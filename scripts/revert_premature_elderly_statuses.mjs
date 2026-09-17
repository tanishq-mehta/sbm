#!/usr/bin/env node

import pg from "pg";
import { runElderlyAlertScan } from "../server/database.mjs";

const { Pool } = pg;
const statusField = "Status";
const birthDateField = "Birth Date";
const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const allowedStatuses = new Set(["PERMANENT", "OPEN", "NEW", "NI", "VSS", "ESS"]);

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) args.set(match[1], match[2] ?? "true");
}

const apply = args.get("apply") === "true";
const keepElderlyThrough = args.get("keep-elderly-through") || "2026-07-31";
const revertThrough = args.get("revert-through") || "2026-12-31";
const alertsThrough = args.get("alerts-through") || "2026-08-31";
const changedBy = args.get("changed-by") || "system-elderly-cutoff-revert";

validateIsoDate(keepElderlyThrough, "--keep-elderly-through");
validateIsoDate(revertThrough, "--revert-through");
validateIsoDate(alertsThrough, "--alerts-through");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. The script is intended for the configured Postgres database.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

try {
  const candidates = await loadCandidates(pool, keepElderlyThrough, revertThrough);
  const { updates, skipped } = planUpdates(candidates);
  const summary = {
    mode: apply ? "apply" : "dry-run",
    keepElderlyThrough,
    revertThrough,
    alertsThrough,
    candidates: candidates.length,
    updates: updates.length,
    skipped: skipped.length,
    updateCountsByTurnMonth: countBy(updates.map((row) => row.turnMonth)),
    updateCountsByTargetStatus: countBy(updates.map((row) => row.targetStatus)),
    skippedReasons: countBy(skipped.map((row) => row.reason)),
    preview: updates.slice(0, 20).map(previewRow),
    skippedPreview: skipped.slice(0, 20).map(previewRow),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to update statuses and run the alert catch-up scan.");
    process.exit(0);
  }

  const applyResult = await applyUpdates(pool, updates, changedBy);
  const scanSummary = await runElderlyAlertScan({
    asOf: alertsThrough,
    source: changedBy,
  });
  const pendingSummary = await pendingAlertSummary(pool, alertsThrough);

  console.log(JSON.stringify({
    applyResult,
    scanSummary,
    pendingSummary,
  }, null, 2));

  if (applyResult.updated !== updates.length) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}

async function loadCandidates(pool, keepThrough, revertThrough) {
  const { rows } = await pool.query(
    `
      SELECT
        p.id,
        p.full_name,
        p.badge_no,
        p.data->>$2 AS birth_date,
        p.data->>$1 AS current_status,
        status_audit.audit_id,
        status_audit.created_at AS audit_created_at,
        status_audit.changed_by AS audit_changed_by,
        status_audit.old_status,
        status_audit.new_status
      FROM people AS p
      LEFT JOIN LATERAL (
        SELECT
          audit_logs.id AS audit_id,
          audit_logs.created_at,
          audit_logs.changed_by,
          audit_logs.change #>> ARRAY[$1, 'old'] AS old_status,
          audit_logs.change #>> ARRAY[$1, 'new'] AS new_status
        FROM audit_logs
        WHERE audit_logs.person_id = p.id
          AND audit_logs.change ? $1
          AND upper(coalesce(audit_logs.change #>> ARRAY[$1, 'new'], '')) = 'ELDERLY'
        ORDER BY audit_logs.created_at DESC, audit_logs.id DESC
        LIMIT 1
      ) AS status_audit ON TRUE
      WHERE p.deleted_at IS NULL
        AND upper(coalesce(p.data->>$1, '')) = 'ELDERLY'
      ORDER BY p.full_name, p.id
    `,
    [statusField, birthDateField]
  );

  return rows
    .map((row) => {
      const birthParts = parseDateParts(row.birth_date);
      const turns70On = birthParts ? datePartsToIso(addYearsToDateParts(birthParts, 70)) : "";
      return {
        id: Number(row.id),
        name: row.full_name || "",
        badgeNo: row.badge_no || "",
        birthDate: row.birth_date || "",
        currentStatus: normalizeStatus(row.current_status),
        turns70On,
        turnMonth: turns70On.slice(0, 7),
        auditId: row.audit_id ? Number(row.audit_id) : null,
        auditCreatedAt: row.audit_created_at || "",
        auditChangedBy: row.audit_changed_by || "",
        previousStatus: normalizeStatus(row.old_status),
        auditNewStatus: normalizeStatus(row.new_status),
      };
    })
    .filter((row) => row.turns70On > keepThrough && row.turns70On <= revertThrough)
    .sort((a, b) => a.turns70On.localeCompare(b.turns70On) || a.name.localeCompare(b.name) || a.id - b.id);
}

function planUpdates(candidates) {
  const updates = [];
  const skipped = [];

  for (const row of candidates) {
    if (!row.auditId) {
      skipped.push({ ...row, reason: "missing-status-audit" });
      continue;
    }
    if (!row.previousStatus) {
      skipped.push({ ...row, reason: "blank-previous-status" });
      continue;
    }
    if (row.previousStatus === "ELDERLY") {
      skipped.push({ ...row, reason: "previous-status-elderly" });
      continue;
    }
    if (!allowedStatuses.has(row.previousStatus)) {
      skipped.push({ ...row, reason: "unsupported-previous-status" });
      continue;
    }
    updates.push({
      ...row,
      targetStatus: row.previousStatus,
    });
  }

  return { updates, skipped };
}

async function applyUpdates(pool, updates, changedBy) {
  if (!updates.length) return { updated: 0, audited: 0 };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `
        WITH input_rows AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb)
            AS input(id bigint, name text, "badgeNo" text, "targetStatus" text)
        ),
        updated AS (
          UPDATE people AS p
          SET data = jsonb_set(p.data, '{Status}', to_jsonb(input_rows."targetStatus"::text), true),
              updated_at = NOW()
          FROM input_rows
          WHERE p.id = input_rows.id
            AND upper(coalesce(p.data->>$2, '')) = 'ELDERLY'
          RETURNING
            p.id,
            p.full_name,
            p.badge_no,
            input_rows."targetStatus"
        ),
        audit AS (
          INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
          SELECT
            updated.id,
            coalesce(updated.full_name, ''),
            coalesce(updated.badge_no, ''),
            $3,
            'update',
            jsonb_build_object(
              'Status',
              jsonb_build_object('old', 'ELDERLY', 'new', updated."targetStatus")
            )
          FROM updated
          RETURNING person_id
        )
        SELECT
          (SELECT COUNT(*)::int FROM updated) AS updated,
          (SELECT COUNT(*)::int FROM audit) AS audited
      `,
      [JSON.stringify(updates), statusField, changedBy]
    );
    const result = {
      updated: Number(rows[0]?.updated || 0),
      audited: Number(rows[0]?.audited || 0),
    };
    if (result.updated !== updates.length || result.updated !== result.audited) {
      await client.query("ROLLBACK");
      throw new Error(
        `Rolled back elderly status revert: expected ${updates.length} updates, got ${result.updated} updates and ${result.audited} audit rows.`
      );
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pendingAlertSummary(pool, alertsThrough) {
  const { rows } = await pool.query(
    `
      SELECT
        to_char(ea.turns_70_on, 'YYYY-MM') AS month,
        COUNT(*)::int AS count
      FROM elderly_alerts AS ea
      INNER JOIN people AS p ON p.id = ea.person_id
      WHERE ea.resolved_at IS NULL
        AND p.deleted_at IS NULL
        AND ea.turns_70_on <= $3::date
        AND NOT (upper(coalesce(p.data->>$1, '')) = ANY($2::text[]))
      GROUP BY month
      ORDER BY month
    `,
    [statusField, ["ELDERLY", "ESS"], alertsThrough]
  );
  return {
    alertsThrough,
    pendingTotal: rows.reduce((total, row) => total + Number(row.count || 0), 0),
    byMonth: Object.fromEntries(rows.map((row) => [row.month, Number(row.count || 0)])),
  };
}

function previewRow(row) {
  return {
    id: row.id,
    name: row.name,
    badgeNo: row.badgeNo,
    birthDate: row.birthDate,
    turns70On: row.turns70On,
    currentStatus: row.currentStatus,
    previousStatus: row.previousStatus,
    targetStatus: row.targetStatus,
    auditId: row.auditId,
    auditChangedBy: row.auditChangedBy,
    reason: row.reason,
  };
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = value || "(blank)";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function validateIsoDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be in YYYY-MM-DD format.`);
  }
}

function parseDateParts(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})$/);
  if (match) {
    const month = monthFromText(match[2]);
    return month ? validDate(expandYear(match[3]), month, Number(match[1])) : null;
  }

  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) return validDate(expandYear(match[3]), Number(match[2]), Number(match[1]));

  return null;
}

function monthFromText(value) {
  const index = monthNames.findIndex((month) => value.toLowerCase().startsWith(month));
  return index === -1 ? 0 : index + 1;
}

function expandYear(value) {
  const text = String(value);
  const year = Number(text);
  if (text.length === 4) return year;
  const currentTwoDigitYear = new Date().getFullYear() % 100;
  return year <= currentTwoDigitYear ? 2000 + year : 1900 + year;
}

function validDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function addYearsToDateParts(parts, years) {
  const targetYear = parts.year + years;
  const day = Math.min(parts.day, daysInMonth(targetYear, parts.month));
  return {
    year: targetYear,
    month: parts.month,
    day,
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function datePartsToIso(parts) {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

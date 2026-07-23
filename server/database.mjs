import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnvFile } from "./env.mjs";

loadEnvFile();

const require = createRequire(import.meta.url);
const { Pool } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "data");
const dbPath = process.env.DB_PATH || path.join(dataDir, "users.sqlite");
const fieldsPath = path.join(dataDir, "fields.json");
const seedPath = path.join(dataDir, "people-seed.json");
const dropdownOptionsPath = path.join(dataDir, "dropdown-options.json");
const locationOptionsPath = path.join(dataDir, "location-options.json");
const sbmExportFieldsPath = path.join(dataDir, "sbm-export-fields.json");

export const fields = JSON.parse(fs.readFileSync(fieldsPath, "utf8"));
export const searchableFields = ["All fields", ...fields];
export const sbmExportFields = fs.existsSync(sbmExportFieldsPath)
  ? JSON.parse(fs.readFileSync(sbmExportFieldsPath, "utf8"))
  : [];
export const dropdownOptions = fs.existsSync(dropdownOptionsPath)
  ? JSON.parse(fs.readFileSync(dropdownOptionsPath, "utf8"))
  : {};
export const locationOptions = fs.existsSync(locationOptionsPath)
  ? JSON.parse(fs.readFileSync(locationOptionsPath, "utf8"))
  : { states: [], districtsByState: {}, citiesByStateDistrict: {} };
export const databaseProvider = process.env.DATABASE_URL ? "postgres" : "sqlite";
const emailField = "Email Id";
const serialField = "S No";
const badgeField = "Badge no.";
const verificationField = "Verification Status";
const verificationOptions = ["None", "Verification Done", "Rectification Done"];
const dateFields = new Set(["Birth Date", "Initiation Date"]);
const departmentFields = new Set(["Sewa Dept - Local Centre", "Sewa Dept - Major Centre"]);
const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const dataQualityGroups = [
  {
    key: "pending",
    label: "None / blank verification",
    statuses: new Set(["None", ""]),
  },
  {
    key: "completed",
    label: "Rectification Done / Verification Done",
    statuses: new Set(["Rectification Done", "Verification Done"]),
  },
];
const dataQualityIssueTypes = [
  { key: "mismatch", label: "Mismatching" },
  { key: "blank", label: "Blank" },
];
const dataQualityFields = [
  {
    key: "skills",
    label: "Skills",
    fields: ["Skills - 1", "Skills - 2"],
    blankLabel: "Skills - 1 / Skills - 2",
  },
  {
    key: "profession",
    label: "Profession",
    fields: ["Profession"],
  },
  {
    key: "qualification",
    label: "Qualification",
    fields: ["Educational Qualification"],
  },
  {
    key: "state",
    label: "State",
    fields: ["State"],
  },
  {
    key: "city",
    label: "City",
    fields: ["City"],
  },
  {
    key: "district",
    label: "District",
    fields: ["District"],
  },
];
const dataQualityGroupByStatus = new Map(
  dataQualityGroups.flatMap((group) =>
    [...group.statuses].map((status) => [status, group])
  )
);

let dataQualityOptionSetsCache;

let sqliteDb;
let pgPool;
let initialized = false;

export async function initializeDatabase({ seedIfEmpty = true } = {}) {
  if (initialized) return;

  if (databaseProvider === "postgres") {
    await migratePostgres();
    if (seedIfEmpty) {
      const { rows } = await getPool().query("SELECT COUNT(*)::int AS total FROM people");
      if (rows[0].total === 0) await seedPostgres();
    }
  } else {
    migrateSqlite();
    if (seedIfEmpty) {
      const count = getSqlite().prepare("SELECT COUNT(*) AS total FROM people").get().total;
      if (count === 0) seedSqlite();
    }
  }

  initialized = true;
}

export async function closeDatabase() {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  initialized = false;
}

export async function checkDatabaseConnection() {
  if (databaseProvider === "postgres") {
    await getPool().query("SELECT 1");
    return;
  }

  getSqlite().prepare("SELECT 1").get();
}

export async function reseedDatabase() {
  await initializeDatabase({ seedIfEmpty: false });

  if (databaseProvider === "postgres") {
    await getPool().query("TRUNCATE TABLE people RESTART IDENTITY CASCADE");
    await seedPostgres();
    return;
  }

  const db = getSqlite();
  db.exec("DELETE FROM audit_logs");
  db.exec("DELETE FROM people");
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'people'");
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'audit_logs'");
  seedSqlite();
}

export async function cleanEmailValues(options = {}) {
  await initializeDatabase({ seedIfEmpty: false });
  const requestedBatchSize = Number(options.batchSize);
  const dryRun = Boolean(options.dryRun);

  if (databaseProvider === "postgres") {
    const { rows } = await getPool().query("SELECT id, full_name, badge_no, data FROM people");
    const updates = [];
    for (const row of rows) {
      const original = row.data?.[emailField] || "";
      const cleaned = sanitizeEmailValue(original);
      if (cleaned !== original) {
        updates.push({
          id: row.id,
          name: row.full_name || "",
          badgeNo: row.badge_no || "",
          oldEmail: original,
          email: cleaned,
        });
      }
    }

    const selectedUpdates = emailCleanupBatch(updates, requestedBatchSize);
    if (dryRun) {
      return emailCleanupResult(updates.length, 0, options.returnSummary, updates);
    }

    let updated = 0;
    for (let start = 0; start < selectedUpdates.length; start += 200) {
      const batch = selectedUpdates.slice(start, start + 200);
      const values = [];
      const placeholders = batch.map((row, index) => {
        const offset = index * 2;
        values.push(row.id, row.email);
        return `($${offset + 1}::bigint, $${offset + 2}::text)`;
      });
      await getPool().query(
        `
          UPDATE people AS p
          SET data = jsonb_set(p.data, '{Email Id}', to_jsonb(v.email), true),
              updated_at = NOW()
          FROM (VALUES ${placeholders.join(", ")}) AS v(id, email)
          WHERE p.id = v.id
        `,
        values
      );
      updated += batch.length;
    }
    return emailCleanupResult(updates.length, updated, options.returnSummary);
  }

  const db = getSqlite();
  const rows = db.prepare("SELECT id, full_name, badge_no, data FROM people").all();
  const update = db.prepare("UPDATE people SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  const updates = [];
  for (const row of rows) {
    const data = JSON.parse(row.data);
    const original = data[emailField] || "";
    const cleaned = sanitizeEmailValue(original);
    if (cleaned === original) continue;
    updates.push({
      id: row.id,
      name: row.full_name || "",
      badgeNo: row.badge_no || "",
      oldEmail: original,
      email: cleaned,
      data,
    });
  }

  const selectedUpdates = emailCleanupBatch(updates, requestedBatchSize);
  if (dryRun) {
    return emailCleanupResult(updates.length, 0, options.returnSummary, updates);
  }

  db.exec("BEGIN");
  try {
    for (const row of selectedUpdates) {
      const data = row.data;
      const cleaned = row.email;
      data[emailField] = cleaned;
      update.run(JSON.stringify(data), row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return emailCleanupResult(updates.length, selectedUpdates.length, options.returnSummary);
}

export async function normalizeVerificationValues() {
  await initializeDatabase({ seedIfEmpty: false });

  if (databaseProvider === "postgres") {
    const { rows } = await getPool().query("SELECT id, data FROM people");
    const batchSize = 200;
    const updates = [];
    for (const row of rows) {
      const original = row.data?.[verificationField] || "";
      const cleaned = normalizeVerificationValue(original);
      if (cleaned !== original) updates.push({ id: row.id, status: cleaned });
    }

    let updated = 0;
    for (let start = 0; start < updates.length; start += batchSize) {
      const batch = updates.slice(start, start + batchSize);
      const values = [];
      const placeholders = batch.map((row, index) => {
        const offset = index * 2;
        values.push(row.id, row.status);
        return `($${offset + 1}::bigint, $${offset + 2}::text)`;
      });
      await getPool().query(
        `
          UPDATE people AS p
          SET data = jsonb_set(p.data, '{Verification Status}', to_jsonb(v.status), true),
              updated_at = NOW()
          FROM (VALUES ${placeholders.join(", ")}) AS v(id, status)
          WHERE p.id = v.id
        `,
        values
      );
      updated += batch.length;
    }
    return updated;
  }

  const db = getSqlite();
  const rows = db.prepare("SELECT id, data FROM people").all();
  const update = db.prepare("UPDATE people SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  let updated = 0;
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const data = JSON.parse(row.data);
      const original = data[verificationField] || "";
      const cleaned = normalizeVerificationValue(original);
      if (cleaned === original) continue;
      data[verificationField] = cleaned;
      update.run(JSON.stringify(data), row.id);
      updated += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return updated;
}

export async function normalizeDepartmentValues(options = {}) {
  await initializeDatabase({ seedIfEmpty: false });
  const changedBy = normalizeChangedBy(options.changedBy || "system-department-normalization");
  const requestedBatchSize = Number(options.batchSize);

  if (databaseProvider === "postgres") {
    const rows = (
      await getPool().query(
        "SELECT id, full_name, badge_no, department, phone_number, data, updated_at, deleted_at FROM people"
      )
    ).rows;
    const updates = rows
      .map((row) => rowToPerson(row))
      .map((person) => {
        const data = normalizedDepartmentData(person.data || {});
        const change = diffData(person.data, data);
        const summary = summarize(data);
        return departmentRecordNeedsUpdate(person, summary, change)
          ? { person, data, change, summary }
          : null;
      })
      .filter(Boolean);
    const selectedUpdates = departmentNormalizationBatch(updates, requestedBatchSize);

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      for (const update of selectedUpdates) {
        await client.query(
          `
            UPDATE people
            SET full_name = $1,
                badge_no = $2,
                department = $3,
                phone_number = $4,
                data = $5,
                updated_at = NOW()
            WHERE id = $6
          `,
          [
            update.summary.fullName,
            update.summary.badgeNo,
            update.summary.department,
            update.summary.phoneNumber,
            update.data,
            update.person.id,
          ]
        );
        if (Object.keys(update.change).length) {
          await client.query(
            `
              INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
              VALUES ($1, $2, $3, $4, 'update', $5)
            `,
            [
              update.person.id,
              update.summary.fullName,
              update.summary.badgeNo,
              changedBy,
              update.change,
            ]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return departmentNormalizationResult(updates.length, selectedUpdates.length, options.returnSummary);
  }

  const db = getSqlite();
  const rows = db
    .prepare("SELECT id, full_name, badge_no, department, phone_number, data, updated_at, deleted_at FROM people")
    .all();
  const updates = rows
    .map((row) => rowToPerson(row))
    .map((person) => {
      const data = normalizedDepartmentData(person.data || {});
      const change = diffData(person.data, data);
      const summary = summarize(data);
      return departmentRecordNeedsUpdate(person, summary, change)
        ? { person, data, change, summary }
        : null;
    })
    .filter(Boolean);
  const selectedUpdates = departmentNormalizationBatch(updates, requestedBatchSize);
  const updatePersonRecord = db.prepare(`
    UPDATE people
    SET full_name = ?,
        badge_no = ?,
        department = ?,
        phone_number = ?,
        data = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
    VALUES (?, ?, ?, ?, 'update', ?)
  `);

  db.exec("BEGIN");
  try {
    for (const update of selectedUpdates) {
      updatePersonRecord.run(
        update.summary.fullName,
        update.summary.badgeNo,
        update.summary.department,
        update.summary.phoneNumber,
        JSON.stringify(update.data),
        update.person.id
      );
      if (Object.keys(update.change).length) {
        insertAudit.run(
          update.person.id,
          update.summary.fullName,
          update.summary.badgeNo,
          changedBy,
          JSON.stringify(update.change)
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return departmentNormalizationResult(updates.length, selectedUpdates.length, options.returnSummary);
}

export async function renumberSerialNumbers(options = {}) {
  await initializeDatabase({ seedIfEmpty: false });
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || 250, 1000));
  const changedBy = normalizeChangedBy(options.changedBy || "system-sno-renumbering");
  const people = (await getAllPersonRows()).map(rowToPerson);
  const assignments = buildSerialAssignments(people);
  const updates = assignments
    .filter((assignment) => assignment.oldSerial !== assignment.newSerial)
    .map((assignment) => {
      const data = cleanData({
        ...assignment.person.data,
        [serialField]: assignment.newSerial,
      });
      return {
        person: assignment.person,
        data,
        summary: summarize(data),
        change: {
          [serialField]: {
            old: assignment.oldSerial,
            new: assignment.newSerial,
          },
        },
      };
    });

  const result = {
    total: people.length,
    updated: updates.length,
    batchSize,
    groups: serialGroupSummary(assignments),
    skipped: people
      .filter((person) => !badgeSerialGroup(person.data?.[badgeField] || person.badgeNo))
      .map((person) => serialPreview(person, person.data?.[serialField] || "")),
    first: assignments[0] ? serialPreview(assignments[0].person, assignments[0].newSerial) : null,
    last: assignments.length
      ? serialPreview(assignments[assignments.length - 1].person, assignments[assignments.length - 1].newSerial)
      : null,
  };

  if (options.dryRun || updates.length === 0) {
    return result;
  }

  if (databaseProvider === "postgres") {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      for (let start = 0; start < updates.length; start += batchSize) {
        await applySerialNumberBatchPostgres(
          client,
          updates.slice(start, start + batchSize),
          changedBy
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    const db = getSqlite();
    const updatePersonRecord = db.prepare(`
      UPDATE people
      SET full_name = ?,
          badge_no = ?,
          department = ?,
          phone_number = ?,
          data = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND deleted_at IS NULL
    `);
    const insertAudit = db.prepare(`
      INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
      VALUES (?, ?, ?, ?, 'update', ?)
    `);

    db.exec("BEGIN");
    try {
      for (const update of updates) {
        updatePersonRecord.run(
          update.summary.fullName,
          update.summary.badgeNo,
          update.summary.department,
          update.summary.phoneNumber,
          JSON.stringify(update.data),
          update.person.id
        );
        insertAudit.run(
          update.person.id,
          update.summary.fullName,
          update.summary.badgeNo,
          changedBy,
          JSON.stringify(update.change)
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return result;
}

export async function listPeople({ query = "", field = "All fields", limit = 200 } = {}) {
  await initializeDatabase();
  const rows = await getAllPersonRows();

  const normalizedQuery = normalizeSearch(query);
  const normalizedField = searchableFields.includes(field) ? field : "All fields";
  const max = Math.max(1, Math.min(Number(limit) || 200, 500));
  const matched = rows
    .map(rowToPerson)
    .filter((person) => matchesQuery(person, normalizedQuery, normalizedField));

  return {
    total: matched.length,
    results: matched.slice(0, max).map(toSummary),
  };
}

export async function listAllPeople() {
  await initializeDatabase();
  return (await getAllPersonRows()).map(rowToPerson);
}

export function getLocationOptions({ state = "", district = "" } = {}) {
  const states = locationOptions.states || [];
  const selectedState = findOption(state, states);
  const districts = selectedState
    ? locationOptions.districtsByState?.[selectedState] || []
    : allLocationDistricts();
  const selectedDistrict = findOption(district, districts);

  let cities = [];
  if (selectedState && selectedDistrict) {
    cities = locationOptions.citiesByStateDistrict?.[selectedState]?.[selectedDistrict] || [];
  } else if (selectedDistrict) {
    cities = allLocationCitiesForDistrict(selectedDistrict);
  }

  return {
    states,
    districts,
    cities,
    selectedState,
    selectedDistrict,
  };
}

export async function getVerificationSummary({ department = "" } = {}) {
  await initializeDatabase();
  const people = (await getAllPersonRows()).map(rowToPerson);
  const departments = getDepartmentOptions(people);
  const normalizedDepartment = normalizeSearch(department);
  const filtered = normalizedDepartment
    ? people.filter((person) => normalizeSearch(person.department) === normalizedDepartment)
    : people;

  return {
    department: department || "",
    departments,
    total: filtered.length,
    counts: countStatuses(filtered),
    byDepartment: departments.map((entry) => {
      const departmentPeople = people.filter((person) => person.department === entry.department);
      return {
        department: entry.department,
        label: entry.label,
        total: departmentPeople.length,
        counts: countStatuses(departmentPeople),
      };
    }),
  };
}

export async function getDataQualitySummary() {
  await initializeDatabase();
  const people = (await getAllPersonRows()).map(rowToPerson).filter(isPrBadgePerson);
  const fieldsSummary = dataQualityFields.map(emptyDataQualityFieldSummary);
  const fieldsByKey = new Map(fieldsSummary.map((field) => [field.key, field]));
  const optionSets = dataQualityOptionSets();

  for (const person of people) {
    const group = dataQualityGroupForPerson(person);
    if (!group) continue;

    for (const definition of dataQualityFields) {
      const details = dataQualityDetailsForField(person, definition, optionSets.get(definition.key) || new Set());
      if (!details.issueType) continue;

      const fieldSummary = fieldsByKey.get(definition.key);
      fieldSummary.groups[group.key][details.issueType] += 1;
      fieldSummary.totals[details.issueType] += 1;
    }
  }

  return {
    totalPeople: people.length,
    groups: dataQualityGroups.map(({ key, label }) => ({ key, label })),
    issueTypes: dataQualityIssueTypes,
    fields: fieldsSummary,
  };
}

export async function listDataQualityPeople({ field, issue, group } = {}) {
  await initializeDatabase();
  const fieldDefinition = dataQualityFields.find((definition) => definition.key === field);
  const issueType = dataQualityIssueTypes.find((definition) => definition.key === issue);
  const groupDefinition = dataQualityGroups.find((definition) => definition.key === group);

  if (!fieldDefinition) throw statusError(400, "Unknown data quality field.");
  if (!issueType) throw statusError(400, "Unknown data quality issue.");
  if (!groupDefinition) throw statusError(400, "Unknown verification group.");

  const people = (await getAllPersonRows()).map(rowToPerson).filter(isPrBadgePerson);
  const validOptions = dataQualityOptionSets().get(fieldDefinition.key) || new Set();
  const results = [];

  for (const person of people) {
    const personGroup = dataQualityGroupForPerson(person);
    if (personGroup?.key !== groupDefinition.key) continue;

    const details = dataQualityDetailsForField(person, fieldDefinition, validOptions);
    if (details.issueType !== issueType.key) continue;

    results.push({
      ...toSummary(person),
      verificationStatus: normalizeVerificationValue(person.data?.[verificationField]),
      issueDetails: details.rows,
    });
  }

  results.sort(compareDataQualityPeople);

  return {
    field: { key: fieldDefinition.key, label: fieldDefinition.label },
    issue: issueType,
    group: { key: groupDefinition.key, label: groupDefinition.label },
    total: results.length,
    results,
  };
}

export async function listAuditLogs({ limit = 500 } = {}) {
  await initializeDatabase();
  const max = Math.max(1, Math.min(Number(limit) || 500, 1000));
  const rows =
    databaseProvider === "postgres"
      ? (
          await getPool().query(
            auditLogSelectSql("", "LIMIT $1"),
            [max]
          )
        ).rows
      : getSqlite()
          .prepare(auditLogSelectSql("", "LIMIT ?"))
          .all(max);

  return rows.map(rowToAuditLog);
}

export async function listAllAuditLogs() {
  await initializeDatabase();
  const rows =
    databaseProvider === "postgres"
      ? (await getPool().query(auditLogSelectSql())).rows
      : getSqlite()
          .prepare(auditLogSelectSql())
          .all();

  return rows.map(rowToAuditLog);
}

export async function createPerson(incomingData, options = {}) {
  await initializeDatabase();
  const changedBy = normalizeChangedBy(options.changedBy);

  if (databaseProvider === "postgres") {
    const client = await getPool().connect();
    let createdId;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [591447517]);
      const incoming = cleanData(incomingData || {});
      const serialNo = await nextSerialNumberPostgres(client, incoming[badgeField]);
      const data = cleanData({ ...incoming, [serialField]: serialNo });
      const summary = summarize(data);
      const change = diffData(emptyData(), data);
      const { rows } = await client.query(
        `
          INSERT INTO people (
            full_name,
            badge_no,
            department,
            phone_number,
            data
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id
        `,
        [
          summary.fullName,
          summary.badgeNo,
          summary.department,
          summary.phoneNumber,
          data,
        ]
      );
      createdId = rows[0].id;
      await client.query(
        `
          INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
          VALUES ($1, $2, $3, $4, 'create', $5)
        `,
        [createdId, summary.fullName, summary.badgeNo, changedBy, change]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return getPerson(createdId);
  }

  const db = getSqlite();
  let createdId;
  db.exec("BEGIN IMMEDIATE");
  try {
    const incoming = cleanData(incomingData || {});
    const serialNo = nextSerialNumberSqlite(db, incoming[badgeField]);
    const data = cleanData({ ...incoming, [serialField]: serialNo });
    const summary = summarize(data);
    const change = diffData(emptyData(), data);
    const result = db
      .prepare(`
        INSERT INTO people (
          full_name,
          badge_no,
          department,
          phone_number,
          data
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        summary.fullName,
        summary.badgeNo,
        summary.department,
        summary.phoneNumber,
        JSON.stringify(data)
      );
    createdId = Number(result.lastInsertRowid);
    db
      .prepare(`
        INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
        VALUES (?, ?, ?, ?, 'create', ?)
      `)
      .run(createdId, summary.fullName, summary.badgeNo, changedBy, JSON.stringify(change));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getPerson(createdId);
}

export async function getPerson(id) {
  await initializeDatabase();
  const row = await getPersonRow(id);
  return row ? rowToPerson(row) : null;
}

async function getPersonRow(id, { includeDeleted = false } = {}) {
  const deletedFilter = includeDeleted ? "" : " AND deleted_at IS NULL";
  return databaseProvider === "postgres"
    ? (
        await getPool().query(
          `
            SELECT id, full_name, badge_no, department, phone_number, data, updated_at, deleted_at
            FROM people
            WHERE id = $1${deletedFilter}
          `,
          [Number(id)]
        )
      ).rows[0]
    : getSqlite()
        .prepare(`
          SELECT id, full_name, badge_no, department, phone_number, data, updated_at, deleted_at
          FROM people
          WHERE id = ?${deletedFilter}
        `)
        .get(Number(id));
}

async function getAuditLog(id) {
  const rows =
    databaseProvider === "postgres"
      ? (
          await getPool().query(
            auditLogSelectSql("WHERE a.id = $1"),
            [Number(id)]
          )
        ).rows
      : getSqlite()
          .prepare(auditLogSelectSql("WHERE a.id = ?"))
          .all(Number(id));

  return rows[0] ? rowToAuditLog(rows[0]) : null;
}

async function getAllPersonRows() {
  if (databaseProvider === "postgres") {
    return (await getPool().query("SELECT id, full_name, badge_no, department, phone_number, data FROM people WHERE deleted_at IS NULL ORDER BY lower(full_name), full_name")).rows;
  }

  return getSqlite()
    .prepare("SELECT id, full_name, badge_no, department, phone_number, data FROM people WHERE deleted_at IS NULL ORDER BY full_name COLLATE NOCASE")
    .all();
}

export async function updatePerson(id, incomingData, options = {}) {
  const existing = await getPerson(id);
  if (!existing) return null;

  const data = cleanData({ ...existing.data, ...(incomingData || {}) });
  const summary = summarize(data);
  const change = diffData(existing.data, data);
  const changedBy = normalizeChangedBy(options.changedBy);

  if (Object.keys(change).length === 0) {
    return existing;
  }

  if (databaseProvider === "postgres") {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE people
          SET full_name = $1,
              badge_no = $2,
              department = $3,
              phone_number = $4,
              data = $5,
              updated_at = NOW()
          WHERE id = $6
        `,
        [
          summary.fullName,
          summary.badgeNo,
          summary.department,
          summary.phoneNumber,
          data,
          Number(id),
        ]
      );
      await client.query(
        `
          INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
          VALUES ($1, $2, $3, $4, 'update', $5)
        `,
        [Number(id), summary.fullName, summary.badgeNo, changedBy, change]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    const db = getSqlite();
    db.exec("BEGIN");
    try {
      db
        .prepare(`
        UPDATE people
        SET full_name = ?,
            badge_no = ?,
            department = ?,
            phone_number = ?,
            data = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
        .run(
          summary.fullName,
          summary.badgeNo,
          summary.department,
          summary.phoneNumber,
          JSON.stringify(data),
          Number(id)
        );
      db
        .prepare(`
          INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
          VALUES (?, ?, ?, ?, 'update', ?)
        `)
        .run(Number(id), summary.fullName, summary.badgeNo, changedBy, JSON.stringify(change));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return getPerson(id);
}

export async function deletePerson(id, options = {}) {
  await initializeDatabase();
  const existing = await getPerson(id);
  if (!existing) return null;

  const changedBy = normalizeChangedBy(options.changedBy);
  const change = diffData(existing.data, emptyData());

  if (databaseProvider === "postgres") {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE people
          SET deleted_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
            AND deleted_at IS NULL
        `,
        [Number(id)]
      );
      await client.query(
        `
          INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
          VALUES ($1, $2, $3, $4, 'delete', $5)
        `,
        [Number(id), existing.fullName, existing.badgeNo, changedBy, change]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    const db = getSqlite();
    db.exec("BEGIN");
    try {
      db
        .prepare(`
          UPDATE people
          SET deleted_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND deleted_at IS NULL
        `)
        .run(Number(id));
      db
        .prepare(`
          INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
          VALUES (?, ?, ?, ?, 'delete', ?)
        `)
        .run(Number(id), existing.fullName, existing.badgeNo, changedBy, JSON.stringify(change));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return existing;
}

export async function restorePersonFromAudit(auditId, options = {}) {
  await initializeDatabase();
  const audit = await getAuditLog(auditId);
  if (!audit) return null;
  if (audit.action !== "delete") {
    throw statusError(400, "Only deleted records can be restored.");
  }
  if (!audit.restorable) {
    throw statusError(409, "This deleted record has already been restored.");
  }

  const existingRow = await getPersonRow(audit.personId, { includeDeleted: true });
  if (!existingRow) {
    throw statusError(409, "The original deleted record is no longer available to restore.");
  }

  const existing = rowToPerson(existingRow);
  const data = dataFromAuditSnapshot(audit.change, existing.data);
  const summary = summarize(data);
  const change = diffData(emptyData(), data);
  const changedBy = normalizeChangedBy(options.changedBy);

  if (databaseProvider === "postgres") {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE people
          SET full_name = $1,
              badge_no = $2,
              department = $3,
              phone_number = $4,
              data = $5,
              deleted_at = NULL,
              updated_at = NOW()
          WHERE id = $6
            AND deleted_at IS NOT NULL
        `,
        [
          summary.fullName,
          summary.badgeNo,
          summary.department,
          summary.phoneNumber,
          data,
          audit.personId,
        ]
      );
      await client.query(
        `
          INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
          VALUES ($1, $2, $3, $4, 'restore', $5)
        `,
        [audit.personId, summary.fullName, summary.badgeNo, changedBy, change]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    const db = getSqlite();
    db.exec("BEGIN");
    try {
      db
        .prepare(`
          UPDATE people
          SET full_name = ?,
              badge_no = ?,
              department = ?,
              phone_number = ?,
              data = ?,
              deleted_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND deleted_at IS NOT NULL
        `)
        .run(
          summary.fullName,
          summary.badgeNo,
          summary.department,
          summary.phoneNumber,
          JSON.stringify(data),
          audit.personId
        );
      db
        .prepare(`
          INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
          VALUES (?, ?, ?, ?, 'restore', ?)
        `)
        .run(audit.personId, summary.fullName, summary.badgeNo, changedBy, JSON.stringify(change));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return getPerson(audit.personId);
}

function getSqlite() {
  if (sqliteDb) return sqliteDb;
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(dataDir, { recursive: true });
  sqliteDb = new DatabaseSync(dbPath);
  sqliteDb.exec("PRAGMA journal_mode = WAL");
  sqliteDb.exec("PRAGMA foreign_keys = ON");
  return sqliteDb;
}

function getPool() {
  if (pgPool) return pgPool;
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return pgPool;
}

function migrateSqlite() {
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      badge_no TEXT,
      department TEXT,
      phone_number TEXT,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    )
  `);
  let columns = db.prepare("PRAGMA table_info(people)").all().map((column) => column.name);
  if (columns.includes("team")) {
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE people_without_team (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          full_name TEXT NOT NULL,
          badge_no TEXT,
          department TEXT,
          phone_number TEXT,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          deleted_at TEXT
        )
      `);
      db.exec(`
        INSERT INTO people_without_team (
          id,
          full_name,
          badge_no,
          department,
          phone_number,
          data,
          created_at,
          updated_at,
          deleted_at
        )
        SELECT
          id,
          full_name,
          badge_no,
          department,
          phone_number,
          data,
          created_at,
          updated_at,
          NULL
        FROM people
      `);
      db.exec("DROP TABLE people");
      db.exec("ALTER TABLE people_without_team RENAME TO people");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  columns = db.prepare("PRAGMA table_info(people)").all().map((column) => column.name);
  if (!columns.includes("deleted_at")) {
    db.exec("ALTER TABLE people ADD COLUMN deleted_at TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_people_name ON people(full_name)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_people_badge ON people(badge_no)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_people_phone ON people(phone_number)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_people_deleted_at ON people(deleted_at)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      badge_no TEXT,
      changed_by TEXT NOT NULL DEFAULT 'system',
      action TEXT NOT NULL DEFAULT 'update',
      "change" TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const auditColumns = db.prepare("PRAGMA table_info(audit_logs)").all().map((column) => column.name);
  if (!auditColumns.includes("changed_by")) {
    db.exec("ALTER TABLE audit_logs ADD COLUMN changed_by TEXT NOT NULL DEFAULT 'system'");
  }
  if (!auditColumns.includes("action")) {
    db.exec("ALTER TABLE audit_logs ADD COLUMN action TEXT NOT NULL DEFAULT 'update'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_logs_person_id ON audit_logs(person_id)");
}

async function migratePostgres() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      badge_no TEXT,
      department TEXT,
      phone_number TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `);
  await pool.query("ALTER TABLE people DROP COLUMN IF EXISTS team");
  await pool.query("ALTER TABLE people ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_people_name ON people (lower(full_name))");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_people_badge ON people (lower(badge_no))");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_people_phone ON people (phone_number)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_people_data ON people USING GIN (data)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_people_deleted_at ON people (deleted_at)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      person_id BIGINT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      badge_no TEXT,
      changed_by TEXT NOT NULL DEFAULT 'system',
      action TEXT NOT NULL DEFAULT 'update',
      "change" JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS changed_by TEXT NOT NULL DEFAULT 'system'");
  await pool.query("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'update'");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_audit_logs_person_id ON audit_logs (person_id)");
}

function seedSqlite() {
  const people = readSeedPeople();
  const insert = getSqlite().prepare(`
    INSERT INTO people (
      full_name,
      badge_no,
      department,
      phone_number,
      data
    ) VALUES (?, ?, ?, ?, ?)
  `);

  getSqlite().exec("BEGIN");
  try {
    for (const person of people) {
      const data = cleanData(person.data || {});
      const summary = summarize(data);
      insert.run(
        summary.fullName || person.fullName || "",
        summary.badgeNo || person.badgeNo || "",
        summary.department || person.department || "",
        summary.phoneNumber || person.phoneNumber || "",
        JSON.stringify(data)
      );
    }
    getSqlite().exec("COMMIT");
  } catch (error) {
    getSqlite().exec("ROLLBACK");
    throw error;
  }
}

async function seedPostgres() {
  const people = readSeedPeople();
  const pool = getPool();
  const client = await pool.connect();
  const batchSize = 200;
  try {
    await client.query("BEGIN");
    for (let start = 0; start < people.length; start += batchSize) {
      const batch = people.slice(start, start + batchSize);
      const values = [];
      const placeholders = batch.map((person, index) => {
        const data = cleanData(person.data || {});
        const summary = summarize(data);
        const offset = index * 5;
        values.push(
          summary.fullName || person.fullName || "",
          summary.badgeNo || person.badgeNo || "",
          summary.department || person.department || "",
          summary.phoneNumber || person.phoneNumber || "",
          data
        );
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
      });
      await client.query(
        `
          INSERT INTO people (
            full_name,
            badge_no,
            department,
            phone_number,
            data
          ) VALUES ${placeholders.join(", ")}
        `,
        values
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function readSeedPeople() {
  if (!fs.existsSync(seedPath)) {
    throw new Error(`Missing seed file: ${seedPath}`);
  }
  return JSON.parse(fs.readFileSync(seedPath, "utf8"));
}

function cleanData(data) {
  return Object.fromEntries(
    fields.map((field) => [field, normalizeFieldValue(field, data[field])])
  );
}

function normalizedDepartmentData(data) {
  return cleanData({
    ...data,
    ...Object.fromEntries(
      [...departmentFields].map((field) => [field, normalizeDepartmentValue(data?.[field])])
    ),
  });
}

function departmentRecordNeedsUpdate(person, summary, change) {
  return (
    Object.keys(change).length > 0 ||
    normalizeValue(person.fullName) !== normalizeValue(summary.fullName) ||
    normalizeValue(person.badgeNo) !== normalizeValue(summary.badgeNo) ||
    normalizeValue(person.department) !== normalizeValue(summary.department) ||
    normalizeValue(person.phoneNumber) !== normalizeValue(summary.phoneNumber)
  );
}

function departmentNormalizationBatch(updates, requestedBatchSize) {
  if (!Number.isFinite(requestedBatchSize) || requestedBatchSize <= 0) return updates;
  return updates.slice(0, Math.min(Math.floor(requestedBatchSize), 250));
}

function departmentNormalizationResult(totalPending, updated, returnSummary = false) {
  if (!returnSummary) return updated;
  return {
    updated,
    remaining: Math.max(0, totalPending - updated),
  };
}

function emailCleanupBatch(updates, requestedBatchSize) {
  if (!Number.isFinite(requestedBatchSize) || requestedBatchSize <= 0) return updates;
  return updates.slice(0, Math.min(Math.floor(requestedBatchSize), 250));
}

function emailCleanupResult(totalPending, updated, returnSummary = false, updates = []) {
  if (!returnSummary) return updated;
  return {
    updated,
    remaining: Math.max(0, totalPending - updated),
    preview: updates.slice(0, 25).map((entry) => ({
      id: Number(entry.id),
      name: entry.name || "",
      badgeNo: entry.badgeNo || "",
      oldEmail: entry.oldEmail || "",
      newEmail: entry.email || "",
    })),
  };
}

function normalizeValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeFieldValue(field, value) {
  const normalized = normalizeValue(value);
  if (field === verificationField) return normalizeVerificationValue(normalized);
  if (dateFields.has(field)) return normalizeDateValue(normalized);
  if (departmentFields.has(field)) return normalizeDepartmentValue(normalized);
  return field === emailField ? sanitizeEmailValue(normalized) : normalized;
}

export function normalizeDepartmentValue(value) {
  const normalized = normalizeValue(value);
  const compact = normalized.toLowerCase().replace(/[.\s_-]+/g, "");

  if (["admin", "administration", "adminstration"].includes(compact)) {
    return "ADMINISTRATION";
  }
  if (compact === "fr" || compact === "foreignersreception") {
    return "FOREIGNERS RECEPTION";
  }
  if (compact === "mnt" || compact === "maintenance") {
    return "MAINTENANCE";
  }
  if (compact === "hrt" || compact === "horticulture") {
    return "HORTICULTURE";
  }
  if (compact === "es" || compact === "englishsatsang") {
    return "ENGLISH SATSANG";
  }
  if (compact === "baalpathi" || compact === "balpathi") {
    return "BAAL PATHI";
  }
  if (compact === "bav") {
    return "BAV";
  }
  if (compact === "madical" || compact === "medical") {
    return "MEDICAL";
  }
  if (compact === "sanitation") {
    return "SANITATION";
  }
  if (compact === "sevacollection" || compact === "sewacollection") {
    return "SEWA COLLECTION";
  }
  if (compact === "sevasamiti" || compact === "sewasamiti") {
    return "SEWA SAMITI";
  }

  return normalized.toUpperCase();
}

function normalizeDateValue(value) {
  const parsed = parseDateParts(value);
  if (!parsed) return normalizeValue(value);
  return `${parsed.day}-${monthNames[parsed.month - 1]}-${String(parsed.year).slice(-2)}`;
}

function parseDateParts(value) {
  const text = normalizeValue(value);
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

export function sanitizeEmailValue(value) {
  const withoutLabel = normalizeValue(value).replace(
    /^\s*email\s*id\s*[:;\-]?\s*/i,
    ""
  );
  const match = withoutLabel.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
  const email = match ? match[0] : withoutLabel.trim();
  return isGenericEmailValue(email) ? "" : email;
}

function isGenericEmailValue(value) {
  const email = normalizeValue(value).toLowerCase();
  const match = email.match(/^([a-z0-9._%+\-]+)@([a-z0-9.\-]+\.[a-z]{2,})$/);
  if (!match) return false;

  const local = match[1];
  const domain = match[2];
  const compactLocal = local.replace(/[^a-z0-9]/g, "");
  const genericLocals = new Set([
    "a",
    "abc",
    "abcd",
    "abcxyz",
    "xyz",
    "na",
    "noemail",
    "noemailid",
    "test",
  ]);
  const genericDomains = new Set(["xyz.com", "na.com"]);
  const commonDomains = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"]);

  if (genericDomains.has(domain)) return true;
  if (domain === "abc.com" && genericLocals.has(compactLocal)) return true;
  return commonDomains.has(domain) && genericLocals.has(compactLocal);
}

export function normalizeVerificationValue(value) {
  const normalized = normalizeValue(value);
  const comparable = normalized.toLowerCase();
  if (comparable === "" || comparable === "none" || comparable === "to-be-attended") {
    return "None";
  }
  if (comparable === "attended-ok" || comparable === "verification done") {
    return "Verification Done";
  }
  if (comparable === "attended-not-ok" || comparable === "rectification done") {
    return "Rectification Done";
  }
  return verificationOptions.includes(normalized) ? normalized : "None";
}

function summarize(data) {
  const fullName = [
    data["First Name"],
    data["Middle Name"],
    data["Last Name"],
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    fullName,
    badgeNo: data["Badge no."] || "",
    department:
      data["Sewa Dept - Local Centre"] ||
      data["Sewa Dept - Major Centre"] ||
      "",
    phoneNumber: data["Mobile No"] || "",
  };
}

function emptyData() {
  return Object.fromEntries(fields.map((field) => [field, ""]));
}

async function nextSerialNumberPostgres(client, badgeNo) {
  const group = requireBadgeSerialGroup(badgeNo);
  const badgePattern = `${group}%`;
  const { rows } = await client.query(
    `
      SELECT
        COUNT(*)::int AS total,
        COALESCE(MAX(
          CASE
            WHEN $1 = 'PR' AND data->>$2 ~ '^[0-9]+$' THEN (data->>$2)::int
            WHEN $1 = 'EC' AND data->>$2 ~* '^S[0-9]+$' THEN substring(data->>$2 from 2)::int
            ELSE NULL
          END
        ), 0)::int AS max_serial
      FROM people
      WHERE upper(coalesce(data->>$3, badge_no, '')) LIKE $4
    `,
    [group, serialField, badgeField, badgePattern]
  );
  return serialForBadgeGroup(group, Math.max(rows[0]?.max_serial || 0, rows[0]?.total || 0) + 1);
}

function nextSerialNumberSqlite(db, badgeNo) {
  const group = requireBadgeSerialGroup(badgeNo);
  const rows = db.prepare("SELECT data FROM people").all();
  let maxSerial = 0;
  let total = 0;
  for (const row of rows) {
    const data = JSON.parse(row.data);
    if (badgeSerialGroup(data[badgeField]) !== group) continue;
    total += 1;
    const serialNumber = serialNumberForGroup(data[serialField], group);
    if (serialNumber) maxSerial = Math.max(maxSerial, serialNumber);
  }
  return serialForBadgeGroup(group, Math.max(maxSerial, total) + 1);
}

function buildSerialAssignments(people) {
  return ["PR", "EC"].flatMap((group) =>
    people
      .filter((person) => badgeSerialGroup(person.data?.[badgeField] || person.badgeNo) === group)
      .sort(comparePeopleForSerialNumber)
      .map((person, index) => ({
        group,
        person,
        oldSerial: normalizeValue(person.data?.[serialField]),
        newSerial: serialForBadgeGroup(group, index + 1),
      }))
  );
}

function serialGroupSummary(assignments) {
  return ["PR", "EC"].reduce((summary, group) => {
    const groupAssignments = assignments.filter((assignment) => assignment.group === group);
    summary[group] = {
      total: groupAssignments.length,
      first: groupAssignments[0]
        ? serialPreview(groupAssignments[0].person, groupAssignments[0].newSerial)
        : null,
      last: groupAssignments.length
        ? serialPreview(groupAssignments[groupAssignments.length - 1].person, groupAssignments[groupAssignments.length - 1].newSerial)
        : null,
    };
    return summary;
  }, {});
}

function badgeSerialGroup(badgeNo) {
  const badge = normalizeValue(badgeNo).toUpperCase();
  if (badge.startsWith("PR")) return "PR";
  if (badge.startsWith("EC")) return "EC";
  return "";
}

function requireBadgeSerialGroup(badgeNo) {
  const group = badgeSerialGroup(badgeNo);
  if (!group) {
    throw statusError(400, "Badge no. must start with PR or EC before S No can be assigned.");
  }
  return group;
}

function serialForBadgeGroup(group, index) {
  return group === "EC" ? `S${index}` : String(index);
}

function serialNumberForGroup(serialNo, group) {
  const serial = normalizeValue(serialNo);
  if (group === "PR") {
    return /^\d+$/.test(serial) ? Number(serial) : 0;
  }
  const match = serial.match(/^S(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function dataFromAuditSnapshot(change, fallbackData = {}) {
  const data = {};
  for (const field of fields) {
    const fieldChange = change?.[field];
    data[field] =
      fieldChange && Object.hasOwn(fieldChange, "old")
        ? fieldChange.old
        : fallbackData[field] || "";
  }
  return cleanData(data);
}

function rowToPerson(row) {
  return {
    id: Number(row.id),
    fullName: row.full_name,
    badgeNo: row.badge_no || "",
    department: row.department || "",
    phoneNumber: row.phone_number || "",
    updatedAt: row.updated_at || "",
    deletedAt: row.deleted_at || "",
    data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
  };
}

function rowToAuditLog(row) {
  return {
    id: Number(row.id),
    personId: Number(row.person_id),
    name: row.name || "",
    badgeNo: row.badge_no || "",
    changedBy: row.changed_by || "system",
    action: row.action || "update",
    change: typeof row.change === "string" ? JSON.parse(row.change) : row.change,
    createdAt: row.created_at || "",
    restorable: Boolean(row.restorable),
  };
}

function auditLogSelectSql(whereClause = "", limitClause = "") {
  return `
    SELECT
      a.id,
      a.person_id,
      a.name,
      a.badge_no,
      a.changed_by,
      a.action,
      a."change",
      a.created_at,
      CASE
        WHEN a.action = 'delete'
          AND p.deleted_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM audit_logs AS newer
            WHERE newer.person_id = a.person_id
              AND newer.action IN ('delete', 'restore')
              AND (
                newer.created_at > a.created_at
                OR (newer.created_at = a.created_at AND newer.id > a.id)
              )
          )
        THEN TRUE
        ELSE FALSE
      END AS restorable
    FROM audit_logs AS a
    LEFT JOIN people AS p ON p.id = a.person_id
    ${whereClause}
    ORDER BY a.created_at DESC, a.id DESC
    ${limitClause}
  `;
}

function normalizeChangedBy(value) {
  return String(value || "system").trim() || "system";
}

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function applySerialNumberBatchPostgres(client, batch, changedBy) {
  const values = [];
  const placeholders = batch.map((update, index) => {
    const offset = index * 7;
    values.push(
      update.person.id,
      update.summary.fullName,
      update.summary.badgeNo,
      update.summary.department,
      update.summary.phoneNumber,
      update.data,
      update.change
    );
    return `($${offset + 1}::bigint, $${offset + 2}::text, $${offset + 3}::text, $${offset + 4}::text, $${offset + 5}::text, $${offset + 6}::jsonb, $${offset + 7}::jsonb)`;
  });
  const changedByIndex = values.length + 1;
  values.push(changedBy);

  await client.query(
    `
      WITH updates(id, full_name, badge_no, department, phone_number, data, audit_change) AS (
        VALUES ${placeholders.join(", ")}
      ),
      changed AS (
        UPDATE people AS p
        SET full_name = u.full_name,
            badge_no = u.badge_no,
            department = u.department,
            phone_number = u.phone_number,
            data = u.data,
            updated_at = NOW()
        FROM updates AS u
        WHERE p.id = u.id
          AND p.deleted_at IS NULL
        RETURNING u.id, u.full_name, u.badge_no, u.audit_change
      )
      INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
      SELECT id, full_name, badge_no, $${changedByIndex}, 'update', audit_change
      FROM changed
    `,
    values
  );
}

function comparePeopleForSerialNumber(a, b) {
  const badgeA = normalizeValue(a.data?.[badgeField] || a.badgeNo);
  const badgeB = normalizeValue(b.data?.[badgeField] || b.badgeNo);

  if (badgeA && badgeB) {
    const badgeCompare = badgeA.localeCompare(badgeB, "en", {
      numeric: true,
      sensitivity: "base",
    });
    if (badgeCompare !== 0) return badgeCompare;
  } else if (badgeA) {
    return -1;
  } else if (badgeB) {
    return 1;
  }

  const nameCompare = normalizeValue(a.fullName).localeCompare(normalizeValue(b.fullName), "en", {
    numeric: true,
    sensitivity: "base",
  });
  if (nameCompare !== 0) return nameCompare;

  return a.id - b.id;
}

function serialPreview(person, serial) {
  return {
    id: person.id,
    serial: String(serial),
    badgeNo: normalizeValue(person.data?.[badgeField] || person.badgeNo),
    name: person.fullName || "",
  };
}

function toSummary(person) {
  return {
    id: person.id,
    name: person.fullName || "(No name)",
    badgeNo: person.badgeNo,
    department: person.department,
    phoneNumber: person.phoneNumber,
  };
}

function emptyDataQualityFieldSummary(definition) {
  return {
    key: definition.key,
    label: definition.label,
    groups: Object.fromEntries(
      dataQualityGroups.map((group) => [
        group.key,
        Object.fromEntries(dataQualityIssueTypes.map((issueType) => [issueType.key, 0])),
      ])
    ),
    totals: Object.fromEntries(dataQualityIssueTypes.map((issueType) => [issueType.key, 0])),
  };
}

function dataQualityGroupForPerson(person) {
  return dataQualityGroupForStatus(normalizeVerificationValue(person.data?.[verificationField]));
}

function isPrBadgePerson(person) {
  return normalizeValue(person.data?.[badgeField] || person.badgeNo).toUpperCase().startsWith("PR");
}

function dataQualityGroupForStatus(status) {
  return dataQualityGroupByStatus.get(status) || null;
}

function dataQualityDetailsForField(person, definition, validOptions) {
  const values = definition.fields.map((field) => ({
    field,
    value: normalizeValue(person.data?.[field]),
  }));
  const filledValues = values.filter((entry) => entry.value);

  if (filledValues.length === 0) {
    return {
      issueType: "blank",
      rows: [
        {
          field: definition.blankLabel || definition.fields[0],
          value: "",
          issue: "blank",
        },
      ],
    };
  }

  const mismatches = filledValues.filter((entry) => !validOptions.has(entry.value));
  if (mismatches.length === 0) {
    return { issueType: "", rows: [] };
  }

  return {
    issueType: "mismatch",
    rows: mismatches.map((entry) => ({
      field: entry.field,
      value: entry.value,
      issue: "mismatch",
    })),
  };
}

function dataQualityOptionSets() {
  if (dataQualityOptionSetsCache) return dataQualityOptionSetsCache;

  dataQualityOptionSetsCache = new Map();
  for (const definition of dataQualityFields) {
    const options = new Set();
    for (const value of dataQualityOptionsForField(definition)) {
      const normalized = normalizeValue(value);
      if (normalized) options.add(normalized);
    }
    dataQualityOptionSetsCache.set(definition.key, options);
  }
  return dataQualityOptionSetsCache;
}

function dataQualityOptionsForField(definition) {
  if (definition.key === "skills") {
    return [
      ...(dropdownOptions["Skills - 1"] || []),
      ...(dropdownOptions["Skills - 2"] || []),
    ];
  }
  if (definition.key === "state") return locationOptions.states || [];
  if (definition.key === "district") return Object.values(locationOptions.districtsByState || {}).flat();
  if (definition.key === "city") {
    return Object.values(locationOptions.citiesByStateDistrict || {})
      .flatMap((districts) => Object.values(districts || {}).flat());
  }
  return dropdownOptions[definition.fields[0]] || [];
}

function compareDataQualityPeople(a, b) {
  const statusCompare = normalizeValue(a.verificationStatus).localeCompare(normalizeValue(b.verificationStatus), "en", {
    sensitivity: "base",
  });
  if (statusCompare !== 0) return statusCompare;

  const badgeCompare = normalizeValue(a.badgeNo).localeCompare(normalizeValue(b.badgeNo), "en", {
    numeric: true,
    sensitivity: "base",
  });
  if (badgeCompare !== 0) return badgeCompare;

  return normalizeValue(a.name).localeCompare(normalizeValue(b.name), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function matchesQuery(person, query, field) {
  if (!query) return true;

  if (field === "All fields") {
    return [
      person.fullName,
      person.badgeNo,
      person.department,
      person.phoneNumber,
      ...Object.values(person.data),
    ].some((value) => normalizeSearch(value).includes(query));
  }

  return normalizeSearch(person.data[field]).includes(query);
}

function diffData(before, after) {
  const change = {};
  for (const field of fields) {
    const oldValue = normalizeValue(before?.[field]);
    const newValue = normalizeValue(after?.[field]);
    if (oldValue !== newValue) {
      change[field] = {
        old: oldValue,
        new: newValue,
      };
    }
  }
  return change;
}

function getDepartmentOptions(people) {
  const counts = new Map();
  for (const person of people) {
    const department = person.department || "";
    counts.set(department, (counts.get(department) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([department, total]) => ({
      department,
      label: department || "(blank)",
      total,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function allLocationDistricts() {
  return uniqueSorted(Object.values(locationOptions.districtsByState || {}).flat());
}

function allLocationCitiesForDistrict(district) {
  const cities = [];
  for (const districts of Object.values(locationOptions.citiesByStateDistrict || {})) {
    cities.push(...(districts?.[district] || []));
  }
  return uniqueSorted(cities);
}

function findOption(value, options = []) {
  const normalized = normalizeSearch(value);
  if (!normalized) return "";
  return options.find((option) => normalizeSearch(option) === normalized) || "";
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
}

function countStatuses(people) {
  const counts = {
    attended: 0,
    rectified: 0,
    notAttended: 0,
  };

  for (const person of people) {
    const status = normalizeVerificationValue(person.data?.[verificationField]);
    if (status === "Rectification Done") {
      counts.attended += 1;
      counts.rectified += 1;
    } else if (status === "Verification Done") {
      counts.attended += 1;
    } else {
      counts.notAttended += 1;
    }
  }

  return counts;
}

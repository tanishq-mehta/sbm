from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV = ROOT / ".env"
DEFAULT_ACTIVE_WORKBOOK = Path("/Users/tmehta/Downloads/aCTIVE LIST.xlsx")
DEFAULT_CANCELLED_WORKBOOK = Path("/Users/tmehta/Downloads/CANCELLED LIST.xlsx")
REPORTS_DIR = ROOT / "reports"
TARGET_FIELD = "Condition"
DATABASE_IDENTIFIER_FIELDS = ["Badge no.", "EC No."]
CONDITION_OPTIONS = ["Active", "Inactive", "Cancelled", "Transferred", "Withdrawn", "Expired"]
CONDITION_STATUS_MAP = {
    "CANCELLED": "Cancelled",
    "CANCELED": "Cancelled",
    "TRANSFERRED": "Transferred",
    "WITHDRAWAL": "Withdrawn",
    "WITHDRAWL": "Withdrawn",
    "WITHDRAWN": "Withdrawn",
    "EXPIRED": "Expired",
}
SHEET_NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = {"rel": "http://schemas.openxmlformats.org/package/2006/relationships"}
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

DB_HELPER = r"""
import pg from 'pg';

const input = JSON.parse(await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => data += chunk);
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
}));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

try {
  if (input.command === 'people') {
    const { rows } = await pool.query(`
      SELECT id, full_name, badge_no, data
      FROM people
      WHERE deleted_at IS NULL
      ORDER BY id
    `);
    console.log(JSON.stringify({
      people: rows.map((row) => ({
        id: Number(row.id),
        fullName: row.full_name || '',
        badgeNo: row.badge_no || '',
        data: row.data || {},
      })),
    }));
  } else if (input.command === 'apply') {
    const client = await pool.connect();
    const updatesJson = JSON.stringify(input.updates || []);
    const changedBy = input.changedBy || 'system-condition-import';
    const result = {
      updatedPeople: 0,
      alreadyCurrent: 0,
      staleSkipped: [],
      failed: [],
    };

    try {
      await client.query('BEGIN');

      const current = await client.query(
        `
          WITH input_rows AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS input(id bigint, name text, "badgeNo" text, "oldCondition" text, "targetCondition" text)
          )
          SELECT
            input.id,
            input."badgeNo",
            COALESCE(input."oldCondition", '') AS expected,
            COALESCE(people.data->>'Condition', '') AS actual,
            input."targetCondition" AS target
          FROM input_rows input
          JOIN people ON people.id = input.id
        `,
        [updatesJson]
      );

      for (const row of current.rows) {
        if ((row.actual || '') === row.target) {
          result.alreadyCurrent += 1;
        } else if ((row.actual || '') !== (row.expected || '')) {
          result.staleSkipped.push({
            id: Number(row.id),
            badgeNo: row.badgeNo || '',
            expected: row.expected || '',
            actual: row.actual || '',
            target: row.target,
          });
        }
      }

      const apply = await client.query(
        `
          WITH input_rows AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS input(id bigint, name text, "badgeNo" text, "oldCondition" text, "targetCondition" text)
          ),
          updated AS (
            UPDATE people
            SET data = jsonb_set(people.data, '{Condition}', to_jsonb(input_rows."targetCondition"::text), true),
                updated_at = NOW()
            FROM input_rows
            WHERE people.id = input_rows.id
              AND COALESCE(people.data->>'Condition', '') = COALESCE(input_rows."oldCondition", '')
            RETURNING
              people.id,
              input_rows.name,
              input_rows."badgeNo",
              COALESCE(input_rows."oldCondition", '') AS old_condition,
              input_rows."targetCondition" AS target_condition
          ),
          audit AS (
            INSERT INTO audit_logs (person_id, name, badge_no, changed_by, action, "change")
            SELECT
              updated.id,
              COALESCE(updated.name, ''),
              COALESCE(updated."badgeNo", ''),
              $2,
              'update',
              jsonb_build_object(
                'Condition',
                jsonb_build_object('old', updated.old_condition, 'new', updated.target_condition)
              )
            FROM updated
            RETURNING person_id
          )
          SELECT
            (SELECT COUNT(*)::int FROM updated) AS updated_count,
            (SELECT COUNT(*)::int FROM audit) AS audit_count
        `,
        [updatesJson, changedBy]
      );
      const updatedCount = Number(apply.rows[0]?.updated_count || 0);
      const auditCount = Number(apply.rows[0]?.audit_count || 0);
      if (updatedCount !== auditCount) {
        result.failed.push({
          id: 0,
          badgeNo: '',
          message: `Audit count mismatch: updated ${updatedCount}, audit ${auditCount}`,
        });
      }
      result.updatedPeople = updatedCount;

      if (result.failed.length) {
        await client.query('ROLLBACK');
      } else {
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    console.log(JSON.stringify(result));
  } else {
    throw new Error(`Unknown command: ${input.command}`);
  }
} finally {
  await pool.end();
}
"""


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import Condition values from active and cancelled PRC lists into prod."
    )
    parser.add_argument("--active-workbook", default=str(DEFAULT_ACTIVE_WORKBOOK))
    parser.add_argument("--cancelled-workbook", default=str(DEFAULT_CANCELLED_WORKBOOK))
    parser.add_argument("--env", default=str(DEFAULT_ENV))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--changed-by", default="system-condition-import")
    args = parser.parse_args()

    env_path = Path(args.env)
    load_env(env_path)
    required_env("DATABASE_URL", env_path)

    active_workbook = Path(args.active_workbook)
    cancelled_workbook = Path(args.cancelled_workbook)
    source_rows, source_summary = read_source_rows(active_workbook, cancelled_workbook)
    people = db_command({"command": "people"})["people"]
    plan = build_plan(source_rows, people)

    report = report_payload(args, active_workbook, cancelled_workbook, source_summary, people, plan)
    write_report(report)
    print(json.dumps(summary_payload(report), indent=2))

    if not args.apply:
        print("Dry run only. Re-run with --apply to update prod data.")
        return

    if plan["ambiguous"]:
        raise SystemExit("Refusing to apply while ambiguous matches exist.")

    apply_result = db_command(
        {
            "command": "apply",
            "changedBy": args.changed_by,
            "updates": plan["updates"],
        }
    )
    report["mode"] = "apply"
    report["applyResult"] = apply_result
    write_report(report)
    print(json.dumps(apply_result, indent=2))
    if apply_result["failed"] or apply_result["staleSkipped"]:
        raise SystemExit(1)


def read_source_rows(active_workbook: Path, cancelled_workbook: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    active_rows, active_summary = read_active_rows(active_workbook)
    cancelled_rows, cancelled_summary = read_cancelled_rows(cancelled_workbook)
    rows = active_rows + cancelled_rows
    source_key_counts = Counter(row["identifierKey"] for row in rows if row["identifierKey"])
    duplicates = [
        {"identifierKey": key, "count": count}
        for key, count in sorted(source_key_counts.items())
        if count > 1
    ]
    return rows, {
        "active": active_summary,
        "cancelled": cancelled_summary,
        "totalUsableRows": len(rows),
        "duplicateSourceIdentifiers": duplicates,
    }


def read_active_rows(workbook_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows = read_first_sheet_rows(workbook_path)
    header_row_index, headers = find_header_row(rows, {"sewadarid", "active"})
    header_index = header_indexes(headers)
    output = []
    skipped_not_active = 0
    skipped_blank_identifier = 0

    for row_number, row in enumerate(rows[header_row_index + 1 :], header_row_index + 2):
        if not row_has_content(row):
            continue
        active_value = cell_value(row, header_index.get("active"))
        identifier = cell_value(row, header_index.get("sewadarid"))
        if active_value != "-1":
            skipped_not_active += 1
            continue
        if not identifier:
            skipped_blank_identifier += 1
            continue
        output.append(
            {
                "source": "active",
                "rowNumber": row_number,
                "identifier": identifier,
                "identifierKey": identifier_key(identifier),
                "name": cell_value(row, header_index.get("name")),
                "sourceValue": active_value,
                "targetCondition": "Active",
            }
        )

    return output, {
        "workbook": str(workbook_path),
        "rowsAfterHeader": max(0, len(rows) - header_row_index - 1),
        "usableRows": len(output),
        "skippedNotActive": skipped_not_active,
        "skippedBlankIdentifier": skipped_blank_identifier,
    }


def read_cancelled_rows(workbook_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows = read_first_sheet_rows(workbook_path)
    header_row_index, headers = find_header_row(rows, {"grno", "status"})
    header_index = header_indexes(headers)
    output = []
    skipped_blank_identifier = 0
    skipped_blank_status = 0
    unsupported_statuses = []
    status_counts: Counter[str] = Counter()

    for row_number, row in enumerate(rows[header_row_index + 1 :], header_row_index + 2):
        if not row_has_content(row):
            continue
        identifier = cell_value(row, header_index.get("grno"))
        raw_status = cell_value(row, header_index.get("status"))
        status_counts[raw_status] += 1
        if not identifier:
            skipped_blank_identifier += 1
            continue
        if not raw_status:
            skipped_blank_status += 1
            continue
        condition = condition_from_status(raw_status)
        if not condition:
            unsupported_statuses.append({"rowNumber": row_number, "identifier": identifier, "status": raw_status})
            continue
        output.append(
            {
                "source": "cancelled",
                "rowNumber": row_number,
                "identifier": identifier,
                "identifierKey": identifier_key(identifier),
                "name": cell_value(row, header_index.get("name")) or cell_value(row, header_index.get("displayname")),
                "sourceValue": raw_status,
                "targetCondition": condition,
            }
        )

    return output, {
        "workbook": str(workbook_path),
        "rowsAfterHeader": max(0, len(rows) - header_row_index - 1),
        "usableRows": len(output),
        "sourceStatusCounts": dict(status_counts),
        "skippedBlankIdentifier": skipped_blank_identifier,
        "skippedBlankStatus": skipped_blank_status,
        "unsupportedStatuses": unsupported_statuses,
    }


def build_plan(source_rows: list[dict[str, Any]], people: list[dict[str, Any]]) -> dict[str, Any]:
    people_by_key = index_people_by_identifier(people)
    proposals_by_person: dict[int, dict[str, Any]] = {}
    unmatched = []
    ambiguous = []
    name_mismatches = []

    for row in source_rows:
        matches = people_by_key.get(row["identifierKey"], [])
        if not matches:
            unmatched.append(source_preview(row))
            continue
        if len(matches) > 1:
            named_matches = [person for person in matches if name_key(person.get("fullName")) == name_key(row["name"])]
            if len(named_matches) == 1:
                matches = named_matches
            else:
                ambiguous.append({**source_preview(row), "dbMatches": [person_preview(person) for person in matches]})
                continue

        person = matches[0]
        if row["name"] and person.get("fullName") and name_key(row["name"]) != name_key(person.get("fullName")):
            name_mismatches.append({**source_preview(row), "dbMatch": person_preview(person)})

        data = person.get("data") or {}
        person_id = int(person["id"])
        proposal = proposals_by_person.setdefault(
            person_id,
            {
                "id": person_id,
                "badgeNo": text(data.get("Badge no.") or person.get("badgeNo")),
                "ecNo": text(data.get("EC No.")),
                "name": text(person.get("fullName")),
                "oldCondition": text(data.get(TARGET_FIELD)),
                "targetCondition": row["targetCondition"],
                "sourceRows": [],
            },
        )
        proposal["sourceRows"].append(source_preview(row))
        if proposal["targetCondition"] != row["targetCondition"]:
            proposal["conflictingConditions"] = sorted(
                {proposal["targetCondition"], row["targetCondition"]}
            )

    updates = []
    already_current = []
    conflicts = []
    for proposal in proposals_by_person.values():
        if proposal.get("conflictingConditions"):
            conflicts.append(proposal)
        elif proposal["oldCondition"] == proposal["targetCondition"]:
            already_current.append(proposal)
        else:
            updates.append(proposal)

    for collection in [updates, already_current, conflicts]:
        collection.sort(key=lambda item: (item["badgeNo"], item["name"], item["id"]))

    return {
        "updates": updates,
        "alreadyCurrent": already_current,
        "conflicts": conflicts,
        "unmatched": unmatched,
        "ambiguous": ambiguous,
        "nameMismatches": name_mismatches,
    }


def index_people_by_identifier(people: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    index: dict[str, list[dict[str, Any]]] = {}
    seen: set[tuple[str, int]] = set()
    for person in people:
        data = person.get("data") or {}
        identifiers = [
            person.get("badgeNo"),
            *(data.get(field) for field in DATABASE_IDENTIFIER_FIELDS),
        ]
        for identifier in identifiers:
            key = identifier_key(identifier)
            seen_key = (key, int(person["id"]))
            if key and seen_key not in seen:
                index.setdefault(key, []).append(person)
                seen.add(seen_key)
    return index


def report_payload(
    args: argparse.Namespace,
    active_workbook: Path,
    cancelled_workbook: Path,
    source_summary: dict[str, Any],
    people: list[dict[str, Any]],
    plan: dict[str, Any],
) -> dict[str, Any]:
    condition_counts = Counter(entry["targetCondition"] for entry in plan["updates"])
    already_counts = Counter(entry["targetCondition"] for entry in plan["alreadyCurrent"])
    current_counts = Counter(text((person.get("data") or {}).get(TARGET_FIELD)) for person in people)
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "mode": "apply" if args.apply else "dry-run",
        "activeWorkbook": str(active_workbook),
        "cancelledWorkbook": str(cancelled_workbook),
        "source": source_summary,
        "currentConditionCounts": dict(current_counts),
        "updates": plan["updates"],
        "alreadyCurrent": plan["alreadyCurrent"],
        "conflicts": plan["conflicts"],
        "unmatched": plan["unmatched"],
        "ambiguous": plan["ambiguous"],
        "nameMismatches": plan["nameMismatches"],
        "summary": {
            "databasePeople": len(people),
            "peopleToUpdate": len(plan["updates"]),
            "conditionCountsToUpdate": dict(condition_counts),
            "alreadyCurrent": len(plan["alreadyCurrent"]),
            "alreadyCurrentConditionCounts": dict(already_counts),
            "conflicts": len(plan["conflicts"]),
            "unmatched": len(plan["unmatched"]),
            "ambiguous": len(plan["ambiguous"]),
            "nameMismatches": len(plan["nameMismatches"]),
        },
    }


def summary_payload(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": report["mode"],
        "reportPath": report["reportPath"],
        **report["summary"],
        "source": {
            "active": report["source"]["active"],
            "cancelled": report["source"]["cancelled"],
            "totalUsableRows": report["source"]["totalUsableRows"],
            "duplicateSourceIdentifiers": report["source"]["duplicateSourceIdentifiers"][:20],
        },
        "currentConditionCounts": report["currentConditionCounts"],
        "preview": report["updates"][:10],
        "conflictPreview": report["conflicts"][:10],
        "unmatchedPreview": report["unmatched"][:10],
        "ambiguousPreview": report["ambiguous"][:10],
        "nameMismatchPreview": report["nameMismatches"][:10],
    }


def write_report(report: dict[str, Any]) -> None:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = REPORTS_DIR / f"condition-import-{timestamp}.json"
    report["reportPath"] = str(report_path)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def db_command(payload: dict[str, Any]) -> dict[str, Any]:
    process = subprocess.run(
        ["node", "--input-type=module", "--eval", DB_HELPER],
        input=json.dumps(payload),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=ROOT,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.strip() or process.stdout.strip() or "Database helper failed.")
    try:
        return json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Database helper returned invalid JSON: {process.stdout}") from error


def read_first_sheet_rows(workbook_path: Path) -> list[list[str]]:
    if not workbook_path.exists():
        raise RuntimeError(f"Workbook not found: {workbook_path}")
    with ZipFile(workbook_path) as archive:
        shared_strings = read_shared_strings(archive)
        sheet_path = first_sheet_path(archive)
        root = ET.fromstring(archive.read(sheet_path))
        rows = []
        for row_node in root.findall("a:sheetData/a:row", SHEET_NS):
            row: list[str] = []
            for cell_node in row_node.findall("a:c", SHEET_NS):
                index = column_index(cell_node.attrib.get("r", "A1"))
                while len(row) <= index:
                    row.append("")
                row[index] = read_cell_value(cell_node, shared_strings)
            rows.append(row)
        return rows


def first_sheet_path(archive: ZipFile) -> str:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    rel_targets = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels.findall("rel:Relationship", REL_NS)}
    first_sheet = workbook.find("a:sheets/a:sheet", SHEET_NS)
    if first_sheet is None:
        raise RuntimeError("Workbook does not contain any worksheets.")
    rel_id = first_sheet.attrib[f"{{{OFFICE_REL_NS}}}id"]
    target = rel_targets[rel_id]
    return target if target.startswith("xl/") else f"xl/{target.lstrip('/')}"


def read_shared_strings(archive: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    return [
        "".join(text_node.text or "" for text_node in item.findall(".//a:t", SHEET_NS)).strip()
        for item in root.findall("a:si", SHEET_NS)
    ]


def read_cell_value(cell_node: ET.Element, shared_strings: list[str]) -> str:
    cell_type = cell_node.attrib.get("t", "")
    if cell_type == "inlineStr":
        return "".join(text_node.text or "" for text_node in cell_node.findall(".//a:t", SHEET_NS)).strip()

    value_node = cell_node.find("a:v", SHEET_NS)
    if value_node is None:
        return ""
    value = (value_node.text or "").strip()
    if cell_type == "s":
        try:
            return shared_strings[int(value)]
        except (IndexError, ValueError):
            return value
    if cell_type == "b":
        return "-1" if value == "1" else "0"
    return value


def column_index(reference: str) -> int:
    column = re.sub(r"[^A-Za-z]", "", reference)
    index = 0
    for char in column.upper():
        index = index * 26 + ord(char) - 64
    return max(0, index - 1)


def find_header_row(rows: list[list[str]], required_headers: set[str]) -> tuple[int, list[str]]:
    for index, row in enumerate(rows[:20]):
        headers = {header_key(value) for value in row if value}
        if required_headers.issubset(headers):
            return index, row
    raise RuntimeError(f"Could not find header row with: {', '.join(sorted(required_headers))}")


def header_indexes(headers: list[str]) -> dict[str, int]:
    return {header_key(value): index for index, value in enumerate(headers) if value}


def header_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", text(value).lower())


def cell_value(row: list[str], index: int | None) -> str:
    if index is None or index >= len(row):
        return ""
    return text(row[index])


def row_has_content(row: list[str]) -> bool:
    return any(text(value) for value in row)


def condition_from_status(value: str) -> str:
    return CONDITION_STATUS_MAP.get(text(value).upper(), "")


def source_preview(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": row["source"],
        "rowNumber": row["rowNumber"],
        "identifier": row["identifier"],
        "name": row["name"],
        "sourceValue": row["sourceValue"],
        "targetCondition": row["targetCondition"],
    }


def person_preview(person: dict[str, Any]) -> dict[str, Any]:
    data = person.get("data") or {}
    return {
        "id": person.get("id"),
        "name": person.get("fullName") or person.get("name") or "",
        "badgeNo": data.get("Badge no.") or person.get("badgeNo") or "",
        "ecNo": data.get("EC No.") or "",
        "condition": data.get(TARGET_FIELD) or "",
    }


def identifier_key(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]+", "", text(value).upper())


def name_key(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]+", "", text(value).upper())


def text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def load_env(path: Path) -> None:
    if not path.exists():
        raise RuntimeError(f"Missing env file: {path}")
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def required_env(key: str, env_path: Path) -> str:
    value = os.environ.get(key, "").strip()
    if not value:
        raise RuntimeError(f"Set {key} in {env_path}.")
    return value


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise

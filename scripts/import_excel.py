from __future__ import annotations

import argparse
import json
import math
import re
from datetime import date, datetime
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
TARGET_SHEETS = {f"team{i}" for i in range(1, 7)}
HEADER_MARKERS = {"Badge no.", "First Name", "Mobile No"}
VERIFICATION_OPTIONS = ["None", "Verification Done", "Rectification Done"]
INITIATION_BY_OPTIONS = [
    "Baba Gurinder Singh Ji",
    "Maharaj Charan Singh Ji",
    "Maharaj Jagat Singh Ji",
    "Maharaj Sawan Singh Ji",
    "Hazur Jasdeep Singh Ji",
]
DATE_FIELDS = {"Birth Date", "Initiation Date"}
DEPARTMENT_FIELDS = {"Sewa Dept - Local Centre", "Sewa Dept - Major Centre"}
MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def verification_value(value: object) -> str:
    normalized = normalize_value(value)
    comparable = normalized.lower()
    if comparable in {"", "none", "to-be-attended"}:
        return "None"
    if comparable in {"attended-ok", "verification done"}:
        return "Verification Done"
    if comparable in {"attended-not-ok", "rectification done"}:
        return "Rectification Done"
    return normalized


def canonical_sheet_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def normalize_value(value: object) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except TypeError:
        pass
    if isinstance(value, (datetime, pd.Timestamp)):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float):
        if math.isfinite(value) and value.is_integer():
            return str(int(value))
        return str(value)
    return str(value).strip()


def normalize_field_value(field: str, value: object) -> str:
    normalized = normalize_value(value)
    if field == "Verification Status":
        return verification_value(value)
    if field in DATE_FIELDS:
        return date_value(value)
    if field in DEPARTMENT_FIELDS:
        return department_value(value)
    if field == "Email Id":
        normalized = re.sub(r"^\s*email\s*id\s*[:;\-]?\s*", "", normalized, flags=re.IGNORECASE)
        match = re.search(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", normalized, flags=re.IGNORECASE)
        if match:
            return match.group(0)
    return normalized


def department_value(value: object) -> str:
    normalized = normalize_value(value)
    compact = re.sub(r"[.\s_-]+", "", normalized.lower())
    if compact in {"admin", "administration", "adminstration"}:
        return "Administration"
    if compact in {"fr", "foreignersreception"}:
        return "Foreigners Reception"
    if compact in {"mnt", "maintenance"}:
        return "Maintenance"
    if compact in {"hrt", "horticulture"}:
        return "HORTICULTURE"
    if compact == "bav":
        return "BAV"
    if compact in {"madical", "medical"}:
        return "MEDICAL"
    if compact == "sanitation":
        return "SANITATION"
    if compact in {"sevacollection", "sewacollection"}:
        return "Sewa Collection"
    if compact in {"sevasamiti", "sewasamiti"}:
        return "Sewa Samiti"
    return normalized


def date_value(value: object) -> str:
    if isinstance(value, (datetime, pd.Timestamp)):
        return format_date_parts(value.year, value.month, value.day)
    if isinstance(value, date):
        return format_date_parts(value.year, value.month, value.day)

    normalized = normalize_value(value)
    if not normalized:
        return ""

    parsed = parse_date_parts(normalized)
    if not parsed:
        return normalized
    year, month, day = parsed
    return format_date_parts(year, month, day)


def parse_date_parts(value: str) -> tuple[int, int, int] | None:
    match = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", value)
    if match:
        return valid_date(int(match.group(1)), int(match.group(2)), int(match.group(3)))

    match = re.match(r"^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})$", value)
    if match:
        month = month_from_text(match.group(2))
        if not month:
            return None
        return valid_date(expand_year(match.group(3)), month, int(match.group(1)))

    match = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", value)
    if match:
        return valid_date(expand_year(match.group(3)), int(match.group(2)), int(match.group(1)))

    return None


def month_from_text(value: str) -> int:
    lower = value.lower()
    for index, month in enumerate(MONTH_NAMES, start=1):
        if lower.startswith(month):
            return index
    return 0


def expand_year(value: str) -> int:
    year = int(value)
    if len(value) == 4:
        return year
    current_two_digit_year = datetime.now().year % 100
    return 2000 + year if year <= current_two_digit_year else 1900 + year


def valid_date(year: int, month: int, day: int) -> tuple[int, int, int] | None:
    try:
        date(year, month, day)
    except ValueError:
        return None
    if year < 1900 or year > 2099:
        return None
    return year, month, day


def format_date_parts(year: int, month: int, day: int) -> str:
    return f"{day}-{MONTH_NAMES[month - 1]}-{str(year)[-2:]}"


def sheet_values(workbook: Path, sheet_name: str, value_mapper=normalize_value) -> list[str]:
    frame = pd.read_excel(workbook, sheet_name=sheet_name, header=0, dtype=object)
    if frame.empty or len(frame.columns) < 2:
        return []
    values: list[str] = []
    seen: set[str] = set()
    for value in frame.iloc[:, 1].tolist():
        normalized = value_mapper(value)
        if not normalized or normalized.lower() in seen:
            continue
        seen.add(normalized.lower())
        values.append(normalized)
    return values


def dropdown_options(workbook: Path) -> dict[str, list[str]]:
    skills = sheet_values(workbook, "Skills")
    departments = sheet_values(workbook, "Seva Department", department_value)
    return {
        "Verification Status": VERIFICATION_OPTIONS,
        "Skills - 1": skills,
        "Skills - 2": skills,
        "Profession": sheet_values(workbook, "Profession"),
        "Educational Qualification": sheet_values(workbook, "Qualification"),
        "Sewa Dept - Local Centre": departments,
        "Sewa Dept - Major Centre": departments,
        "Initiation_By": INITIATION_BY_OPTIONS,
    }


def find_header_row(workbook: Path, sheet_name: str) -> int:
    raw = pd.read_excel(workbook, sheet_name=sheet_name, header=None, dtype=object)
    for index, row in raw.iterrows():
        values = {normalize_value(value) for value in row.tolist()}
        if HEADER_MARKERS.issubset(values):
            return int(index)
    raise ValueError(f"Could not find header row in {sheet_name}")


def full_name(data: dict[str, str]) -> str:
    parts = [
        data.get("First Name", ""),
        data.get("Middle Name", ""),
        data.get("Last Name", "")
    ]
    return " ".join(part for part in parts if part).strip()


def department(data: dict[str, str]) -> str:
    return (
        data.get("Sewa Dept - Local Centre")
        or data.get("Sewa Dept - Major Centre")
        or data.get("Department")
        or ""
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Import TEAM 1..TEAM 6 sheets into seed JSON.")
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--out-dir", type=Path, default=ROOT / "data")
    args = parser.parse_args()

    excel = pd.ExcelFile(args.workbook)
    selected = [
        sheet
        for sheet in excel.sheet_names
        if canonical_sheet_name(sheet) in TARGET_SHEETS
    ]
    if len(selected) != 6:
        raise SystemExit(f"Expected 6 team sheets, found {len(selected)}: {selected}")

    fields: list[str] | None = None
    people: list[dict[str, object]] = []

    for sheet in selected:
        header_row = find_header_row(args.workbook, sheet)
        frame = pd.read_excel(args.workbook, sheet_name=sheet, header=header_row, dtype=object)
        frame = frame.dropna(how="all")
        frame.columns = [normalize_value(column) for column in frame.columns]

        if fields is None:
            fields = list(frame.columns)

        for _, row in frame.iterrows():
            data = {field: normalize_field_value(field, row.get(field, "")) for field in fields}
            if not (data.get("Badge no.") or data.get("First Name") or data.get("Mobile No")):
                continue
            people.append(
                {
                    "fullName": full_name(data),
                    "badgeNo": data.get("Badge no.", ""),
                    "department": department(data),
                    "phoneNumber": data.get("Mobile No", ""),
                    "data": data,
                }
            )

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "fields.json").write_text(
        json.dumps(fields or [], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    (args.out_dir / "people-seed.json").write_text(
        json.dumps(people, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    (args.out_dir / "dropdown-options.json").write_text(
        json.dumps(dropdown_options(args.workbook), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Wrote {len(people)} people and {len(fields or [])} fields to {args.out_dir}")


if __name__ == "__main__":
    main()

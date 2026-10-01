import { readWorkbookSheets } from "./xlsx.mjs";

const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const badgeHeaders = new Set([
  "batch",
  "batchno",
  "batchnumber",
  "badge",
  "badgeno",
  "badgenumber",
  "ecno",
  "ecnumber",
  "grno",
  "grnumber",
]);
const dateHeaders = new Set([
  "date",
  "attendancedate",
  "attendeddate",
  "lastattendeddate",
  "sewadate",
  "satsangdate",
]);

export const attendanceReportHeaders = [
  "File",
  "Sheet",
  "Row",
  "Original Badge",
  "Final Badge",
  "Badge Type",
  "Attendance Date",
  "Name",
  "DB Badge",
  "Result",
  "Message",
  "Attendance Before",
  "Attendance After",
  "Last Attended Before",
  "Last Attended After",
];

export function previewAttendanceFiles(files = []) {
  const rows = [];
  const safeFiles = Array.isArray(files) ? files : [];

  for (const [fileIndex, file] of safeFiles.entries()) {
    const fileName = normalizeValue(file?.fileName) || `Workbook ${fileIndex + 1}`;
    if (!/\.xlsx$/i.test(fileName)) {
      rows.push(fileIssueRow({
        fileIndex,
        fileName,
        message: "Only .xlsx workbooks are supported.",
      }));
      continue;
    }

    try {
      const workbook = Buffer.from(stripDataUrlPrefix(file?.dataBase64 || ""), "base64");
      const sheets = readWorkbookSheets(workbook);
      if (!sheets.length) {
        rows.push(fileIssueRow({
          fileIndex,
          fileName,
          message: "No worksheets were found in this workbook.",
        }));
        continue;
      }

      for (const [sheetIndex, sheet] of sheets.entries()) {
        rows.push(...extractAttendanceRows({
          fileIndex,
          sheetIndex,
          fileName,
          sheet,
        }));
      }
    } catch (error) {
      rows.push(fileIssueRow({
        fileIndex,
        fileName,
        message: error.message || "Could not read this workbook.",
      }));
    }
  }

  return {
    rows,
    summary: summarizePreviewRows(rows),
  };
}

export function normalizeAttendanceBadge(value) {
  const raw = normalizeValue(value);
  if (!raw) {
    return {
      raw,
      value: "",
      type: "",
      valid: false,
      message: "Badge number is blank.",
    };
  }

  const compact = raw
    .toUpperCase()
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, "");

  if (compact.startsWith("PR")) {
    const badgeNo = compact.replace(/[^A-Z0-9]/g, "");
    return /^PR0012[A-Z0-9]+$/.test(badgeNo)
      ? { raw, value: badgeNo, type: "Permanent", valid: true, message: "" }
      : {
          raw,
          value: badgeNo,
          type: "Permanent",
          valid: false,
          message: "Permanent badge numbers must start with PR0012 and contain only letters/numbers.",
        };
  }

  if (compact.startsWith("EC")) {
    const suffix = compact.slice(2).replace(/^-+/, "");
    return /^\d+$/.test(suffix)
      ? { raw, value: `EC-${suffix}`, type: "Open", valid: true, message: "" }
      : {
          raw,
          value: compact,
          type: "Open",
          valid: false,
          message: "Open badge numbers must use EC- followed by digits.",
        };
  }

  return {
    raw,
    value: compact,
    type: "",
    valid: false,
    message: "Badge number must start with PR0012 or EC-.",
  };
}

export function normalizeAttendanceDate(value) {
  const raw = normalizeValue(value);
  if (!raw) {
    return {
      raw,
      value: "",
      iso: "",
      valid: false,
      message: "Attendance date is blank.",
    };
  }

  const serial = excelDateSerial(raw);
  const parts = serial ? datePartsFromExcelSerial(serial) : parseDateParts(raw);
  if (!parts) {
    return {
      raw,
      value: raw,
      iso: "",
      valid: false,
      message: "Attendance date must be a valid date.",
    };
  }

  return {
    raw,
    value: formatAttendanceDateParts(parts),
    iso: datePartsToIso(parts),
    valid: true,
    message: "",
  };
}

export function formatAttendanceDateFromIso(value) {
  const parts = parseDateParts(value);
  return parts ? formatAttendanceDateParts(parts) : normalizeValue(value);
}

export function attendanceReportRows(rows = []) {
  return rows.map((row) => attendanceReportHeaders.map((header) => row[header] || ""));
}

function extractAttendanceRows({ fileIndex, sheetIndex, fileName, sheet }) {
  const nonEmptyRows = (sheet.rows || []).filter((row) => row.values.some((value) => normalizeValue(value)));
  if (!nonEmptyRows.length) return [];

  const columns = detectAttendanceColumns(nonEmptyRows);
  if (!columns) {
    return [
      fileIssueRow({
        fileIndex,
        sheetIndex,
        fileName,
        sheetName: sheet.name,
        message: "Could not identify badge and date columns.",
      }),
    ];
  }

  const rows = [];
  for (const row of nonEmptyRows.slice(columns.startRowIndex)) {
    const rawBadge = normalizeValue(row.values[columns.badgeIndex]);
    const rawDate = normalizeValue(row.values[columns.dateIndex]);
    if (!rawBadge && !rawDate) continue;

    const badge = normalizeAttendanceBadge(rawBadge);
    const date = normalizeAttendanceDate(rawDate);
    const issues = [
      badge.valid ? "" : badge.message,
      date.valid ? "" : date.message,
    ].filter(Boolean);

    rows.push({
      clientRowId: [
        fileIndex,
        sheetIndex,
        row.rowNumber,
        rows.length,
      ].join(":"),
      fileName,
      sheetName: sheet.name,
      rowNumber: row.rowNumber,
      rawBadge,
      rawDate,
      badgeNo: badge.value,
      badgeType: badge.type,
      attendanceDate: date.value,
      attendanceDateIso: date.iso,
      issues,
      needsReview: issues.length > 0,
    });
  }

  return rows.length
    ? rows
    : [
        fileIssueRow({
          fileIndex,
          sheetIndex,
          fileName,
          sheetName: sheet.name,
          message: "No attendance rows were found in the detected columns.",
        }),
      ];
}

function detectAttendanceColumns(rows) {
  const candidates = rows.slice(0, 10);
  for (const [candidateIndex, row] of candidates.entries()) {
    const keys = row.values.map(headerKey);
    const nonEmptyIndexes = row.values
      .map((value, index) => (normalizeValue(value) ? index : -1))
      .filter((index) => index >= 0);
    let badgeIndex = keys.findIndex((key) => badgeHeaders.has(key));
    let dateIndex = keys.findIndex((key) => dateHeaders.has(key));

    if (badgeIndex >= 0 && dateIndex < 0 && nonEmptyIndexes.length === 2) {
      dateIndex = nonEmptyIndexes.find((index) => index !== badgeIndex) ?? -1;
    }
    if (dateIndex >= 0 && badgeIndex < 0 && nonEmptyIndexes.length === 2) {
      badgeIndex = nonEmptyIndexes.find((index) => index !== dateIndex) ?? -1;
    }
    if (badgeIndex >= 0 && dateIndex >= 0 && badgeIndex !== dateIndex) {
      return {
        badgeIndex,
        dateIndex,
        startRowIndex: candidateIndex + 1,
      };
    }
  }

  const firstDataRowIndex = rows.findIndex((row) =>
    row.values.filter((value) => normalizeValue(value)).length >= 2
  );
  if (firstDataRowIndex < 0) return null;

  const indexes = rows[firstDataRowIndex].values
    .map((value, index) => (normalizeValue(value) ? index : -1))
    .filter((index) => index >= 0);

  return {
    badgeIndex: indexes[0],
    dateIndex: indexes[1],
    startRowIndex: firstDataRowIndex,
  };
}

function fileIssueRow({ fileIndex, sheetIndex = 0, fileName, sheetName = "", message }) {
  return {
    clientRowId: `issue:${fileIndex}:${sheetIndex}:${message}`,
    fileName,
    sheetName,
    rowNumber: "",
    rawBadge: "",
    rawDate: "",
    badgeNo: "",
    badgeType: "",
    attendanceDate: "",
    attendanceDateIso: "",
    issues: [message],
    needsReview: true,
    fileIssue: true,
  };
}

function summarizePreviewRows(rows) {
  return {
    totalRows: rows.filter((row) => !row.fileIssue).length,
    reviewRows: rows.filter((row) => row.needsReview).length,
    fileIssues: rows.filter((row) => row.fileIssue).length,
    readyRows: rows.filter((row) => !row.fileIssue && !row.needsReview).length,
  };
}

function headerKey(value) {
  return normalizeValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function stripDataUrlPrefix(value) {
  const text = String(value || "");
  return text.includes(",") ? text.split(",", 2)[1] : text;
}

function excelDateSerial(value) {
  const text = normalizeValue(value);
  if (!/^\d+(\.\d+)?$/.test(text)) return 0;
  const serial = Number(text);
  return serial > 20_000 && serial < 80_000 ? serial : 0;
}

function datePartsFromExcelSerial(serial) {
  const wholeDays = Math.floor(Number(serial));
  if (!Number.isFinite(wholeDays)) return null;
  const date = new Date(Date.UTC(1899, 11, 30 + wholeDays));
  return validDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
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

  match = text.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (match) return validDate(expandYear(match[3]), Number(match[2]), Number(match[1]));

  return null;
}

function monthFromText(value) {
  const index = monthNames.findIndex((month) => normalizeValue(value).toLowerCase().startsWith(month));
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

function datePartsToIso(parts) {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function formatAttendanceDateParts(parts) {
  return `${parts.day}-${monthNames[parts.month - 1]}-${String(parts.year).slice(-2)}`;
}

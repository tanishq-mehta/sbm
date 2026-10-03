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
  const text = normalizeDateText(value);
  if (!text) return null;

  const relative = relativeDateParts(text);
  if (relative) return relative;

  return (
    parseCompactNumericDate(text) ||
    parseTextMonthDate(text) ||
    parseDelimitedNumericDate(text) ||
    parseNativeDate(text)
  );
}

function normalizeDateText(value) {
  return normalizeValue(value)
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1")
    .replace(/\bat\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function relativeDateParts(value) {
  const text = value.toLowerCase();
  const today = new Date();
  if (text === "today") return datePartsFromDate(today);
  if (text === "yesterday") return datePartsFromDate(addDays(today, -1));
  if (text === "tomorrow") return datePartsFromDate(addDays(today, 1));
  return null;
}

function addDays(value, days) {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function parseCompactNumericDate(value) {
  const compact = value.replace(/\D/g, "");
  if (!/^\d{6}$|^\d{8}$/.test(compact)) return null;

  const candidates = [];
  if (compact.length === 8) {
    candidates.push(
      [Number(compact.slice(0, 4)), Number(compact.slice(4, 6)), Number(compact.slice(6, 8))],
      [Number(compact.slice(4, 8)), Number(compact.slice(2, 4)), Number(compact.slice(0, 2))],
      [Number(compact.slice(4, 8)), Number(compact.slice(0, 2)), Number(compact.slice(2, 4))]
    );
  } else {
    candidates.push(
      [expandYear(compact.slice(4, 6)), Number(compact.slice(2, 4)), Number(compact.slice(0, 2))],
      [expandYear(compact.slice(4, 6)), Number(compact.slice(0, 2)), Number(compact.slice(2, 4))]
    );
  }

  return firstValidDate(candidates);
}

function parseTextMonthDate(value) {
  const tokens = value
    .replace(/[,.]/g, " ")
    .replace(/[/-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token, index) => dateToken(token, index))
    .filter(Boolean);
  const monthToken = tokens.find((token) => token.type === "month");
  if (!monthToken) return null;

  const numbers = tokens.filter((token) => token.type === "number");
  const beforeMonth = numbers.filter((token) => token.index < monthToken.index);
  const afterMonth = numbers.filter((token) => token.index > monthToken.index);
  const yearCandidates = numbers.filter((token) => token.text.length >= 2 || token.value > 31);
  const dayCandidates = numbers.filter((token) => token.value >= 1 && token.value <= 31);
  const candidates = [];

  if (beforeMonth.length && afterMonth.length) {
    const before = beforeMonth[beforeMonth.length - 1];
    const after = afterMonth[0];
    if (before.text.length === 4 || before.value > 31) {
      candidates.push([expandYear(before.text), monthToken.value, after.value]);
    } else {
      candidates.push([expandYear(after.text), monthToken.value, before.value]);
    }
  } else if (afterMonth.length >= 2) {
    candidates.push([expandYear(afterMonth[1].text), monthToken.value, afterMonth[0].value]);
  } else if (beforeMonth.length >= 2) {
    candidates.push(
      [expandYear(beforeMonth[0].text), monthToken.value, beforeMonth[1].value],
      [expandYear(beforeMonth[1].text), monthToken.value, beforeMonth[0].value]
    );
  }

  for (const year of yearCandidates) {
    for (const day of dayCandidates) {
      if (day === year) continue;
      candidates.push([expandYear(year.text), monthToken.value, day.value]);
    }
  }

  if (!candidates.length && dayCandidates.length === 1) {
    candidates.push([new Date().getFullYear(), monthToken.value, dayCandidates[0].value]);
  }

  return firstValidDate(candidates);
}

function dateToken(value, index) {
  const text = value.toLowerCase();
  const month = monthFromText(text);
  if (month) return { type: "month", value: month, text, index };
  if (/^\d{1,4}$/.test(text)) return { type: "number", value: Number(text), text, index };
  return null;
}

function parseDelimitedNumericDate(value) {
  const match = value.match(/^\D*(\d{1,4})\D+(\d{1,2})(?:\D+(\d{1,4}))?(?:\D.*)?$/);
  if (!match) return null;

  const first = numberPart(match[1]);
  const second = numberPart(match[2]);
  const third = match[3] ? numberPart(match[3]) : null;
  const currentYear = new Date().getFullYear();
  const candidates = [];

  if (third) {
    if (first.text.length === 4) {
      candidates.push([first.value, second.value, third.value]);
    } else {
      const year = expandYear(third.text);
      const dayFirst = first.value > 12 || second.value <= 12;
      if (dayFirst) candidates.push([year, second.value, first.value], [year, first.value, second.value]);
      else candidates.push([year, first.value, second.value], [year, second.value, first.value]);
    }
  } else {
    const dayFirst = first.value > 12 || second.value <= 12;
    if (dayFirst) candidates.push([currentYear, second.value, first.value], [currentYear, first.value, second.value]);
    else candidates.push([currentYear, first.value, second.value], [currentYear, second.value, first.value]);
  }

  return firstValidDate(candidates);
}

function numberPart(text) {
  return {
    text,
    value: Number(text),
  };
}

function parseNativeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return validDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function monthFromText(value) {
  const normalized = normalizeValue(value).toLowerCase().replace(/\.$/, "");
  const index = monthNames.findIndex((month) => normalized.startsWith(month));
  return index === -1 ? 0 : index + 1;
}

function expandYear(value) {
  const text = String(value);
  const year = Number(text);
  if (text.length === 4) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

function firstValidDate(candidates) {
  for (const [year, month, day] of candidates) {
    const parsed = validDate(year, month, day);
    if (parsed) return parsed;
  }
  return null;
}

function datePartsFromDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
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

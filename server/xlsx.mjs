import zlib from "node:zlib";

const encoder = new TextEncoder();
const crcTable = createCrcTable();

export function createWorkbookBuffer({ sheetName = "People", headers, rows }) {
  const files = [
    {
      name: "[Content_Types].xml",
      content: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    },
    {
      name: "_rels/.rels",
      content: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      content: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    },
    {
      name: "xl/styles.xml",
      content: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="0000"/><numFmt numFmtId="165" formatCode="000000000000"/></numFmts>
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>`),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: xmlBuffer(createSheetXml(headers, rows)),
    },
  ];

  return zipStore(files);
}

export function readWorkbookSheets(buffer) {
  const files = readZipEntries(Buffer.from(buffer));
  const sharedStrings = parseSharedStrings(xmlText(files.get("xl/sharedStrings.xml")));
  const workbookXml = xmlText(files.get("xl/workbook.xml"));
  const relationshipXml = xmlText(files.get("xl/_rels/workbook.xml.rels"));
  const workbookSheets = parseWorkbookSheets(workbookXml, relationshipXml);
  const sheets = workbookSheets.length ? workbookSheets : worksheetSheets(files);

  return sheets
    .map((sheet) => {
      const sheetXml = xmlText(files.get(sheet.path));
      if (!sheetXml) return null;
      return {
        name: sheet.name,
        rows: parseSheetRows(sheetXml, sharedStrings),
      };
    })
    .filter(Boolean);
}

function createSheetXml(headers, rows) {
  const allRows = [headers, ...rows];
  const rowXml = allRows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex + 1)}${rowNumber}`;
      const style = rowNumber === 1 ? ' s="1"' : "";
      return cellXml(ref, value, style);
    }).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");

  const dimensions = `A1:${columnName(headers.length)}${allRows.length}`;
  const colXml = headers.map((header, index) => {
    const width = Math.max(10, Math.min(36, String(header).length + 4));
    const column = index + 1;
    return `<col min="${column}" max="${column}" width="${width}" customWidth="1"/>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimensions}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${colXml}</cols>
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function cellXml(ref, rawValue, style = "") {
  const { value, numberFormat } = cellValue(rawValue);
  const formatStyle = styleForNumberFormat(numberFormat);
  const cellStyle = formatStyle ? ` s="${formatStyle}"` : style;

  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${cellStyle}><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${cellStyle}><is><t xml:space="preserve">${escapeXml(value ?? "")}</t></is></c>`;
}

function cellValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return value;
  }
  return { value };
}

function styleForNumberFormat(numberFormat) {
  if (numberFormat === "0000") return 2;
  if (numberFormat === "000000000000") return 3;
  return 0;
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const content = Buffer.from(file.content);
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + content.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function xmlBuffer(value) {
  return Buffer.from(encoder.encode(value));
}

function readZipEntries(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const files = new Map();
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid XLSX central directory.");
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString(flags & 0x0800 ? "utf8" : "utf8");

    if (flags & 0x0001) {
      throw new Error("Encrypted XLSX files are not supported.");
    }
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("Zip64 XLSX files are not supported.");
    }

    files.set(name, readZipEntryContent(buffer, {
      compressionMethod,
      compressedSize,
      localOffset,
    }));
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return files;
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Invalid XLSX file.");
}

function readZipEntryContent(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error("Invalid XLSX local file header.");
  }

  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed);
  throw new Error("Unsupported XLSX compression method.");
}

function xmlText(value) {
  return value ? Buffer.from(value).toString("utf8") : "";
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    textNodes(match[1])
  );
}

function parseWorkbookSheets(workbookXml, relationshipXml) {
  if (!workbookXml) return [];
  const relationships = parseRelationships(relationshipXml);
  const sheets = [];

  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = parseAttributes(match[1]);
    const relationshipId = attrs["r:id"];
    const target = relationships.get(relationshipId);
    if (!target) continue;
    sheets.push({
      name: attrs.name || `Sheet ${sheets.length + 1}`,
      path: workbookRelationshipTargetPath(target),
    });
  }

  return sheets;
}

function parseRelationships(xml) {
  const relationships = new Map();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.Id && attrs.Target) relationships.set(attrs.Id, attrs.Target);
  }
  return relationships;
}

function workbookRelationshipTargetPath(target) {
  const cleanTarget = String(target || "").replace(/^\/+/, "");
  return cleanTarget.startsWith("xl/")
    ? cleanTarget
    : `xl/${cleanTarget}`;
}

function worksheetSheets(files) {
  return [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .map((path, index) => ({
      name: `Sheet ${index + 1}`,
      path,
    }));
}

function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttrs = parseAttributes(rowMatch[1]);
    const rowNumber = Number(rowAttrs.r || rows.length + 1);
    const values = [];
    let implicitColumn = 0;

    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = parseAttributes(cellMatch[1]);
      const columnIndex = attrs.r ? columnIndexFromRef(attrs.r) : implicitColumn;
      values[columnIndex] = parseCellValue(attrs, cellMatch[2], sharedStrings);
      implicitColumn = columnIndex + 1;
    }

    rows.push({
      rowNumber: Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber : rows.length + 1,
      values,
    });
  }
  return rows;
}

function parseCellValue(attrs, cellXml, sharedStrings) {
  const type = attrs.t || "";
  if (type === "inlineStr") return textNodes(cellXml);

  const valueMatch = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  const value = valueMatch ? decodeXml(valueMatch[1]) : "";

  if (type === "s") return sharedStrings[Number(value)] || "";
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return value;
}

function textNodes(xml) {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

function parseAttributes(value) {
  const attributes = {};
  for (const match of String(value || "").matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXml(match[2]);
  }
  return attributes;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function columnName(index) {
  let name = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function columnIndexFromRef(ref) {
  const match = String(ref || "").match(/^([A-Z]+)/i);
  if (!match) return 0;
  return match[1]
    .toUpperCase()
    .split("")
    .reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

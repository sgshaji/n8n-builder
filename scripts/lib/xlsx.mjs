// Minimal .xlsx writer and reader, plain Node.js, no packages.
//
// An .xlsx file is a zip of a few XML parts. The writer builds those parts and
// zips them with node:zlib (deflateRawSync) and a CRC32. The reader unzips and
// reads the first sheet back as rows of text, enough for the test runner to
// read the Dispatcher's worklist files.
//
// Cell values the writer accepts:
//   "text"                         a text cell
//   { excelDate: "2026-11-01" }    a real Excel date: a day number with a date format
//   { number: 46327 }              a plain number
//   { text: "01/11/2026" }         a text cell (same as a plain string)
//   null, undefined or ""          an empty cell (left out, as Excel does)
import * as zlib from "node:zlib";

// ---------------------------------------------------------------------------
// CRC32: node:zlib has crc32 from Node 20.15 / 22.2. Fall back to a table.
// ---------------------------------------------------------------------------

let crcTable;
function crc32Fallback(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(buf) {
  return typeof zlib.crc32 === "function" ? zlib.crc32(buf) >>> 0 : crc32Fallback(buf);
}
export { crc32Fallback };

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

// A fixed timestamp keeps the output byte-for-byte the same on every run,
// so regenerating the spreadsheets does not create Git changes.
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 19; // 2026-11-19

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file: end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const packed = buf.subarray(start, start + csize);
    files.set(name, method === 8 ? zlib.inflateRawSync(packed) : Buffer.from(packed));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Cells and dates
// ---------------------------------------------------------------------------

const EXCEL_EPOCH = Date.UTC(1899, 11, 30); // day 0 in Excel's 1900 date system

export function isoToExcelSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Not a yyyy-MM-dd date: ${iso}`);
  return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - EXCEL_EPOCH) / 86_400_000;
}

export function excelSerialToIso(serial) {
  return new Date(EXCEL_EPOCH + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}

export function columnLetter(index) {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function cellKind(value) {
  if (value === null || value === undefined || value === "") return { kind: "empty" };
  if (typeof value === "string") return { kind: "text", text: value };
  if (typeof value === "number") return { kind: "number", number: value };
  if (typeof value === "object") {
    if ("excelDate" in value) return { kind: "date", number: isoToExcelSerial(value.excelDate) };
    if ("number" in value) return { kind: "number", number: value.number };
    if ("text" in value) return value.text === "" ? { kind: "empty" } : { kind: "text", text: value.text };
  }
  throw new Error(`Unsupported cell value: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Workbook writer
// ---------------------------------------------------------------------------

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const STYLE_DEFAULT = 0;
const STYLE_DATE = 1;
const STYLE_HEADER = 2;

/**
 * Build an .xlsx file with one sheet.
 * @param {object} options
 * @param {string[]} options.header   header row (bold text)
 * @param {Array<Array<any>>} options.rows  data rows, one value per header column
 * @param {string} [options.sheetName]
 * @returns {Buffer}
 */
export function buildXlsx({ header = [], rows = [], sheetName = "Changes" }) {
  const strings = [];
  const stringIndex = new Map();
  const sst = (text) => {
    if (!stringIndex.has(text)) {
      stringIndex.set(text, strings.length);
      strings.push(text);
    }
    return stringIndex.get(text);
  };

  const width = Math.max(header.length, ...rows.map((r) => r.length), 1);
  const lines = [];
  const allRows = header.length ? [header.map((h) => ({ header: h })), ...rows] : rows;
  allRows.forEach((row, r) => {
    const cells = [];
    row.forEach((value, c) => {
      const ref = `${columnLetter(c)}${r + 1}`;
      if (value && typeof value === "object" && "header" in value) {
        cells.push(`<c r="${ref}" t="s" s="${STYLE_HEADER}"><v>${sst(value.header)}</v></c>`);
        return;
      }
      const cell = cellKind(value);
      if (cell.kind === "empty") return;
      if (cell.kind === "text") cells.push(`<c r="${ref}" t="s"><v>${sst(cell.text)}</v></c>`);
      if (cell.kind === "number") cells.push(`<c r="${ref}" s="${STYLE_DEFAULT}"><v>${cell.number}</v></c>`);
      if (cell.kind === "date") cells.push(`<c r="${ref}" s="${STYLE_DATE}"><v>${cell.number}</v></c>`);
    });
    lines.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  const lastRef = allRows.length ? `${columnLetter(width - 1)}${allRows.length}` : "A1";
  const dimension = allRows.length ? `A1:${lastRef}` : "A1";

  const sheetXml =
    XML_HEAD +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="${dimension}"/>` +
    `<sheetData>${lines.join("")}</sheetData></worksheet>`;

  const sstXml =
    XML_HEAD +
    `<sst xmlns="${NS_MAIN}" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("") +
    `</sst>`;

  const stylesXml =
    XML_HEAD +
    `<styleSheet xmlns="${NS_MAIN}">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="3">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const workbookXml =
    XML_HEAD +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><workbookPr/>` +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId3" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`;

  const rootRels =
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    XML_HEAD +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`;

  return zip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: stylesXml },
    { name: "xl/sharedStrings.xml", data: sstXml },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml },
  ]);
}

// ---------------------------------------------------------------------------
// Workbook reader (first sheet, values as text; enough for worklists)
// ---------------------------------------------------------------------------

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function textOf(xml) {
  // Concatenate every <t> in a shared string or inline string (rich text has several).
  return [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decodeXml(m[1])).join("");
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read the first sheet of an .xlsx file.
 * @returns {{ rows: string[][], sheetName: string }}  every cell as text ("" if empty)
 */
export function readXlsx(buf) {
  const files = unzip(buf);
  const get = (name) => files.get(name)?.toString("utf8");
  const workbook = get("xl/workbook.xml") ?? "";
  const rels = get("xl/_rels/workbook.xml.rels") ?? "";
  const firstSheet = /<(?:\w+:)?sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"/.exec(workbook);
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (firstSheet) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${firstSheet[2]}"[^>]*>`).exec(rels)?.[0] ?? "";
    const target = /Target="([^"]+)"/.exec(rel)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  }
  const shared = [...(get("xl/sharedStrings.xml") ?? "").matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]));
  const sheet = get(sheetPath);
  if (!sheet) throw new Error(`Sheet not found in workbook: ${sheetPath}`);

  const rows = [];
  for (const rowMatch of sheet.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const rAttr = /\br="(\d+)"/.exec(rowMatch[1]);
    const rowIndex = rAttr ? +rAttr[1] - 1 : rows.length;
    const row = [];
    let nextCol = 0;
    for (const cellMatch of rowMatch[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let value = "";
      if (type === "s") value = shared[+v] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else if (v !== undefined) value = decodeXml(v);
      row[col] = value;
    }
    rows[rowIndex] = Array.from(row, (x) => x ?? "");
  }
  return { rows: Array.from(rows, (r) => r ?? []), sheetName: firstSheet?.[1] ?? "" };
}

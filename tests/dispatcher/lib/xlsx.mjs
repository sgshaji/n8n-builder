// Minimal .xlsx writer and reader for the Dispatcher tests. Plain Node, no packages.
//
// writeXlsx(path, rows, options)
//   rows: array of rows; the first row is the header. A cell can be:
//     string                  -> text cell
//     number                  -> number cell (General format, so an Excel day number stays a number)
//     { date: "2026-11-01" }  -> a real Excel date (day number with a date format)
//     { dateTime: "2026-11-01T14:30:00" } -> a real Excel date with a time
//     null / undefined / ""   -> empty cell (left out of the sheet)
//   options.mtime: Date to set as the file's modified time (to make a file look "settled")
//
// readXlsx(path) -> array of rows (arrays of cell values) from the first sheet.

import { writeFileSync, readFileSync, utimesSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// ---------- zip (store only) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + csize);
    out[name] = method === 8 ? inflateRawSync(raw) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------- xlsx ----------

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&");

function colName(i) {
  let s = "";
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function serial(isoDate) {
  const [d, t] = isoDate.split("T");
  const [y, m, day] = d.split("-").map(Number);
  let v = (Date.UTC(y, m - 1, day) - Date.UTC(1899, 11, 30)) / 86400000;
  if (t) {
    const [hh, mm, ss] = t.split(":").map(Number);
    v += ((hh || 0) * 3600 + (mm || 0) * 60 + (ss || 0)) / 86400;
  }
  return v;
}

function cellXml(ref, v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
  if (typeof v === "object" && v.date) return `<c r="${ref}" s="1"><v>${serial(v.date)}</v></c>`;
  if (typeof v === "object" && v.dateTime) return `<c r="${ref}" s="2"><v>${serial(v.dateTime)}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

export function xlsxBuffer(rows) {
  const sheetRows = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cellXml(`${colName(c)}${r + 1}`, v)).join("")}</row>`)
    .join("");
  return zip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${sheetRows}</sheetData></worksheet>`,
    },
  ]);
}

export function writeXlsx(path, rows, options = {}) {
  writeFileSync(path, xlsxBuffer(rows));
  if (options.mtime) utimesSync(path, options.mtime, options.mtime);
}

export function readXlsx(path) {
  const files = unzip(readFileSync(path));
  const text = (name) => (files[name] ? files[name].toString("utf8") : "");
  const shared = [];
  for (const si of text("xl/sharedStrings.xml").match(/<si>[\s\S]*?<\/si>/g) || []) {
    shared.push(unesc((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  }
  const sheetName = Object.keys(files).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n)) || Object.keys(files).find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  const sheet = text(sheetName);
  const rows = [];
  for (const rowXml of sheet.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) || []) {
    const rowNum = Number((rowXml.match(/<row[^>]*\br="(\d+)"/) || [])[1] || rows.length + 1);
    const row = [];
    for (const c of rowXml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
      const ref = (c.match(/\br="([A-Z]+)\d+"/) || [])[1];
      const type = (c.match(/\bt="(\w+)"/) || [])[1];
      let value = null;
      const v = c.match(/<v>([\s\S]*?)<\/v>/);
      if (type === "inlineStr") value = unesc((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || "");
      else if (type === "s") value = shared[Number(v[1])];
      else if (type === "str" || type === "e") value = v ? unesc(v[1]) : "";
      else if (type === "b") value = v ? v[1] === "1" : null;
      else if (v) value = Number(v[1]);
      let idx = 0;
      for (const ch of ref) idx = idx * 26 + (ch.charCodeAt(0) - 64);
      row[idx - 1] = value;
    }
    rows[rowNum - 1] = row;
  }
  return rows.filter(Boolean);
}

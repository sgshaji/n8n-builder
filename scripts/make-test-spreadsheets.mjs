// Generates the HARSLL test spreadsheets from test-data/scenarios.json.
//
//   node scripts/make-test-spreadsheets.mjs           write test-data/spreadsheets/*.xlsx
//   node scripts/make-test-spreadsheets.mjs --check   exit 1 if the files are missing or out of date
//
// Plain Node.js, no packages: the .xlsx files are built by scripts/lib/xlsx.mjs.
// The output is the same byte for byte on every run, so regenerating does not
// create Git changes unless scenarios.json changed. Made-up data only.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./lib/env.mjs";
import { buildXlsx } from "./lib/xlsx.mjs";
import { fileLayouts, loadScenarios } from "./lib/scenario-kit.mjs";

export const spreadsheetsDir = join(repoRoot, "test-data", "spreadsheets");

/** An Excel "owner" file (~$name.xlsx), written while a workbook is open. Made-up user name. */
function excelOwnerFile() {
  const name = "Test User";
  const buf = Buffer.alloc(165, 0x20);
  buf[0] = name.length;
  buf.write(name, 1, "latin1");
  buf.writeUInt16LE(name.length, 54);
  const wide = Buffer.from(name, "utf16le");
  wide.copy(buf, 56);
  for (let i = 56 + wide.length; i + 1 < buf.length; i += 2) buf.writeUInt16LE(0x0020, i);
  return buf;
}

/** Every test file, built in memory. @returns Map name -> Buffer */
export function buildAllFiles(data = loadScenarios(repoRoot)) {
  const layouts = fileLayouts(data);
  const files = new Map();
  for (const file of data.files) {
    const layout = layouts.get(file.name);
    if (file.kind === "excelOwnerFile") {
      files.set(file.name, excelOwnerFile());
      continue;
    }
    const header = data.columns.filter((c) => !(file.omitColumns ?? []).includes(c));
    const rows = layout.rows.map((r) => header.map((c) => r.cells[c] ?? ""));
    const xlsx = buildXlsx({ header, rows, sheetName: "Changes" });
    if (file.kind === "rows") files.set(file.name, xlsx);
    else if (file.kind === "truncated") files.set(file.name, xlsx.subarray(0, Math.floor(xlsx.length * 0.6)));
    else throw new Error(`Unknown file kind ${file.kind} for ${file.name}`);
  }
  return files;
}

/** Names of files that are missing or differ from what scenarios.json produces. */
export function staleFiles(files = buildAllFiles()) {
  const stale = [];
  for (const [name, buf] of files) {
    const path = join(spreadsheetsDir, name);
    if (!existsSync(path) || !readFileSync(path).equals(buf)) stale.push(name);
  }
  return stale;
}

function main() {
  const check = process.argv.includes("--check");
  const files = buildAllFiles();
  if (check) {
    const stale = staleFiles(files);
    if (stale.length) {
      console.error(`Out of date: ${stale.join(", ")}. Run: node scripts/make-test-spreadsheets.mjs`);
      process.exit(1);
    }
    console.log(`All ${files.size} test spreadsheets are up to date.`);
    return;
  }
  mkdirSync(spreadsheetsDir, { recursive: true });
  for (const old of readdirSync(spreadsheetsDir)) {
    if (old.endsWith(".xlsx") && !files.has(old)) rmSync(join(spreadsheetsDir, old));
  }
  for (const [name, buf] of files) writeFileSync(join(spreadsheetsDir, name), buf);
  console.log(`Wrote ${files.size} files to test-data/spreadsheets/:`);
  for (const [name, buf] of files) console.log(`  ${name.padEnd(26)} ${String(buf.length).padStart(6)} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

// Shared logic for the HARSLL test kit: keys, the expected Dispatcher fields
// for a spreadsheet row, expected cases from test-data/scenarios.json, and the
// comparators that turn "expected" and "actual" into a list of differences.
//
// Used by scripts/make-test-spreadsheets.mjs, scripts/run-tests.mjs and
// scripts/run-tests.test.mjs. Plain Node.js, no packages.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { excelSerialToIso, isoToExcelSerial } from "./xlsx.mjs";

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function loadScenarios(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, "test-data", "scenarios.json"), "utf8"));
}

export function loadAccounts(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, "test-data", "rbis-accounts.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Text and dates (docs/design/interfaces.md, Shared conventions)
// ---------------------------------------------------------------------------

/** lower-case, every run of characters other than a-z0-9 replaced by one space, trimmed. */
export function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isRealIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** A scenario cell (string, {text}, {excelDate}, {number}, empty) as trimmed text. */
export function tidyText(cell) {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number") return String(cell);
  if ("text" in cell) return String(cell.text).trim();
  if ("number" in cell) return String(cell.number);
  if ("excelDate" in cell) return cell.excelDate;
  return "";
}

/**
 * What the Dispatcher's "Tidy rows" step should store for a date cell
 * (design: accept real Excel dates, Excel day numbers and dd/MM/yyyy text;
 * store yyyy-MM-dd; keep the original text if it is not a real date).
 */
export function tidyDate(cell) {
  if (cell === null || cell === undefined || cell === "") return "";
  if (typeof cell === "object" && "excelDate" in cell) return cell.excelDate;
  if (typeof cell === "number") return excelSerialToIso(cell);
  if (typeof cell === "object" && "number" in cell) return excelSerialToIso(cell.number);
  const text = tidyText(cell);
  return tidyDateText(text);
}

/** dd/MM/yyyy (or d/M/yyyy) to yyyy-MM-dd if it is a real date; otherwise the text unchanged. */
export function tidyDateText(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return isRealIsoDate(iso) ? iso : text;
  }
  return text;
}

/**
 * Reference for how a value that n8n's Extract from File returns should be tidied
 * (phase-4 trials, trial 2): date-time text, an Excel day number, or dd/MM/yyyy text.
 */
export function tidyExtractedDate(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return excelSerialToIso(value);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(text)) {
    // Round to the nearest second: a date with a time can arrive a millisecond early.
    return new Date(Math.round(Date.parse(text) / 1000) * 1000).toISOString().slice(0, 10);
  }
  return tidyDateText(text);
}

export { excelSerialToIso, isoToExcelSerial };

// ---------------------------------------------------------------------------
// Keys (interfaces.md, Keys)
// ---------------------------------------------------------------------------

export function relevantDateOf(changeReason, startDate, endDate) {
  return changeReason === "TENANCY_START" ? startDate : endDate;
}

export function caseKey({ changeReason, accountRef, address, tenantName, relevantDate }) {
  return [changeReason, accountRef, normalise(address), normalise(tenantName), relevantDate].join("|");
}

export function tenancyKey({ changeReason, accountRef, address, relevantDate }) {
  return [changeReason, accountRef, normalise(address), relevantDate].join("|");
}

/** The Dispatcher fields expected for one spreadsheet row (interfaces.md, Cases table columns). */
export function intakeFields(cells, rowNumber) {
  const changeReason = tidyText(cells.ChangeReason).toUpperCase();
  const accountRef = tidyText(cells.AccountRef).toUpperCase();
  const address = tidyText(cells.Address);
  const postcode = tidyText(cells.Postcode);
  const tenantName = tidyText(cells.TenantName);
  const startDate = tidyDate(cells.StartDate);
  const endDate = tidyDate(cells.EndDate);
  const relevantDate = relevantDateOf(changeReason, startDate, endDate);
  const fields = {
    rowNumber,
    changeReason,
    accountRef,
    address,
    postcode,
    isFlat: /^flat/i.test(address),
    tenantName,
    startDate,
    endDate,
    relevantDate,
    forwardingAddress: tidyText(cells.ForwardingAddress),
    contactEmail: tidyText(cells.ContactEmail),
    contactPhone: tidyText(cells.ContactPhone),
    sourceSystem: tidyText(cells.SourceSystem),
  };
  fields.caseKey = caseKey(fields);
  fields.tenancyKey = tenancyKey(fields);
  return fields;
}

// ---------------------------------------------------------------------------
// Files and expected cases
// ---------------------------------------------------------------------------

/** Rows of every file, in file order, with row numbers (header = row 1). */
export function fileLayouts(data) {
  const layouts = new Map(data.files.map((f) => [f.name, { ...f, rows: [], endRows: [] }]));
  for (const scenario of data.scenarios) {
    for (const row of scenario.rows ?? []) {
      for (const fileName of [row.file, ...(row.alsoIn ?? [])]) {
        const layout = layouts.get(fileName);
        if (!layout) throw new Error(`Scenario ${scenario.id} row ${row.id}: unknown file ${fileName}`);
        (row.position === "end" ? layout.endRows : layout.rows).push({ scenarioId: scenario.id, rowId: row.id, cells: row.cells });
      }
    }
  }
  for (const layout of layouts.values()) {
    layout.rows = [...layout.rows, ...layout.endRows].map((r, i) => ({ ...r, rowNumber: i + 2, fields: intakeFields(r.cells, i + 2) }));
    delete layout.endRows;
  }
  return layouts;
}

export const scenarioRowRef = (scenarioId, rowId) => `${scenarioId}.${rowId}`;

/**
 * Every expected case: one per scenario row that should become a case.
 * `final` holds the final expectations; `checkpoints` the in-between ones.
 */
export function expectedCases(data) {
  const layouts = fileLayouts(data);
  const out = [];
  for (const scenario of data.scenarios) {
    const byRowId = new Map((scenario.rows ?? []).map((r) => [r.id, r]));
    for (const row of scenario.rows ?? []) {
      const finalFile = row.expect?.batch?.file ?? row.file;
      const layoutRow = layouts.get(finalFile).rows.find((r) => r.scenarioId === scenario.id && r.rowId === row.id);
      const fields = layoutRow.fields;
      let coveredByCaseKey = "";
      if (row.expect?.coveredBy) {
        const lead = byRowId.get(row.expect.coveredBy);
        if (!lead) throw new Error(`Scenario ${scenario.id} row ${row.id}: coveredBy ${row.expect.coveredBy} not found`);
        const leadLayout = layouts.get(lead.file).rows.find((r) => r.scenarioId === scenario.id && r.rowId === lead.id);
        coveredByCaseKey = leadLayout.fields.caseKey;
      }
      out.push({
        scenarioId: scenario.id,
        rowId: row.id,
        ref: scenarioRowRef(scenario.id, row.id),
        file: row.file,
        files: [row.file, ...(row.alsoIn ?? [])],
        fields,
        coveredByCaseKey,
        noCase: row.expect?.noCase === true,
        final: row.expect ?? {},
        checkpoints: row.checkpoints ?? {},
      });
    }
  }
  return out;
}

export function groupOf(data, scenarioId) {
  return data.groups.find((g) => g.scenarios.includes(scenarioId));
}

export function isFinal(row, maxAttempts = 3) {
  if (!row) return false;
  if (["updated", "referred", "duplicate"].includes(row.status)) return true;
  return row.status === "failed" && Number(row.attempts) >= maxAttempts;
}

export function expectedIsFinal(expect, maxAttempts = 3) {
  return isFinal({ status: expect.status, attempts: expect.attempts ?? maxAttempts }, maxAttempts);
}

// ---------------------------------------------------------------------------
// Value comparison
// ---------------------------------------------------------------------------

const isBlank = (v) => v === null || v === undefined || v === "";

function parseJsonField(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { $unparseable: value };
  }
}

export function show(value) {
  if (value === undefined) return "(missing)";
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

/** Loose equality: "" == null == undefined; booleans: null == false; numbers as numbers. */
export function sameValue(expected, actual) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (expected.$nonEmpty) return !isBlank(actual) && !(Array.isArray(actual) && actual.length === 0);
    if (expected.$any) return true;
  }
  if (isBlank(expected)) return isBlank(actual);
  if (typeof expected === "boolean") return expected === (actual === true || actual === "true");
  if (typeof expected === "number") return actual !== null && actual !== "" && Number(actual) === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => sameValue(e, actual[i]));
  }
  if (typeof expected === "object") {
    return actual && typeof actual === "object" && Object.keys(expected).every((k) => sameValue(expected[k], actual[k]));
  }
  return String(expected) === String(actual ?? "");
}

// ---------------------------------------------------------------------------
// Case comparison
// ---------------------------------------------------------------------------

const INTAKE_FIELDS = [
  "rowNumber", "changeReason", "accountRef", "address", "postcode", "isFlat", "tenantName",
  "startDate", "endDate", "relevantDate", "tenancyKey", "forwardingAddress", "contactEmail",
  "contactPhone", "sourceSystem",
];

/**
 * Compare one expected case with its row in the Cases table.
 * @param exp     an item from expectedCases()
 * @param expect  the expectation to apply (exp.final or a checkpoint)
 * @param actual  the table row, or undefined
 * @param ctx     { batchOf(file, drop) -> batchId | undefined, reasonTexts, checkIntake }
 * @returns string[] differences
 */
export function compareCase(exp, expect, actual, ctx) {
  const diffs = [];
  const label = `case ${exp.rowId}`;
  if (expect.noCase) {
    if (actual) diffs.push(`${label}: should not exist, but the Cases table has it (status ${show(actual.status)})`);
    return diffs;
  }
  if (!actual) return [`${label}: missing from the Cases table (caseKey ${exp.fields.caseKey})`];
  const d = (field, expected, got) => diffs.push(`${label}: ${field}: expected ${show(expected)}, got ${show(got)}`);

  if (ctx.checkIntake !== false && expect === exp.final) {
    for (const f of INTAKE_FIELDS) if (!sameValue(exp.fields[f], actual[f])) d(f, exp.fields[f], actual[f]);
    if (!sameValue(exp.coveredByCaseKey, actual.coveredByCaseKey)) d("coveredByCaseKey", exp.coveredByCaseKey, actual.coveredByCaseKey);
  }

  for (const f of ["status", "reasonCode", "outcome", "urgent", "isLeadRow", "attempts", "submissions", "errorDetail"]) {
    if (f in expect && !sameValue(expect[f], actual[f])) d(f, expect[f], actual[f]);
  }
  if (expect === exp.final && !("submissions" in expect) && !sameValue(1, actual.submissions)) d("submissions", 1, actual.submissions);

  if ("reasonCode" in expect && ctx.reasonTexts) {
    const text = expect.reasonCode ? ctx.reasonTexts[expect.reasonCode] : "";
    if (!sameValue(text, actual.reasonText)) d("reasonText", text, actual.reasonText);
  }
  if ("stepsDone" in expect) {
    const got = parseJsonField(actual.stepsDone) ?? [];
    if (!sameValue(expect.stepsDone, got)) d("stepsDone", expect.stepsDone, got);
  }
  if ("jointTenants" in expect) {
    const got = parseJsonField(actual.jointTenants) ?? [];
    const norm = (list) => (Array.isArray(list) ? list.map((p) => ({ name: p?.name ?? "", email: p?.email ?? "", phone: p?.phone ?? "" })) : list);
    if (!sameValue(norm(expect.jointTenants), norm(got))) d("jointTenants", expect.jointTenants, got);
  }
  if ("batch" in expect || expect === exp.final) {
    const want = expect.batch ?? { file: exp.file };
    const batchId = ctx.batchOf(want.file, want.drop ?? 1);
    if (!batchId) diffs.push(`${label}: batchId: no batch row found for file ${show(want.file)}${want.drop ? ` (drop ${want.drop})` : ""}`);
    else if (!sameValue(batchId, actual.batchId)) d("batchId", batchId, actual.batchId);
  }
  if ("previousResult" in expect) {
    const got = parseJsonField(actual.previousResult);
    const want = { status: expect.previousResult.status, reasonCode: expect.previousResult.reasonCode };
    if (expect.previousResult.batch) want.batchId = ctx.batchOf(expect.previousResult.batch.file, expect.previousResult.batch.drop ?? 1) ?? "(no batch row)";
    if (!sameValue(want, got)) d("previousResult", want, got);
  }
  return diffs;
}

/**
 * Compare a set of expected cases with the Cases table.
 * @returns Map scenarioId -> string[]
 */
export function compareCases(expected, tableRows, ctx, { checkpoint } = {}) {
  const byKey = new Map();
  for (const row of tableRows) {
    if (!byKey.has(row.caseKey)) byKey.set(row.caseKey, []);
    byKey.get(row.caseKey).push(row);
  }
  const result = new Map();
  for (const exp of expected) {
    const expect = checkpoint ? exp.checkpoints[checkpoint] : exp.final;
    if (!expect) continue;
    const rows = byKey.get(exp.fields.caseKey) ?? [];
    const diffs = [];
    if (rows.length > 1) diffs.push(`case ${exp.rowId}: ${rows.length} rows in the Cases table with caseKey ${exp.fields.caseKey}; expected one`);
    diffs.push(...compareCase(exp, expect, rows[0], ctx));
    if (!result.has(exp.scenarioId)) result.set(exp.scenarioId, []);
    result.get(exp.scenarioId).push(...diffs);
  }
  return result;
}

/** Table rows whose caseKey no expected case accounts for. */
export function unexpectedCases(expected, tableRows) {
  const keys = new Set(expected.map((e) => e.fields.caseKey));
  return tableRows.filter((r) => !keys.has(r.caseKey));
}

// ---------------------------------------------------------------------------
// Pretend RBIS change log comparison
// ---------------------------------------------------------------------------

function describeChange(c) {
  const { seq, at, ref, operation, ...rest } = c;
  return `${operation} ${JSON.stringify(rest)}`;
}

function normaliseChangeValue(key, value) {
  if (key === "tenants" && Array.isArray(value)) return value.map((t) => (t && typeof t === "object" ? t.name ?? JSON.stringify(t) : t));
  return value;
}

/**
 * @param expectedByRef  { ref: [ {operation, ...fields} ] }
 * @param changes        the pretend RBIS's GET /changes
 * @returns string[] differences
 */
export function compareRbisChanges(expectedByRef, changes) {
  const diffs = [];
  for (const [ref, expectedList] of Object.entries(expectedByRef ?? {})) {
    const actual = changes.filter((c) => c.ref === ref).sort((a, b) => a.seq - b.seq);
    const n = Math.max(expectedList.length, actual.length);
    for (let i = 0; i < n; i++) {
      const want = expectedList[i];
      const got = actual[i];
      if (!got) {
        diffs.push(`RBIS ${ref}: change ${i + 1} missing: expected ${describeChange(want)}`);
        continue;
      }
      if (!want) {
        diffs.push(`RBIS ${ref}: change ${i + 1} not expected: ${describeChange(got)}`);
        continue;
      }
      for (const [key, value] of Object.entries(want)) {
        const actualValue = normaliseChangeValue(key, got[key]);
        if (!sameValue(value, actualValue)) {
          diffs.push(`RBIS ${ref}: change ${i + 1} (${want.operation}): ${key}: expected ${show(value)}, got ${show(actualValue)}`);
        }
      }
    }
    if (actual.length !== expectedList.length) {
      diffs.push(`RBIS ${ref}: expected ${expectedList.length} change(s), got ${actual.length}`);
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Batches, folders and emails
// ---------------------------------------------------------------------------

/** Batch rows for a file name, oldest first. */
export function batchesFor(batches, fileName) {
  return batches.filter((b) => b.fileName === fileName).sort((a, b) => a.id - b.id);
}

export function makeBatchOf(batches) {
  return (fileName, drop = 1) => batchesFor(batches, fileName)[drop - 1]?.batchId;
}

/** Is a file in a folder, under its own name or with a prefix (e.g. a batch time stamp)? */
export function folderHas(names, fileName, { exact = false } = {}) {
  return names.some((n) => n === fileName || (!exact && n.endsWith(`_${fileName}`)) || (!exact && n.endsWith(fileName) && n.length > fileName.length));
}

/** Emails that mention a file name in the subject or body. */
export function emailsAbout(emails, fileName) {
  return emails.filter((m) => (m.subject ?? "").includes(fileName) || (m.text ?? "").includes(fileName));
}

const SUMMARY_SUBJECT = /\b\d+\s+cases?\b/i;
export const isSummaryEmail = (m) => SUMMARY_SUBJECT.test(m.subject ?? "");

/**
 * Compare one file's expectations: where it ends up, its batch rows and emails.
 * @param check   a fileChecks entry (or one of its checkpoints, with file added)
 * @param state   { folders: {input, archive, rejected, reports}, batches, emails | null }
 */
export function compareFileCheck(check, state) {
  const diffs = [];
  const f = check.file;
  const label = `file ${show(f)}`;
  if (check.endsIn) {
    const inInput = state.folders.input.includes(f);
    if (check.endsIn === "input") {
      if (!inInput) diffs.push(`${label}: expected to stay in the input folder, but it is not there`);
    } else {
      if (inInput) diffs.push(`${label}: expected in ${check.endsIn}, but it is still in the input folder`);
      if (!folderHas(state.folders[check.endsIn], f)) diffs.push(`${label}: not found in the ${check.endsIn} folder (${state.folders[check.endsIn].length} file(s) there)`);
      const other = check.endsIn === "archive" ? "rejected" : "archive";
      if (folderHas(state.folders[other], f, { exact: true })) diffs.push(`${label}: unexpectedly found in the ${other} folder`);
    }
  }
  const rows = batchesFor(state.batches, f);
  if ("batchCount" in check && rows.length !== check.batchCount) {
    diffs.push(`${label}: expected ${check.batchCount} batch row(s), got ${rows.length}`);
  }
  if (check.batch) {
    const row = check.batch.drop ? rows[check.batch.drop - 1] : rows.at(-1);
    if (!row) diffs.push(`${label}: no batch row${check.batch.drop ? ` for drop ${check.batch.drop}` : ""}`);
    else {
      for (const k of ["status", "rowCount", "readAttempts"]) {
        if (k in check.batch && !sameValue(check.batch[k], row[k])) diffs.push(`${label}: batch ${k}: expected ${show(check.batch[k])}, got ${show(row[k])}`);
      }
    }
  }
  if ("emailsAbout" in check) {
    if (!state.emails) diffs.push(`SKIP ${label}: email count not checked in this profile`);
    else {
      const n = emailsAbout(state.emails, f).length;
      if (n !== check.emailsAbout) diffs.push(`${label}: expected ${check.emailsAbout} email(s) mentioning it, got ${n}`);
    }
  }
  return diffs;
}

/** Counts a summary email should show, from the expected cases of one batch. */
export function expectedSummaryCounts(cases, maxAttempts = 3) {
  const c = { cases: cases.length, updated: 0, referred: 0, failed: 0, duplicate: 0, urgent: 0 };
  for (const e of cases) {
    if (e.final.status in c) c[e.final.status] += 1;
    if (e.final.urgent) c.urgent += 1;
  }
  return c;
}

export function parseSummaryCounts(subject, text) {
  const pick = (re) => {
    const m = re.exec(subject ?? "") ?? re.exec(text ?? "");
    return m ? Number(m[1]) : undefined;
  };
  return {
    cases: pick(/(\d+)\s+cases?\b/i),
    updated: pick(/(\d+)\s+updated\b/i),
    referred: pick(/(\d+)\s+referred\b/i),
    failed: pick(/(\d+)\s+failed\b/i),
    duplicate: pick(/(\d+)\s+duplicates?\b/i),
    urgent: (() => {
      const m = /URGENT[^\n]*?(\d+)\s*$/im.exec(text ?? "");
      return m ? Number(m[1]) : undefined;
    })(),
  };
}

/**
 * Check the summary email of one batch: one email, the right counts, no personal data.
 * @param cases  expected cases whose final batch is this one
 */
export function compareSummary(fileName, cases, emails) {
  if (!emails) return [`SKIP summary for ${show(fileName)}: emails not checked in this profile`];
  const diffs = [];
  const found = emailsAbout(emails, fileName).filter(isSummaryEmail);
  if (found.length !== 1) {
    diffs.push(`summary for ${show(fileName)}: expected 1 summary email, got ${found.length}`);
    if (found.length === 0) return diffs;
  }
  const mail = found.at(-1);
  const want = expectedSummaryCounts(cases);
  const got = parseSummaryCounts(mail.subject, mail.text);
  for (const k of ["cases", "updated", "referred", "failed", "duplicate", "urgent"]) {
    const g = got[k];
    if (g === undefined && want[k] === 0) continue;
    if (g !== want[k]) diffs.push(`summary for ${show(fileName)}: ${k}: expected ${want[k]}, got ${g === undefined ? "(not shown)" : g}`);
  }
  const body = `${mail.subject}\n${mail.text}`.toLowerCase();
  for (const e of cases) {
    for (const value of [e.fields.tenantName, e.fields.address]) {
      if (value && body.includes(value.toLowerCase())) diffs.push(`summary for ${show(fileName)}: contains personal data ${show(value)}; it should hold counts only`);
    }
  }
  return diffs;
}

/** Expected worklist members of a batch, urgent first (design: Staff worklist). */
export function expectedWorklist(cases, maxAttempts = 3) {
  const members = cases.filter((e) => {
    const x = e.final;
    return x.status === "referred" || (x.status === "updated" && x.reasonCode) || (x.status === "failed" && (x.attempts ?? maxAttempts) >= maxAttempts);
  });
  return members;
}

/**
 * Check a worklist file's rows against the expected members.
 * Rows are matched to cases by tenant name (unique within a test file) and account reference.
 * @param rows  worklist rows as text, header first
 */
export function compareWorklist(fileName, rows, cases) {
  const diffs = [];
  const label = `worklist for ${show(fileName)}`;
  const members = expectedWorklist(cases);
  const dataRows = rows.slice(1).map((r) => normalise(r.join(" "))).filter(Boolean);
  const matchRow = (e) =>
    dataRows.findIndex((text) => text.includes(normalise(e.fields.tenantName)) && (!e.fields.accountRef || text.includes(normalise(e.fields.accountRef))));
  const positions = new Map();
  for (const e of members) {
    const i = matchRow(e);
    if (i < 0) diffs.push(`${label}: case ${e.rowId} (${e.final.status}${e.final.reasonCode ? ` ${e.final.reasonCode}` : ""}) is not listed`);
    else positions.set(e, i);
  }
  for (const e of cases.filter((c) => !members.includes(c))) {
    if (matchRow(e) >= 0) diffs.push(`${label}: case ${e.rowId} (${e.final.status}) is listed but needs nobody`);
  }
  if (dataRows.length !== members.length) diffs.push(`${label}: expected ${members.length} row(s), got ${dataRows.length}`);
  const urgent = [...positions].filter(([e]) => e.final.urgent).map(([, i]) => i);
  const other = [...positions].filter(([e]) => !e.final.urgent).map(([, i]) => i);
  if (urgent.length && other.length && Math.max(...urgent) > Math.min(...other)) {
    diffs.push(`${label}: urgent cases are not listed first (urgent rows ${urgent.map((i) => i + 2).join(", ")}; first other row ${Math.min(...other) + 2})`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Reference reading of the design (used by the unit tests to cross-check the
// hand-written expectations in scenarios.json, not by the runner)
// ---------------------------------------------------------------------------

/**
 * Runs a group's files through a plain reading of the design with the default
 * settings and no outages: Dispatcher intake (keys, tenancy groups, re-sent rows)
 * and the Performer's five checks and update paths against an in-memory RBIS.
 * @returns { cases: Map caseKey -> result, changes: [{ref, operation, ...}] }
 */
export function referenceRun(data, group, accountsFile) {
  const s = data.settingsAssumed;
  const landlord = s.landlordNames[0];
  const isLandlord = (name) => s.landlordNames.some((n) => normalise(n) === normalise(name));
  const rbis = new Map(
    accountsFile.accounts.map((a) => [a.ref, structuredClone({ canTerminate: true, refuseParties: [], ...a })]),
  );
  const changes = [];
  const record = (ref, operation, detail) => changes.push({ ref, operation, ...detail });
  const current = (acc) => acc.liabilities.filter((l) => l.end === null);
  const layouts = fileLayouts(data);
  const cases = new Map();
  const groupScenarios = new Set(group.scenarios);

  const runDrop = (fileNames) => {
    const intake = [];
    for (const fileName of fileNames) {
      const layout = layouts.get(fileName);
      if (layout.kind !== "rows" || layout.omitColumns || layout.rows.length === 0) continue; // rejected
      if (/[^A-Za-z0-9 _.()-]/.test(fileName.replace(/\.xlsx$/, "")) || fileName.startsWith("~$")) continue; // unsafe or temporary
      const leads = new Map();
      for (const r of layout.rows) {
        if (!groupScenarios.has(r.scenarioId)) continue;
        const f = r.fields;
        const lead = leads.get(f.tenancyKey);
        if (!lead) leads.set(f.tenancyKey, f);
        const existing = cases.get(f.caseKey);
        const joint = lead ? [] : layout.rows.filter((o) => o !== r && o.fields.tenancyKey === f.tenancyKey).map((o) => o.fields);
        if (existing && existing.status !== "referred") continue; // skipped
        const c = {
          ...f,
          isLeadRow: !lead,
          coveredByCaseKey: lead ? lead.caseKey : "",
          jointTenants: joint.map((j) => ({ name: j.tenantName, email: j.contactEmail, phone: j.contactPhone })),
          status: "new",
          reasonCode: "",
          outcome: "",
          urgent: false,
          stepsDone: [],
          submissions: existing ? existing.submissions + 1 : 1,
          previousResult: existing ? { status: existing.status, reasonCode: existing.reasonCode, file: existing.file } : null,
          file: fileName,
        };
        cases.set(f.caseKey, c);
        intake.push(c);
      }
    }
    const order = (c) => [isRealIsoDate(c.relevantDate) ? c.relevantDate : "9999", c.changeReason === "TENANCY_START" ? 1 : 0, c.rowNumber];
    intake.sort((a, b) => {
      const x = order(a);
      const y = order(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return 0;
    });
    for (const c of intake) perform(c);
  };

  const refer = (c, code) => {
    c.status = "referred";
    c.reasonCode = code;
    c.urgent = c.stepsDone.length > 0;
  };

  const perform = (c) => {
    // Check 1
    const dates = [c.startDate, c.endDate].filter((d) => d !== "");
    const relevantMissing = c.relevantDate === "";
    if (relevantMissing || dates.some((d) => !isRealIsoDate(d)) || (c.startDate && c.endDate && c.endDate < c.startDate)) return refer(c, "DATES_INVALID");
    if (s.deathChangeReasons.includes(c.changeReason) && s.deathHandling === "refer") return refer(c, "DEATH_REFERRED");
    if (!s.allowedChangeReasons.includes(c.changeReason)) return refer(c, "CHANGE_REASON_NOT_VALID");
    // Check 2
    if (!c.isLeadRow) {
      const lead = cases.get(c.coveredByCaseKey);
      if (lead.status === "updated") {
        c.status = "duplicate";
        c.reasonCode = "SAME_TENANCY_AS_EARLIER_ROW";
        return;
      }
      return refer(c, "EARLIER_ROW_NOT_COMPLETED");
    }
    // Check 3
    if (!c.accountRef) return refer(c, "NO_ACCOUNT_REF");
    if (brokenRefs.has(c.accountRef)) {
      // Every call fails on every try (an outage with no count): failed with no tries left.
      c.status = "failed";
      c.reasonCode = "RBIS_ERROR";
      c.urgent = c.stepsDone.length > 0;
      return;
    }
    const acc = rbis.get(c.accountRef);
    if (!acc || normalise(acc.address) !== normalise(c.address) || normalise(acc.postcode) !== normalise(c.postcode)) return refer(c, "ADDRESS_NOT_FOUND");
    // Check 4
    const now = current(acc);
    const landlordLiable = now.some((l) => isLandlord(l.party));
    const moveIn = c.changeReason === "TENANCY_START";
    const dateCheck = () => {
      const start = now[0]?.start ?? null;
      if (!start) return "NO_START_DATE";
      return start === c.relevantDate ? "ACCOUNT_ALREADY_PROCESSED" : "CHECK_DATES";
    };
    if (moveIn && !landlordLiable) return refer(c, dateCheck());
    if (!moveIn && landlordLiable) return refer(c, dateCheck());
    if (!moveIn && s.confirmLeaverIsLiable && !now.some((l) => normalise(l.party) === normalise(c.tenantName))) return refer(c, "LEAVER_NOT_LIABLE");
    // Check 5
    if (!acc.canTerminate || now.length === 0) return refer(c, "NO_OPTION_TO_TERMINATE");
    // Update paths
    const endAll = (endDate) => {
      const ended = current(acc);
      ended.forEach((l) => (l.end = endDate));
      record(acc.ref, "terminate", { endDate, ended: ended.map((l) => l.party) });
      c.stepsDone.push("endLiability");
    };
    const add = (name, type, startDate) => {
      if (acc.refuseParties.some((p) => normalise(p) === normalise(name))) return false;
      acc.liabilities.push({ party: name, type, start: startDate, end: null });
      record(acc.ref, "addLiableParty", { name, type, startDate });
      c.stepsDone.push(`addLiableParty:${normalise(name)}`);
      return true;
    };
    if (moveIn) {
      const people = [{ name: c.tenantName, email: c.contactEmail, phone: c.contactPhone }, ...c.jointTenants];
      endAll(c.startDate);
      for (const p of people) if (!add(p.name, "tenant", c.startDate)) return refer(c, "UNABLE_TO_ADD_PARTY");
      record(acc.ref, "createDetail", { startDate: c.startDate, tenants: people.map((p) => p.name) });
      c.stepsDone.push("createDetail");
      const withContact = people.filter((p) => p.email || p.phone);
      for (const p of withContact) {
        record(acc.ref, "setContact", { name: p.name, email: p.email || null, phone: p.phone || null });
        c.stepsDone.push(`setContactDetails:${normalise(p.name)}`);
      }
      c.status = "updated";
      c.outcome = "liability started";
      c.reasonCode = withContact.length ? "" : "NO_CONTACT_DETAILS";
      return;
    }
    endAll(c.endDate);
    if (!add(landlord, "landlord", c.endDate)) return refer(c, "UNABLE_TO_ADD_PARTY");
    if (c.forwardingAddress) {
      record(acc.ref, "setForwardingAddress", { address: c.forwardingAddress });
      c.stepsDone.push("setForwardingAddress");
      c.outcome = "liability ended, address saved";
    } else c.outcome = "liability ended";
    c.status = "updated";
  };

  // Outages that recover (with a count) do not change the final result; only
  // an outage with no count that also fails reads is modelled.
  const brokenRefs = new Set();
  for (const step of group.steps) {
    if (step.do === "outage" && step.body.count === undefined && step.body.includeReads && step.body.ref) brokenRefs.add(step.body.ref);
    if (step.do === "outageOff") brokenRefs.clear();
    if (step.do === "drop") runDrop(step.files);
    if (step.do === "addAccount") rbis.set(step.ref, structuredClone({ canTerminate: true, refuseParties: [], ref: step.ref, ...data.accountsAddedAtRunTime[step.ref] }));
  }
  return { cases, changes };
}

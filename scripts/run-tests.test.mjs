// Unit tests for the HARSLL test kit: key builders, the reference tidy rules,
// the comparators, the .xlsx writer and reader, the scenario list itself, and
// the runner's options. No n8n or pretend RBIS needed.
//
//   node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { repoRoot } from "./lib/env.mjs";
import * as kit from "./lib/scenario-kit.mjs";
import { buildXlsx, crc32, crc32Fallback, excelSerialToIso, isoToExcelSerial, readXlsx, unzip } from "./lib/xlsx.mjs";
import { buildAllFiles, staleFiles } from "./make-test-spreadsheets.mjs";
import { estimateSeconds, formatReport, parseArgs, selectGroups } from "./run-tests.mjs";

const data = kit.loadScenarios(repoRoot);
const accounts = kit.loadAccounts(repoRoot);
const expected = kit.expectedCases(data);
const byRow = (rowId) => expected.find((e) => e.rowId === rowId);

// ---------------------------------------------------------------------------
// Keys and tidying
// ---------------------------------------------------------------------------

test("normalise follows the interfaces rule", () => {
  assert.equal(kit.normalise("  Flat 1, 6 Example Street "), "flat 1 6 example street");
  assert.equal(kit.normalise("O'Brien-Test"), "o brien test");
  assert.equal(kit.normalise(null), "");
});

test("caseKey and tenancyKey match the example in interfaces.md", () => {
  const alan = byRow("alan").fields;
  assert.equal(alan.caseKey, "TENANCY_END|AC100004|4 example street|alan sample|2026-10-31");
  assert.equal(alan.tenancyKey, "TENANCY_END|AC100004|4 example street|2026-10-31");
});

test("relevant date: start date for a move-in, end date otherwise (deaths and unknown reasons too)", () => {
  assert.equal(byRow("amy").fields.relevantDate, "2026-11-01");
  assert.equal(byRow("eric").fields.relevantDate, "2026-10-28");
  assert.equal(byRow("dawn").fields.relevantDate, "2026-10-31");
});

test("tidyDate accepts the three date forms and keeps impossible dates as text", () => {
  assert.equal(kit.tidyDate({ excelDate: "2026-11-01" }), "2026-11-01");
  assert.equal(kit.tidyDate({ number: 46327 }), "2026-11-01");
  assert.equal(kit.tidyDate("01/11/2026"), "2026-11-01");
  assert.equal(kit.tidyDate(" 1/11/2026 "), "2026-11-01");
  assert.equal(kit.tidyDate("31/02/2026"), "31/02/2026");
  assert.equal(kit.tidyDate(""), "");
});

test("tidyExtractedDate handles what n8n returns (phase-4 trial 2)", () => {
  assert.equal(kit.tidyExtractedDate("2026-11-01T00:00:00.000Z"), "2026-11-01");
  assert.equal(kit.tidyExtractedDate("2026-11-01T14:29:59.999Z"), "2026-11-01");
  assert.equal(kit.tidyExtractedDate("2026-10-31T23:59:59.999Z"), "2026-11-01", "rounds to the nearest second first");
  assert.equal(kit.tidyExtractedDate(46327), "2026-11-01");
  assert.equal(kit.tidyExtractedDate("01/11/2026"), "2026-11-01");
  assert.equal(kit.tidyExtractedDate("31/02/2026"), "31/02/2026");
  assert.equal(kit.tidyExtractedDate(""), "");
});

test("intakeFields trims, upper-cases the change reason and account reference, and marks flats", () => {
  const beth = byRow("beth").fields;
  assert.equal(beth.changeReason, "TENANCY_END");
  assert.equal(beth.accountRef, "AC100005");
  assert.equal(beth.tenantName, "Beth Sample");
  assert.equal(beth.endDate, "2026-10-30");
  assert.equal(beth.isFlat, false);
  assert.equal(byRow("della").fields.isFlat, true);
  assert.equal(byRow("dora").fields.endDate, "31/02/2026");
  assert.equal(byRow("dora").fields.caseKey, "TENANCY_END|AC100007|7 example street|dora sample|31/02/2026");
});

test("row numbers start at 2, and a row placed at the end of a file is numbered there", () => {
  assert.equal(byRow("amy").fields.rowNumber, 2);
  assert.equal(byRow("bella").fields.rowNumber, 3);
  assert.equal(byRow("bruno").fields.rowNumber, 32);
});

// ---------------------------------------------------------------------------
// The scenario list
// ---------------------------------------------------------------------------

test("scenarios.json has scenarios 1 to 37, each in exactly one group", () => {
  assert.deepEqual(data.scenarios.map((s) => s.id), Array.from({ length: 37 }, (_, i) => i + 1));
  for (const s of data.scenarios) {
    const groups = data.groups.filter((g) => g.scenarios.includes(s.id));
    assert.equal(groups.length, 1, `scenario ${s.id} is in ${groups.length} groups`);
  }
});

test("every row's file exists, and each file is dropped by the group its scenarios are in", () => {
  const fileNames = new Set(data.files.map((f) => f.name));
  for (const s of data.scenarios) {
    const group = kit.groupOf(data, s.id);
    const dropped = new Set(group.steps.filter((st) => st.do === "drop").flatMap((st) => st.files));
    for (const r of s.rows) for (const f of [r.file, ...(r.alsoIn ?? [])]) {
      assert.ok(fileNames.has(f), `scenario ${s.id}: unknown file ${f}`);
      assert.ok(dropped.has(f), `scenario ${s.id}: ${f} is not dropped by group ${group.id}`);
    }
  }
});

test("reason codes, statuses and outcomes are the design's", () => {
  const statuses = new Set(["new", "in_progress", "updated", "referred", "duplicate", "failed"]);
  const outcomes = new Set(["", "liability started", "liability ended, address saved", "liability ended"]);
  for (const e of expected) {
    for (const x of [e.final, ...Object.values(e.checkpoints)]) {
      if (x.noCase) continue;
      if ("status" in x) assert.ok(statuses.has(x.status), `${e.ref}: status ${x.status}`);
      if (x.reasonCode) assert.ok(x.reasonCode in data.reasonTexts, `${e.ref}: reason ${x.reasonCode}`);
      if ("outcome" in x) assert.ok(outcomes.has(x.outcome), `${e.ref}: outcome ${x.outcome}`);
    }
  }
});

test("every final expectation states status, reasonCode, urgent, outcome, isLeadRow, attempts and stepsDone", () => {
  for (const e of expected.filter((x) => !x.noCase)) {
    for (const k of ["status", "reasonCode", "urgent", "outcome", "isLeadRow", "attempts", "stepsDone"]) {
      assert.ok(k in e.final, `${e.ref}: no ${k}`);
    }
    if (!e.final.isLeadRow) assert.ok(e.final.coveredBy, `${e.ref}: a joint row needs coveredBy`);
  }
});

test("made-up data only: names end in Sample or Test, emails use example.test, streets are invented", () => {
  for (const e of expected) {
    assert.match(e.fields.tenantName, /\b(Sample|Test)$/, e.ref);
    if (e.fields.contactEmail) assert.match(e.fields.contactEmail, /@example\.test$/, e.ref);
    assert.match(e.fields.address, /(Example|Other) Street$/, e.ref);
  }
});

test("tenant names are unique within each file (the worklist check matches rows by name)", () => {
  for (const [name, layout] of kit.fileLayouts(data)) {
    const names = layout.rows.map((r) => kit.normalise(r.fields.tenantName));
    assert.equal(new Set(names).size, names.length, `${name} repeats a tenant name`);
  }
});

test("accounts: rows use the account their scenario names, with its address, unless the scenario tests a mismatch", () => {
  const known = new Map(accounts.accounts.map((a) => [a.ref, a]));
  for (const [ref, a] of Object.entries(data.accountsAddedAtRunTime)) known.set(ref, a);
  for (const e of expected) {
    const s = data.scenarios.find((x) => x.id === e.scenarioId);
    const ref = e.fields.accountRef;
    if (!ref || e.noCase || e.final.reasonCode === "ADDRESS_NOT_FOUND") continue;
    const a = known.get(ref);
    assert.ok(a, `${e.ref}: account ${ref} is not in rbis-accounts.json or accountsAddedAtRunTime`);
    assert.ok(s.accounts.includes(ref), `${e.ref}: scenario ${s.id} does not list ${ref}`);
    assert.equal(kit.normalise(a.address), kit.normalise(e.fields.address), `${e.ref}: address`);
    assert.equal(kit.normalise(a.postcode), kit.normalise(e.fields.postcode), `${e.ref}: postcode`);
  }
  for (const s of data.scenarios) for (const ref of Object.keys(s.rbisChanges ?? {})) assert.ok(s.accounts.includes(ref), `scenario ${s.id}: ${ref}`);
});

test("lead and joint rows agree with the tenancy grouping (same account, address, change type and date)", () => {
  for (const [, layout] of kit.fileLayouts(data)) {
    const first = new Map();
    for (const r of layout.rows) {
      const e = expected.find((x) => x.scenarioId === r.scenarioId && x.rowId === r.rowId);
      if (e.noCase || e.final.batch?.file && e.final.batch.file !== layout.name) continue;
      const lead = first.get(r.fields.tenancyKey);
      if (!lead) first.set(r.fields.tenancyKey, r);
      assert.equal(e.final.isLeadRow, !lead, `${e.ref}: isLeadRow`);
      if (lead) assert.equal(e.coveredByCaseKey, lead.fields.caseKey, `${e.ref}: coveredBy`);
    }
  }
});

test("the expectations agree with a plain reading of the design (reference model)", () => {
  for (const group of data.groups) {
    const { cases, changes } = kit.referenceRun(data, group, accounts);
    for (const e of expected.filter((x) => group.scenarios.includes(x.scenarioId))) {
      const c = cases.get(e.fields.caseKey);
      if (e.noCase) {
        assert.equal(c, undefined, `${e.ref}: the model made a case`);
        continue;
      }
      assert.ok(c, `${e.ref}: the model made no case`);
      for (const k of ["status", "reasonCode", "outcome", "urgent", "isLeadRow", "stepsDone", "jointTenants"]) {
        if (!(k in e.final)) continue; // joint rows do not state jointTenants
        assert.ok(kit.sameValue(e.final[k], c[k]), `${e.ref}: ${k}: scenarios.json ${JSON.stringify(e.final[k])}, model ${JSON.stringify(c[k])}`);
      }
      assert.equal(c.coveredByCaseKey, e.coveredByCaseKey, `${e.ref}: coveredBy`);
      if (e.final.submissions) assert.equal(c.submissions, e.final.submissions, `${e.ref}: submissions`);
    }
    for (const id of group.scenarios) {
      const s = data.scenarios.find((x) => x.id === id);
      const withoutReplyLost = Object.fromEntries(Object.entries(s.rbisChanges ?? {}).map(([ref, l]) => [ref, l.map(({ replyLost, ...rest }) => rest)]));
      assert.deepEqual(kit.compareRbisChanges(withoutReplyLost, changes), [], `scenario ${id}`);
    }
  }
});

test("the main file's summary and worklist counts", () => {
  const main = expected.filter((e) => !e.noCase && (e.final.batch?.file ?? e.file) === "harsll-main.xlsx");
  assert.deepEqual(kit.expectedSummaryCounts(main), { cases: 31, updated: 11, referred: 19, failed: 0, duplicate: 1, urgent: 2 });
  const worklist = kit.expectedWorklist(main);
  assert.equal(worklist.length, 20);
  assert.deepEqual(worklist.filter((e) => e.final.urgent).map((e) => e.rowId).sort(), ["noah", "paul"]);
});

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

const batchOf = (file, drop = 1) => ({ "harsll-main.xlsx": ["B-MAIN"], "resend-first.xlsx": ["B-R1"], "resend-second.xlsx": ["B-R2"] })[file]?.[drop - 1];
const ctx = { batchOf, reasonTexts: data.reasonTexts };

function rowFor(e, overrides = {}) {
  const x = e.final;
  return {
    ...e.fields,
    coveredByCaseKey: e.coveredByCaseKey,
    isLeadRow: x.isLeadRow,
    jointTenants: x.isLeadRow ? JSON.stringify(x.jointTenants) : "",
    batchId: batchOf(x.batch?.file ?? e.file, x.batch?.drop ?? 1),
    status: x.status,
    reasonCode: x.reasonCode,
    reasonText: x.reasonCode ? data.reasonTexts[x.reasonCode] : "",
    outcome: x.outcome,
    urgent: x.urgent,
    stepsDone: JSON.stringify(x.stepsDone),
    attempts: x.attempts,
    submissions: x.submissions ?? 1,
    previousResult: x.previousResult ? JSON.stringify({ status: x.previousResult.status, reasonCode: x.previousResult.reasonCode, batchId: batchOf(x.previousResult.batch.file) }) : "",
    ...overrides,
  };
}

test("compareCase: a matching row has no differences", () => {
  for (const id of ["amy", "bella", "bruno", "noah", "paul", "dora", "cara"]) {
    const e = byRow(id);
    assert.deepEqual(kit.compareCase(e, e.final, rowFor(e), ctx), [], id);
  }
});

test("compareCase: null and empty text are the same; booleans may be null for false", () => {
  const e = byRow("amy");
  assert.deepEqual(kit.compareCase(e, e.final, rowFor(e, { reasonCode: null, endDate: null, forwardingAddress: null }), ctx), []);
  const dora = byRow("dora");
  assert.deepEqual(kit.compareCase(dora, dora.final, rowFor(dora, { urgent: null }), ctx), []);
});

test("compareCase: reports each wrong field with expected and actual values", () => {
  const e = byRow("amy");
  const diffs = kit.compareCase(e, e.final, rowFor(e, { status: "referred", attempts: 2, startDate: "2026-10-31", reasonText: "x" }), ctx);
  assert.ok(diffs.includes('case amy: status: expected "updated", got "referred"'));
  assert.ok(diffs.includes("case amy: attempts: expected 1, got 2"));
  assert.ok(diffs.includes('case amy: startDate: expected "2026-11-01", got "2026-10-31"'));
  assert.ok(diffs.includes('case amy: reasonText: expected "", got "x"'));
});

test("compareCase: stepsDone order matters; jointTenants compares by content", () => {
  const e = byRow("bella");
  const steps = JSON.parse(rowFor(e).stepsDone).reverse();
  assert.equal(kit.compareCase(e, e.final, rowFor(e, { stepsDone: JSON.stringify(steps) }), ctx).length, 1);
  const reordered = JSON.stringify([{ phone: "07700 900022", email: "bruno.sample@example.test", name: "Bruno Sample" }]);
  assert.deepEqual(kit.compareCase(e, e.final, rowFor(e, { jointTenants: reordered }), ctx), []);
  const wrong = JSON.stringify([{ name: "Bruno Sample", email: "", phone: "07700 900022" }]);
  assert.match(kit.compareCase(e, e.final, rowFor(e, { jointTenants: wrong }), ctx)[0], /jointTenants/);
});

test("compareCase: missing case, unwanted case, batch and previous result", () => {
  const amy = byRow("amy");
  assert.match(kit.compareCase(amy, amy.final, undefined, ctx)[0], /missing from the Cases table/);
  const mia = byRow("mia");
  assert.match(kit.compareCase(mia, mia.final, { status: "referred" }, ctx)[0], /should not exist/);
  assert.match(kit.compareCase(amy, amy.final, rowFor(amy, { batchId: "OTHER" }), ctx)[0], /batchId: expected "B-MAIN", got "OTHER"/);
  const cleo = byRow("cleo");
  assert.deepEqual(kit.compareCase(cleo, cleo.final, rowFor(cleo), ctx), []);
  const badPrev = JSON.stringify({ status: "referred", reasonCode: "ADDRESS_NOT_FOUND", batchId: "B-R2" });
  assert.match(kit.compareCase(cleo, cleo.final, rowFor(cleo, { previousResult: badPrev }), ctx)[0], /previousResult/);
});

test("compareCase: checkpoints compare only what they state", () => {
  const vera = byRow("vera");
  const atCheckpoint = { ...rowFor(vera), status: "failed", reasonCode: "RBIS_ERROR", reasonText: data.reasonTexts.RBIS_ERROR, attempts: 1, stepsDone: '["endLiability"]', errorDetail: "503" };
  assert.deepEqual(kit.compareCase(vera, vera.checkpoints.afterFirstPass, atCheckpoint, ctx), []);
  assert.match(kit.compareCase(vera, vera.checkpoints.afterFirstPass, { ...atCheckpoint, errorDetail: "" }, ctx)[0], /errorDetail/);
});

test("compareCases: two rows with one caseKey is a failure", () => {
  const cara = byRow("cara");
  const diffs = kit.compareCases([cara], [rowFor(cara), rowFor(cara)], ctx).get(3);
  assert.match(diffs[0], /2 rows in the Cases table/);
});

test("unexpectedCases lists rows no scenario expects", () => {
  const amy = byRow("amy");
  assert.deepEqual(kit.unexpectedCases([amy], [rowFor(amy), { caseKey: "X" }]).map((r) => r.caseKey), ["X"]);
});

const change = (seq, ref, operation, rest) => ({ seq, at: "", ref, operation, ...rest });

test("compareRbisChanges: exact match, extra, missing and wrong fields", () => {
  const want = data.scenarios.find((s) => s.id === 1).rbisChanges;
  const good = want.AC100001.map((c, i) => change(i + 1, "AC100001", c.operation, c));
  assert.deepEqual(kit.compareRbisChanges(want, good), []);
  const extra = [...good, change(9, "AC100001", "setContact", { name: "Amy Sample" })];
  assert.match(kit.compareRbisChanges(want, extra)[0], /change 5 not expected: setContact/);
  assert.match(kit.compareRbisChanges(want, good.slice(0, 3))[0], /change 4 missing/);
  const wrongDate = good.map((c) => (c.operation === "terminate" ? { ...c, endDate: "2026-10-31" } : c));
  assert.match(kit.compareRbisChanges(want, wrongDate)[0], /change 1 \(terminate\): endDate: expected "2026-11-01", got "2026-10-31"/);
  assert.match(kit.compareRbisChanges({ AC100007: [] }, [change(1, "AC100007", "terminate", {})])[0], /not expected/);
});

test("compareRbisChanges: order is by sequence; other accounts are ignored; tenants may be objects", () => {
  const want = { AC100001: [{ operation: "createDetail", tenants: ["Amy Sample"] }, { operation: "setContact", name: "Amy Sample" }] };
  const got = [change(5, "AC100001", "setContact", { name: "Amy Sample" }), change(2, "AC999998", "terminate", {}), change(3, "AC100001", "createDetail", { tenants: [{ name: "Amy Sample", email: "a@example.test" }] })];
  assert.deepEqual(kit.compareRbisChanges(want, got), []);
});

test("compareFileCheck: folders, batch rows and emails", () => {
  const state = {
    folders: { input: ["unsafe;name$test.xlsx"], archive: ["2026-11-19T10-00-01_together.xlsx"], rejected: [], reports: [] },
    batches: [{ id: 1, fileName: "together.xlsx", status: "received", rowCount: 1 }, { id: 2, fileName: "unsafe;name$test.xlsx", status: "needs_rename" }],
    emails: [{ subject: "Please rename unsafe;name$test.xlsx", text: "" }],
  };
  assert.deepEqual(kit.compareFileCheck({ file: "together.xlsx", endsIn: "archive", batchCount: 1, batch: { status: "received", rowCount: 1 } }, state), []);
  assert.deepEqual(kit.compareFileCheck({ file: "unsafe;name$test.xlsx", endsIn: "input", emailsAbout: 1, batch: { status: "needs_rename" } }, state), []);
  const d = kit.compareFileCheck({ file: "missing-column.xlsx", endsIn: "rejected", emailsAbout: 1, batch: { status: "rejected" } }, state);
  assert.ok(d.some((x) => /not found in the rejected folder/.test(x)));
  assert.ok(d.some((x) => /no batch row/.test(x)));
  assert.ok(d.some((x) => /expected 1 email\(s\) mentioning it, got 0/.test(x)));
  assert.match(kit.compareFileCheck({ file: "x.xlsx", emailsAbout: 1 }, { ...state, emails: null })[0], /^SKIP /);
});

test("summary email: parses the design's example and checks counts and personal data", () => {
  const subject = "HARSLL batch 2026-11-19 09:14 – 18 cases: 11 updated, 5 referred, 1 failed, 1 duplicate";
  const text = "File: changes.xlsx (archived)\n\nURGENT – RBIS partly changed, needs a person now: 1\n\nUpdated: 11\n";
  assert.deepEqual(kit.parseSummaryCounts(subject, text), { cases: 18, updated: 11, referred: 5, failed: 1, duplicate: 1, urgent: 1 });
  const main = expected.filter((e) => !e.noCase && (e.final.batch?.file ?? e.file) === "harsll-main.xlsx");
  const good = { subject: "HARSLL batch 2026-11-19 10:00 – 31 cases: 11 updated, 19 referred, 0 failed, 1 duplicate", text: "File: harsll-main.xlsx (archived)\nURGENT – RBIS partly changed, needs a person now: 2\n" };
  assert.deepEqual(kit.compareSummary("harsll-main.xlsx", main, [good]), []);
  const leaky = { ...good, text: `${good.text}Referred: Paul Sample\n` };
  assert.match(kit.compareSummary("harsll-main.xlsx", main, [leaky])[0], /personal data "Paul Sample"/);
  const noZeros = { subject: "HARSLL batch – 31 cases: 11 updated, 19 referred, 1 duplicate", text: "File: harsll-main.xlsx\nURGENT: 2" };
  assert.deepEqual(kit.compareSummary("harsll-main.xlsx", main, [noZeros]), [], "a count of 0 may be left out");
  assert.match(kit.compareSummary("harsll-main.xlsx", main, [])[0], /expected 1 summary email, got 0/);
});

test("worklist: members, urgent first, nothing extra", () => {
  const main = expected.filter((e) => !e.noCase && (e.final.batch?.file ?? e.file) === "harsll-main.xlsx");
  const members = kit.expectedWorklist(main);
  const row = (e) => [e.final.urgent ? "URGENT" : "", e.fields.accountRef, e.fields.tenantName, e.final.reasonCode];
  const urgentFirst = [...members].sort((a, b) => Number(Boolean(b.final.urgent)) - Number(Boolean(a.final.urgent)));
  assert.deepEqual(kit.compareWorklist("harsll-main.xlsx", [["h"], ...urgentFirst.map(row)], main), []);
  assert.match(kit.compareWorklist("harsll-main.xlsx", [["h"], ...[...urgentFirst].reverse().map(row)], main).join(), /urgent cases are not listed first/);
  assert.match(kit.compareWorklist("harsll-main.xlsx", [["h"], ...urgentFirst.slice(1).map(row)], main).join(), /case noah .* is not listed|case paul .* is not listed/);
  assert.match(kit.compareWorklist("harsll-main.xlsx", [["h"], ...urgentFirst.map(row), row(byRow("amy"))], main).join(), /case amy \(updated\) is listed but needs nobody/);
});

// ---------------------------------------------------------------------------
// .xlsx writer and reader, and the generated files
// ---------------------------------------------------------------------------

test("CRC32: node:zlib and the fallback agree", () => {
  for (let i = 0; i < 20; i++) {
    const b = randomBytes(1 + i * 97);
    assert.equal(crc32(b), crc32Fallback(b));
  }
  assert.equal(crc32Fallback(Buffer.from("hello world")).toString(16), "d4a1185");
});

test("Excel day numbers: 46327 is 1 November 2026", () => {
  assert.equal(isoToExcelSerial("2026-11-01"), 46327);
  assert.equal(excelSerialToIso(46327), "2026-11-01");
  assert.equal(excelSerialToIso(45748), "2025-04-01");
});

test("an .xlsx built by the writer reads back, with text, dates as day numbers and plain numbers", () => {
  const buf = buildXlsx({ header: ["A", "B", "C"], rows: [["x & <y>", { excelDate: "2026-11-01" }, { number: 7 }], ["", "  spaced  ", null]] });
  const parts = [...unzip(buf).keys()];
  assert.ok(parts.includes("xl/worksheets/sheet1.xml") && parts.includes("xl/styles.xml") && parts.includes("[Content_Types].xml"));
  const { rows, sheetName } = readXlsx(buf);
  assert.equal(sheetName, "Changes");
  assert.deepEqual(rows, [["A", "B", "C"], ["x & <y>", "46327", "7"], ["", "  spaced  "]]);
});

test("generated files: deterministic, up to date, and the special files are what they claim", () => {
  const a = buildAllFiles(data);
  const b = buildAllFiles(data);
  for (const [name, buf] of a) assert.ok(buf.equals(b.get(name)), name);
  assert.deepEqual(staleFiles(a).filter((n) => !n.startsWith("~$")), [], "run node scripts/make-test-spreadsheets.mjs");
  assert.throws(() => unzip(a.get("unreadable.xlsx")));
  assert.equal(a.get("~$temp-book.xlsx").length, 165);
  assert.deepEqual(readXlsx(a.get("no-rows.xlsx")).rows.length, 1);
  assert.ok(!readXlsx(a.get("missing-column.xlsx")).rows[0].includes("Postcode"));
  const main = readXlsx(a.get("harsll-main.xlsx")).rows;
  assert.equal(main.length, 32);
  const tess = main.find((r) => r[2] === "Tess Sample");
  assert.equal(tess[5], "46327");
});

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

test("parseArgs: defaults, --only, --profile, and errors", () => {
  assert.equal(parseArgs([]).profile, "production");
  assert.deepEqual(parseArgs(["--only", "1, 2,6"]).only, [1, 2, 6]);
  assert.deepEqual(parseArgs(["--only=24"]).only, [24]);
  assert.equal(parseArgs(["--profile", "trackC", "--self-check"]).selfCheck, true);
  assert.throws(() => parseArgs(["--only", "x"]), /not a scenario number/);
  assert.throws(() => parseArgs(["--profile", "nope"]), /Unknown profile/);
  assert.throws(() => parseArgs(["--frobnicate"]), /Unknown option/);
});

test("selectGroups: --only picks the groups; the slow group needs --include-slow and the production profile", () => {
  const ids = (sel) => sel.chosen.map((c) => c.group.id);
  assert.deepEqual(ids(selectGroups(data, parseArgs(["--only", "2,24"]))), ["main", "retry-24"]);
  assert.deepEqual(selectGroups(data, parseArgs(["--only", "2,24"])).chosen[0].wanted, [2]);
  const all = selectGroups(data, parseArgs([]));
  assert.ok(!ids(all).includes("while-stopped"));
  assert.equal(all.skipped[0].group.id, "while-stopped");
  assert.ok(ids(selectGroups(data, parseArgs(["--include-slow"]))).includes("while-stopped"));
  assert.ok(!ids(selectGroups(data, parseArgs(["--include-slow", "--profile", "trackC"]))).includes("while-stopped"));
  assert.throws(() => selectGroups(data, parseArgs(["--only", "99"])), /no such scenario/);
});

test("estimateSeconds: about 14 minutes for everything but the slow group", () => {
  const total = data.groups.filter((g) => !g.slow).reduce((s, g) => s + estimateSeconds(g), 0);
  assert.ok(total > 10 * 60 && total < 20 * 60, `${total}s`);
});

test("formatReport: PASS, FAIL with differences, and not-run scenarios", () => {
  const group = data.groups[1];
  const runs = [{ group, wanted: [24], seconds: 80, groupFailures: [], results: new Map([[24, { failures: ["case vera: status: expected \"updated\", got \"failed\""], notes: [] }]]) }];
  const r = formatReport(data, runs, [{ group: data.groups.at(-1), wanted: [36], why: "slow: add --include-slow" }]);
  assert.match(r.text, /FAIL  24  Outage after the first RBIS call/);
  assert.match(r.text, /- case vera: status/);
  assert.match(r.text, /Not run: scenario\(s\) 36/);
  assert.equal(r.fail, 1);
  assert.equal(r.notRun, 1);
});

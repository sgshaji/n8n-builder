#!/usr/bin/env node
// Tests for HARSLL – Dispatcher (parallel build, track B), run against the live local n8n.
//
//   node tests/dispatcher/run-dispatcher-tests.mjs              run every test
//   node tests/dispatcher/run-dispatcher-tests.mjs t2 t4        run only tests t2 and t4
//   node tests/dispatcher/run-dispatcher-tests.mjs --with-restart  also run t10 (may wait up to 15 minutes for the timer)
//   node tests/dispatcher/run-dispatcher-tests.mjs --list       list the tests
//
// Uses only track B's resources: the trackB_* tables, data/trackB/ folders, the Mailpit
// messages sent to harsll-team-trackb@example.test, and the published Dispatcher and stand-in
// Performer. Each test starts by clearing the tables, resetting the lock, deleting track B's
// emails and emptying the track B folders. Made-up data only. Takes about 15 minutes, mostly
// waiting for the file trigger's one-minute settle time. Results: docs/build-notes/track-B.md.
import { writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { readXlsx } from "./lib/xlsx.mjs";
import {
  CFG, HEADER, row, dropFile, xlsxBuffer, folder, listFolder, cases, batches, lockRow, insertRows,
  updateRows, setLock, latestExecutionId, executionsAfter, executionNodes, waitForIdle, waitForTriggerRuns, waitOutTriggerRuns,
  waitUntil, runNow, myMails, resetAll, dockerFind, results, startTest, check, eq, byName,
  minutesAgo, sleep, api, log,
} from "./lib/harness.mjs";

const TESTS = [];
const test = (name, windowSeconds, fn) => TESTS.push({ name, windowSeconds, fn });

// "2026-11-19T09-14-03_x.xlsx" -> "2026-11-19 09:14"
const when = (batchId) => batchId.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2}).*$/, "$1 $2:$3");
const worklistOf = (batchId) => `${batchId.replace(/\.xlsx$/, "")}_worklist.xlsx`;
const statusMap = (list) => Object.fromEntries(list.map((c) => [c.tenantName.split(" ")[0], `${c.status}/${c.attempts}`]));
const readWorklist = (name) => {
  const [head, ...body] = readXlsx(join(folder("reports"), name));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
};
function noPersonalData(mails, caseRows) {
  const leaks = [];
  for (const m of mails) {
    for (const c of caseRows) {
      for (const v of [c.tenantName, c.address, c.accountRef, c.postcode, c.contactEmail, c.contactPhone, c.forwardingAddress]) {
        if (v && v.length > 3 && (m.subject.includes(v) || m.text.includes(v))) leaks.push(`"${v}" in "${m.subject}"`);
      }
    }
  }
  eq("emails hold no names, addresses, postcodes, contact details or account references", leaks, []);
}
// A complete case row for seeding the table directly.
function seededCase(o) {
  const changeReason = o.changeReason || "TENANCY_END";
  const relevantDate = o.relevantDate || "2026-11-01";
  const norm = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const address = o.address || `${o.accountRef} Seed Street`;
  return {
    caseKey: [changeReason, o.accountRef, norm(address), norm(o.tenantName), relevantDate].join("|"),
    tenancyKey: [changeReason, o.accountRef, norm(address), relevantDate].join("|"),
    batchId: o.batchId || "2026-11-18T00-00-00_seeded.xlsx",
    rowNumber: o.rowNumber || 2,
    changeReason, accountRef: o.accountRef, address, postcode: "EX9 8AA", isFlat: false, tenantName: o.tenantName,
    isLeadRow: true, jointTenants: "[]", coveredByCaseKey: "",
    startDate: changeReason === "TENANCY_START" ? relevantDate : "", endDate: changeReason === "TENANCY_START" ? "" : relevantDate,
    relevantDate, forwardingAddress: "", contactEmail: "", contactPhone: "", sourceSystem: "",
    status: o.status || "new", reasonCode: "", reasonText: "", outcome: "", urgent: false,
    stepsDone: o.stepsDone || "[]", attempts: o.attempts ?? 0, submissions: 1, previousResult: "",
    lastAttemptAt: o.lastAttemptAt ?? null, errorDetail: "",
  };
}

// ---------------------------------------------------------------------------------------------
test("t1 file trigger; scenario 6 (move-out and move-in at one address, in order)", 170, async () => {
  const before = await latestExecutionId();
  dropFile("t1 move-out and move-in.xlsx", [
    HEADER,
    row({ ChangeReason: "TENANCY_START", AccountRef: "AC910001", TenantName: "Mia Movein", Address: "10 Order Street", Postcode: "EX9 1AA", StartDate: "01/11/2026", ContactEmail: "mia@example.test" }),
    row({ ChangeReason: "TENANCY_END", AccountRef: "AC910001", TenantName: "Otto Moveout", Address: "10 Order Street", Postcode: "EX9 1AA", EndDate: "01/11/2026", ForwardingAddress: "1 New Road, EX9 9ZZ" }),
    row({ ChangeReason: "TENANCY_END", AccountRef: "AC910002", TenantName: "Pat Early", Address: "11 Order Street", Postcode: "EX9 1AB", EndDate: "31/10/2026" }),
  ]);
  const [run] = await waitForTriggerRuns(before, 1);
  const ex = await executionNodes(run.id);
  check("started by the file trigger", ex.runs["File added to input folder"] === 1, JSON.stringify(ex.runs));
  check("waited for the file to settle before taking the lock", ex.runs["Wait for the file to settle"] === 1);
  const seconds = (new Date(run.stoppedAt) - new Date(run.startedAt)) / 1000;
  check("the run lasted at least fileSettleSeconds (60 s)", seconds >= 59, `${seconds} s`);
  const c = await cases();
  eq("three cases recorded", c.length, 3);
  eq("all updated, each tried once", c.map((x) => `${x.status}/${x.attempts}`), ["updated/1", "updated/1", "updated/1"]);
  const mia = byName(c, "Mia Movein");
  const otto = byName(c, "Otto Moveout");
  const pat = byName(c, "Pat Early");
  check("earliest date first: Pat (31 Oct) before Otto (1 Nov)", pat.lastAttemptAt < otto.lastAttemptAt, `${pat.lastAttemptAt} / ${otto.lastAttemptAt}`);
  check("same date: the move-out (Otto, row 3) before the move-in (Mia, row 2)", otto.lastAttemptAt < mia.lastAttemptAt, `${otto.lastAttemptAt} / ${mia.lastAttemptAt}`);
  eq("move-in and move-out at one address are separate cases, not one tenancy", [mia.isLeadRow, otto.isLeadRow, mia.coveredByCaseKey, otto.coveredByCaseKey], [true, true, "", ""]);
  eq("case key", otto.caseKey, "TENANCY_END|AC910001|10 order street|otto moveout|2026-11-01");
  eq("tenancy key", otto.tenancyKey, "TENANCY_END|AC910001|10 order street|2026-11-01");
  eq("Dispatcher columns of a new case", [mia.status, mia.attempts, mia.submissions, mia.previousResult, mia.rowNumber, otto.rowNumber, pat.rowNumber], ["updated", 1, 1, "", 2, 3, 4]);
  const b = await batches();
  eq("one batch, received, with its row count", b.map((x) => [x.status, x.rowCount, x.fileName, x.readAttempts]), [["received", 3, "t1 move-out and move-in.xlsx", 0]]);
  check("batchId is <yyyy-MM-ddTHH-mm-ss>_<file name>", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_t1 move-out and move-in\.xlsx$/.test(b[0].batchId), b[0].batchId);
  eq("every case carries the batchId", [...new Set(c.map((x) => x.batchId))], [b[0].batchId]);
  eq("input folder is empty", listFolder("input"), []);
  eq("file archived as <batchId>", listFolder("archive"), [b[0].batchId]);
  check("summarySentAt recorded", !!b[0].summarySentAt);
  const mails = await myMails();
  eq("one email", mails.length, 1);
  eq("summary subject", mails[0]?.subject, `HARSLL batch ${when(b[0].batchId)} – 3 cases: 3 updated, 0 referred, 0 failed, 0 duplicate`);
  const lines = (mails[0]?.text || "").split(/\r?\n/);
  for (const l of ["File: t1 move-out and move-in.xlsx (archived)", "Updated: 3", "  Liability started: 1", "  Liability ended, address saved: 1", "  Liability ended: 1", "Referred to staff: 0", "Failed after 3 tries: 0", "Covered by an earlier row for the same tenancy: 0", "Worklist: none needed, nothing for staff to do"]) {
    check(`summary line "${l.trim()}"`, lines.includes(l), mails[0]?.text);
  }
  check("no URGENT line when nothing is urgent", !lines.some((l) => l.startsWith("URGENT")));
  noPersonalData(mails, c);
  eq("no worklist file when nothing needs a person", listFolder("reports"), []);
  const lock = await lockRow();
  eq("lock released at the end", [lock.lockedBy, lock.lockedAt], ["", null]);
});

// ---------------------------------------------------------------------------------------------
test("t2 retries, holds, joint rows, urgent; scenarios 26 and 27; summary and worklist", 200, async () => {
  const before = await latestExecutionId();
  dropFile("t2 retries and holds.xlsx", [
    HEADER,
    row({ ChangeReason: "TENANCY_START", AccountRef: "AC920001", TenantName: "Jo FailOnce", Address: "20 Joint Road", Postcode: "EX9 2AA", StartDate: { date: "2026-11-02" }, ContactEmail: "jo@example.test" }),
    row({ ChangeReason: "TENANCY_START", AccountRef: "AC920001", TenantName: "Kim Joint", Address: "20 Joint Road", Postcode: "EX9 2AA", StartDate: "02/11/2026", ContactPhone: "07700 900002" }),
    row({ ChangeReason: "TENANCY_END", AccountRef: "AC920002", TenantName: "Lou FailOnce", Address: "21 Retry Road", Postcode: "EX9 2AB", EndDate: "01/11/2026" }),
    row({ ChangeReason: "TENANCY_START", AccountRef: "AC920002", TenantName: "Max Newtenant", Address: "21 Retry Road", Postcode: "EX9 2AB", StartDate: "01/11/2026", ContactEmail: "max@example.test" }),
    row({ ChangeReason: "TENANCY_END", AccountRef: "AC920003", TenantName: "Ned FailAlways", Address: "22 Always Road", Postcode: "EX9 2AC", EndDate: "01/11/2026" }),
    row({ ChangeReason: "TENANCY_START", AccountRef: "AC920004", TenantName: "Ola Urgent", Address: "23 Urgent Road", Postcode: "EX9 2AD", StartDate: "01/11/2026", ContactEmail: "ola@example.test" }),
    row({ ChangeReason: "TENANCY_START", AccountRef: "AC920005", TenantName: "Pip Nocontact", Address: "24 Quiet Road", Postcode: "EX9 2AE", StartDate: "01/11/2026" }),
    row({ ChangeReason: "deceased", AccountRef: "AC920006", TenantName: "Quin Sample", Address: "25 Rest Road", Postcode: "EX9 2AF", EndDate: "30/10/2026" }),
  ]);
  await waitForTriggerRuns(before, 1); // run 1 (the file trigger)
  let c = await cases();
  eq("run 1: failures, holds and results", statusMap(c), { Jo: "failed/1", Kim: "new/0", Lou: "failed/1", Max: "new/0", Ned: "failed/1", Ola: "referred/1", Pip: "updated/1", Quin: "referred/1" });
  const jo = byName(c, "Jo FailOnce");
  const kim = byName(c, "Kim Joint");
  eq("lead row of the joint tenancy", [jo.isLeadRow, jo.coveredByCaseKey, JSON.parse(jo.jointTenants)], [true, "", [{ name: "Kim Joint", email: "", phone: "07700 900002" }]]);
  eq("joint row points to its lead", [kim.isLeadRow, kim.coveredByCaseKey, kim.jointTenants], [false, jo.caseKey, "[]"]);
  eq("joint rows share the tenancy key", kim.tenancyKey, jo.tenancyKey);
  eq("death row: change reason upper-cased, relevant date is the end date", [byName(c, "Quin Sample").changeReason, byName(c, "Quin Sample").relevantDate], ["DECEASED", "2026-10-30"]);
  eq("no summary while the batch is unfinished", (await myMails()).length, 0);

  const r2 = await runNow(); // run 2
  eq("Run now answers {\"started\": true}", r2.body, { started: true });
  check("Run now answers with JSON", /application\/json/.test(r2.contentType || ""), r2.contentType);
  c = await cases();
  eq("run 2: retries succeed, held cases run after their earlier case", statusMap(c), { Jo: "updated/2", Kim: "duplicate/1", Lou: "updated/2", Max: "updated/1", Ned: "failed/2", Ola: "referred/1", Pip: "updated/1", Quin: "referred/1" });
  check("scenario 27: the move-in ran after the move-out's retry", byName(c, "Lou FailOnce").lastAttemptAt < byName(c, "Max Newtenant").lastAttemptAt);
  check("the joint row ran after its lead row", byName(c, "Jo FailOnce").lastAttemptAt < byName(c, "Kim Joint").lastAttemptAt);
  eq("still no summary", (await myMails()).length, 0);

  await runNow(); // run 3
  c = await cases();
  eq("scenario 26: a case that always fails stops after 3 tries", [byName(c, "Ned FailAlways").status, byName(c, "Ned FailAlways").attempts], ["failed", 3]);
  const b = (await batches())[0];
  let mails = await myMails();
  eq("summary sent once every case is finished", mails.length, 1);
  check("summarySentAt recorded", !!b.summarySentAt);
  eq("summary subject", mails[0]?.subject, `HARSLL batch ${when(b.batchId)} – 8 cases: 4 updated, 2 referred, 1 failed, 1 duplicate`);
  const lines = (mails[0]?.text || "").split(/\r?\n/);
  for (const l of [
    "File: t2 retries and holds.xlsx (archived)",
    "URGENT – RBIS partly changed, needs a person now: 1",
    "Updated: 4",
    "  Liability started: 3   (1 needs contact details added)",
    "  Liability ended: 1",
    "Referred to staff: 2",
    "  A person could not be added to the account: 1   (urgent)",
    "  The tenancy ended because the tenant died: 1",
    "Failed after 3 tries: 1",
    "Covered by an earlier row for the same tenancy: 1",
    `Worklist: trackB/reports/${worklistOf(b.batchId)}`,
  ]) check(`summary line "${l.trim()}"`, lines.includes(l), mails[0]?.text);
  noPersonalData(mails, c);
  eq("worklist file written to the reports folder", listFolder("reports"), [worklistOf(b.batchId)]);
  const wl = readWorklist(worklistOf(b.batchId));
  eq("worklist: urgent first, then spreadsheet order", wl.map((r) => r["Tenant name"]), ["Ola Urgent", "Ned FailAlways", "Pip Nocontact", "Quin Sample"]);
  eq("worklist: the urgent case shows the RBIS changes already made", [wl[0]?.["Urgent"], wl[0]?.["RBIS changes already made"]], ["URGENT – RBIS partly changed", "Ended the current liability"]);
  eq("worklist: plain-English reasons", wl.map((r) => r["Reason"]), ["A person could not be added to the account", "RBIS did not respond or returned an error", "Liability started, but there were no contact details to record", "The tenancy ended because the tenant died"]);
  eq("worklist: what happened", wl.map((r) => r["What happened"]), ["Referred to staff", "Failed after 3 tries", "Updated – follow-up needed", "Referred to staff"]);
  eq("worklist: steps only shown for urgent cases", wl.slice(1).map((r) => r["RBIS changes already made"]), ["", "", ""]);

  await runNow(); // run 4
  c = await cases();
  eq("run 4: no further try once the tries have run out", byName(c, "Ned FailAlways").attempts, 3);
  eq("run 4: no second summary", (await myMails()).length, 1);
});

// ---------------------------------------------------------------------------------------------
test("t3 case key: same file twice (28), referred row reopened (29), repeated row", 170, async () => {
  const before = await latestExecutionId();
  const file = [
    HEADER,
    row({ ChangeReason: "TENANCY_START", AccountRef: "AC930001", TenantName: "Rae Sample", Address: "30 Key Street", Postcode: "EX9 3AA", StartDate: "03/11/2026", ContactEmail: "rae@example.test" }),
    row({ ChangeReason: "TENANCY_END", AccountRef: "AC930002", TenantName: "Sam ReferOnce", Address: "31 Key Street", Postcode: "EX9 3AB", EndDate: "03/11/2026" }),
    row({ ChangeReason: "TENANCY_END", AccountRef: "AC930003", TenantName: "Tia Refer", Address: "32 Key Street", Postcode: "EX9 3AC", EndDate: "03/11/2026" }),
    // The same change as row 2, written differently: same case key after tidying.
    row({ ChangeReason: " tenancy_start", AccountRef: "ac930001 ", TenantName: "Rae  Sample", Address: "30 Key Street.", Postcode: "EX9 3AA", StartDate: "2026-11-03", ContactEmail: "rae@example.test" }),
  ];
  dropFile("t3 same file.xlsx", file, { settled: true });
  await runNow();
  let c = await cases();
  let b = await batches();
  eq("first file: 3 cases; the repeated row is not recorded twice", c.length, 3);
  eq("first file: the batch row count includes every row", b[0]?.rowCount, 4);
  eq("first file: results", statusMap(c), { Rae: "updated/1", Sam: "referred/1", Tia: "referred/1" });
  const batch1 = b[0].batchId;
  let mails = await myMails();
  eq("first summary sent", mails.length, 1);
  check("first summary counts the repeated row as left alone", (mails[0]?.text || "").includes("left as they were: 1"), mails[0]?.text);

  await sleep(1200); // a different batch time
  dropFile("t3 same file.xlsx", file, { settled: true });
  const secondDrop = Date.now();
  await runNow();
  c = await cases();
  b = await batches();
  eq("second file: still 3 cases", c.length, 3);
  eq("second file: a second batch", b.map((x) => x.status), ["received", "received"]);
  const batch2 = b[1]?.batchId;
  const rae = byName(c, "Rae Sample");
  const sam = byName(c, "Sam ReferOnce");
  const tia = byName(c, "Tia Refer");
  eq("scenario 28: an updated case is skipped (batch, tries and submissions unchanged)", [rae.status, rae.batchId, rae.attempts, rae.submissions], ["updated", batch1, 1, 1]);
  eq("scenario 29: a referred case is reopened in the new batch and processed again", [sam.status, sam.batchId, sam.submissions, sam.attempts], ["updated", batch2, 2, 1]);
  eq("reopened case keeps its earlier result", JSON.parse(sam.previousResult || "{}"), { status: "referred", reasonCode: "ADDRESS_NOT_FOUND", batchId: batch1 });
  eq("reopened case was cleared before processing", [sam.reasonCode, sam.urgent], ["", false]);
  eq("a reopened case can be referred again", [tia.status, tia.batchId, tia.submissions], ["referred", batch2, 2]);
  mails = await myMails();
  eq("second summary sent", mails.length, 2);
  eq("second summary counts the reopened cases", mails[1]?.subject, `HARSLL batch ${when(batch2)} – 2 cases: 1 updated, 1 referred, 0 failed, 0 duplicate`);
  check("second summary: rows already recorded", (mails[1]?.text || "").includes("left as they were: 2"), mails[1]?.text);
  eq("both copies archived under their own batch IDs", listFolder("archive").sort(), [batch1, batch2].sort());
  const wl2 = readWorklist(worklistOf(batch2));
  eq("second worklist: the case referred again, with its earlier result", wl2.map((r) => [r["Tenant name"], r["Earlier result (row sent before)"]]), [["Tia Refer", "referred – The account could not be found in RBIS"]]);
  await waitOutTriggerRuns(secondDrop);
  eq("any file-trigger runs that followed found nothing new", [(await cases()).length, (await batches()).length, (await myMails()).length], [3, 2, 2]);
});

// ---------------------------------------------------------------------------------------------
test("t4 rejected files (30, 31) and unsafe name (32)", 120, async () => {
  const before = await latestExecutionId();
  const valid = row({ ChangeReason: "TENANCY_END", AccountRef: "AC940001", TenantName: "Zed Sample", Address: "40 Reject Road", Postcode: "EX9 4AA", EndDate: "04/11/2026" });
  const noPostcode = HEADER.filter((h) => h !== "Postcode");
  dropFile("t4 missing column.xlsx", [noPostcode, valid.filter((_, i) => HEADER[i] !== "Postcode")], { settled: true });
  dropFile("t4 header only.xlsx", [HEADER], { settled: true });
  const broken = join(folder("input"), "t4 broken.xlsx");
  writeFileSync(broken, xlsxBuffer([HEADER, valid]).subarray(0, 700)); // a cut-off copy: not a readable zip
  utimesSync(broken, new Date(Date.now() - 300000), new Date(Date.now() - 300000));
  const unsafe = "t4 bad';touch PWNED-TRACKB;'.xlsx";
  dropFile(unsafe, [HEADER, valid], { settled: true });
  const dropped = Date.now();

  await runNow(); // run 1
  let b = await batches();
  const of = (name) => b.filter((x) => x.fileName === name).map((x) => [x.status, x.readAttempts]);
  eq("missing column: rejected at once", of("t4 missing column.xlsx"), [["rejected", 0]]);
  eq("header only (no rows): rejected at once", of("t4 header only.xlsx"), [["rejected", 0]]);
  eq("cannot be read: unreadable, 1 try", of("t4 broken.xlsx"), [["unreadable", 1]]);
  eq("unsafe name: needs_rename", of(unsafe), [["needs_rename", 0]]);
  eq("input folder: unreadable and unsafe files left in place", listFolder("input").sort(), ["t4 broken.xlsx", unsafe].sort());
  const rejected = listFolder("rejected");
  check("rejected folder: both wrong-layout files, as <yyyy-MM-ddTHH-mm-ss>_<name>", rejected.length === 2 && rejected.some((f) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_t4 missing column\.xlsx$/.test(f)) && rejected.some((f) => /_t4 header only\.xlsx$/.test(f)), rejected.join(", "));
  let mails = await myMails();
  const subjects = () => mails.map((m) => m.subject).sort();
  eq("run 1 emails: one rename request, two rejections", subjects(), ["HARSLL: please rename a spreadsheet", "HARSLL: spreadsheet rejected – t4 header only.xlsx", "HARSLL: spreadsheet rejected – t4 missing column.xlsx"].sort());
  const missing = mails.find((m) => m.subject.endsWith("t4 missing column.xlsx"));
  check("rejection email names the missing column", (missing?.text || "").includes("The file is missing these columns: Postcode."), missing?.text);
  const headerOnly = mails.find((m) => m.subject.endsWith("t4 header only.xlsx"));
  check("rejection email says there are no rows", (headerOnly?.text || "").includes("no rows of changes"), headerOnly?.text);
  check("rename email gives the allowed characters", (mails.find((m) => m.subject.includes("rename"))?.text || "").includes("_ - . ( )"));

  await runNow(); // run 2
  b = await batches();
  eq("run 2: unreadable, 2 tries, still in input", [of("t4 broken.xlsx"), listFolder("input").includes("t4 broken.xlsx")], [[["unreadable", 2]], true]);
  eq("run 2: no new email", (await myMails()).length, 3);

  await runNow(); // run 3
  b = await batches();
  eq("run 3: rejected after 3 tries (scenario 31)", of("t4 broken.xlsx"), [["rejected", 3]]);
  eq("run 3: only the unsafe file is left in input", listFolder("input"), [unsafe]);
  check("run 3: the unreadable file is in the rejected folder", listFolder("rejected").some((f) => f.endsWith("_t4 broken.xlsx")));
  mails = await myMails();
  const brokenMails = mails.filter((m) => m.subject === "HARSLL: spreadsheet rejected – t4 broken.xlsx");
  eq("one rejection email for the unreadable file", brokenMails.length, 1);
  check("it says it could not be read on 3 runs", (brokenMails[0]?.text || "").includes("could not be opened as a spreadsheet on 3 runs"), brokenMails[0]?.text);

  await waitOutTriggerRuns(dropped); // any file-trigger runs, a minute after the drops
  mails = await myMails();
  eq("scenario 32: still exactly one rename email after further runs", mails.filter((m) => m.subject.includes("rename")).length, 1);
  eq("scenario 32: one batch row for the unsafe file", (await batches()).filter((x) => x.fileName === unsafe).length, 1);
  eq("unsafe file still in place", listFolder("input"), [unsafe]);
  eq("no cases recorded from bad files", (await cases()).length, 0);
  const found = dockerFind("PWNED-TRACKB");
  if (found === null) check("no injected command ran (docker not available: checked folders only)", !listFolder("input").includes("PWNED-TRACKB"));
  else eq("no injected command ran (searched the n8n container for PWNED-TRACKB)", found, "");
  noPersonalData(mails, [{ tenantName: "Zed Sample", address: "40 Reject Road", accountRef: "AC940001", postcode: "EX9 4AA" }]);
});

// ---------------------------------------------------------------------------------------------
test("t5 file still being copied; Excel temporary file (33)", 150, async () => {
  const before = await latestExecutionId();
  dropFile("t5 just arrived.xlsx", [HEADER, row({ ChangeReason: "TENANCY_END", AccountRef: "AC950001", TenantName: "Uma Sample", Address: "50 Fresh Street", Postcode: "EX9 5AA", EndDate: "05/11/2026" })]);
  const temp = join(folder("input"), "~$t5 just arrived.xlsx");
  writeFileSync(temp, Buffer.from("owner file written by Excel"));
  utimesSync(temp, new Date(Date.now() - 300000), new Date(Date.now() - 300000));
  const r = await runNow();
  const d = await executionNodes(r.exec.id);
  check("Run now within the minute: the run listed no files", d.runs["Any files to take in?"] === 1 && !d.runs["Note file details"], JSON.stringify(d.runs));
  eq("nothing recorded yet", (await batches()).length, 0);
  eq("both files still in input", listFolder("input").sort(), ["t5 just arrived.xlsx", "~$t5 just arrived.xlsx"].sort());
  await waitForTriggerRuns(before, 1);
  await waitForIdle();
  const b = await batches();
  eq("after a minute: the file was read; the temporary file was not", b.map((x) => [x.fileName, x.status]), [["t5 just arrived.xlsx", "received"]]);
  eq("temporary file left alone", listFolder("input"), ["~$t5 just arrived.xlsx"]);
  const mails = await myMails();
  eq("only the summary email (no warning about the temporary file)", mails.map((m) => m.subject.startsWith("HARSLL batch")), [true]);
  eq("case processed", statusMap(await cases()), { Uma: "updated/1" });
});

// ---------------------------------------------------------------------------------------------
test("t6 two files dropped together, names with brackets (34)", 170, async () => {
  const before = await latestExecutionId();
  dropFile("t6 together (1).xlsx", [
    HEADER,
    row({ ChangeReason: "TENANCY_END", AccountRef: "AC960001", TenantName: "Vic Leaving", Address: "60 Pair Street", Postcode: "EX9 6AA", EndDate: "05/11/2026" }),
    row({ ChangeReason: "TENANCY_START", AccountRef: "AC960002", TenantName: "Wyn Arriving", Address: "61 Pair Street", Postcode: "EX9 6AB", StartDate: "05/11/2026", ContactEmail: "wyn@example.test" }),
  ]);
  dropFile("t6 together (2).xlsx", [
    HEADER,
    row({ ChangeReason: "TENANCY_START", AccountRef: "AC960001", TenantName: "Xan Arriving", Address: "60 Pair Street", Postcode: "EX9 6AA", StartDate: "05/11/2026", ContactEmail: "xan@example.test" }),
    row({ ChangeReason: "TENANCY_END", AccountRef: "AC960003", TenantName: "Yas Leaving", Address: "62 Pair Street", Postcode: "EX9 6AC", EndDate: "04/11/2026" }),
  ]);
  const runs = await waitForTriggerRuns(before, 2);
  await waitForIdle();
  const details = await Promise.all(runs.map((r) => executionNodes(r.id)));
  const intake = details.filter((d) => d.runs["Note file details"]);
  eq("one run took in both files", intake.map((d) => d.runs["Note file details"]), [2]);
  check("the other run ended at the lock or found nothing to do", details.some((d) => d.runs["End: another run has the lock"] || (d.runs["Any files to take in?"] && !d.runs["Note file details"])), JSON.stringify(details.map((d) => Object.keys(d.runs).length)));
  const c = await cases();
  eq("four cases, each processed once", statusMap(c), { Vic: "updated/1", Wyn: "updated/1", Xan: "updated/1", Yas: "updated/1" });
  check("across files: the move-out (file 1) ran before the move-in at the same account (file 2)", byName(c, "Vic Leaving").lastAttemptAt < byName(c, "Xan Arriving").lastAttemptAt);
  const perf = await executionsAfter(CFG.performerId, before);
  eq("the Performer ran exactly four times", perf.length, 4);
  eq("two batches received", (await batches()).map((x) => x.status), ["received", "received"]);
  eq("two summaries", (await myMails()).length, 2);
  eq("both archived", listFolder("archive").length, 2);
});

// ---------------------------------------------------------------------------------------------
test("t7 two Run now calls at the same moment (35), three rounds", 120, async () => {
  const rounds = [];
  for (let round = 1; round <= 3; round++) {
    if (round > 1) await resetAll();
    const batchId = `2026-11-18T00-00-0${round}_seeded race.xlsx`;
    await insertRows(CFG.batchesTable, [{ batchId, fileName: "seeded race.xlsx", status: "received", readAttempts: 0, rowCount: 6, receivedAt: new Date().toISOString() }]);
    await insertRows(CFG.casesTable, Array.from({ length: 6 }, (_, i) => seededCase({ batchId, rowNumber: i + 2, accountRef: `AC97000${i}`, tenantName: `Race${i} Person` })));
    const before = await latestExecutionId();
    const answers = await Promise.all([1, 2].map(() => fetch(`${CFG.n8n}/webhook/harsll-run-now`, { method: "POST" }).then((r) => r.json())));
    const execs = await waitUntil(async () => {
      const list = (await executionsAfter(CFG.dispatcherId, before)).filter((e) => e.mode === "webhook");
      return list.length >= 2 && list.every((e) => e.stoppedAt) ? list : null;
    }, 120000, "both Run now executions");
    const d = await Promise.all(execs.map((e) => executionNodes(e.id)));
    const c = await cases();
    const perf = await executionsAfter(CFG.performerId, before);
    rounds.push({
      answers: answers.every((a) => a.started === true),
      tookLock: d.filter((x) => x.runs["List settled spreadsheets"]).length,
      refused: d.filter((x) => x.runs["End: another run has the lock"]).length,
      attempts: c.map((x) => x.attempts),
      statuses: [...new Set(c.map((x) => x.status))],
      performerRuns: perf.length,
      mails: (await myMails()).length,
    });
  }
  log("   rounds:", JSON.stringify(rounds));
  check("both calls answered {started: true} in every round", rounds.every((r) => r.answers));
  check("every round: one run took the lock, the other ended at once", rounds.every((r) => r.tookLock === 1 && r.refused === 1), JSON.stringify(rounds));
  check("every round: each case was tried exactly once", rounds.every((r) => r.attempts.length === 6 && r.attempts.every((a) => a === 1)));
  check("every round: all six cases updated", rounds.every((r) => r.statuses.join() === "updated"));
  check("every round: the Performer ran exactly six times", rounds.every((r) => r.performerRuns === 6));
  check("every round: one summary", rounds.every((r) => r.mails === 1));
});

// ---------------------------------------------------------------------------------------------
test("t8 lock held, stale lock, stuck cases, crash and retry", 150, async () => {
  // a) a fresh lock held by another run
  await insertRows(CFG.casesTable, [seededCase({ accountRef: "AC980010", tenantName: "Abe Waiting" })]);
  await setLock("other-run", minutesAgo(5));
  let r = await runNow();
  let d = await executionNodes(r.exec.id);
  check("lock held by a live run: this run ends at once", d.runs["End: another run has the lock"] === 1 && !d.runs["List settled spreadsheets"] && !d.runs["Release the lock"], JSON.stringify(d.runs));
  eq("the case was not touched", statusMap(await cases()), { Abe: "new/0" });
  eq("the other run's lock is left alone", (await lockRow()).lockedBy, "other-run");

  // b) a stale lock
  await setLock("dead-run", minutesAgo(40));
  r = await runNow();
  d = await executionNodes(r.exec.id);
  check("stale lock (40 min) is taken over", d.runs["List settled spreadsheets"] === 1);
  eq("the case was processed", statusMap(await cases()), { Abe: "updated/1" });
  const lock = await lockRow();
  eq("lock released", [lock.lockedBy, lock.lockedAt], ["", null]);

  // c) stuck and failed cases
  await resetAll();
  const old = minutesAgo(20);
  await insertRows(CFG.casesTable, [
    seededCase({ accountRef: "AC980001", tenantName: "Ada Stuckpartial", status: "in_progress", attempts: 3, lastAttemptAt: old, stepsDone: '["endLiability"]' }),
    seededCase({ accountRef: "AC980002", tenantName: "Ben Stuckclean", status: "in_progress", attempts: 3, lastAttemptAt: old }),
    seededCase({ accountRef: "AC980003", tenantName: "Cy Stucktries", status: "in_progress", attempts: 1, lastAttemptAt: old }),
    seededCase({ accountRef: "AC980004", tenantName: "Dee Busy", status: "in_progress", attempts: 1, lastAttemptAt: minutesAgo(2), relevantDate: "2026-11-01" }),
    seededCase({ accountRef: "AC980004", tenantName: "Eli Later", relevantDate: "2026-11-02" }),
    seededCase({ accountRef: "AC980004", tenantName: "Fay Earlier", relevantDate: "2026-10-01" }),
    seededCase({ accountRef: "AC980005", tenantName: "Gus Failed", status: "failed", attempts: 3, lastAttemptAt: old }),
    seededCase({ accountRef: "AC980006", tenantName: "Hal Failedonce", status: "failed", attempts: 1, lastAttemptAt: old }),
  ]);
  const deeBefore = byName(await cases(), "Dee Busy").lastAttemptAt;
  await runNow();
  let c = await cases();
  eq("statuses after one run", statusMap(c), { Ada: "failed/3", Ben: "failed/3", Cy: "updated/2", Dee: "in_progress/1", Eli: "new/0", Fay: "updated/1", Gus: "failed/3", Hal: "updated/2" });
  const ada = byName(c, "Ada Stuckpartial");
  const ben = byName(c, "Ben Stuckclean");
  eq("stuck with no tries left: PROCESSING_STOPPED, urgent because RBIS was partly changed", [ada.reasonCode, ada.urgent, ada.reasonText], ["PROCESSING_STOPPED", true, "Processing stopped unexpectedly and the tries ran out"]);
  eq("stuck with no tries left and no RBIS change: not urgent", [ben.reasonCode, ben.urgent], ["PROCESSING_STOPPED", false]);
  check("errorDetail explains the stop", /15 minutes after 3 tries/.test(ada.errorDetail), ada.errorDetail);
  eq("a case in progress for under stuckMinutes is left alone", byName(c, "Dee Busy").lastAttemptAt, deeBefore);

  // d) a Performer that crashes every time (stand-in "Hang")
  await resetAll();
  await insertRows(CFG.casesTable, [
    seededCase({ accountRef: "AC980020", tenantName: "Ivy Hang", relevantDate: "2026-11-01" }),
    seededCase({ accountRef: "AC980020", tenantName: "Jay Waitsforivy", relevantDate: "2026-11-02" }),
  ]);
  const ageIvy = async () => updateRows(CFG.casesTable, [{ columnName: "tenantName", condition: "eq", value: "Ivy Hang" }], { lastAttemptAt: minutesAgo(20) });
  await runNow();
  eq("crash 1: left in progress; the later case for the account waits", statusMap(await cases()), { Ivy: "in_progress/1", Jay: "new/0" });
  await runNow();
  eq("not retried until stuck for stuckMinutes", statusMap(await cases()), { Ivy: "in_progress/1", Jay: "new/0" });
  await ageIvy();
  await runNow();
  eq("stuck with tries left: retried", statusMap(await cases()), { Ivy: "in_progress/2", Jay: "new/0" });
  await ageIvy();
  await runNow();
  eq("third try", statusMap(await cases()), { Ivy: "in_progress/3", Jay: "new/0" });
  await ageIvy();
  await runNow();
  c = await cases();
  eq("no tries left: closed as failed, then the waiting case runs in the same pass", statusMap(c), { Ivy: "failed/3", Jay: "updated/1" });
  eq("closed with PROCESSING_STOPPED, not urgent", [byName(c, "Ivy Hang").reasonCode, byName(c, "Ivy Hang").urgent], ["PROCESSING_STOPPED", false]);
});

// ---------------------------------------------------------------------------------------------
test("t9 dates as real Excel dates, text and day numbers (37); tidy rows", 120, async () => {
  const before = await latestExecutionId();
  const S = (AccountRef, TenantName, StartDate) => row({ ChangeReason: "TENANCY_START", AccountRef, TenantName, Address: `${AccountRef} Date Row`, Postcode: "EX9 9AA", StartDate, ContactEmail: "d@example.test" });
  dropFile("t9 date forms.xlsx", [
    HEADER,
    S("AC990001", "Date Realdate", { date: "2026-11-01" }),
    S("AC990002", "Date Withtime", { dateTime: "2026-11-01T14:30:00" }),
    S("AC990003", "Date Justbeforemidnight", { dateTime: "2026-10-31T23:59:59.9996" }),
    S("AC990004", "Date Uktext", "01/11/2026"),
    S("AC990005", "Date Shorttext", "1/11/2026"),
    S("AC990006", "Date Daynumber", 46327),
    S("AC990007", "Date Isotext", "2026-11-01"),
    S("AC990008", "Date Summer", { date: "2026-07-01" }),
    row({ ChangeReason: "TENANCY_END", AccountRef: "AC990009", TenantName: "Date Enddaynumber", Address: "AC990009 Date Row", Postcode: "EX9 9AA", EndDate: 46326 }),
    S("AC990010", "Date Impossible", "31/02/2026"),
    S("AC990011", "Date Missing", ""),
    row({ ChangeReason: "  tenancy_start ", AccountRef: " ac990012 ", TenantName: "  Flora Flatdweller ", Address: " flat 3, 7 Date Row ", Postcode: " EX9 9AB ", StartDate: "01/11/2026", ContactPhone: " 07700 900003 " }),
  ], { settled: true });
  const dropped = Date.now();
  await runNow();
  const c = await cases();
  const get = (n) => byName(c, n) || {};
  const sameDay = ["Date Realdate", "Date Withtime", "Date Justbeforemidnight", "Date Uktext", "Date Shorttext", "Date Daynumber", "Date Isotext"];
  eq("all forms of 1 November read as 2026-11-01", sameDay.map((n) => get(n).startDate), sameDay.map(() => "2026-11-01"));
  eq("relevant date and case key use the tidied date", sameDay.map((n) => [get(n).relevantDate, get(n).caseKey?.endsWith("|2026-11-01")]), sameDay.map(() => ["2026-11-01", true]));
  eq("summer date is not shifted by British Summer Time", get("Date Summer").startDate, "2026-07-01");
  eq("Excel day number as an end date", [get("Date Enddaynumber").endDate, get("Date Enddaynumber").relevantDate], ["2026-10-31", "2026-10-31"]);
  eq("impossible date kept as written (so check 1 can refer it)", [get("Date Impossible").startDate, get("Date Impossible").status, get("Date Impossible").reasonCode], ["31/02/2026", "referred", "DATES_INVALID"]);
  eq("missing date is empty", [get("Date Missing").startDate, get("Date Missing").status], ["", "referred"]);
  const f = c.find((x) => x.accountRef === "AC990012") || {};
  eq("text trimmed; change reason and account ref upper-cased", [f.changeReason, f.accountRef, f.tenantName, f.address, f.postcode, f.contactPhone], ["TENANCY_START", "AC990012", "Flora Flatdweller", "flat 3, 7 Date Row", "EX9 9AB", "07700 900003"]);
  eq("isFlat from an address starting with 'flat'", [f.isFlat, get("Date Realdate").isFlat], [true, false]);
  eq("case key uses normalise()", f.caseKey, "TENANCY_START|AC990012|flat 3 7 date row|flora flatdweller|2026-11-01");
  eq("row numbers follow the spreadsheet (header is row 1)", c.map((x) => x.rowNumber), Array.from({ length: 12 }, (_, i) => i + 2));
  eq("optional columns read; empty ones are empty text", [get("Date Realdate").forwardingAddress, get("Date Realdate").sourceSystem, get("Date Realdate").contactEmail], ["", "", "d@example.test"]);
  await waitOutTriggerRuns(dropped);
});

// ---------------------------------------------------------------------------------------------
test("t10 file arrives while the Dispatcher is switched off (36, approximated)", 200, async () => {
  const before = await latestExecutionId();
  await api("POST", `/workflows/${CFG.dispatcherId}/deactivate`);
  try {
    dropFile("t10 while off.xlsx", [HEADER, row({ ChangeReason: "TENANCY_END", AccountRef: "AC900101", TenantName: "Oli Offline", Address: "70 Quiet Street", Postcode: "EX9 7AA", EndDate: "06/11/2026" })], { settled: true });
    await sleep(8000);
    eq("nothing runs while switched off", (await executionsAfter(CFG.dispatcherId, before)).length, 0);
  } finally {
    await api("POST", `/workflows/${CFG.dispatcherId}/activate`);
  }
  const wf = await api("GET", `/workflows/${CFG.dispatcherId}`);
  check("Dispatcher published again, current version", wf.active === true && wf.versionId === wf.activeVersionId, `${wf.active} ${wf.versionId} ${wf.activeVersionId}`);
  // On start the file trigger reports files already in the folder; the 15-minute timer is the backstop.
  const exec = await waitUntil(async () => {
    const list = (await executionsAfter(CFG.dispatcherId, before)).filter((e) => e.stoppedAt);
    for (const e of list) {
      const d = await executionNodes(e.id);
      if (d.runs["Note file details"]) return { e, d };
    }
    return null;
  }, 17 * 60000, "a run that picks up the file");
  log(`   picked up by: ${exec.d.runs["File added to input folder"] ? "the file trigger on start" : exec.d.runs["Every 15 minutes"] ? "the 15-minute timer" : exec.e.mode}`);
  eq("the file was processed after the restart", [(await batches()).map((x) => x.status), statusMap(await cases())], [["received"], { Oli: "updated/1" }]);
  await waitForIdle();
});

async function timerRunsAfter(afterId) {
  const out = [];
  for (const e of (await executionsAfter(CFG.dispatcherId, afterId)).filter((x) => x.mode === "trigger")) {
    if ((await executionNodes(e.id)).runs["Every 15 minutes"]) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const t of TESTS) log(t.name);
    return;
  }
  const only = args.filter((a) => !a.startsWith("--"));
  // t10 can wait up to 15 minutes for the timer, so it runs only when named or with --with-restart.
  const chosen = TESTS.filter((t) =>
    only.length ? only.some((o) => t.name.split(" ")[0] === o) : !t.name.startsWith("t10 ") || args.includes("--with-restart"));
  const started = Date.now();
  const firstExec = await latestExecutionId();
  // The 15-minute timer can start a Dispatcher run in the middle of a test and move cases on by
  // one extra step. If a test fails and a timer run overlapped it, the test is run once more.
  for (const t of chosen) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      startTest(attempt === 1 ? t.name : `${t.name} (run again: the timer started a run during the first try)`);
      const mark = results.length;
      await waitForIdle();
      const startId = await latestExecutionId();
      try {
        await resetAll();
        await t.fn();
      } catch (e) {
        check("test ran to the end", false, e.message);
      }
      const failed = results.slice(mark).some((r) => !r.ok);
      if (failed && attempt === 1 && (await timerRunsAfter(startId)).length) {
        log("   the timer ran during this test; discarding this try and running it again");
        results.splice(mark);
        continue;
      }
      break;
    }
  }
  await waitForIdle();
  const timerRuns = (await timerRunsAfter(firstExec)).map((e) => e.startedAt);
  log(`\nTimer (every 15 minutes) runs seen during the suite: ${timerRuns.length ? timerRuns.join(", ") : "none"}`);

  const byTest = {};
  for (const r of results) {
    byTest[r.test] ??= { pass: 0, fail: 0 };
    byTest[r.test][r.ok ? "pass" : "fail"]++;
  }
  log("\n================ Summary ================");
  for (const [name, v] of Object.entries(byTest)) log(`${v.fail ? "FAIL" : "PASS"}  ${name}  (${v.pass} passed, ${v.fail} failed)`);
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  log(`\n${pass} checks passed, ${fail} failed, in ${chosen.length} tests (${Math.round((Date.now() - started) / 1000)} s).`);
  if (fail) {
    log("\nFailed checks:");
    for (const r of results.filter((x) => !x.ok)) log(` - [${r.test}] ${r.name}: ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});

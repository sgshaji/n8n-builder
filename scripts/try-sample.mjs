// Try HARSLL with a small sample spreadsheet of made-up tenancy changes, on the local stack.
//
//   node scripts/try-sample.mjs              reset the local test data, run the sample, show what happened
//   node scripts/try-sample.mjs --yes        the same, without asking first
//   node scripts/try-sample.mjs --write-file only (re)write test-data/sample/harsll-sample.xlsx
//
// The sample's 10 rows come from the test scenarios (test-data/scenarios.json), so every outcome is
// known in advance and the script can say whether HARSLL got it right. Made-up data only.
// Plain Node.js, no packages. Guide: docs/guides/try-harsll-with-sample-data.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { readEnv, repoRoot } from "./lib/env.mjs";
import { loadScenarios } from "./lib/scenario-kit.mjs";
import { buildXlsx } from "./lib/xlsx.mjs";
import { PROFILES, makeClients, resetEverything, dispatcherBusy, worklistNameFor } from "./run-tests.mjs";

export const SAMPLE_FILE = "harsll-sample.xlsx";
export const SAMPLE_PATH = join(repoRoot, "test-data", "sample", SAMPLE_FILE);
// Scenarios whose rows make up the sample: a mix of updates and referrals, none needing special set-up.
export const SAMPLE_SCENARIOS = [1, 2, 4, 7, 10, 13, 15, 20];

const OUTCOME = {
  updated: "Account updated",
  referred: "Referred to staff",
  duplicate: "Covered by another row",
  failed: "Technical failure",
  new: "Not processed yet",
  in_progress: "Still being processed",
};
const CHANGE = { TENANCY_START: "Moved in", TENANCY_END: "Moved out", DECEASED: "Died" };

/** The sample rows, in file order, with what each is expected to end as. */
export function sampleRows(data = loadScenarios(repoRoot)) {
  const rows = [];
  for (const id of SAMPLE_SCENARIOS) {
    const s = data.scenarios.find((x) => x.id === id);
    if (!s) throw new Error(`scenario ${id} not found`);
    for (const r of s.rows) rows.push({ scenario: s.id, scenarioTitle: s.title, id: r.id, cells: r.cells, expect: r.expect });
  }
  return rows;
}

/** The sample spreadsheet, built the same way as the test spreadsheets. */
export function buildSample(data = loadScenarios(repoRoot)) {
  const header = data.columns;
  return buildXlsx({ header, rows: sampleRows(data).map((r) => header.map((c) => r.cells[c] ?? "")), sheetName: "Changes" });
}

const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One plain-English line per case, in spreadsheet order. */
export function describeResults(rows, cases, reasonTexts) {
  const byName = new Map(cases.map((c) => [String(c.tenantName).trim().toLowerCase(), c]));
  const lines = [];
  let matched = 0;
  for (const r of rows) {
    const c = byName.get(String(r.cells.TenantName).trim().toLowerCase());
    const date = c ? (c.changeReason === "TENANCY_START" ? c.startDate : c.endDate) : "";
    const outcome = c ? OUTCOME[c.status] ?? c.status : "No case recorded";
    const why = c?.reasonCode ? (c.reasonText || reasonTexts[c.reasonCode] || c.reasonCode) : c?.outcome ? `RBIS: ${c.outcome}` : "";
    const ok = c && c.status === r.expect.status && (c.reasonCode ?? "") === (r.expect.reasonCode ?? "");
    if (ok) matched++;
    lines.push(`  ${ok ? "✓" : "✗"} ${pad(r.cells.TenantName, 13)} ${pad(`${CHANGE[r.cells.ChangeReason] ?? r.cells.ChangeReason} ${date || ""}`, 22)} ${pad(outcome, 24)} ${why}${c?.urgent ? "  [URGENT]" : ""}`);
  }
  return { lines, matched, total: rows.length };
}

async function confirm() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("This clears the LOCAL HARSLL test data (Cases and Batches tables, data/ folders, test mailbox)\nand resets the pretend RBIS. Carry on? [y/N] ");
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const args = process.argv.slice(2);
  const data = loadScenarios(repoRoot);
  const xlsx = buildSample(data);
  mkdirSync(join(repoRoot, "test-data", "sample"), { recursive: true });
  if (!existsSync(SAMPLE_PATH) || !readFileSync(SAMPLE_PATH).equals(xlsx)) writeFileSync(SAMPLE_PATH, xlsx);
  if (args.includes("--write-file")) {
    console.log(`Wrote test-data/sample/${SAMPLE_FILE} (${sampleRows(data).length} rows).`);
    return;
  }

  const env = readEnv();
  if (!env.N8N_API_KEY) throw new Error("N8N_API_KEY is missing or empty in .env. See docs/setup/02-connect-mcp-servers.md, step 1.");
  const profile = { ...PROFILES.production, checkEmails: false };
  const c = makeClients(profile, env.N8N_API_KEY);
  const ctx = { profile, c, log: () => {} };
  try {
    await c.rbis.health();
    profile.tables = await c.n8n.findTables(profile.tableNames);
    ctx.dispatcherId = await c.n8n.findWorkflowId(profile.dispatcherName);
  } catch (err) {
    throw new Error(`The local stack is not ready: ${err.message}\nStart it with: docker compose up -d --wait. Set HARSLL up with: node scripts/setup-harsll.mjs`);
  }
  if (!ctx.dispatcherId) throw new Error(`No workflow named "${profile.dispatcherName}". Set HARSLL up with: node scripts/setup-harsll.mjs`);
  if ((await dispatcherBusy(ctx)).busy) throw new Error("The Dispatcher is busy right now. Try again in a minute.");
  if (!args.includes("--yes") && !(await confirm())) {
    console.log("Nothing changed.");
    return;
  }

  console.log("\n1. Resetting the local test data and the pretend RBIS ...");
  await resetEverything(ctx);

  console.log(`2. Putting ${SAMPLE_FILE} (${sampleRows(data).length} made-up rows) into data/input ...`);
  writeFileSync(join(profile.folders.input, SAMPLE_FILE), xlsx);

  console.log("3. Waiting for HARSLL. It waits a minute so a file is never read while still being copied,");
  console.log("   then records the cases, archives the file, checks each case and sends the summary. About 2 minutes.");
  const t0 = Date.now();
  let lastNote = 0;
  for (;;) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const inInput = c.folders.list("input").includes(SAMPLE_FILE);
    const batch = (await c.n8n.listRows(profile.tables.batches)).find((b) => b.fileName === SAMPLE_FILE);
    const busy = (await dispatcherBusy(ctx)).busy;
    if (!inInput && batch?.summarySentAt && !busy) break;
    if (elapsed > 420) throw new Error("HARSLL did not finish within 7 minutes. In n8n, open Executions to see whether the Dispatcher ran or failed.");
    if (Date.now() - lastNote > 20_000) {
      lastNote = Date.now();
      const stage = inInput ? (busy ? "letting the file settle" : "waiting for the file to be noticed") : !batch ? "reading the file" : "checking the cases";
      console.log(`   ... ${elapsed}s: ${stage}`);
    }
    await sleep(3000);
  }
  console.log(`   Done in ${Math.round((Date.now() - t0) / 1000)} seconds.\n`);

  const cases = await c.n8n.listRows(profile.tables.cases);
  const batch = (await c.n8n.listRows(profile.tables.batches)).find((b) => b.fileName === SAMPLE_FILE);
  const changes = await c.rbis.changes();
  const result = describeResults(sampleRows(data), cases, data.reasonTexts);
  console.log("What happened to each row (✓ = the outcome the design expects):\n");
  console.log(`    ${pad("Person", 13)} ${pad("Change", 22)} ${pad("Outcome", 24)} Why`);
  for (const l of result.lines) console.log(l);
  const accounts = new Set(changes.map((x) => x.ref));
  console.log(`\n${result.matched} of ${result.total} rows ended as expected. The pretend RBIS recorded ${changes.length} changes to ${accounts.size} accounts.`);
  console.log("\nWhere to look:");
  console.log("  Summary email (counts only)  http://localhost:8025");
  console.log(`  Staff worklist               data/reports/${worklistNameFor(batch.batchId)}`);
  console.log(`  The spreadsheet, archived    data/archive/${batch.batchId}`);
  console.log("  Every case, in full          n8n > Overview > Data tables > harsll_cases");
  console.log("  Changes made to RBIS         http://localhost:8088/changes");
  console.log("\nTry next: copy test-data/sample/harsll-sample.xlsx into data/input again, without resetting.");
  console.log("Rows already done are skipped; referred rows are checked again. RBIS gets no new changes.");
  console.log("More to try: docs/guides/try-harsll-with-sample-data.md");
  process.exit(result.matched === result.total ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(2);
  });
}

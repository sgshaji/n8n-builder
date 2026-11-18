#!/usr/bin/env node
// Track A tests: HARSLL – RBIS adapter and HARSLL – Performer.
//
// Runs every case against the track A copies only: the pretend RBIS "mock-rbis-a"
// (reset before each test) and the Cases table "trackA_cases" (emptied before each test).
// Calls the workflows through the track A test harness (POST /webhook/track-a-harness).
//
//   node tests/performer/run-performer-tests.mjs                 all tests
//   node tests/performer/run-performer-tests.mjs --adapter       adapter tests only
//   node tests/performer/run-performer-tests.mjs --performer     Performer tests only
//   node tests/performer/run-performer-tests.mjs --only S2       tests whose name contains "S2"
//   node tests/performer/run-performer-tests.mjs --verbose       print outputs and changes
//
// Plain Node.js (18+), no packages. Reads N8N_API_URL and N8N_API_KEY from .env.
// All data is made up (test-data/rbis-accounts.json).
import { readEnv, requireValue } from "../../scripts/lib/env.mjs";

// ---------------------------------------------------------------- configuration
const env = readEnv();
const N8N = (env.N8N_API_URL || "http://localhost:5678").replace(/\/$/, "");
const API_KEY = requireValue(env, "N8N_API_KEY", "Create one in n8n: Settings > n8n API.");

const ADAPTER_ID = process.env.TRACKA_ADAPTER_ID || "UEa9ahhsExQ8SXfb";      // HARSLL – RBIS adapter
const PERFORMER_ID = process.env.TRACKA_PERFORMER_ID || "Bxb1mMwb4TOFuP8j";  // HARSLL – Performer
const HARNESS_URL = `${N8N}/webhook/track-a-harness`;                         // Track A – test harness
const CASES_TABLE = "A0QezsR9YWAsD6Z9";                                       // trackA_cases
const RBIS = "http://localhost:8089";                                          // mock-rbis-a, from this machine
const RBIS_FROM_N8N = "http://mock-rbis-a:8080";                               // mock-rbis-a, from n8n

// Production settings (docs/design/interfaces.md), with the track A overrides.
const BASE_SETTINGS = {
  profile: "trackA",
  landlordNames: ["Example Housing Association"],
  landlordLiabilityEndsOn: "startDate",
  landlordLiableFrom: "endDate",
  confirmLeaverIsLiable: true,
  jointTenantHandling: "leadRowAddsAll",
  addPersonToExistingTenancy: false,
  requiredSourceSystem: "ABRITAS",
  allowedChangeReasons: ["TENANCY_START", "TENANCY_END"],
  deathHandling: "refer",
  deathChangeReasons: ["DECEASED"],
  nameMatch: "normalised",
  requiredColumns: ["ChangeReason", "AccountRef", "TenantName", "Address", "Postcode", "StartDate", "EndDate"],
  optionalColumns: ["ForwardingAddress", "ContactEmail", "ContactPhone", "SourceSystem"],
  maxAttempts: 3,
  stuckMinutes: 15,
  lockStaleMinutes: 30,
  fileSettleSeconds: 60,
  maxFileReadAttempts: 3,
  summaryEmailTo: "harsll-team@example.test",
  summaryEmailFrom: "harsll@example.test",
  inputFolder: "/files/input",
  archiveFolder: "/files/archive",
  rejectedFolder: "/files/rejected",
  reportsFolder: "/files/reports",
  rbisBaseUrl: RBIS_FROM_N8N,
  casesTableId: CASES_TABLE,
  batchesTableId: "",
  lockTableId: "",
  performerWorkflowId: PERFORMER_ID,
  adapterWorkflowId: ADAPTER_ID,
};
const settings = (overrides = {}) => ({ ...BASE_SETTINGS, ...overrides });

// Exact texts from the design's reason-code table.
const TEXTS = {
  DATES_INVALID: "The dates on the spreadsheet row are wrong or missing",
  DEATH_REFERRED: "The tenancy ended because the tenant died; these are passed to staff",
  CHANGE_REASON_NOT_VALID: "The reason for the change is not one the automation handles",
  SAME_TENANCY_AS_EARLIER_ROW: "Covered by an earlier row for the same tenancy",
  EARLIER_ROW_NOT_COMPLETED: "The earlier row for this tenancy was not completed, so this person was not added",
  NO_ACCOUNT_REF: "The row has no account reference",
  ADDRESS_NOT_FOUND: "The account could not be found in RBIS",
  NO_START_DATE: "RBIS has no start date to compare against",
  CHECK_DATES: "The dates in RBIS do not match the spreadsheet",
  ACCOUNT_ALREADY_PROCESSED: "RBIS already shows this change",
  LEAVER_NOT_LIABLE: "The person leaving is not the liable person in RBIS",
  NO_OPTION_TO_TERMINATE: "RBIS does not allow the current liability to be ended",
  UNABLE_TO_ADD_PARTY: "A person could not be added to the account",
  NO_CONTACT_DETAILS: "Liability started, but there were no contact details to record",
  RBIS_ERROR: "RBIS did not respond or returned an error",
};

const LANDLORD = "Example Housing Association";
const LANDLORD_STEP = "addLiableParty:example housing association";

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const GROUPS = ["--adapter", "--performer"].filter((g) => args.includes(g)).map((g) => g.slice(2));

// ---------------------------------------------------------------- helpers
export const normalise = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function http(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", accept: "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function n8nApi(method, path, body) {
  const r = await http(method, `${N8N}/api/v1${path}`, body, { "X-N8N-API-KEY": API_KEY });
  if (r.status >= 300) throw new Error(`n8n API ${method} ${path} -> ${r.status}: ${JSON.stringify(r.data).slice(0, 400)}`);
  return r.data;
}

// Pretend RBIS (track A copy)
const rbis = {
  reset: async () => { const r = await http("POST", `${RBIS}/reset`); if (r.status !== 200) throw new Error("mock-rbis-a reset failed"); },
  outage: async (cfg) => { const r = await http("POST", `${RBIS}/simulate-outage`, cfg); if (r.status !== 200) throw new Error(`outage refused: ${JSON.stringify(r.data)}`); },
  changes: async () => (await http("GET", `${RBIS}/changes`)).data,
  account: async (ref) => (await http("GET", `${RBIS}/accounts/${encodeURIComponent(ref)}`)).data,
};

// Cases table (trackA_cases)
const cases = {
  clear: () => n8nApi("DELETE", `/data-tables/${CASES_TABLE}/rows/clear`),
  insert: async (row) => (await n8nApi("POST", `/data-tables/${CASES_TABLE}/rows`, { data: [row], returnType: "all" }))[0],
  get: async (id) => {
    const filter = JSON.stringify({ type: "and", filters: [{ columnName: "id", condition: "eq", value: id }] });
    const r = await n8nApi("GET", `/data-tables/${CASES_TABLE}/rows?filter=${encodeURIComponent(filter)}`);
    return r.data[0] ?? null;
  },
  update: async (id, data) => {
    const filter = { type: "and", filters: [{ columnName: "id", condition: "eq", value: id }] };
    return n8nApi("PATCH", `/data-tables/${CASES_TABLE}/rows/update`, { filter, data });
  },
};

// Calls a workflow through the harness. Returns the list of output items.
async function harness(workflowId, input) {
  const r = await http("POST", HARNESS_URL, { workflowId, input });
  if (r.status !== 200) throw new Error(`harness answered ${r.status}: ${JSON.stringify(r.data).slice(0, 400)}`);
  return Array.isArray(r.data) ? r.data : [r.data];
}

const adapter = async (operation, ref, params = {}, rbisBaseUrl = RBIS_FROM_N8N) => {
  const out = await harness(ADAPTER_ID, { operation, rbisBaseUrl, ref, params });
  return out;
};

// A case row as the Dispatcher would write it (interfaces.md, "Cases table columns" and "Keys").
function caseRow(o) {
  const changeReason = String(o.changeReason).trim().toUpperCase();
  const accountRef = String(o.accountRef ?? "").trim().toUpperCase();
  const startDate = o.startDate ?? "";
  const endDate = o.endDate ?? "";
  const relevantDate = changeReason === "TENANCY_START" ? startDate : endDate;
  const address = o.address;
  return {
    caseKey: [changeReason, accountRef, normalise(address), normalise(o.tenantName), relevantDate].join("|"),
    tenancyKey: [changeReason, accountRef, normalise(address), relevantDate].join("|"),
    batchId: "2026-11-19T09-00-00_track-a-test.xlsx",
    rowNumber: o.rowNumber ?? 2,
    changeReason, accountRef, address, postcode: o.postcode,
    isFlat: /^flat\b/i.test(address.trim()),
    tenantName: o.tenantName,
    isLeadRow: o.isLeadRow ?? true,
    jointTenants: o.jointTenants ?? "[]",
    coveredByCaseKey: o.coveredByCaseKey ?? "",
    startDate, endDate, relevantDate,
    forwardingAddress: o.forwardingAddress ?? "", contactEmail: o.contactEmail ?? "", contactPhone: o.contactPhone ?? "",
    sourceSystem: o.sourceSystem ?? "",
    status: o.status ?? "new", reasonCode: "", reasonText: "", outcome: "", urgent: false,
    stepsDone: o.stepsDone ?? "[]", attempts: o.attempts ?? 0, submissions: 1, previousResult: "", errorDetail: "",
  };
}

// Rows of one tenancy group: the first is the lead row and carries the others' details.
function tenancyGroup(common, people) {
  const rows = people.map((p, i) => caseRow({ ...common, ...p, rowNumber: (common.rowNumber ?? 2) + i }));
  const lead = rows[0];
  lead.jointTenants = JSON.stringify(people.slice(1).map((p) => ({ name: p.tenantName, email: p.contactEmail ?? "", phone: p.contactPhone ?? "" })));
  for (const r of rows.slice(1)) {
    r.isLeadRow = false;
    r.jointTenants = "";
    r.coveredByCaseKey = lead.caseKey;
  }
  return rows;
}

async function perform(id, { expectedStatus = "new", expectedAttempts = 0, s = settings() } = {}) {
  return harness(PERFORMER_ID, { caseId: id, expectedStatus, expectedAttempts, settings: s });
}

// ---------------------------------------------------------------- test runner
const tests = [];
const test = (group, name, fn) => tests.push({ group, name, fn });

class Checks {
  constructor() { this.failures = []; this.count = 0; }
  ok(cond, message) { this.count++; if (!cond) this.failures.push(message); }
  eq(actual, expected, label) {
    this.count++;
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) this.failures.push(`${label}: expected ${e}, got ${a}`);
  }
  // Case row after the Performer.
  caseIs(row, exp) {
    if (!row) return this.ok(false, "case row missing");
    for (const [k, v] of Object.entries(exp)) {
      if (k === "stepsDone") this.eq(JSON.parse(row.stepsDone || "[]"), v, "row.stepsDone");
      else if (k === "errorDetail" && v instanceof RegExp) this.ok(v.test(row.errorDetail), `row.errorDetail ${JSON.stringify(row.errorDetail)} should match ${v}`);
      else this.eq(row[k], v, `row.${k}`);
    }
    if ("reasonCode" in exp) this.eq(row.reasonText, exp.reasonCode ? TEXTS[exp.reasonCode] : "", "row.reasonText");
  }
  // The Performer's single output item.
  outputIs(out, row, exp) {
    this.eq(out.length, 1, "number of output items");
    const o = out[0] ?? {};
    this.eq(Object.keys(o).sort(), ["caseId", "caseKey", "claimed", "outcome", "reasonCode", "status", "urgent"], "output keys");
    this.eq(o.caseId, row.id, "output.caseId");
    this.eq(o.caseKey, row.caseKey, "output.caseKey");
    for (const [k, v] of Object.entries(exp)) this.eq(o[k], v, `output.${k}`);
  }
  // The adapter's single output item.
  adapterIs(out, exp) {
    this.eq(out.length, 1, "number of adapter output items");
    const o = out[0] ?? {};
    this.eq(Object.keys(o).sort(), ["alreadyDone", "data", "error", "ok", "operation", "ref"], "adapter output keys");
    for (const [k, v] of Object.entries(exp)) {
      if (k === "error" && v && typeof v === "object") for (const [ek, ev] of Object.entries(v)) this.eq(o.error?.[ek], ev, `error.${ek}`);
      else if (k === "data" && v && typeof v === "object") for (const [dk, dv] of Object.entries(v)) this.eq(o.data?.[dk], dv, `data.${dk}`);
      else this.eq(o[k], v, k);
    }
    return o;
  }
  // RBIS change log: list of [operation, partial fields].
  changesAre(changes, expected) {
    this.eq(changes.map((c) => c.operation), expected.map(([op]) => op), "RBIS changes (operations)");
    expected.forEach(([, fields], i) => {
      if (!fields || !changes[i]) return;
      for (const [k, v] of Object.entries(fields)) this.eq(changes[i][k], v, `change ${i + 1} (${changes[i].operation}).${k}`);
    });
  }
}

// One Performer run with the usual checks.
async function runCase(t, row, { expectRow, expectOut, ...opts }) {
  const out = await perform(row.id, opts);
  const after = await cases.get(row.id);
  if (VERBOSE) console.log("    output:", JSON.stringify(out), "\n    row:", JSON.stringify(after));
  // The output must match the row as written, and the row must match what is expected.
  const r = after ?? {};
  if (expectOut !== false) t.outputIs(out, after ?? row, { claimed: true, status: r.status, reasonCode: r.reasonCode, outcome: r.outcome, urgent: r.urgent, ...(expectOut ?? {}) });
  t.caseIs(after, expectRow);
  return { out, after };
}

const insert = (o) => cases.insert(caseRow(o));

// ================================================================ ADAPTER TESTS
const AD = "adapter";

test(AD, "A01 findAccount: found, address and postcode normalised", async (t) => {
  const out = await adapter("findAccount", "AC100001", { address: "1, EXAMPLE street ", postcode: "ex1 2ab" });
  const o = t.adapterIs(out, { ok: true, operation: "findAccount", ref: "AC100001", alreadyDone: false, error: null, data: { found: true, reason: null } });
  t.eq(o.data?.account?.ref, "AC100001", "data.account.ref");
  t.eq(o.data?.account?.current?.[0]?.party, LANDLORD, "data.account.current[0].party");
});
test(AD, "A02 findAccount: unknown reference is NOT_FOUND, not an error", async (t) => {
  t.adapterIs(await adapter("findAccount", "AC999999", { address: "x", postcode: "y" }), { ok: true, alreadyDone: false, error: null, data: { found: false, reason: "NOT_FOUND", account: null } });
});
test(AD, "A03 findAccount: address differs is ADDRESS_MISMATCH", async (t) => {
  t.adapterIs(await adapter("findAccount", "AC100013", { address: "99 Other Street", postcode: "EX1 5AF" }), { ok: true, error: null, data: { found: false, reason: "ADDRESS_MISMATCH", account: null } });
});
test(AD, "A04 findAccount: postcode differs is ADDRESS_MISMATCH", async (t) => {
  t.adapterIs(await adapter("findAccount", "AC100013", { address: "13 Example Street", postcode: "EX9 9ZZ" }), { ok: true, data: { found: false, reason: "ADDRESS_MISMATCH" } });
});
test(AD, "A05 findAccount: a wrong RBIS address (unknown path) is an error, not 'not found'", async (t) => {
  t.adapterIs(await adapter("findAccount", "AC100001", { address: "1 Example Street", postcode: "EX1 2AB" }, `${RBIS_FROM_N8N}/nope`),
    { ok: false, data: null, error: { code: "NOT_FOUND", httpStatus: 404, transient: false } });
});
test(AD, "A06 getAccount: returns the account view", async (t) => {
  const o = t.adapterIs(await adapter("getAccount", "AC100004"), { ok: true, operation: "getAccount", alreadyDone: false, error: null });
  t.eq(o.data?.account?.current, [{ party: "Alan Sample", type: "tenant", start: "2025-04-01" }], "data.account.current");
});
test(AD, "A07 getAccount: unknown reference is ACCOUNT_NOT_FOUND (business error)", async (t) => {
  t.adapterIs(await adapter("getAccount", "AC999999"), { ok: false, data: null, error: { code: "ACCOUNT_NOT_FOUND", httpStatus: 404, transient: false } });
});
test(AD, "A08 canTerminate: yes", async (t) => {
  t.adapterIs(await adapter("canTerminate", "AC100001"), { ok: true, data: { canTerminate: true, reason: null } });
});
test(AD, "A09 canTerminate: RBIS does not allow it", async (t) => {
  t.adapterIs(await adapter("canTerminate", "AC100020"), { ok: true, data: { canTerminate: false, reason: "TERMINATION_NOT_ALLOWED" } });
});
test(AD, "A10 canTerminate: nobody liable", async (t) => {
  await adapter("endLiability", "AC100001", { endDate: "2026-11-01", parties: [LANDLORD] });
  t.adapterIs(await adapter("canTerminate", "AC100001"), { ok: true, data: { canTerminate: false, reason: "NO_CURRENT_LIABILITY" } });
});
test(AD, "A11 canTerminate: unknown reference is ACCOUNT_NOT_FOUND", async (t) => {
  t.adapterIs(await adapter("canTerminate", "AC999999"), { ok: false, error: { code: "ACCOUNT_NOT_FOUND", transient: false, httpStatus: 404 } });
});
test(AD, "A12 endLiability: ends it once; a repeat is already done and changes nothing", async (t) => {
  const first = t.adapterIs(await adapter("endLiability", "AC100004", { endDate: "2026-10-31", parties: ["alan sample"] }), { ok: true, alreadyDone: false, error: null });
  t.eq(first.data?.account?.current, [], "current after ending");
  t.adapterIs(await adapter("endLiability", "AC100004", { endDate: "2026-10-31", parties: ["Alan Sample"] }), { ok: true, alreadyDone: true, error: null });
  t.changesAre(await rbis.changes(), [["terminate", { endDate: "2026-10-31", ended: ["Alan Sample"] }]]);
});
test(AD, "A13 endLiability: ended on another date is not 'already done'; RBIS says NO_CURRENT_LIABILITY", async (t) => {
  await adapter("endLiability", "AC100004", { endDate: "2026-10-31", parties: ["Alan Sample"] });
  t.adapterIs(await adapter("endLiability", "AC100004", { endDate: "2026-11-30", parties: ["Alan Sample"] }), { ok: false, alreadyDone: false, error: { code: "NO_CURRENT_LIABILITY", httpStatus: 409, transient: false } });
  t.eq((await rbis.changes()).length, 1, "number of RBIS changes");
});
test(AD, "A14 endLiability: TERMINATION_NOT_ALLOWED", async (t) => {
  t.adapterIs(await adapter("endLiability", "AC100020", { endDate: "2026-10-31", parties: ["Mona Sample"] }), { ok: false, error: { code: "TERMINATION_NOT_ALLOWED", httpStatus: 409, transient: false } });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(AD, "A15 endLiability: END_BEFORE_START", async (t) => {
  t.adapterIs(await adapter("endLiability", "AC100001", { endDate: "2026-01-01", parties: [LANDLORD] }), { ok: false, error: { code: "END_BEFORE_START", httpStatus: 422, transient: false } });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(AD, "A16 endLiability: refused without the names of the people to end (INVALID_PARAMS)", async (t) => {
  t.adapterIs(await adapter("endLiability", "AC100001", { endDate: "2026-11-01" }), { ok: false, error: { code: "INVALID_PARAMS", httpStatus: null, transient: false } });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(AD, "A17 addLiableParty: adds once; a repeat is already done (look first)", async (t) => {
  await adapter("endLiability", "AC100001", { endDate: "2026-11-01", parties: [LANDLORD] });
  t.adapterIs(await adapter("addLiableParty", "AC100001", { name: "Amy Sample", type: "tenant", startDate: "2026-11-01" }), { ok: true, alreadyDone: false, error: null });
  t.adapterIs(await adapter("addLiableParty", "AC100001", { name: "AMY  sample", type: "tenant", startDate: "2026-11-01" }), { ok: true, alreadyDone: true, error: null });
  t.changesAre(await rbis.changes(), [["terminate"], ["addLiableParty", { name: "Amy Sample", type: "tenant", startDate: "2026-11-01" }]]);
});
test(AD, "A18 addLiableParty: liable from another date gets RBIS 409 ALREADY_LIABLE, which counts as already done", async (t) => {
  const o = t.adapterIs(await adapter("addLiableParty", "AC100004", { name: "Alan Sample", type: "tenant", startDate: "2026-11-01" }), { ok: true, alreadyDone: true, error: null });
  t.eq(o.data?.account?.ref, "AC100004", "data.account.ref");
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(AD, "A19 addLiableParty: PARTY_REFUSED", async (t) => {
  t.adapterIs(await adapter("addLiableParty", "AC100021", { name: "Nina Sample", type: "tenant", startDate: "2026-11-01" }), { ok: false, alreadyDone: false, data: null, error: { code: "PARTY_REFUSED", httpStatus: 422, transient: false } });
});
test(AD, "A20 addLiableParty: a bad date is a business error (400), not transient", async (t) => {
  t.adapterIs(await adapter("addLiableParty", "AC100001", { name: "Amy Sample", type: "tenant", startDate: "01/11/2026" }), { ok: false, error: { code: "INVALID_DATE", httpStatus: 400, transient: false } });
});
test(AD, "A21 createDetail: creates once; a repeat is already done", async (t) => {
  t.adapterIs(await adapter("createDetail", "AC100001", { startDate: "2026-11-01", tenants: ["Amy Sample"] }), { ok: true, alreadyDone: false });
  t.adapterIs(await adapter("createDetail", "AC100001", { startDate: "2026-11-01", tenants: ["Amy Sample"] }), { ok: true, alreadyDone: true });
  t.changesAre(await rbis.changes(), [["createDetail", { startDate: "2026-11-01", tenants: ["Amy Sample"] }]]);
});
test(AD, "A22 createDetail: two at the same moment make one record (look first or RBIS 409 DETAIL_EXISTS)", async (t) => {
  const outs = await Promise.all([1, 2].map(() => adapter("createDetail", "AC100003", { startDate: "2026-11-03", tenants: ["Dan Sample"] })));
  t.eq(outs.map((o) => o[0].ok), [true, true], "both ok");
  t.eq(outs.map((o) => o[0].alreadyDone).sort(), [false, true], "exactly one already done");
  t.eq((await rbis.changes()).length, 1, "number of RBIS changes");
  t.note = `already-done answers: ${outs.map((o) => JSON.stringify(o[0].alreadyDone)).join(", ")}`;
});
test(AD, "A23 setContactDetails: saves; same again is already done; a changed phone is saved", async (t) => {
  const p = { name: "Amy Sample", email: "amy@example.test", phone: "07700 900001" };
  t.adapterIs(await adapter("setContactDetails", "AC100001", p), { ok: true, alreadyDone: false });
  t.adapterIs(await adapter("setContactDetails", "AC100001", { ...p, name: "amy sample" }), { ok: true, alreadyDone: true });
  t.adapterIs(await adapter("setContactDetails", "AC100001", { ...p, phone: "07700 900002" }), { ok: true, alreadyDone: false });
  t.changesAre(await rbis.changes(), [["setContact", { phone: "07700 900001" }], ["setContact", { phone: "07700 900002" }]]);
});
test(AD, "A24 setForwardingAddress: saves once; a repeat is already done", async (t) => {
  t.adapterIs(await adapter("setForwardingAddress", "AC100004", { address: "9 New Road, EX2 2BB" }), { ok: true, alreadyDone: false });
  t.adapterIs(await adapter("setForwardingAddress", "AC100004", { address: " 9 New Road, EX2 2BB " }), { ok: true, alreadyDone: true });
  t.changesAre(await rbis.changes(), [["setForwardingAddress", { address: "9 New Road, EX2 2BB" }]]);
});
test(AD, "A25 unknown operation: non-transient error", async (t) => {
  t.adapterIs(await adapter("deleteAccount", "AC100001"), { ok: false, operation: "deleteAccount", ref: "AC100001", alreadyDone: false, data: null, error: { code: "UNKNOWN_OPERATION", httpStatus: null, transient: false } });
});
test(AD, "A26 no account reference: non-transient error", async (t) => {
  t.adapterIs(await adapter("getAccount", "  "), { ok: false, error: { code: "MISSING_REF", transient: false } });
});
test(AD, "A27 no RBIS address: non-transient error", async (t) => {
  t.adapterIs(await adapter("getAccount", "AC100001", {}, ""), { ok: false, error: { code: "MISSING_RBIS_BASE_URL", transient: false } });
});
test(AD, "A28 outage 'before': transient 503, nothing changed", async (t) => {
  await rbis.outage({ mode: "before", ref: "AC100004", operations: ["terminate"] });
  t.adapterIs(await adapter("endLiability", "AC100004", { endDate: "2026-10-31", parties: ["Alan Sample"] }), { ok: false, alreadyDone: false, error: { code: "RBIS_UNAVAILABLE", httpStatus: 503, transient: true } });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(AD, "A29 outage 'afterChange' (reply lost) on each write: transient, then the repeat is already done", async (t) => {
  const calls = [
    ["endLiability", "terminate", { endDate: "2026-11-01", parties: [LANDLORD] }],
    ["addLiableParty", "addLiableParty", { name: "Amy Sample", type: "tenant", startDate: "2026-11-01" }],
    ["createDetail", "createDetail", { startDate: "2026-11-01", tenants: ["Amy Sample"] }],
    ["setContactDetails", "setContact", { name: "Amy Sample", email: "amy@example.test", phone: "" }],
    ["setForwardingAddress", "setForwardingAddress", { address: "1 Old Road" }],
  ];
  for (const [op, rbisOp, p] of calls) {
    await rbis.outage({ mode: "afterChange", ref: "AC100001", operations: [rbisOp], count: 1 });
    t.adapterIs(await adapter(op, "AC100001", p), { ok: false, alreadyDone: false, error: { code: "RBIS_UNAVAILABLE", httpStatus: 503, transient: true } });
    t.adapterIs(await adapter(op, "AC100001", p), { ok: true, operation: op, alreadyDone: true, error: null });
  }
  const changes = await rbis.changes();
  t.changesAre(changes, calls.map(([, rbisOp]) => [rbisOp, { replyLost: true }]));
});
test(AD, "A30 outage on reads: getAccount and findAccount are transient", async (t) => {
  await rbis.outage({ mode: "before", ref: "AC100001", operations: ["getAccount", "terminationOptions"], includeReads: true });
  t.adapterIs(await adapter("getAccount", "AC100001"), { ok: false, error: { code: "RBIS_UNAVAILABLE", httpStatus: 503, transient: true } });
  t.adapterIs(await adapter("findAccount", "AC100001", { address: "1 Example Street", postcode: "EX1 2AB" }), { ok: false, data: null, error: { httpStatus: 503, transient: true } });
  t.adapterIs(await adapter("canTerminate", "AC100001"), { ok: false, error: { httpStatus: 503, transient: true } });
  t.adapterIs(await adapter("endLiability", "AC100001", { endDate: "2026-11-01", parties: [LANDLORD] }), { ok: false, error: { httpStatus: 503, transient: true } });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(AD, "A31 RBIS unreachable (connection refused): transient", async (t) => {
  t.adapterIs(await adapter("getAccount", "AC100001", {}, "http://mock-rbis-a:9999"), { ok: false, data: null, error: { code: "RBIS_UNREACHABLE", httpStatus: null, transient: true } });
});
test(AD, "A32 RBIS unreachable (unknown host): transient", async (t) => {
  t.adapterIs(await adapter("addLiableParty", "AC100001", { name: "Amy Sample", type: "tenant", startDate: "2026-11-01" }, "http://track-a-no-such-host:8080"), { ok: false, error: { code: "RBIS_UNREACHABLE", transient: true } });
});
test(AD, "A34 RBIS answers 200 in an unexpected shape: refused before any write", async (t) => {
  // GET <base>/accounts/... with this base reaches GET /changes, which answers 200 with a list, not an account.
  const weird = `${RBIS_FROM_N8N}/changes?x=`;
  for (const [op, p] of [["addLiableParty", { name: "Amy Sample", type: "tenant", startDate: "2026-11-01" }], ["endLiability", { endDate: "2026-11-01", parties: [LANDLORD] }], ["findAccount", { address: "1 Example Street", postcode: "EX1 2AB" }]]) {
    t.adapterIs(await adapter(op, "AC100001", p, weird), { ok: false, operation: op, alreadyDone: false, data: null, error: { code: "UNEXPECTED_RBIS_ANSWER", transient: false } });
  }
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(AD, "A33 every write op: 'already done' paths for all five", async (t) => {
  // Make every change once, then repeat each: all five must answer already done with no new change.
  const calls = [
    ["endLiability", { endDate: "2026-11-01", parties: [LANDLORD] }],
    ["addLiableParty", { name: "Amy Sample", type: "tenant", startDate: "2026-11-01" }],
    ["createDetail", { startDate: "2026-11-01", tenants: ["Amy Sample"] }],
    ["setContactDetails", { name: "Amy Sample", email: "amy@example.test", phone: "07700 900001" }],
    ["setForwardingAddress", { address: "1 Old Road" }],
  ];
  for (const [op, p] of calls) t.adapterIs(await adapter(op, "AC100001", p), { ok: true, operation: op, alreadyDone: false });
  for (const [op, p] of calls) t.adapterIs(await adapter(op, "AC100001", p), { ok: true, operation: op, alreadyDone: true });
  t.eq((await rbis.changes()).length, 5, "number of RBIS changes");
});

// ================================================================ PERFORMER TESTS
const PF = "performer";
const A1 = { accountRef: "AC100001", address: "1 Example Street", postcode: "EX1 2AB" };

test(PF, "S01 move-in, landlord liable, contact details", async (t) => {
  const row = await insert({ ...A1, changeReason: "TENANCY_START", tenantName: "Amy Sample", startDate: "2026-11-01", contactEmail: "amy@example.test", contactPhone: "07700 900001" });
  const { after } = await runCase(t, row, { expectRow: { status: "updated", reasonCode: "", outcome: "liability started", urgent: false, attempts: 1, errorDetail: "",
    stepsDone: ["endLiability", "addLiableParty:amy sample", "createDetail", "setContactDetails:amy sample"] } });
  t.ok(after && after.lastAttemptAt, "lastAttemptAt is set");
  t.changesAre(await rbis.changes(), [
    ["terminate", { endDate: "2026-11-01", ended: [LANDLORD] }],
    ["addLiableParty", { name: "Amy Sample", type: "tenant", startDate: "2026-11-01" }],
    ["createDetail", { startDate: "2026-11-01", tenants: ["Amy Sample"] }],
    ["setContact", { name: "Amy Sample", email: "amy@example.test", phone: "07700 900001" }],
  ]);
});

const A2 = { accountRef: "AC100002", address: "2 Example Street", postcode: "EX1 3AC", changeReason: "TENANCY_START", startDate: "2026-11-02" };
test(PF, "S02 joint move-in: lead row adds both, joint row is a duplicate", async (t) => {
  const [leadRow, jointRow] = tenancyGroup(A2, [
    { tenantName: "Ben Sample", contactEmail: "ben@example.test", contactPhone: "07700 900002" },
    { tenantName: "Cara Sample", contactEmail: "cara@example.test", contactPhone: "" },
  ]);
  const lead = await cases.insert(leadRow);
  const joint = await cases.insert(jointRow);
  await runCase(t, lead, { expectRow: { status: "updated", outcome: "liability started", reasonCode: "",
    stepsDone: ["endLiability", "addLiableParty:ben sample", "addLiableParty:cara sample", "createDetail", "setContactDetails:ben sample", "setContactDetails:cara sample"] } });
  await runCase(t, joint, { expectRow: { status: "duplicate", reasonCode: "SAME_TENANCY_AS_EARLIER_ROW", outcome: "", urgent: false, stepsDone: [], attempts: 1 } });
  t.changesAre(await rbis.changes(), [
    ["terminate", { endDate: "2026-11-02" }],
    ["addLiableParty", { name: "Ben Sample" }],
    ["addLiableParty", { name: "Cara Sample" }],
    ["createDetail", { tenants: ["Ben Sample", "Cara Sample"] }],
    ["setContact", { name: "Ben Sample", email: "ben@example.test" }],
    ["setContact", { name: "Cara Sample", email: "cara@example.test", phone: null }],
  ]);
});

test(PF, "S03 move-in, nobody has contact details: updated with NO_CONTACT_DETAILS", async (t) => {
  const row = await insert({ accountRef: "AC100003", address: "3 Example Street", postcode: "EX1 4AD", changeReason: "TENANCY_START", tenantName: "Dan Sample", startDate: "2026-11-03" });
  await runCase(t, row, { expectRow: { status: "updated", reasonCode: "NO_CONTACT_DETAILS", outcome: "liability started", urgent: false,
    stepsDone: ["endLiability", "addLiableParty:dan sample", "createDetail"] } });
  t.changesAre(await rbis.changes(), [["terminate"], ["addLiableParty"], ["createDetail"]]);
});

const A4 = { accountRef: "AC100004", address: "4 Example Street", postcode: "EX1 5AE", changeReason: "TENANCY_END", tenantName: "Alan Sample", endDate: "2026-10-31" };
test(PF, "S04 move-out with forwarding address", async (t) => {
  const row = await insert({ ...A4, forwardingAddress: "9 New Road, EX2 2BB" });
  await runCase(t, row, { expectRow: { status: "updated", reasonCode: "", outcome: "liability ended, address saved", urgent: false,
    stepsDone: ["endLiability", LANDLORD_STEP, "setForwardingAddress"] } });
  t.changesAre(await rbis.changes(), [
    ["terminate", { endDate: "2026-10-31", ended: ["Alan Sample"] }],
    ["addLiableParty", { name: LANDLORD, type: "landlord", startDate: "2026-10-31" }],
    ["setForwardingAddress", { address: "9 New Road, EX2 2BB" }],
  ]);
});

test(PF, "S05 move-out, no forwarding address", async (t) => {
  const row = await insert({ accountRef: "AC100005", address: "5 Example Street", postcode: "EX1 6AF", changeReason: "TENANCY_END", tenantName: "Beth Sample", startDate: "2024-06-10", endDate: "2026-10-31" });
  await runCase(t, row, { expectRow: { status: "updated", reasonCode: "", outcome: "liability ended", stepsDone: ["endLiability", LANDLORD_STEP] } });
  t.changesAre(await rbis.changes(), [["terminate", { ended: ["Beth Sample"] }], ["addLiableParty", { name: LANDLORD, startDate: "2026-10-31" }]]);
});

test(PF, "S06 move-out then move-in at the same address (flat)", async (t) => {
  const A6 = { accountRef: "AC100006", address: "Flat 1, 6 Example Street", postcode: "EX1 7AG" };
  const out = await insert({ ...A6, changeReason: "TENANCY_END", tenantName: "Carl Sample", endDate: "2026-10-31" });
  const inn = await insert({ ...A6, changeReason: "TENANCY_START", tenantName: "Erin Sample", startDate: "2026-11-01", contactEmail: "erin@example.test", rowNumber: 3 });
  t.eq(out.isFlat, true, "isFlat");
  await runCase(t, out, { expectRow: { status: "updated", outcome: "liability ended" } });
  await runCase(t, inn, { expectRow: { status: "updated", outcome: "liability started", reasonCode: "" } });
  t.changesAre(await rbis.changes(), [
    ["terminate", { ended: ["Carl Sample"], endDate: "2026-10-31" }], ["addLiableParty", { name: LANDLORD, startDate: "2026-10-31" }],
    ["terminate", { ended: [LANDLORD], endDate: "2026-11-01" }], ["addLiableParty", { name: "Erin Sample" }], ["createDetail"], ["setContact"],
  ]);
});

const A7 = { accountRef: "AC100007", address: "7 Example Street", postcode: "EX1 8AH", tenantName: "Dora Sample" };
const referred = (reasonCode, extra = {}) => ({ status: "referred", reasonCode, outcome: "", urgent: false, stepsDone: [], attempts: 1, errorDetail: "", ...extra });
async function referredNoChange(t, o, reasonCode, opts = {}) {
  const row = await insert(o);
  const r = await runCase(t, row, { expectRow: referred(reasonCode), ...opts });
  t.eq(await rbis.changes(), [], "RBIS changes");
  return r;
}

test(PF, "S07 impossible date (31/02/2026 kept as text)", (t) => referredNoChange(t, { ...A7, changeReason: "TENANCY_END", endDate: "31/02/2026" }, "DATES_INVALID"));
test(PF, "S07b impossible date in yyyy-MM-dd form (2026-02-31)", (t) => referredNoChange(t, { ...A7, changeReason: "TENANCY_END", endDate: "2026-02-31" }, "DATES_INVALID"));
test(PF, "S07c move-in with no start date", (t) => referredNoChange(t, { ...A7, changeReason: "TENANCY_START", startDate: "" }, "DATES_INVALID"));
test(PF, "S08 end date before start date", (t) => referredNoChange(t, { ...A7, changeReason: "TENANCY_END", startDate: "2026-11-01", endDate: "2026-10-01" }, "DATES_INVALID"));
test(PF, "S09 unknown change reason", (t) => referredNoChange(t, { ...A7, changeReason: "TRANSFER", endDate: "2026-10-31" }, "CHANGE_REASON_NOT_VALID"));
test(PF, "S09b unknown change reason with only a start date", (t) => referredNoChange(t, { ...A7, changeReason: "TRANSFER", startDate: "2026-11-01" }, "CHANGE_REASON_NOT_VALID"));
const A10 = { accountRef: "AC100010", address: "10 Example Street", postcode: "EX1 2AC", tenantName: "Eric Sample", changeReason: "DECEASED", endDate: "2026-10-31" };
test(PF, "S10 death is DEATH_REFERRED, not CHANGE_REASON_NOT_VALID", (t) => referredNoChange(t, A10, "DEATH_REFERRED"));
test(PF, "S10b death with no end date: dates are checked first", (t) => referredNoChange(t, { ...A10, endDate: "" }, "DATES_INVALID"));

test(PF, "S11 joint move-in, lead row referred: joint row EARLIER_ROW_NOT_COMPLETED, not duplicate", async (t) => {
  const [leadRow, jointRow] = tenancyGroup({ accountRef: "AC100011", address: "11 Example Street", postcode: "EX1 3AD", changeReason: "TENANCY_START", startDate: "2026-11-01" },
    [{ tenantName: "Gina Sample" }, { tenantName: "Gus Sample" }]);
  const lead = await cases.insert(leadRow);
  const joint = await cases.insert(jointRow);
  await runCase(t, lead, { expectRow: referred("CHECK_DATES") });
  await runCase(t, joint, { expectRow: referred("EARLIER_ROW_NOT_COMPLETED") });
  t.eq(await rbis.changes(), [], "RBIS changes");
});

test(PF, "S12 no account reference", (t) => referredNoChange(t, { accountRef: "", address: "12 Example Street", postcode: "EX1 4AE", changeReason: "TENANCY_START", tenantName: "Gail Sample", startDate: "2026-11-01" }, "NO_ACCOUNT_REF"));
test(PF, "S13 account not in RBIS", (t) => referredNoChange(t, { accountRef: "AC999999", address: "99 Example Street", postcode: "EX1 9ZZ", changeReason: "TENANCY_START", tenantName: "Gail Sample", startDate: "2026-11-01" }, "ADDRESS_NOT_FOUND"));
test(PF, "S13b reference exists but the address does not match", (t) => referredNoChange(t, { accountRef: "AC100013", address: "31 Example Street", postcode: "EX1 5AF", changeReason: "TENANCY_START", tenantName: "Gail Sample", startDate: "2026-11-01" }, "ADDRESS_NOT_FOUND"));
test(PF, "S14 move-in already in RBIS from the same date", (t) => referredNoChange(t, { accountRef: "AC100014", address: "14 Example Street", postcode: "EX1 6AG", changeReason: "TENANCY_START", tenantName: "Hana Sample", startDate: "2026-11-01" }, "ACCOUNT_ALREADY_PROCESSED"));
test(PF, "S15 move-in, a tenant already liable from another date", (t) => referredNoChange(t, { accountRef: "AC100015", address: "15 Example Street", postcode: "EX1 7AH", changeReason: "TENANCY_START", tenantName: "Jack Sample", startDate: "2026-11-01" }, "CHECK_DATES"));
test(PF, "S16 move-out already in RBIS: landlord liable from the end date", (t) => referredNoChange(t, { accountRef: "AC100016", address: "16 Example Street", postcode: "EX1 8AA", changeReason: "TENANCY_END", tenantName: "Jill Sample", endDate: "2026-10-31" }, "ACCOUNT_ALREADY_PROCESSED"));
test(PF, "S17 move-out, landlord already liable from another date", (t) => referredNoChange(t, { accountRef: "AC100017", address: "17 Example Street", postcode: "EX1 9AB", changeReason: "TENANCY_END", tenantName: "Kim Sample", endDate: "2026-10-31" }, "CHECK_DATES"));
test(PF, "S18 current liability has no start date", (t) => referredNoChange(t, { accountRef: "AC100018", address: "18 Example Street", postcode: "EX1 1AC", changeReason: "TENANCY_END", tenantName: "Lee Sample", endDate: "2026-10-31" }, "NO_START_DATE"));
const A19 = { accountRef: "AC100019", address: "19 Example Street", postcode: "EX1 2AD", changeReason: "TENANCY_END", tenantName: "Liam Sample", endDate: "2026-10-31" };
test(PF, "S19 move-out, someone else is liable", (t) => referredNoChange(t, A19, "LEAVER_NOT_LIABLE"));
test(PF, "S20 RBIS will not allow ending the liability", (t) => referredNoChange(t, { accountRef: "AC100020", address: "Flat 3, 20 Example Street", postcode: "EX1 3AE", changeReason: "TENANCY_END", tenantName: "Mona Sample", endDate: "2026-10-31" }, "NO_OPTION_TO_TERMINATE"));

test(PF, "S21 joint tenant cannot be added: referred, urgent, earlier calls recorded", async (t) => {
  const [leadRow, jointRow] = tenancyGroup({ accountRef: "AC100021", address: "21 Example Street", postcode: "EX1 4AF", changeReason: "TENANCY_START", startDate: "2026-11-01" },
    [{ tenantName: "Olga Sample", contactEmail: "olga@example.test" }, { tenantName: "Nina Sample", contactEmail: "nina@example.test" }]);
  const lead = await cases.insert(leadRow);
  const joint = await cases.insert(jointRow);
  await runCase(t, lead, { expectRow: referred("UNABLE_TO_ADD_PARTY", { urgent: true, stepsDone: ["endLiability", "addLiableParty:olga sample"] }) });
  await runCase(t, joint, { expectRow: referred("EARLIER_ROW_NOT_COMPLETED") });
  t.changesAre(await rbis.changes(), [["terminate"], ["addLiableParty", { name: "Olga Sample" }]]);
});

test(PF, "S22 landlord ended, then the lead tenant cannot be added: referred, urgent", async (t) => {
  const row = await insert({ accountRef: "AC100022", address: "22 Example Street", postcode: "EX1 5AG", changeReason: "TENANCY_START", tenantName: "Paul Sample", startDate: "2026-11-01", contactEmail: "paul@example.test" });
  await runCase(t, row, { expectRow: referred("UNABLE_TO_ADD_PARTY", { urgent: true, stepsDone: ["endLiability"] }) });
  t.changesAre(await rbis.changes(), [["terminate", { ended: [LANDLORD] }]]);
});

// ---- failures and retries
const failed = (extra = {}) => ({ status: "failed", reasonCode: "RBIS_ERROR", outcome: "", errorDetail: /\S/, ...extra });
const A23 = { accountRef: "AC100023", address: "23 Example Street", postcode: "EX1 6AH", changeReason: "TENANCY_START", tenantName: "Rita Sample", startDate: "2026-11-01", contactEmail: "rita@example.test" };
test(PF, "S23 outage before any RBIS call: failed, then updated on retry", async (t) => {
  const row = await insert(A23);
  await rbis.outage({ mode: "before", ref: "AC100023", operations: ["terminate"], count: 1 });
  await runCase(t, row, { expectRow: failed({ urgent: false, stepsDone: [], attempts: 1, errorDetail: /RBIS_UNAVAILABLE/ }) });
  await runCase(t, row, { expectedStatus: "failed", expectedAttempts: 1, expectRow: { status: "updated", reasonCode: "", outcome: "liability started", attempts: 2, errorDetail: "",
    stepsDone: ["endLiability", "addLiableParty:rita sample", "createDetail", "setContactDetails:rita sample"] } });
  t.changesAre(await rbis.changes(), [["terminate"], ["addLiableParty"], ["createDetail"], ["setContact"]]);
});

const A24 = { accountRef: "AC100024", address: "24 Example Street", postcode: "EX1 7AA", changeReason: "TENANCY_START", tenantName: "Sam Sample", startDate: "2026-11-01", contactEmail: "sam@example.test" };
const A24_STEPS = ["endLiability", "addLiableParty:sam sample", "createDetail", "setContactDetails:sam sample"];
test(PF, "S24 outage after the first RBIS call ('before' on the second): retry carries on, no call made twice", async (t) => {
  const row = await insert(A24);
  await rbis.outage({ mode: "before", ref: "AC100024", operations: ["addLiableParty"], count: 1 });
  await runCase(t, row, { expectRow: failed({ urgent: false, stepsDone: ["endLiability"], attempts: 1 }) });
  await runCase(t, row, { expectedStatus: "failed", expectedAttempts: 1, expectRow: { status: "updated", outcome: "liability started", attempts: 2, stepsDone: A24_STEPS } });
  t.changesAre(await rbis.changes(), [["terminate"], ["addLiableParty"], ["createDetail"], ["setContact"]]);
});
test(PF, "S24b reply lost on the second call ('afterChange'): retry finds it already done, no call made twice", async (t) => {
  const row = await insert(A24);
  await rbis.outage({ mode: "afterChange", ref: "AC100024", operations: ["addLiableParty"], count: 1 });
  await runCase(t, row, { expectRow: failed({ urgent: false, stepsDone: ["endLiability"], attempts: 1 }) });
  await runCase(t, row, { expectedStatus: "failed", expectedAttempts: 1, expectRow: { status: "updated", attempts: 2, stepsDone: A24_STEPS } });
  t.changesAre(await rbis.changes(), [["terminate"], ["addLiableParty", { replyLost: true }], ["createDetail"], ["setContact"]]);
});

const A25 = { accountRef: "AC100025", address: "25 Example Street", postcode: "EX1 8AB", changeReason: "TENANCY_END", tenantName: "Quinn Sample", endDate: "2026-10-31", forwardingAddress: "5 New Road, EX2 3CC" };
const A25_STEPS = ["endLiability", LANDLORD_STEP, "setForwardingAddress"];
test(PF, "S25 reply lost on the first call: failed, then updated on retry; the change exists once", async (t) => {
  const row = await insert(A25);
  await rbis.outage({ mode: "afterChange", ref: "AC100025", operations: ["terminate"], count: 1 });
  await runCase(t, row, { expectRow: failed({ urgent: false, stepsDone: [], attempts: 1 }) });
  await runCase(t, row, { expectedStatus: "failed", expectedAttempts: 1, expectRow: { status: "updated", outcome: "liability ended, address saved", attempts: 2, stepsDone: A25_STEPS } });
  t.changesAre(await rbis.changes(), [["terminate", { replyLost: true }], ["addLiableParty", { name: LANDLORD }], ["setForwardingAddress"]]);
});
test(PF, "S25b reply lost on the last call: retry finds it already done", async (t) => {
  const row = await insert(A25);
  await rbis.outage({ mode: "afterChange", ref: "AC100025", operations: ["setForwardingAddress"], count: 1 });
  await runCase(t, row, { expectRow: failed({ stepsDone: ["endLiability", LANDLORD_STEP] }) });
  await runCase(t, row, { expectedStatus: "failed", expectedAttempts: 1, expectRow: { status: "updated", stepsDone: A25_STEPS } });
  t.changesAre(await rbis.changes(), [["terminate"], ["addLiableParty"], ["setForwardingAddress", { replyLost: true }]]);
});
test(PF, "S25c lost reply on a first call is NOT assumed done on a first try (strict check 4)", async (t) => {
  // Same RBIS state as after S25's lost reply, but the case has never been tried: check 4 refers it.
  await rbis.outage({ mode: "afterChange", ref: "AC100025", operations: ["terminate"], count: 1 });
  await adapter("endLiability", "AC100025", { endDate: "2026-10-31", parties: ["Quinn Sample"] });
  const row = await insert(A25);
  await runCase(t, row, { expectRow: referred("LEAVER_NOT_LIABLE") });
});

const A26 = { accountRef: "AC100026", address: "26 Example Street", postcode: "EX1 9AC", changeReason: "TENANCY_START", tenantName: "Tess Sample", startDate: "2026-11-01" };
test(PF, "S26 fails on every try: failed after 3 tries, not urgent (RBIS unchanged)", async (t) => {
  const row = await insert(A26);
  await rbis.outage({ mode: "before", ref: "AC100026", operations: ["terminate"] });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runCase(t, row, { expectedStatus: attempt === 1 ? "new" : "failed", expectedAttempts: attempt - 1, expectRow: failed({ attempts: attempt, urgent: false, stepsDone: [] }) });
  }
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "S26b fails on every try after a change: urgent once the tries run out", async (t) => {
  const row = await insert(A26);
  await rbis.outage({ mode: "before", ref: "AC100026", operations: ["addLiableParty"] });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runCase(t, row, { expectedStatus: attempt === 1 ? "new" : "failed", expectedAttempts: attempt - 1, expectRow: failed({ attempts: attempt, urgent: attempt === 3, stepsDone: ["endLiability"] }) });
  }
  t.changesAre(await rbis.changes(), [["terminate"]]);
});

test(PF, "S27 move-out fails once; the move-in for the same account follows after the retry", async (t) => {
  const A27 = { accountRef: "AC100027", address: "27 Example Street", postcode: "EX1 1AD" };
  const out = await insert({ ...A27, changeReason: "TENANCY_END", tenantName: "Rosa Sample", endDate: "2026-10-31" });
  const inn = await insert({ ...A27, changeReason: "TENANCY_START", tenantName: "Uma Sample", startDate: "2026-11-01", contactPhone: "07700 900027", rowNumber: 3 });
  await rbis.outage({ mode: "before", ref: "AC100027", operations: ["terminate"], count: 1 });
  await runCase(t, out, { expectRow: failed({ stepsDone: [] }) });
  await runCase(t, out, { expectedStatus: "failed", expectedAttempts: 1, expectRow: { status: "updated", outcome: "liability ended" } });
  await runCase(t, inn, { expectRow: { status: "updated", outcome: "liability started", reasonCode: "" } });
  t.changesAre(await rbis.changes(), [
    ["terminate", { ended: ["Rosa Sample"] }], ["addLiableParty", { name: LANDLORD, startDate: "2026-10-31" }],
    ["terminate", { ended: [LANDLORD], endDate: "2026-11-01" }], ["addLiableParty", { name: "Uma Sample" }], ["createDetail"], ["setContact", { phone: "07700 900027" }],
  ]);
});

// ---- the claim
test(PF, "C01 claim refused when the status differs", async (t) => {
  const row = await insert({ ...A1, changeReason: "TENANCY_START", tenantName: "Amy Sample", startDate: "2026-11-01", status: "updated", attempts: 1 });
  const out = await perform(row.id, { expectedStatus: "new", expectedAttempts: 1 });
  const after = await cases.get(row.id);
  t.outputIs(out, row, { claimed: false, status: "updated", reasonCode: "", outcome: "", urgent: false });
  t.caseIs(after, { status: "updated", attempts: 1, stepsDone: [] });
  t.eq(after.updatedAt, row.updatedAt, "row not touched (updatedAt)");
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "C02 claim refused when the number of tries differs", async (t) => {
  const row = await insert({ ...A1, changeReason: "TENANCY_START", tenantName: "Amy Sample", startDate: "2026-11-01", status: "failed", attempts: 2 });
  const out = await perform(row.id, { expectedStatus: "failed", expectedAttempts: 1 });
  t.outputIs(out, row, { claimed: false, status: "failed" });
  t.caseIs(await cases.get(row.id), { status: "failed", attempts: 2 });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "C03 claim refused for a case that does not exist", async (t) => {
  const out = await perform(999999, {});
  t.eq(out.length, 1, "number of output items");
  t.eq(out[0], { caseId: 999999, caseKey: "", claimed: false, status: "", reasonCode: "", outcome: "", urgent: false }, "output");
});
test(PF, "C04 four simultaneous claims: exactly one wins, RBIS changed once", async (t) => {
  const row = await insert({ ...A1, changeReason: "TENANCY_START", tenantName: "Amy Sample", startDate: "2026-11-01", contactEmail: "amy@example.test" });
  const outs = await Promise.all([1, 2, 3, 4].map(() => perform(row.id)));
  const claimed = outs.filter((o) => o[0]?.claimed === true);
  t.eq(claimed.length, 1, "number of runs that claimed the case");
  t.eq(outs.filter((o) => o[0]?.claimed === false).length, 3, "number of runs told 'not claimed'");
  t.eq(claimed[0]?.[0]?.status, "updated", "winner's status");
  t.caseIs(await cases.get(row.id), { status: "updated", attempts: 1 });
  t.eq((await rbis.changes()).map((c) => c.operation), ["terminate", "addLiableParty", "createDetail", "setContact"], "RBIS changes");
});

// ---- resume and other edges
test(PF, "R01 joint row whose lead row is unfinished is released unchanged", async (t) => {
  const [leadRow, jointRow] = tenancyGroup(A2, [{ tenantName: "Ben Sample" }, { tenantName: "Cara Sample" }]);
  await cases.insert(leadRow);
  const joint = await cases.insert(jointRow);
  await runCase(t, joint, { expectRow: { status: "new", attempts: 0, reasonCode: "", stepsDone: [] } });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "R02 resume with every step recorded: nothing repeated, updated", async (t) => {
  const row = await insert({ ...A4, status: "failed", attempts: 1, stepsDone: JSON.stringify(["endLiability", LANDLORD_STEP]) });
  await runCase(t, row, { expectedStatus: "failed", expectedAttempts: 1, expectRow: { status: "updated", outcome: "liability ended", attempts: 2, stepsDone: ["endLiability", LANDLORD_STEP] } });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "R03 a case left in_progress (stuck) can be claimed and finished", async (t) => {
  const row = await insert({ ...A4, status: "in_progress", attempts: 1 });
  await runCase(t, row, { expectedStatus: "in_progress", expectedAttempts: 1, expectRow: { status: "updated", attempts: 2 } });
});
test(PF, "R04 RBIS refuses to end the liability (END_BEFORE_START): referred CHECK_DATES", async (t) => {
  const row = await insert({ ...A1, changeReason: "TENANCY_START", tenantName: "Amy Sample", startDate: "2026-08-01" });
  await runCase(t, row, { expectRow: referred("CHECK_DATES") });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "E01 broken jointTenants text: failed with errorDetail, nobody silently dropped", async (t) => {
  const row = await insert({ ...A2, tenantName: "Ben Sample", jointTenants: "[{not json" });
  await runCase(t, row, { expectRow: failed({ urgent: false, attempts: 1, errorDetail: /jointTenants is not a JSON list/ }) });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "E01b broken stepsDone text on a retry: failed, the checks are not re-run", async (t) => {
  const row = await insert({ ...A4, status: "failed", attempts: 1, stepsDone: "[\"endLiability\"" });
  await runCase(t, row, { expectedStatus: "failed", expectedAttempts: 1, expectRow: failed({ attempts: 2, errorDetail: /stepsDone is not a JSON list/ }) });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "E04 incomplete settings (no landlordNames): failed, RBIS untouched", async (t) => {
  const row = await insert({ ...A4 });
  await runCase(t, row, { s: settings({ landlordNames: [] }), expectRow: failed({ errorDetail: /landlordNames/ }) });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "E05 RBIS answers in an unexpected shape: failed, nothing written", async (t) => {
  const row = await insert({ ...A1, changeReason: "TENANCY_START", tenantName: "Amy Sample", startDate: "2026-11-01" });
  await runCase(t, row, { s: settings({ rbisBaseUrl: `${RBIS_FROM_N8N}/changes?x=` }), expectRow: failed({ errorDetail: /UNEXPECTED_RBIS_ANSWER/ }) });
  t.eq(await rbis.changes(), [], "RBIS changes");
});
test(PF, "E02 adapter workflow missing: failed, Performer still answers", async (t) => {
  const row = await insert({ ...A1, changeReason: "TENANCY_START", tenantName: "Amy Sample", startDate: "2026-11-01" });
  await runCase(t, row, { s: settings({ adapterWorkflowId: "NoSuchWorkflow1" }), expectRow: failed({ attempts: 1 }) });
});
test(PF, "E03 RBIS unreachable: failed RBIS_ERROR", async (t) => {
  const row = await insert({ ...A1, changeReason: "TENANCY_START", tenantName: "Amy Sample", startDate: "2026-11-01" });
  await runCase(t, row, { s: settings({ rbisBaseUrl: "http://mock-rbis-a:9999" }), expectRow: failed({ errorDetail: /RBIS_UNREACHABLE/ }) });
});

// ---- settings variants
test(PF, "V01 deathHandling processAsEnd: a death is processed as a move-out", async (t) => {
  const row = await insert(A10);
  await runCase(t, row, { s: settings({ deathHandling: "processAsEnd" }), expectRow: { status: "updated", outcome: "liability ended", reasonCode: "", stepsDone: ["endLiability", LANDLORD_STEP] } });
  t.changesAre(await rbis.changes(), [["terminate", { ended: ["Eric Sample"], endDate: "2026-10-31" }], ["addLiableParty", { name: LANDLORD, startDate: "2026-10-31" }]]);
});
test(PF, "V02 confirmLeaverIsLiable false: the UiPath behaviour, the liable person is ended", async (t) => {
  const row = await insert(A19);
  await runCase(t, row, { s: settings({ confirmLeaverIsLiable: false }), expectRow: { status: "updated", outcome: "liability ended" } });
  t.changesAre(await rbis.changes(), [["terminate", { ended: ["Kate Sample"] }], ["addLiableParty", { name: LANDLORD }]]);
});
test(PF, "V03 jointTenantHandling referLaterRows: lead adds only its own person, joint row referred", async (t) => {
  const s = settings({ jointTenantHandling: "referLaterRows" });
  const [leadRow, jointRow] = tenancyGroup(A2, [{ tenantName: "Ben Sample", contactEmail: "ben@example.test" }, { tenantName: "Cara Sample", contactEmail: "cara@example.test" }]);
  const lead = await cases.insert(leadRow);
  const joint = await cases.insert(jointRow);
  await runCase(t, lead, { s, expectRow: { status: "updated", stepsDone: ["endLiability", "addLiableParty:ben sample", "createDetail", "setContactDetails:ben sample"] } });
  await runCase(t, joint, { s, expectRow: referred("EARLIER_ROW_NOT_COMPLETED") });
  t.changesAre(await rbis.changes(), [["terminate"], ["addLiableParty", { name: "Ben Sample" }], ["createDetail", { tenants: ["Ben Sample"] }], ["setContact", { name: "Ben Sample" }]]);
});
const A14 = { accountRef: "AC100014", address: "14 Example Street", postcode: "EX1 6AG", changeReason: "TENANCY_START", startDate: "2026-11-01" };
test(PF, "V04 addPersonToExistingTenancy on: a new person from ABRITAS is added", async (t) => {
  const row = await insert({ ...A14, tenantName: "Hugo Sample", sourceSystem: "ABRITAS", contactEmail: "hugo@example.test" });
  await runCase(t, row, { s: settings({ addPersonToExistingTenancy: true }), expectRow: { status: "updated", outcome: "liability started", reasonCode: "", urgent: false,
    stepsDone: ["addLiableParty:hugo sample", "createDetail", "setContactDetails:hugo sample"] } });
  t.changesAre(await rbis.changes(), [["addLiableParty", { name: "Hugo Sample", type: "tenant", startDate: "2026-11-01" }], ["createDetail", { tenants: ["Hugo Sample"] }], ["setContact", { name: "Hugo Sample" }]]);
});
test(PF, "V04b addPersonToExistingTenancy on, other source system: referred", (t) =>
  referredNoChange(t, { ...A14, tenantName: "Hugo Sample", sourceSystem: "OTHER" }, "ACCOUNT_ALREADY_PROCESSED", { s: settings({ addPersonToExistingTenancy: true }) }));
test(PF, "V04c addPersonToExistingTenancy on, person already liable: referred", (t) =>
  referredNoChange(t, { ...A14, tenantName: "Hana Sample", sourceSystem: "ABRITAS" }, "ACCOUNT_ALREADY_PROCESSED", { s: settings({ addPersonToExistingTenancy: true }) }));
test(PF, "V04d addPersonToExistingTenancy off (default): referred", (t) =>
  referredNoChange(t, { ...A14, tenantName: "Hugo Sample", sourceSystem: "ABRITAS" }, "ACCOUNT_ALREADY_PROCESSED"));
test(PF, "V04e add-person path resumes after an outage without ending anyone's liability", async (t) => {
  const s = settings({ addPersonToExistingTenancy: true });
  const row = await insert({ ...A14, tenantName: "Hugo Sample", sourceSystem: "ABRITAS", contactEmail: "hugo@example.test" });
  await rbis.outage({ mode: "before", ref: "AC100014", operations: ["createDetail"], count: 1 });
  await runCase(t, row, { s, expectRow: failed({ stepsDone: ["addLiableParty:hugo sample"] }) });
  await runCase(t, row, { s, expectedStatus: "failed", expectedAttempts: 1, expectRow: { status: "updated", stepsDone: ["addLiableParty:hugo sample", "createDetail", "setContactDetails:hugo sample"] } });
  t.changesAre(await rbis.changes(), [["addLiableParty"], ["createDetail"], ["setContact"]]);
});
test(PF, "V05 landlordLiabilityEndsOn dayBefore", async (t) => {
  const row = await insert({ ...A1, changeReason: "TENANCY_START", tenantName: "Amy Sample", startDate: "2026-11-01" });
  await runCase(t, row, { s: settings({ landlordLiabilityEndsOn: "dayBefore" }), expectRow: { status: "updated" } });
  t.changesAre(await rbis.changes(), [["terminate", { endDate: "2026-10-31" }], ["addLiableParty", { startDate: "2026-11-01" }], ["createDetail"]]);
});
test(PF, "V07 nameMatch surnameOnly: 'Liam Sample' matches the liable 'Kate Sample' (same surname)", async (t) => {
  const row = await insert(A19);
  await runCase(t, row, { s: settings({ nameMatch: "surnameOnly" }), expectRow: { status: "updated", outcome: "liability ended" } });
  t.changesAre(await rbis.changes(), [["terminate", { ended: ["Kate Sample"] }], ["addLiableParty", { name: LANDLORD }]]);
});
test(PF, "V06 landlordLiableFrom dayAfter", async (t) => {
  const row = await insert(A4);
  await runCase(t, row, { s: settings({ landlordLiableFrom: "dayAfter" }), expectRow: { status: "updated" } });
  t.changesAre(await rbis.changes(), [["terminate", { endDate: "2026-10-31" }], ["addLiableParty", { name: LANDLORD, startDate: "2026-11-01" }]]);
});
test(PF, "V06b landlordLiableFrom dayAfter: a move-out already done that way is ACCOUNT_ALREADY_PROCESSED", async (t) => {
  const s = settings({ landlordLiableFrom: "dayAfter" });
  const first = await insert(A4);
  await runCase(t, first, { s, expectRow: { status: "updated" } });
  await cases.clear();
  const again = await insert({ ...A4, rowNumber: 5 });
  await runCase(t, again, { s, expectRow: referred("ACCOUNT_ALREADY_PROCESSED") });
});

// ---------------------------------------------------------------- main
async function main() {
  const health = await http("GET", `${RBIS}/health`).catch(() => null);
  if (!health || health.status !== 200) throw new Error(`mock-rbis-a is not answering at ${RBIS}`);
  const selected = tests.filter((x) => (GROUPS.length === 0 || GROUPS.includes(x.group)) && (!ONLY || x.name.includes(ONLY)));
  let passed = 0;
  const failedTests = [];
  const started = Date.now();
  for (const { group, name, fn } of selected) {
    const t = new Checks();
    try {
      await rbis.reset();
      await cases.clear();
      await fn(t);
    } catch (err) {
      t.failures.push(`threw: ${err.message}`);
    }
    if (t.failures.length === 0) {
      passed++;
      console.log(`PASS  [${group}] ${name} (${t.count} checks)${t.note ? `  — ${t.note}` : ""}`);
    } else {
      failedTests.push(name);
      console.log(`FAIL  [${group}] ${name}`);
      for (const f of t.failures) console.log(`        - ${f}`);
      if (VERBOSE) console.log("        changes:", JSON.stringify(await rbis.changes()));
    }
  }
  await rbis.reset();
  await cases.clear();
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n${passed} passed, ${failedTests.length} failed, ${selected.length} run (${secs}s)`);
  if (failedTests.length) {
    console.log("Failed:\n  " + failedTests.join("\n  "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});

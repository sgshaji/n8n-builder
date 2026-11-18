// Checks for the pretend RBIS itself. Run with:  node --test mock-rbis/
// Uses its own small fixture, so changes to test-data/ cannot break these checks.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRbis, normalise } from "./server.mjs";

const LANDLORD = "Example Housing Association";
const fixture = {
  accounts: [
    {
      ref: "T1",
      address: "1 Test Road",
      postcode: "TE1 1ST",
      liabilities: [{ party: LANDLORD, type: "landlord", start: "2026-08-01", end: null }],
    },
    {
      ref: "T2",
      address: "Flat 2, 2 Test Road",
      postcode: "TE1 2ST",
      isFlat: true,
      liabilities: [
        { party: LANDLORD, type: "landlord", start: "2020-01-01", end: "2024-03-01" },
        { party: "Jane Test", type: "tenant", start: "2024-03-01", end: null },
        { party: "John Test", type: "tenant", start: "2024-03-01", end: null },
      ],
    },
    {
      ref: "T3",
      address: "3 Test Road",
      postcode: "TE1 3ST",
      canTerminate: false,
      refuseParties: ["Blocked Person"],
      liabilities: [{ party: LANDLORD, type: "landlord", start: "2026-08-01", end: null }],
    },
  ],
};

let dir, server, base;
process.env.MOCK_RBIS_LOG = "off";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mock-rbis-"));
  const file = join(dir, "accounts.json");
  writeFileSync(file, JSON.stringify(fixture));
  server = createMockRbis({ accountsFile: file });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await call("POST", "/reset");
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test("health reports the number of accounts", async () => {
  const res = await call("GET", "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok", accounts: 3 });
});

test("an account shows who is liable now, and hides test-only switches", async () => {
  const res = await call("GET", "/accounts/T2");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.current, [
    { party: "Jane Test", type: "tenant", start: "2024-03-01" },
    { party: "John Test", type: "tenant", start: "2024-03-01" },
  ]);
  assert.equal(res.body.liabilities.length, 3);
  assert.equal(res.body.isFlat, true);
  assert.equal("canTerminate" in res.body, false);
  assert.equal("refuseParties" in res.body, false);
});

test("an unknown account is a 404", async () => {
  const res = await call("GET", "/accounts/NOPE");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "ACCOUNT_NOT_FOUND");
});

test("search matches address and postcode ignoring capitals and punctuation", async () => {
  const res = await call("GET", "/accounts?address=flat%202%20%202%20TEST%20road&postcode=te1-2st");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((a) => a.ref), ["T2"]);
  const none = await call("GET", "/accounts?address=9%20Nowhere");
  assert.deepEqual(none.body, []);
});

test("termination options reflect the account", async () => {
  assert.equal((await call("GET", "/accounts/T1/termination-options")).body.canTerminate, true);
  const blocked = await call("GET", "/accounts/T3/termination-options");
  assert.equal(blocked.body.canTerminate, false);
  assert.equal(blocked.body.reason, "TERMINATION_NOT_ALLOWED");
});

test("terminate ends every current liability and is recorded once", async () => {
  const res = await call("POST", "/accounts/T2/terminate", { endDate: "2026-10-31" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.current, []);
  const changes = (await call("GET", "/changes")).body;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].operation, "terminate");
  assert.deepEqual(changes[0].ended, ["Jane Test", "John Test"]);

  const again = await call("POST", "/accounts/T2/terminate", { endDate: "2026-10-31" });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "NO_CURRENT_LIABILITY");
  const options = await call("GET", "/accounts/T2/termination-options");
  assert.equal(options.body.canTerminate, false);
  assert.equal(options.body.reason, "NO_CURRENT_LIABILITY");
});

test("terminate is refused when not allowed, with a bad date, or before the start", async () => {
  assert.equal((await call("POST", "/accounts/T3/terminate", { endDate: "2026-10-31" })).body.error, "TERMINATION_NOT_ALLOWED");
  assert.equal((await call("POST", "/accounts/T1/terminate", { endDate: "31/10/2026" })).status, 400);
  assert.equal((await call("POST", "/accounts/T1/terminate", { endDate: "2026-02-31" })).status, 400);
  assert.equal((await call("POST", "/accounts/T1/terminate", { endDate: "2026-07-01" })).body.error, "END_BEFORE_START");
  assert.deepEqual((await call("GET", "/changes")).body, []);
});

test("a liable party can be added once; repeats and refused people are rejected", async () => {
  await call("POST", "/accounts/T1/terminate", { endDate: "2026-11-01" });
  const added = await call("POST", "/accounts/T1/liable-parties", { name: "Amy Test", type: "tenant", startDate: "2026-11-01" });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.current, [{ party: "Amy Test", type: "tenant", start: "2026-11-01" }]);

  const repeat = await call("POST", "/accounts/T1/liable-parties", { name: "  amy  TEST ", type: "tenant", startDate: "2026-11-01" });
  assert.equal(repeat.status, 409);
  assert.equal(repeat.body.error, "ALREADY_LIABLE");

  const refused = await call("POST", "/accounts/T3/liable-parties", { name: "blocked person", type: "tenant", startDate: "2026-11-01" });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, "PARTY_REFUSED");

  assert.equal((await call("POST", "/accounts/T1/liable-parties", { name: "X", type: "owner", startDate: "2026-11-01" })).status, 400);
  assert.equal((await call("POST", "/accounts/T1/liable-parties", { name: "", type: "tenant", startDate: "2026-11-01" })).status, 400);
});

test("detail, contact and forwarding address are saved; a second detail for the same date is rejected", async () => {
  const detail = await call("POST", "/accounts/T1/details", { startDate: "2026-11-01", tenants: ["Amy Test"] });
  assert.equal(detail.status, 201);
  assert.equal((await call("POST", "/accounts/T1/details", { startDate: "2026-11-01", tenants: ["Amy Test"] })).body.error, "DETAIL_EXISTS");

  await call("PUT", "/accounts/T1/contact", { name: "Amy Test", email: "amy@example.test" });
  const contact = await call("PUT", "/accounts/T1/contact", { name: "amy test", phone: "07700 900123" });
  assert.deepEqual(contact.body.contacts, [{ name: "amy test", email: null, phone: "07700 900123" }]);
  assert.equal((await call("PUT", "/accounts/T1/contact", { name: "Amy Test" })).status, 400);

  const fwd = await call("PUT", "/accounts/T1/forwarding-address", { address: " 4 New Road, EX2 2BB " });
  assert.equal(fwd.body.forwardingAddress, "4 New Road, EX2 2BB");
  assert.equal((await call("PUT", "/accounts/T1/forwarding-address", {})).status, 400);
});

test("reset restores the starting data and clears the change log", async () => {
  await call("POST", "/accounts/T2/terminate", { endDate: "2026-10-31" });
  await call("POST", "/reset");
  assert.equal((await call("GET", "/accounts/T2")).body.current.length, 2);
  assert.deepEqual((await call("GET", "/changes")).body, []);
});

test("outage 'before': the call fails and nothing changes, for the requested number of calls", async () => {
  await call("POST", "/simulate-outage", { mode: "before", count: 1 });
  const failed = await call("POST", "/accounts/T2/terminate", { endDate: "2026-10-31" });
  assert.equal(failed.status, 503);
  assert.equal((await call("GET", "/accounts/T2")).body.current.length, 2);
  const retried = await call("POST", "/accounts/T2/terminate", { endDate: "2026-10-31" });
  assert.equal(retried.status, 200);
});

test("outage 'afterChange': the change is made but the reply is lost", async () => {
  await call("POST", "/simulate-outage", { mode: "afterChange", count: 1, operations: ["terminate"] });
  const lost = await call("POST", "/accounts/T2/terminate", { endDate: "2026-10-31" });
  assert.equal(lost.status, 503);
  assert.deepEqual((await call("GET", "/accounts/T2")).body.current, []);
  const changes = (await call("GET", "/changes")).body;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].replyLost, true);
});

test("outage can skip calls, target one account and one operation, and leave reads alone", async () => {
  await call("POST", "/simulate-outage", { mode: "before", ref: "T1", operations: ["addLiableParty"], skip: 1 });
  assert.equal((await call("GET", "/accounts/T1")).status, 200);
  assert.equal((await call("POST", "/accounts/T1/terminate", { endDate: "2026-11-01" })).status, 200);
  const first = await call("POST", "/accounts/T1/liable-parties", { name: "Amy Test", type: "tenant", startDate: "2026-11-01" });
  assert.equal(first.status, 201);
  const second = await call("POST", "/accounts/T1/liable-parties", { name: "Ben Test", type: "tenant", startDate: "2026-11-01" });
  assert.equal(second.status, 503);
  assert.equal((await call("POST", "/accounts/T2/terminate", { endDate: "2026-10-31" })).status, 200);

  await call("POST", "/simulate-outage", { mode: "off" });
  assert.equal((await call("POST", "/accounts/T1/liable-parties", { name: "Ben Test", type: "tenant", startDate: "2026-11-01" })).status, 201);
});

test("outage with includeReads also fails reads; bad outage settings are rejected", async () => {
  await call("POST", "/simulate-outage", { mode: "before", includeReads: true, count: 1 });
  assert.equal((await call("GET", "/accounts/T1")).status, 503);
  assert.equal((await call("GET", "/accounts/T1")).status, 200);
  assert.equal((await call("POST", "/simulate-outage", { mode: "sometimes" })).status, 400);
  assert.equal((await call("POST", "/simulate-outage", { mode: "before", operations: ["nope"] })).status, 400);
});

test("accounts can be added and removed while running, and reset undoes it", async () => {
  const put = await call("PUT", "/admin/accounts/T9", { address: "9 Test Road", postcode: "TE1 9ST" });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.current, []);
  assert.equal((await call("GET", "/accounts/T9")).status, 200);
  assert.equal((await call("DELETE", "/admin/accounts/T9")).body.deleted, true);
  assert.equal((await call("GET", "/accounts/T9")).status, 404);
  assert.equal((await call("PUT", "/admin/accounts/T8", {})).status, 400);
});

test("bad JSON and unknown paths are rejected", async () => {
  const res = await fetch(base + "/accounts/T1/terminate", { method: "POST", body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal((await call("GET", "/nothing-here")).status, 404);
  assert.equal((await call("POST", "/accounts/T1/unknown-action", {})).status, 404);
});

test("normalise ignores capitals, punctuation and extra spaces", () => {
  assert.equal(normalise("  O'Brien-Smith,  JANE "), "o brien smith jane");
  assert.equal(normalise(null), "");
});

// Shared helpers for the Dispatcher tests: n8n public API, Data tables, Mailpit,
// the track B folders and a small check/report system. Plain Node, no packages.
import { readdirSync, rmSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readEnv, repoRoot } from "../../../scripts/lib/env.mjs";
import { writeXlsx, xlsxBuffer } from "./xlsx.mjs";

const env = readEnv();
if (!env.N8N_API_KEY) {
  process.stderr.write("N8N_API_KEY is missing in .env (see docs/setup/02-connect-mcp-servers.md).\n");
  process.exit(2);
}

// ---------- track B resources (never anything else) ----------
export const CFG = {
  n8n: (env.N8N_API_URL || "http://localhost:5678").replace(/\/$/, ""),
  mailpit: process.env.MAILPIT_URL || "http://localhost:8025",
  dispatcherId: process.env.DISPATCHER_ID || "ixS5Wg5EN0IZwAjX",
  performerId: process.env.PERFORMER_ID || "V6d1AbXAlOPwo9Uw",
  casesTable: "fKgz5jaovu1lXFxF",
  batchesTable: "Au3kGjRv0bauKmlw",
  lockTable: "SKA4C9Pihmt3oowK",
  mailTo: "harsll-team-trackb@example.test",
  dataDir: join(repoRoot, "data", "trackB"),
  maxAttempts: 3,
  stuckMinutes: 15,
};
export const FOLDERS = ["input", "archive", "rejected", "reports"];
export const folder = (name) => join(CFG.dataDir, name);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(...a);

// ---------- n8n public API ----------
export async function api(method, path, body) {
  const res = await fetch(`${CFG.n8n}/api/v1${path}`, {
    method,
    headers: { "X-N8N-API-KEY": env.N8N_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const filterParam = (filters, type = "and") => encodeURIComponent(JSON.stringify({ type, filters }));

export async function rows(tableId, filters) {
  const out = [];
  let cursor;
  do {
    const q = [`limit=250`];
    if (filters) q.push(`filter=${filterParam(filters)}`);
    if (cursor) q.push(`cursor=${encodeURIComponent(cursor)}`);
    const r = await api("GET", `/data-tables/${tableId}/rows?${q.join("&")}`);
    out.push(...r.data);
    cursor = r.nextCursor;
  } while (cursor);
  return out.sort((a, b) => a.id - b.id);
}
export const cases = () => rows(CFG.casesTable);
export const batches = () => rows(CFG.batchesTable);
export const lockRow = async () => (await rows(CFG.lockTable))[0];

export async function insertRows(tableId, data) {
  return api("POST", `/data-tables/${tableId}/rows`, { data, returnType: "all" });
}
export async function updateRows(tableId, filters, data) {
  return api("PATCH", `/data-tables/${tableId}/rows/update`, { filter: { type: "and", filters }, data });
}
export async function clearTable(tableId) {
  await api("DELETE", `/data-tables/${tableId}/rows/delete?filter=${filterParam([{ columnName: "id", condition: "gte", value: 0 }])}`);
}
export async function setLock(lockedBy, lockedAt) {
  await updateRows(CFG.lockTable, [{ columnName: "name", condition: "eq", value: "dispatcher" }], { lockedBy, lockedAt });
}

// ---------- executions ----------
export async function latestExecutionId() {
  const r = await api("GET", "/executions?limit=1");
  return r.data.length ? Number(r.data[0].id) : 0;
}

// Note: the plain executions list leaves out running executions; they are fetched with status=running.
export async function runningExecutions(workflowId) {
  return (await api("GET", `/executions?workflowId=${workflowId}&status=running&limit=50`)).data;
}

export async function executionsAfter(workflowId, afterId) {
  const out = new Map();
  let cursor;
  for (;;) {
    const r = await api("GET", `/executions?workflowId=${workflowId}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    let older = false;
    for (const e of r.data) {
      if (Number(e.id) > afterId) out.set(e.id, e);
      else older = true;
    }
    cursor = r.nextCursor;
    if (older || !cursor) break;
  }
  for (const e of await runningExecutions(workflowId)) if (Number(e.id) > afterId && !out.has(e.id)) out.set(e.id, e);
  return [...out.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export async function executionNodes(id) {
  const e = await api("GET", `/executions/${id}?includeData=true`);
  const runData = e.data?.resultData?.runData || {};
  const runs = {};
  for (const [name, arr] of Object.entries(runData)) runs[name] = arr.length;
  return { status: e.status, mode: e.mode, runs, error: e.data?.resultData?.error?.message, startedAt: e.startedAt, stoppedAt: e.stoppedAt };
}

export async function waitUntil(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(1500);
  }
}

// Idle = no Dispatcher run still going. A file-trigger run is "running" during its settle wait.
export async function waitForIdle(timeoutMs = 240000) {
  let quiet = 0;
  await waitUntil(async () => {
    const busy = await runningExecutions(CFG.dispatcherId);
    quiet = busy.length ? 0 : quiet + 1;
    return quiet >= 3;
  }, timeoutMs, "the Dispatcher to become idle");
}

// Wait until `count` file-trigger runs have started after `afterId`, and all of them have finished.
export async function waitForTriggerRuns(afterId, count, timeoutMs = 200000) {
  return waitUntil(async () => {
    const list = (await executionsAfter(CFG.dispatcherId, afterId)).filter((e) => e.mode === "trigger");
    return list.length >= count && list.every((e) => e.stoppedAt) ? list : null;
  }, timeoutMs, `${count} file-trigger run(s)`);
}

// Files whose modified time is already old (as after a Windows copy) do not reliably raise a
// file-trigger event, so after such drops wait out any trigger run instead of counting on one.
export async function waitOutTriggerRuns(droppedAtMs) {
  const left = droppedAtMs + 75000 - Date.now();
  if (left > 0) await sleep(left);
  await waitForIdle();
}

// POST the Run now webhook and wait for that run to finish.
export async function runNow() {
  const before = await latestExecutionId();
  const res = await fetch(`${CFG.n8n}/webhook/harsll-run-now`, { method: "POST" });
  const body = await res.json();
  const exec = await waitUntil(async () => {
    const list = (await executionsAfter(CFG.dispatcherId, before)).filter((e) => e.mode === "webhook");
    return list.length && list[0].stoppedAt ? list[0] : null;
  }, 180000, "the Run now execution");
  return { body, status: res.status, contentType: res.headers.get("content-type"), exec };
}

// ---------- Mailpit (only track B's recipient) ----------
export async function myMails() {
  const res = await fetch(`${CFG.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${CFG.mailTo}`)}&limit=500`);
  const list = await res.json();
  const out = [];
  for (const m of list.messages || []) {
    const full = await (await fetch(`${CFG.mailpit}/api/v1/message/${m.ID}`)).json();
    out.push({ id: m.ID, subject: m.Subject, text: full.Text || "", created: m.Created, to: m.To.map((t) => t.Address) });
  }
  return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
}
export async function clearMyMails() {
  const res = await fetch(`${CFG.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${CFG.mailTo}`)}&limit=1000`);
  const list = await res.json();
  const ids = (list.messages || []).map((m) => m.ID);
  if (ids.length) {
    await fetch(`${CFG.mailpit}/api/v1/messages`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ IDs: ids }) });
  }
}

// ---------- folders ----------
export function listFolder(name) {
  const dir = folder(name);
  return existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()) : [];
}
export function clearFolders() {
  for (const f of FOLDERS) {
    const dir = folder(f);
    if (existsSync(dir)) for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}
export const HEADER = ["ChangeReason", "AccountRef", "TenantName", "Address", "Postcode", "StartDate", "EndDate", "ForwardingAddress", "ContactEmail", "ContactPhone", "SourceSystem"];
// Row helper: r({ ChangeReason, AccountRef, ... }) in HEADER order.
export const row = (o) => HEADER.map((h) => (o[h] === undefined ? "" : o[h]));
export function dropFile(name, rowsWithHeader, { settled = false } = {}) {
  const path = join(folder("input"), name);
  writeXlsx(path, rowsWithHeader, settled ? { mtime: new Date(Date.now() - 5 * 60000) } : {});
  return path;
}
export { xlsxBuffer };

// ---------- docker (optional, for the command-injection check) ----------
export function dockerFind(fileName) {
  try {
    return execFileSync("docker", ["compose", "exec", "-T", "n8n", "sh", "-c", `find / -xdev -name '${fileName}' 2>/dev/null | head -5`], { cwd: repoRoot, encoding: "utf8", timeout: 60000 }).trim();
  } catch (e) {
    return null; // docker not available
  }
}

// ---------- reset ----------
export async function resetAll() {
  await waitForIdle();
  await clearTable(CFG.casesTable);
  await clearTable(CFG.batchesTable);
  await setLock("", null);
  await clearMyMails();
  clearFolders();
}

// ---------- checks ----------
export const results = [];
let currentTest = "";
export function startTest(name) {
  currentTest = name;
  log(`\n=== ${name}`);
}
export function check(name, ok, detail = "") {
  results.push({ test: currentTest, name, ok: !!ok, detail });
  log(`   ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
  return !!ok;
}
export function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return check(name, a === e, `expected ${e}, got ${a}`);
}
export const byName = (list, tenantName) => list.find((c) => c.tenantName === tenantName);
export const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

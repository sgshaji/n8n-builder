// HARSLL test runner: runs the scenarios in test-data/scenarios.json against
// the n8n workflows and the pretend RBIS, and reports PASS or FAIL per scenario.
//
//   node scripts/run-tests.mjs                     all scenarios except the slow one (production profile)
//   node scripts/run-tests.mjs --only 1,2,6        only the groups these scenarios are in
//   node scripts/run-tests.mjs --include-slow      also scenario 36 (stops and starts n8n)
//   node scripts/run-tests.mjs --list              show the groups and scenarios, run nothing
//   node scripts/run-tests.mjs --profile trackC --self-check
//                                                  check the runner itself, without the workflows
//
// Plain Node.js, no packages. The n8n API key is read from .env and never printed.
// Guide: docs/testing.md.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readEnv, repoRoot } from "./lib/env.mjs";
import * as kit from "./lib/scenario-kit.mjs";
import { buildXlsx, readXlsx } from "./lib/xlsx.mjs";
import { buildAllFiles, staleFiles } from "./make-test-spreadsheets.mjs";

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const folderSet = (base) => ({
  input: join(repoRoot, ...base, "input"),
  archive: join(repoRoot, ...base, "archive"),
  rejected: join(repoRoot, ...base, "rejected"),
  reports: join(repoRoot, ...base, "reports"),
});

export const PROFILES = {
  production: {
    name: "production",
    n8nUrl: "http://localhost:5678",
    rbisUrl: "http://localhost:8088",
    mailpitUrl: "http://localhost:8025",
    tables: { cases: "SBZZFYYtjdKZcTha", batches: "4jaeshwJnybiuyp3", lock: "4iFl6qPseCy2DyGb" },
    folders: folderSet(["data"]),
    runNowUrl: "http://localhost:5678/webhook/harsll-run-now",
    dispatcherName: "HARSLL – Dispatcher",
    cleanFolders: true,
    cleanMailpit: true,
    checkEmails: true,
    mayRestartN8n: true,
  },
  trackC: {
    name: "trackC",
    n8nUrl: "http://localhost:5678",
    rbisUrl: "http://localhost:8091",
    mailpitUrl: "http://localhost:8025",
    tables: { cases: "rMQDvBaEjwGIanqf", batches: "uM2kkAGutYhptMNK", lock: "hCHw5zGXvh5ddm5k" },
    folders: folderSet(["data", "trackC"]),
    runNowUrl: null, // no Dispatcher of its own; see --run-now-url
    dispatcherName: null,
    cleanFolders: true, // its own folders only
    cleanMailpit: false, // the test mailbox is shared during the build: read only
    checkEmails: false,
    mayRestartN8n: false, // other tracks use the same n8n
  },
};

const LOCK_STALE_MS = 30 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { profile: "production", only: null, includeSlow: false, list: false, selfCheck: false, verbose: false, runNowUrl: undefined, dispatcherName: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--profile") opts.profile = next();
    else if (a.startsWith("--profile=")) opts.profile = a.slice(10);
    else if (a === "--only") opts.only = parseOnly(next());
    else if (a.startsWith("--only=")) opts.only = parseOnly(a.slice(7));
    else if (a === "--include-slow") opts.includeSlow = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--self-check") opts.selfCheck = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--run-now-url") opts.runNowUrl = next();
    else if (a === "--dispatcher-name") opts.dispatcherName = next();
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!PROFILES[opts.profile]) throw new Error(`Unknown profile ${opts.profile}. Use ${Object.keys(PROFILES).join(" or ")}`);
  return opts;
}

export function parseOnly(text) {
  const ids = String(text)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--only: not a scenario number: ${s}`);
      return n;
    });
  if (!ids.length) throw new Error("--only needs scenario numbers, e.g. --only 1,2,6");
  return ids;
}

/** Which groups to run, and why any are left out. */
export function selectGroups(data, opts) {
  const chosen = [];
  const skipped = [];
  if (opts.only) {
    const known = new Set(data.scenarios.map((s) => s.id));
    const unknown = opts.only.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`--only: no such scenario: ${unknown.join(", ")}`);
  }
  for (const group of data.groups) {
    const wanted = opts.only ? group.scenarios.filter((id) => opts.only.includes(id)) : group.scenarios;
    if (!wanted.length) continue;
    if (group.slow && !opts.includeSlow) skipped.push({ group, wanted, why: "slow: add --include-slow" });
    else if (group.productionOnly && opts.profile !== "production") skipped.push({ group, wanted, why: "production profile only" });
    else chosen.push({ group, wanted });
  }
  return { chosen, skipped };
}

export function estimateSeconds(group) {
  let s = 10;
  for (const step of group.steps) {
    if (step.do === "drop") s += 75;
    if (step.do === "runNow") s += 10 * (step.parallel ?? 1);
    if (step.do === "runNowUntil") s += 10;
    if (step.do === "startN8n") s += 60;
  }
  if (group.slow) s += 15 * 60;
  return s;
}

// ---------------------------------------------------------------------------
// Clients: n8n public API, pretend RBIS, Mailpit, folders
// ---------------------------------------------------------------------------

async function http(method, url, { headers = {}, body, expect = [200, 201, 204] } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`${method} ${url.replace(/\?.*/, "")}: cannot connect (${err.cause?.code ?? err.message})`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (expect && !expect.includes(res.status)) {
    const message = json?.message ?? json?.error ?? String(text).slice(0, 200);
    const err = new Error(`${method} ${url.replace(/\?.*/, "")} answered ${res.status}: ${message}`);
    err.status = res.status;
    throw err;
  }
  return { status: res.status, json };
}

export function makeClients(profile, apiKey) {
  const api = (method, path, body, expect) =>
    http(method, `${profile.n8nUrl}/api/v1${path}`, { headers: { "X-N8N-API-KEY": apiKey }, body, expect }).then((r) => r.json);
  const filterParam = (filters) => encodeURIComponent(JSON.stringify({ type: "and", filters }));

  const n8n = {
    async listRows(tableId) {
      const rows = [];
      let cursor = null;
      do {
        const page = await api("GET", `/data-tables/${tableId}/rows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        rows.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      return rows;
    },
    insertRows: (tableId, rows) => api("POST", `/data-tables/${tableId}/rows`, { data: rows, returnType: "all" }),
    updateRows: (tableId, filters, data) => api("PATCH", `/data-tables/${tableId}/rows/update`, { filter: { type: "and", filters }, data, returnData: true }),
    deleteRows: (tableId, filters) => api("DELETE", `/data-tables/${tableId}/rows/delete?filter=${filterParam(filters)}&returnData=false`),
    deleteAllRows: (tableId) => api("DELETE", `/data-tables/${tableId}/rows/delete?filter=${filterParam([{ columnName: "id", condition: "gt", value: 0 }])}&returnData=false`),
    async getLock() {
      const rows = await n8n.listRows(profile.tables.lock);
      return rows.find((r) => r.name === "dispatcher") ?? null;
    },
    async freeLock() {
      const updated = await n8n.updateRows(profile.tables.lock, [{ columnName: "name", condition: "eq", value: "dispatcher" }], { lockedAt: null, lockedBy: "" });
      if (!Array.isArray(updated) || updated.length === 0) await n8n.insertRows(profile.tables.lock, [{ name: "dispatcher", lockedAt: null, lockedBy: "" }]);
    },
    async findWorkflowId(name) {
      const page = await api("GET", `/workflows?name=${encodeURIComponent(name)}&limit=100`);
      const exact = page.data.filter((w) => w.name === name);
      return exact.find((w) => w.active)?.id ?? exact[0]?.id ?? null;
    },
    /** Executions of a workflow that have not finished. The plain list leaves running ones out. */
    async unfinishedExecutions(workflowId) {
      const out = [];
      for (const status of ["running", "waiting", "new"]) {
        try {
          const page = await api("GET", `/executions?workflowId=${workflowId}&status=${status}&limit=100`);
          out.push(...page.data.filter((e) => !e.stoppedAt));
        } catch (err) {
          if (err.status !== 400) throw err; // a status this n8n does not filter on
        }
      }
      return out;
    },
  };

  const rbisCall = (method, path, body, expect) => http(method, `${profile.rbisUrl}${path}`, { body, expect });
  const rbis = {
    health: () => rbisCall("GET", "/health").then((r) => r.json),
    reset: () => rbisCall("POST", "/reset").then((r) => r.json),
    outage: (body) => rbisCall("POST", "/simulate-outage", body).then((r) => r.json),
    outageOff: () => rbisCall("POST", "/simulate-outage", { mode: "off" }).then((r) => r.json),
    changes: () => rbisCall("GET", "/changes").then((r) => r.json),
    addAccount: (ref, account) => rbisCall("PUT", `/admin/accounts/${encodeURIComponent(ref)}`, account).then((r) => r.json),
    raw: rbisCall,
  };

  const mail = {
    /** HARSLL emails: every message to the team address, with subject and plain text. */
    async list(teamAddress) {
      const out = [];
      let start = 0;
      for (;;) {
        const page = (await http("GET", `${profile.mailpitUrl}/api/v1/messages?limit=200&start=${start}`)).json;
        for (const m of page.messages ?? []) {
          if (!(m.To ?? []).some((t) => (t.Address ?? "").toLowerCase() === teamAddress.toLowerCase())) continue;
          const full = (await http("GET", `${profile.mailpitUrl}/api/v1/message/${m.ID}`)).json;
          const text = full.Text || String(full.HTML ?? "").replace(/<[^>]+>/g, " ");
          out.push({ id: m.ID, subject: full.Subject ?? m.Subject ?? "", text, created: m.Created });
        }
        start += (page.messages ?? []).length;
        if (!page.messages?.length || start >= (page.messages_count ?? page.total ?? 0)) break;
      }
      return out;
    },
    deleteAll: () => http("DELETE", `${profile.mailpitUrl}/api/v1/messages`),
  };

  const folders = {
    list(key) {
      const dir = profile.folders[key];
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile());
    },
    clean(key) {
      const dir = profile.folders[key];
      mkdirSync(dir, { recursive: true });
      for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
    },
    /** Write (not copy: a copy keeps the old modification time on Windows). */
    write(key, name, buf, { backdateSeconds = 0 } = {}) {
      const path = join(profile.folders[key], name);
      writeFileSync(path, buf);
      if (backdateSeconds) {
        const t = (Date.now() - backdateSeconds * 1000) / 1000;
        utimesSync(path, t, t);
      }
    },
    read: (key, name) => readFileSync(join(profile.folders[key], name)),
  };

  return { n8n, rbis, mail, folders };
}

// ---------------------------------------------------------------------------
// The Dispatcher: busy, idle, Run now
// ---------------------------------------------------------------------------

const lockHeld = (lock) => Boolean(lock?.lockedAt) && Date.now() - Date.parse(lock.lockedAt) < LOCK_STALE_MS;

/**
 * Is the Dispatcher doing anything? When its workflow is known, its unfinished
 * executions decide (a run waiting out the one-minute settle counts as busy, and
 * a lock left behind by a crashed run does not). Otherwise the lock decides.
 */
export async function dispatcherBusy(ctx) {
  const lock = await ctx.c.n8n.getLock();
  const running = ctx.dispatcherId ? await ctx.c.n8n.unfinishedExecutions(ctx.dispatcherId) : [];
  const busy = ctx.dispatcherId ? running.length > 0 : lockHeld(lock);
  return { busy, lockHeld: lockHeld(lock), running, lock };
}

async function waitLockFree(ctx, timeoutSeconds = 600) {
  const end = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const lock = await ctx.c.n8n.getLock();
    if (!lockHeld(lock)) return lock;
    if (Date.now() > end) throw new Error(`the Dispatcher lock was still held after ${timeoutSeconds}s`);
    await sleep(1000);
  }
}

/** Start the Dispatcher with its Run now webhook and wait until that run has finished. */
export async function runNow(ctx, { parallel = 1 } = {}) {
  if (!ctx.runNowUrl) throw new Error("this profile has no Run now webhook (use --run-now-url)");
  const before = await waitLockFree(ctx);
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: parallel }, () => http("POST", ctx.runNowUrl, { body: { source: "run-tests" } })),
  );
  const end = t0 + 15 * 60_000;
  let lastNote = 0;
  for (;;) {
    await sleep(500);
    const lock = await ctx.c.n8n.getLock();
    const cycled = (lock?.updatedAt ?? "") !== (before?.updatedAt ?? "") && !lockHeld(lock);
    let mineRunning = false;
    if (ctx.dispatcherId) {
      const running = await ctx.c.n8n.unfinishedExecutions(ctx.dispatcherId);
      mineRunning = running.some((e) => e.mode === "webhook" && Date.parse(e.startedAt) >= t0 - 2000);
    }
    if (cycled && !mineRunning) break;
    if (Date.now() > end) throw new Error("Run now: no run took and released the lock within 15 minutes");
    if (Date.now() - lastNote > 30_000) {
      lastNote = Date.now();
      if (Date.now() - t0 > 30_000) ctx.log(`      ... waiting for the Run now pass (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }
  await sleep(1000);
}

/** Evaluate a step's "until" conditions against the current state. */
export async function evaluateUntil(ctx, until = {}) {
  const waitingFor = [];
  if (until.filesGone) {
    const input = ctx.c.folders.list("input");
    for (const f of until.filesGone) if (input.includes(f)) waitingFor.push(`${f} to leave the input folder`);
  }
  let batches;
  if (until.batchesExist) {
    batches = await ctx.c.n8n.listRows(ctx.profile.tables.batches);
    for (const f of until.batchesExist) if (!batches.some((b) => b.fileName === f)) waitingFor.push(`a batch row for ${f}`);
  }
  if (until.allFinal || until.cases) {
    const rows = await ctx.c.n8n.listRows(ctx.profile.tables.cases);
    const byKey = new Map(rows.map((r) => [r.caseKey, r]));
    if (until.allFinal) {
      const notFinal = ctx.groupExpected.filter((e) => !e.noCase && !kit.isFinal(byKey.get(e.fields.caseKey), ctx.maxAttempts));
      if (notFinal.length) waitingFor.push(`cases to finish: ${notFinal.map((e) => `${e.rowId} (${byKey.get(e.fields.caseKey)?.status ?? "not recorded"})`).join(", ")}`);
    }
    for (const [ref, want] of Object.entries(until.cases ?? {})) {
      const exp = ctx.groupExpected.find((e) => e.ref === ref);
      const row = exp && byKey.get(exp.fields.caseKey);
      const ok = row && Object.entries(want).every(([k, v]) => kit.sameValue(v, row[k]));
      if (!ok) waitingFor.push(`case ${ref} to reach ${JSON.stringify(want)}`);
    }
  }
  return { ok: waitingFor.length === 0, waitingFor };
}

/** Wait until the conditions hold and the Dispatcher has been idle for a few seconds. */
export async function waitForDispatcher(ctx, until, { timeoutSeconds = 300, nudgeAfterSeconds, quietSeconds = 3 } = {}) {
  const t0 = Date.now();
  let nudged = false;
  let lastNote = 0;
  for (;;) {
    const cond = await evaluateUntil(ctx, until);
    const b = await dispatcherBusy(ctx);
    if (cond.ok && !b.busy) {
      await sleep(quietSeconds * 1000);
      const b2 = await dispatcherBusy(ctx);
      const cond2 = await evaluateUntil(ctx, until);
      if (!b2.busy && cond2.ok && (b2.lock?.updatedAt ?? "") === (b.lock?.updatedAt ?? "")) return { ok: true, seconds: Math.round((Date.now() - t0) / 1000) };
      continue;
    }
    const elapsed = (Date.now() - t0) / 1000;
    if (nudgeAfterSeconds && !nudged && elapsed > nudgeAfterSeconds && !b.busy && ctx.runNowUrl) {
      ctx.log(`      nudge: no progress after ${Math.round(elapsed)}s, using Run now`);
      nudged = true;
      await runNow(ctx);
      continue;
    }
    if (elapsed > timeoutSeconds) {
      return { ok: false, reason: `timed out after ${timeoutSeconds}s waiting for ${cond.waitingFor.join("; ") || "the Dispatcher to finish"}${b.busy ? " (the Dispatcher is still busy)" : ""}` };
    }
    if (Date.now() - lastNote > 30_000) {
      lastNote = Date.now();
      if (elapsed > 20) ctx.log(`      ... ${Math.round(elapsed)}s: waiting for ${cond.waitingFor.join("; ") || "the Dispatcher to finish"}`);
    }
    await sleep(2000);
  }
}

// ---------------------------------------------------------------------------
// Docker (scenario 36 only)
// ---------------------------------------------------------------------------

function docker(args) {
  const r = spawnSync("docker", ["compose", ...args], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`docker compose ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
}

async function waitN8nUp(ctx, timeoutSeconds = 180) {
  const end = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    try {
      const r = await http("GET", `${ctx.profile.n8nUrl}/healthz`, { expect: null });
      if (r.status === 200) {
        await ctx.c.n8n.getLock();
        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`n8n did not come back within ${timeoutSeconds}s`);
    await sleep(2000);
  }
}

// ---------------------------------------------------------------------------
// State, reset and comparison
// ---------------------------------------------------------------------------

export async function resetEverything(ctx) {
  await ctx.c.rbis.reset();
  await ctx.c.n8n.deleteAllRows(ctx.profile.tables.cases);
  await ctx.c.n8n.deleteAllRows(ctx.profile.tables.batches);
  await ctx.c.n8n.freeLock();
  if (ctx.profile.cleanFolders) for (const key of ["input", "archive", "rejected", "reports"]) ctx.c.folders.clean(key);
  if (ctx.profile.cleanMailpit) await ctx.c.mail.deleteAll();
}

export async function collectState(ctx) {
  const [cases, batches, changes] = await Promise.all([
    ctx.c.n8n.listRows(ctx.profile.tables.cases),
    ctx.c.n8n.listRows(ctx.profile.tables.batches),
    ctx.c.rbis.changes(),
  ]);
  const folders = Object.fromEntries(["input", "archive", "rejected", "reports"].map((k) => [k, ctx.c.folders.list(k)]));
  const emails = ctx.profile.checkEmails ? await ctx.c.mail.list(ctx.data.settingsAssumed.summaryEmailTo) : null;
  return { cases, batches, changes, folders, emails };
}

const isSkip = (d) => d.startsWith("SKIP ");

function finalBatchOf(e) {
  return { file: e.final.batch?.file ?? e.file, drop: e.final.batch?.drop ?? 1 };
}

/** Compare a group's state with its expectations. @returns Map scenarioId -> { failures, notes } */
export function compareGroup(ctx, state, { checkpoint, groupScenarios } = {}) {
  const batchOf = kit.makeBatchOf(state.batches);
  const cmpCtx = { batchOf, reasonTexts: ctx.data.reasonTexts };
  const result = new Map(groupScenarios.map((id) => [id, { failures: [], notes: [] }]));
  const add = (id, diffs, prefix = "") => {
    const r = result.get(id);
    if (!r) return;
    for (const d of diffs) (isSkip(d) ? r.notes : r.failures).push(prefix + d);
  };
  const prefix = checkpoint ? `[at checkpoint ${checkpoint}] ` : "";
  const expected = ctx.groupExpected;

  for (const [id, diffs] of kit.compareCases(expected, state.cases, cmpCtx, { checkpoint })) add(id, diffs, prefix);

  for (const id of groupScenarios) {
    const scenario = ctx.data.scenarios.find((s) => s.id === id);
    for (const check of scenario.fileChecks ?? []) {
      const c = checkpoint ? check.checkpoints?.[checkpoint] : check;
      if (c) add(id, kit.compareFileCheck({ ...c, file: check.file }, state), prefix);
    }
    if (checkpoint) continue;
    add(id, kit.compareRbisChanges(scenario.rbisChanges, state.changes));
    for (const s of scenario.summaries ?? []) {
      const cases = expected.filter((e) => !e.noCase && finalBatchOf(e).file === s.file);
      add(id, kit.compareSummary(s.file, cases, state.emails));
    }
    for (const w of scenario.worklists ?? []) {
      const cases = expected.filter((e) => !e.noCase && finalBatchOf(e).file === w.file);
      const batchId = kit.batchesFor(state.batches, w.file).at(-1)?.batchId;
      if (!batchId) {
        add(id, [`worklist for ${JSON.stringify(w.file)}: no batch row, so no worklist to find`]);
        continue;
      }
      const name = state.folders.reports.find((n) => n === `${batchId}_worklist.xlsx`) ?? state.folders.reports.find((n) => n.includes(batchId) && /worklist/i.test(n));
      if (!name) {
        add(id, [`worklist for ${JSON.stringify(w.file)}: expected reports/${batchId}_worklist.xlsx; not found (${state.folders.reports.length} file(s) in reports)`]);
        continue;
      }
      try {
        const rows = readXlsx(ctx.c.folders.read("reports", name)).rows;
        add(id, kit.compareWorklist(w.file, rows, cases));
      } catch (err) {
        add(id, [`worklist ${name}: cannot be read (${err.message})`]);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Running a group
// ---------------------------------------------------------------------------

// The bytes of a test file. They are built in memory from scenarios.json, which gives
// exactly the committed test-data/spreadsheets/ files when those are up to date (the
// runner warns if not), and also covers ~$temp-book.xlsx, which Git ignores.
function fileBytes(ctx, name) {
  const bytes = ctx.builtFiles.get(name);
  if (!bytes) throw new Error(`no test file called ${name}`);
  return bytes;
}

async function runStep(ctx, step, record) {
  const say = (text) => ctx.log(`    - ${text}`);
  switch (step.do) {
    case "outage":
      await ctx.c.rbis.outage(step.body);
      say(`outage on the pretend RBIS: ${JSON.stringify(step.body)}`);
      return;
    case "outageOff":
      await ctx.c.rbis.outageOff();
      say("outage off");
      return;
    case "addAccount":
      await ctx.c.rbis.addAccount(step.ref, ctx.data.accountsAddedAtRunTime[step.ref]);
      say(`account ${step.ref} added to the pretend RBIS`);
      return;
    case "drop":
      for (const f of step.files) ctx.c.folders.write("input", f, fileBytes(ctx, f), { backdateSeconds: step.backdateSeconds ?? 0 });
      say(`dropped ${step.files.join(", ")}${step.backdateSeconds ? ` (already settled: ${step.backdateSeconds}s old)` : ""}`);
      return;
    case "runNow":
      say(`Run now${step.parallel > 1 ? ` x${step.parallel}, at the same moment` : ""}`);
      await runNow(ctx, { parallel: step.parallel ?? 1 });
      return;
    case "runNowUntil": {
      let runs = 0;
      for (;;) {
        const cond = await evaluateUntil(ctx, step.until);
        if (cond.ok) break;
        if (runs >= step.maxRuns) {
          record.groupFailures.push(`after ${runs} Run now pass(es), still waiting for ${cond.waitingFor.join("; ")}`);
          break;
        }
        runs += 1;
        say(`Run now (${runs}): waiting for ${cond.waitingFor.join("; ")}`);
        await runNow(ctx);
        const w = await waitForDispatcher(ctx, {}, { timeoutSeconds: 300 });
        if (!w.ok) record.groupFailures.push(w.reason);
      }
      return;
    }
    case "waitForDispatcher": {
      say(`waiting for the Dispatcher (up to ${step.timeoutSeconds ?? 300}s)`);
      const w = await waitForDispatcher(ctx, step.until, { timeoutSeconds: step.timeoutSeconds, nudgeAfterSeconds: step.nudgeAfterSeconds });
      if (w.ok) say(`done after ${w.seconds}s`);
      else record.groupFailures.push(w.reason);
      return;
    }
    case "checkpoint": {
      const state = await collectState(ctx);
      const r = compareGroup(ctx, state, { checkpoint: step.name, groupScenarios: record.groupScenarios });
      for (const [id, { failures, notes }] of r) {
        record.results.get(id).failures.push(...failures);
        record.results.get(id).notes.push(...notes);
      }
      say(`checkpoint ${step.name} compared`);
      return;
    }
    case "stopN8n":
      if (!ctx.profile.mayRestartN8n) throw new Error("this profile may not stop n8n");
      say("stopping n8n (docker compose stop n8n)");
      docker(["stop", "n8n"]);
      ctx.n8nStopped = true;
      return;
    case "startN8n":
      say("starting n8n (docker compose start n8n)");
      docker(["start", "n8n"]);
      ctx.n8nStopped = false;
      await waitN8nUp(ctx);
      ctx.dispatcherId = ctx.dispatcherName ? await ctx.c.n8n.findWorkflowId(ctx.dispatcherName) : null;
      return;
    default:
      throw new Error(`unknown step ${step.do}`);
  }
}

export async function runGroup(ctx, group, wanted) {
  const t0 = Date.now();
  ctx.groupExpected = kit.expectedCases(ctx.data).filter((e) => group.scenarios.includes(e.scenarioId));
  const record = {
    groupScenarios: group.scenarios,
    results: new Map(group.scenarios.map((id) => [id, { failures: [], notes: [] }])),
    groupFailures: [],
  };
  ctx.log(`\nGroup ${group.id}: ${group.title} (scenarios ${group.scenarios.join(", ")})`);
  try {
    const idle = await waitForDispatcher(ctx, {}, { timeoutSeconds: 600 });
    if (!idle.ok) throw new Error(`the Dispatcher is busy before the group starts: ${idle.reason}`);
    await resetEverything(ctx);
    ctx.log("    - reset: pretend RBIS, Cases and Batches tables, lock, folders" + (ctx.profile.cleanMailpit ? ", test mailbox" : ""));
    for (const step of group.steps) await runStep(ctx, step, record);
    const state = await collectState(ctx);
    for (const [id, { failures, notes }] of compareGroup(ctx, state, { groupScenarios: group.scenarios })) {
      record.results.get(id).failures.push(...failures);
      record.results.get(id).notes.push(...notes);
    }
    const extra = kit.unexpectedCases(ctx.groupExpected, state.cases);
    if (extra.length) record.groupFailures.push(`${extra.length} case(s) in the table that no scenario expects: ${extra.map((r) => r.caseKey).join("; ")}`);
  } catch (err) {
    record.groupFailures.push(`group stopped: ${err.message}`);
  } finally {
    if (ctx.n8nStopped) {
      // Never leave n8n stopped because a group failed part-way.
      try {
        docker(["start", "n8n"]);
        ctx.n8nStopped = false;
        await waitN8nUp(ctx);
      } catch (err) {
        record.groupFailures.push(`could not restart n8n: ${err.message}`);
      }
    }
    try {
      await ctx.c.rbis.outageOff();
    } catch {
      // reported elsewhere
    }
  }
  record.seconds = Math.round((Date.now() - t0) / 1000);
  return { group, wanted, ...record };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function formatReport(data, runs, skipped, { verbose = false, seconds } = {}) {
  const lines = [];
  let pass = 0;
  let fail = 0;
  for (const run of runs) {
    lines.push(`\n${run.group.id} (${run.seconds}s)`);
    for (const f of run.groupFailures) lines.push(`  GROUP  ${f}`);
    for (const id of run.wanted) {
      const s = data.scenarios.find((x) => x.id === id);
      const r = run.results.get(id);
      const failures = [...r.failures, ...run.groupFailures.map((f) => `group problem: ${f}`)];
      const ok = failures.length === 0;
      ok ? pass++ : fail++;
      lines.push(`  ${ok ? "PASS" : "FAIL"}  ${String(id).padStart(2)}  ${s.title}`);
      for (const d of r.failures) lines.push(`          - ${d}`);
      if (verbose) for (const n of r.notes) lines.push(`          . ${n}`);
      else if (r.notes.length) lines.push(`          . ${r.notes.length} check(s) skipped in this profile (--verbose to list)`);
    }
  }
  for (const s of skipped) lines.push(`\nNot run: scenario(s) ${s.wanted.join(", ")} (${s.group.id}): ${s.why}`);
  const notRun = skipped.reduce((n, s) => n + s.wanted.length, 0);
  lines.push(`\n${pass} passed, ${fail} failed${notRun ? `, ${notRun} not run` : ""}${seconds !== undefined ? ` in ${Math.floor(seconds / 60)}m ${seconds % 60}s` : ""}.`);
  return { text: lines.join("\n"), pass, fail, notRun };
}

// ---------------------------------------------------------------------------
// Self-check: proves the runner without the Dispatcher (trackC profile)
// ---------------------------------------------------------------------------

const OPERATION_ENDPOINTS = {
  terminate: (c) => ["POST", "terminate", { endDate: c.endDate }],
  addLiableParty: (c) => ["POST", "liable-parties", { name: c.name, type: c.type, startDate: c.startDate }],
  createDetail: (c) => ["POST", "details", { startDate: c.startDate, tenants: c.tenants }],
  setContact: (c) => ["PUT", "contact", { name: c.name, email: c.email, phone: c.phone }],
  setForwardingAddress: (c) => ["PUT", "forwarding-address", { address: c.address }],
};

/** Make the tables, folders and pretend RBIS look as the workflows should leave them. */
export async function simulateGroup(ctx, group) {
  const data = ctx.data;
  const expected = kit.expectedCases(data).filter((e) => group.scenarios.includes(e.scenarioId));
  const layouts = kit.fileLayouts(data);
  const checksByFile = new Map();
  for (const id of group.scenarios) for (const c of data.scenarios.find((s) => s.id === id).fileChecks ?? []) checksByFile.set(c.file, c);

  // Accounts added during the run.
  for (const step of group.steps) if (step.do === "addAccount") await ctx.c.rbis.addAccount(step.ref, data.accountsAddedAtRunTime[step.ref]);

  // Batches: one row per drop of each file, as the Dispatcher would record them.
  const batchRows = [];
  let n = 0;
  for (const step of group.steps.filter((s) => s.do === "drop")) {
    for (const f of step.files) {
      const check = checksByFile.get(f);
      if (check?.batchCount === 0) continue;
      n += 1;
      const batchId = `2026-11-19T10-00-${String(n).padStart(2, "0")}_${f}`;
      batchRows.push({
        batchId,
        fileName: f,
        status: check?.batch?.status ?? "received",
        readAttempts: check?.batch?.readAttempts ?? 0,
        rowCount: layouts.get(f).rows.length,
        receivedAt: new Date().toISOString(),
        summarySentAt: new Date().toISOString(),
      });
    }
  }
  if (batchRows.length) await ctx.c.n8n.insertRows(ctx.profile.tables.batches, batchRows);
  const batchOf = (file, drop = 1) => batchRows.filter((b) => b.fileName === file)[drop - 1]?.batchId;

  // Cases, as the Performer should leave them.
  const caseRows = expected
    .filter((e) => !e.noCase)
    .map((e) => {
      const x = e.final;
      const fb = finalBatchOf(e);
      return {
        ...e.fields,
        coveredByCaseKey: e.coveredByCaseKey,
        isLeadRow: x.isLeadRow,
        jointTenants: x.isLeadRow ? JSON.stringify(x.jointTenants ?? []) : "",
        batchId: batchOf(fb.file, fb.drop),
        status: x.status,
        reasonCode: x.reasonCode ?? "",
        reasonText: x.reasonCode ? data.reasonTexts[x.reasonCode] : "",
        outcome: x.outcome ?? "",
        urgent: x.urgent ?? false,
        stepsDone: JSON.stringify(x.stepsDone ?? []),
        attempts: x.attempts ?? 1,
        submissions: x.submissions ?? 1,
        previousResult: x.previousResult
          ? JSON.stringify({ status: x.previousResult.status, reasonCode: x.previousResult.reasonCode, batchId: batchOf(x.previousResult.batch.file, x.previousResult.batch.drop ?? 1) })
          : "",
        lastAttemptAt: new Date().toISOString(),
        errorDetail: x.status === "failed" ? "Simulated: RBIS answered 503" : "",
      };
    });
  if (caseRows.length) await ctx.c.n8n.insertRows(ctx.profile.tables.cases, caseRows);

  // The pretend RBIS's change log: replay the expected calls (this also proves they are possible).
  const replayProblems = [];
  for (const id of group.scenarios) {
    const scenario = data.scenarios.find((s) => s.id === id);
    for (const [ref, list] of Object.entries(scenario.rbisChanges ?? {})) {
      for (const change of list) {
        const [method, action, body] = OPERATION_ENDPOINTS[change.operation](change);
        if (change.replyLost) await ctx.c.rbis.outage({ mode: "afterChange", ref, operations: [change.operation], count: 1 });
        const r = await ctx.c.rbis.raw(method, `/accounts/${ref}/${action}`, body, null);
        const okStatus = change.replyLost ? r.status === 503 : r.status < 300;
        if (!okStatus) replayProblems.push(`scenario ${id}: ${change.operation} on ${ref} answered ${r.status} ${JSON.stringify(r.json)}`);
      }
    }
  }

  // Folders: where each file should end up, and the worklists.
  for (const step of group.steps.filter((s) => s.do === "drop")) {
    for (const f of step.files) {
      const where = checksByFile.get(f)?.endsIn ?? (layouts.get(f).kind === "excelOwnerFile" ? "input" : "archive");
      const bytes = ctx.builtFiles.get(f);
      if (where === "input") ctx.c.folders.write("input", f, bytes);
      else ctx.c.folders.write(where, `${batchRows.find((b) => b.fileName === f)?.batchId ?? "x"}`.replace(/_.*$/, "") + `_${f}`, bytes);
    }
  }
  for (const id of group.scenarios) {
    for (const w of data.scenarios.find((s) => s.id === id).worklists ?? []) {
      const cases = expected.filter((e) => !e.noCase && finalBatchOf(e).file === w.file);
      ctx.c.folders.write("reports", `${batchOf(w.file)}_worklist.xlsx`, worklistXlsx(cases, data.reasonTexts));
    }
  }
  return { replayProblems, batchOf };
}

/** A worklist as the design describes it: urgent cases first, reason in plain English. */
export function worklistXlsx(cases, reasonTexts, { urgentLast = false } = {}) {
  const members = kit.expectedWorklist(cases);
  members.sort((a, b) => (urgentLast ? -1 : 1) * (Number(Boolean(b.final.urgent)) - Number(Boolean(a.final.urgent))) || a.fields.rowNumber - b.fields.rowNumber);
  return buildXlsx({
    header: ["Urgent", "Status", "Reason", "Account", "Tenant", "Address", "RBIS calls made"],
    rows: members.map((e) => [e.final.urgent ? "URGENT" : "", e.final.status, reasonTexts[e.final.reasonCode] ?? "", e.fields.accountRef, e.fields.tenantName, e.fields.address, e.final.urgent ? (e.final.stepsDone ?? []).join(", ") : ""]),
    sheetName: "Worklist",
  });
}

async function selfCheck(ctx) {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    ctx.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  };
  const expectThrow = async (fn) => {
    try {
      await fn();
      return null;
    } catch (err) {
      return err;
    }
  };
  ctx.log(`Self-check of the test runner against the ${ctx.profile.name} resources (no workflows needed)\n`);

  // 1. Pretend RBIS: reset, outage scoped by account, recovery, reset clears everything.
  ctx.log("Pretend RBIS");
  const h = await ctx.c.rbis.health();
  check("health", h.status === "ok", `${h.accounts} accounts`);
  await ctx.c.rbis.reset();
  check("reset empties the change log", (await ctx.c.rbis.changes()).length === 0);
  await ctx.c.rbis.outage({ mode: "before", ref: "AC100001", operations: ["terminate"], count: 1 });
  const other = await ctx.c.rbis.raw("POST", "/accounts/AC100004/terminate", { endDate: "2026-10-31" }, null);
  check("outage scoped by ref leaves other accounts alone", other.status === 200, `AC100004 answered ${other.status}`);
  const first = await ctx.c.rbis.raw("POST", "/accounts/AC100001/terminate", { endDate: "2026-11-01" }, null);
  const second = await ctx.c.rbis.raw("POST", "/accounts/AC100001/terminate", { endDate: "2026-11-01" }, null);
  check("outage fails the first matching call, then recovers (count 1)", first.status === 503 && second.status === 200, `answered ${first.status} then ${second.status}`);
  await ctx.c.rbis.outage({ mode: "before", ref: "AC100003", includeReads: true });
  await ctx.c.rbis.reset();
  const afterReset = await ctx.c.rbis.raw("GET", "/accounts/AC100003", undefined, null);
  check("reset switches the outage off and reloads the accounts", afterReset.status === 200 && (await ctx.c.rbis.changes()).length === 0 && afterReset.json.current[0]?.party === "Example Housing Association");

  // 2. Tables through the n8n public API.
  ctx.log("\nn8n tables (public API)");
  await ctx.c.n8n.insertRows(ctx.profile.tables.cases, [{ caseKey: "SELF-CHECK", status: "new" }]);
  await ctx.c.n8n.insertRows(ctx.profile.tables.batches, [{ batchId: "SELF-CHECK", fileName: "x.xlsx" }]);
  await ctx.c.n8n.updateRows(ctx.profile.tables.lock, [{ columnName: "name", condition: "eq", value: "dispatcher" }], { lockedAt: new Date().toISOString(), lockedBy: "self-check" });
  check("insert and read rows", (await ctx.c.n8n.listRows(ctx.profile.tables.cases)).some((r) => r.caseKey === "SELF-CHECK"));
  check("a held lock is seen as busy", (await dispatcherBusy(ctx)).busy === true);
  await resetEverything(ctx);
  const lock = await ctx.c.n8n.getLock();
  check("reset clears Cases and Batches and frees the lock",
    (await ctx.c.n8n.listRows(ctx.profile.tables.cases)).length === 0 && (await ctx.c.n8n.listRows(ctx.profile.tables.batches)).length === 0 && lock && !lock.lockedAt && lock.lockedBy === "");
  check("an idle Dispatcher is seen as idle", (await dispatcherBusy(ctx)).busy === false);
  check("reset empties the folders", ["input", "archive", "rejected", "reports"].every((k) => ctx.c.folders.list(k).length === 0));

  // 3. Simulated runs: tables, RBIS and folders as the workflows should leave them. Every scenario must PASS.
  ctx.log("\nComparator: simulated correct results (each must PASS)");
  for (const group of ctx.data.groups) {
    ctx.groupExpected = kit.expectedCases(ctx.data).filter((e) => group.scenarios.includes(e.scenarioId));
    await resetEverything(ctx);
    const sim = await simulateGroup(ctx, group);
    check(`group ${group.id}: expected RBIS calls are possible on the pretend RBIS`, sim.replayProblems.length === 0, sim.replayProblems.join("; "));
    const state = await collectState(ctx);
    const r = compareGroup(ctx, state, { groupScenarios: group.scenarios });
    for (const [id, { failures }] of r) check(`group ${group.id}: scenario ${id} passes`, failures.length === 0, failures.join(" | "));
    const extra = kit.unexpectedCases(ctx.groupExpected, state.cases);
    check(`group ${group.id}: no unexpected cases`, extra.length === 0);
    // Checkpoints compare too (they describe other moments, so only check they run).
    for (const step of group.steps.filter((s) => s.do === "checkpoint")) compareGroup(ctx, state, { checkpoint: step.name, groupScenarios: group.scenarios });

    // 4. Wrong results in the main group: each must FAIL with a useful difference.
    if (group.id !== "main") continue;
    ctx.log("\nComparator: deliberately wrong results in the main group (each must FAIL)");
    const exp = (rowId) => ctx.groupExpected.find((e) => e.rowId === rowId);
    const byKey = (rowId) => [{ columnName: "caseKey", condition: "eq", value: exp(rowId).fields.caseKey }];
    const T = ctx.profile.tables;
    await ctx.c.n8n.updateRows(T.cases, byKey("amy"), { status: "referred" });
    await ctx.c.n8n.deleteRows(T.cases, byKey("bruno"));
    const cara = (await ctx.c.n8n.listRows(T.cases)).find((row) => row.caseKey === exp("cara").fields.caseKey);
    const { id: _id, createdAt: _c, updatedAt: _u, ...caraCopy } = cara;
    await ctx.c.n8n.insertRows(T.cases, [caraCopy]);
    await ctx.c.n8n.updateRows(T.cases, byKey("alan"), { stepsDone: JSON.stringify(["addLiableParty:example housing association", "endLiability", "setForwardingAddress"]) });
    await ctx.c.n8n.updateRows(T.cases, byKey("theo"), { startDate: "2026-10-31" });
    await ctx.c.rbis.raw("PUT", "/accounts/AC100005/contact", { name: "Beth Sample", email: "beth.sample@example.test", phone: null });
    const mia = kit.expectedCases(ctx.data).find((e) => e.rowId === "mia");
    await ctx.c.n8n.insertRows(T.cases, [{ ...mia.fields, status: "referred", reasonCode: "ADDRESS_NOT_FOUND" }]);
    await ctx.c.n8n.insertRows(T.cases, [{ caseKey: "TENANCY_START|AC100099|99 nowhere|nobody test|2026-11-01", status: "new" }]);
    const mainCases = ctx.groupExpected.filter((e) => !e.noCase && finalBatchOf(e).file === "harsll-main.xlsx");
    ctx.c.folders.write("reports", `${sim.batchOf("harsll-main.xlsx")}_worklist.xlsx`, worklistXlsx(mainCases, ctx.data.reasonTexts, { urgentLast: true }));
    ctx.c.folders.clean("rejected");
    await ctx.c.n8n.updateRows(T.batches, [{ columnName: "fileName", condition: "eq", value: "no-rows.xlsx" }], { status: "received" });

    const bad = compareGroup(ctx, await collectState(ctx), { groupScenarios: group.scenarios });
    const wantFail = {
      1: 'case amy: status: expected "updated", got "referred"',
      2: "case bruno: missing from the Cases table",
      3: "case cara: 2 rows in the Cases table",
      4: "case alan: stepsDone: expected",
      5: "RBIS AC100005: change 3 not expected: setContact",
      22: "urgent cases are not listed first",
      30: "case mia: should not exist",
      37: 'case theo: startDate: expected "2026-11-01", got "2026-10-31"',
    };
    for (const [id, text] of Object.entries(wantFail)) {
      const failures = bad.get(Number(id)).failures;
      check(`scenario ${id} fails with: ${text}`, failures.some((f) => f.includes(text)), failures.length ? failures[0] : "it passed");
    }
    const f30 = bad.get(30).failures;
    check("scenario 30 also reports the missing rejected file", f30.some((f) => f.includes('file "missing-column.xlsx": not found in the rejected folder')));
    check("scenario 30 also reports the wrong batch status", f30.some((f) => f.includes('file "no-rows.xlsx": batch status: expected "rejected", got "received"')));
    const others = [...bad].filter(([id]) => !(id in wantFail));
    check("every other scenario still passes", others.every(([, r]) => r.failures.length === 0), others.filter(([, r]) => r.failures.length).map(([id, r]) => `${id}: ${r.failures[0]}`).join(" | "));
    const extraAfter = kit.unexpectedCases(ctx.groupExpected, (await collectState(ctx)).cases).map((r) => r.caseKey);
    check("an unexpected case is reported for the group", extraAfter.includes("TENANCY_START|AC100099|99 nowhere|nobody test|2026-11-01"));
  }

  await resetEverything(ctx);
  ctx.log("\nCleaned up: pretend RBIS reset, tables emptied, lock freed, folders emptied.");
  const failed = results.filter((r) => !r.ok);
  ctx.log(`\nSelf-check: ${results.length - failed.length} passed, ${failed.length} failed.`);
  return failed.length === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: node scripts/run-tests.mjs [options]

  --profile production|trackC   which tables, pretend RBIS and folders to use (default production)
  --only 1,2,6                  run only the groups that contain these scenarios, and report only them
  --include-slow                also run scenario 36 (stops and starts the n8n container; up to 15 minutes)
  --list                        show the groups, their scenarios and rough timings; run nothing
  --self-check                  check the runner itself against the profile's own resources (no workflows)
  --verbose                     also list checks that were skipped
  --run-now-url URL             override the Dispatcher's Run now webhook
  --dispatcher-name NAME        override the Dispatcher's workflow name (to watch its runs)

Guide: docs/testing.md`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${usage()}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(usage());
    return;
  }
  const data = kit.loadScenarios(repoRoot);
  let selection;
  try {
    selection = selectGroups(data, opts);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const { chosen, skipped } = selection;

  if (opts.list) {
    let total = 0;
    for (const g of data.groups) {
      const secs = estimateSeconds(g);
      const run = chosen.some((c) => c.group === g);
      if (run) total += secs;
      console.log(`${run ? "*" : " "} ${g.id.padEnd(22)} ~${Math.round(secs / 60)} min  ${g.title}${g.slow ? " [slow]" : ""}${g.productionOnly ? " [production only]" : ""}`);
      for (const id of g.scenarios) console.log(`      ${String(id).padStart(2)}  ${data.scenarios.find((s) => s.id === id).title}`);
    }
    console.log(`\n* = would run with these options; about ${Math.round(total / 60)} minutes.`);
    return;
  }

  const profile = { ...PROFILES[opts.profile] };
  if (opts.runNowUrl !== undefined) profile.runNowUrl = opts.runNowUrl;
  if (opts.dispatcherName !== undefined) profile.dispatcherName = opts.dispatcherName;
  const env = readEnv();
  if (!env.N8N_API_KEY) {
    console.error("N8N_API_KEY is missing or empty in .env. See docs/setup/02-connect-mcp-servers.md.");
    process.exit(2);
  }
  const ctx = {
    data,
    profile,
    c: makeClients(profile, env.N8N_API_KEY),
    runNowUrl: profile.runNowUrl,
    dispatcherName: profile.dispatcherName,
    maxAttempts: data.settingsAssumed.maxAttempts,
    builtFiles: buildAllFiles(data),
    log: (t) => console.log(t),
  };

  const stale = staleFiles(ctx.builtFiles).filter((n) => !n.startsWith("~$"));
  if (stale.length) console.warn(`Note: test-data/spreadsheets is out of date (${stale.join(", ")}). Run node scripts/make-test-spreadsheets.mjs. The tests use copies built from scenarios.json.`);

  if (opts.selfCheck) {
    if (opts.profile === "production") {
      console.error("--self-check writes made-up rows into the tables; use it with --profile trackC (or another non-production profile).");
      process.exit(2);
    }
    const ok = await selfCheck(ctx);
    process.exit(ok ? 0 : 1);
  }

  if (!ctx.runNowUrl) {
    console.error(`Profile ${profile.name} has no Dispatcher Run now webhook, so the scenarios cannot run. Use --self-check, or --run-now-url.`);
    process.exit(2);
  }
  try {
    await ctx.c.rbis.health();
    ctx.dispatcherId = ctx.dispatcherName ? await ctx.c.n8n.findWorkflowId(ctx.dispatcherName) : null;
  } catch (err) {
    console.error(`Cannot start: ${err.message}`);
    process.exit(2);
  }
  if (ctx.dispatcherName && !ctx.dispatcherId) console.warn(`Note: no workflow named "${ctx.dispatcherName}"; watching the lock only.`);

  const started = Date.now();
  console.log(`HARSLL tests, profile ${profile.name}, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
  console.log(`Groups: ${chosen.map((c) => c.group.id).join(", ") || "none"}; about ${Math.round(chosen.reduce((s, c) => s + estimateSeconds(c.group), 0) / 60)} minutes.`);
  const runs = [];
  for (const { group, wanted } of chosen) runs.push(await runGroup(ctx, group, wanted));
  const report = formatReport(data, runs, skipped, { verbose: opts.verbose, seconds: Math.round((Date.now() - started) / 1000) });
  console.log(report.text);
  process.exit(report.fail === 0 && runs.every((r) => r.groupFailures.length === 0) ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Test run stopped: ${err.stack ?? err.message}`);
    process.exit(2);
  });
}

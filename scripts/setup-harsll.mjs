#!/usr/bin/env node
// Installs or updates HARSLL in an n8n through its public API.
//
//   node scripts/setup-harsll.mjs --dry-run
//   node scripts/setup-harsll.mjs --env-file .env.bcc-test --settings config/bcc-test.local.json
//
// What it does, in order (run with --help for every flag):
//   1. Checks everything first (env file, settings file, workflow files, the email credential,
//      the tables and workflows already in the target) and reports every problem at once.
//      Nothing is written if there is a problem.
//   2. Finds or creates the three tables (harsll_cases, harsll_batches, harsll_lock), adds any
//      missing columns, and makes sure the lock table has its one "dispatcher" row.
//   3. Creates or updates the six workflows from workflows/*.json, found by exact name, in the
//      order Settings, Performer: RBIS adapter, Performer, Dispatcher: take in a file,
//      Dispatcher: report a batch, Dispatcher. The real table and workflow IDs (and any settings
//      overrides) are written into Settings; the Dispatcher's "Load settings" step is pointed at
//      the Settings workflow; the file trigger's folder is set to settings.inputFolder; every
//      email step is pointed at the target's SMTP credential.
//   4. Publishes them all, the Dispatcher last (a called workflow runs only its published version).
//
// Running it again updates in place: a workflow whose content already matches is left alone.
// Secrets: the API key is read from the env file only and never printed. Credential secrets
// are never handled here, except the Mailpit test mailbox, which has none.
//
// Pure helpers are exported for scripts/setup-harsll.test.mjs; the network part runs only when
// this file is run directly.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv, repoRoot } from "./lib/env.mjs";

// ---------------------------------------------------------------------------------------------
// What HARSLL consists of
// ---------------------------------------------------------------------------------------------

export const WORKFLOWS = [
  { key: "settings", file: "harsll-settings.json", name: "HARSLL – Settings" },
  { key: "adapter", file: "harsll-performer-rbis-adapter.json", name: "HARSLL – Performer: RBIS adapter", settingsKey: "adapterWorkflowId" },
  { key: "performer", file: "harsll-performer.json", name: "HARSLL – Performer", settingsKey: "performerWorkflowId" },
  { key: "takeInFile", file: "harsll-dispatcher-take-in-a-file.json", name: "HARSLL – Dispatcher: take in a file", settingsKey: "takeInFileWorkflowId" },
  { key: "reportBatch", file: "harsll-dispatcher-report-a-batch.json", name: "HARSLL – Dispatcher: report a batch", settingsKey: "reportBatchWorkflowId" },
  { key: "dispatcher", file: "harsll-dispatcher.json", name: "HARSLL – Dispatcher" },
];

// Columns in the order the tested local install has them (see docs/design/interfaces.md, Tables).
export const TABLES = [
  {
    key: "cases", name: "harsll_cases", settingsKey: "casesTableId",
    columns: [
      ["caseKey", "string"], ["tenancyKey", "string"], ["batchId", "string"], ["rowNumber", "number"],
      ["changeReason", "string"], ["accountRef", "string"], ["address", "string"], ["postcode", "string"],
      ["isFlat", "boolean"], ["tenantName", "string"], ["isLeadRow", "boolean"], ["jointTenants", "string"],
      ["coveredByCaseKey", "string"], ["startDate", "string"], ["endDate", "string"], ["relevantDate", "string"],
      ["forwardingAddress", "string"], ["contactEmail", "string"], ["contactPhone", "string"], ["sourceSystem", "string"],
      ["status", "string"], ["reasonCode", "string"], ["reasonText", "string"], ["outcome", "string"],
      ["urgent", "boolean"], ["stepsDone", "string"], ["attempts", "number"], ["submissions", "number"],
      ["previousResult", "string"], ["lastAttemptAt", "date"], ["errorDetail", "string"],
    ],
  },
  {
    key: "batches", name: "harsll_batches", settingsKey: "batchesTableId",
    columns: [
      ["batchId", "string"], ["fileName", "string"], ["status", "string"], ["readAttempts", "number"],
      ["rowCount", "number"], ["receivedAt", "date"], ["summarySentAt", "date"],
    ],
  },
  {
    key: "lock", name: "harsll_lock", settingsKey: "lockTableId",
    columns: [["name", "string"], ["lockedAt", "date"], ["lockedBy", "string"]],
  },
];

export const LOCK_ROW = { name: "dispatcher", lockedAt: null, lockedBy: "" };

// Settings keys the script always fills in itself.
export const ID_KEYS = [...TABLES.map((t) => t.settingsKey), ...WORKFLOWS.filter((w) => w.settingsKey).map((w) => w.settingsKey)];

export const NODES = {
  settings: "Settings", // Settings workflow: Set node holding the settings JSON
  loadSettings: "Load settings", // Dispatcher: calls the Settings workflow by fixed ID
  fileTrigger: "File added to input folder", // Dispatcher: Local File Trigger, folder fixed on the node
  runNow: "Run now", // Dispatcher: POST /webhook/harsll-run-now
};

export const MAILPIT_CREDENTIAL = {
  name: "Mailpit (local test mailbox)",
  type: "smtp",
  // Mailpit takes mail without a login. No secret here.
  data: { host: "mailpit", port: 1025, secure: false, user: "", password: "" },
};

// Workflow settings the public API accepts on create and update.
export const ALLOWED_WORKFLOW_SETTINGS = [
  "saveExecutionProgress", "saveManualExecutions", "saveDataErrorExecution", "saveDataSuccessExecution",
  "executionTimeout", "errorWorkflow", "timezone", "executionOrder", "callerPolicy", "callerIds", "availableInMCP",
];

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const FLAGS = {
  "--env-file": "value",
  "--settings": "value",
  "--email-credential": "value",
  "--email-credential-id": "value",
  "--create-mailpit-credential": "switch",
  "--without-run-now": "switch",
  "--leave-dispatcher-off": "switch",
  "--dry-run": "switch",
  "--help": "switch",
};

export const HELP = `Install or update HARSLL in an n8n through its public API.

Usage: node scripts/setup-harsll.mjs [options]

  --env-file <path>            Env file with N8N_API_URL and N8N_API_KEY of the target n8n.
                               Default: .env in the repo. The key is never accepted on the command line.
  --settings <path>            JSON file of Settings overrides (see config/settings.example.json).
                               ID settings are always filled in by this script and may not be given.
  --email-credential <name>    Name of the SMTP credential the email steps use.
                               Default: "${MAILPIT_CREDENTIAL.name}".
  --email-credential-id <id>   Use this credential ID without looking it up. Only for an API key that
                               may not list credentials (listing needs the owner or an admin).
  --create-mailpit-credential  If the default Mailpit credential is missing, create it (test only).
  --without-run-now            Switch off the Dispatcher's "Run now" webhook (production).
                               Without it, "Run now" is switched on.
  --leave-dispatcher-off       Publish everything except the Dispatcher, so nothing starts yet.
                               If the Dispatcher is already published, it is unpublished.
  --dry-run                    Check everything and print the plan. Changes nothing.
  --help                       Show this text.

Exit code 0 when everything worked (or the dry run found no problems), 1 otherwise.`;

export function parseArgs(argv) {
  const options = {
    envFile: null, settingsFile: null, emailCredential: MAILPIT_CREDENTIAL.name, emailCredentialId: null,
    createMailpitCredential: false, withoutRunNow: false, leaveDispatcherOff: false, dryRun: false, help: false,
  };
  const problems = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) { value = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const kind = FLAGS[arg];
    if (!arg.startsWith("--")) { problems.push(`Unexpected argument "${arg}". Options start with --; run with --help.`); continue; }
    if (!kind) {
      problems.push(/key|token|password|secret/i.test(arg)
        ? `Unknown option ${arg}. Secrets are never taken on the command line: put N8N_API_KEY in the env file.`
        : `Unknown option ${arg}. Run with --help to see the options.`);
      continue;
    }
    if (kind === "value") {
      if (value === undefined) value = argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) { problems.push(`${arg} needs a value.`); continue; }
    } else if (value !== undefined) {
      problems.push(`${arg} does not take a value.`);
      continue;
    }
    switch (arg) {
      case "--env-file": options.envFile = value; break;
      case "--settings": options.settingsFile = value; break;
      case "--email-credential": options.emailCredential = value; break;
      case "--email-credential-id": options.emailCredentialId = value; break;
      case "--create-mailpit-credential": options.createMailpitCredential = true; break;
      case "--without-run-now": options.withoutRunNow = true; break;
      case "--leave-dispatcher-off": options.leaveDispatcherOff = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--help": options.help = true; break;
    }
  }
  if (options.createMailpitCredential && options.emailCredential !== MAILPIT_CREDENTIAL.name) {
    problems.push(`--create-mailpit-credential only creates "${MAILPIT_CREDENTIAL.name}". Another email credential must be created by a person in the n8n editor.`);
  }
  if (options.createMailpitCredential && options.emailCredentialId) {
    problems.push("--create-mailpit-credential and --email-credential-id cannot be used together.");
  }
  return { options, problems };
}

// ---------------------------------------------------------------------------------------------
// Env file and settings file
// ---------------------------------------------------------------------------------------------

// Returns { url, key, problems }. The key is returned for use, never for printing.
export function readTarget(envText, envPath) {
  const problems = [];
  const env = parseEnv(envText);
  let url = (env.N8N_API_URL || "").trim();
  const key = (env.N8N_API_KEY || "").trim();
  if (!url) problems.push(`N8N_API_URL is missing or empty in ${envPath}.`);
  else if (!/^https?:\/\//.test(url)) problems.push(`N8N_API_URL in ${envPath} must start with http:// or https://.`);
  if (!key) problems.push(`N8N_API_KEY is missing or empty in ${envPath}. Create one in n8n: Settings > n8n API.`);
  url = url.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return { url, key, problems };
}

// The settings file is a flat object of Settings keys. Keys starting with "_" are comments.
export function parseOverrides(text, path) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { overrides: {}, problems: [`${path} is not valid JSON: ${e.message}`] }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { overrides: {}, problems: [`${path} must hold one JSON object of settings.`] };
  return { overrides: Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("_"))), problems: [] };
}

export function validateOverrides(defaults, overrides) {
  const problems = [];
  const kind = (v) => (Array.isArray(v) ? "a list" : v === null ? "empty" : typeof v === "object" ? "an object" : `a ${typeof v}`);
  for (const [key, value] of Object.entries(overrides)) {
    if (ID_KEYS.includes(key)) problems.push(`Setting "${key}" is an ID: the script fills it in. Remove it from the settings file.`);
    else if (!(key in defaults)) problems.push(`Unknown setting "${key}". Known settings: ${Object.keys(defaults).filter((k) => !ID_KEYS.includes(k)).join(", ")}.`);
    else if (kind(value) !== kind(defaults[key])) problems.push(`Setting "${key}" should be ${kind(defaults[key])}, but the settings file has ${kind(value)}.`);
  }
  // The Dispatcher's "List settled spreadsheets" command only takes files at least a minute old
  // (find -mmin +0). A shorter wait after the file trigger finds nothing, so the file would wait
  // for the 15-minute timer. Found in the trial install, 19 November 2026.
  if (typeof overrides.fileSettleSeconds === "number" && overrides.fileSettleSeconds < 60) {
    problems.push(`Setting "fileSettleSeconds" must be at least 60: the Dispatcher only takes files that are a minute old, so a shorter wait finds nothing and the file waits for the 15-minute timer.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Workflow files
// ---------------------------------------------------------------------------------------------

export function loadWorkflowFiles(dir) {
  const files = {};
  const problems = [];
  for (const w of WORKFLOWS) {
    const path = join(dir, w.file);
    if (!existsSync(path)) { problems.push(`Workflow file missing: ${path}`); continue; }
    try { files[w.key] = JSON.parse(readFileSync(path, "utf8")); } catch (e) { problems.push(`${path} is not valid JSON: ${e.message}`); }
  }
  return { files, problems: problems.concat(checkWorkflowFiles(files)) };
}

export function settingsDefaults(settingsWorkflow) {
  const node = settingsWorkflow.nodes.find((n) => n.name === NODES.settings);
  return JSON.parse(node.parameters.jsonOutput).settings;
}

export function checkWorkflowFiles(files) {
  const problems = [];
  for (const w of WORKFLOWS) {
    const wf = files[w.key];
    if (!wf) continue;
    if (wf.name !== w.name) problems.push(`${w.file}: name is "${wf.name}", expected "${w.name}".`);
    if (!Array.isArray(wf.nodes) || !wf.connections) { problems.push(`${w.file}: has no nodes or connections.`); continue; }
    for (const n of wf.nodes) {
      for (const type of Object.keys(n.credentials ?? {})) {
        if (type !== "smtp") problems.push(`${w.file}, step "${n.name}": uses a ${type} credential; this script only knows how to point SMTP credentials.`);
      }
    }
  }
  const need = [["settings", NODES.settings], ["dispatcher", NODES.loadSettings], ["dispatcher", NODES.fileTrigger], ["dispatcher", NODES.runNow]];
  for (const [key, name] of need) {
    const wf = files[key];
    if (wf?.nodes && !wf.nodes.some((n) => n.name === name)) problems.push(`${WORKFLOWS.find((w) => w.key === key).file}: step "${name}" not found.`);
  }
  if (files.settings?.nodes?.some((n) => n.name === NODES.settings)) {
    try {
      const s = settingsDefaults(files.settings);
      for (const k of ID_KEYS) if (!(k in s)) problems.push(`harsll-settings.json: setting "${k}" not found.`);
    } catch (e) {
      problems.push(`harsll-settings.json: the Settings step does not hold valid JSON: ${e.message}`);
    }
  }
  return problems;
}

// The settings object to store: defaults in their original order, overrides applied, IDs filled in.
// Unknown IDs (not created yet) become "".
export function buildSettings(defaults, overrides, ids) {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (ID_KEYS.includes(k)) out[k] = ids[k] ?? "";
    else out[k] = k in overrides ? overrides[k] : v;
  }
  return out;
}

export function workflowBody(wf) {
  return {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: Object.fromEntries(Object.entries(wf.settings ?? {}).filter(([k]) => ALLOWED_WORKFLOW_SETTINGS.includes(k))),
  };
}

// Applies IDs, overrides, the credential and the Run now choice to the six workflow files.
// ctx: { ids: { casesTableId, ..., settingsWorkflowId }, overrides, credential: { id, name }, withoutRunNow }
// Returns { bodies: { <key>: { name, nodes, connections, settings } }, settings }. Does not change `files`.
export function prepareWorkflows(files, ctx) {
  const defaults = settingsDefaults(files.settings);
  const settings = buildSettings(defaults, ctx.overrides ?? {}, ctx.ids ?? {});
  const bodies = {};
  for (const w of WORKFLOWS) {
    const wf = structuredClone(files[w.key]);
    for (const n of wf.nodes) {
      if (n.credentials?.smtp && ctx.credential) n.credentials.smtp = { id: ctx.credential.id ?? "", name: ctx.credential.name };
    }
    const node = (name) => wf.nodes.find((n) => n.name === name);
    if (w.key === "settings") {
      node(NODES.settings).parameters.jsonOutput = JSON.stringify({ settings }, null, 2);
    }
    if (w.key === "dispatcher") {
      node(NODES.loadSettings).parameters.workflowId = { __rl: true, mode: "id", value: ctx.ids?.settingsWorkflowId ?? "" };
      node(NODES.fileTrigger).parameters.path = settings.inputFolder;
      const runNow = node(NODES.runNow);
      if (ctx.withoutRunNow) runNow.disabled = true;
      else delete runNow.disabled;
    }
    bodies[w.key] = workflowBody(wf);
  }
  return { bodies, settings };
}

// ---------------------------------------------------------------------------------------------
// Comparing with what the target already has
// ---------------------------------------------------------------------------------------------

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Lists what differs between a prepared body and the workflow in the target. Empty = unchanged.
export function diffWorkflow(prepared, current) {
  const diffs = [];
  if (prepared.name !== current.name) diffs.push("name");
  const before = new Map((current.nodes ?? []).map((n) => [n.name, n]));
  const after = new Map(prepared.nodes.map((n) => [n.name, n]));
  for (const [name, n] of after) {
    if (!before.has(name)) diffs.push(`step added: ${name}`);
    else if (stableStringify(n) !== stableStringify(before.get(name))) diffs.push(`step changed: ${name}`);
  }
  for (const name of before.keys()) if (!after.has(name)) diffs.push(`step removed: ${name}`);
  if (stableStringify(prepared.connections) !== stableStringify(current.connections ?? {})) diffs.push("connections");
  if (stableStringify(prepared.settings) !== stableStringify(workflowBody(current).settings)) diffs.push("workflow settings");
  return diffs;
}

// Works out what to do with one table. current: the target's table (with columns) or undefined.
export function planTable(spec, current) {
  if (!current) return { action: "create", addColumns: [], problems: [] };
  const have = new Map(current.columns.map((c) => [c.name, c.type]));
  const addColumns = [];
  const problems = [];
  for (const [name, type] of spec.columns) {
    if (!have.has(name)) addColumns.push([name, type]);
    else if (have.get(name) !== type) problems.push(`Table ${spec.name}: column "${name}" is ${have.get(name)}, expected ${type}. Fix it by hand; the script will not change a column's type.`);
  }
  return { action: addColumns.length ? "add columns" : "unchanged", addColumns, problems };
}

// Exact-name match among non-archived items. Returns { item, problem }.
export function findOneByName(items, name, what) {
  const matches = items.filter((x) => x.name === name && !x.isArchived);
  if (matches.length > 1) return { item: null, problem: `${matches.length} ${what}s are called "${name}" (IDs ${matches.map((m) => m.id).join(", ")}). Archive or rename the extras, then run again.` };
  return { item: matches[0] ?? null, problem: null };
}

// ---------------------------------------------------------------------------------------------
// n8n public API
// ---------------------------------------------------------------------------------------------

function makeApi(url, key) {
  const base = `${url}/api/v1`;
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { "X-N8N-API-KEY": key, accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(`Cannot reach n8n at ${url} (${e.cause?.code ?? e.message}).`, 0);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try { message = JSON.parse(text).message ?? message; } catch { /* keep text */ }
      if (res.status === 401) message = "the API key was refused (wrong, expired or for another n8n)";
      throw new ApiError(`${method} ${path} failed: ${res.status} ${message}`, res.status);
    }
    if (text.trimStart().startsWith("<")) throw new ApiError(`${method} ${path} returned a web page, not the API. Is N8N_API_URL the n8n address?`, res.status);
    return text ? JSON.parse(text) : {};
  }
  async function listAll(path) {
    const out = [];
    let cursor = null;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page = await call("GET", `${path}${sep}limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }
  return { call, listAll };
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(argv) {
  const out = (s = "") => process.stdout.write(s + "\n");
  const { options, problems } = parseArgs(argv);
  if (options.help) { out(HELP); return 0; }

  // 1. Local checks.
  const envPath = options.envFile ? resolve(options.envFile) : join(repoRoot, ".env");
  let target = null;
  if (!existsSync(envPath)) problems.push(`Env file not found: ${envPath}`);
  else {
    target = readTarget(readFileSync(envPath, "utf8"), envPath);
    problems.push(...target.problems);
  }

  let overrides = {};
  if (options.settingsFile) {
    const p = resolve(options.settingsFile);
    if (!existsSync(p)) problems.push(`Settings file not found: ${p}`);
    else {
      const r = parseOverrides(readFileSync(p, "utf8"), p);
      overrides = r.overrides;
      problems.push(...r.problems);
    }
  }

  const { files, problems: fileProblems } = loadWorkflowFiles(join(repoRoot, "workflows"));
  problems.push(...fileProblems);
  let defaults = null;
  if (files.settings && !fileProblems.some((p) => p.includes("harsll-settings.json"))) {
    defaults = settingsDefaults(files.settings);
    problems.push(...validateOverrides(defaults, overrides));
  }

  // 2. Read the target (read-only) if we can reach it.
  const state = { workflows: [], credentials: null, tables: [], lockRows: null };
  let api = null;
  if (target && !target.problems.length) {
    api = makeApi(target.url, target.key);
    try {
      state.workflows = await api.listAll("/workflows?excludePinnedData=true");
    } catch (e) {
      problems.push(`Target n8n (${target.url}): ${e.message}`);
      api = null;
    }
  }

  const plan = { credential: null, tables: [], lockRow: null, workflows: [] };
  if (api) {
    // Email credential.
    if (options.emailCredentialId) {
      plan.credential = { action: "use (not looked up)", id: options.emailCredentialId, name: options.emailCredential };
    } else {
      try {
        state.credentials = await api.listAll("/credentials");
        const sameName = state.credentials.filter((c) => c.name === options.emailCredential);
        const smtp = sameName.filter((c) => c.type === "smtp");
        if (smtp.length === 1) plan.credential = { action: "use", id: smtp[0].id, name: smtp[0].name };
        else if (smtp.length > 1) problems.push(`${smtp.length} SMTP credentials are called "${options.emailCredential}" (IDs ${smtp.map((c) => c.id).join(", ")}). Rename the extras, or pick one with --email-credential-id.`);
        else if (sameName.length) problems.push(`The credential "${options.emailCredential}" is of type ${sameName[0].type}, not SMTP.`);
        else if (options.emailCredential === MAILPIT_CREDENTIAL.name && options.createMailpitCredential) plan.credential = { action: "create", id: null, name: MAILPIT_CREDENTIAL.name };
        else {
          problems.push(
            `No SMTP credential called "${options.emailCredential}" in the target n8n. A person must create it first: in the n8n editor, ` +
              `Credentials > Add credential > SMTP, name it exactly "${options.emailCredential}", and type in the mail server details there ` +
              `(passwords go into n8n, never into files).` +
              (options.emailCredential === MAILPIT_CREDENTIAL.name ? " For a local test n8n only, --create-mailpit-credential creates the Mailpit one." : ""),
          );
        }
      } catch (e) {
        if (e.status === 403) problems.push(`The API key may not list credentials (only the owner or an admin can). Use a key of the owner, or give the credential's ID with --email-credential-id.`);
        else problems.push(`Reading credentials: ${e.message}`);
      }
    }

    // Tables.
    try {
      state.tables = await api.listAll("/data-tables");
    } catch (e) {
      problems.push(`Reading data tables: ${e.message}`);
    }
    for (const spec of TABLES) {
      const { item, problem } = findOneByName(state.tables, spec.name, "data table");
      if (problem) { problems.push(problem); continue; }
      const p = planTable(spec, item);
      problems.push(...p.problems);
      plan.tables.push({ spec, current: item, ...p });
    }
    const lockPlan = plan.tables.find((t) => t.spec.key === "lock");
    if (lockPlan?.current) {
      try {
        const rows = await api.listAll(`/data-tables/${lockPlan.current.id}/rows`);
        const found = rows.filter((r) => r.name === LOCK_ROW.name);
        plan.lockRow = found.length ? "present" : "add";
        if (found.length > 1) problems.push(`Table harsll_lock has ${found.length} "dispatcher" rows; it must have exactly one. Delete the extras by hand.`);
      } catch (e) {
        problems.push(`Reading the lock table: ${e.message}`);
      }
    } else if (lockPlan) plan.lockRow = "add";

    // Workflows.
    for (const w of WORKFLOWS) {
      const { item, problem } = findOneByName(state.workflows, w.name, "workflow");
      if (problem) problems.push(problem);
      plan.workflows.push({ meta: w, current: item });
    }
  }

  if (problems.length) {
    out(`Stopped: ${problems.length} problem${problems.length > 1 ? "s" : ""} to fix first. Nothing was changed.`);
    for (const p of problems) out(`  - ${p}`);
    return 1;
  }

  // 3. Work out the prepared workflows with the IDs known now (new ones shown as "(new)").
  const ids = {};
  for (const t of plan.tables) ids[t.spec.settingsKey] = t.current?.id;
  for (const p of plan.workflows) {
    if (p.meta.settingsKey) ids[p.meta.settingsKey] = p.current?.id;
    if (p.meta.key === "settings") ids.settingsWorkflowId = p.current?.id;
  }
  const ctx = () => ({ ids, overrides, credential: plan.credential, withoutRunNow: options.withoutRunNow });
  const currentFull = {};
  for (const p of plan.workflows) if (p.current) currentFull[p.meta.key] = await api.call("GET", `/workflows/${p.current.id}`);

  const show = (id) => id ?? "(new)";
  out(`${options.dryRun ? "Plan (dry run, nothing will be changed)" : "Plan"} for ${target.url}`);
  out(`  Email credential: ${plan.credential.action} "${plan.credential.name}" ${plan.credential.id ? `(${plan.credential.id})` : ""}`);
  for (const t of plan.tables) {
    const extra = t.addColumns.length ? `: ${t.addColumns.map((c) => c[0]).join(", ")}` : "";
    out(`  Table ${t.spec.name} ${show(t.current?.id)}: ${t.action}${extra}`);
  }
  out(`  Lock row "dispatcher": ${plan.lockRow === "present" ? "present (left as it is)" : "add"}`);
  {
    const { bodies } = prepareWorkflows(files, ctx());
    for (const p of plan.workflows) {
      const cur = currentFull[p.meta.key];
      if (!cur) { out(`  Workflow ${p.meta.name} (new): create`); continue; }
      const diffs = diffWorkflow(bodies[p.meta.key], cur);
      const published = cur.activeVersionId && cur.activeVersionId === cur.versionId;
      const pub = p.meta.key === "dispatcher" && options.leaveDispatcherOff
        ? (cur.activeVersionId ? "will be unpublished (--leave-dispatcher-off)" : "stays unpublished (--leave-dispatcher-off)")
        : diffs.length || !published ? "will be published" : "published version is current";
      out(`  Workflow ${p.meta.name} (${cur.id}): ${diffs.length ? `update (${diffs.join("; ")})` : "unchanged"}; ${pub}`);
    }
  }
  if (Object.keys(overrides).length) out(`  Settings overrides: ${Object.keys(overrides).join(", ")}`);
  out(`  Run now webhook: ${options.withoutRunNow ? "switched off" : "switched on"}`);

  if (options.dryRun) { out(""); out("Dry run: nothing was changed."); return 0; }

  // 4. Write. Credential, tables, lock row.
  const done = [];
  try {
    if (plan.credential.action === "create") {
      const c = await api.call("POST", "/credentials", MAILPIT_CREDENTIAL);
      plan.credential = { action: "created", id: c.id, name: c.name };
      done.push(`Created credential "${c.name}" (${c.id}).`);
    }
    for (const t of plan.tables) {
      if (t.action === "create") {
        const created = await api.call("POST", "/data-tables", { name: t.spec.name, columns: t.spec.columns.map(([name, type]) => ({ name, type })) });
        t.current = created;
        done.push(`Created table ${t.spec.name} (${created.id}).`);
      } else {
        for (const [name, type] of t.addColumns) await api.call("POST", `/data-tables/${t.current.id}/columns`, { name, type });
        if (t.addColumns.length) done.push(`Added columns to ${t.spec.name}: ${t.addColumns.map((c) => c[0]).join(", ")}.`);
      }
      ids[t.spec.settingsKey] = t.current.id;
    }
    const lock = plan.tables.find((t) => t.spec.key === "lock").current;
    if (plan.lockRow === "add") {
      await api.call("POST", `/data-tables/${lock.id}/rows`, { data: [LOCK_ROW] });
      done.push(`Added the "dispatcher" row to harsll_lock.`);
    }

    // Workflows, in order. A new Settings workflow is first saved with blank workflow IDs, then
    // saved again once every workflow exists.
    const results = {};
    for (const p of plan.workflows) {
      const body = prepareWorkflows(files, ctx()).bodies[p.meta.key];
      const cur = currentFull[p.meta.key];
      let id;
      if (!cur) {
        id = (await api.call("POST", "/workflows", body)).id;
        results[p.meta.key] = "created";
      } else {
        id = cur.id;
        if (diffWorkflow(body, cur).length) { await api.call("PUT", `/workflows/${id}`, body); results[p.meta.key] = "updated"; }
        else results[p.meta.key] = "unchanged";
      }
      p.id = id;
      if (p.meta.settingsKey) ids[p.meta.settingsKey] = id;
      if (p.meta.key === "settings") ids.settingsWorkflowId = id;
    }
    const settingsPlan = plan.workflows.find((p) => p.meta.key === "settings");
    const finalSettings = prepareWorkflows(files, ctx()).bodies.settings;
    const savedSettings = await api.call("GET", `/workflows/${settingsPlan.id}`);
    if (diffWorkflow(finalSettings, savedSettings).length) {
      await api.call("PUT", `/workflows/${settingsPlan.id}`, finalSettings);
      if (results.settings === "unchanged") results.settings = "updated";
    }

    // Publish, Dispatcher last.
    const published = {};
    for (const p of plan.workflows) {
      let w = await api.call("GET", `/workflows/${p.id}`);
      if (p.meta.key === "dispatcher" && options.leaveDispatcherOff) {
        if (w.activeVersionId) { await api.call("POST", `/workflows/${p.id}/unpublish`); published[p.meta.key] = "unpublished (left off)"; }
        else published[p.meta.key] = "not published (left off)";
        continue;
      }
      // n8n 2.48.5 publishes a saved change to an already-published workflow by itself (seen in
      // the trial), so after an update this is usually already current.
      if (w.activeVersionId && w.activeVersionId === w.versionId) {
        published[p.meta.key] = results[p.meta.key] === "unchanged" ? "published (already current)" : "published";
        continue;
      }
      try {
        await api.call("POST", `/workflows/${p.id}/publish`, {});
      } catch (e) {
        throw new Error(`Publishing ${p.meta.name} failed: ${e.message}`);
      }
      w = await api.call("GET", `/workflows/${p.id}`);
      if (!w.activeVersionId || w.activeVersionId !== w.versionId) throw new Error(`${p.meta.name} did not end up published at its latest version.`);
      published[p.meta.key] = "published";
    }

    // 5. Summary.
    out("");
    out("Done.");
    for (const d of done) out(`  ${d}`);
    for (const t of plan.tables) out(`  Table ${t.spec.name}: ${t.current.id}`);
    for (const p of plan.workflows) out(`  ${p.meta.name} (${p.id}): ${results[p.meta.key]}, ${published[p.meta.key]}`);
    out(`  Email steps use credential "${plan.credential.name}" (${plan.credential.id}).`);
    out(`  Run now webhook: ${options.withoutRunNow ? "switched off" : "switched on"}.`);
    out("");
    out("Next steps:");
    out(`  - Make sure these folders exist inside the n8n container and n8n may use them: ${["inputFolder", "archiveFolder", "rejectedFolder", "reportsFolder"].map((k) => prepareWorkflows(files, ctx()).settings[k]).join(", ")}.`);
    if (options.leaveDispatcherOff) out(`  - The Dispatcher is off: nothing starts until someone publishes "HARSLL – Dispatcher" in the n8n editor.`);
    else out(`  - The Dispatcher is on: a spreadsheet dropped in the input folder will be processed.`);
    out("  - Workflow IDs in workflows/README.md are those of the original local n8n; this n8n has the IDs above.");
    return 0;
  } catch (e) {
    out("");
    out(`Stopped part way: ${e.message}`);
    for (const d of done) out(`  Already done: ${d}`);
    out("Fix the problem and run the script again: it picks up where it stopped.");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    process.stdout.write(`Unexpected error: ${e.message}\n`);
    process.exit(1);
  });
}

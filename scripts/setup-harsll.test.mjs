// Checks the pure parts of setup-harsll.mjs against the real workflow files.
// Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./lib/env.mjs";
import {
  WORKFLOWS, TABLES, ID_KEYS, NODES, MAILPIT_CREDENTIAL,
  parseArgs, readTarget, parseOverrides, validateOverrides, loadWorkflowFiles, settingsDefaults,
  buildSettings, prepareWorkflows, workflowBody, diffWorkflow, planTable, findOneByName,
} from "./setup-harsll.mjs";

const { files, problems: fileProblems } = loadWorkflowFiles(join(repoRoot, "workflows"));
const defaults = settingsDefaults(files.settings);
const node = (body, name) => body.nodes.find((n) => n.name === name);

const newIds = {
  casesTableId: "cases0000000001", batchesTableId: "batches00000001", lockTableId: "lock00000000001",
  adapterWorkflowId: "adapter00000001", performerWorkflowId: "perform00000001",
  takeInFileWorkflowId: "takein000000001", reportBatchWorkflowId: "report000000001", settingsWorkflowId: "settings0000001",
};
const newCredential = { id: "cred00000000001", name: "Council SMTP" };

test("the real workflow files load with no problems", () => {
  assert.deepEqual(fileProblems, []);
  assert.deepEqual(Object.keys(files).sort(), WORKFLOWS.map((w) => w.key).sort());
  for (const k of ID_KEYS) assert.ok(k in defaults, `settings has ${k}`);
});

test("parseArgs reads every flag, in both spellings", () => {
  const { options, problems } = parseArgs([
    "--env-file", ".env.x", "--settings=cfg.json", "--email-credential", "Council SMTP", "--email-credential-id=abc",
    "--without-run-now", "--leave-dispatcher-off", "--dry-run",
  ]);
  assert.deepEqual(problems, []);
  assert.equal(options.envFile, ".env.x");
  assert.equal(options.settingsFile, "cfg.json");
  assert.equal(options.emailCredential, "Council SMTP");
  assert.equal(options.emailCredentialId, "abc");
  assert.ok(options.withoutRunNow && options.leaveDispatcherOff && options.dryRun);
  assert.equal(options.createMailpitCredential, false);
});

test("parseArgs defaults to the Mailpit credential and refuses secrets and stray values", () => {
  assert.equal(parseArgs([]).options.emailCredential, MAILPIT_CREDENTIAL.name);
  assert.match(parseArgs(["--api-key", "x"]).problems[0], /never taken on the command line/);
  assert.match(parseArgs(["--settings"]).problems[0], /needs a value/);
  assert.match(parseArgs(["--dry-run=yes"]).problems[0], /does not take a value/);
  assert.match(parseArgs(["oops"]).problems[0], /Unexpected argument/);
  assert.match(parseArgs(["--email-credential", "Other", "--create-mailpit-credential"]).problems[0], /only creates/);
});

test("readTarget takes the URL and key from the env text and never needs them elsewhere", () => {
  const t = readTarget("N8N_API_URL=http://n8n.example:5678/api/v1/\nN8N_API_KEY='k'\n", "test.env");
  assert.deepEqual(t, { url: "http://n8n.example:5678", key: "k", problems: [] });
  const bad = readTarget("N8N_API_URL=n8n.example\n", "test.env");
  assert.equal(bad.problems.length, 2);
});

test("the committed example settings file is valid", () => {
  const path = join(repoRoot, "config", "settings.example.json");
  const { overrides, problems } = parseOverrides(readFileSync(path, "utf8"), path);
  assert.deepEqual(problems, []);
  assert.ok(!("_readme" in overrides));
  assert.deepEqual(validateOverrides(defaults, overrides), []);
});

test("validateOverrides rejects unknown keys, ID keys and wrong types, all at once", () => {
  const problems = validateOverrides(defaults, { nope: 1, casesTableId: "x", maxAttempts: "3", landlordNames: "One name", summaryEmailTo: "a@b.example" });
  assert.equal(problems.length, 4);
  assert.match(problems.join("\n"), /Unknown setting "nope"/);
  assert.match(problems.join("\n"), /"casesTableId" is an ID/);
  assert.match(problems.join("\n"), /"maxAttempts" should be a number/);
  assert.match(problems.join("\n"), /"landlordNames" should be a list/);
  assert.match(validateOverrides(defaults, { fileSettleSeconds: 20 })[0], /at least 60/);
  assert.deepEqual(validateOverrides(defaults, { fileSettleSeconds: 90 }), []);
  assert.match(parseOverrides("[1]", "f").problems[0], /one JSON object/);
  assert.match(parseOverrides("{", "f").problems[0], /not valid JSON/);
});

test("buildSettings keeps the key order, applies overrides and fills IDs (blank when unknown)", () => {
  const s = buildSettings(defaults, { maxAttempts: 5 }, { casesTableId: "C" });
  assert.deepEqual(Object.keys(s), Object.keys(defaults));
  assert.equal(s.maxAttempts, 5);
  assert.equal(s.casesTableId, "C");
  assert.equal(s.performerWorkflowId, "");
});

test("prepareWorkflows writes IDs, overrides, folder, credential and Run now into the six workflows", () => {
  const before = JSON.stringify(files);
  const { bodies, settings } = prepareWorkflows(files, {
    ids: newIds, overrides: { inputFolder: "/files/in-test", profile: "test" }, credential: newCredential, withoutRunNow: true,
  });
  assert.equal(JSON.stringify(files), before, "the loaded files are not changed");

  const stored = JSON.parse(node(bodies.settings, NODES.settings).parameters.jsonOutput).settings;
  assert.deepEqual(stored, settings);
  for (const k of ID_KEYS) assert.equal(stored[k], newIds[k]);
  assert.equal(stored.profile, "test");
  assert.equal(stored.inputFolder, "/files/in-test");

  const d = bodies.dispatcher;
  assert.deepEqual(node(d, NODES.loadSettings).parameters.workflowId, { __rl: true, mode: "id", value: newIds.settingsWorkflowId });
  assert.equal(node(d, NODES.fileTrigger).parameters.path, "/files/in-test");
  assert.equal(node(d, NODES.runNow).disabled, true);

  let emailSteps = 0;
  for (const body of Object.values(bodies)) {
    for (const n of body.nodes) {
      if (n.credentials) { emailSteps++; assert.deepEqual(n.credentials, { smtp: newCredential }); }
    }
  }
  assert.equal(emailSteps, 3);
});

test("prepareWorkflows never moves a step (execution order depends on canvas position)", () => {
  const { bodies } = prepareWorkflows(files, { ids: newIds, overrides: {}, credential: newCredential });
  for (const w of WORKFLOWS) {
    const pos = (wf) => Object.fromEntries(wf.nodes.map((n) => [n.name, n.position]));
    assert.deepEqual(pos(bodies[w.key]), pos(files[w.key]), w.name);
    assert.deepEqual(bodies[w.key].connections, files[w.key].connections, w.name);
  }
});

test("Run now is switched on unless --without-run-now", () => {
  const { bodies } = prepareWorkflows(files, { ids: newIds, credential: newCredential });
  assert.equal(node(bodies.dispatcher, NODES.runNow).disabled, undefined);
});

test("with the original IDs and credential, the prepared workflows equal the committed files", () => {
  const original = Object.fromEntries(ID_KEYS.map((k) => [k, defaults[k]]));
  original.settingsWorkflowId = files.settings.id;
  const cred = files.dispatcher.nodes.concat(files.takeInFile.nodes, files.reportBatch.nodes).find((n) => n.credentials).credentials.smtp;
  const { bodies } = prepareWorkflows(files, { ids: original, overrides: {}, credential: cred });
  for (const w of WORKFLOWS) assert.deepEqual(diffWorkflow(bodies[w.key], files[w.key]), [], w.name);
});

test("workflowBody keeps only the settings the public API accepts", () => {
  const b = workflowBody({ name: "x", nodes: [], connections: {}, settings: { timezone: "Europe/London", binaryMode: "x" }, id: "i", versionId: "v" });
  assert.deepEqual(b, { name: "x", nodes: [], connections: {}, settings: { timezone: "Europe/London" } });
});

test("diffWorkflow names what changed", () => {
  const { bodies } = prepareWorkflows(files, { ids: newIds, credential: newCredential });
  const current = structuredClone(bodies.dispatcher);
  assert.deepEqual(diffWorkflow(bodies.dispatcher, current), []);
  node(current, NODES.runNow).disabled = true;
  current.nodes.push({ name: "Extra step" });
  current.settings.timezone = "UTC";
  assert.deepEqual(diffWorkflow(bodies.dispatcher, current), ["step changed: Run now", "step removed: Extra step", "workflow settings"]);
});

test("planTable creates, adds missing columns, and refuses to change a column's type", () => {
  const cases = TABLES.find((t) => t.key === "cases");
  assert.equal(planTable(cases, undefined).action, "create");
  const cols = cases.columns.map(([name, type]) => ({ name, type }));
  assert.equal(planTable(cases, { columns: cols }).action, "unchanged");
  const missing = planTable(cases, { columns: cols.filter((c) => c.name !== "errorDetail") });
  assert.deepEqual(missing.addColumns, [["errorDetail", "string"]]);
  const wrong = planTable(cases, { columns: cols.map((c) => (c.name === "attempts" ? { ...c, type: "string" } : c)) });
  assert.match(wrong.problems[0], /"attempts" is string, expected number/);
});

test("findOneByName matches exactly, ignores archived copies, and refuses duplicates", () => {
  const items = [{ id: "1", name: "HARSLL – Performer" }, { id: "2", name: "HARSLL – Performer: RBIS adapter" }, { id: "3", name: "HARSLL – Performer", isArchived: true }];
  assert.equal(findOneByName(items, "HARSLL – Performer", "workflow").item.id, "1");
  assert.equal(findOneByName(items, "HARSLL – Dispatcher", "workflow").item, null);
  assert.match(findOneByName([...items, { id: "4", name: "HARSLL – Performer" }], "HARSLL – Performer", "workflow").problem, /2 workflows are called/);
});

test("the table columns are the ones the workflows use", () => {
  const text = JSON.stringify(Object.values(files));
  for (const t of TABLES) for (const [name] of t.columns) assert.ok(text.includes(name), `${t.name}.${name} is used somewhere`);
});

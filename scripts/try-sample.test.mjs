// Checks for the sample run (scripts/try-sample.mjs). No n8n needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadScenarios } from "./lib/scenario-kit.mjs";
import { repoRoot } from "./lib/env.mjs";
import { SAMPLE_PATH, buildSample, describeResults, sampleRows } from "./try-sample.mjs";

const data = loadScenarios(repoRoot);

test("the sample has 10 made-up rows with a mix of outcomes", () => {
  const rows = sampleRows(data);
  assert.equal(rows.length, 10);
  for (const r of rows) {
    assert.match(r.cells.TenantName, / (Sample|Test)$/, "made-up names only");
    assert.match(r.cells.Address, /Example Street|Other Street/, "made-up addresses only");
  }
  const statuses = new Set(rows.map((r) => r.expect.status));
  for (const s of ["updated", "referred", "duplicate"]) assert.ok(statuses.has(s), `has a ${s} row`);
  assert.equal(new Set(rows.map((r) => r.cells.TenantName)).size, rows.length, "names are unique, so results can be matched by name");
});

test("the committed sample spreadsheet is up to date", () => {
  assert.ok(readFileSync(SAMPLE_PATH).equals(buildSample(data)), "run: node scripts/try-sample.mjs --write-file");
});

test("describeResults: ticks rows that ended as expected, crosses the others", () => {
  const rows = sampleRows(data);
  const cases = rows.map((r) => ({
    tenantName: r.cells.TenantName,
    changeReason: r.cells.ChangeReason,
    startDate: "2026-11-01",
    endDate: "2026-10-31",
    status: r.expect.status,
    reasonCode: r.expect.reasonCode ?? "",
    outcome: r.expect.outcome ?? "",
  }));
  assert.equal(describeResults(rows, cases, data.reasonTexts).matched, rows.length);
  cases[0].status = "failed";
  const r = describeResults(rows, cases, data.reasonTexts);
  assert.equal(r.matched, rows.length - 1);
  assert.match(r.lines[0], /✗/);
  assert.match(describeResults(rows, [], data.reasonTexts).lines[0], /No case recorded/);
});

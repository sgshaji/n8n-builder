import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./lib/env.mjs";
import { KIT_PATHS, FORBIDDEN, installText } from "./make-install-kit.mjs";

test("every kit path exists, and the set-up script's own needs are in the kit", () => {
  for (const p of KIT_PATHS) assert.ok(existsSync(join(repoRoot, p)), `${p} is missing`);
  for (const p of ["workflows", "scripts/setup-harsll.mjs", "scripts/lib/env.mjs", "config/settings.example.json"]) assert.ok(KIT_PATHS.includes(p), p);
  assert.ok(!KIT_PATHS.some((p) => p.startsWith(".env") || p.startsWith("data")), "no env files or data folder");
});

test("the secret checks catch filled-in values and let placeholders through", () => {
  const caught = (text) => FORBIDDEN.some(({ re }) => re.test(text));
  assert.ok(caught("N8N_API_KEY=abc123realkey"));
  assert.ok(caught("SMTP_PASSWORD=hunter2"));
  assert.ok(caught("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6.abc"));
  assert.ok(caught('{ "shared": [ { "role": "workflow:owner" } ] }'));
  assert.ok(!caught("N8N_API_KEY=paste-the-key-here"));
  assert.ok(!caught("N8N_API_KEY="));
  assert.ok(!caught("N8N_ENCRYPTION_KEY=change-me-to-a-long-random-string"));
});

test("INSTALL.md names the version and warns about RBIS", () => {
  const text = installText({ commit: "abc1234", date: "2026-11-19", ref: "HEAD" });
  assert.match(text, /commit `abc1234`, built 2026-11-19/);
  assert.match(text, /pretend RBIS/);
  assert.match(text, /--dry-run/);
  assert.match(installText({ commit: "abc1234", date: "2026-11-19", ref: "v1.0" }), /\(v1\.0\)/);
});

// Checks on the documentation's diagrams: see docs/diagrams/README.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "./lib/env.mjs";

const diagrams = join(repoRoot, "docs", "diagrams");
const markdownFiles = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], { cwd: repoRoot, encoding: "utf8" })
  .stdout.split("\n").filter(Boolean).filter((f) => existsSync(join(repoRoot, f)));

test("every diagram source has its image", () => {
  for (const f of readdirSync(diagrams).filter((x) => x.endsWith(".mmd"))) {
    assert.ok(existsSync(join(diagrams, f.replace(/\.mmd$/, ".png"))), `${f} has no .png: see docs/diagrams/README.md`);
  }
});

test("every image a document shows exists, and every diagram is used", () => {
  const used = new Set();
  for (const f of markdownFiles) {
    const text = readFileSync(join(repoRoot, f), "utf8").replace(/^```[\s\S]*?^```/gm, ""); // examples in code blocks don't count
    for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+\.png)\)/g)) {
      const path = resolve(dirname(join(repoRoot, f)), m[1]);
      assert.ok(existsSync(path), `${f} shows ${m[1]}, which does not exist`);
      used.add(path);
    }
  }
  for (const f of readdirSync(diagrams).filter((x) => x.endsWith(".png"))) {
    assert.ok(used.has(resolve(diagrams, f)), `docs/diagrams/${f} is not shown in any document`);
  }
});

test("no document contains Mermaid code", () => {
  for (const f of markdownFiles) {
    assert.ok(!/^\s*```mermaid\s*$/m.test(readFileSync(join(repoRoot, f), "utf8")), `${f} contains a Mermaid block: move it to docs/diagrams (see docs/diagrams/README.md)`);
  }
});

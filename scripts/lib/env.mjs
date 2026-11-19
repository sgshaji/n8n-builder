// Reads the repo's .env file, so MCP helpers can use secrets without
// them ever appearing in .mcp.json or the shell environment.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readEnv() {
  const path = join(repoRoot, ".env");
  if (!existsSync(path)) {
    fail(`No .env file found at ${path}. See docs/setup/01-run-n8n-locally.md, step 1.`);
  }
  return parseEnv(readFileSync(path, "utf8"));
}

// Parses the text of a .env-style file: KEY=value lines; quotes around a value are removed.
// Exported so other scripts (e.g. setup-harsll.mjs) can read a different env file.
export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

export function requireValue(env, name, hint) {
  if (!env[name]) fail(`${name} is missing or empty in .env. ${hint}`);
  return env[name];
}

export function fail(message) {
  // stderr only: stdout is reserved for the MCP protocol / header JSON.
  process.stderr.write(`[n8n-builder] ${message}\n`);
  process.exit(1);
}

// Starts the community n8n-mcp server (github.com/czlonkowski/n8n-mcp) in Docker,
// speaking MCP over stdio. Claude Code runs this via .mcp.json.
//
// It shares the n8n container's network, so it reaches n8n at http://localhost:5678.
// That lets n8n-mcp keep its "moderate" SSRF protection (localhost only) instead of
// allowing every private IP address. It receives only the n8n API key, read from .env.
import { spawn } from "node:child_process";
import { readEnv, requireValue } from "./lib/env.mjs";

const env = readEnv();
const apiKey = requireValue(
  env,
  "N8N_API_KEY",
  "Create one in n8n (Settings > n8n API). See docs/setup/02-connect-mcp-servers.md.",
);
const version = env.N8N_MCP_VERSION || "2.103.1";

const args = [
  "run", "-i", "--rm", "--init",
  "--network", "container:n8n-builder-n8n-1",
  "-e", "MCP_MODE=stdio",
  "-e", "LOG_LEVEL=error",
  "-e", "DISABLE_CONSOLE_OUTPUT=true",
  "-e", "N8N_MCP_TELEMETRY_DISABLED=true",
  "-e", "WEBHOOK_SECURITY_MODE=moderate",
  "-e", "N8N_API_URL=http://localhost:5678",
  "-e", "N8N_API_KEY", // value passed through the child environment, not the command line
  `ghcr.io/czlonkowski/n8n-mcp:${version}`,
];

const child = spawn("docker", args, {
  stdio: "inherit",
  env: { ...process.env, N8N_API_KEY: apiKey },
});
child.on("error", (err) => {
  process.stderr.write(`[n8n-builder] Could not start Docker: ${err.message}. Is Docker Desktop running?\n`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));

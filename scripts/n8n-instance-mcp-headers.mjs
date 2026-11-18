// Prints the Authorization header for n8n's built-in MCP server as JSON.
// Claude Code calls this as a "headersHelper" (see .mcp.json), so the token
// stays in .env and never appears in the config file.
import { readEnv, requireValue } from "./lib/env.mjs";

const env = readEnv();
const token = requireValue(
  env,
  "N8N_MCP_TOKEN",
  "Generate one in n8n (Settings > Instance-level MCP > API key). See docs/setup/02-connect-mcp-servers.md.",
);

process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));

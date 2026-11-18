// Connects Claude Code to n8n's built-in MCP server.
//
// Claude Code talks to this script over stdio; the script forwards each message to
// n8n's MCP endpoint over HTTP, adding the token from .env. This avoids putting the
// token in .mcp.json, and works without Claude Code's folder-trust setting (which a
// "headersHelper" would need).
//
// Implements the client side of MCP "Streamable HTTP": JSON or SSE responses, and the
// Mcp-Session-Id header. No dependencies: Node's built-in fetch only.
import { createInterface } from "node:readline";
import { readEnv, requireValue } from "./lib/env.mjs";

const env = readEnv();
const token = requireValue(
  env,
  "N8N_MCP_TOKEN",
  "Generate one in n8n (Settings > Instance-level MCP > Connect > API key). See docs/setup/02-connect-mcp-servers.md.",
);
const url = `${(env.N8N_API_URL || "http://localhost:5678").replace(/\/$/, "")}/mcp-server/http`;

let sessionId;
let protocolVersion;

const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (text) => process.stderr.write(`[n8n-instance] ${text}\n`);

function errorReply(message, text) {
  if (message && message.id !== undefined) {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
  }
}

async function forward(message) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
  } catch (err) {
    log(`Cannot reach ${url}: ${err.message}. Is n8n running?`);
    return errorReply(message, `Cannot reach n8n at ${url}. Is it running?`);
  }

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (res.status === 202 || res.status === 204) return; // notification accepted
  if (!res.ok) {
    const hint =
      res.status === 401 ? "Token rejected: generate a new N8N_MCP_TOKEN." :
      res.status === 404 ? "MCP is off: enable it in Settings > Instance-level MCP." : "";
    log(`HTTP ${res.status} from n8n. ${hint}`);
    return errorReply(message, `n8n returned HTTP ${res.status}. ${hint}`.trim());
  }

  const type = res.headers.get("content-type") || "";
  if (type.includes("text/event-stream")) {
    await readEventStream(res.body);
  } else {
    const text = await res.text();
    if (!text.trim()) return;
    const body = JSON.parse(text);
    for (const msg of Array.isArray(body) ? body : [body]) handleIncoming(msg);
  }
}

async function readEventStream(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) handleIncoming(JSON.parse(data));
    }
  }
}

function handleIncoming(msg) {
  if (msg?.result?.protocolVersion) protocolVersion = msg.result.protocolVersion;
  write(msg);
}

// Read one JSON-RPC message per line from Claude Code.
const rl = createInterface({ input: process.stdin });
const inFlight = new Set();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return log("Ignored a line that was not JSON.");
  }
  const p = forward(message).catch((err) => {
    log(`Unexpected error: ${err.message}`);
    errorReply(message, `Proxy error: ${err.message}`);
  });
  inFlight.add(p);
  p.finally(() => inFlight.delete(p));
});

rl.on("close", async () => {
  await Promise.allSettled([...inFlight]);
  if (sessionId) {
    await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    }).catch(() => {});
  }
  process.exit(0);
});

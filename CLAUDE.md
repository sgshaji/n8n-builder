# CLAUDE.md

Working rules for Claude Code in this repository.

## What this project is

Rebuilding the HARSLL process (two UiPath robots: Dispatcher and Performer) as n8n workflows. HARSLL updates council tax accounts (in a system called RBIS) when council tenancies start or end. Read `docs/business/HARSLL-business-overview.md` and `docs/process/HARSLL-uipath-process.md` before designing or changing workflows.

## Hard rules

- **Never commit real data.** Tenant names, addresses, account references and anything about deaths are personal data. Use made-up test data only, kept in `test-data/`.
- **Never commit secrets.** API keys, passwords and tokens go in `.env` (ignored). Add new variables to `.env.example` with a placeholder and a comment.
- **Never commit `docs/source/` contents.** They may be client-confidential.
- **The real RBIS is not available.** Build against the pretend RBIS until the process owner confirms how RBIS can be reached.

## Conventions

- **Docs live in the repo** as Markdown under `docs/`, with Mermaid diagrams. Update the relevant doc in the same change as the workflow.
- **Business docs use plain English**, with no system jargon. Technical detail goes in `docs/process/` or the design docs.
- **Label inferences.** If something is assumed rather than confirmed, say so and add it to the open questions.
- **Unknown business rules become settings** with a sensible default, recorded as an assumption, not hard-coded logic.
- **Workflows are exported** to `workflows/<kebab-case-name>.json` after every meaningful change.
- **Keep the README status table current** when a phase starts or finishes.

## Environment notes

- Windows 11 on ARM (arm64), PowerShell and Git Bash. Docker Desktop (WSL 2) runs n8n.
- Local stack: `compose.yaml` runs n8n (pinned in `.env`, currently 2.48.5) at http://localhost:5678 and Mailpit at http://localhost:8025. Setup guide: `docs/setup/01-run-n8n-locally.md`.
- Inside n8n, `data/` is `/files` (the only folder workflows may touch) and `workflows/` is `/workflows`.
- Local File Trigger and Execute Command are re-enabled via `NODES_EXCLUDE=[]` for local use only.
- MCP servers (`.mcp.json`): `n8n-mcp` (community, Docker, uses `N8N_API_KEY`) and `n8n-instance` (n8n built-in, uses `N8N_MCP_TOKEN` via a headers helper). Both read secrets from `.env` through `scripts/`. Guide: `docs/setup/02-connect-mcp-servers.md`.
- Prefer `n8n-mcp` to look up node settings and validate a workflow before creating or updating it.
- The repo sits in a OneDrive-synced folder. n8n runtime data must live in Docker volumes, never inside this folder.
- Local Node.js is v26, newer than n8n supports, so n8n runs in Docker, not with `npx`.

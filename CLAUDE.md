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

- **Docs live in the repo** as Markdown under `docs/`. Diagrams: Mermaid source in `docs/diagrams/*.mmd`, shown as PNG, never inline Mermaid (GitHub often fails to display it). See `docs/diagrams/README.md`; the unit tests enforce it. Update the relevant doc in the same change as the workflow.
- **Business docs use plain English**, with no system jargon. Technical detail goes in `docs/process/` or the design docs.
- **Label inferences.** If something is assumed rather than confirmed, say so and add it to the open questions.
- **Unknown business rules become settings** with a sensible default, recorded as an assumption, not hard-coded logic.
- **Workflows are exported** to `workflows/<kebab-case-name>.json` after every meaningful change.
- **Keep the README status table current** when a phase starts or finishes.

## Environment notes

- Windows 11 on ARM (arm64), PowerShell and Git Bash. Docker Desktop (WSL 2) runs n8n.
- Local stack: `compose.yaml` runs n8n (pinned in `.env`, currently 2.48.5) at http://localhost:5678 and Mailpit at http://localhost:8025. Setup guide: `docs/setup/01-run-n8n-locally.md`.
- Pretend RBIS: `mock-rbis/server.mjs` (plain Node.js, no packages) runs as the `mock-rbis` service at http://localhost:8088; workflows reach it at `http://mock-rbis:8080`. Accounts come from `test-data/rbis-accounts.json`. Run its checks with `node --test mock-rbis/` after any change, then `docker compose restart mock-rbis`.
- In Git Bash, a command passed to `docker compose exec` must not contain absolute container paths (they are rewritten to Windows paths). Use relative paths or `sh -c '...'`.
- Install or update HARSLL in any n8n with `node scripts/setup-harsll.mjs` (locally `--create-mailpit-credential`; `--dry-run` first). It writes all table and workflow IDs into Settings; never hand-copy IDs. Guide: `docs/setup/03-move-to-another-environment.md`.
- See it work: `node scripts/try-sample.mjs` (wipes local test data; 10 made-up rows; ~70 s).
- Hand-over zip: `node scripts/make-install-kit.mjs` builds `dist/harsll-install-kit-<date>-<commit>.zip` from the last commit (git archive; refuses secrets). Commit first: uncommitted changes are left out.
- Through the public API, saving (PUT) an already-published workflow republishes it at once in 2.48.5; `POST /workflows/{id}/publish` publishes. Always confirm `versionId === activeVersionId`.
- Deleting an n8n workflow through the API needs it deactivated, then archived (`POST /workflows/{id}/archive`), then deleted.
- Restarting n8n (including test scenario 36) cuts off the `n8n-mcp` server: reconnect it with `/mcp`. Meanwhile, use the n8n public API (key in `.env`) or `n8n-instance`.
- In n8n 2.48.5 an expression that hits a plain JavaScript error yields `null` instead of failing. Parse JSON only in Code nodes and check values explicitly (see `docs/design/interfaces.md`).
- Tests: `node --test scripts/ mock-rbis/` (unit), then `node scripts/run-tests.mjs` (all 37 scenarios end to end, ~11 min; `--include-slow` adds scenario 36; the runner finds the tables by name). Guide: `docs/testing.md`. Never change an expected result just to match a workflow: settle it from the design.
- A workflow called by another (Execute Sub-workflow) runs **only its published version**: publish it, and after every edit check the published version is current (`n8n_get_workflow` mode `active`).
- Workflow and table IDs can come from expressions, e.g. `{"__rl": true, "mode": "id", "value": "={{ $json.settings.casesTableId }}"}`. Proven for Execute Sub-workflow and Data table nodes.
- n8n runs sibling branches top to bottom by canvas position, so moving nodes can change behaviour. Keep the two order-dependent fan-outs (in the Dispatcher and in Dispatcher: take in a file) in order, and keep the naming and layout conventions (see `workflows/README.md`).
- The handovers between workflows (settings, tables, keys, Performer and adapter input/output) are fixed in `docs/design/interfaces.md`.
- Inside n8n, `data/` is `/files` (the only folder workflows may touch) and `workflows/` is `/workflows`.
- Local File Trigger and Execute Command are re-enabled via `NODES_EXCLUDE=[]` for local use only.
- MCP servers (`.mcp.json`): `n8n-mcp` (community, Docker, uses `N8N_API_KEY`) and `n8n-instance` (n8n built-in, uses `N8N_MCP_TOKEN` via a stdio-to-HTTP forwarding script). Both read secrets from `.env` through `scripts/`. Guide: `docs/setup/02-connect-mcp-servers.md`.
- Prefer `n8n-mcp` to look up node settings and validate a workflow before creating or updating it.
- The repo sits in a OneDrive-synced folder. n8n runtime data must live in Docker volumes, never inside this folder.
- Local Node.js is v26, newer than n8n supports, so n8n runs in Docker, not with `npx`.

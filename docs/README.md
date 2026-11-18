# Documentation

Start with the business overview, then go deeper as needed.

| Document | For | What it covers |
| --- | --- | --- |
| [Business overview](business/HARSLL-business-overview.md) | Business stakeholders | Purpose, benefits, scope, safety checks, referred cases, decisions needed |
| [Current UiPath process](process/HARSLL-uipath-process.md) | IT and process specialists | How today's Dispatcher and Performer robots work, step by step, and every reason a case stops |
| [Source documents](source/README.md) | Anyone checking the originals | The flowcharts this work is based on (kept local, not in Git) |
| [Run n8n locally with Docker](setup/01-run-n8n-locally.md) | Anyone working on the workflows | First-time setup, everyday commands, settings, import and export, upgrades, troubleshooting |
| [HARSLL in n8n: design](design/HARSLL-n8n-design.md) | IT, and stakeholders approving the build | The four workflows, tables, checks, pretend RBIS, settings and assumptions, test plan. **Revision 2, draft for approval** |
| [Connect the n8n MCP servers](setup/02-connect-mcp-servers.md) | Anyone using Claude Code on this repo | The two MCP servers, how secrets stay out of Git, setup, checks, troubleshooting |

## Coming in later phases

| Document | Phase |
| --- | --- |
| Testing guide and test data | 4 |
| Move to the real environment | 5 |

## Writing conventions

- **Business documents** use plain English, with no system jargon. Technical detail goes in the process or design documents.
- **Anything inferred is labelled** as assumed or inferred, and listed as an open question.
- **Diagrams** are written in [Mermaid](https://mermaid.js.org/) so they render on GitHub and in the VS Code preview.
- A shared, commentable copy of the business overview also lives in Claude Docs. This repo is the source of truth.

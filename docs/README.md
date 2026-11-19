# Documentation

Start with the business overview, then go deeper as needed.

| Document | For | What it covers |
| --- | --- | --- |
| [Business overview](business/HARSLL-business-overview.md) | Business stakeholders | Purpose, benefits, scope, safety checks, referred cases, decisions needed |
| [Current UiPath process](process/HARSLL-uipath-process.md) | IT and process specialists | How today's Dispatcher and Performer robots work, step by step, and every reason a case stops |
| [Source documents](source/README.md) | Anyone checking the originals | The flowcharts this work is based on (kept local, not in Git) |
| [Run n8n locally with Docker](setup/01-run-n8n-locally.md) | Anyone working on the workflows | First-time setup, everyday commands, settings, import and export, upgrades, troubleshooting |
| [HARSLL in n8n: design](design/HARSLL-n8n-design.md) | IT, and stakeholders approving the build | The six workflows, tables, checks, pretend RBIS, settings and assumptions, test plan, and the changes made during the build. **Revision 3, approved** |
| [Interfaces](design/interfaces.md) | IT | Exact hand-overs between the workflows: settings, tables, keys, inputs and outputs, error codes |
| [Testing HARSLL](testing.md) | Anyone changing the workflows | The 37 test scenarios, how to run them, how long they take, how to read the report and add a scenario |
| [Build notes](build-notes/) | IT | What each of the three parallel build tracks built and tested, and where it departed from the design |
| [Phase 4 trials: results](design/phase-4-trials.md) | IT | The four checks run before building, and what each proved |
| [Connect the n8n MCP servers](setup/02-connect-mcp-servers.md) | Anyone using Claude Code on this repo | The two MCP servers, how secrets stay out of Git, setup, checks, troubleshooting |

Component guides live next to the code: [pretend RBIS](../mock-rbis/README.md), [test data](../test-data/README.md), [workflows](../workflows/README.md).

## Coming in later phases

| Document | Phase |
| --- | --- |
| Move to the real environment | 5 |

## Writing conventions

- **Business documents** use plain English, with no system jargon. Technical detail goes in the process or design documents.
- **Anything inferred is labelled** as assumed or inferred, and listed as an open question.
- **Diagrams** are written in [Mermaid](https://mermaid.js.org/) so they render on GitHub and in the VS Code preview.
- A shared, commentable copy of the business overview also lives in Claude Docs. This repo is the source of truth.

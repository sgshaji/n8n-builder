# Documentation

Pick the row that matches what you want to do. Business and user guides are in plain English; technical detail is kept in the setup, design and testing documents.

## Understand HARSLL

| Document | For | What it covers |
| --- | --- | --- |
| [Business overview](business/HARSLL-business-overview.md) | Business stakeholders | Why HARSLL exists, what it does, the five safety checks, what goes to staff, and the decisions still needed |
| [How HARSLL works](guides/how-harsll-works.md) | Anyone, including the process owner, IT support and new developers | The six workflows: what each is for, when it runs, what it does step by step, and what it changes. No n8n knowledge needed |
| [Current UiPath process](process/HARSLL-uipath-process.md) | IT and process specialists | How today's two UiPath robots work, and every reason a case stops |

## Use HARSLL

| Document | For | What it covers |
| --- | --- | --- |
| [Using HARSLL day to day](guides/using-harsll.md) | The team that sends spreadsheets and handles referred cases | The spreadsheet format, what happens next, the summary email, the worklist, what to do with each reason, sending a row again, rejected files |
| [Try HARSLL with sample data](guides/try-harsll-with-sample-data.md) | Anyone who wants to see it work | Whether mock data is needed (it's included), a one-command sample run, the same by hand, and things to try next |

## Set HARSLL up or move it

| Document | For | What it covers |
| --- | --- | --- |
| [1. Run n8n locally with Docker](setup/01-run-n8n-locally.md) | Anyone working on HARSLL on their own computer | Installing the local stack, setting HARSLL up in it, everyday commands, upgrades, troubleshooting |
| [2. Connect the n8n MCP servers](setup/02-connect-mcp-servers.md) | Anyone using Claude Code on this repo | The two MCP servers, keeping secrets out of Git, setup, troubleshooting |
| [3. Move HARSLL to another environment](setup/03-move-to-another-environment.md) | Whoever installs HARSLL on another n8n, such as BCC's | What the environment needs, keys and secrets, the set-up script, what to configure by hand, testing, going live, updates |

## Change HARSLL

| Document | For | What it covers |
| --- | --- | --- |
| [Design](design/HARSLL-n8n-design.md) | IT, and stakeholders approving changes | The full design: workflows, tables, checks, settings and assumptions, test plan, open questions, and every change made since approval. **Revision 3, approved** |
| [Interfaces](design/interfaces.md) | Developers | The exact hand-overs between workflows: settings, tables, keys, inputs and outputs, error codes |
| [Workflows](../workflows/README.md) | Developers | The six exported workflows, the naming rule, and how to read each one in the editor |
| [Testing HARSLL](testing.md) | Anyone changing the workflows | The 37 test scenarios, how to run them, how to read the report, how to add one |

Component guides live next to the code: [pretend RBIS](../mock-rbis/README.md), [test data](../test-data/README.md), [data folders](../data/README.md).

## Background

| Document | What it covers |
| --- | --- |
| [Build history](history/README.md) | How HARSLL was built: the trials, the three parallel build tracks, and their notes |
| [Source documents](source/README.md) | The original flowcharts this work is based on (kept local, never in Git) |

## Writing conventions

- **Business documents and guides** use plain English, with no system jargon. Technical detail goes in the setup, design and testing documents.
- **Anything inferred is labelled** as assumed or to be confirmed, and listed as an open question in the design.
- **Diagrams** are written in [Mermaid](https://mermaid.js.org/) so they render on GitHub and in the VS Code preview.
- **Docs change with the work.** When a workflow changes, its documentation changes in the same commit.
- A shared, commentable copy of an earlier business overview lives in Claude Docs. This repository is the source of truth.

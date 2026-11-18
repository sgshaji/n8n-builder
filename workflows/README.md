# Workflows

Exported n8n workflows live here as JSON files, one file per workflow. This folder is the source of truth: the copy inside n8n is the working copy.

## The HARSLL workflows

| File | Workflow in n8n | ID | Job |
| --- | --- | --- | --- |
| [`harsll-dispatcher.json`](harsll-dispatcher.json) | HARSLL – Dispatcher | `ixS5Wg5EN0IZwAjX` | Starts when a spreadsheet arrives, on a 15-minute timer, or on **Run now**. Records one case per row, archives the file, runs the Performer for each unfinished case, writes the staff worklist and emails a counts-only summary |
| [`harsll-performer.json`](harsll-performer.json) | HARSLL – Performer | `Bxb1mMwb4TOFuP8j` | Claims one case, runs the five safety checks, then updates RBIS or refers the case with a reason |
| [`harsll-rbis-adapter.json`](harsll-rbis-adapter.json) | HARSLL – RBIS adapter | `UEa9ahhsExQ8SXfb` | The only workflow that talks to RBIS. Looks before every change, so a repeated call never changes RBIS twice |
| [`harsll-settings.json`](harsll-settings.json) | HARSLL – Settings | `lq2vGGGRcILxjPpb` | Every setting in one place. Each default is an assumption until confirmed |

How they fit together: [design](../docs/design/HARSLL-n8n-design.md). Exact hand-overs between them: [interfaces](../docs/design/interfaces.md).

The IDs are those of the original local n8n. On another machine, importing gives new IDs: update `performerWorkflowId` and `adapterWorkflowId` in **HARSLL – Settings**, the Settings workflow ID in the Dispatcher's **Load settings** step, and the table IDs in Settings.

**Publish all four after importing.** A workflow called by another runs only its published version.

## Conventions

- **One file per workflow**, named after the workflow in kebab-case.
- **Export after every meaningful change**, and commit the JSON with a message that says what changed in business terms.
- **Remove the `shared` block** from an export before committing. It holds the n8n owner's name and email.
- **No secrets in exports.** Credentials are stored in n8n and referenced by name. Check a diff before committing.
- **No real data in exports.** Pinned test data must be made up.

How to import and export workflows is covered in [Run n8n locally with Docker](../docs/setup/01-run-n8n-locally.md#importing-and-exporting-workflows).

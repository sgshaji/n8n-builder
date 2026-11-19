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

## Reading the workflows in the editor

The Dispatcher and Performer are large (90 and 86 steps, including notes), so both are laid out to read left to right, in labelled boxes:

| Workflow | Boxes | Rows inside the boxes |
| --- | --- | --- |
| **Performer** | Start, Check 1 … Check 5, Update RBIS, Finish | **Top:** other paths (resume, joint rows, retries). **Middle:** the main path when everything passes. **Lower ("Reason: …"):** a check failed, so the case goes to staff. **Bottom ("Errors: …"):** something went wrong |
| **Dispatcher** | 1. Start, 2. Take in each file, 3a–3d after intake (close stuck cases, run the Performer on each case, report each batch, release the lock) | Each box reads left to right |

Some steps exist only to keep the lines tidy. They do nothing to the data:

- **Errors: start, Errors: check 1 …** (Performer): each box's error lines meet here, then go to **Describe the error** as one line.
- **Next file, Next case, Next batch** (Dispatcher): each loop's "go round again" lines meet here, then return to the loop as one line.

**Moving steps can change behaviour.** When one step feeds several branches, n8n runs them **top to bottom by their position on the canvas**. Two places in the Dispatcher depend on this, so they must keep their vertical order:

- after **Link rows of the same tenancy**: record new cases, then reopen earlier cases, then record the batch and archive the file;
- after **Intake finished**: close stuck cases, then run the cases, then report, then **release the lock last**.

The Performer has no such places.

## Conventions

- **One file per workflow**, named after the workflow in kebab-case.
- **Export after every meaningful change**, and commit the JSON with a message that says what changed in business terms.
- **Remove the `shared` block** from an export before committing. It holds the n8n owner's name and email.
- **No secrets in exports.** Credentials are stored in n8n and referenced by name. Check a diff before committing.
- **No real data in exports.** Pinned test data must be made up.

How to import and export workflows is covered in [Run n8n locally with Docker](../docs/setup/01-run-n8n-locally.md#importing-and-exporting-workflows).

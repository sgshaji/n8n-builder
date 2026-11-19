# Workflows

Exported n8n workflows live here as JSON files, one file per workflow. This folder is the source of truth: the copy inside n8n is the working copy.

## The HARSLL workflows

**Naming rule:** `HARSLL – <workflow that calls it>: <job>`. A workflow called by only one other is named after its caller, so the n8n list groups them and shows who calls whom. The Dispatcher and Performer keep the names of the two UiPath robots; Settings is used by all.

| File | Workflow in n8n | ID | Called by | Job |
| --- | --- | --- | --- | --- |
| [`harsll-dispatcher.json`](harsll-dispatcher.json) | HARSLL – Dispatcher | `ixS5Wg5EN0IZwAjX` | A spreadsheet arriving, a 15-minute timer, or **Run now** | Takes the lock, takes in each file, runs the Performer for each unfinished case, reports each finished batch, releases the lock |
| [`harsll-dispatcher-take-in-a-file.json`](harsll-dispatcher-take-in-a-file.json) | HARSLL – Dispatcher: take in a file | `KsUFs7e8kubcri9g` | The Dispatcher, once per file | Checks one file, records one case per new row and archives the file; or rejects it and emails staff |
| [`harsll-dispatcher-report-a-batch.json`](harsll-dispatcher-report-a-batch.json) | HARSLL – Dispatcher: report a batch | `dlr4h7esJCHtBP39` | The Dispatcher, once per batch waiting for its summary | When every case is finished: saves the staff worklist and emails a counts-only summary |
| [`harsll-performer.json`](harsll-performer.json) | HARSLL – Performer | `Bxb1mMwb4TOFuP8j` | The Dispatcher, once per case | Claims one case, runs the five safety checks, then updates RBIS or refers the case with a reason |
| [`harsll-performer-rbis-adapter.json`](harsll-performer-rbis-adapter.json) | HARSLL – Performer: RBIS adapter | `UEa9ahhsExQ8SXfb` | The Performer, once per RBIS step | The only workflow that talks to RBIS. Looks before every change, so a repeated call never changes RBIS twice |
| [`harsll-settings.json`](harsll-settings.json) | HARSLL – Settings | `lq2vGGGRcILxjPpb` | The Dispatcher, once per run | Every setting in one place. Each default is an assumption until confirmed |

How they fit together: [design](../docs/design/HARSLL-n8n-design.md). Exact hand-overs between them: [interfaces](../docs/design/interfaces.md).

The IDs are those of the original local n8n. **To install these files into any n8n, use the set-up script**: `node scripts/setup-harsll.mjs` (locally add `--create-mailpit-credential`). It creates the tables, writes the new table and workflow IDs into **HARSLL – Settings**, points the Dispatcher's **Load settings** step at Settings, and publishes all six in the right order. A plain import does none of that. See [Run n8n locally](../docs/setup/01-run-n8n-locally.md#6-install-harsll) and [Move HARSLL to another environment](../docs/setup/03-move-to-another-environment.md).

**A workflow called by another runs only its published version.** After editing one by hand in n8n, publish it, then export it here.

## Reading the workflows in the editor

Each workflow reads left to right, in labelled boxes, with a note at the top saying what it does:

| Workflow | Boxes | Rows inside the boxes |
| --- | --- | --- |
| **Dispatcher** | 1. Start, 2. Take in each file, 3a–3d after intake (close stuck cases, run the Performer on each case, report each batch, release the lock) | Each box reads left to right |
| **Dispatcher: take in a file** | One box | **Top:** unsafe file name. **Middle:** read the rows, record cases, archive. **Lower:** unreadable or wrong layout, so rejected |
| **Dispatcher: report a batch** | One box | One line: read the cases, then worklist and summary |
| **Performer** | Start, Check 1 … Check 5, Update RBIS, Finish | **Top:** other paths (resume, joint rows, retries). **Middle:** the main path when everything passes. **Lower ("Reason: …"):** a check failed, so the case goes to staff. **Bottom ("Errors: …"):** something went wrong |

Some steps exist only to keep the lines tidy. They do nothing to the data:

- **Errors: start, Errors: check 1 …** (Performer): each box's error lines meet here, then go to **Describe the error** as one line.
- **Next file, Next case, Next batch** (Dispatcher): each loop's "go round again" lines meet here, then return to the loop as one line.
- **Done with this file**, **Done with this batch** (the two Dispatcher sub-workflows): every path ends here before control goes back to the Dispatcher.

**Moving steps can change behaviour.** When one step feeds several branches, n8n runs them **top to bottom by their position on the canvas**. Two places depend on this, so they must keep their vertical order:

- **Dispatcher**, after **Intake finished**: close stuck cases, then run the cases, then report, then **release the lock last**;
- **Dispatcher: take in a file**, after **Link rows of the same tenancy**: record new cases, then reopen earlier cases, then record the batch and archive the file.

The Performer has no such places.

## Conventions

- **One file per workflow**, named after the workflow in kebab-case.
- **Export after every meaningful change**, and commit the JSON with a message that says what changed in business terms.
- **Remove the `shared` block** from an export before committing. It holds the n8n owner's name and email.
- **No secrets in exports.** Credentials are stored in n8n and referenced by name. Check a diff before committing.
- **No real data in exports.** Pinned test data must be made up.

How to import and export workflows is covered in [Run n8n locally with Docker](../docs/setup/01-run-n8n-locally.md#importing-and-exporting-workflows).

# HARSLL build interfaces

**Purpose:** the exact hand-overs between the HARSLL workflows, so they can be built in parallel and fit together. The [design](HARSLL-n8n-design.md) says *what* each part does; this document says *what passes between them*. If the two disagree, raise it; do not guess.

**Status:** written for the parallel build (19 November 2026) and updated at the reconcile stage to match what was built.

## Shared conventions

| Topic | Rule |
| --- | --- |
| Dates | Text `yyyy-MM-dd` everywhere (cases table, adapter, pretend RBIS). Empty date = `""` |
| Text normalising | `normalise(x)` = lower-case, every run of characters other than `a-z0-9` replaced by one space, then trimmed. Same as `mock-rbis/server.mjs`. Used for names, addresses and keys |
| Sub-workflow input | Trigger node **Execute Workflow Trigger** v1.3 with **Accept all data** (`inputSource: passthrough`) |
| Calling a sub-workflow | **Execute Sub-workflow** v1.4, `source: database`, workflow ID by **expression from settings** where the settings provide it, `waitForSubWorkflow: true` |
| Publishing | **A called workflow runs only its published version.** Publish it (activate) once, and check after every edit that the published version is current (`n8n_get_workflow` with `mode: active`). If it is stale, deactivate and activate again |
| Table nodes | **Data table** v1.1, table ID by **expression from settings**: `{"__rl": true, "mode": "id", "value": "={{ $json.settings.casesTableId }}"}` (proven to work) |
| Settings | Loaded once per Dispatcher run and passed down. Every sub-workflow receives a `settings` object and must not call the Settings workflow itself |
| Code nodes | Only where the design allows or no native node fits. Notes start with `Why Code:` |
| Node names | Plain English, saying what the step does: "Check 1: row usable?", "Refer case", not "IF1" |
| Workflow settings | `executionOrder: v1`, `timezone: Europe/London`. Leave run-history settings at their defaults during the build; they are set at the reconcile stage |
| Validation | Validate every workflow with the n8n-mcp validator before saving, and fix errors |
| **Silent expression errors** | In n8n 2.48.5 an expression that hits an ordinary JavaScript error (bad JSON, a property of `null`) does **not** stop the node: the value becomes `null`. Never rely on an expression failing to stop a dangerous path. Parse JSON only in Code nodes (they do stop), and check other values explicitly, with the cautious branch as the fallback |

## Settings

Workflow **HARSLL – Settings** (`lq2vGGGRcILxjPpb`, published). Returns one item: `{ "settings": { ... } }`.

| Key | Production value | Meaning |
| --- | --- | --- |
| `profile` | `production` | Which copy this is |
| `landlordNames` | `["Example Housing Association"]` | A liable party with one of these names is the landlord |
| `landlordLiabilityEndsOn` | `startDate` | Move-in: the landlord's liability ends on the tenant's start date (`dayBefore` = the day before) |
| `landlordLiableFrom` | `endDate` | Move-out: the landlord is liable from the tenancy end date (`dayAfter` = the day after) |
| `confirmLeaverIsLiable` | `true` | Check 4 safeguard |
| `jointTenantHandling` | `leadRowAddsAll` | Or `referLaterRows` |
| `addPersonToExistingTenancy` | `false` | The unconnected flowchart branch |
| `requiredSourceSystem` | `ABRITAS` | Used only when the setting above is on |
| `allowedChangeReasons` | `["TENANCY_START", "TENANCY_END"]` | |
| `deathHandling` | `refer` | Or `processAsEnd` |
| `deathChangeReasons` | `["DECEASED"]` | |
| `nameMatch` | `normalised` | Or `surnameOnly` |
| `requiredColumns` | `["ChangeReason", "AccountRef", "TenantName", "Address", "Postcode", "StartDate", "EndDate"]` | Header columns a file must have |
| `optionalColumns` | `["ForwardingAddress", "ContactEmail", "ContactPhone", "SourceSystem"]` | Read if present, empty if not |
| `maxAttempts` | `3` | |
| `stuckMinutes` | `15` | |
| `lockStaleMinutes` | `30` | |
| `fileSettleSeconds` | `60` | |
| `maxFileReadAttempts` | `3` | |
| `summaryEmailTo` / `summaryEmailFrom` | `harsll-team@example.test` / `harsll@example.test` | |
| `inputFolder`, `archiveFolder`, `rejectedFolder`, `reportsFolder` | `/files/input`, `/files/archive`, `/files/rejected`, `/files/reports` | |
| `rbisBaseUrl` | `http://mock-rbis:8080` | |
| `casesTableId`, `batchesTableId`, `lockTableId` | See [Tables](#tables) | |
| `takeInFileWorkflowId`, `reportBatchWorkflowId` | `KsUFs7e8kubcri9g`, `dlr4h7esJCHtBP39` | HARSLL – Dispatcher: take in a file, and HARSLL – Dispatcher: report a batch |
| `performerWorkflowId`, `adapterWorkflowId` | `Bxb1mMwb4TOFuP8j`, `UEa9ahhsExQ8SXfb` | HARSLL – Performer, and HARSLL – Performer: RBIS adapter |

The email credential is **Mailpit (local test mailbox)** (`qwZ9yygtBArarq6Q`, SMTP to `mailpit:1025`).

## Tables

All three kinds exist in n8n with the columns below. Columns not listed in the design were added: `tenancyKey`, `isLeadRow`, `relevantDate`.

| Table | Production | Track A | Track B | Track C |
| --- | --- | --- | --- | --- |
| Cases | `harsll_cases` `SBZZFYYtjdKZcTha` | `trackA_cases` `A0QezsR9YWAsD6Z9` | `trackB_cases` `fKgz5jaovu1lXFxF` | `trackC_cases` `rMQDvBaEjwGIanqf` |
| Batches | `harsll_batches` `4jaeshwJnybiuyp3` | | `trackB_batches` `Au3kGjRv0bauKmlw` | `trackC_batches` `uM2kkAGutYhptMNK` |
| Lock | `harsll_lock` `4iFl6qPseCy2DyGb` | | `trackB_lock` `SKA4C9Pihmt3oowK` | `trackC_lock` `hCHw5zGXvh5ddm5k` |

Each lock table has one row: `{ name: "dispatcher", lockedAt: null, lockedBy: "" }`.

### Cases table columns

| Column | Type | Written by | Value |
| --- | --- | --- | --- |
| `caseKey` | string | Dispatcher | See [Keys](#keys) |
| `tenancyKey` | string | Dispatcher | See [Keys](#keys) |
| `batchId` | string | Dispatcher | `<yyyy-MM-ddTHH-mm-ss>_<file name>` (local time). Replaced when a referred case is reopened |
| `rowNumber` | number | Dispatcher | Spreadsheet row; the header is row 1, so the first case is row 2 |
| `changeReason` | string | Dispatcher | As in the file, trimmed and upper-cased |
| `accountRef` | string | Dispatcher | Trimmed, upper-cased; `""` if empty |
| `address`, `postcode` | string | Dispatcher | Trimmed, as written |
| `isFlat` | boolean | Dispatcher | Address starts with "Flat" (ignoring case) |
| `tenantName` | string | Dispatcher | Trimmed, as written |
| `isLeadRow` | boolean | Dispatcher | First row of its tenancy group in the file |
| `jointTenants` | string | Dispatcher | Lead rows only: JSON array `[{"name","email","phone"}]` for the **other** rows in the group, in row order. `"[]"` if none |
| `coveredByCaseKey` | string | Dispatcher | Joint rows only: the lead row's `caseKey`. `""` on lead rows |
| `startDate`, `endDate` | string | Dispatcher | `yyyy-MM-dd`, or the original text if it is not a real date (so check 1 can refer it), or `""` |
| `relevantDate` | string | Dispatcher | `startDate` for a move-in, `endDate` for a move-out or death |
| `forwardingAddress`, `contactEmail`, `contactPhone`, `sourceSystem` | string | Dispatcher | Trimmed; `""` if empty |
| `status` | string | Both | `new`, `in_progress`, `updated`, `referred`, `duplicate`, `failed` |
| `reasonCode`, `reasonText` | string | Performer | From the design's reason-code table; `""` if none |
| `outcome` | string | Performer | `liability started`, `liability ended, address saved`, `liability ended`, or `""` |
| `urgent` | boolean | Performer | Stopped after at least one RBIS change |
| `stepsDone` | string | Performer | JSON array of step IDs, see [Step IDs](#step-ids). `"[]"` initially |
| `attempts` | number | Performer (claim) | `0` initially |
| `submissions` | number | Dispatcher | `1` initially; +1 when reopened |
| `previousResult` | string | Dispatcher | On reopen: JSON `{"status","reasonCode","batchId"}` of the earlier result. `""` otherwise. A reopened case also takes the new row's details (row number, address text, contacts, forwarding address, lead and joint links) |
| `lastAttemptAt` | date | Performer (claim) | Time the latest try started |
| `errorDetail` | string | Performer | Technical error text for `failed`; `""` otherwise |

### Keys

```text
relevantDate = TENANCY_START ? startDate : endDate          (deaths count as ends)
caseKey      = changeReason | accountRef | normalise(address) | normalise(tenantName) | relevantDate
tenancyKey   = changeReason | accountRef | normalise(address) | relevantDate
```

Parts joined with `|`. Example: `TENANCY_END|AC100004|4 example street|alan sample|2026-10-31`.

Rows with the same `tenancyKey` in one file form a tenancy group: the first is the lead row, the others are joint rows.

## Dispatcher triggers

The Dispatcher has **three** triggers. All three run the same steps.

| Trigger | Node | Detail |
| --- | --- | --- |
| File added | **Local File Trigger** | Folder from the trigger node (it cannot read settings): `/files/input` in production, `/files/trackB/input` during the build. Event "File Added", **Use Polling** and **Await Write Finish** on, then a **Wait** of `fileSettleSeconds` |
| Timer | **Schedule Trigger** | Every 15 minutes, not on the quarter hour. It is also the only trigger for files copied with an old modified time, which the file trigger may not notice |
| **Run now** | **Webhook**, `POST /webhook/harsll-run-now`, responds immediately with `{"started": true}` | **Addition to the design.** Lets the test runner start a run, for example to retry failed cases, without waiting for the timer. No waiting step. Local only; review before production |

## Dispatcher → take in a file

The Dispatcher calls **HARSLL – Dispatcher: take in a file** (ID from `settings.takeInFileWorkflowId`) once per settled spreadsheet, one at a time, waiting for each.

**Input**, one item: `{ "fileName": "harsll-main.xlsx", "settings": { ... } }`. The file is in `settings.inputFolder`.

**What it does:** everything for one file. Unsafe name: email once asking for a rename, leave the file. Unreadable: count the try, reject after `maxFileReadAttempts`. Wrong layout or no rows: reject at once. Otherwise: record one case per new case key, reopen referred cases sent again, record the batch, move the file to the archive. Rejected files are moved to `rejectedFolder` and staff are emailed.

**Output:** whatever its last step returns. The Dispatcher only needs it to move on, and moves on even if nothing comes back. It writes its results to the Cases and Batches tables itself. A missing reopen row still stops the whole run, as before.

**Order matters inside it.** After "Link rows of the same tenancy" three branches run top to bottom: record new cases, reopen earlier cases, record the batch and archive the file.

## Dispatcher → report a batch

The Dispatcher calls **HARSLL – Dispatcher: report a batch** (ID from `settings.reportBatchWorkflowId`) once per batch with `status = received` and no `summarySentAt`, one at a time, after it has checked it still holds the lock.

**Input**, one item: the batch row from the Batches table (`id`, `batchId`, `fileName`, `rowCount`, ...) plus `settings`.

**What it does:** reads the batch's cases. If any is unfinished, it stops and the batch waits for a later run. Otherwise it saves `reports/<batch>_worklist.xlsx` when staff have cases to look at, sends the counts-only summary email, and sets `summarySentAt`. If saving or sending fails, `summarySentAt` stays empty, so a later run tries again.

**Output:** as above, only used to move on.

## Dispatcher → Performer

The Dispatcher calls **HARSLL – Performer** (ID from `settings.performerWorkflowId`) once per case, one at a time, waiting for each.

**Input**, one item:

```json
{
  "caseId": 17,
  "expectedStatus": "new",
  "expectedAttempts": 0,
  "settings": { "...": "the full settings object" }
}
```

`caseId` is the Cases table row `id`. `expectedStatus` and `expectedAttempts` are the values the Dispatcher read; the Performer's claim only succeeds if they are unchanged.

**Output**, one item:

```json
{
  "caseId": 17,
  "caseKey": "TENANCY_START|AC100001|1 example street|amy sample|2026-11-01",
  "claimed": true,
  "status": "updated",
  "reasonCode": "",
  "outcome": "liability started",
  "urgent": false
}
```

`claimed: false` means another run had the case; the other fields are then the case's current values. A joint row whose lead row is still unfinished is **released**: put back as the Dispatcher found it, with output `claimed: true` and that status (`new` or `failed`). The Dispatcher reads statuses from the Cases table, so it treats such a row as unfinished. The Performer writes every result to the Cases table itself; the output is for the Dispatcher's counts only. **The Performer must never fail as a whole**: every error ends with the case marked `failed`, and the output says so.

## Performer → RBIS adapter

The Performer calls **HARSLL – Performer: RBIS adapter** (ID from `settings.adapterWorkflowId`) once per RBIS step.

**Input**, one item:

```json
{
  "operation": "addLiableParty",
  "rbisBaseUrl": "http://mock-rbis:8080",
  "ref": "AC100001",
  "params": { "name": "Amy Sample", "type": "tenant", "startDate": "2026-11-01" }
}
```

**Output**, one item, always (the adapter must never fail as a whole):

```json
{
  "ok": true,
  "operation": "addLiableParty",
  "ref": "AC100001",
  "alreadyDone": false,
  "data": { "...": "operation result" },
  "error": null
}
```

On failure `ok` is `false` and `error` is `{ "code", "message", "httpStatus", "transient" }`. `transient: true` means RBIS was unreachable, timed out, or answered 5xx: the Performer marks the case `failed` (`RBIS_ERROR`). `transient: false` is a business answer the Performer turns into a reason code.

| Operation | `params` | `data` when `ok` | Looks first; `alreadyDone: true` when | Business errors (`transient: false`) |
| --- | --- | --- | --- | --- |
| `findAccount` | `{ address, postcode }` | `{ found, reason, account }`. `reason`: `null`, `NOT_FOUND` or `ADDRESS_MISMATCH` | (read only) | none: not found is `ok: true, found: false` |
| `getAccount` | `{}` | `{ account }`, the pretend RBIS account view | (read only) | `ACCOUNT_NOT_FOUND` |
| `canTerminate` | `{}` | `{ canTerminate, reason }` | (read only) | `ACCOUNT_NOT_FOUND` |
| `endLiability` | `{ endDate, parties }`. `parties`: names whose liability should end | `{ account }` | None of `parties` is current, and each has a liability ending on `endDate` | `NO_CURRENT_LIABILITY`, `TERMINATION_NOT_ALLOWED`, `END_BEFORE_START` |
| `addLiableParty` | `{ name, type, startDate }`. `type`: `tenant` or `landlord` | `{ account }` | The party is current with that start date (RBIS `409 ALREADY_LIABLE` also counts) | `PARTY_REFUSED` |
| `createDetail` | `{ startDate, tenants }` | `{ account }` | A detail exists for `startDate` (RBIS `409 DETAIL_EXISTS` also counts) | |
| `setContactDetails` | `{ name, email, phone }` | `{ account }` | The same contact is already saved | |
| `setForwardingAddress` | `{ address }` | `{ account }` | The same address is already saved | |

Address match for `findAccount`: `normalise(address)` and `normalise(postcode)` both equal the account's. Only a `404` with code `ACCOUNT_NOT_FOUND` counts as "not found"; any other 404 (for example a wrong `rbisBaseUrl`) is an error. `data.account` is `null` whenever `found` is `false`.

Further adapter error codes, all with `httpStatus: null`:

| Code | `transient` | Meaning |
| --- | --- | --- |
| `RBIS_UNREACHABLE`, `RBIS_TIMEOUT` | `true` | No answer from RBIS. HTTP 408 and 429 also count as transient, like 5xx |
| `UNKNOWN_OPERATION`, `MISSING_REF`, `MISSING_RBIS_BASE_URL`, `INVALID_PARAMS` | `false` | The call was wrong. `endLiability` without `parties` is `INVALID_PARAMS` |
| `UNEXPECTED_RBIS_ANSWER` | `false` | RBIS answered in a shape the adapter cannot read; refused before any comparison or write |
| `ADAPTER_ERROR` | `false` | Anything else inside the adapter |

### Step IDs

The Performer records each successful RBIS change in `stepsDone`, as a JSON array of strings:

| Step | ID |
| --- | --- |
| End the landlord's or tenants' liability | `endLiability` |
| Add a person or the landlord | `addLiableParty:<normalise(name)>` |
| Create the detail record | `createDetail` |
| Save a person's contact details | `setContactDetails:<normalise(name)>` |
| Save the forwarding address | `setForwardingAddress` |

A step whose call returned `alreadyDone: true` is recorded too.

## Pretend RBIS copies

| Who | URL from n8n | URL from your machine | Rule |
| --- | --- | --- | --- |
| Everyone, after the build | `http://mock-rbis:8080` | http://localhost:8088 | Used by the workflows and the test runner |
| Track A (build only, removed) | `http://mock-rbis-a:8080` | http://localhost:8089 | |
| Track C (build only, removed) | `http://mock-rbis-c:8080` | http://localhost:8091 | |

All load `test-data/rbis-accounts.json`. Endpoints: [mock-rbis/README.md](../../mock-rbis/README.md).

## Track resources (build only)

These existed during the parallel build and were **removed at the reconcile stage**. Kept here as a record.

| Track | Builds | Uses | Folders |
| --- | --- | --- | --- |
| **A** | HARSLL – RBIS adapter, HARSLL – Performer | `trackA_cases`, `mock-rbis-a`. Passes its own settings object in tests | None |
| **B** | HARSLL – Dispatcher, HARSLL – Performer (stand-in, track B) | **HARSLL – Settings (track B, dev)** (`lI18cfcKFPSv2heB`), `trackB_*` tables | `data/trackB/` = `/files/trackB/` |
| **C** | Test kit: scenarios, spreadsheet generator, test runner | `trackC_*` tables, `mock-rbis-c` | `data/trackC/` = `/files/trackC/` |

Rules for every track:

- **Webhook paths are shared across all workflows.** Prefix any test webhook with your track: `track-a-…`, `track-b-…`, `track-c-…`. The only exception is `harsll-run-now`, owned by track B.
- **You may turn on "Available in MCP"** for your own workflows, to run them through the MCP tools.
- **Touch only your own resources.** Never change, reset or delete another track's tables, pretend RBIS, folders, workflows or files, and never the production ones.
- **Do not run `git add`, `git commit` or `git push`.** The reconcile stage commits everything.
- **Do not edit shared files**: `README.md`, `CLAUDE.md`, `docs/design/HARSLL-n8n-design.md`, this file, `compose.yaml`, `.env.example`. Put proposed changes in your build notes.
- **Write build notes** in `docs/build-notes/track-<A|B|C>.md`: what you built (workflow names and IDs), how you tested it and the results, every place you departed from the design or this document and why, and open issues.

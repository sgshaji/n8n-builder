# Build notes: track C (test kit)

**Date:** 19 November 2026. **Scope:** the test kit for the HARSLL workflows: the scenario list with expected results, a spreadsheet generator, a test runner, unit tests, and a draft testing guide. The workflows (tracks A and B) did not exist in their final form during this work, so the full suite has **not** been run. Everything that could be checked without them was.

## What was built

| File | What it is |
| --- | --- |
| `test-data/scenarios.json` | All 37 scenarios from the design's test plan: rows, set-up, groups, expected cases, expected pretend-RBIS changes, file, email, summary and worklist checks, and checkpoints part-way through a group |
| `test-data/spreadsheets/*.xlsx` | 18 test files generated from `scenarios.json` (17 committed; `~$temp-book.xlsx` is ignored by Git, see proposals) |
| `scripts/make-test-spreadsheets.mjs` | Generator. `--check` exits 1 if the committed files are out of date. Output is identical byte for byte on every run |
| `scripts/run-tests.mjs` | Test runner, profiles `production` (default) and `trackC`. Options `--only`, `--include-slow`, `--list`, `--self-check`, `--verbose`, `--run-now-url`, `--dispatcher-name` |
| `scripts/run-tests.test.mjs` | 38 unit tests (`node --test scripts/`) |
| `scripts/lib/xlsx.mjs` | **Addition:** a minimal `.xlsx` writer (zip with `node:zlib` `deflateRawSync` and CRC32) and reader (for worklists) |
| `scripts/lib/scenario-kit.mjs` | **Addition:** keys, the reference tidy rules, expected cases, comparators, and a reference model of the design used to cross-check the expectations |
| `docs/testing.md` | Draft testing guide, plain English |
| `test-data/README.md` | Two rows added to its file table, and the run-time accounts listed |

`zlib.crc32` exists in both Node 22 (22.23.5 in the containers) and Node 26 (26.13.0 on the host); the writer uses it and falls back to a table-driven CRC32, which the unit tests compare against it.

### How the scenarios are grouped

Each group starts from a clean state: the pretend RBIS is reset, the Cases and Batches tables are emptied, the lock is freed, the four folders are emptied and (production profile only) the test mailbox is emptied. So groups are independent, and `--only` runs just the groups needed.

| Group | Scenarios | Drops | Steps |
| --- | --- | --- | --- |
| `main` | 1–23, 30, 32, 34, 37 | 1 (six files) | Outage on AC100023 (first call, count 1); drop; wait; Run now until every case is finished (up to 4); one extra Run now (the rename email must not repeat) |
| `retry-24` | 24 | 1 | Outage `before` on `addLiableParty` for AC100024, count 1; drop; wait; checkpoint; Run now until finished |
| `retry-25` | 25 | 1 | Outage `afterChange` on `addLiableParty` for AC100025, count 1; as above |
| `retry-27` | 27 | 1 | Outage `before` on `terminate` for AC100027, count 1; as above |
| `fails-and-unreadable` | 26, 31 | 1 (two files) | Permanent outage on AC100026 (reads too); drop; wait; checkpoint; Run now until 3 tries and the file rejected (up to 5); one extra Run now |
| `re-runs` | 28, 29 | 2 | Drop `same-file` + `resend-first`; checkpoint; add AC100029; drop `same-file` again + `resend-second` |
| `copying` | 33 | 1 | Add AC100033; drop a fresh file and an Excel temporary file; Run now at once (must not read the fresh file); checkpoint; wait for the file trigger's own run |
| `two-runs` | 35 | 1 | Drop a file already settled (backdated 2 minutes); two Run now calls at the same moment |
| `while-stopped` | 36 | 1 | Slow, production profile only: `docker compose stop n8n`, drop, `start`, wait up to 18 minutes |

The pretend RBIS holds **one** outage at a time, so the retry scenarios cannot share a pass. Scenario 23 shares the main pass because no other scenario there needs an outage. Estimated run time: **about 14 minutes** without the slow group (`--list` shows the estimate per group), mostly the Dispatcher's one-minute settle wait per drop.

### What the runner compares

- **Cases table**, matched by `caseKey` (built by the runner from the row, with the interfaces rule): `status`, `reasonCode`, `reasonText` (the design's exact text), `outcome`, `urgent`, `isLeadRow`, `coveredByCaseKey`, `jointTenants` (as JSON, by content), `attempts`, `submissions`, `stepsDone` (as JSON, in order), `batchId` (resolved from the Batches table by file name and drop), `previousResult`, `errorDetail` (non-empty where stated), and every field the Dispatcher fills in (`rowNumber`, `changeReason`, `accountRef`, `address`, `postcode`, `isFlat`, `tenantName`, dates, `relevantDate`, `tenancyKey`, contact fields, `sourceSystem`). Also: exactly one row per `caseKey`, rows that must not exist (from rejected files), and rows that no scenario expects.
- **Pretend RBIS** `GET /changes` per account, in order, with the key fields of each change. `""` and `null` count as equal; `tenants` in `createDetail` may be names or objects with a `name`.
- **Folders**: archive, rejected or left in input. An archived name may carry a prefix (for example the batch time stamp).
- **Batches table**: number of rows per file, `status`, `rowCount`, `readAttempts`.
- **Emails** (production profile; the mailbox is read only during the build): emails to `harsll-team@example.test` that mention the file name. Summary emails: one per file, counts parsed from the subject or body, the URGENT line, and no tenant names or addresses.
- **Worklist**: `reports/<batchId>_worklist.xlsx`, read with the kit's own reader. Rows are matched to cases by tenant name (unique within each test file) and account; exactly the expected members; urgent ones first.

## How it was verified, and the results

| Check | Result |
| --- | --- |
| Every generated file opened with Python openpyxl 3.1.5 | 16 of 16 spreadsheets open with the expected rows and columns. Dates come back as real dates, `dd/MM/yyyy` text and the number `46327`. `unreadable.xlsx` and `~$temp-book.xlsx` fail to open, as intended |
| Every file read through n8n (a harness workflow: Read/Write Files from Disk from `/files/trackC/input`, Extract from File XLSX, header row on, Include Empty Cells on) | All rows read. After the reference tidy rules (`tidyExtractedDate`), all 31 rows of the main file give exactly the expected case keys and dates; 0 mismatches in every file. Real Excel dates arrive as `"2026-11-01T00:00:00.000Z"`, text stays text, the day number stays `46327` (as trial 2 found). See the findings below |
| Expectations cross-checked against a reference model of the design (`referenceRun`: intake, linking, re-sent rows, the five checks, the update paths, against an in-memory copy of `rbis-accounts.json`) | All 46 expected rows and every expected RBIS change list agree. This catches slips (wrong dates, postcodes, step order); it cannot catch a misreading shared by both |
| Unit tests, `node --test scripts/` | **38 of 38 pass** on Node 26 (host) and on Node 22 (a throwaway `node:22-alpine` container with the repo mounted read-only) |
| Runner self-check, `node scripts/run-tests.mjs --profile trackC --self-check` | **77 of 77 pass.** It covers four areas, listed below the table |
| Runner timing against a stand-in Dispatcher of my own (see Workflows) | All pass, listed below the table |
| Rehearsal of a whole group (`copying`) through `runGroup` against the stand-in | The steps ran in order, and the checkpoint passed: the fresh file stayed in input with no batch row. The final report listed the expected differences (the stand-in makes no cases), each clear |

**The self-check covers:**
- **Pretend RBIS on mock-rbis-c.** Reset; an outage scoped to one account leaves the others alone; count 1 fails once and then recovers; reset switches the outage off and reloads the accounts.
- **Tables through the public API.** Insert, read and clear rows, and free the lock. A held lock counts as busy and a free one as idle.
- **Simulated correct results for all 37 scenarios, which all PASS.** The simulation writes the expected rows into the trackC tables and puts files and worklists in the trackC folders. It also replays every expected RBIS change on mock-rbis-c, which proves each sequence is possible on the pretend RBIS, including the lost reply in scenario 25.
- **Deliberately wrong results, which each FAIL with the expected difference.** The cases covered:
  - a wrong status;
  - a missing case;
  - a duplicate case;
  - `stepsDone` in the wrong order;
  - a wrong tidied date;
  - an extra RBIS call;
  - a row from a rejected file that became a case;
  - a worklist with urgent cases last;
  - a rejected file that is missing, and a wrong batch status.

  It also confirms that every other scenario still passes and that an unexpected case is reported.

**The timing checks against the stand-in show:**
- Run now returns after one full pass (about 4.6 s).
- Two Run now calls at the same moment are handled.
- A file less than a minute old is not moved by an immediate Run now.
- The file trigger's run counts as busy while it waits out the minute.
- `waitForDispatcher` returns 64 s after the drop, once that run has moved the file and finished.
- A backdated file is moved at once.

### Findings for tracks A and B

1. **File names with brackets are not read unless an option is on.** Read/Write Files from Disk treats its path as a glob pattern. A name such as `together (2).xlsx` silently finds no file (`This operation expects the node's input data to contain a binary file 'data', but none was found`) unless **Treat Brackets and Parentheses as Literal** (`options.literalBrackets`) is on. The safe-name rule allows `( )`, so the Dispatcher needs this option. Scenario 34's second file has such a name.
2. **A plain text file named `.xlsx` is not "unreadable" to n8n**: Extract from File returns zero rows. Only a damaged zip fails, as `Bad compressed size`. So scenario 31 uses a truncated spreadsheet. An Excel temporary file (`~$…`) also reads as zero rows, so it must be skipped by name, as the design says.
3. **A header-only file gives zero items**, so "at least one row" has to be tested with "Always Output Data" or a count. A file missing a column gives items without that key.
4. **Dates in British Summer Time are not shifted.** Real dates in April, June and October all arrived as midnight UTC of the right day.
5. **The container's `find` is BusyBox.** `-mmin +0` lists a file only when it is **60 seconds or older** (59 s: not listed; 63 s: listed). The Dispatcher's trigger fires about 1 to 2 s after the file arrives, then waits 60 s, so a just-dropped file is listed on that run, but only just.
6. **Copying a file on Windows keeps its old modification time** (`fs.copyFileSync`, and Explorer too). A copied file therefore counts as settled as soon as the copy ends. That is fine for the Dispatcher; the runner writes files instead of copying them, so each drop starts a fresh minute.
7. **The executions API leaves running executions out of its plain list.** Use `status=running` (a run inside a short Wait shows as `running`) and `status=waiting`.

## n8n public API endpoints used

All with the header `X-N8N-API-KEY` (read from `.env` with `readEnv`, never printed). Found by testing against the track C tables.

| Method and path | Use | Notes |
| --- | --- | --- |
| `GET /api/v1/data-tables` | List tables and their columns | |
| `GET /api/v1/data-tables/{id}/rows?limit=250&cursor=…` | Read rows | Paged: follow `nextCursor` until `null` |
| `POST /api/v1/data-tables/{id}/rows` | Insert rows (self-check) | Body `{"data": [ … ], "returnType": "all"}`; missing columns are stored as `null` |
| `PATCH /api/v1/data-tables/{id}/rows/update` | Free the lock; change rows (self-check) | Body `{"filter": {"type": "and", "filters": [{"columnName", "condition": "eq", "value"}]}, "data": { … }, "returnData": true}`. Returns the updated rows, or `[]` if none matched |
| `DELETE /api/v1/data-tables/{id}/rows/delete?filter=…&returnData=false` | Clear the Cases and Batches tables | `filter` (URL-encoded JSON, as above) is **required** (400 without it). All rows: `{"columnName": "id", "condition": "gt", "value": 0}` |
| `GET /api/v1/workflows?name=…` | Find the Dispatcher by name | Matches names that **contain** the text, so the runner picks the exact name itself |
| `GET /api/v1/executions?workflowId=…&status=running` (and `waiting`, `new`) | Is the Dispatcher busy? | See finding 7 |

Also used: Mailpit `GET /api/v1/messages?limit=&start=` and `GET /api/v1/message/{ID}` (read), `DELETE /api/v1/messages` (production profile only; never run during the build); the pretend RBIS's `/health`, `/reset`, `/changes`, `/simulate-outage`, `PUT /admin/accounts/{ref}`, and its write endpoints (self-check replay, mock-rbis-c only).

## Ambiguities, and the reading chosen

Each was settled from the design and interfaces where possible, otherwise with the most cautious reading: the one that would show a departure from the design.

| # | Point | Reading chosen |
| --- | --- | --- |
| 1 | **Scenario 25, which reply is lost?** If the reply to the *first* change is lost, `stepsDone` is empty, so by the design's rule the retry runs the checks again and check 4 misreads the half-changed account | The lost reply is on the **second** change (landlord added on a move-out), the case the design clearly covers. Track A has since added handling for the first-change case (their departure 1); proposed scenario 25b below |
| 2 | `outcome` of a referred (including urgent) or duplicate row | `""`. Track A does the same |
| 3 | `createDetail` `tenants` | A list of names, lead first. The comparator also accepts objects with a `name`. Track A does the same |
| 4 | Joint row of an urgent lead (21) | Not urgent: the joint row changed nothing itself |
| 5 | Scenario 6 dates | Move-out and move-in on the **same** date, with the move-in first in the file, so only "move-outs before move-ins on the same date" gives the right order. The landlord is then liable for no days, as the default settings imply |
| 6 | Scenario 18 | A **move-out** on AC100018: a move-in with the landlord liable passes check 4 without a date test |
| 7 | Scenario 9: date of an unknown change reason | The end date (interfaces' key formula). The row has both dates, real and in order, so only the change-reason test can stop it (Track A departure 4 agrees) |
| 8 | Check 1 on a move-out with no start date | Valid (the template says StartDate is "for move-ins"). Scenario 4 also gives the tenancy start date and contact details; neither may change the move-out path |
| 9 | Scenario 23, "before any RBIS call" | An outage on the account's first call of any kind (`includeReads`), recovering after one failure; expects `attempts: 2`. If the adapter retried HTTP calls internally the failure would be hidden and the scenario fails, deliberately |
| 10 | When a failed case is retried | On a later run, not within the same pass. The checkpoints after the first pass expect `failed` with `attempts: 1` (24, 25, 27) |
| 11 | Scenario 26 | `failed`, `RBIS_ERROR` (not `PROCESSING_STOPPED`, which is for stuck cases), `attempts: 3`, not urgent, `errorDetail` set, in the worklist, summary shows 1 failed; a fourth run must not try it again |
| 12 | Scenario 27 | The move-in is never tried before the move-out finishes, so it ends with `attempts: 1` (a held case keeps 0 tries; Track A's "release" also puts tries back) |
| 13 | Scenario 28, second drop | A second batch row, file archived again, the case untouched (`batchId` of the first drop, `submissions: 1`, `attempts: 1`), no new RBIS change. Whether a summary is sent for a batch with no new cases is **not** checked |
| 14 | Scenario 29, reopened row | `batchId` = the new file's batch, `submissions: 2`, tries counted again from 0 (1 at the end), `previousResult` = `{status, reasonCode, batchId}` of the first result; counted in the new file's summary (1 case, 1 updated) |
| 15 | Rejected files (30, 31) | Batch row `rejected`; **one** email per file, mentioning the file name; no summary email for them. A header-only file is "no rows" |
| 16 | Unreadable file (31) | One batch row, updated on each run (`unreadable`, `readAttempts` 1 → 3, then `rejected`); no email until it is rejected |
| 17 | Unsafe name (32) | A batch row `needs_rename`; one email even after more runs; the file stays in input |
| 18 | "Still being copied" (33) | A modification time less than a minute old. A run started then must not read it. The temporary file gets no batch row and no email |
| 19 | Scenario 35, "one takes the lock" | Shown by the outcome: one batch row, one case, `attempts: 1`, one set of RBIS changes. The lock itself is not watched |
| 20 | Summary email format | Subject or body contains "N cases" and "N updated / referred / failed / duplicate"; a count of 0 may be left out; an "URGENT … N" line when N > 0; the file name appears; no tenant names or addresses |
| 21 | Worklist | `reports/<batchId>_worklist.xlsx`; columns are not fixed by the design, so rows are matched by tenant name and account; members are referred cases, updated cases with a follow-up, and failed cases with no tries left; urgent first |
| 22 | `reasonText` | Must equal the design's plain-English text exactly ("From the design's reason-code table") |
| 23 | Batch row fields | `fileName` is the file's own name; `rowCount` is the number of data rows; an archived file's batch stays `received` |
| 24 | Defaults on every case | `submissions: 1` unless re-sent; `""` equals `null`; a `null` flag equals `false` |

## Proposed changes (not made: shared files)

**`test-data/rbis-accounts.json`**

- Add **AC100033** ("33 Example Street", "EX1 7AJ", landlord liable from 2026-09-01; note "Scenario 33"). Scenario 33 adds it at run time today, from `accountsAddedAtRunTime` in `scenarios.json`; adding it to the file would make that step unnecessary. AC100029 should stay out of the file: scenario 29 depends on it being missing at first.
- If scenario 25b is added: **AC100040**, a tenant liable (move-out), for a lost reply on the **first** change.
- If a stuck-case scenario is added: **AC100041**, landlord liable.

**Test plan (design)**

- **25b: reply lost on the first change.** This needs a decision in the design (Track A's departure 1 is one answer).
- **38: n8n stops in the middle of a run.** A case is left `in_progress`: it should be retried after `stuckMinutes`, and become `PROCESSING_STOPPED` once its tries run out. No current scenario covers this. It can be tested without stopping n8n: insert a case `in_progress` with an old `lastAttemptAt`, then Run now.

**Other**

- `.gitignore`: add `!test-data/spreadsheets/~$*.xlsx` if the Excel temporary test file should be committed. Not required: the runner builds it in memory.
- Pretend RBIS: allow several outages at once (a list). The three retry groups could then share one drop, saving about 3 minutes.
- `docs/README.md`: move the testing guide out of "Coming in later phases" into the document table. `README.md` status table: add the test kit when Phase 4 is reconciled.

## What the reconcile stage must do to run the full suite

1. Publish the four workflows with the production settings, including `performerWorkflowId` and `adapterWorkflowId` (Track A gives the IDs). The Dispatcher needs three things:
   - a Local File Trigger on `/files/input`;
   - the Run now webhook `POST /webhook/harsll-run-now`;
   - the name **HARSLL – Dispatcher**, or pass `--dispatcher-name`. The runner watches its executions to know when it has finished; without it, the runner falls back to the lock.
2. Make sure the Dispatcher reads files with brackets in their names (finding 1).
3. The stack is up: n8n, Mailpit, and `mock-rbis` on port 8088 with the committed accounts. The production tables exist (they do).
4. Run `node --test scripts/`, then `node scripts/run-tests.mjs` (about 14 minutes), then `node scripts/run-tests.mjs --only 36 --include-slow` (stops and starts n8n; nobody else should be using it).
5. For each failure, decide from the **design** whether the workflow or the expectation is wrong. Never change an expectation just to match what a workflow does. Record any design change, and update `scenarios.json` and the spreadsheets together (`node scripts/make-test-spreadsheets.mjs`).
6. Fill in the real timings in `docs/testing.md` and drop its "draft" status.
7. Commit `test-data/scenarios.json`, `test-data/spreadsheets/`, the scripts and the docs.

## Workflows created and deleted

Both were used only on track C resources, and were **deactivated and deleted** at the end of the work:

| ID | Name | What it did |
| --- | --- | --- |
| `lwSBiv3WXPHMIXXj` | TRACK C – spreadsheet read harness (delete after the build) | Webhooks `track-c-read-xlsx` (Read/Write Files from Disk from `/files/trackC/input` + Extract from File), `track-c-list-settled` (the `find -mmin +0` list, on `/files/trackC/input`), `track-c-wait` (a 20-second Wait, to see how running executions are listed) |
| `VWTlVnuVmRBT44Py` | TRACK C – Dispatcher stand-in for runner checks (delete after the build) | Webhook `track-c-run-now` and a Local File Trigger on `/files/trackC/input` (60-second wait); took the `trackC_lock` row with a conditional update, moved settled files to `/files/trackC/archive`, waited 3 s, released the lock |

At the end: `trackC_cases` and `trackC_batches` are empty, the `trackC_lock` row is free, mock-rbis-c has been reset, and `data/trackC/*` is empty. The shared test mailbox was only read. `harsll-run-now`, the production tables, `mock-rbis` and `mock-rbis-a` were not used. Apart from these two workflows, the only container I started was a throwaway `node:22-alpine` container, used to run the unit tests on Node 22.

## Departures from the brief

- **Two library files** (`scripts/lib/xlsx.mjs`, `scripts/lib/scenario-kit.mjs`) hold the code that the generator, runner and tests share.
- **The trackC profile also empties `data/trackC/*`.** These are track C's own folders, and the self-check needs them clean. The brief named folder cleaning for the production profile only. Mailpit is still never cleared in the trackC profile.
- **The runner writes files rather than copying them**, using the bytes built from `scenarios.json` (identical to the committed files; it warns if they are out of date). A Windows copy keeps the old modification time, which would make every file look settled.
- **`test-data/README.md` was updated** for the new files. It is not on the list of shared files.

## Open issues

1. **The full suite has not been run.** The workflows were not ready. The timings are estimates.
2. **The email, summary and worklist checks rest on assumptions** (ambiguities 15, 17, 20 and 21). Track B's actual formats may need small changes to `compareSummary` and `compareWorklist`, not to the expectations.
3. **The 15-minute timer can fire during a group.** End results are unaffected, but a checkpoint may then see one try more than expected. Re-run the group if that happens.
4. **Scenario 36 has not been tried**, because stopping n8n would have interrupted the other tracks.

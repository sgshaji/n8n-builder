# test-data/

Made-up data for building and testing HARSLL. **Everything here is invented**: the people, the addresses (all on "Example Street"), the account references and the landlord ("Example Housing Association"). Never put real data in this folder. It is committed to Git.

| File | What it is | Used by |
| --- | --- | --- |
| [`rbis-accounts.json`](rbis-accounts.json) | The accounts the pretend RBIS starts with: 31 accounts, each set up for one or more test scenarios | [`mock-rbis`](../mock-rbis/README.md) |
| [`scenarios.json`](scenarios.json) | The 37 test scenarios: spreadsheet rows, set-up, groups and expected results | [`scripts/run-tests.mjs`](../scripts/run-tests.mjs) |
| [`sample/harsll-sample.xlsx`](sample/harsll-sample.xlsx) | A 10-row sample spreadsheet for trying HARSLL, built from 8 of the scenarios by `node scripts/try-sample.mjs --write-file`. Do not edit it by hand | [`scripts/try-sample.mjs`](../scripts/try-sample.mjs) and [Try HARSLL with sample data](../docs/guides/try-harsll-with-sample-data.md) |
| [`spreadsheets/`](spreadsheets/) | The test spreadsheets, generated from `scenarios.json` by [`scripts/make-test-spreadsheets.mjs`](../scripts/make-test-spreadsheets.mjs). Do not edit them by hand | The test runner |

How to run the tests: [Testing HARSLL](../docs/testing.md).

`spreadsheets/~$temp-book.xlsx` (an Excel temporary file, for scenario 33) is generated but not committed, because `.gitignore` ignores `~$*` files. The test runner builds it when it needs it.

## The accounts

Each account has a `note` saying which scenario in the [design's test plan](../docs/design/HARSLL-n8n-design.md#test-plan) it is for. Each scenario has its own account, so one test cannot disturb another.

| Field | Meaning |
| --- | --- |
| `ref` | Account reference, `AC1000nn` |
| `address`, `postcode`, `isFlat` | The property. `isFlat` decides the address search format |
| `liabilities` | History of who was liable: `party`, `type` (`landlord` or `tenant`), `start`, `end`. An `end` of `null` means liable now |
| `canTerminate` | `false` makes RBIS refuse to end the liability (scenario 20) |
| `refuseParties` | People RBIS refuses to add (scenarios 21 and 22) |
| `note` | What the account is for. Not visible to HARSLL |

Three scenarios need an account that is **not** in the file: scenario 13 uses `AC999999`, which does not exist; scenario 29 adds `AC100029` while the test runs; and scenario 33 adds `AC100033` while the test runs (both are in `scenarios.json`, under `accountsAddedAtRunTime`). Scenarios 30, 31 and 32 name `AC100030` to `AC100032`, which do not exist, so a row from a rejected file that became a case by mistake would show.

After changing this file, reload it:

```bash
curl -X POST http://localhost:8088/reset
```

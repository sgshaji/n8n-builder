# test-data/

Made-up data for building and testing HARSLL. **Everything here is invented**: the people, the addresses (all on "Example Street"), the account references and the landlord ("Example Housing Association"). Never put real data in this folder. It is committed to Git.

| File | What it is | Used by |
| --- | --- | --- |
| [`rbis-accounts.json`](rbis-accounts.json) | The accounts the pretend RBIS starts with: 31 accounts, each set up for one or more test scenarios | [`mock-rbis`](../mock-rbis/README.md) |

Test spreadsheets and the list of scenarios with their expected results are added when the Performer and Dispatcher workflows are built.

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

Two scenarios need an account that is **not** in the file: scenario 13 uses `AC999999`, which does not exist, and scenario 29 adds `AC100029` while the test runs.

After changing this file, reload it:

```bash
curl -X POST http://localhost:8088/reset
```

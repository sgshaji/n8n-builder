# Try HARSLL with sample data

**For:** anyone who wants to see HARSLL work, from the process owner to a new developer. It takes about 5 minutes on a laptop where HARSLL is already set up locally ([setup guide](../setup/01-run-n8n-locally.md)): the sample itself runs in a little over a minute.

## Do we need mock data?

**Yes, and it's already here.** HARSLL must never be tried out with real tenants or the real council tax system. The repository includes a complete set of **made-up data**:

| What | Where | What it is |
| --- | --- | --- |
| A **pretend RBIS** | Runs next to n8n, at http://localhost:8088 | A stand-in for the council tax system, with 31 made-up accounts. It answers HARSLL exactly as RBIS is expected to, and records every change made |
| The **made-up accounts** | [`test-data/rbis-accounts.json`](../../test-data/rbis-accounts.json) | People called "… Sample" at addresses on "Example Street", each account set up for a particular situation |
| A **sample spreadsheet** | [`test-data/sample/harsll-sample.xlsx`](../../test-data/sample/harsll-sample.xlsx) | 10 tenancy changes for those accounts: a mix that HARSLL should update and refer |
| The **full test set** | [`test-data/`](../../test-data/README.md) | 37 test scenarios and their spreadsheets, used by the automated tests |
| A **test mailbox** | http://localhost:8025 | Catches every email HARSLL sends, so nothing reaches a real person |

**In another environment** (for example a BCC test system), the same idea applies, but the made-up accounts must exist in **that** environment's test copy of RBIS, and the spreadsheet rows must match them. The real RBIS and real tenant data are never used for testing. See [Testing in another environment](#testing-in-another-environment).

## The sample's 10 rows

Each row uses its own made-up account, set up in the pretend RBIS for that situation, so the right outcome is known in advance:

| Person | Change | What the pretend RBIS shows | Expected outcome |
| --- | --- | --- | --- |
| Amy Sample | Moves in, 1 Nov 2026 | The landlord is liable (the property was empty) | **Updated:** the landlord's liability ends, Amy becomes liable, her contact details are saved |
| Bella Sample | Moves in, 2 Nov 2026, with Bruno | The landlord is liable | **Updated:** both Bella and Bruno become liable |
| Bruno Sample | Moves in with Bella | (same account) | **Covered by another row:** Bella's row already added him |
| Alan Sample | Moves out, 31 Oct 2026, with a forwarding address | Alan is liable | **Updated:** Alan's liability ends, the landlord's starts, the forwarding address is saved |
| Dora Sample | Moves out, "31/02/2026" | — | **Referred:** the date doesn't exist |
| Eric Sample | Died, 28 Oct 2026 | — | **Referred:** deaths go to staff (a setting) |
| Iris Sample | Moves in, account AC999999 | No such account | **Referred:** the account could not be found |
| Jade Sample | Moves in, "13 Other Street" | The account is at a different address | **Referred:** the account could not be found at that address |
| Ivan Sample | Moves in, 1 Nov 2026 | Ivan is already liable, from a different date | **Referred:** the dates in RBIS don't match the spreadsheet |
| Mona Sample | Moves out, 31 Oct 2026 | RBIS won't allow the liability to be ended | **Referred:** RBIS does not allow the liability to be ended |

So: **3 updated, 1 covered by another row, 6 referred.** No account is changed unless all the safety checks pass.

## Option 1: one command (recommended)

From the repository folder, with the local stack running (`docker compose up -d --wait`):

```bash
node scripts/try-sample.mjs
```

It asks before it starts, because it **clears the local test data first**: the HARSLL tables, the `data/` folders, the test mailbox, and the pretend RBIS's changes. Then it puts the sample spreadsheet into `data/input`, waits for HARSLL to finish (about 2 minutes), and prints what happened to each row:

```text
What happened to each row (✓ = the outcome the design expects):

    Person        Change                 Outcome                  Why
  ✓ Amy Sample    Moved in 2026-11-01    Account updated          RBIS: liability started
  ✓ Bella Sample  Moved in 2026-11-02    Account updated          RBIS: liability started
  ✓ Bruno Sample  Moved in 2026-11-02    Covered by another row   Covered by an earlier row for the same tenancy
  ✓ Alan Sample   Moved out 2026-10-31   Account updated          RBIS: liability ended, address saved
  ✓ Dora Sample   Moved out 31/02/2026   Referred to staff        The dates on the spreadsheet row are wrong or missing
  ✓ Eric Sample   Died 2026-10-28        Referred to staff        The tenancy ended because the tenant died; these are passed to staff
  ✓ Iris Sample   Moved in 2026-11-01    Referred to staff        The account could not be found in RBIS
  ✓ Jade Sample   Moved in 2026-11-01    Referred to staff        The account could not be found in RBIS
  ✓ Ivan Sample   Moved in 2026-11-01    Referred to staff        The dates in RBIS do not match the spreadsheet
  ✓ Mona Sample   Moved out 2026-10-31   Referred to staff        RBIS does not allow the current liability to be ended

10 of 10 rows ended as expected. The pretend RBIS recorded 13 changes to 3 accounts.
```

It ends by listing where to look: the summary email, the worklist, the archived spreadsheet, every case in n8n, and the changes made to the pretend RBIS.

## Option 2: by hand

This shows the same thing using only the normal folders and web pages.

1. **Start fresh.** Reset the pretend RBIS, so its accounts are as described above:

   ```bash
   curl -X POST http://localhost:8088/reset
   ```

   If you've tried the sample before, also delete the old rows in n8n (**Overview → Data tables → `harsll_cases`** and **`harsll_batches`**), or HARSLL will see the rows as already done. Option 1 does all this for you.

2. **Copy** `test-data/sample/harsll-sample.xlsx` into `data/input`.
3. **Wait about 2 minutes.** The file disappears from `data/input` and appears in `data/archive`, with the date and time added to its name.
4. **Look at the results:**

   | Where | What you'll see |
   | --- | --- |
   | **Test mailbox**, http://localhost:8025 | The summary email: 3 updated, 6 referred, 1 covered by an earlier row |
   | **`data/reports/`** | The worklist: the 6 referred cases, one row each, with the reason |
   | **n8n → Overview → Data tables → `harsll_cases`** | One row per case, with its status, reason and outcome |
   | **n8n → Executions** | Usually nothing: successful runs aren't kept, because they'd hold personal data. Failed runs appear here |
   | **http://localhost:8088/changes** | Every change HARSLL made to the pretend RBIS, in order |
   | **http://localhost:8088/accounts/AC100001** | Amy's account after the change: the landlord ended, Amy liable from 1 Nov |

## Things to try next

| Try | How | What you should see |
| --- | --- | --- |
| **Send the same file again** | Copy `harsll-sample.xlsx` into `data/input` again, without resetting | A second summary: **6 cases, 0 updated, 6 referred**. The 4 rows already done are skipped. The 6 referred rows count as "sent again", so they are checked again, and, since nothing about them has changed, referred again. RBIS gets no new changes |
| **A file with a bad name** | Copy the sample to `data/input` as `sample;test.xlsx` | An email asking for the file to be renamed. The file stays where it is |
| **The full test set** | `node scripts/run-tests.mjs` (about 11 minutes) | 37 scenarios, each checked in detail, including RBIS failing part-way and retries. See [Testing HARSLL](../testing.md) |

## Making your own test rows

Your rows need accounts in the pretend RBIS that are set up for the situation you want to test. The simplest way is to copy a row from the sample and change one thing, for example the date. To test a new situation, add an account to [`test-data/rbis-accounts.json`](../../test-data/rbis-accounts.json) and reload it with `curl -X POST http://localhost:8088/reset`. [Testing HARSLL](../testing.md#adding-a-scenario) explains how to turn it into a permanent automated test.

Keep to made-up data: names ending "Sample" or "Test", addresses on "Example Street", emails ending `example.test`.

## Testing in another environment

Before HARSLL goes live anywhere, it should be tried in that environment's **test** set-up:

1. **A test copy of RBIS**, never the live one. The RBIS adapter's address is a setting, so pointing HARSLL at a test RBIS is a settings change.
2. **Test accounts** in that RBIS, set up for the situations in the sample (an empty property where the landlord is liable, a current tenant moving out, an account RBIS won't let you end, and so on).
3. **A spreadsheet that matches those accounts.** Use the sample as the template; change the account references, names and addresses to the test accounts. `node scripts/make-test-spreadsheets.mjs` shows how the test files are built from a list of rows.
4. **A test mailbox or a test distribution list** for the summary emails.

Whether test accounts may be copies of real ones (anonymised) or must be invented is BCC's decision under its data protection rules. Until then, invent them. Moving HARSLL to another environment: [setup guide](../setup/03-move-to-another-environment.md).

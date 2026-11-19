# Using HARSLL day to day

**For:** the team that sends HARSLL its spreadsheets and deals with the cases it passes back. No n8n knowledge is needed. For what happens behind the scenes, see [How HARSLL works](how-harsll-works.md).

> **Some of this is still to be decided** with the process owner: where the input folder will be in the live system, who reviews referred cases and how quickly, and the exact spreadsheet columns. Those points are marked **To be confirmed**. Locally, the input folder is `data/input` in this repository.

## The short version

1. **Save the spreadsheet** of tenancy changes into the **input folder**.
2. **Wait.** HARSLL starts within a minute or two of the file arriving (and checks every 15 minutes anyway).
3. **Read the summary email** when it arrives. It gives counts only.
4. **Open the worklist** named in the email, if there is one, and deal with each case on it, **urgent cases first**.
5. **To retry a referred case** after fixing the problem, send its row again in a new spreadsheet.

## 1. Sending a spreadsheet

### The file

- **Excel `.xlsx`**, with the changes on the first sheet and the column names in the first row.
- **One row per person.** Two joint tenants moving in together are two rows with the same address, account and date. HARSLL links them.
- **A simple file name:** letters, numbers, spaces and `_ - . ( )` only, ending `.xlsx`. For example `tenancy changes 2026-11-19.xlsx`. A name with other characters (such as `&`, `;` or `'`) is not read: you get an email asking you to rename it.
- **Save it, then leave it.** HARSLL reads a file only once it has stopped changing for a minute, so a slow copy is fine. Excel's temporary `~$...` files are ignored.
- **The same file sent twice does no harm.** Rows already done are skipped.

### The columns

**To be confirmed:** these are the columns HARSLL is set up for today. The real export from the housing system may use different names; HARSLL can be adjusted to match it.

| Column | Needed? | What to put | Example (made up) |
| --- | --- | --- | --- |
| `ChangeReason` | Always | `TENANCY_START` (moved in), `TENANCY_END` (moved out) or `DECEASED` | `TENANCY_START` |
| `AccountRef` | Strongly advised | The council tax account reference | `AC100234` |
| `TenantName` | Always | One person's full name | `Jane Test` |
| `Address` | Always | The property address. Start with "Flat" for a flat | `Flat 2, 12 Example Street` |
| `Postcode` | Always | | `EX1 1AA` |
| `StartDate` | For a move-in | The tenancy start date | `01/11/2026` |
| `EndDate` | For a move-out or death | The tenancy end date | `31/10/2026` |
| `ForwardingAddress` | If known | Where a leaver can be contacted | `4 New Road, EX2 2BB` |
| `ContactEmail`, `ContactPhone` | If known | A new tenant's contact details | `jane@example.test` |
| `SourceSystem` | Optional | Where the change came from | `ABRITAS` |

Dates can be typed as `dd/mm/yyyy` or entered as real Excel dates. A file missing any of the "Always" columns is rejected straight away, with an email saying which column is missing.

## 2. What happens next

Within about two minutes of the file arriving (longer for big files):

- the file disappears from the input folder and appears in the **archive** folder, with the date and time added to its name;
- each row becomes a **case**, and each case is checked and either applied to the council tax account or referred;
- when every case is finished, the **summary email** arrives.

If RBIS is unavailable, the cases affected are tried again automatically on the next runs, every 15 minutes, up to 3 times. The summary email waits until every case has an outcome, so it can arrive later than usual.

## 3. The summary email

One email per spreadsheet. It contains **counts only**, never names or addresses, so it is safe to forward. For example:

```text
Subject: HARSLL batch 2026-11-19 09:14 – 18 cases: 11 updated, 5 referred, 1 failed, 1 duplicate

File: changes.xlsx (archived)

URGENT – RBIS partly changed, needs a person now: 1

Updated: 11
  Liability started: 5   (1 needs contact details added)
  Liability ended, address saved: 3
  Liability ended: 3

Referred to staff: 5
  The account could not be found in RBIS: 2
  The dates in RBIS do not match the spreadsheet: 1
  The tenancy ended because the tenant died: 1
  A person could not be added to the account: 1   (urgent)

Failed after 3 tries: 1
Covered by an earlier row for the same tenancy: 1

Worklist: reports/2026-11-19T09-14-03_changes_worklist.xlsx
```

| Line | Meaning | Do you need to act? |
| --- | --- | --- |
| **Updated** | The council tax account was changed | No, unless a follow-up is mentioned (such as contact details to add) |
| **Referred to staff** | HARSLL was not sure, so it left the account exactly as it was | Yes: see the worklist |
| **Failed after 3 tries** | A technical problem that did not clear up | Yes: tell IT support (the worklist has the technical detail) |
| **Covered by an earlier row** | A joint tenant who was added by the first row of the same tenancy | No |
| **URGENT** | RBIS was partly changed before the case stopped, for example the old tenant was ended but the new one could not be added | **Yes, first.** The account is half-done |

## 4. The worklist

If any case needs a person, the email names a **worklist**: a spreadsheet in the reports folder. It lists only the cases to look at, **urgent first**, with one row each:

| Column | What it tells you |
| --- | --- |
| Urgent | "URGENT – RBIS partly changed" for half-done accounts |
| What happened | Referred to staff, Updated – follow-up needed, or Failed after N tries |
| Reason, Reason code | Why, in plain English, and the short code |
| RBIS changes already made | For urgent cases: exactly which changes were made before it stopped |
| Spreadsheet row, Change, Account ref, Tenant name, Address, Postcode, Start date, End date | The row as HARSLL read it |
| Earlier result | If this row was sent before, what happened that time |
| Technical detail | For failed cases: the error, for IT support |
| Case ID | HARSLL's reference for the case, if IT support needs it |

The worklist holds personal data. Keep it where it is; don't email it around.

### What to do with each reason

The suggested actions are what each reason implies; **To be confirmed** by the process owner, along with who reviews referred cases and how quickly.

| Reason | What it means | What you would typically do |
| --- | --- | --- |
| The dates on the spreadsheet row are wrong or missing | A date is impossible (such as 31/02/2026), missing, or the end is before the start | Correct the dates with the housing team, then send the row again |
| The tenancy ended because the tenant died | Deaths are not handled automatically (a setting) | Handle the account by hand, following the council's process for deaths |
| The reason for the change is not one the automation handles | `ChangeReason` is something other than the three accepted values | Check the row; handle it by hand or correct and resend |
| The row has no account reference | `AccountRef` is empty | Find the account, add the reference, send the row again |
| The account could not be found in RBIS | No account with that reference at that address | Identify the right account, for example from the address; correct and resend, or update by hand |
| RBIS has no start date to compare against | The current liability in RBIS has no start date | Check the account in RBIS and update by hand |
| The dates in RBIS do not match the spreadsheet | RBIS shows a different date from the housing record | Decide which record is right; correct the wrong one |
| RBIS already shows this change | Someone has already made the change | Check the account looks right; usually nothing more to do |
| The person leaving is not the liable person in RBIS | Someone else is liable in RBIS | Check who should be liable; update by hand |
| RBIS does not allow the current liability to be ended | RBIS refused to end the liability | Find out why RBIS is blocking it |
| A person could not be added to the account | RBIS refused to add a tenant | Add the person by hand. Often **urgent**: the old liability may already be ended |
| The earlier row for this tenancy was not completed | A joint tenant whose first row was referred, so they were not added | Deal with the first row; this person needs adding too |
| Liability started, but there were no contact details to record | Updated, but no email or phone was given | Add contact details if you have them |
| RBIS did not respond or returned an error | Technical, after 3 tries | Tell IT support |
| Processing stopped unexpectedly and the tries ran out | Technical: the process was interrupted 3 times | Tell IT support |

## 5. Sending a corrected row again

Once you've fixed the cause, for example corrected a date in the housing system or added a missing account reference:

1. Put the corrected row (or rows) in a **new spreadsheet** with a new file name.
2. Save it into the input folder as usual.

HARSLL recognises a row that was **referred** before and tries it again with the new details. The worklist shows the earlier result next to it. Rows that were already **updated** are never done twice, even if you send them again.

## 6. When a file is rejected

You get an email in either case:

| The email is about | Why | What to do |
| --- | --- | --- |
| Renaming the file | The file name has characters HARSLL won't use | Rename it (letters, numbers, spaces, `_ - . ( )`) and save it into the input folder again. You get this email only once per name |
| A required column is missing | The file doesn't have the expected columns | Fix the columns and send it again |
| No rows | The file has headings but no data | Check you exported the right file |
| A file that could not be read | The file is damaged; HARSLL tried 3 times | Export or save it again and send the new copy |

Rejected files are moved to the **rejected** folder, with the date and time added to the name. Nothing from a rejected file has been processed.

## Things to avoid

- **Don't edit or rename a file in the input folder** once it's there. Make changes before saving it in.
- **Don't put anything except tenancy-change spreadsheets** in the input folder.
- **Don't change an account by hand while its case is still being processed.** Wait for the summary email.
- **Don't forward the worklist.** It contains personal data. The summary email is safe to forward.

## Questions

**How do I know HARSLL received my file?** The file leaves the input folder within about two minutes and appears in the archive folder.

**The summary email hasn't arrived.** The email waits until every case is finished. If RBIS was unavailable, retries take up to 15 minutes each. If nothing arrives within an hour, tell IT support.

**Can HARSLL change the wrong account?** It changes an account only if the reference **and** the address match, and RBIS shows what the change expects. Anything else is referred.

**What if the same tenant appears in two spreadsheets?** The same change is done once. A different change (for example a move-in, then a later move-out) is done in date order.

**Who looks at referred cases?** **To be confirmed** by the process owner.

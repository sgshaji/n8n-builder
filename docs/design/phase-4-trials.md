# Phase 4 trials: results

**Run on:** 19 November 2026, n8n 2.48.5 in Docker on Windows 11 (ARM), repo in a OneDrive folder.
**Result:** all four trials passed. The [design](HARSLL-n8n-design.md) stands, with three small build details added.

The design asked for four short trials before building, because each one tested something the design depends on but had not been proven on this setup. The trial workflows, table and files were deleted afterwards.

## Summary

| # | Question | Answer | Effect on the build |
| --- | --- | --- | --- |
| 1 | Does the file trigger notice a new file here? | **Yes.** It fired 2 seconds after a file was dropped. Two files dropped together raised two separate events | Keep the trigger, with the timer as the safety net |
| 2 | How does n8n return Excel dates? | Real dates arrive as date-time text; text stays text; numbers stay numbers; **empty cells are left out** unless an option is turned on | Turn on "Include Empty Cells"; handle all three date forms |
| 3 | Can files be listed once settled, and moved safely? | **Yes.** A fixed command lists files unchanged for a minute and skips Excel temporary files. Safe names move; unsafe names are refused before any command runs | Use `-mmin +0` in the list command |
| 4 | When several runs claim the same row at once, does exactly one win? | **Yes**, in 25 races of 8 simultaneous claims. The winner gets the row back; the others get nothing | The claim and the lock can be built as designed. No fallback needed |

## Trial 1: file trigger

**Setup.** A workflow with a Local File Trigger on `/files/input`: event "File Added", polling on, "await write finish" on. Files were copied into `data/input` from Windows.

| Test | Result |
| --- | --- |
| One file dropped at 01:53:09 | Workflow started at 01:53:11, with the file's path |
| Two files dropped together at 01:54:21 | Two runs started at 01:54:23, one per file |

**Not tested here:** a file arriving while n8n is stopped. The 15-minute timer covers that case by design, and test scenario 36 checks it once the Dispatcher is built.

## Trial 2: Excel dates

**Setup.** A spreadsheet with one date written seven ways, read with Read/Write Files from Disk and Extract from File (XLSX, header row on).

| Cell contains | n8n returns |
| --- | --- |
| A real Excel date, 1 November 2026 | `"2026-11-01T00:00:00.000Z"` |
| A real Excel date with a time, 14:30 | `"2026-11-01T14:29:59.999Z"` (one millisecond early) |
| Text `01/11/2026` | `"01/11/2026"` |
| Text `2026-11-01` | `"2026-11-01"` |
| The plain number 46327 | `46327` |
| Text `31/02/2026`, an impossible date | `"31/02/2026"` |
| An empty cell | **The column is missing from that row** |

With the option **Include Empty Cells** on, the empty cell comes back as `""` and every row has every column.

**What this means for the build:**

- **Turn on Include Empty Cells.** Otherwise a column that happens to be empty looks the same as a column that is missing, and the "required columns present" test would be wrong.
- **Tidy rows must accept three forms:** date-time text (take the date part, after rounding to the nearest second because of the millisecond drift), `dd/MM/yyyy` text, and Excel day numbers.
- An impossible date stays as text, so check 1 can refer it as `DATES_INVALID`.

## Trial 3: listing settled files and moving files

**Setup.** One Execute Command node with a fixed command, and a second that moves a file only after an IF node has checked its name.

**Listing.** A file was created at 01:53:08 and the list was read twice:

| Read at | `find … -mmin +0` | `find … -mmin +1` |
| --- | --- | --- |
| 01:53:08, file just created | Not listed | Not listed |
| 01:54:19, file 71 seconds old | **Listed** | Not listed |

So `-mmin +0` means "unchanged for at least one minute", which is what the design needs. `-mmin +1` would wait two minutes. An Excel temporary file (`~$settle-test.xlsx`) was never listed.

**Moving.**

| File name | Result |
| --- | --- |
| `settle-test.xlsx` | Moved |
| `changes (1).xlsx` (space and brackets) | Moved |
| `x';touch /files/trials/pwned;'.xlsx` | Refused. No command ran, no file was created |
| `a$(touch /files/trials/pwned2).xlsx` | Refused. No command ran, no file was created |
| `../input/x.xlsx` | Refused |

The name test is the pattern `^[A-Za-z0-9 _.()-]+\.xlsx$`.

## Trial 4: the claim and the lock

**Setup.** A table with one row (`holder = free`). A workflow updates the row to `holder = <caller>` **only if** `holder` is still `free`, using the Data table node's Update with "all conditions must match". A script reset the row and then sent 8 claims at the same moment, 25 times.

| Measure | Result |
| --- | --- |
| Winners per race | Exactly 1, in all 25 races |
| What the winner's node returns | The updated row |
| What a loser's node returns | No rows (one empty item when "Always Output Data" is on) |

**What this means for the build:** the per-case claim and the Dispatcher lock work as designed. The fallback in the design (n8n's own limit of one run at a time) is not needed.

**Limit.** The trial ran on SQLite, n8n's default database. If the real environment uses another database, repeat this trial there.

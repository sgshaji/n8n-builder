# data/

The folder the HARSLL workflows read from and write to. Inside the n8n container it appears as `/files`, the only folder n8n may touch.

**Everything here except this README is ignored by Git.** Put only made-up test spreadsheets here, never real tenant data.

| Folder | Inside n8n | Purpose |
| --- | --- | --- |
| `input/` | `/files/input` | Drop a spreadsheet of tenancy changes here to start HARSLL |
| `archive/` | `/files/archive` | Each spreadsheet is moved here once its rows are recorded, with the date and time added to its name |
| `rejected/` | `/files/rejected` | Spreadsheets that could not be used: wrong columns, no rows, or unreadable |
| `reports/` | `/files/reports` | Staff worklists: the cases from each spreadsheet that need a person |

Create the folders if they are missing:

```powershell
New-Item -ItemType Directory -Force data/input, data/archive, data/rejected, data/reports
```

```bash
mkdir -p data/input data/archive data/rejected data/reports
```

The tests and the sample run (`scripts/try-sample.mjs`) empty these folders before they start.

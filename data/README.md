# data/

The folder n8n workflows read from and write to. Inside the n8n container it appears as `/files`.

**Everything here except this README is ignored by Git.** Put only made-up test spreadsheets here, never real tenant data.

| Folder | Inside n8n | Purpose |
| --- | --- | --- |
| `input/` | `/files/input` | Drop a spreadsheet of tenancy changes here to start the Dispatcher |
| `archive/` | `/files/archive` | The Dispatcher moves each spreadsheet here once it has been processed |

Create the folders if they are missing:

```powershell
New-Item -ItemType Directory -Force data/input, data/archive
```

```bash
mkdir -p data/input data/archive
```

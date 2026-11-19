# Run n8n locally with Docker

This guide sets up a local n8n, installs HARSLL in it, and shows it working. It takes about 15 minutes the first time.

## What you get

| Service | Address | What it is for |
| --- | --- | --- |
| **n8n** | http://localhost:5678 | The workflow editor, where the HARSLL workflows are built and run |
| **Mailpit** | http://localhost:8025 | A test mailbox. It catches every email n8n sends, so nothing reaches a real person |
| **Pretend RBIS** | http://localhost:8088 | A stand-in for the real council tax system, with made-up accounts. See [mock-rbis/README.md](../../mock-rbis/README.md) |

All three are reachable **only from your own machine**.

| Folder in the repo | Inside n8n | Purpose |
| --- | --- | --- |
| `data/input/` | `/files/input` | Drop a test spreadsheet here to start the Dispatcher |
| `data/archive/` | `/files/archive` | Processed spreadsheets are moved here |
| `data/rejected/` | `/files/rejected` | Spreadsheets that could not be used |
| `data/reports/` | `/files/reports` | Staff worklists |
| `workflows/` | `/workflows` | Exported workflow files, for import and export |

n8n's own database (workflows, credentials, run history) lives in a Docker volume called `n8n-builder_n8n_data`, **not** in the repo folder. This keeps it out of Git and out of OneDrive.

## Before you start

You need:

- **Docker Desktop**, installed and running. On Windows it uses WSL 2. Wait until Docker Desktop shows "Engine running".
- **Git**, and a clone of this repo.
- **Node.js 20 or later**, for the set-up script, the sample run and the tests. n8n itself runs in Docker, so your Node version doesn't need to match n8n's.

Check Docker is ready:

```bash
docker version
```

If this shows an error about connecting to the Docker engine, Docker Desktop is not running yet.

## First-time setup

Run these commands from the repo folder.

### 1. Create your settings file

`.env` holds your local settings. It is ignored by Git, so it never leaves your machine.

**Windows (PowerShell):**

```powershell
Copy-Item .env.example .env
$bytes = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
(Get-Content .env) -replace '^N8N_ENCRYPTION_KEY=$', "N8N_ENCRYPTION_KEY=$key" | Set-Content .env
```

**macOS or Linux:**

```bash
cp .env.example .env
sed -i.bak "s/^N8N_ENCRYPTION_KEY=$/N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env && rm .env.bak
```

Open `.env` and check that `N8N_ENCRYPTION_KEY=` now has a long random value after it.

> **Keep this key.** n8n uses it to encrypt saved passwords and API keys. If it changes, n8n cannot read them any more. Each person can have their own key on their own machine.

### 2. Create the data folders

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Force data/input, data/archive, data/rejected, data/reports
```

**macOS or Linux:**

```bash
mkdir -p data/input data/archive data/rejected data/reports
```

### 3. Start n8n

```bash
docker compose up -d --wait
```

The first start downloads the images (they need about 2 GB of disk space) and can take a few minutes. When it finishes you should see all three containers as **Healthy**.

### 4. Create your n8n owner account

1. Open http://localhost:5678.
2. Fill in the **Set up owner account** form: email, name and password.
   - This account exists only in your local n8n. No email is sent to the address.
   - Use a password you will remember. A password manager is best.
3. Skip or close the optional survey and licence prompts.

You now have a working n8n.

### 5. Create an API key

The set-up script, the sample run and the tests talk to n8n through its API.

1. In n8n, open **Settings → n8n API** and click **Create an API key**. Label: `local scripts`. Expiry: 90 days is sensible.
2. Copy the key (n8n shows it only once) and paste it into `.env` after `N8N_API_KEY=`.

[Connect the n8n MCP servers](02-connect-mcp-servers.md) uses the same key.

### 6. Install HARSLL

```bash
node scripts/setup-harsll.mjs --create-mailpit-credential
```

This creates the three tables, the test-mailbox login and the six workflows, wires them together and publishes them. It takes a few seconds and prints what it did. Running it again later updates HARSLL in place: use it after pulling changes from Git. Add `--dry-run` to see what it would do without changing anything. All its options: [Move HARSLL to another environment](03-move-to-another-environment.md#step-5-install).

### 7. See it work

```bash
node scripts/try-sample.mjs
```

This clears the local test data, puts a 10-row made-up spreadsheet into `data/input`, and shows what HARSLL did with each row, in about two minutes. See [Try HARSLL with sample data](../guides/try-harsll-with-sample-data.md).

## Everyday use

| Task | Command |
| --- | --- |
| Start | `docker compose up -d --wait` |
| Stop (data is kept) | `docker compose down` |
| Check status | `docker compose ps` |
| Follow the n8n log | `docker compose logs -f n8n` |
| Restart after changing `.env` or `compose.yaml` | `docker compose up -d --wait` |

Docker Desktop must be running for any of these. n8n restarts automatically when Docker Desktop starts, unless you stopped it with `docker compose down`.

## Settings explained

All settings are in [`compose.yaml`](../../compose.yaml) and `.env`.

| Setting | Value | Why |
| --- | --- | --- |
| `N8N_VERSION` | `2.48.5` (in `.env`) | Pinned so everyone runs the same version. See [Upgrading n8n](#upgrading-n8n) |
| `N8N_ENCRYPTION_KEY` | Random, per person (in `.env`) | Encrypts saved credentials |
| `TIMEZONE` | `Europe/London` | Dates and schedules use UK time |
| `N8N_RESTRICT_FILE_ACCESS_TO` | `/files` | Workflows can only touch files in `data/`, nowhere else |
| `NODES_EXCLUDE` | `[]` | n8n 2.x turns off the **Local File Trigger** and **Execute Command** nodes by default. HARSLL needs both: one to start when a spreadsheet arrives, one to move it to the archive. **Local development only; review before production** |
| `N8N_SMTP_*` | Mailpit | Any email n8n sends itself goes to the test mailbox |
| `N8N_DIAGNOSTICS_ENABLED` | `false` | No usage data is sent to n8n |
| `MOCK_RBIS_PORT` | `8088` | Port for the pretend RBIS on your machine. Workflows always use `http://mock-rbis:8080` |
| Ports | `127.0.0.1` only | n8n, Mailpit and the pretend RBIS cannot be reached from other machines on the network |

Workflows that send email, such as the batch summary, use an n8n **SMTP credential** named "Mailpit (local test mailbox)": host `mailpit`, port `1025`, no SSL, no login. The set-up script creates it (step 6).

## Importing and exporting workflows

Workflows are kept in Git as JSON files in [`workflows/`](../../workflows/). See that folder's README for naming rules.

**To install or update all six from Git, use the set-up script** (step 6). It also wires the IDs together, which a plain import does not. The methods below are for working on one workflow at a time.

**In the editor:**

- **Export:** open the workflow → **⋯** menu → **Download**. Save it into `workflows/`.
- **Import:** **⋯** menu on a new workflow → **Import from File**.

**From the command line** (the `workflows/` folder appears inside n8n as `/workflows`):

```bash
# Export one workflow (find its ID in the editor URL)
docker compose exec n8n n8n export:workflow --id=<WORKFLOW_ID> --output=/workflows/harsll-dispatcher.json

# Import one workflow
docker compose exec n8n n8n import:workflow --input=/workflows/harsll-dispatcher.json
```

Before committing an export, check the diff for anything that looks like real data or a secret.

From Phase 2, Claude Code can also create and update workflows directly through the n8n MCP servers.

## Upgrading n8n

1. Read the n8n release notes for every version between the current one and the new one. Look for breaking changes.
2. Change `N8N_VERSION` in `.env.example` **and** in your `.env`.
3. Run `docker compose up -d --wait`.
4. Run the HARSLL tests: `node scripts/run-tests.mjs` (see [Testing HARSLL](../testing.md)).
5. Commit the `.env.example` change, saying which version you moved to and why.

## Starting again from scratch

> ⚠️ **This deletes everything in your local n8n**: workflows, credentials, run history and your owner account. Export any workflows you want to keep first.

```bash
docker compose down --volumes
docker compose up -d --wait
```

Then create the owner account and an API key again (steps 4 and 5), and install HARSLL again (step 6).

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `failed to connect to the docker API` | Start Docker Desktop and wait for "Engine running" |
| `Set N8N_ENCRYPTION_KEY in .env` | You have no `.env`, or the key is empty. Redo step 1 |
| `port is already allocated` | Something else uses port 5678, 8025 or 8088. Change `N8N_PORT`, `MAILPIT_UI_PORT` or `MOCK_RBIS_PORT` in `.env`, then start again |
| Pretend RBIS gives unexpected answers after a test | Its data has been changed by earlier runs. Reset it: `curl -X POST http://localhost:8088/reset` |
| n8n says it cannot decrypt credentials | The encryption key changed. Put the old key back in `.env`, or start from scratch |
| A file dropped in `data/input` does not start the workflow | In the **Local File Trigger** node, turn on **Use Polling**. On Windows, file events do not reach Docker reliably without it |
| Log says `Failed to start Python task runner` | Harmless. HARSLL uses JavaScript only |
| Log lists deprecations, for example task runner settings | Harmless for local use. They will be reviewed when moving to the real environment |

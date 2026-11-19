# Set up HARSLL on your computer

**For:** anyone who wants HARSLL running on their own Windows or Mac computer, to see it work, demonstrate it or change it. No n8n experience needed.

**Time:** about 30 to 45 minutes the first time, most of it installing tools and downloading. After that, starting it takes a minute.

**What you end up with:** your own private copy of n8n with HARSLL installed, a test mailbox, and a pretend council tax system with made-up accounts. Nothing connects to a real council system, and every email stays on your computer.

| Step | What you do | Time |
| --- | --- | --- |
| [Before you start](#before-you-start-install-three-tools) | Install Docker Desktop, Git and Node.js | 15 to 25 min |
| [Get the code](#get-the-code) | Accept the GitHub invitation and download the repository | 5 min |
| [Steps 1 to 6](#first-time-setup) | Settings file, start n8n, account, API key, install HARSLL | 10 min |
| [Step 7](#7-see-it-work) | Run the 10-row sample and look at the results | 5 min |

## Before you start: install three tools

| Tool | What it's for | Get it |
| --- | --- | --- |
| **Docker Desktop** | Runs n8n, the test mailbox and the pretend RBIS in containers, so nothing else needs installing | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| **Git** | Downloads the code and keeps it up to date | [git-scm.com/downloads](https://git-scm.com/downloads) |
| **Node.js**, version 20 or later (the "LTS" download) | Runs the set-up script, the sample run and the tests | [nodejs.org](https://nodejs.org/) |

**On Windows** you can install all three from PowerShell instead:

```powershell
winget install Docker.DockerDesktop
winget install Git.Git
winget install OpenJS.NodeJS.LTS
```

**On a Mac** with Homebrew: install Docker Desktop from the link above, then `brew install git node`.

Notes:

- **Docker Desktop on Windows** uses WSL 2. The installer sets it up, but may ask you to restart, and may need administrator rights. Start Docker Desktop after installing and wait until it shows **Engine running**.
- **Docker Desktop licence:** it is free for personal use, education and small businesses. Larger organisations need a paid Docker subscription, so check that yours has one.
- **Close and reopen PowerShell** (or Terminal) after installing, so it finds the new tools.

Check all three are ready. Each should print a version, and Node.js should be 20 or higher:

```bash
docker version
git --version
node --version
```

If `docker version` shows an error about connecting to the Docker engine, Docker Desktop is not running yet.

## Get the code

The code is in a **private** GitHub repository, so you need a GitHub account with access to it.

1. **Accept the invitation.** The repository owner invites your GitHub account. Accept it from the invitation email, or at https://github.com/sgshaji/n8n-builder/invitations while signed in to GitHub.
2. **Choose a folder** for the code. A plain local folder such as `C:\Projects` is best. Avoid OneDrive or other synced folders: HARSLL moves files around constantly, and syncing gets in the way.
3. **Download the repository** into that folder:

   ```powershell
   cd C:\Projects
   git clone https://github.com/sgshaji/n8n-builder.git
   cd n8n-builder
   ```

   The first time, Git opens a browser window to sign in to GitHub. If it says **Repository not found**, the invitation hasn't been accepted yet, or you signed in with a different GitHub account.

**Run every command from here on inside the `n8n-builder` folder.** If you open a new PowerShell window later, go back there first: `cd C:\Projects\n8n-builder`.

## First-time setup

### 1. Create your settings file

`.env` holds your local settings and keys. Git ignores it, so it never leaves your computer. These commands copy the template and put a new random encryption key in it.

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

✔ Open `.env` in any text editor (for example `notepad .env`). The line `N8N_ENCRYPTION_KEY=` now has a long random value after it.

> **Keep this key.** n8n uses it to encrypt the passwords and keys it stores. If it changes, n8n can no longer read them. Everyone has their own key on their own computer.

### 2. Create the data folders

These are where spreadsheets go in and come out.

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

The first start downloads about 2 GB and can take a few minutes.

✔ It ends by listing three containers as **Healthy**: `n8n`, `mailpit` (the test mailbox) and `mock-rbis` (the pretend RBIS).

### 4. Create your n8n account

1. Open http://localhost:5678 in your browser.
2. Fill in the **Set up owner account** form: email, name and password.
   - This account exists only in your own n8n. No email is sent.
   - Use a password you will remember.
3. Skip or close the optional survey and licence prompts.

✔ You see n8n's **Overview** page, with no workflows yet.

### 5. Create an API key

The set-up script, the sample run and the tests talk to n8n through its API, using a key.

1. In n8n, click your name (bottom left) → **Settings** → **n8n API** → **Create an API key**. Label: `local scripts`. Expiry: 90 days is sensible.
2. **Copy the key now**: n8n shows it only once.
3. Paste it into `.env` after `N8N_API_KEY=`, with no spaces or quotes, and save the file.

### 6. Install HARSLL

```bash
node scripts/setup-harsll.mjs --create-mailpit-credential
```

In a few seconds this:

- creates the three Data tables HARSLL keeps its records in;
- installs the six workflows and connects them to each other;
- fills in **HARSLL – Settings** with the right IDs;
- creates the login for the test mailbox, and connects the email steps to it;
- publishes all six, so HARSLL is now live on your computer.

✔ It prints a summary ending with the six workflows **published**. In n8n, **Overview** now lists six **HARSLL** workflows.

You can run the same command again at any time. It updates what has changed and leaves the rest alone, so use it after getting a newer version of the code (see [Getting updates](#getting-updates)). Add `--dry-run` to see what it would do without changing anything.

### 7. See it work

```bash
node scripts/try-sample.mjs
```

It asks before it starts, because it first clears any local test data. Answer `y`. It then puts a 10-row spreadsheet of made-up tenancy changes into `data/input`, waits for HARSLL (about 70 seconds) and shows what happened to each row.

✔ It ends with **10 of 10 rows ended as expected**: 3 accounts updated, 6 cases referred to staff, 1 duplicate.

Then look at the results:

| Look at | Where |
| --- | --- |
| The summary email | Test mailbox: http://localhost:8025 |
| The staff worklist | `data/reports/` (open the spreadsheet in Excel) |
| The original spreadsheet, archived | `data/archive/` |
| Every case, with its outcome and reason | n8n → **Overview** → **Data tables** → `harsll_cases` |
| What changed in the pretend RBIS | http://localhost:8088/changes |
| The workflows themselves | n8n → **Overview**. Open **HARSLL – Dispatcher** first: it runs the others |

To run it by hand instead, copy `test-data/sample/harsll-sample.xlsx` into `data/input` and wait about two minutes. HARSLL notices the file on its own. More to try: [Try HARSLL with sample data](../guides/try-harsll-with-sample-data.md).

### You're set up when

- [ ] `docker compose ps` lists three containers, all **healthy**
- [ ] n8n at http://localhost:5678 shows six **HARSLL** workflows, all **Published**
- [ ] `node scripts/try-sample.mjs` ends with **10 of 10 rows ended as expected**
- [ ] The test mailbox at http://localhost:8025 has a summary email

## Everyday use

Docker Desktop must be running for any of these. Run them from the `n8n-builder` folder.

| Task | Command |
| --- | --- |
| Start | `docker compose up -d --wait` |
| Stop (everything is kept) | `docker compose down` |
| Check it's running | `docker compose ps` |
| Follow n8n's log | `docker compose logs -f n8n` |
| Run the sample again | `node scripts/try-sample.mjs` |
| Run the quick checks | `node --test scripts/ mock-rbis/` |
| Run all 37 test scenarios (15 to 20 minutes) | `node scripts/run-tests.mjs` |

n8n starts again by itself when Docker Desktop starts, unless you stopped it with `docker compose down`.

## Getting updates

When there is a newer version of the code:

```bash
git pull
docker compose up -d --wait
node scripts/setup-harsll.mjs --create-mailpit-credential
```

Your n8n account, API key and records are kept.

## What's running

| Service | Address | What it is for |
| --- | --- | --- |
| **n8n** | http://localhost:5678 | The workflow editor, where HARSLL lives and runs |
| **Test mailbox** (Mailpit) | http://localhost:8025 | Catches every email n8n sends, so nothing reaches a real person |
| **Pretend RBIS** | http://localhost:8088 | A stand-in for the council tax system, with made-up accounts. See [mock-rbis/README.md](../../mock-rbis/README.md) |

All three can be reached **only from your own computer**.

| Folder in the repository | Inside n8n | Purpose |
| --- | --- | --- |
| `data/input/` | `/files/input` | Put a spreadsheet here to start HARSLL |
| `data/archive/` | `/files/archive` | Spreadsheets are moved here once read |
| `data/rejected/` | `/files/rejected` | Spreadsheets that could not be used |
| `data/reports/` | `/files/reports` | Staff worklists |
| `workflows/` | `/workflows` | The exported workflow files |

n8n's own database (workflows, logins, records, run history) lives in a Docker volume called `n8n-builder_n8n_data`, **not** in the repository folder, so it never ends up in Git.

## Settings explained

All settings are in [`compose.yaml`](../../compose.yaml) and `.env`.

| Setting | Value | Why |
| --- | --- | --- |
| `N8N_VERSION` | `2.48.5` (in `.env`) | Pinned so everyone runs the same version. See [Upgrading n8n](#upgrading-n8n) |
| `N8N_ENCRYPTION_KEY` | Random, per person (in `.env`) | Encrypts saved logins and keys |
| `N8N_API_KEY` | Your key (in `.env`) | Lets the set-up script, sample run and tests use n8n's API |
| `TIMEZONE` | `Europe/London` | Dates and schedules use UK time |
| `N8N_RESTRICT_FILE_ACCESS_TO` | `/files` | Workflows can only touch files in `data/`, nowhere else |
| `NODES_EXCLUDE` | `[]` | n8n 2.x turns off the **Local File Trigger** and **Execute Command** nodes by default. HARSLL needs both: one to start when a spreadsheet arrives, one to move it to the archive. **Local use only; another environment's administrator decides this** |
| `N8N_SMTP_*` | Mailpit | Any email n8n sends itself goes to the test mailbox |
| `N8N_DIAGNOSTICS_ENABLED` | `false` | No usage data is sent to n8n |
| `MOCK_RBIS_PORT` | `8088` | Port for the pretend RBIS on your computer. Workflows always use `http://mock-rbis:8080` |
| Ports | `127.0.0.1` only | n8n, the mailbox and the pretend RBIS cannot be reached from other computers |

The email steps use an n8n login (an SMTP credential) named "Mailpit (local test mailbox)": host `mailpit`, port `1025`, no SSL, no password. The set-up script creates it.

## Importing and exporting workflows

Workflows are kept in Git as JSON files in [`workflows/`](../../workflows/). See that folder's README for naming rules.

**To install or update all six, use the set-up script** (step 6). It also connects them to each other and to their tables, which a plain import does not. The methods below are for working on one workflow at a time.

**In the editor:**

- **Export:** open the workflow → **⋯** menu → **Download**. Save it into `workflows/`.
- **Import:** **⋯** menu on a new workflow → **Import from File**.

**From the command line** (the `workflows/` folder appears inside n8n as `/workflows`):

```bash
# Export one workflow (find its ID in the editor's address bar)
docker compose exec n8n n8n export:workflow --id=<WORKFLOW_ID> --output=/workflows/harsll-dispatcher.json

# Import one workflow
docker compose exec n8n n8n import:workflow --input=/workflows/harsll-dispatcher.json
```

Before committing an export, check the changes for anything that looks like real data or a secret.

## Upgrading n8n

1. Read the n8n release notes for every version between the current one and the new one. Look for breaking changes.
2. Change `N8N_VERSION` in `.env.example` **and** in your `.env`.
3. Run `docker compose up -d --wait`.
4. Run the HARSLL tests: `node scripts/run-tests.mjs` (see [Testing HARSLL](../testing.md)).
5. Commit the `.env.example` change, saying which version you moved to and why.

## Starting again from scratch

> ⚠️ **This deletes everything in your local n8n**: workflows, logins, records, run history and your n8n account. Export anything you want to keep first.

```bash
docker compose down --volumes
docker compose up -d --wait
```

Then create the n8n account and an API key again (steps 4 and 5), and install HARSLL again (step 6).

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `docker`, `git` or `node` is "not recognized" | Close and reopen PowerShell after installing. If it still fails, reinstall that tool |
| Docker Desktop won't start, or mentions WSL or virtualisation | Run `wsl --update` in PowerShell and restart the computer. If it says virtualisation is turned off, ask IT to turn it on |
| `failed to connect to the docker API` | Start Docker Desktop and wait for **Engine running** |
| `git clone` says **Repository not found** | Accept the GitHub invitation first, and sign in with the GitHub account that was invited |
| `Set N8N_ENCRYPTION_KEY in .env` | There is no `.env`, or the key is empty. Redo step 1 |
| `N8N_API_KEY is missing or empty` | Paste the key into `.env` (step 5), and save the file |
| HTTP 401 from n8n | The API key is wrong or has expired. Create a new one (step 5) |
| `port is already allocated` | Something else uses port 5678, 8025 or 8088. Change `N8N_PORT`, `MAILPIT_UI_PORT` or `MOCK_RBIS_PORT` in `.env`, then start again |
| The sample says the Dispatcher is busy | A run is already going. Wait a minute and try again |
| The pretend RBIS gives unexpected answers | Its data was changed by earlier runs. Reset it: `curl -X POST http://localhost:8088/reset`. The sample run does this for you |
| n8n says it cannot decrypt credentials | The encryption key changed. Put the old key back in `.env`, or start again from scratch |
| A spreadsheet in `data/input` is not picked up | Check the Dispatcher is published, and the file name ends `.xlsx`. The 15-minute timer picks up anything missed |
| Log says `Failed to start Python task runner` | Harmless. HARSLL uses JavaScript only |
| Log lists deprecations, for example task runner settings | Harmless for local use |

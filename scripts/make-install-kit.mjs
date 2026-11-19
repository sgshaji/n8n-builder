// Build the HARSLL install kit: one zip to hand to whoever installs HARSLL on another n8n.
//
//   node scripts/make-install-kit.mjs            build dist/harsll-install-kit-<date>-<commit>.zip
//   node scripts/make-install-kit.mjs --ref v1.0 build it from a tag or commit instead of HEAD
//
// The kit is built with `git archive` from a commit, so only committed files can go in: never
// .env files, data/, docs/source/ or anything else Git ignores. It adds an INSTALL.md at the top.
// n8n cannot import a zip: the kit's set-up script does the install. Guide:
// docs/setup/03-move-to-another-environment.md
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./lib/env.mjs";

/** What goes in the kit, as Git pathspecs. Kept to what an installer needs, in the repo's layout. */
export const KIT_PATHS = [
  "workflows",
  "scripts/setup-harsll.mjs",
  "scripts/lib/env.mjs",
  "config/settings.example.json",
  "docs",
  "mock-rbis/server.mjs",
  "mock-rbis/README.md",
  "test-data/rbis-accounts.json",
  "test-data/sample/harsll-sample.xlsx",
  ".gitignore",
];

/** Text that must never be in the kit: a filled-in key or password line, a JWT-style token, an n8n owner block. */
export const FORBIDDEN = [
  { name: "a filled-in key, token or password", re: /^\s*(N8N_API_KEY|N8N_MCP_TOKEN|N8N_ENCRYPTION_KEY|[A-Z_]*PASSWORD)\s*=\s*(?!paste|change|your|<|$)\S+/m },
  { name: "a token", re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { name: "an n8n owner block", re: /"shared"\s*:\s*\[/ },
];

function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: opts.encoding ?? "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

export function installText({ commit, date, ref }) {
  return `# HARSLL install kit

**Version:** commit \`${commit}\`${ref !== "HEAD" ? ` (${ref})` : ""}, built ${date}.
**For:** whoever installs HARSLL on another n8n, usually the n8n administrator and a HARSLL developer together.

This kit installs the six HARSLL workflows, their three Data tables and that environment's settings into an n8n. n8n cannot import a zip, and importing the workflow files one by one leaves them unconnected: **use the set-up script**, which does the whole install through n8n's API and can be repeated safely.

## Read this first: RBIS

The RBIS adapter in this kit talks to the **pretend RBIS**, a test stand-in. How the real RBIS can be reached is not yet confirmed, so this kit is for a **test or trial install only**. Do not point it at live RBIS or use real tenant data. A live install needs a real RBIS adapter, which replaces one workflow.

## What's inside

| Path | What it is |
| --- | --- |
| \`INSTALL.md\` | This file |
| \`workflows/\` | The six workflows, as n8n JSON, and a description of each |
| \`scripts/setup-harsll.mjs\` | The set-up script (plain Node.js 20+, no packages to install) |
| \`config/settings.example.json\` | Template for this environment's settings |
| \`docs/\` | All documentation. Start with \`docs/setup/03-move-to-another-environment.md\` |
| \`mock-rbis/\`, \`test-data/\` | The pretend RBIS, its made-up accounts and a 10-row sample spreadsheet, for a trial install |

No secrets and no real data are included. Some documents link to files that are only in the full source repository, such as the automated tests.

## Before you start

The n8n administrator must provide (details in \`docs/setup/03-move-to-another-environment.md\`):

1. n8n **2.48 or later**, with the public API switched on.
2. The **Local File Trigger** and **Execute Command** nodes allowed (\`NODES_EXCLUDE\`). **Check this first**: without them HARSLL cannot handle files.
3. **Four folders** n8n can read and write: input, archive, rejected, reports.
4. Time zone \`Europe/London\`; failed-run history deleted after 7 days.
5. A mail server, and an **SMTP credential** created in n8n for HARSLL.
6. An **API key** for the install, from an owner or admin (**Settings → n8n API**).

On the machine that runs the script: **Node.js 20 or later**, and network access to n8n.

## Install, in short

Run these from the folder this kit unzips to.

1. **API key.** Create \`.env.bcc-test\` (never share or commit it):

   \`\`\`ini
   N8N_API_URL=https://your-n8n-address
   N8N_API_KEY=paste-the-key-here
   \`\`\`

2. **Settings.** Copy \`config/settings.example.json\` to \`config/bcc-test.local.json\` and fill in the folders, email addresses, \`rbisBaseUrl\` and landlord name. Leave out anything not confirmed.
3. **Dry run** (checks everything, changes nothing):

   \`\`\`bash
   node scripts/setup-harsll.mjs --env-file .env.bcc-test --settings config/bcc-test.local.json \\
     --email-credential "HARSLL mail (BCC test)" --without-run-now --leave-dispatcher-off --dry-run
   \`\`\`

4. **Install:** the same command without \`--dry-run\`. Everything is installed and published except the Dispatcher, so nothing starts yet.
5. **Check and test,** then publish **HARSLL – Dispatcher** to switch it on. Unpublish it to stop HARSLL at any time.
6. **Revoke the API key** when you have finished.

Full steps, checks, updating and rolling back: \`docs/setup/03-move-to-another-environment.md\`.

## Trial install with the pretend RBIS

To prove the install end to end before RBIS access is settled, run the pretend RBIS somewhere that n8n can reach:

\`\`\`bash
PORT=8088 ACCOUNTS_FILE=test-data/rbis-accounts.json node mock-rbis/server.mjs
\`\`\`

Set \`rbisBaseUrl\` to its address, install, publish the Dispatcher, and save \`test-data/sample/harsll-sample.xlsx\` into the input folder. Expected result: 3 updated, 6 referred, 1 covered by another row (\`docs/guides/try-harsll-with-sample-data.md\`).
`;
}

async function main() {
  const args = process.argv.slice(2);
  const refAt = args.indexOf("--ref");
  const ref = refAt >= 0 ? args[refAt + 1] : "HEAD";
  if (!ref) throw new Error("--ref needs a tag or commit.");

  const commit = git(["rev-parse", "--short", `${ref}^{commit}`]).trim();
  if (ref === "HEAD" && git(["status", "--porcelain", "--", ...KIT_PATHS]).trim()) {
    console.warn("Note: there are uncommitted changes to kit files. The kit is built from the last commit, without them.\n");
  }

  // Check every kit file at that commit before building.
  const files = git(["ls-tree", "-r", "--name-only", commit, "--", ...KIT_PATHS]).split("\n").filter(Boolean);
  for (const p of KIT_PATHS) if (!files.some((f) => f === p || f.startsWith(`${p}/`))) throw new Error(`${p} is not in commit ${commit}.`);
  const problems = [];
  for (const f of files) {
    if (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".env.example")) problems.push(`${f}: an env file`);
    if (f.startsWith("docs/source/") && f !== "docs/source/README.md") problems.push(`${f}: an original process document`);
    if (/\.(json|md|mjs|js|txt|ini|ya?ml)$/.test(f)) {
      const text = git(["show", `${commit}:${f}`]);
      for (const { name, re } of FORBIDDEN) if (re.test(text)) problems.push(`${f}: contains ${name}`);
    }
  }
  if (problems.length) throw new Error(`Not building the kit:\n  ${problems.join("\n  ")}`);

  const date = new Date().toISOString().slice(0, 10);
  const name = `harsll-install-kit-${date}-${commit}`;
  const dist = join(repoRoot, "dist");
  mkdirSync(dist, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "harsll-kit-"));
  try {
    const install = join(tmp, "INSTALL.md");
    writeFileSync(install, installText({ commit, date, ref }));
    const out = join(dist, `${name}.zip`);
    git(["archive", "--format=zip", `--prefix=${name}/`, `--add-file=${install}`, "-o", out, commit, "--", ...KIT_PATHS]);
    console.log(`Built dist/${name}.zip: ${files.length + 1} files, from commit ${commit}.`);
    console.log("Checked: no env files, no keys or tokens, no owner blocks, no original process documents.");
    console.log("Give it to the installer with docs/setup/03-move-to-another-environment.md. It is for a test or trial install until the real RBIS adapter exists.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

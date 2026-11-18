# Workflows

Exported n8n workflows live here as JSON files, one file per workflow. This folder is the source of truth: the copy inside n8n is the working copy.

## Conventions

- **One file per workflow**, named after the workflow in kebab-case, for example `harsll-dispatcher.json`.
- **Export after every meaningful change**, and commit the JSON with a message that says what changed in business terms.
- **No secrets in exports.** Credentials are stored in n8n and referenced by name. Check a diff before committing.
- **No real data in exports.** Pinned test data must be made up.

## Planned workflows

| File | Purpose | Status |
| --- | --- | --- |
| `harsll-dispatcher.json` | Starts when a spreadsheet arrives, creates one case per row, archives the file, emails a summary | Not started |
| `harsll-performer.json` | Runs the five safety checks on one case, then updates the account or refers the case | Not started |

How to import and export workflows is covered in the setup guide (added in Phase 1).

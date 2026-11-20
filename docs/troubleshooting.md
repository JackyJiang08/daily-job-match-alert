# Troubleshooting

How to find out what is wrong (`npm run doctor`), the usual fixes, and the limits the project has by
design.

## Start With the Doctor

`npm run doctor` prints one line per check, ✓ or ✗, and how to fix each failure: the Node.js
version, `config.json` (time zone, graduation date and home state formats), the Claude Code and
Codex logins, `pdftotext`, each resume track's text, the cover-letter playbook, and the nightly
LaunchAgent. It writes nothing. It exits with 1 when a required check fails (Node.js, `config.json`,
or no signed-in CLI).

## Common Problems

-  **"config.json already exists, nothing changed"**: `npm run setup` never overwrites. Edit
  `config.json`, or run `npm run setup -- --force-new --config new.json` to write a second config at
  a new path.
-  **Claude is signed out**: Run `claude auth login --claudeai` in Terminal. The hub shows a banner
  and keeps postings for the next run.
-  **Codex is not connected**: Run `codex login` and choose the ChatGPT option. Codex is optional
  when Claude is signed in.
-  **A resume shows no text**: Install poppler (`brew install poppler`) and run `npm run
  resume:sync`, or upload the PDF again under Resumes.
-  **Nothing runs at night**: Install the schedule with `zsh scripts/install-launchd.sh 18 0`; the
  logs are in `state/logs/`.
-  **The hub page is stale after an update**: Run `npm run hub:restart`.
-  **A letter will not generate**: Add your name, phone or email and a playbook under Settings >
  Cover Letters; the Letters page names what is missing.

## Current Limitations

-  **No email channel yet.** The Himalaya collector exists but is disabled; nothing routes alert
  mail into `intake/eml`. Until that is set up, Handshake, Simplify, Wellfound, ZipRecruiter, and
  Jobright alerts are not ingested.
-  **Login-walled platforms are not scraped.** Handshake, LinkedIn, Jobright, Wellfound, and similar
  sites forbid automated access in their terms and sit behind logins, MFA, and bot checks; the
  project only reads public, unauthenticated endpoints. When their alert email arrives one day, it
  will serve only as a link source, and the employer's public board becomes the posting of record.
-  **Workday is best effort.** The CXS list endpoint is public but undocumented; if a tenant changes
  it, that board fails, warns, and eventually goes dormant while everything else continues.
-  **Baseline delays a new board by one night.** A freshly discovered board contributes scored
  postings from its second poll on, by design.
-  **Local scoring is triage only.** When no subscription CLI is available, `unreviewed` postings
  are ranked by keyword overlap in the folded Not reviewed group and should be read as a rough list,
  not a judgment.
-  **Greenhouse EU boards.** Boards on `job-boards.eu.greenhouse.io` are read through the global
  `boards-api.greenhouse.io` (there is no `boards-api.eu.greenhouse.io`); boards registered with the
  old EU host are repointed on the next run, and a dormancy that host caused is lifted.
-  **macOS first.** The schedule, notifications, iCloud recovery, and the hub's LaunchAgent assume
  macOS.

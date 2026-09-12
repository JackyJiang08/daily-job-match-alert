# Daily Job Match Alert — Project Context
Nightly unattended job-discovery pipeline (Node 20+, ESM, zero-framework).
Runs 20:00 America/Chicago via launchd. Collects new Data / AI-ML internship,
new-grad, entry-level postings from public sources (SimplifyJobs GitHub lists,
public ATS endpoints incl. Workday CXS); scores each JD against N configurable
private resume tracks with the Claude Code subscription CLI; writes one dated
folder per application date to the Desktop: an HTML shortlist, an XLSX
workbook, and warnings.txt only when warnings exist. Same-day reruns merge
into that date's report (never shrink). Email-alert collectors exist but are
disabled; do not expand them unless a task says so.
## Hard constraints
- Subscription-only LLM use via the local `claude` CLI (allow-listed auth).
  Never add API clients; never read API-key/gateway env vars.
- No auto-apply, no screening answers, no authenticated scraping.
- config.json, resumes/, intake/, state/, reports are gitignored: never
  commit personal data (incl. phone/email/resume text) or weaken .gitignore.
- The nightly run must ALWAYS leave a report; failures degrade to warnings
  (src/warnings.mjs) or, for missing preconditions, an ERROR-{date}.html.
- Dedup keys: original AND final URL hashes (src/state.mjs). Keep gh_jid.
- Deterministic eligibility (US location, May 2027 window) applies in all
  modes, including local fallback.
## Working agreement
- Every behavioral change ships with node --test tests using injected fakes.
- Verify with npm test && npm run demo && npm run chaos. Never run
  `npm run run` (owner's quota + real Desktop); the owner does acceptance.
- No new dependencies unless the task allows; no framework/TypeScript
  migration; do not rename user-facing files or folders.
- Report UI lives in src/report-components.mjs + src/report-theme.mjs and
  is meant to be reused by a future local hub.
## Local hub (src/hub/)
- `npm run hub` serves http://127.0.0.1:<config.hub.port|4747> (Node http, no
  framework, zero external requests). Pages: Reports (renders
  state/report-payload-*.json with the report components; the Desktop folder
  stays authoritative), Resumes (upload PDFs into private/resumes/<id>/ and
  repoint config.json; external paths keep working), Status (last/next run,
  lock, warnings.txt per day, ERROR-*.html, Run Now = child
  `node src/index.mjs` with DAILY_JOB_MATCH_ALERT_TRIGGER=manual under the
  run lock), Settings (five keys, surgical config.json edit under the lock).
- The hub only reads pipeline artifacts; it writes config.json and private/
  (gitignored). POSTs require a loopback Host/Origin; uploads are .pdf ≤ 5 MB;
  path params are pattern-checked. Never render resume text in the hub.
- Its LaunchAgent (launchd/com.dailyjobmatchalert.hub.plist.template,
  scripts/install-hub-launchd.sh) is separate from the nightly one.

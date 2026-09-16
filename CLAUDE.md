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
- Subscription-only LLM use via local subscription CLIs (`claude` with a
  claude.ai login, `codex` with a ChatGPT login), both allow-listed. Never add
  API clients; never use an API key or gateway; ANTHROPIC_/AWS_/OPENAI_ env
  vars are scrubbed before every CLI subprocess (src/engines/shared.mjs).
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
- All hub and report timestamps render in config.timeZone via src/time-format.mjs
  ("Sep 13, 2026, 8:00 PM"); never show UTC. The pipeline writes meta.trigger and
  meta.completedAt into each day payload; Status reads those, not the logs.
  After pulling new code run `npm run hub:restart` (launchctl kickstart).
## Scoring engines (src/engines/)
- One interface per engine: verifyAuth(), reviewBatch(prompt, schema,
  { tempDirectory }), describeModel(), modelMatches(actual),
  describeConnection(). claude.mjs and codex.mjs implement it; index.mjs is
  the registry (normalizeEngineId, resolveModel, createEngine,
  describeConnections). src/subscription-match.mjs only orchestrates batches,
  retries, supplemental review, and local_fallback on top of an engine.
- config.semanticMatching.engine is "claude" (default) or "codex";
  models: { claude, codex } holds each engine's model (legacy `model` still
  applies to Claude). meta.engine + meta.scoringModel record what a run used.
- CLI binaries are found by src/engines/cli-path.mjs (config path → PATH →
  ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin, nvm);
  launchd jobs get PATH=/usr/bin:/bin, so never assume `claude`/`codex` are
  on PATH. Both LaunchAgent templates set PATH explicitly.
## Cover letters (src/cover-letter/ + hub Letters pages)
- Engines expose generateText(prompt, { schema, tempDirectory }); local_only
  gets a labelled placeholder engine (src/engines/fake.mjs) so demos and tests
  never call a model. compose.mjs holds the rules, prompt, validation
  (5–6 paragraphs, no bullets, no em/en dash punctuation, 320–450 words) and
  the deterministic framing (header, date in config.timeZone, "Dear {Company}
  Recruiting Team,", "Sincerely,"); generate.mjs retries once with a
  condensing instruction; pdf.mjs prints with local Chrome (Letter, Times New
  Roman 11pt, 1in) and falls back to pdfkit, retrying B5 then 0.8in margins.
- Personal details (name, phone, email, signature, playbook, sample letters)
  live ONLY under private/cover-letter/; generated letters under
  private/cover-letters/<date>/<Company>/. Never put a real person's data in
  code, config.example.json, docs, or fixtures: use "Jane Doe" placeholders.
  Downloads go through /letters/<date>/<Company>/<file> with a file whitelist.

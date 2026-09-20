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
- The hub only reads pipeline artifacts; it writes config.json, private/
  (gitignored), and state/ats-boards.json (the ATS board registry, when a
  dormant board is resumed from Status). Status's Sources card reads that
  registry plus the source catalog (src/collectors/catalog.mjs) and the
  latest payload's per-source counts. POSTs require a loopback Host/Origin;
  uploads are .pdf ≤ 5 MB; path params are pattern-checked. Never render
  resume text in the hub.
- Its LaunchAgent (launchd/com.dailyjobmatchalert.hub.plist.template,
  scripts/install-hub-launchd.sh) is separate from the nightly one.
- All hub and report timestamps render in config.timeZone via src/time-format.mjs
  ("Sep 13, 2026, 8:00 PM"); never show UTC. The pipeline writes meta.trigger and
  meta.completedAt into each day payload; Status reads those, not the logs.
  After pulling new code run `npm run hub:restart` (launchctl kickstart).
## Sources, baselines, and the review budget
- Built-in sources live in src/collectors/ (SimplifyJobs, community GitHub
  lists via catalog.mjs, Hacker News hiring, RemoteOK, email files) and ATS
  boards discovered from posting URLs (ats-boards.mjs, registry in
  state/ats-boards.json; quiet after 30 days without new postings → weekly
  polls; dormant after 7 consecutive failures).
- Baseline rule: the first poll of a board or list marks only postings older
  than lookbackHours as seen (`baseline: true`, postedAt stored); postings
  inside the window, postings without a date count as old, and a URL another
  source collected this run is never swallowed by a baseline. Baseline
  entries less than 48 h old are released once at startup (info warning).
- Freshness re-check: after enrichment, a posting with a minute-precise publish
  time (board APIs, JSON-LD datePosted with a clock time; src/posting-fields.mjs
  `holdsToExactWindow`) must sit inside lookbackHours or it is dropped, not seen
  (meta.droppedAfterPreciseTimestamps). Day-level sources stay lenient. Workday
  company names prefer the list/registry label, else `cleanWorkdayCompany`;
  `displayCompanyName` is applied at render time (cards, xlsx, letter panel).
- Subscription quota (src/engines/quota.mjs): the CLI has no usage command, so
  refusal text is classified with a configurable regex table into fiveHourLimit
  (wait 10 min up to 90 min, then defer), modelWeeklyLimit (step down
  quotaPolicy.modelLadder, default fable → opus, audited as an info line, never
  MODEL MISMATCH; next run starts on the preferred model), and
  accountWeeklyLimit (defer everything, report banner; optional
  quotaPolicy.fallbackEngine "codex" when Codex is signed in). Deferred
  postings use state.deferred (quotaDeferred), never unreviewed. Cover letters
  step down the same ladder (editor note + footer) and offer "Generate with
  Codex"; Status has a Quota card; Settings exposes the ladder and fallback.
  Fixture: tests/fixtures/quota-errors.json (recorded from the CLI binary).
- Review budget: config.semanticMatching.maxReviewedPerRun (default 120,
  0 = no limit) caps the local candidates sent to the engine per run; the
  rest are deferred in state.deferred (not seen), come back next run whatever
  their age, and jump the queue once deferred twice. Run Details and Status
  show candidates / reviewed / deferred.

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
  never call a model. compose.mjs holds the fixed letter architecture (sign-off "Sincerely," and the
  name on consecutive lines; openings follow the samples with "with a 3.91 GPA"
  wording and varied phrasing across letters; the editor pass lists unverified
  scenario details as "unverified detail:" notes without deleting them)  (P1:
  role + location, degree/GPA, role-type timeline sentence, in-state line for
  Illinois, hook; 3–4 responsibility paragraphs with numbered evidence and a
  principle; a candid "I should be straightforward about" paragraph only when
  the scorer's gaps name missing tools; a two-sentence close; verbatim-number
  discipline), validation (5–7 paragraphs, no bullets, no em/en dash
  punctuation, 460–600 words) and the deterministic framing. generate.mjs
  makes the draft call plus an editor-review call (config.coverLetter.
  editorReview, default on) that returns { issues, revised_paragraphs };
  page fit is decided by the rendered PDF: pdf.mjs calls the engine's
  condensing pass once when the first render spills, then tries B5 and
  0.8in margins. Samples: up to 10, tagged data/llm/agent, three closest to
  the chosen track go into the prompt.
- One-click generation from a job card: POST /letters/oneclick starts a
  background job in src/hub/letter-jobs.mjs (one at a time; 409 while busy),
  GET /letters/oneclick.json is polled by ONECLICK_SCRIPT on the Reports page,
  and the browser downloads the PDF from the whitelisted letter route. The
  panel (/letters/new, /letters/<date>/<Company>) always opens in the editor.
- Company names (src/posting-fields.mjs): `resolveCompanyName` runs the
  candidate chain list/source name → board registry label → the scorer's
  employerName (schema field, kept as job.employerNameFromJd) → cleaned ATS
  entity → URL (Workday site / board slug); `isValidCompanyName` rejects legal
  words alone, codes ("US101", "1007 Clarios, LLC"), and generic words. The
  pipeline settles job.company/companySource/companyUncertain after scoring
  (`finalizeCompany`); enrichment never overwrites a valid source name. An
  uncertain company shows a "Company name uncertain" badge, blocks one-click
  letters (the panel asks first), and blocks Save & Render; the editor pass
  flags "salutation says X, body says Y". Letters are named
  {Prefix}_Cover_Letter_{Company}.pdf (prefix from Settings, default derived
  from the signature, e.g. "Yuqing (Jacky) Jiang" → JackyJiang); Rename
  Company & Re-render (POST /letters/rename) moves the directory and file
  without calling the model.
- Personal details (name, phone, email, signature, playbook, sample letters)
  live ONLY under private/cover-letter/; generated letters under
  private/cover-letters/<date>/<Company>/. Never put a real person's data in
  code, config.example.json, docs, or fixtures: use "Jane Doe" placeholders.
  Downloads go through /letters/<date>/<Company>/<file> with a file whitelist.

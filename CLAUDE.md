# Daily Job Match Alert — Project Context
Nightly unattended job-discovery pipeline (Node 20+, ESM, zero-framework).
Runs 18:00 America/Chicago via launchd (2026-11-08; was 20:00). Collects new Data / AI-ML internship,
new-grad, entry-level postings from public sources (SimplifyJobs GitHub lists,
public ATS endpoints incl. Workday CXS); scores each JD against N configurable
private resume tracks with the Claude Code subscription CLI; writes one dated
folder per run date (the run's local day) to the Desktop: an HTML shortlist, an XLSX
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
- package.json overrides (2026-11-03, npm audit 0): exceljs 4.4.0 pins archiver 5, whose glob 7 /
  minimatch 3–5 chain carries GHSA-g3hv-75wg-m249 (fixed only in minimatch 11.0.1). Overriding minimatch
  alone breaks glob 7 (glob.sync throws), so the chain is lifted together: archiver ^7 (CJS, same API),
  glob ^14, minimatch ^11, unzipper ^0.12 (drops fstream/rimraf/glob 7). xlsx parts were byte-identical to
  the old build apart from docProps timestamps. exceljs's stream.xlsx.WorkbookReader fails on our files
  under the old deps too (unused here; verify uses xlsx.readFile).
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
- The hub only reads pipeline artifacts (never state.json: a torn one is read from its backup); it writes config.json, private/
  (gitignored), state/ats-boards.json (the ATS board registry, when a
  dormant board is resumed from Status), state/reports-index.json, and
  state/status-summary.json.
- State safety (2026-10-23): src/json-file.mjs writeFileAtomic/writeJsonAtomic (same-dir temp, fsync, rename,
  dir fsync; a test double without open() uses writeFile+rename) for every JSON under state/ and private/
  (state.json, ats-boards/ats-snapshots, payloads, resume-sources, search-usage, model-availability, the
  envelope log, hub runs/auto-catchup/hub-state, letter store); files that already did temp+rename (reports
  index, status summary, usage, quota notices, letters-auto/backlog, config.json) are unchanged. backups: 3
  (state.json via writeState, writeRegistry) keeps <file>.1–.3 (hard link of the replaced file, copy as
  fallback). readJsonWithBackups: unparsable → newest parsable .N; restore: true (pipeline loadState,
  readRegistry in collectAtsBoardSources) moves the broken file to <file>.corrupt-<time> (one kept) and puts
  the backup in place; warning + notifyMessage "state.json was corrupt, restored from backup (<local time>)"
  (restoredFromBackupMessage); none readable → empty + warning. The hub (readStateView) reads the backup and
  never rewrites. sweepTemporaryFiles at run start (> 10 min). src/state-integrity.mjs: writeState records
  state/integrity.json { seenCount, recordedAt }; loadState runs checkIntegrity (top-level state/*.json except
  payloads parse; seen < 50% of the record → meta.integrity.seenDrop, kept by same-day reruns → report
  data-banner="integrity" + warning); hub startHub runs checkHubIntegrity (ctx.integrity) and Status shows
  integrityView (live seen count of the cached state view, the newest run's seenDrop, state.json read from a
  backup, still-corrupt files). src/backup.mjs + src/zip.mjs (own zip writer/reader, CRC-checked, no ZIP64):
  createBackup → <config.backup.directory | ~/Library/Application Support/daily-job-match-alert/backups (macOS; XDG data dir on Linux)>/
  daily-job-match-alert-backup-<local date>-<HHMMSS>.zip with backup-manifest.json, keep 7; isBackedUp skips
  payloads, logs/, state/backups/, .N copies, .corrupt-, .tmp, .lock. main() autoBackupAfterRun after the
  letters phase: triggers scheduled/catchup/auto_catchup only, once per local day, under the run lock (tests
  pass backupDirectory). npm run backup / npm run restore -- <zip> (src/backup-cli.mjs; restore under the run
  lock after a -pre-restore zip; state.json/ats-boards.json rotate). Status Runs card "Backup" row
  (#backup-line, backupView; the Status snapshot helper strips it). Chaos scenario state-corrupt.
- Payload size (2026-10-20): src/payload-store.mjs owns every payload read and write (.json or
  .json.gz; the plain file wins when both exist). writeReportPayload stores slimPayload(payload): only
  postings that went to the final review (semanticReviewed, unreviewed/local_fallback, or a local_only
  isSemanticCandidate) and the matches keep the JD; the rest of `reviewed` keep SLIM_JOB_FIELDS plus
  exclusionReason and jdOmitted (finalUrl/originalUrl dropped when equal to url); meta.prefilter.titleExcluded
  and meta.prescreen.dropped are cut to a few fields. The run keeps its full in-memory copy (the Desktop
  HTML renders the same). payload.storage = { form: slim | archived, version }. src/payload-maintenance.mjs
  maintainPayloads: gzip after GZIP_AFTER_DAYS (30), archivePayload after config.reports.payloadRetentionDays
  (default 90, 31–3650, Settings → Pipeline; matches + RUN_SUMMARY_META_FIELDS, reviewed [] with
  storage.reviewedCount). The nightly run calls compactAgedPayloads (mode 'aged', replaces the old 90-day
  delete); `npm run payloads:compact [-- --dry-run]` (src/payloads-compact.mjs) runs mode 'all' under the run
  lock, backs each rewritten file up gzipped to state/backups/payloads-<time>/, prints sizes. A file the
  index already records in its target form is skipped unread.
- Status page (2026-10-20): buildStatusView(ctx, config, timer) reads syncReportsIndex entries (days:
  warningsCount, metaMatchCount) and src/status-summary.mjs loadStatusSummary (state/status-summary.json:
  STATUS_META_FIELDS of the newest payload, letterCount; written by writeReportPayload, the maintenance, and
  refreshStatusLetters in the letter-store wrapper; rebuilt from the newest payload once when its
  date/mtime/size do not match the index). GET /status is timed (index · status summary · status data ·
  render · sidebar) into the same timing log as the Reports pages. tests/fixtures/snapshots/status-page.html
  (pre-change code, Hub card stripped by tests/helpers/status-fixture.mjs withoutHubCard).
  readStateView(ctx) parses state/state.json (≈90 MB, mostly `seen`) once per mtime/size and drops `seen`
  (Status, plan banner, Settings; read-only). usageWindow computes each entry's local date once, and
  time-format.mjs caches safeZone and the date formatter per zone.
- Reports speed (2026-10-19): src/reports-index.mjs keeps state/reports-index.json (per date: generatedAt,
  matchCount, deferredCount, carriedCount, letterCount, complete, sidebar fields, payloadMtimeMs/Size,
  lettersMtimeMs); the pipeline's writeReportPayload calls updateReportsIndex, the wrapped
  ctx.letterStore.saveLetter/renameLetter call refreshIndexLetters; syncReportsIndex (list, sidebar,
  Settings) only stats and re-reads a payload whose mtime/size changed (first call builds it).
  src/hub/report-cache.mjs: day layer (date|mtime|size|run version → matches, meta, reviewReportJobs
  result, card-id → JD) and render layer (+ letters version: counter, letters-auto.json and letter dir
  mtimes, auto pass pending; + config version: counter, config.json mtime); invalidate('run') from
  runManager onFinished, 'letters' from the store wrapper, 'config' after any POST /settings*. Day page:
  JDs over LAZY_DESCRIPTION_CHARACTERS (300 code points) render data-jd-src + preview, JD_LOADER_SCRIPT
  fetches GET /reports/<date>/jd/<card id> (text/plain, exact text); Desktop HTML keeps full JDs.
  sendCacheable: sha1 ETag, If-None-Match → 304, gzip ≥ 1 KB, cache-control private, no-cache; CSS/JS
  served from src/hub/assets.mjs (/assets/hub-<hash>.css|js, immutable 1 year). src/hub/report-timing.mjs
  logs "[hub] GET … (index · payload · review · letters · render · sidebar) size, gzip, cache" and keeps 20
  for the Status Hub card. tests/fixtures/snapshots/*.html were rendered by the pre-change code;
  tests/report-speed.test.mjs inlines the assets (tests/helpers/report-hub.mjs inlineAssets), strips
  JD_LOADER_SCRIPT, and expands the JD sections to compare content (see UI redesign). Status's Sources card reads that
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
  lists via catalog.mjs, Hacker News hiring, RemoteOK, search discovery, email files) and ATS
  boards discovered from posting URLs (ats-boards.mjs, registry in
  state/ats-boards.json; quiet after 30 days without new postings → weekly
  polls; dormant after 7 consecutive failures). Dormant probe (2026-10-23): collectAtsBoards ends with
  probeDormantBoards (skipped when outage.persisting): enabled dormant boards past nextDormantProbeAt
  (max(dormantSince, lastProbeAt) + DORMANT_PROBE_DAYS 30, DORMANT_PROBE_GRACE_HOURS 6 early;
  sources.atsBoards.dormantProbeDays overrides) get probeBoard (one request: Greenhouse without content,
  Lever/SmartRecruiters limit=1, Workday POST limit 1, Ashby as is; status only). 2xx → dormant cleared,
  failures reset, resumedBy 'probe', info warning, polled from the next run; else lastProbeAt/lastProbeResult
  and one aggregated info line. Status Sources row: "Next probe <first scheduled run after due>" + last probe.
- Baseline rule: the first poll of a board or list marks only postings older
  than lookbackHours as seen (`baseline: true`, postedAt stored); postings
  inside the window, postings without a date count as old, and a URL another
  source collected this run is never swallowed by a baseline. Baseline
  entries less than 48 h old are released once at startup (info warning).
- Freshness re-check: after enrichment, a posting with a minute-precise publish
  time (board APIs, JSON-LD datePosted with a clock time; src/posting-fields.mjs
  `holdsToExactWindow`) must sit inside lookbackHours or it is dropped, not seen
  (meta.droppedAfterPreciseTimestamps). Day-level dates (Workday "Posted N Days
  Ago", list "Nd" tokens, bare datePosted) are converted to a posting date and
  held to every window by the end of that local day (`freshnessInstant`,
  `endOfLocalDay`): "yesterday" passes a 24 h window, "3 days ago" fails the
  24 + 24 h backlog rule. The discovery time is a basis only for postings with
  no date at all (`ageBasisInstant`); it never substitutes for a dated posting.
  Undated postings (Oracle Cloud pages) render "Unknown (found Sep 26)" on the
  card and in the xlsx, rank in freshness bucket 2 after every dated posting,
  and after UNDATED_DEFERRAL_NIGHTS (2) deferrals are marked seen
  (`undated_abandoned`, meta.undatedAbandonedCount) instead of deferred again.
  meta.datePrecision (`datePrecisionSummary`) feeds the Run Details "Date
  precision" row: precise / date only / undated, overall and per source. Workday
  company names prefer the list/registry label, else `cleanWorkdayCompany`;
  `displayCompanyName` is applied at render time (cards, xlsx, letter panel).
- Subscription quota (src/engines/quota.mjs): the CLI has no usage command, so
  refusal text is classified with a configurable regex table into fiveHourLimit
  (wait 10 min up to 90 min, then defer), modelWeeklyLimit (the notice names
  a model: step down quotaPolicy.modelLadder, default fable → opus, audited as
  an info line, never MODEL MISMATCH), ambiguousWeeklyLimit (a weekly or
  generic notice with a reset beyond five hours that names no model, e.g.
  "You're out of usage credits. Switch to another model": the same batch is
  retried on the next ladder model; an answer settles it as the first model's
  limit, a second weekly refusal as the account's), and accountWeeklyLimit
  (only via that second refusal or an empty ladder: defer everything, report
  banner; optional quotaPolicy.fallbackEngine "codex" when Codex is signed in).
  Model weekly limits are recorded in state/model-availability.json limits
  with resetsAt ONLY when the CLI gave one (never estimated; an old exact
  at+7d estimate is dropped on read). limitHold: CLI reset → owner's
  config.plans.claude.weeklyReset { day, time } (Settings > Claude card,
  POST /settings/plans/weekly-reset) → 24 h (nightly prune has a 2 h grace so
  the next day's run at the same time retries the preferred model). Until then runs skip it.
  The report banner/header quotaNote appear only when postings went
  unreviewed or Codex took over; a Fable → Opus step is a Run Details line. The CLI's words
  (sanitizeNotice: no command path, ids, e-mail, URL query; 300 chars) go to
  state/quota-notices.json and the Quota card's CLI notices. Deferred
  postings use state.deferred (quotaDeferred), never unreviewed. Cover letters
  step down the same ladder (editor note + footer) and offer "Generate with
  Codex"; Status has a Quota card; Settings exposes the ladder and fallback.
  Fixture: tests/fixtures/quota-errors.json (recorded from the CLI binary).
- Signed out / expired login (2026-10-29; src/engines/engine-errors.mjs, claude.mjs readClaudeAuthStatus): the
  run-start check (`claude auth status --json` exits 1 and still prints { loggedIn: false, authMethod: "none" }:
  run() errors carry stdout; loggedIn false, authMethod none/missing, or a status command that fails without a
  status → AuthExpiredError, notice "claude auth status: loggedIn=false, authMethod=\"none\"") and a mid-run
  failure (print-mode envelope unwrapped; quotaPolicy.patterns.authExpired incl. '"loggedin"\s*:\s*false') are
  one auth_expired. Console/API-key logins and a CLI that cannot report its version keep the local fallback.
  applySubscriptionMatching handOverForAuth: quotaPolicy.fallbackEngine codex + fallbackConnected → Codex reviews
  the rest (event action 'fallback-engine'); else deferForAuth (quotaDeferred + authDeferred; markDeferred
  reason 'auth', sticky). meta.authExpired { at, notice, deferred, takenOverBy, message }; report data-banner="auth"
  (signedOutBanner, "Claude signed out"), footer, Run Details; quotaNote ignores auth events; notifyAuthExpired
  "Claude is signed out. Run claude auth login --claudeai" (main({ notifier })). applyReviewBudget ranks reason
  reasons 'auth'/'quota' as the catch-up lane (below). requeueSignedOutPostings (startup, state.authRequeue per date): payloads whose meta shows the sign-out
  (meta.authExpired, or the old "authentication check failed … loggedIn false" warning) → unreviewed postings
  inside CATCH_UP_MAX_AGE_HOURS (48) are forgotten from seen and deferred 'auth' (10-26..10-29 nights). Hub:
  src/hub/auth-watch.mjs (ctx.authWatch, startHub starts it, every 10 min, connections probe force; signedOut →
  authState.expire(notice, 'login check'), notification once per local day in private/hub/auth-watch.json;
  signed in clears only what the watch set). Sidebar "Login · Claude signed out", Connections "Signed out",
  Status banner data-banner="auth-expired"; POST /settings/connections/refresh clears; every user-visible engine
  error goes through humanizeEngineError; raw text only in the hub log.
- Catch-up lane (2026-10-29, applyReviewBudget): deferral reasons CATCH_UP_REASONS ('auth', 'quota', src/state.mjs)
  never compete in the main budget; after it, the lane keeps those at most CATCH_UP_MAX_AGE_HOURS (48) old by
  postingAgeHours, same ranking, up to semanticMatching.catchUpBudget (catchUpBudgetOf: default 40, 0 = no limit,
  Settings → Pipeline catchUpBudget); older ones expire unseen (budget step and expireDeferred catchUpMaxAgeHours
  at startup), the rest re-deferred with their reason. budget.jobs = others, main kept, then catch-up (the engine
  reviews them last). The prescreen runs before the budget, so catch-up postings pass it too. meta.catchUp
  (reviewSplit: reviewedNew / reviewedCatchUp, candidates, selected, waiting, expired) → Run Details "Reviewed".
  budgetHistory counts only the main lane.
- Seen state (2026-10-29, src/state.mjs SEEN_FORMAT 2): entries keyed sha256(canonical original/final URL) hold
  firstSeen, lastAttempt (only when different), attempts+completed (open retry or more than one attempt),
  baseline+postedAt (baseline entries only); no URLs, enrichment, or error. migrateSeenFormat (loadState): legacy
  state → createBackup(label '-pre-seen-slim', not matched by the prune pattern) first (failure → warning, stay
  legacy), slimSeenState, prune, state.seenMigration { entriesBefore/After, pruned, bytesBefore, backup }.
  writeState is compact (indent 0). pruneSeen(SEEN_RETENTION_DAYS 90) every run → meta.seen → Run Details "Seen
  state". Tests/chaos/demo keep backups out of ~/Library (demo: demo-output/backups; chaos baseConfig backup).
  Real file 2026-10-29 dry run: 96.8 MB → 16.4 MB, 138,078 entries kept.
- Not reviewed (src/review-status.mjs): isNotReviewed (matchLevel 'unreviewed' or local_fallback); isEligible
  never matches one unless the engine is local_only; splitReportJobs({ matches, reviewed }) → matches without
  them + notReviewed (both lists, once per URL, eligibility exclusions dropped, best local score first);
  buildReportView splits (options.reviewed in the pipeline, options.notReviewed in the hub day layer) →
  data-banner="not-reviewed" (inline bad style: the shared CSS/script stay byte-identical) and a folded
  <details class="run" id="not-reviewed"> with a div.jobs (not section.jobs, so the page script ignores it);
  meta.notReviewedCount; xlsx Matches without them + "Not Reviewed" sheet (only when any); reports index v3
  matchCount = reviewedMatchCount; Generate Missing Letters and auto letters take isLetterCandidate only
  (model-reviewed high); pruneLettersBacklog drops queue entries for unreviewed postings (run inside the pass).
- Greenhouse EU: no boards-api.eu.greenhouse.io (NXDOMAIN, checked 2026-10-29); identifyBoard uses the global
  API host for EU boards, repointGreenhouseEuBoards (every run) repoints old registry entries and lifts the
  failures/dormancy that host caused; enrich greenhouseApiUrl accepts job-boards.eu.
- Automatic letters (src/auto-letters.mjs): main() runs runLettersPhase after
  runPipeline returns and the run lock is released (Run Now too), under
  state/.letters.lock, with a headless hub context (createHubContext; tests pass
  options.lettersContext with fake engines). config.coverLetter.autoGenerate
  { enabled true, maxPerRun 0 = no limit }; selection = the carry-over queue
  (state/letters-backlog.json: postings a stopped pass did not write; 14 days)
  first, then this run's new matches (summary.newMatchUrls) by score, skipping
  letters on file and uncertain companies; generateLetter(strict) + saveLetter
  on the draft/editor stage chains; a fully failed chain stops the pass with a
  warning and queues the rest. mode 'missing' = POST /letters/missing (the
  report's "Generate Missing Letters" button): every high match of that date
  without a letter, trusted company, no cap, works with autoGenerate off.
  Cards with a letter: Download Letter + Open Letter only; the one badge is
  "Check N Details" (src/cover-letter/notes.mjs classifyEditorNotes:
  needs-review = unverified detail, salutation mismatch, unsupported number,
  still too long; everything else is info, shown in the Open Letter footer). Off when the
  draft stage is the local_only placeholder or material is incomplete. Status
  in state/letters-auto.json (cards: "Letter generating…", manual one-click
  and Test refused while the letters lock is held); outcome goes to
  meta.autoLetters (Run Details, re-rendered HTML and warnings.txt; the xlsx is
  left as written) and the Status card; usage entries are tagged
  source 'auto-letters'. Letter records keep engine/model/effort for draft and
  editor (passLine in the footer and Editor notes). The letters status line
  goes to stderr: stdout is the run summary JSON that chaos parses.
- Seeds and search discovery: config.sources.atsBoards.seeds (applySeedBoards:
  { greenhouse|lever|ashby|smartrecruiters: id }, { workday: tenant/site, host }
  (host required), key strings or URLs; origin 'seed', then the usual baseline /
  quiet / dormant rules, never re-enabled). SmartRecruiters is a board kind
  (public Posting API, country=us, newest first; enrich.mjs smartRecruitersApiUrl
  detail endpoint; fixtures tests/fixtures/ats/smartrecruiters-*.json).
  src/collectors/search-discovery.mjs (sources.searchDiscovery, default off):
  brave (X-Subscription-Token) or tavily, key ONLY in private/search.json and one
  request header (scrubbed from error text; never logged); no key → one info
  line, no source row. rotateQueries(pool, now, queriesPerRun 12) by local
  dayOfYear; every query counted in state/search-usage.json before it is sent,
  monthlyQueryCap 400 → stop + warning. Results on greenhouse/lever/ashby/
  workday/smartrecruiters → options.searchBoards → registered (origin
  'search_discovery') and woken past the quiet wait (wakeKeys); icims and other
  pages → candidates (sourceKind search_discovery: title family required,
  job-board hosts and listing pages dropped). No page_age → postedAt null
  (undated). dedupe/dedupeByFinalUrl drop the search copy when a list or board
  has the posting (debug.searchDuplicates). Tests never call a real search API
  (searchFetchImpl / readSearchKey injectable). The Muse was not integrated: its
  terms require a registered app (checked 2026-10-09).
- Poll snapshots (2026-10-11): state/ats-snapshots.json ({ at, complete, count, ids: 16-hex sha256 of
  canonical URL and id:<externalId> }, separate from the registry). collectAtsBoards: with a usableSnapshot
  (≤ SNAPSHOT_MAX_AGE_HOURS 30, no lastFailureAt after it) a posting absent from it is NEW_SINCE_LAST_POLL
  (freshnessBasis 'new since last poll', sourceFreshnessBasis, firstSeenAt = now, previousPollAt; a partial
  Workday/SmartRecruiters walk also needs the date rule) and a present one is dropped unless deferred
  (snapshotExcluded); otherwise the date rule (freshnessRule 'date', snapshotReason). No snapshot → no
  conditional headers. freshnessInstant/isUndated/holdsToExactWindow treat NEW by firstSeenAt.
- Carried over: a job whose state.deferred entry exists when stamped gets carriedOver, firstSeenAt (entry
  discoveredAt), restored NEW basis; markDeferred(state, job, at, reason 'budget'|'quota'). Report: separate
  "From Yesterday" group (view.carried, section#jobs-carried; the script sorts each
  section.jobs). semanticMatching.includeCarriedOver (Settings > Pipeline, pipelinePresent marker) false →
  clearBudgetDeferrals at startup and no budget deferral kept (quota ones stay).
- Strict 24-hour window: REMOVED 2026-11-15 (src/strict-window.mjs deleted). The report no longer splits a
  "Date Only, May Be Older Than 24 Hours" group: date-only and undated reviewed matches sit in the main list in
  the current sort; the Settings > Pipeline switch is gone and a semanticMatching.strict24HourWindow left in
  config.json is ignored (never written, never an error); meta.strictWindow is not recorded any more (old payloads
  carrying it render like the rest). Collection-time freshness rules (precise 24 h, date-only to the end of the
  local day, snapshot NEW) are unchanged. Run Details row "Posting Window" = "Main List: " + postingWindowLabel
  over the non-carried matches.
- Dates: parsePostingDate (JSON-LD datePosted, Workday startDate, search page_age): bare date → noon UTC
  calendar date; midnight → date; zoneless clock time → ZONELESS_TIME_ZONES (jobright.ai = UTC, verified
  2026-10-11 against its "2 hours ago") else date only. postingDay reads stored noon/midnight-UTC values as
  the UTC date. postedText: "Oct 8 (date only)", "first seen Oct 9, 8:04 PM", carried adds first seen.
  correctFutureTimestamp after enrichment (precise > max(run start, check time), or a calendar day after
  the run's local day) → date-only run day, meta.freshness.futureCorrected. xlsx: Posted At text except a
  'posted today' value, new Freshness column (freshnessLabel). Run Details "Freshness" row.
- Network outages (2026-10-12; 10-11's 20:06 run fired in a lid-closed DarkWake, every source said "fetch
  failed"): errorSummary appends error.cause (errorCause walks cause / AggregateError; HTTP errors carry
  status). isNetworkError = no HTTP answer. collectAtsBoards defers failure bookkeeping: > OUTAGE_SHARE 0.5
  of attempted boards (min 3) failing on the network, or createRunClock().jumpMs() ≥ CLOCK_JUMP_MS 5 min
  (wall vs monotonic), → sleep(retryDelayMs 60 s, sources.atsBoards.outageRetryDelaySeconds) and retry
  those once; if most still fail they are excused (no count/lastError/lastFailureAt/snapshot/lastSuccessAt,
  lastPolledAt restored, lastOutageAt/lastOutageError, result.outage) and meta.networkOutage drives the
  report banner (data-banner="network"), Run Details "Network", the warning, and notifyMessage
  (DAILY_JOB_MATCH_ALERT_NOTIFY=off silences it; chaos sets it). undoOutageFailures is the one-time
  registry.migrations repair (applied to the real registry 2026-10-12: 841 boards). caffeinated() wraps
  launchd runNode and Run Now in /usr/bin/caffeinate -i on darwin. npm run boards:probe (src/boards-probe.mjs)
  is read-only. Chaos scenario network-drop.
- Auto catch-up (2026-10-12): runPipeline calls recordIncompleteRun(state, incompleteRunReason({networkOutage,
  sourceStats})) before the final state write: state.incompleteRun { date (runDate), reason network_outage |
  all_sources_failed (local Email files / career-ops excluded, skipped boards excluded), detail, at, firstAt,
  trigger }; a normal run clears it into state.lastIncompleteRun { resolvedAt, resolvedBy }.
  src/hub/auto-catchup.mjs createAutoCatchUp (ctx.autoCatchUp, timer started only in startHub, unref'd):
  check() order = config.autoCatchUp.enabled → record → deadline (nextScheduledRun after firstAt, from the
  plist schedule) → attempts in private/hub/auto-catchup.json (MAXIMUM_ATTEMPTS 2 per record date) → clock
  jump since the previous check → probeNetwork (api.github.com + boards-api.greenhouse.io/v1/boards/greenhouse)
  → runManager.availability → runManager.start({ trigger: 'auto_catchup' }) + CATCH_UP_NOTIFICATION. Status
  Runs card "Catch-up" row (#catch-up-line); Settings > Pipeline checkbox autoCatchUp (pipelinePresent).
- US evidence in a JD (usEvidenceInDescription) also counts a standalone
  uppercase US / U.S. / USA, except lowercase "us" and all-caps phrases such as
  "JOIN US".
- Prefilter level ranges: LEVEL_ONE_RANGE ("I/II", "I-II", "I or II", "1/2",
  "I - III") bypasses the II/III/IV suffix rule and reads as entry level.
- Stage assignments (src/engines/assignments.mjs): stageAssignments(config) →
  scoring (semanticMatching engine/model/reasoningEffort; fallback = ladder after
  the model + the Codex model when quotaPolicy.fallbackEngine is codex, which is
  ON when unset and still needs Codex signed in; explicit null turns it off),
  supplemental (linked), letterDraft / letterEditor (config.models.assignments;
  default codex / gpt-5.6-sol / medium and high, fallback claude-opus-5-5; a
  local_only config without letter assignments keeps the placeholder engine),
  prescreen (config.models.assignments.prescreen; default codex / lightestModelId
  ('openai') / low, no fallback; none for local_only). Letters: letterStagePlan drops Codex steps when Codex is
  not connected (note in Editor notes), withStageChain hands the draft to the next
  step on failure, generate.mjs reviewWithChain does the same for the editor.
  Settings saves via POST /settings/assignments (validateAssignments).
- Settings tabs (/settings?tab=models|pipeline|letters): Subscriptions & Models
  (cards: plan + source + detection time, scheduled change, CLI, 7-day tokens per
  model, last limit and reset; compact model tables, unused models under "Show
  all models", inline Test; Task assignments with engine/model/effort selects and
  editable fallback tags), Pipeline (matching, reports, hub; POST /settings with
  no model leaves the model alone), Cover Letters (material). The old ladder
  editor is gone: Scoring's chain is the ladder.
- Zapply links (src/collectors/zapply.mjs): https://zapply.jobs/l/d/<slug> answers
  301 then 302 to the employer posting (probed 2026-10-07; a gone listing
  redirects to zapply.jobs/jobs). resolveZapplyJobs runs after the prefilter and
  before enrichment (redirect: manual, ≤4 hops; offline or on error, greenhouse/
  lever/ashby/sr slugs are decoded; Workday/Oracle/Amazon cannot be), keeps the
  Zapply link as originalUrl, and dedupe merges it with the employer listing.
- Run counts: meta.runCounts (scored by engine · model, local scores, deferred by
  budget and quota, prefiltered out, expired) feed Run Details and the Run
  Summary ("Reviewed jobs (this run)" is gone); meta.quotaNote is one header line
  when a quota limit touched the run. Prefilter also drops titles with European
  gender markers ((m/w/d), (f/m/d), (h/f), …) as non-US; detectEarlyCareer
  promotes on JD signals alone (0-2 / 0 to 2 years, recent graduate(s), Class of
  2027, new grad(uate)s) unless the title is senior; classify.mjs matches plurals.
- Model registry (src/engines/catalog.mjs) is the only place that names
  models: config.models.catalog [{ provider anthropic|openai, id, label,
  alias, efforts (Codex only) }], defaulting to ids checked against Claude
  Code 2.1.292 (binary model table) and codex-cli 0.153.0 (`codex debug
  models`); hub.modelChoices migrates. resolveModel, both engines, the quota
  ladder, and the hub canonicalize names to registry ids (engine.model, marks,
  display); the CLI is given the entry's alias (`--model fable`, cliModelArg)
  or the full id when there is none (Codex) or the entry is pinnedId (claude-haiku-5-5 since 2026-11-15:
  2.1.292's `--model haiku` still answers as claude-haiku-4-5; `--model claude-haiku-5-5` answered as
  claude-haiku-5-5, checked with one call; claudeModelMatches accepts only that id for a pinned entry). The id modelUsage reports is the
  resolvedId; a different release (newerRelease, e.g. claude-fable-5-2) shows
  "New version: <id>" in Settings and still matches its family. Never add a
  model string elsewhere.
  semanticMatching.reasoningEffort reaches Codex as `-c
  model_reasoning_effort="x"` (unset = CLI default).
- Model status lives in state/model-availability.json (version 2): models
  (kind not_on_plan | unknown_model, skipped by the ladder), limits (weekly
  limit, cleared when limitHold ends), seen ({ resolvedId,
  lastUsedAt } from modelUsage of every successful call: matcher recordUsage
  info, hub letters, Test). Badges: Available, Not verified, Weekly limit,
  Not on plan, Unknown model (quotaPolicy.patterns.unknownModel, incl. the
  "not supported when using Codex with a ChatGPT account" refusal).
- Plans (src/engines/plans.mjs): Claude from auth status; ChatGPT from codex
  login status, else the plan claim of ~/.codex/auth.json's id_token decoded
  locally (src/engines/chatgpt-plan.mjs; never log, store, or render a token
  or any other claim). config.plans.<claude|chatgpt>.manual (Settings form,
  POST /settings/plans) and .scheduledChange { plan, effectiveDate } (switches
  on the local date); every plan is labelled auto or manual.
- Settings (src/hub/model-settings.mjs + model-settings-views.mjs): two plan
  cards with model tables, Model assignments (Scoring editable, Supplemental,
  Cover letter draft/editor, Prescreen) with fallback chains, the
  Model Ladder as a reorderable list (validateLadder: Claude registry models,
  no repeats, at least one), per-model Test (POST /settings/models/test: fake
  engine via ctx.makeTestEngine in tests; refused while the run lock is held
  or a letter generates; never batch). Sidebar: "Claude Max → Pro Oct 26" and
  "ChatGPT Plus". Each nightly run writes a redacted last envelope
  (state/logs/claude-envelope-last.json: usage and modelUsage only) for
  recording fixtures; `npm run fixture:envelope` turns it into
  tests/fixtures/usage/claude-result.json (the synthetic fixture is still in
  use until then).
- Plan awareness (src/engines/model-availability.mjs): both connection probes
  report `plan` (Claude subscriptionType; Codex when its status prints one);
  the sidebar, the Status Quota card, and the Settings engine radios show it.
  The pipeline records the plan the CLI reported in state.observedPlans; a
  change sends the macOS notification "Claude plan changed: max → pro. Review
  the model ladder in Settings." (notifyMessage / recordObservedPlan), an info
  warning, meta.planChange, and a Status banner with a Review Settings link
  (plus the `claude auth login --claudeai` hint when the session also looks
  expired; cleared when Settings is opened). No plan → model table: a refusal
  matching quotaPolicy.patterns.modelUnavailable ("not available on your
  plan", "requires a Max subscription", "model … not found", fixture cases in
  tests/fixtures/engine-errors.json) classifies as model_unavailable, steps
  the ladder down for that very call, and marks the model in
  state/model-availability.json ({ model, plan, detectedAt }); marked models
  are skipped by the matcher and by cover letters until the plan changes or 7
  days pass (then tried once more). Settings disables marked models
  "(unavailable on Pro)", shows the marks beside the ladder, and Re-check
  Models (POST /settings/models/recheck, under the run lock) clears them.
- Pre-screen (src/prefilter.mjs), before enrichment and the budget, every
  source: titles hitting preferences.excludeTitleTerms (the eligibility list)
  + prefilterExcludeTitleTerms (head of, vice president, VP, account manager,
  sales, sales/store/retail associate, retail sales, store manager, warehouse, customer success,
  engagement manager, technician,
  nurse, driver, mechanic) + excludeLevelSuffixes (II, III,
  IV, standalone uppercase) are skipped; uncurated sources (ATS boards, HN,
  RemoteOK) must also name a preferences.titleFamilies term (whole words; the
  last word of a family term also takes common endings: engineer →
  engineering, developer → development, statistic → statistician; acronyms
  and exclusions stay strict). A title with a prefilterExcludeOverrides
  phrase (new grad, early career, university, graduate program, 2027,
  rotational, associate product/program manager, APM) is exempt from the "manager" and
  level-suffix exclusions only (isEligible applies the same lift via exclusionLifted);
  NON_FAMILY_TERMS: "associate" is never a family (dropped even if configured); ENTRY_PROGRAM_TERMS
  (rotational/development/leadership/graduate/analyst/early career/associate program) are default
  families and entry_level; a bare "retail" is not excluded (Retail Analytics passes);
  curated lists and alert emails skip the family check. A location
  assessLocation() calls non-US is skipped too. Skipped postings are not marked
  seen. meta.prefilter feeds the Run Details "Prefilter" row (per-source counts
  and a folded list: company · title · source · rule). Score bands unchanged. `detectEarlyCareer` marks job.earlyCareer
  (entry_level from the title: level I, Associate Consultant, Business Analyst,
  Associate Product/Program Manager, APM, Consulting/Strategy Analyst, an entry program, Associate, Junior, Graduate,
  University, Early Career, Entry, Rotational, or a plain Analyst; new_grad
  when the JD also says 0-2 years / recent graduate / Class of 2027 / new
  grad); it never rewrites roleType and only ranks those postings with
  internships inside a freshness bucket (`isEarlyCareerPriority`).
- Role scope (src/role-families.mjs, 2026-10-17): preferences.targetRoleFamilies (DEFAULT_TARGET_ROLE_FAMILIES
  data, AI/ML, software, product management, consulting/strategy) → targetRoleGuidance paragraph in
  buildSemanticPrompt and buildPrescreenPrompt (product/consulting judged on analysis, projects/internships,
  communication, business sense; not marked down as non-data; "Manager" in an entry title is not a manager
  role; track chosen from evidence). classify.mjs reads Business/Consulting/Strategy Analyst, Rotational
  Program, APM from the title as entry_level. meta.roleFamilies = countByRoleFamily (roleFamilyOf buckets
  product → consulting → AI/ML → data → software → other; prescreen = local candidates, review = semantic
  candidates kept by the budget, matched) → Run Details "Candidates by role family". Settings > Pipeline
  "Role scope" tag editors (roleScopePresent marker; hidden field per tag + <name>Add box split on commas;
  tagListField / validateSettings reject empty lists and a lone "associate") write
  config.preferences.titleFamilies / targetRoleFamilies.
- Usage (src/engines/usage.mjs): engines return `usage` (Claude modelUsage keyed
  by the real model id, recorded verbatim; Codex turn.completed usage with the
  model id and reasoning effort). The matcher tags review / supplemental, hub
  letters tag letter / editor; entries go to state/usage.json (35 days, re-read
  and appended by both writers). meta.usage → Run Details "Subscription usage";
  the Quota card shows 7 days by model, by purpose, and per night. Fixtures:
  tests/fixtures/usage/ (the Claude one is SYNTHETIC, from field names). A
  successful Claude reply with empty or unreadable modelUsage is never stored
  as zero: usage.parseEmpty → one "usage parse empty" warning per run (hub
  letters log it). Run Summary: "Reviewed jobs (this run)" (meta.
  reviewedInRun) and "Reviewed (last 90 days)" (meta.reviewedLast90Days,
  from the stored day payloads, archived ones by storage.reviewedCount; no
  all-time claim).
- Prescreen (src/prescreen.mjs, src/resume-digest.mjs, src/prescreen-text.mjs):
  prescreenStage runs between the local evaluation and applyReviewBudget. Resume
  digests (~1,200 chars, extracted locally, resumes/{id}.digest.md with a sha256
  header, rebuilt on hash change) + title/company/location/roleType/first 1,500
  JD chars, 25 per call, schema { id, prescreenScore, bestTrack }, usage purpose
  'prescreen'. config.prescreen { enabled, threshold 55, shadowRuns 3, enforce }:
  shadow (default) drops nothing and records recall (final matches the threshold
  would have lost) in state.prescreen { shadowRunsDone, history } and
  meta.prescreen; enforced only when the owner sets enforce in Settings (POST
  /settings/prescreen, refused before the shadow nights are done): below the
  threshold → markJobSeen 'prescreened_out' (never deferred, folded list in Run
  Details), the rest ranked by prescreen score inside the freshness buckets
  (rankByPrescreen). Any failure → local order + warning. meta.funnel feeds Run
  Details and Status. Tests and chaos set prescreen.enabled false (the default
  would reach the signed-in Codex); options.prescreenEngine injects a fake.
- Review budget: config.semanticMatching.maxReviewedPerRun (default 60,
  0 = no limit) caps the local candidates sent to the engine per run. Ranking
  is freshness first (postings inside lookbackHours, then the backlog, then
  undated postings), then local score with a deferral bonus inside a bucket.
  The rest are deferred in state.deferred (not seen; entries keep
  postedAtPrecision) and stay eligible only while their posting date (the end
  of its local day for date-only values; first discovery only when there is no
  date) is within lookbackHours + deferralGraceHours (default
  48 h); older entries expire at startup and after enrichment, unscored and
  unseen ("expired N backlog postings" in Run Details; also the one-time
  migration of the old one-week queue). state.budgetHistory keeps 7 nights of
  in-window candidates vs budget; 3 nights over raises meta.budgetAlert (a
  warning, the Run Details, and the Status Quota card). Near-duplicates (same
  company + normalized title + location, different URLs) merge into one card
  with `alternates` links and one review; alternates are marked seen with the
  primary. Run Details "Posting Window" says "posted within the last 24 hours /
  N days" from the main list's oldest posting date at run time.

## Schedule, report date, header, Title Case (2026-11-08)
- Schedule: src/schedule.mjs DEFAULT_SCHEDULE {18, 0} is only the fallback; install-launchd.sh default 18 0. The
  hub reads the plist (installedSchedule) for Next Run / overdue (sidebarSummary), auto catch-up deadline,
  dormant probe "Next probe"; launchd-dispatch reads DAILY_JOB_MATCH_ALERT_SCHEDULE_HOUR/MINUTE. HOLD_GRACE_MS
  (2 h) is schedule-independent. Never hard-code a run hour.
- Report date: resolveRunDates → applicationDate = runDate = the run's local day (18:00 CST is 00:00Z next
  day; local wins). reportDateOffsetDays and the old 14:00 cut-off are gone (config key ignored). Folders from
  before 2026-11-08 (evening run → next day) keep their names; the first 18:00 run merges into that day's
  existing payload (mergeReviewedJobs, only adds). Run Details "Report Date" adds "(run on …)" when they differ.
- Header: since 2026-11-15 the one top row (see "Compact cards and page") replaces the masthead; mastheadSubtitle
  ("N Matches · Ran 6:02 PM") is kept only for the Status summary and tests; meta.quotaNote renders as
  p.quota-note[data-quota-note] under the row; banners (auth, quota, network, integrity, not reviewed) unchanged.
  A group with no cards is not rendered (main list too when other groups have cards); the empty state only when
  nothing at all.
- Title Case for buttons, summaries/h1–h3, labels, th, dt, badges/tags, <b> labels in hub + report (not the
  xlsx, not prose, not data values). tests/title-case.test.mjs scans rendered hub pages, the letter panel and
  the Desktop report with tests/helpers/title-case.mjs (minor words lower case after the first word; words
  with a capital pass; ALLOWED_WORDS keeps "CoverLetter" as the owner spells it). Constants: CARRIED_OVER_TITLE
  "From Yesterday" (was "Carried Over From Yesterday" until 2026-11-15), NOT_REVIEWED_TITLE "Not Reviewed (Engine
  Unavailable)", LOCATION_NOT_STATED_LABEL "US Location Not Stated", STAGE_LABELS "Cover Letter Draft/Editor".

## Cards, JD markup, letter copy (2026-11-08)
- Why It Matches is not rendered (cards, hub, xlsx; the Matches sheet lost that column, the [unreviewed] tag moved
  to the start of Gaps / Verify). job.reasons is still produced and stored for cover letters. Gaps / Verify shows
  every item (no "N More" fold).
- src/jd-html.mjs: sanitizeJobHtml whitelist (p br ul ol li strong b em i h1–h4 a[href http/https/mailto] +
  target=_blank rel=noopener noreferrer; script/style/iframe/… dropped with content; other tags dropped, blocks →
  <br>; no attributes; entities decoded, text re-escaped; balanced; Greenhouse's entity-escaped content decoded
  once). Collectors set job.descriptionHtml (cleanDescriptionHtml → undefined when empty) beside the UNCHANGED
  description the scorer reads (prompts pick fields; descriptionHtml never reaches a model). jobDescriptionHtml
  (job) re-cleans at render, else textToParagraphs (blank line = paragraph, newline = <br>). Card: details.jd >
  div.jd-body. Hub lazy JD: preview text <p>, GET /reports/<d>/jd/<id> returns text/html markup, loader sets
  .jd-body innerHTML. slimJob's field whitelist drops descriptionHtml for postings that never went to review.
- Letters: Open Letter (card action newTab, one-click markReady) opens a new tab. Letter page top row: Copy
  Full Letter (btn) / Copy From Salutation (secondary) / #copy-status. src/cover-letter/plain-text.mjs
  letterPlainText(parts, 'top'|'salutation') + salutationFor + LETTER_CLOSING (assembleLetter uses them); their
  source is injected into LETTER_SCRIPT so page and tests share one implementation; parts {name, contact, date,
  signature} come from data-letter (route: assembleLetter at record.createdAt), company/paragraphs from the page.
  There were no per-paragraph copy buttons to remove.

## Job Description completeness (2026-11-14)
- Cause fixed: enrich.mjs's generic page branch fell back to <meta name="description"> / og:description (a
  search-engine summary ending in "…", descriptionHtml undefined) when a page had no JSON-LD; some JSON-LD
  descriptions are cut summaries too.
- src/jd-extract.mjs: extractJobBody(html, { minimum }) → { html, text, ats, method 'container'|'density' }:
  CONTAINER_RULES in order (iCIMS, Taleo rows, SuccessFactors, Oracle HCM, Jobvite, BambooHR, Workable data-ui
  sections, Paylocity, ADP, UKG, SmartRecruiters .job-sections, [itemprop=description], job-description class/id,
  posting/job details|content|body, main, article; outermost matches, joined), first rule whose text is complete
  wins; else the densest block (text ≥ minimum, links ≤ MAXIMUM_LINK_SHARE 0.3, tightened to the largest child
  holding 80% or when the siblings are navigation/crumbs). script/style/nav/header/footer/aside stripped first;
  form only before the density pass (Taleo renders inside one). extractEmbeddedDescription: longest complete
  "*description*"/job_description string field with markup or newlines in non-JSON-LD scripts. isCompleteText(text,
  minimum, source) (2026-11-15): ≥ minimum (config.minimumDescriptionCharacters, default 200); meta never; ats_api /
  page_body / embedded_json by length alone; json_ld / list also not (< ELLIPSIS_CHECK_CHARACTERS 1500 and ending in
  … / "..."); no source → the summary rule. descriptionStatus /
  withDescriptionStatus (pipeline, for API-fed and failed postings), incompleteDescriptionSummary (info warning
  "N posting(s) have an incomplete Job Description …: host (k), …", 8 hosts; failed fetches excluded).
- enrich.mjs: fromPublicApis(url) = Greenhouse, SmartRecruiters, Lever (leverApiUrl → api.lever.co/v0/postings/
  {company}/{id}, leverEnrichment, enrichment 'lever_api'), Ashby (ashbyApiUrl → board API, matched by id,
  'ashby_api'), Workday CXS; tried for the original URL, then for finalUrl after the page fetch (before the ok
  check), each entry once (`tried`), failures fall through. pickDescription order: complete JSON-LD → page body →
  embedded JSON → complete list text → longest partial of JSON-LD / list / page body (extractJobBody minimum 1, kept
  only when ≥ minimum/4 characters so a shell's "Loading…" never displaces the meta line) → meta (never complete,
  only with no text at all). ashbyApiUrl decodes the org segment before checking it (spaces allowed) and encodes it
  in the API address. Plain-text picks
  with newlines go through textToParagraphs before cleanDescriptionHtml. Still incomplete after a redirect → one
  more fetch of finalUrl by its own address, better answer kept. Fields: descriptionSource, descriptionComplete,
  descriptionContainer (ats label). enrichment labels: json_ld_jobposting (JSON-LD present), html_page (body or
  embedded JSON gave the text), html_metadata (meta or nothing). network.minimumDescriptionCharacters is passed
  by index.mjs ({ ...config.network, minimumDescriptionCharacters }), with options.fetchImpl.
- index.mjs: enriched postings get withDescriptionStatus; the summary counts this run's postings that get a card
  (isEligible or isNotReviewed, after finalizeCompany); meta.incompleteDescriptions { count, hosts } → Run
  Details "Incomplete Job Descriptions". Scoring is unchanged (incomplete postings are scored as before).
- Report: cardView.descriptionComplete (job.descriptionComplete !== false; old payloads count as complete and
  render as before); lazyDescription skips incomplete cards; renderJobCard shows <p class="jd-missing">
  INCOMPLETE_DESCRIPTION_LABEL "Full Description On The Posting Page" · Open Posting</p> instead of details.jd.
  Display cuts audited: only the hub's 300-character preview (full JD via the route), description text capped
  at 50,000 at collection, .jd-body scrolls (max-height) and never clips.
- Tests: tests/jd-complete.test.mjs + tests/fixtures/pages/ (synthetic pages per host shape, manifest.json with
  expected outcomes; no network). History untouched: stored payloads are not re-fetched or edited.

## Message to Recruiters (2026-11-08; named Reach Out until 2026-11-15; people list 2026-11-16)
- HARD: never request, fetch, or log in to linkedin.com; never send messages. ids/classes (reach-*, data-reach,
  /outreach/*, src/outreach/) stay. links.mjs: googleSearchUrl, isLinkedInUrl, assertNotLinkedIn (guards every
  people-search request; ctx.fetchImpl only). Tests assert it at the network layer (fetch stub + global fetch
  blocked). The LinkedIn people-search links, candidates.mjs, the first-name box, resume download
  (/outreach/resume) and Mark as Contacted (/outreach/contacted, /outreach/name, /outreach/candidates) are GONE.
- src/outreach/people.mjs: four kinds — posting (contacts.mjs extractJdContacts, always first, no cap), recruiter,
  team, alumni (one search each via search-discovery searchRequest recent:false count 10; key from
  private/search.json, provider from sources.searchDiscovery.provider). Queries: peopleQueries (recruiter terms
  early-career vs technical; team = functionTerm (JD "join our X team" name, else title/JD function list) +
  (manager OR director OR lead OR head) + quoted city; alumni = schoolSpellings OR-ed: full, without " at ",
  short). Profile: outreachProfile(digests resumes/<track>.digest.md, else config.outreach.profile {schools:
  ["Name" | {name, short}], pastEmployers}); config short wins; schoolShortName = initials (≥3) else the name.
  pastEmployers are read but unused (owner agreed 2026-11-16). No school → no alumni query.
- Parsing: parseProfileResult (title split on - – — | ·, "| LinkedIn" suffix, emoji, "(She/Her)", ", MBA"
  stripped; /in/<slug> only, any subdomain → www). Kept only when companyMention(title+snippet, companyNamesFor
  [short name, letterCompanyFor, job.company, resolveCompanyName candidates except url, matching aliases]) is
  'current' (former/ex-/previously/retired right before a mention → dropped). Dedupe by slug.
- Score (scorePerson; < 2 hidden): recruiter early-talent words +3 on internship/new_grad, recruiter/TA +2;
  team +2 per function word, manager/lead/director +1, VP+ −3 when the board's lastJobCount > 200
  (state/ats-boards.json); alumni school spelling in snippet +2, function word +2; city/state +2 for all.
  headline = title middle part; when it is only the company the snippet is read too. pickPeople: posting rows
  first (a searched person with the same name merges into it, lending the URL), caps recruiter 2 / team 2 /
  alumni 1, leftovers fill to 5.
- findPeople: cache private/outreach/people-cache.json {version, updatedAt, entries: {<kind>:<company>:<…>: {at,
  kind, people: [{name, firstName, headline, snippet ≤300, url, slug}]}}} 30 days (recruiter key adds
  early/experienced, team key = function term, alumni key = spellings); expired entries pruned on write.
  Usage private/outreach/people-usage.json {month, queries, provider, lastQueryAt}, counted before each call;
  cap outreach.peopleSearch.monthlyCap (default 300), enabled default true (searchCandidates: true also reads
  as on); no key ⇒ off. A non-OK answer, a throw or the timeout (8 s; ctx.peopleTimeoutMs) stops the rest;
  status 'ok'|'off'|'no-key'|'cap'|'error'. Nightly run never calls it.
- messages.mjs: LETTER_SCHEMA requires connectionNote + followUpMessage (same call as the letter);
  personalizeMessage(template, {firstName, fellow, limit}) — "Hi <First>," or "Hi there,"; fellow phrase only
  if ≤ limit (note only). It is self-contained (var, no imports) because OUTREACH_SCRIPT inlines its
  toString(). generateOutreachMessages = panel Generate Messages (one call).
- Hub (src/hub/outreach.mjs): GET /outreach/panel renders people at once when every query is cached or no
  search can run, else JD contacts + "Finding People…" + <template id="reach-fallback">; the script POSTs
  /outreach/people ({status, calls, html}; failures are 200 with the Find buttons; one in-flight search per
  job) and falls back client-side after 30 s or on any error. POST /outreach/copied {job, person} → state
  copied[person] + contactedAt (card badge). Settings card: connectionNoteLimit, peopleSearch, peopleSearchCap,
  usage line (outreachSettingsView). Store private/outreach/state.json by job id: contactedAt, copied,
  messages (older firstName/candidates/appliedAt kept, unread). Chaos: people-search-down (429, hang, refused).

## UI redesign (2026-11-08)
- Design rules (src/report-theme.mjs, shared by the Desktop report and the hub): three type levels --fs-title 18 /
  --fs-body 14 / --fs-meta 12 (--fs-page aliases title; no other font sizes anywhere), spacing only --space-1..6,
  --control-height 32. Buttons: .btn (primary, filled) and .btn.secondary (outlined), one size; .small is kept as a
  class but no longer changes anything; .apply = primary. --ink-3 #5b6472 light / #9aa3b1 dark (≥ 4.5:1 on bg, surface
  and the tag background). Card action styles are scoped to `.job .actions` (td.actions in tables is unrelated).
- Card and filter bar: superseded by "Compact cards and page (2026-11-15)" below. Filter state in the URL query
  (q, sort, resume, role, freshness, min, max, hideContacted=1; defaults omitted, other params kept, an old
  hideApplied dropped). Events: 'report-cards-changed' re-applies (drawer contacted), 'report-filters' after each
  apply.
- Mark as Applied: REMOVED 2026-11-15 (button, Hide Applied filter, POST /outreach/applied, setApplied,
  appliedLabel). private/outreach/state.json appliedAt values already on disk are kept and neither read nor written.
- Hub mobile (≤ 760px): nav is one scrolling row (brand and mini status hidden), the month picker is a bottom sheet,
  report-head buttons scroll in one row, kv/conn lists stack; filter bar is a two-column grid (select labels
  visually hidden); Task Assignments stack per stage (≤ 640px). Wide tables scroll inside .card / .table-wrap;
  .file is position:relative so its hidden input cannot widen the page.
- Snapshots: tests/fixtures/snapshots/*.html stay the pre-redesign pages; tests compare CONTENT, not bytes
  (tests/helpers/page-content.mjs assertSameContent: words, links/actions, form fields and data-* must match;
  REDESIGN_ALLOWANCES lists the intended additions and "pdf" from Download PDF → Download Letter; extended
  2026-11-15 with missingWords/missingFields for the compact page).

## Compact cards and page (2026-11-15)
- Card (renderJobCard), top to bottom: .job-head = h2.job-title (Company · Title) + p.job-meta (location · role ·
  span.meta "Posted Nov 14, 3:12 PM" / "Posted Nov 14": "(date only)" only in the hover title; NO Freshness tags;
  then a.badge.badge-warn.job-check[data-badge=letter-check] "Check N Details" at the right end, href = the letter
  page, only for needs-review notes: cardView gets it from decorate(job).check {label,title,href}; reviewBadge's
  label is Title Case now), right .job-score = .scores (one span.track per track "Data <b>82</b>", class .top on
  the highest, every holder when tied: cardView score.top) + .ring 60px (b at --fs-title); .badges; Gaps / Verify;
  details.jd (summary = span + button.jd-copy[aria-label="Copy Job Description"] with an inline SVG); .actions
  Open Posting, Download CoverLetter, Open CoverLetter, Message to Recruiters (Generate CoverLetter in place of
  the two letter actions; ONECLICK_SCRIPT swaps it in place and appends the check link to .job-meta); p.job-foot;
  alternates. No "Apply with … Resume" line (cardView.recommendation gone; the xlsx Recommended Resume column
  stays). COPY_DESCRIPTION_LABEL, INCOMPLETE_DESCRIPTION_LABEL, MENU_SLOT in report-components.mjs.
- Copy Job Description (REPORT_SCRIPT): click on .jd-copy (capture, preventDefault+stopPropagation so the fold
  does not toggle) → the JD markup (fetching data-jd-src first in the hub and filling the body) → navigator.
  clipboard.write(ClipboardItem text/html + text/plain) → writeText(text) → textarea/execCommand; the icon becomes
  a tick (.done) for 1.5 s. descriptionPlainText(html) in src/jd-html.mjs (self-contained, injected via toString):
  blocks separated by a blank line, li → "• ", br → newline, tags stripped, entities decoded.
- Top row (renderToolbar; view.toolbar { title: formatLongDate(meta.date, meta.timeZone), total, roleTypes, tracks,
  freshness (no "date only"), marks, menuSlot/dateSlot: options.embedded }): div.bar-sentinel + form.toolbar#toolbar =
  .bar-title (Desktop: "span.bar-date November 14, 2026 · <span.count#count>42 Jobs</span>"; hub: DATE_SLOT filled by
  reportsPage, see "Date controls"; jobCountLabel; the script writes "N Jobs" / "N of M Jobs"), input#q,
  select#sort/#track/#role (aria-labels, no visible labels; "All Tracks"), details.menu#filters-menu (summary.btn
  "Filters": Freshness, Score, Hide Contacted (hub), Clear Filters; .active when one is set), then the hub's
  details.menu.overflow#more-menu ("⋯", aria-label More Actions: Generate Missing Letters / Update Salutations
  forms, Open Desktop Copy, Download XLSX) which reportsPage puts into the MENU_SLOT comment of the cached body
  (reportMenu). Sticky top:0; IntersectionObserver on the sentinel toggles .stuck (rule + backdrop blur); popovers
  close on outside click / Escape; @media (min-width:1100px) flex-wrap:nowrap (hub nav 152px between 761 and
  1279px); REPORT_SCRIPT fit() (load, resize, fonts.ready): while flex-wrap is nowrap and scrollWidth > clientWidth,
  select#role then #track move into label.control.folded at the top of #filters-menu .menu-list (toolbar
  data-folded="role resume"; a folded control that is set marks Filters .active), back when there is room; .bar-title
  flex 0 0 auto (the date is never cut); ≤640px grid. No masthead, no "quiet" bar, no report-head row;
  .hub-nav is sticky, 100vh, overflow auto again (840be72 had made it static, which pushed .mini off-screen;
  restored 2026-11-15), static only ≤760px. .mini = Last Run, Next Run, [Login], Plan,
  Models (new 2026-11-15, never present before): sidebarSummary.models = sidebarModels → effectiveStageModels
  (src/engines/assignments.mjs; Review = scoring, Prescreen, CoverLetter = letterDraft; walks stageChain past
  weekly_limit / not_on_plan / unknown_model in state/model-availability.json, Claude when signed out, Codex when
  the cached probe says not connected; "Off" when prescreen.enabled is false, "Local Only", "Unavailable");
  span.model[data-model] "Review · Fable 5.1" (modelShortName), .fallback with a hover reason. Test:
  tests/hub-sidebar.test.mjs. Do not name a popover "more" (details.more[open]
  > summary is hidden by the fold rule).
- Groups: main list = every reviewed match that is not carried (date-only and undated included; strict window
  removed); "From Yesterday" (CARRIED_OVER_TITLE) with no note line; Not Reviewed unchanged. The xlsx has no
  group name (Freshness column values unchanged).
- Hub date column: REMOVED 2026-11-18 (renderDateList, .split/aside#date-column, .datelist/.datetools/.history CSS,
  Only Days With Matches, History fold). REPORTS_SCRIPT removes the old localStorage keys hub.reports.history and
  hub.reports.onlyMatches once. See "Date controls (2026-11-18)".
- Screenshots: tests/fixtures/demo-output/screenshots/ (gitignored; playwright-core installed with --no-save,
  Chrome channel; tests/shapes.test.mjs and scripts/shape-check.mjs import it as 'playwright-core'; the older
  capture scripts live outside the repo). Checked at 1440/1100 × light/dark: one-row bar
  that fits, stuck after scrolling with the nav gone, aligned counts, card order.

## Date controls (2026-11-18, src/hub/views.mjs)
- The report fills the width beside the nav (section.report-view; .hub-content:has(.report-view) max-width none).
  reportsPage replaces DATE_SLOT ('<!--date-->', report-components.mjs) with renderDateNav({ dates, selected, today,
  timeZone }) and MENU_SLOT with reportMenu (both request-specific; the cached body keeps the slots).
- renderDateNav: span.date-nav#date-nav = ‹ (a.date-step#date-prev[data-keep-query] or button disabled) + span.date-pick
  (button.bar-date.date-button#date-button "November 15, 2026" aria-haspopup=dialog aria-expanded + div.cal#calendar
  [role=dialog][data-current=YYYY-MM][hidden] + div.cal-backdrop#cal-backdrop) + › (#date-next). neighborDates /
  datesWithMatches: matchCount !== 0 (null counts as matches), so 0-match and missing days are skipped.
- The picker: .cal-head (button.cal-step#cal-prev, span.cal-title#cal-title, #cal-next), .cal-week Su..Sa, one
  calendarMonth grid per month with reports (div.cal-grid[data-month][data-label "November 2026"][data-prev][data-next],
  only the selected month not hidden; Sunday-first blanks span.cal-blank): a report day = a.cal-day[data-keep-query]
  [data-date][aria-label "November 15, 2026 · 3 Jobs"] (span.cal-d + span.cal-n count, .zero light grey, .today ring,
  .current filled + aria-current=date), no report = span.cal-day.off[aria-disabled] (not a link); .cal-foot
  a.btn.secondary.cal-today#cal-today → todayTarget (title says when it is the newest report instead). ≤760px: fixed
  bottom sheet + backdrop (.toolbar.stuck loses its backdrop-filter there so the sheet is fixed to the viewport).
- formatLongDate / formatMonthLabel (src/time-format.mjs): Intl.DateTimeFormat en-US long month in config.timeZone at
  the instant the calendar date is that date in the zone (noon UTC, shifted a day for far zones). Tab titles: Desktop
  view.tabTitle "November 15, 2026 · 3 Jobs"; hub "<same> — Daily Job Match Alert Hub" (rendered.tabTitle).
- REPORTS_SCRIPT: a[data-keep-query] click/auxclick → href = pathname + location.search (filters ride along; URL stays
  /reports/<date>, history normal); ← / → follow #date-prev / #date-next when they are links, not with a modifier, an
  input/textarea/select/contenteditable target, or the picker open; the picker opens on data-current, pages by
  data-prev/next (buttons disabled at the ends), closes on outside click or Escape (focus back to the date).
  REPORT_SCRIPT restore() appends an option for a select value the date does not offer (data-absent) so the filter
  survives a date change. Tests: tests/report-date-nav.test.mjs (fake DOM via vm), hub/report-speed/run-schedule
  updates; snapshot allowances DATE_NAV in tests/helpers/page-content.mjs (addedLinkPrefixes, missingWordPatterns).

## Corner shapes (2026-11-19, src/report-theme.mjs)
- Tokens: RADIUS_TOKENS (inside REPORT_TOKENS) --r-xs 6 / --r-sm 10 / --r-md 14 / --r-lg 20 / --r-xl 28, each
  calc(Npx * var(--corner-k)), and --r-pill 999px. --radius / --radius-sm are gone. No border-radius in src/ or
  scripts/ may hold a length (tests/shapes.test.mjs scans): only var(--…), calc()/max() of tokens, 0, or 50%.
  Pages outside REPORT_STYLES (letter page, fatal ERROR page in index.mjs, letters-ab) import RADIUS_TOKENS and
  SQUIRCLE_STYLES.
- SQUIRCLE_STYLES: @supports (corner-shape: squircle) sets --corner-k to CORNER_K (1.6) and corner-shape:squircle on
  every element; .ring, .ring::before, .facts li::before, .tag and .round stay round. 1.6 was chosen by measuring in
  Chrome 157: the area a squircle corner removes is ~53% of the plain corner's at 1.25, ~88% at 1.6, equal at 1.7.
  Support (2026-11-19): Chrome/Edge 139+; Safari 27.2 (macOS and iOS) and Firefox do not; Safari TP has it. Spec
  (css-borders-4): squircle = superellipse(2), initial round, not inherited; Chrome serializes computed values as
  superellipse(n). No mask/clip-path emulation.
- Concentric rule via --in-r: every rounded container sets --in-r: max(var(--r-xs), calc(<own radius> - <own
  padding>)) (.job, .card, .menu-list, .cal, the mobile .cal sheet, .reach-drawer, .sub-card/.model-card and
  .assignments-card with 12px padding, fieldset.group). Nested parts use border-radius: var(--in-r, <default token>)
  (.btn/.apply, inputs/selects, .badge, .jd-copy, .cal-step, .cal-day, .stage, .reach-person, .reach-icon,
  .reach-text, .jd-frame, .log-frame, .text-frame). A container must not read its own --in-r for its own radius
  (custom properties resolve on the element: fieldset.group spells the card's calc() out).
- Frames (the rounded box clips and pads --space-3 top/bottom and --space-1 at the sides; the inner element
  scrolls with padding 0 --space-2, so text scrolled to its edge still stops 12px from the frame's edge): details.jd .jd-frame > .jd-body,
  .log-frame > pre.log, .text-frame > textarea (letter paragraphs, also created in the editor script; Company Short
  Names), .cal > .cal-body (scrolls only in the mobile sheet), .reach-drawer (overflow hidden, flex column) >
  .reach-panel (scrolls). Cards are overflow:hidden; every hub table sits in .table-wrap / .table-scroll.
  .letter-status:empty has no margin (keeps the editor's last button row in the card's corner zone concentric).
- The drawer is flush right with its two left corners at --r-xl (square at 480px and narrower), so its scrollbar runs
  down the square edge. The toolbar's background and bottom rule reach across the page gutter (--gutter on .page /
  .hub-main .page; margin-inline negative, padding-inline the same). Nav rows: filled --r-md rows, no left bar.
- Shadows: --shadow (cards, softer two-layer), --shadow-pop (popovers, picker, letter sheet), --shadow-drawer.
- Checks: scripts/shape-check.mjs (auditShapes runs in the page) over tests/helpers/ui-pages.mjs (Reports, Letters,
  letter editor, Resumes, Status, the three Settings tabs, letter page, Desktop HTML; report states: JD open,
  Filters, picker, "⋯", drawer) at 1440/1100 × light/dark (also checked by hand at 390 and 760) × squircle/plain (plain = --corner-k 1 and corner-shape
  round forced, i.e. what Safari draws). Rules: corner (text boxes inside the curve, superellipse for squircle),
  nested (corner zone only: both gaps ≤ the outer radius; expected max(outer − gap + outer border, xs), capped at
  half the inner box), padding (box >48px: text ≥ max(12, 0.6 × token radius) from every edge, legends exempt;
  control ≤48px: ≥ 0.8 × radius left/right; capsule ≥ 0.8 × h/2), scroll, clip, round. `node scripts/shape-check.mjs
  --shots <dir>` also writes screenshots (tests/fixtures/demo-output/screenshots/shapes/, gitignored). The test
  skips when playwright-core or Chrome is missing (CI).
- Content snapshots: tests/fixtures/snapshots/shapes/*.html, captured from e813d85 before the restyle. contentOf()
  drops <style> bodies, asset hashes, class/style attributes and the frame wrappers (WRAPPERS), blanks timings,
  the hub-timings rows and the platform's backup folder (Status; macOS vs XDG on Linux CI), then compares exactly. The hub JS asset may differ only by SCRIPT_CHANGES (the editor's
  text-frame), checked by re-hashing.

## Letter rules v2 (2026-11-08, from private/review/cover-letter-review-response.md)
- config.coverLetter.rulesVersion "v1" (DEFAULT, unchanged behavior; v1 reads private/cover-letter/playbook-v1.md, the
  pre-edit backup, when present) | "v2"; openingStyle "limit-writing-to" (an "I am writing to" opening allowed while
  the last 7 days use it ≤ 30%) | "ban-writing-to"; availability { fullTimeFrom "June 2027", springTerm false,
  mentionMasters { internship true, newGrad false } } (src/cover-letter/availability.mjs letterRulesSettings;
  Settings → Cover Letters "Letter Rules", POST /settings/letter-rules). The hub playbook (private/cover-letter/
  playbook.md, edited per review part B; backup playbook.backup-2026-11-08.md, diff private/review/playbook-v2.diff)
  carries {{AVAILABILITY}}, filled per letter (renderPlaybook). Never hard-code availability or master's plans.
- v2 prompts: src/cover-letter/rules-v2.mjs (letterRulesV2, buildCoverLetterPromptV2 / buildReviewPromptV2 /
  buildCondensePromptV2, LETTER_SCHEMA_V2 adds candidParagraphIndex + candidGaps ≤ 3, REVIEW_SCHEMA_V2 adds
  candidParagraphIndex; coreGaps = "No …"/skill-not-found gaps minus eligibility/schedule items; closingRule drops
  overused thank-yous). v2 flow src/cover-letter/generate-v2.mjs: editor issues filtered (filterEditorIssues: quote
  not in draft, case-only name mismatch), rewrite guard (guardEditorRewrite: a revised paragraph adding numbers
  outside resume+playbook+JD or scenario phrases keeps the draft paragraph, note "check failed (editor-rewrite)"),
  postingCasing for the short name, autoFix (%, ≥, ≤, τ, ρ, K+ in words; " - " → ", "), runChecks.
- Checks (src/cover-letter/checks.mjs, CHECK_IDS): opening, banned-phrases, principle-openers, symbols,
  title-separators, graduation-once, availability, masters, numbers (evidence.mjs whitelist by value), metric-repeat,
  scenario, jd-echo (≥ 6 shared words), candid, scoring-evidence (matchReasons naming an experience only another
  resume has; resumeExperiences parses employer "X | Role | Place" lines and project headings), one-page. A failure
  is the editor note "check failed (<id>): …" (needs-review, notes.mjs), a fix "auto-fix: …" (info). reviewBadge
  honors letter.reviewClearedAt (POST /letters/clear-review, letter page "Mark Details Checked").
- v2 save (finishLetterV2 in src/hub/letters.mjs): > 560 words → condense before render; renderLetterPdfV2 = Letter
  1in only (no B5), condense min(480, 0.85×words) then 450; re-run checks with pages; record keeps rulesVersion,
  candidParagraphIndex, candidGaps, openingForbidden, checks. v2 track rule letterTrackFor: business analyst /
  customer support / operations / product / project / consulting titles → DA_TRACK_ID 'data'; letter page offers
  "Regenerate With DA Resume" when a scoring-evidence note exists. Term conflict (postingTermConflict: title, or a
  description sentence about the term/start, not graduation or applications) → selectAutoLetters skips
  (skipped.termConflict), card badge "Term Conflict", manual letters allowed.
- src/cover-letter/recent.mjs recentLetterStats (7 days): overused (> 15%) openings/closings and experiences
  (> 60%) go into the next v2 prompt; Status "Letter Variety" card shows the rates (stripped by the Status snapshot
  helper). A/B: scripts/letters-ab.mjs + src/letters-ab.mjs (real engines, saves nothing to the store or outreach
  state; private/review/ab-jobs.json, output private/review/ab-<date>/).
- Tonight's batch + closing rotation (2026-11-09, recent.mjs): batchAvoid (letters created in the last BATCH_HOURS 12,
  other postings only; the A/B script passes its unsaved letters as extraLetters) → v2Context batch: the prompt
  lists their first sentences (batchOpeningRule: another construction) and closing paragraphs (closingRule: another
  forward-looking sentence), the last BATCH_PROMPT_LIMIT 10. pickClosing assigns one of THANK_YOU_SENTENCES (6) per
  letter: not used tonight, share ≤ CLOSING_LIMIT 0.3 of the last 7 days, least used first; closingRule demands it
  word for word, autoFix({ closing }) replaces another thank-you sentence (draft/editor output and condensed bodies,
  never the body the owner saves), record.closingSentence (rules.closingSentence, only a listed sentence accepted).
  Checks 'opening-variety' (openingShape: first 5 words with title/company words masked, equal to a batch shape)
  and 'closing' (last paragraph does not start with the assigned sentence) are needs-review.
- Letters by job ID (2026-11-09, store.mjs): saveLetter writes private/cover-letters/<date>/<jobId>/ (meta.jobId;
  no job ID → company folder as before); record.companySlug keeps the company slug, `slug` in listLetters/URLs is
  the folder name. adoptLegacy moves an old company folder holding the same job's letter (with its PDF) into the job
  ID folder on the next save; renameLetter keeps a job ID folder (moves an old one in); a re-save under another
  company name deletes the old-name PDF. updateSalutations keys collisions by job ID. Old company-folder URLs keep
  working until the letter is saved again. Audit: npm run letters:audit (scripts/letters-audit.mjs,
  src/letters-audit.mjs, read only; --out writes the Markdown): postings without a letter whose same-date company
  folder holds another job's letter, evidence confirmed (Reach Out texts from a letter) / likely (that date's
  automatic pass shortfall covers them) / possible / unproven. Real data 2026-11-09: 100 listed (80 likely, 15
  possible, 5 unproven), shortfall 95 letters across 25 passes 10-08..11-06; not regenerated.

## Scoring engines (src/engines/)
- One interface per engine: verifyAuth(), reviewBatch(prompt, schema,
  { tempDirectory }), describeModel(), modelMatches(actual),
  describeConnection(). claude.mjs and codex.mjs implement it; index.mjs is
  the registry (normalizeEngineId, resolveModel, createEngine,
  describeConnections). src/subscription-match.mjs only orchestrates batches,
  retries, supplemental review, and local_fallback on top of an engine.
- config.semanticMatching.engine is "claude" (default) or "codex";
  models: { claude, codex } holds each engine's model as a registry id (legacy `model` still
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
  entity → URL (Workday site / board slug). Source and registry names (and
  names the owner types) are trusted unless empty, legal-only, or shorter than
  two characters (`isTrustedSourceName`: "3M", "Q2", "S&P Global" pass); ATS,
  employerName, and URL candidates also face the strict `isValidCompanyName`
  (no leading tenant code, no bare code such as "US101" or "1007 Clarios, LLC",
  no generic word). The Letters page flags stored salutations that look like
  raw entities (`looksLikeEntityCode`). The
  pipeline settles job.company/companySource/companyUncertain after scoring
  (`finalizeCompany`); enrichment never overwrites a valid source name. An
  uncertain company shows a "Company name uncertain" badge, blocks one-click
  letters (the panel asks first), and blocks Save & Render; the editor pass
  flags "salutation says X, body says Y". Letters are named
  {Prefix}_Cover_Letter_{Company}.pdf (prefix from Settings, default derived
  from the signature, e.g. "Mary (Molly) Doe" → MollyDoe); Rename
  Company & Re-render (POST /letters/rename) moves the directory and file
  without calling the model (and refuses to land on another posting's letter).
- Short names (src/cover-letter/short-name.mjs, 2026-11-04): salutation, file name, and body mentions after
  the first use the company's short name. LETTER_SCHEMA = { paragraphs, shortName } (condense uses
  BODY_SCHEMA); companyNamingRule asks for the posting's most-used self-name, ≤ 4 words, no coined
  abbreviation. resolveShortName order: owner-typed (panel field, sent as companyEdited=1, or any name given
  for an uncertain company) → alias table (profile.companyAliases, Settings → Cover Letters "Company Short
  Names", "Full = Short" lines; matched against every chain candidate as written or cleaned) → model
  shortName if validateShortName passes (case-sensitive whole-name hit in job.description after &amp;/’
  normalization, or equal to the cleaned name) → cleanCompanyName(chain name). Cleaning (second pass,
  2026-11-04): baseCompanyName always drops parentheses, ", a …" appositives, Inc./Incorporated/LLC/L.P./LP;
  Corporation/Corp./Company/Co./Group/Holdings and a leading "The" go only when the shorter form is attested
  in the JD (attestedCount: an occurrence not followed by a dropped suffix word and, if "The" was dropped,
  not preceded by "The"); otherwise the base (full) name stays. No JD → base. A refused shortName still in the body → issue kind
  'short-name'. The editor prompt now allows the full name at the first mention. Records keep fullName and
  shortNameSource. POST /letters/update-salutations (Reports "Update Salutations (N)", shown when the date
  has letters): salutationUpdateFor = alias → owner rename (shortNameSource 'owner' or legacy renamedAt) →
  with a JD in the payload, inferShortNameFromPosting (most JD occurrences among cleaned, full/base, a stored
  model name that validates, and brands: an acronym whose capitals spell the name's initials incl. CamelCase
  humps (HPE, P&G, PwC, RGA), a contraction of word starts (FedEx, AmEx), or KNOWN_BRANDS (Disney, IBM,
  BofA, 3M); ties keep that order; source 'posting') → without a JD the stored model name, then the cleaned
  name; reuses renameLetter (PDF re-render, no condense,
  no engine); skips a target slug held by another posting's letter. Real-data preview 2026-11-04 (second
  pass): 51 of 571 saved letters would change; 36 differ from the first pass.
- Personal details (name, phone, email, signature, playbook, sample letters)
  live ONLY under private/cover-letter/; generated letters under
  private/cover-letters/<date>/<jobId>/ (older ones <date>/<Company>/). Never put a real person's data in
  code, config.example.json, docs, or fixtures: use "Jane Doe" placeholders.
  Downloads go through /letters/<date>/<folder>/<file> with a file whitelist.

## Fable on Pro (2026-11-15, src/engines/plan-models.mjs)
- Pro bills Fable to paid usage credits from the first call (Anthropic's plan notes; the CLI's refusal reads "You're
  out of usage credits"); the project uses subscription allowances only. PAID_CREDIT_ALIASES { pro: ['fable'] };
  claudePlanOf(config, { detected, now }) = planView('claude').plan (manual > scheduled change from its date > the
  detected plan). planAdjustedConfig(config, plan) returns a COPY (same object when nothing is billed): ladder without
  Fable (empty → Opus), semanticMatching.models.claude → the ladder's first step when it resolves to Fable, each
  models.assignments stage drops Fable from its fallback and a Fable stage model gives way to its first fallback (else
  Opus). Never rewrite config.json for this.
- Applied: runPipeline after loadState (detected = state.observedPlans.claude; one info warning "Fable Uses Paid
  Credits On Pro: skipped … in every task; scoring starts at …"; prescreen and scoring use the copy);
  applySubscriptionMatching options.paidCreditModels(planFromAuth) after verifyAuth (skip set; a Fable engine switches
  to the first ladder step left, else quotaDeferred); hub planConfigFor(ctx, config) for generateLetter / saveLetter /
  generateOutreachMessages (detected = the cached probe), withQuotaPolicy adds the paid ids to its skip lists; testModel
  refuses a paid model; effectiveStageModels(config, { claudePlan }) walks the adjusted chain and reports the reason
  "paid credits on Pro"; modelSettingsView marks such steps blocked ("Paid Credits on Pro") and gives the stage row
  paidWarning → badge data-paid-credits "Fable Uses Paid Credits On Pro" in Task Assignments (supplemental excluded).
  Max (or no plan) → unchanged. Tests: tests/plan-models.test.mjs.
- Owner's runs since the 2026-10-26 switch (usage.json + daily logs, read 2026-11-15): 10-30 one Fable call refused
  ("out of usage credits", ambiguousWeeklyLimit → Opus); 10-31..11-12 Fable skipped (limit held); 11-13, 11-14, 11-15
  Fable answered 32 review calls after the Friday weekly reset released the hold (≈115k output tokens).

## Letter page (2026-11-15, src/hub/letter-page.mjs)
- GET /letters/<date>/<folder> is a standalone document (no hub layout, nav, notes list, engine/version lines, links,
  or form fields): letterDocument → div.top (button#copy-letter "Copy" + button#regenerate-letter "Regenerate", p.error)
  + #letter-holder > [p.flags-top] + article.sheet#letter[data-letter] laid out like pdf.mjs letterHtml (Times 11pt,
  centered name/contact, 1in padding, white sheet in dark mode too). Text from parseLetterMarkdown(letter.md) (the
  markdown of the very letter the PDF was rendered from; handles the pre-09-20 blank line before the signature; all 780
  real letters parsed with paragraphs equal to the record), else assembleLetter from the record.
- Notes: only needs-review (classifyEditorNotes; none after reviewClearedAt). src/cover-letter/note-marks.mjs
  placeNotes: notePhrases (quoted text, "unverified detail: X" minus "the claim that", "body says X", "number N") →
  sentence (splitSentences rejoins exactly) by substring or standalone number, else ≥ 60% of ≥ 3 content words; hit →
  span.flag[title=note]; misses → p.flags-top (first note, "+N More", all on hover). Real data: about half place (the
  rest name text the editor already removed). Copy = letterPlainText(data-letter, 'top'), "Copied" for 1.5 s.
- POST /letters/regenerate { date, slug } (JSON): refused while the automatic pass runs or material is incomplete; runs
  regenerateLetter through ctx.letterJobs (cards wait) and awaits settle(): generateLetter(strict, same track, short
  name fixed when shortNameSource is owner) + saveLetter; a failure after the save began rewrites the old letter.json/
  letter.md and the old PDF bytes. Reply { slug, openUrl, downloadUrl, sheet }; errors are the runner's humanized line.
- The old editor panel stays at /letters/<date>/<folder>/edit; its only entry is "Edit Letter" (a[data-letter-edit]) at the
  right end of each Letters list row (2026-11-18); cards never link it. /letters/new is unchanged. Card
  Download CoverLetter has download="<pdfFileName>" (renderAction action.download; ONECLICK markReady sets it too);
  the route already answered content-disposition attachment. Letters list: Open CoverLetter / Download CoverLetter / Edit Letter.
- Check N Details seen (2026-11-18): GET /letters/<date>/<folder> calls markLetterReviewSeen (src/hub/letters.mjs):
  once, only with needs-review notes and no reviewClearedAt, record.reviewSeenAt via letterStore.saveLetter (render
  cache invalidated). getReports passes check.seen → renderCheck badge-muted + data-seen="1" (else badge-warn);
  REPORTS_SCRIPT greys it in the open report when a card link to the same letter page is clicked. Regenerate saves a
  fresh record (new editorNotes, no reviewSeenAt/reviewClearedAt), so the badge goes unless the new letter has
  needs-review notes. The 6-posting letters A/B is not re-run; the page-body 50-character minimum stays.
  Tests: tests/letter-page.test.mjs.

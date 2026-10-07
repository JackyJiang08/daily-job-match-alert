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
  until the reset time (7 days when the notice gave none) and the next run
  starts on the next model without asking the limited one. The CLI's words
  (sanitizeNotice: no command path, ids, e-mail, URL query; 300 chars) go to
  state/quota-notices.json and the Quota card's CLI notices. Deferred
  postings use state.deferred (quotaDeferred), never unreviewed. Cover letters
  step down the same ladder (editor note + footer) and offer "Generate with
  Codex"; Status has a Quota card; Settings exposes the ladder and fallback.
  Fixture: tests/fixtures/quota-errors.json (recorded from the CLI binary).
- Expired login (src/engines/engine-errors.mjs): the CLI's print-mode result
  envelope ({ is_error: true, result: "<notice>" }, recorded in
  tests/fixtures/engine-errors.json) is unwrapped before any text reaches a
  person; quotaPolicy.patterns.authExpired classifies "Failed to authenticate",
  "OAuth session expired", "could not be refreshed", "not logged in",
  "loggedIn=false" as auth_expired. Nightly: defer like a quota (never
  unreviewed), meta.authExpired, banner + footer + Run Details, macOS
  notification via notifyAuthExpired (injectable through main({ notifier })).
  Hub: ctx.authState (expire/clear), "Session expired" badge on Connections
  and the sidebar, Status banner, POST /settings/connections/refresh clears
  it; every user-visible engine error goes through humanizeEngineError
  (auth sentence, quota sentence, or "Generation failed (<reason>); details
  in the hub log"); raw text only in the hub log.
- Automatic letters (src/auto-letters.mjs): main() runs runLettersPhase after
  runPipeline returns and the run lock is released (Run Now too), under
  state/.letters.lock, with a headless hub context (createHubContext; tests pass
  options.lettersContext with fake engines). config.coverLetter.autoGenerate
  { enabled true, maxPerRun 8 }; selection = this run's new matches
  (summary.newMatchUrls) by score, skipping letters on file and uncertain
  companies; generateLetter(strict) + saveLetter on the draft/editor stage
  chains; a fully failed chain stops the pass with a warning. Off when the
  draft stage is the local_only placeholder or material is incomplete. Status
  in state/letters-auto.json (cards: "Letter generating…", manual one-click
  and Test refused while the letters lock is held); outcome goes to
  meta.autoLetters (Run Details, re-rendered HTML and warnings.txt; the xlsx is
  left as written) and the Status card; usage entries are tagged
  source 'auto-letters'. Letter records keep engine/model/effort for draft and
  editor (passLine in the footer and Editor notes). The letters status line
  goes to stderr: stdout is the run summary JSON that chaos parses.
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
  or the full id when there is none (Codex). The id modelUsage reports is the
  resolvedId; a different release (newerRelease, e.g. claude-fable-5-2) shows
  "New version: <id>" in Settings and still matches its family. Never add a
  model string elsewhere.
  semanticMatching.reasoningEffort reaches Codex as `-c
  model_reasoning_effort="x"` (unset = CLI default).
- Model status lives in state/model-availability.json (version 2): models
  (kind not_on_plan | unknown_model, skipped by the ladder), limits (weekly
  limit, cleared at resetsAt or after 7 days), seen ({ resolvedId,
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
  sales, technician, nurse, driver, mechanic) + excludeLevelSuffixes (II, III,
  IV, standalone uppercase) are skipped; uncurated sources (ATS boards, HN,
  RemoteOK) must also name a preferences.titleFamilies term (whole words; the
  last word of a family term also takes common endings: engineer →
  engineering, developer → development, statistic → statistician; acronyms
  and exclusions stay strict). A title with a prefilterExcludeOverrides
  phrase (new grad, early career, university, graduate program, 2027,
  rotational, associate product manager) is exempt from the "manager" and
  level-suffix exclusions only;
  curated lists and alert emails skip the family check. A location
  assessLocation() calls non-US is skipped too. Skipped postings are not marked
  seen. meta.prefilter feeds the Run Details "Prefilter" row (per-source counts
  and a folded list: company · title · source · rule). Final scoring and
  isEligible are unchanged. `detectEarlyCareer` marks job.earlyCareer
  (entry_level from the title: level I, Associate, Junior, Graduate,
  University, Early Career, Entry, Rotational, or a plain Analyst; new_grad
  when the JD also says 0-2 years / recent graduate / Class of 2027 / new
  grad); it never rewrites roleType and only ranks those postings with
  internships inside a freshness bucket (`isEarlyCareerPriority`).
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
  from the stored day payloads; no longer history exists, so no all-time
  claim).
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
  primary. The masthead says "posted within the last 24 hours / N days" from
  the report's oldest posting date at run time.

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
  without calling the model.
- Personal details (name, phone, email, signature, playbook, sample letters)
  live ONLY under private/cover-letter/; generated letters under
  private/cover-letters/<date>/<Company>/. Never put a real person's data in
  code, config.example.json, docs, or fixtures: use "Jane Doe" placeholders.
  Downloads go through /letters/<date>/<Company>/<file> with a file whitelist.

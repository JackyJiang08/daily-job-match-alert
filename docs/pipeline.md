# Pipeline

What one run does, from collecting postings to the report, and how it keeps going when a part of it
fails. The schedule and every default named here can be changed (see
[configuration.md](configuration.md)).

## Every Night

At 18:00 (America/Chicago by default) a launchd job runs the pipeline once, unattended:

1.  **Collect.** Postings arrive from public GitHub lists (SimplifyJobs, Jobright, vanshb03, Zapply,
   zshah101), the month's Hacker News "Who is hiring" thread, the RemoteOK feed, the public
   job-board APIs of Greenhouse, Lever, Ashby, Workday, and SmartRecruiters tenants that earlier
   postings (or your seeds, or an opt-in web search) pointed at, and any `.eml` alert files dropped
   into `intake/eml`. Every board is polled once per night with a named user agent and conditional
   requests.
2.  **Deduplicate.** URLs are canonicalized (tracking parameters stripped, redirects resolved) and
   checked against `state/state.json`, so a posting is reported once even when three sources list
   it.
3.  **Fetch the description.** Board APIs deliver the full text directly; other links are fetched
   once, with Workday pages read through the tenant's public JSON endpoint. A link that redirects
   into Greenhouse, SmartRecruiters, Lever, Ashby, or Workday is read through that ATS's public
   endpoint for the final URL too (Lever and Ashby posting pages included). On any other page the
   Job Description is the first complete text of: the JSON-LD `JobPosting` description, the page
   body (the content container of iCIMS, Taleo, SuccessFactors, Oracle HCM, Jobvite, BambooHR,
   Workable, Paylocity, ADP, UKG, `itemprop=description`, job-description classes and ids, `main`,
   `article`, or else the block with the most text and few links once navigation, headers, footers
   and forms are set aside), the page's embedded JSON (`__NEXT_DATA__`, `window.__INITIAL_STATE__`),
   and the list's own text; a `<meta name="description">` summary is used only when nothing else
   exists. Complete means at least `minimumDescriptionCharacters` (200) characters and not a meta
   tag; a JSON-LD or list text shorter than 1,500 characters that ends in an ellipsis is a cut
   summary, while an ATS API, page-body or embedded-JSON text is judged by length alone. With
   nothing complete, the longest partial text of the JSON-LD, the list or the page body is kept (a
   meta tag only when there is no text at all); every posting records `descriptionComplete` and
   `descriptionSource` (`ats_api`, `json_ld`, `page_body`, `embedded_json`, `list`, `meta`). A
   redirect that lands on an incomplete page is fetched once more by its own address. An incomplete
   posting is still scored, its card shows one line, "Full Description On The Posting Page", with a
   link instead of the fragment, and the run's warnings carry one info line with the count and the
   first eight hosts (also a Run Details row). Unreachable pages are retried on later nights,
   refused or removed ones are closed. A posting whose own publish time is then known to the minute
   (a board API, a JSON-LD `datePosted` with a clock time) is held to the lookback window exactly
   and dropped without being marked seen when it falls outside; day-level sources (list ages such as
   "3d", Workday's "Posted 3 Days Ago") are converted to a posting date and held to the window by
   the end of that local day, so "posted yesterday" stays in for the whole day while "3 days ago" is
   out even of the backlog. A posting the source does not date at all (Oracle Cloud recruiting
   pages, for example) is judged by when this pipeline first found it, shows "Unknown (found
   Sep 26)" as its Posted At in the report and the workbook, is reviewed after every dated posting,
   and is dropped after two nights without a date. Run Details counts precise, date-only, and
   undated postings per source. Boards polled every night (Greenhouse, Lever, Ashby, Workday,
   SmartRecruiters; not quiet ones) are judged by snapshot instead: a posting that was not on the
   board at its previous successful poll, at most 30 hours earlier, is new since last poll and
   inside the window whatever date the board prints; a posting already there last night is left out
   even when it now says "Posted Yesterday". A new board, a failed last poll, or an older snapshot
   falls back to the dates. The snapshots live in `state/ats-snapshots.json`. A posting date later
   than the run is a misread time zone and is cut to a date-only value on the run's day (jobright.ai
   pages print UTC times without a zone and are read as UTC; other zoneless times keep only their
   date); Run Details counts the corrections. Workday entity names such as `100000 Motorola
   Solutions, Inc.` are replaced by the list's or registry's company label, or cleaned when there is
   none, and the same cleaning is applied when older reports are rendered.
4.  **Hard-filter.** Two facts are enforced in code, whatever the model says: the location must be
   in the United States (or unstated: when neither the location nor the description names a US state
   or city, "United States", "US-based", or US work authorization, the card says "US Location Not
   Stated"), and the graduation window in the posting must fit `preferences.graduationDate`.
5.  **Score with your subscription.** Every remaining posting is reviewed against each enabled
   resume track by the Claude Code CLI or the Codex CLI, signed in with a claude.ai or ChatGPT
   subscription. Each track gets a 0–100 score with reasons and gaps; the best track is recommended.
6.  **Write two files to the Desktop.** `~/Desktop/Daily Job Match Alert/<run date>/` receives a
   self-contained HTML shortlist (sortable, searchable, dark-mode, complete JD folded into each
   card) and an XLSX workbook with one score column per track. Each card shows one score line per
   track (the highest marked, every one when tied) beside the ring, and Gaps / Verify (every item,
   open); the review's "why it matches" evidence is kept in the payload for cover letters and is not
   shown on cards or in the workbook. The folded Job Description keeps the posting's own paragraphs,
   headings, lists, bold, and links: collectors save a cleaned `descriptionHtml` beside the plain
   text the scorer reads (Greenhouse content, Lever description and lists, Ashby descriptionHtml,
   Workday jobDescription, SmartRecruiters sections, JSON-LD description), through a whitelist of p,
   br, ul, ol, li, strong, b, em, i, h1–h4, and a (http, https, or mailto only, opened in a new tab
   with `rel="noopener noreferrer"`); scripts, styles, frames, inline styles, and event attributes
   are dropped. Plain-text sources and older reports are split into paragraphs at their own line
   breaks. The hub embeds the first 300 characters of a long JD and loads the rest when the section
   opens; the Desktop file carries every JD whole (the plain text the scorer reads is capped at
   50,000 characters, and the markup is scrolled inside the card, never cut). A card whose
   description could not be read in full shows "Full Description On The Posting Page" with a link to
   the posting instead. `warnings.txt` appears beside them only when something degraded. A card and
   the XLSX show a posting time only when the source gave one; day-level dates read "Oct 8 (date
   only)" and a board posting new since the last poll reads "first seen Oct 9, 8:04 PM". The XLSX
   has a Freshness column (new since last poll, posted today, carried over, date only, undated).
   Postings the review budget carried from an earlier run sit in their own "From Yesterday" group
   under the main list, with the time each was first found.

Every run writes the folder of its own local day: the 18:00 run, a Run Now, and a catch-up all fill
today's report, and the report is titled with that date (18:00 in Chicago is already the next day in
UTC; the local day counts). Reruns on the same date merge into that day's report instead of
replacing it; nothing already listed is dropped. Folders written before 2026-11-08, when evening
runs wrote the next day's folder, keep their names: the first 18:00 run merges into the folder the
previous evening created for that date, and the hub lists every date once. The schedule is whatever
`scripts/install-launchd.sh [hour] [minute]` installed (default 18 0); the hub's Next Run, overdue
badge, auto catch-up deadline, and dormant-board probe time read it from the LaunchAgent.

## Reliability

The run is designed to leave a report even when parts of it fail:

-  **Degrade, don't die.** A failing collector, board, page fetch, or model call becomes a `[stage /
  source] message` line in `warnings.txt`; the rest of the run continues. A fatal error before any
  report writes `ERROR-<date>.html` and a macOS notification.
-  **Catch-up.** `state.lastSuccessfulRun` is recorded only when both the HTML and the XLSX exist. A
  login or boot start runs the catch-up path, which executes only when the last success is more than
  26 hours old.
-  **Lock.** `state/.lock` holds the owner PID; a second start exits cleanly, a stale lock from a
  dead process is removed.
-  **Same-day accumulation.** `state/report-payload-<date>.json` holds everything reported for one
  application date; each run merges into it (a semantically reviewed copy beats a local one, a
  longer description beats a shorter one) and re-renders both files as `Daily update #N`. An
  incomplete day is rebuilt at the start of the next run.
-  **State file safety.** Every JSON file under `state/` and `private/` is written to a temporary
  file in the same folder, fsynced, and renamed over the old one, so a crash or power loss leaves
  the old file or the new one, never half of one. `state/state.json` and the board registry
  `state/ats-boards.json` keep their three previous versions (`.1`, `.2`, `.3`); when one of them
  does not parse, the run reads the newest backup that does, puts it back, keeps the broken copy as
  `<file>.corrupt-<time>`, adds a warning, and sends the notification "state.json was corrupt,
  restored from backup (<time>)". At startup the run and the hub check that every JSON in `state/`
  parses and compare the number of seen postings with the number the last run recorded
  (`state/integrity.json`): a drop of more than half (a replaced or reset state would treat old
  postings as new and re-baseline boards) is shown in the report header and as a Status banner.
-  **Backups.** `npm run backup` writes a dated zip of `private/`, `state/` (without the day
  payloads, logs, payload backups, and the `.1`–`.3` copies), and `config.json` to
  `config.backup.directory` (default `~/Library/Application Support/daily-job-match-alert/backups`
  on macOS, `daily-job-match-alert/backups` under `$XDG_DATA_HOME` or `~/.local/share` on Linux);
  the scheduled run (or its catch-up) makes one each night and the newest seven are kept
  (`config.backup.auto: false` turns the nightly one off). `npm run restore -- <zip>` writes a
  backup's files back under the run lock, after saving the current ones as a `-pre-restore` zip;
  restart the hub afterwards. The Status Runs card shows the latest backup's time and size.
-  **Payload size.** Only postings that went to the final review (and every match) keep their full
  Job Description in the payload; postings the local prefilter or the title and prescreen filters
  left out keep their title, company, location, source, links, dates, scores, and why they were left
  out. Payloads more than 30 days old are stored as `.json.gz` (the Reports pages and the index read
  both), and past the retention period (Settings → Pipeline, default 90 days) a day keeps only its
  matches and Run Summary. `npm run payloads:compact` applies the same rules once to payloads
  written before them, backs each file up to `state/backups/` first, and prints every size before
  and after (`-- --dry-run` only reports).
-  **Pre-screen.** Before any page is fetched, titles are checked against an exclusion list (the
  eligibility terms plus `prefilterExcludeTitleTerms`: head of, vice president, VP, account manager,
  sales, sales associate, store associate, retail associate, retail sales, store manager, warehouse,
  customer success, engagement manager, technician, nurse, driver, mechanic, and the level suffixes
  II, III, IV), and postings from uncurated feeds (ATS boards, Hacker News, RemoteOK) must name one
  of `preferences.titleFamilies` (data, analytics, analyst, scientist, machine learning, ML, AI,
  quant, BI, software engineer, research, decision, statistic, actuarial, consultant, consulting,
  strategy, strategist, business analyst, program manager, solutions engineer, associate product
  manager, APM, product manager, the entry programs (rotational, development, leadership, graduate,
  analyst, early career, associate program), and so on; "associate" is never a family on its own, so
  Associate Consultant and "Associate, Strategy" pass while a lone Associate does not). Family terms
  also match common endings, so "engineer" covers "Software Engineering Intern" and "statistic"
  covers "Statistician"; acronyms such as AI stay whole-word. Titles with early-career wording (new
  grad, early career, university, graduate program, 2027, rotational, Associate Product Manager,
  Associate Program Manager, or APM; configurable as `prefilterExcludeOverrides`) are exempt from
  the manager and level-suffix exclusions only, here and in the final eligibility check. Curated
  lists and alert emails only face the exclusions. A location already known to be outside the US is
  skipped too. Run Details counts the skips per source and lists every title it dropped, with the
  rule, so a false positive is easy to spot. The score bands and thresholds are unchanged. Full-time
  early-career roles (a level I title, Associate Consultant, Business Analyst, Associate Product
  Manager, APM, Consulting or Strategy Analyst, an entry program (rotational, development,
  leadership, graduate, analyst, early career, associate), Associate, Junior, Graduate, University,
  Early Career, Entry, Rotational, or a plain Analyst; promoted to new grad when the description
  says 0-2 years, recent graduate, Class of 2027, or new grad) are ranked with internships inside
  the review budget; Senior Consultant, Engagement Manager, and Principal stay excluded.
-  **Role scope.** `preferences.targetRoleFamilies` (default data, AI/ML, software, product
  management, consulting/strategy) goes into the prescreen and review prompts: a product or
  consulting posting is judged on analytical ability, project and internship experience,
  communication and collaboration, and business understanding, and is not marked down for not being
  a data role. The model still picks the resume track from the evidence. Settings > Pipeline edits
  both this list and `titleFamilies` as tag lists (× removes a tag, Enter adds one; the next run
  uses them). Run Details has a "Candidates by role family" row: for data, AI/ML, software, product,
  and consulting, how many postings entered the prescreen, the review, and the matches.
-  **Zapply links.** Zapply list links are redirects (a 301, then a 302 to the employer's posting).
  They are resolved before enrichment so the Workday, Greenhouse, and other ATS fetchers read the
  employer's page, and a posting listed both on Zapply and by the employer is reviewed once.
  Listings Zapply has removed are reported as a warning and fall back to the old path.
-  **Per-stage models.** Scoring (with Supplemental), the cover-letter draft, and the cover-letter
  editor each have their own engine, model, reasoning effort, and fallback chain. Letters default to
  Codex gpt-5.6-sol (medium effort for the draft, high for the editor) and fall back to Claude Opus;
  when Codex is not connected the fallback runs and the letter's Editor notes say so. Scoring's
  chain is the Claude model ladder, ending with Codex on a weekly account limit or a signed-out
  Claude when Codex is signed in. Automatic letters are written only for postings a model reviewed
  as high matches.
-  **Run breakdown.** Run Details and the workbook's Run Summary count postings scored per engine
  and model, deferred (review budget or quota), prefiltered out, and expired; when a quota limit
  touched the run, the report header says how many postings it held back and which engine or model
  took over.
-  **Subscription usage.** Each call's token usage is read from the CLI's JSON: Claude's
  `modelUsage`, keyed by the model id that actually ran and stored verbatim, and Codex's
  `turn.completed` usage with the model id and reasoning effort. Entries are tagged review,
  supplemental, editor, or letter and kept in `state/usage.json` for 35 days. The Status Quota card
  shows the last seven days by model, by purpose, and per night; Run Details shows the run's totals.
  A successful Claude reply whose usage cannot be read adds a "usage parse empty" warning instead of
  counting zero. The workbook's Run Summary separates "Reviewed jobs (this run)" from "Reviewed
  (last 90 days)", which is as far back as the stored day payloads go.
-  **Prescreen (two-step scoring).** Before the review budget, a light model (the Prescreen stage in
  Settings > Task assignments; default Codex with the registry's lightest ChatGPT model at low
  effort, or Claude Sonnet) scores every candidate 25 at a time from its title, company, location,
  role type, the first 1,500 characters of the description, and a compact digest of each resume
  track (about 1,200 characters of skills, project names, and numbers, extracted locally and cached
  as `resumes/{id}.digest.md`, rebuilt when the resume changes). The final review's model, rubric,
  and thresholds are unchanged. For the first `prescreen.shadowRuns` nights (default 3) nothing is
  dropped: Run Details and Status show how many final high matches the threshold would have lost
  (prescreen recall). After that the owner can enforce it from Settings (Pipeline tab): postings at
  or above `prescreen.threshold` (default 55) go on to the review budget ordered by prescreen score,
  and those below are marked seen (`prescreened_out`), never deferred, and listed in a folded Run
  Details list. A failed prescreen (login, limit, unreadable reply) keeps the local order and
  records a warning. Run Details and Status show the funnel (candidates → prescreened → passed →
  reviewed → matched) with usage per stage.
-  **Catch-up.** Postings held because the engine was unavailable (Claude signed out, a usage limit)
  never take the place of a run's own postings. Each run first reviews its new postings under the
  review budget below, then catches up the held ones in a lane of their own: at most
  `semanticMatching.catchUpBudget` per run (default 40, `0` for no limit, Settings → Pipeline),
  ranked the same way, and only while their posting date is at most 48 hours old; older ones expire
  unreviewed and are not caught up. With the prescreen on they are prescreened like any other
  posting first. Run Details lists the new and the catch-up reviews apart.
-  **Seen state.** `state/state.json` keeps one entry per posting URL (original and final), keyed by
  its hash, with only the first sighting and the retry or baseline fields; the postings themselves
  live in the day payloads. Entries older than 90 days (by their last attempt) are removed on every
  run, and Run Details shows the count. The first run with this format makes a full zip backup
  (`…-pre-seen-slim.zip` in the backup directory, never pruned automatically) before converting the
  old entries; `npm run restore -- <zip>` undoes it. The file is written compact.
-  **Review budget.** `semanticMatching.maxReviewedPerRun` (default 60, `0` for no limit) caps how
  many local candidates go to the engine per run. Freshness comes before completeness: tonight's
  postings (inside the lookback window) are always ranked ahead of the backlog, and local score with
  a small deferral bonus only reorders within those buckets. The surplus is deferred without being
  marked seen and stays eligible only while its posting date (first discovery only for postings
  without any date) is within `lookbackHours` plus `deferralGraceHours` (24 + 24 hours by default);
  older backlog expires unscored, and Run Details counts it. Settings → Pipeline "Include
  carried-over postings" (`semanticMatching.includeCarriedOver`, default on) turns the carrying off:
  the surplus is then left unreviewed instead of waiting for the next run (quota deferrals still
  wait). The report's main list holds every reviewed match of the day, date-only and undated
  postings included, in the chosen sort; the collection-time freshness rules (a precise time within
  24 hours, a date-only value to the end of its local day, new since the last board poll) decide
  what gets in, and nothing is rescored at render time. The former Settings → Pipeline "Strict
  24-Hour Window" switch and its folded "Date Only" group are gone (2026-11-15; a
  `semanticMatching.strict24HourWindow` left in config.json is ignored). A group with no postings is
  not shown. The page header is the one top row ("Sat, Nov 14 · 42 Jobs"); the run time and the main
  list's posting window ("posted within the last 24 hours") are in Run Details. Quota, signed-out,
  network, and integrity banners still show above the list. Buttons, group names, labels, table
  headers, and badges in the hub and the report are Title Case. When the in-window candidates exceed
  the budget three nights running, a warning and the Status Quota card say so and show the last
  seven nights of candidates against the budget. The same requisition listed on several career-site
  paths (Workday multi-site postings) becomes one card with alternate links and one review. Run
  Details states the real posting window of the main list.
-  **Chaos suite.** `npm run chaos` runs fourteen scenarios in temporary directories on every CI
  run, among them: baseline, every collector offline, subscription CLI unavailable, a corrupted
  `.eml`, an XLSX failure followed by recovery, an ATS board answering HTTP 500, the network
  dropping mid-run (an outage: retried once, nothing counted against the boards), more candidates
  than the review budget allows, a Fable weekly limit (the run steps down to Opus), an account-wide
  limit (everything deferred, banner shown), and a torn `state.json` (restored from its backup with
  a warning). Each must still leave the dated folder with an HTML report.

Cover-letter steps of the run are in [cover-letters.md](cover-letters.md); sources in
[sources.md](sources.md).

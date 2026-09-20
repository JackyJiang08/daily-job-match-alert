<div align="center">

# Daily Job Match Alert

**A nightly job-match agent for your Mac: it collects public internship and new-grad postings, scores each one against your resume tracks with the Claude or ChatGPT subscription you already pay for, and drafts one-page cover letters from a local hub. No API keys, no auto-apply.**

[![CI](https://github.com/JackyJiang08/daily-job-match-alert/actions/workflows/ci.yml/badge.svg)](https://github.com/JackyJiang08/daily-job-match-alert/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)

</div>

## What it does every night

At 20:00 (America/Chicago by default) a launchd job runs the pipeline once, unattended:

1. **Collect.** Postings arrive from public GitHub lists (SimplifyJobs, Jobright, vanshb03, Zapply, zshah101), the month's Hacker News "Who is hiring" thread, the RemoteOK feed, the public job-board APIs of Greenhouse, Lever, Ashby, and Workday tenants that earlier postings pointed at, and any `.eml` alert files dropped into `intake/eml`. Every board is polled once per night with a named user agent and conditional requests.
2. **Deduplicate.** URLs are canonicalized (tracking parameters stripped, redirects resolved) and checked against `state/state.json`, so a posting is reported once even when three sources list it.
3. **Fetch the description.** Board APIs deliver the full text directly; other links are fetched once, with Workday pages read through the tenant's public JSON endpoint. Unreachable pages are retried on later nights, refused or removed ones are closed. A posting whose own publish time is then known to the minute (a board API, a JSON-LD `datePosted` with a clock time) is held to the lookback window exactly and dropped without being marked seen when it falls outside; day-level sources (list ages, Workday's "Posted Yesterday") keep the lenient rule. Workday entity names such as `100000 Motorola Solutions, Inc.` are replaced by the list's or registry's company label, or cleaned when there is none, and the same cleaning is applied when older reports are rendered.
4. **Hard-filter.** Two facts are enforced in code, whatever the model says: the location must be in the United States (or unverifiable, which is flagged), and the graduation window in the posting must fit `preferences.graduationDate`.
5. **Score with your subscription.** Every remaining posting is reviewed against each enabled resume track by the Claude Code CLI or the Codex CLI, signed in with a claude.ai or ChatGPT subscription. Each track gets a 0–100 score with reasons and gaps; the best track is recommended.
6. **Write two files to the Desktop.** `~/Desktop/Daily Job Match Alert/<application date>/` receives a self-contained HTML shortlist (sortable, searchable, dark-mode, complete JD folded into each card) and an XLSX workbook with one score column per track. `warnings.txt` appears beside them only when something degraded. A card and the XLSX show a posting time only when the source gave one; day-level dates show the calendar day alone and say "date only" on hover and in the Notes sheet.

The evening run writes tomorrow's folder; a morning catch-up after a missed night fills today's. Reruns on the same date merge into that day's report instead of replacing it.

## Local hub

`npm run hub` serves `http://127.0.0.1:4747/`, loopback only, with no outbound requests of its own:

- **Reports** renders every stored day with the same components as the Desktop HTML, grouped by month with a Today shortcut, and links the Desktop copy and workbook.
- **Resumes** shows one card per resume track and accepts a replacement PDF, which tonight's run scores against; older versions are kept and can be reselected.
- **Letters** lists every generated cover letter (with its generation time and editor-note count) with Open and Download PDF. Each job card offers a one-click Generate Cover Letter: the letter is drafted with the recommended track and the cleaned company name, reviewed by the editor pass, rendered, and downloaded by the browser without leaving the page; the button then becomes Open Letter and Download PDF. One letter generates at a time, so the other cards' buttons wait, and a failure shows its reason on the card. Open Letter leads to the panel for editing the paragraphs, switching the track and regenerating, or rendering again.
  Company names go through one candidate chain (the list's name, the board registry label, the employer name the scorer read in the posting, the cleaned ATS entity, then the URL), each candidate validated so that legal words alone, tenant codes such as `US101`, and generic words never become a salutation. A posting with no usable name shows a "Company name uncertain" badge; its one-click button opens the panel to confirm the name first, and Save & Render refuses an unusable one. The editor pass flags "salutation says X, body says Y". Files are named `Prefix_Cover_Letter_Company.pdf`, with the prefix set under Settings (default from the signature: "Mary (Molly) Doe" gives `MollyDoe`), and Rename Company & Re-render replaces the salutation and the file without calling the model.
- **Status** shows the last and next run, the lock, a Sources table (every list and board with its last success, new postings, and a Resume Polling button for boards that went dormant), seven days of warnings, and a Run Now button.
- **Settings** exposes the match threshold, accepted match levels, the engine and model, the XLSX requirement, the hub port, the CLI connection state, and the private cover-letter material.

Cover letters are drafted by the same subscription engine from your playbook, up to three of your sample letters, the chosen resume, and the posting, then reviewed once by the engine as an editor, rendered to a one-page PDF (local Chrome, pdfkit fallback), and stored under `private/cover-letters/`. Your name, contact line, playbook, and samples live only under `private/cover-letter/`; the repository, docs, and tests contain placeholder people such as Jane Doe.

## Engines and billing

The only model access is through two local subscription CLIs, chosen by `semanticMatching.engine`:

| Engine | CLI | Sign-in that is accepted |
|---|---|---|
| `claude` (default) | Claude Code 2.1.250+ | `claude auth login --claudeai`; `claude auth status --json` must report a claude.ai subscription (`pro`, `max`, `team`, or `enterprise`) |
| `codex` | OpenAI Codex CLI | `codex login` with the ChatGPT option; `codex login status` must say "Logged in using ChatGPT" |

When the subscription itself is exhausted the run degrades by class instead of failing: a five-hour limit is waited out (ten-minute retries for up to 90 minutes, then the rest is deferred to the next run); a model's weekly limit steps down the configured ladder (`quotaPolicy.modelLadder`, default Fable then Opus) with an info line such as "scored by opus: fable weekly limit" instead of a mismatch warning, and the next run tries the preferred model again; an account-wide weekly limit defers every remaining posting, puts a banner with the expected reset time on the report, and can hand the run to Codex when `quotaPolicy.fallbackEngine` is `codex` and Codex is signed in. Cover letters follow the same ladder and offer Generate with Codex; the Status page has a Quota card. The CLI offers no usage query, so the classes are recognized from its refusal text with a configurable regex table recorded from the installed binary.

Both run as child processes with every `ANTHROPIC_*`, `AWS_*`, and `OPENAI_*` variable, plus the Bedrock, Vertex, and Google credential switches, removed from the environment, so neither can be steered to an API key or a gateway. There is no API client in the project. Console billing, API-key logins, wrong versions, and batch failures degrade to local keyword scores (labelled `unreviewed`) and a warning; they never fall back to an API. Subscription runs count against the plan's own limits. The model that actually scored each batch is read from the CLI output and recorded as `scoringModel`; a mismatch with the configured model is a warning, never a silent substitution.

## Privacy model

Everything personal stays on the Mac and outside Git:

- `config.json`, `resumes/*.md`, `resumes/*.pdf`, `intake/eml/*.eml`, `state/`, `private/`, logs, and generated reports are gitignored. The repository holds `config.example.json` and code only.
- Resume PDFs are hashed and re-extracted with `pdftotext` when they change; iCloud-evicted files are pulled back with `brctl download` before the run.
- The hub writes only `config.json` (surgically, under the run lock), `state/ats-boards.json` when you resume a board, and its own `private/` directory.
- Posting text is treated as untrusted input, including inside the model prompt. The engines are given a temporary read-only workspace and no tools.
- Nothing is submitted anywhere: no applications, no screening answers, no mailbox changes.

## Sources

| Source | How it is read | Basis | Status |
|---|---|---|---|
| SimplifyJobs Summer Internships and New Grad lists | The public README of each GitHub repository, fetched raw once per night | Public repositories maintained for exactly this purpose; postings link to employer sites | Enabled by default |
| Jobright lists (Data Analysis and Software Engineer, internship and new grad) | Raw README of the `jobright-ai/2026-*` repositories (the organization names its current cycle by graduation year; there is no ML & AI list) | Public repositories updated daily; each row links to a posting page with structured JobPosting data | Enabled by default (`sources.githubLists.lists.jobright*`) |
| vanshb03 Summer 2027 Internships and New Grad 2027 | Raw README, `dev` branch | Public repositories, last pushed within 30 days of 2026-09-18; rows link straight to employer ATS pages | Enabled by default (`sources.githubLists.lists.vansh*`) |
| Zapply Internships 2027, New Grad Jobs 2027, ML Internships 2027, New Grad Data Science 2027 | Raw README; each Apply link is a `zapply.jobs` redirect that the description fetch follows to the employer | Public repositories updated hourly | Enabled by default (`sources.githubLists.lists.zapply*`) |
| zshah101 Tech Internships 2027 (Summer 2027 and Fall 2026 tables) | Raw README | Public repository updated daily; rows link straight to employer ATS pages | Enabled by default (`sources.githubLists.lists.zshahTechInternships`) |
| Hacker News "Ask HN: Who is hiring?" | The public Algolia HN Search API: the newest thread by `whoishiring`, then its top-level posts; only posts mentioning intern, new grad, entry level, or junior are kept, and each card links to the post itself | Algolia's documented public API, no key; posts are public and written to be found | Enabled by default (`sources.hackerNewsHiring`) |
| RemoteOK | `GET remoteok.com/api` once per night with the configured user agent; only remote postings open to the United States with an early-career title or tag are kept | RemoteOK's published feed and its terms (user agent, follow link back to the posting, RemoteOK named as the source); `robots.txt` allows `/` with a one-second crawl delay | Enabled by default (`sources.remoteOk`) |
| Greenhouse boards | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` (full content, `updated_at`, ETag honoured) | Greenhouse's documented public Job Board API; no authentication | Discovered automatically, or listed in `sources.atsBoards.boards` |
| Lever boards | `GET api.lever.co/v0/postings/{company}?mode=json` (`createdAt`, ETag honoured) | Lever's documented public Postings API; no authentication | Same |
| Ashby boards | `GET api.ashbyhq.com/posting-api/job-board/{org}` (`publishedAt`) | Ashby's documented public Job Posting API; no authentication | Same |
| Workday career sites | `POST {tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`, 20 postings per page, pages walked only while they stay inside the lookback window; descriptions come from the per-posting CXS endpoint | The same unauthenticated JSON the public career page itself loads; read-only, one short walk per night, named user agent | Same |
| `.eml` files in `intake/eml` | Parsed locally every night | Files you place there yourself | Collector runs; nothing is routed to it yet |
| Himalaya mailbox folder | `himalaya` envelope list and `--preview` reads | Official alert email you subscribed to; the collector never marks, moves, or sends mail | Implemented, disabled (`sources.himalaya.enabled: false`) |
| career-ops scan history | A local TSV written by [career-ops](https://github.com/santifer/career-ops) | Your own local file | Optional (`sources.careerOps`) |

Every source has its own `enabled` switch under `sources`, and every new list, feed, or board starts with a baseline: its first collection marks only the postings older than the lookback window (and any without a date) as already seen, while postings inside the window go through the normal flow at once; a posting that another source listed the same night is never swallowed by a baseline. So switching a source on never floods a report and never hides a genuinely new posting. A list that answers 200 with no parsable rows raises a format-change warning; a failing source only produces a warning while the others continue; each source has a row under Run Details and on the Status page. A posting that several lists carry is reported once with every list named in its source line.

**How boards are discovered.** Every night the pipeline looks at the URLs it collected, recognizes Greenhouse, Lever, Ashby, and Workday postings, and records the board they belong to in `state/ats-boards.json` with the date and source that revealed it. You can add a board by hand (`{ "url": "https://job-boards.greenhouse.io/examplecorp" }` or a `greenhouse:` / `lever:` / `ashby:` / `workday:tenant/site` key) or switch one off with `"enabled": false`.

**First poll is a baseline.** The first time a board is polled, postings older than the lookback window are recorded as already seen and the in-window ones are scored; the counts are disclosed as an info line in `warnings.txt` and under Run Details. Every night only postings posted or updated inside the window are scored. Each board is polled at most once per night, requests share `network.concurrency` and `network.userAgent`, a failing board only produces a warning, a board with no new posting for 30 days is marked quiet and polled weekly until something new appears, and a board that fails seven nights in a row is marked dormant and skipped until you press Resume Polling on the Status page. Postings from boards show their source as `Greenhouse · Example Corp` and so on.

### Not integrated, and why

| Platform | Reason |
|---|---|
| LinkedIn, Indeed, Glassdoor, Handshake | Their terms of service prohibit automated access and scraping; they sit behind logins, rate limits, and bot detection, and offer no public unauthenticated feed |
| Wellfound, Work at a Startup | Postings are behind a login wall; reading them would require an account session, which the project never holds |
| Adzuna, USAJOBS | Their APIs require registering for an application key; the project runs with no keys of any kind |

If one of these ever offers a public, unauthenticated, terms-compliant feed, it fits the same collector pattern; until then, alert email from them is the only planned path, and only as a source of links.

## Reliability

The run is designed to leave a report even when parts of it fail:

- **Degrade, don't die.** A failing collector, board, page fetch, or model call becomes a `[stage / source] message` line in `warnings.txt`; the rest of the run continues. A fatal error before any report writes `ERROR-<date>.html` and a macOS notification.
- **Catch-up.** `state.lastSuccessfulRun` is recorded only when both the HTML and the XLSX exist. A login or boot start runs the catch-up path, which executes only when the last success is more than 26 hours old.
- **Lock.** `state/.lock` holds the owner PID; a second start exits cleanly, a stale lock from a dead process is removed.
- **Same-day accumulation.** `state/report-payload-<date>.json` holds everything reported for one application date; each run merges into it (a semantically reviewed copy beats a local one, a longer description beats a shorter one) and re-renders both files as `Daily update #N`. An incomplete day is rebuilt at the start of the next run.
- **Review budget.** `semanticMatching.maxReviewedPerRun` (default 120, `0` for no limit) caps how many local candidates go to the engine per run. The best local scores go first; the surplus is deferred without being marked seen, comes back the next night whatever its age, and jumps the queue once it has been deferred twice. Run Details and the Status page show candidates, reviewed, and deferred counts, and Settings exposes the limit.
- **Chaos suite.** `npm run chaos` runs nine scenarios in temporary directories on every CI run: baseline, every collector offline, subscription CLI unavailable, a corrupted `.eml`, an XLSX failure followed by recovery, an ATS board answering HTTP 500, more candidates than the review budget allows, a Fable weekly limit (the run steps down to Opus), and an account-wide limit (everything deferred, banner shown). Each must still leave the dated folder with an HTML report.

## Quick start

Requirements: macOS (Linux works for everything but launchd and iCloud recovery), Node.js 20+, `pdftotext`, and one signed-in subscription CLI.

```bash
git clone https://github.com/JackyJiang08/daily-job-match-alert.git
cd daily-job-match-alert
npm ci
cp config.example.json config.json
```

Edit `config.json`: point each entry of `resumes.tracks` at a private PDF (the example ships `data`, `llm`, and `agent`), set `preferences.graduationDate`, and pick the engine. Then:

```bash
claude auth login --claudeai      # or: codex login (ChatGPT option)
npm run resume:sync               # extract the resume text
npm test && npm run demo && npm run chaos
npm run run                       # one real run; check the Desktop folder
./scripts/install-launchd.sh 20 0 # nightly schedule (zsh)
./scripts/install-hub-launchd.sh  # keep the hub running; then open http://127.0.0.1:4747/
```

After pulling new code, run `npm run hub:restart`. [VERIFICATION.md](VERIFICATION.md) is the sign-off checklist, [SETUP.zh-CN.md](SETUP.zh-CN.md) the Chinese guide.

## Current limitations

- **No email channel yet.** The Himalaya collector exists but is disabled; nothing routes alert mail into `intake/eml`. Until that is set up, Handshake, Simplify, Wellfound, ZipRecruiter, and Jobright alerts are not ingested.
- **Login-walled platforms are not scraped.** Handshake, LinkedIn, Jobright, Wellfound, and similar sites forbid automated access in their terms and sit behind logins, MFA, and bot checks; the project only reads public, unauthenticated endpoints. When their alert email arrives one day, it will serve only as a link source, and the employer's public board becomes the posting of record.
- **Workday is best effort.** The CXS list endpoint is public but undocumented; if a tenant changes it, that board fails, warns, and eventually goes dormant while everything else continues.
- **Baseline delays a new board by one night.** A freshly discovered board contributes scored postings from its second poll on, by design.
- **Local scoring is triage only.** When no subscription CLI is available, `unreviewed` postings are ranked by keyword overlap and should be read as a rough list, not a judgment.
- **macOS first.** The schedule, notifications, iCloud recovery, and the hub's LaunchAgent assume macOS.

## Documentation

- [Chinese setup and source guide](SETUP.zh-CN.md)
- [Verification checklist](VERIFICATION.md)
- [Example configuration](config.example.json)
- [Contributing](CONTRIBUTING.md) and [Security policy](SECURITY.md)

## Acknowledgements

Daily Job Match Alert consumes the public lists maintained by [SimplifyJobs](https://github.com/SimplifyJobs), the public job-board APIs of Greenhouse, Lever, and Ashby, and pairs with [santifer/career-ops](https://github.com/santifer/career-ops). Those projects and companies are independent and keep their own licenses and trademarks.

## License

[MIT](LICENSE) © 2026 Mary (Molly) Doe

# Sources

Where postings come from, how each source is read, and why some job sites are not used. Every source
has its own switch under `sources` in config.json.

## Sources Read

-  **SimplifyJobs Summer Internships and New Grad lists**: How it is read: The public README of each
  GitHub repository, fetched raw once per night. Basis: Public repositories maintained for exactly
  this purpose; postings link to employer sites. Status: Enabled by default.
-  **Jobright lists (Data Analysis and Software Engineer, internship and new grad)**: How it is
  read: Raw README of the `jobright-ai/2026-*` repositories (the organization names its current
  cycle by graduation year; there is no ML & AI list). Basis: Public repositories updated daily;
  each row links to a posting page with structured JobPosting data. Status: Enabled by default
  (`sources.githubLists.lists.jobright*`).
-  **vanshb03 Summer 2027 Internships and New Grad 2027**: How it is read: Raw README, `dev` branch.
  Basis: Public repositories, last pushed within 30 days of 2026-09-18; rows link straight to
  employer ATS pages. Status: Enabled by default (`sources.githubLists.lists.vansh*`).
-  **Zapply Internships 2027, New Grad Jobs 2027, ML Internships 2027, New Grad Data Science 2027**:
  How it is read: Raw README; each Apply link is a `zapply.jobs` redirect that the description fetch
  follows to the employer. Basis: Public repositories updated hourly. Status: Enabled by default
  (`sources.githubLists.lists.zapply*`).
-  **zshah101 Tech Internships 2027 (Summer 2027 and Fall 2026 tables)**: How it is read: Raw
  README. Basis: Public repository updated daily; rows link straight to employer ATS pages. Status:
  Enabled by default (`sources.githubLists.lists.zshahTechInternships`).
-  **Hacker News "Ask HN: Who is hiring?"**: How it is read: The public Algolia HN Search API: the
  newest thread by `whoishiring`, then its top-level posts; only posts mentioning intern, new grad,
  entry level, or junior are kept, and each card links to the post itself. Basis: Algolia's
  documented public API, no key; posts are public and written to be found. Status: Enabled by
  default (`sources.hackerNewsHiring`).
-  **RemoteOK**: How it is read: `GET remoteok.com/api` once per night with the configured user
  agent; only remote postings open to the United States with an early-career title or tag are kept.
  Basis: RemoteOK's published feed and its terms (user agent, follow link back to the posting,
  RemoteOK named as the source); `robots.txt` allows `/` with a one-second crawl delay. Status:
  Enabled by default (`sources.remoteOk`).
-  **Greenhouse boards**: How it is read: `GET
  boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` (full content, `updated_at`, ETag
  honoured). Basis: Greenhouse's documented public Job Board API; no authentication. Status:
  Discovered automatically, or listed in `sources.atsBoards.boards`.
-  **Lever boards**: How it is read: `GET api.lever.co/v0/postings/{company}?mode=json`
  (`createdAt`, ETag honoured). Basis: Lever's documented public Postings API; no authentication.
  Status: Same.
-  **Ashby boards**: How it is read: `GET api.ashbyhq.com/posting-api/job-board/{org}`
  (`publishedAt`). Basis: Ashby's documented public Job Posting API; no authentication. Status:
  Same.
-  **Workday career sites**: How it is read: `POST
  {tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`, 20 postings per page, pages
  walked only while they stay inside the lookback window; descriptions come from the per-posting CXS
  endpoint. Basis: The same unauthenticated JSON the public career page itself loads; read-only, one
  short walk per night, named user agent. Status: Same.
-  **SmartRecruiters boards**: How it is read: `GET
  api.smartrecruiters.com/v1/companies/{company}/postings?country=us`, 100 per page, newest first,
  walked only inside the lookback window; descriptions from the per-posting detail endpoint. Basis:
  SmartRecruiters' public Posting API; no key. Status: Discovered, seeded, or found by search
  discovery.
-  **Search discovery (Brave or Tavily)**: How it is read: Up to `queriesPerRun` (12) web searches
  per night from a rotating query pool, United States, past day only. Basis: The provider's API with
  your own key in `private/search.json` (gitignored); a hard monthly cap keeps it inside the free
  tier. Status: Off by default (`sources.searchDiscovery`); without a key it does not run.
-  **`.eml` files in `intake/eml`**: How it is read: Parsed locally every night. Basis: Files you
  place there yourself. Status: Collector runs; nothing is routed to it yet.
-  **Himalaya mailbox folder**: How it is read: `himalaya` envelope list and `--preview` reads.
  Basis: Official alert email you subscribed to; the collector never marks, moves, or sends mail.
  Status: Implemented, disabled (`sources.himalaya.enabled: false`).
-  **career-ops scan history**: How it is read: A local TSV written by
  [career-ops](https://github.com/santifer/career-ops). Basis: Your own local file. Status: Optional
  (`sources.careerOps`).

Every source has its own `enabled` switch under `sources`, and every new list, feed, or board starts
with a baseline: its first collection marks only the postings older than the lookback window (and
any without a date) as already seen, while postings inside the window go through the normal flow at
once; a posting that another source listed the same night is never swallowed by a baseline. So
switching a source on never floods a report and never hides a genuinely new posting. A list that
answers 200 with no parsable rows raises a format-change warning; a failing source only produces a
warning while the others continue; each source has a row under Run Details and on the Status page. A
posting that several lists carry is reported once with every list named in its source line.

**How boards are discovered.** Every night the pipeline looks at the URLs it collected, recognizes
Greenhouse, Lever, Ashby, and Workday postings, and records the board they belong to in
`state/ats-boards.json` with the date and source that revealed it. You can add a board by hand (`{
"url": "https://job-boards.greenhouse.io/examplecorp" }` or a `greenhouse:` / `lever:` / `ashby:` /
`smartrecruiters:` / `workday:tenant/site` key) or switch one off with `"enabled": false`.

**Seeds.** `sources.atsBoards.seeds` adds company boards you know about: `{ "greenhouse": "<token>"
}`, `{ "lever": "<company>" }`, `{ "ashby": "<org>" }`, `{ "smartrecruiters": "<company>" }`, or `{
"workday": "<tenant>/<site>", "host": "<tenant>.wdN.myworkdayjobs.com" }` (the host is required
because the wdN data center cannot be guessed), each with an optional `company` label. A seed is
registered once with origin `seed` and then lives like a discovered board: baseline on the first
poll, quiet after 30 days, dormant after seven failures. Unlike `boards`, a seed never switches a
board back on.

**Search discovery.** `src/collectors/search-discovery.mjs`, off by default. Set
`sources.searchDiscovery.enabled`, pick `provider` (`brave`, sent as `X-Subscription-Token`, or
`tavily`), and put the key in `private/search.json` as `{ "brave": "<key>" }` or `{ "tavily": {
"apiKey": "<key>" } }`. The key goes into one request header only; it never appears in code, logs,
warnings, state, or reports (provider error text is scrubbed of it). Without a key the collector
does not run and records one info line. Each night takes `queriesPerRun` consecutive queries from
the pool (default: new grad data analyst 2027, entry level data scientist 2027, new graduate machine
learning engineer, data analyst I hiring 2027, junior data scientist remote, new grad business
analyst 2027, associate data engineer new grad, 2027 graduate data science program, entry level AI
engineer 2027), starting at the day of the year, restricted to the United States and the past day.
Every query is counted in `state/search-usage.json` before it is sent; at `monthlyQueryCap`
(default 400) the collector stops with a warning so the free tier is never exceeded. A result on
Greenhouse, Lever, Ashby, Workday, or SmartRecruiters registers that board (origin
`search_discovery`; a quiet board is polled that night) and its postings arrive through the board
API with full data. iCIMS pages and other employer pages become candidates: title and snippet face
the prefilter (title family required, job-board and listing pages dropped), then the usual baseline,
enrichment, and freshness rules. A result without `page_age` is an undated posting; it is never
stamped with the current time. When a list or board also carries the posting, the search copy is
dropped (`debug.searchDuplicates` in the run summary).

**First poll is a baseline.** The first time a board is polled, postings older than the lookback
window are recorded as already seen and the in-window ones are scored; the counts are disclosed as
an info line in `warnings.txt` and under Run Details. Every night only postings posted or updated
inside the window are scored. Each board is polled at most once per night, requests share
`network.concurrency` and `network.userAgent`, a failing board only produces a warning, a board with
no new posting for 30 days is marked quiet and polled weekly until something new appears, and a
board that fails seven nights in a row is marked dormant and skipped. Every 30 days (counted from
when it went dormant or from its last probe) the nightly run sends a dormant board one light request
(the list without descriptions, or a single posting); a board that answers resumes polling from the
next run with an info line in `warnings.txt`, and one that still fails stays dormant until the next
probe (one info line lists them). No probe is sent while this Mac's network is down. The Sources
table shows each dormant board's next probe and the last result, and Resume Polling still resumes
one at once. A failure names its cause (`fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND …)`,
`ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`, a certificate error, or the HTTP status) in the Status
column and in `warnings.txt`. **Local network outages.** When more than half of the boards polled in
a run fail without any HTTP answer, or the clock jumps by more than 5 minutes mid-run (the Mac
slept), the run treats it as this Mac's network, not the boards: it waits 60 seconds
(`sources.atsBoards.outageRetryDelaySeconds`) and polls the failed boards once more. Boards still
unreachable after that are not counted as failing, get no snapshot and no new last-success time, and
are polled again on the next run; the report header and `warnings.txt` say "This Mac's network
dropped while the job boards were being polled, so ATS sources are missing from this run", and a
macOS notification goes out. HTTP errors such as a 404 always count against the board. **Auto
catch-up.** Such a run, or one in which every network source failed, is recorded as incomplete in
`state/state.json`. Every 10 minutes the hub checks whether to redo it: Settings → Pipeline "Auto
catch-up after network outage" is on (default), the Mac has not slept since the previous check,
light requests to GitHub and Greenhouse both answer, and no run holds the lock. Then it starts the
same run as Run Now and posts "Network back, catching up tonight's run". At most two catch-ups per
day; a catch-up that collects clears the record, and once the next nightly run's time arrives that
run takes over. The Status page shows the incomplete run and the next check. Both the nightly run
and Run Now run under `caffeinate -i`, so the Mac does not idle-sleep mid-run (closing the lid on
battery still sleeps it). Postings from boards show their source as `Greenhouse · Example Corp` and
so on.

## Not Integrated, and Why

-  **LinkedIn, Indeed, Glassdoor, Handshake**: Their terms of service prohibit automated access and
  scraping; they sit behind logins, rate limits, and bot detection, and offer no public
  unauthenticated feed.
-  **Wellfound, Work at a Startup**: Postings are behind a login wall; reading them would require an
  account session, which the project never holds.
-  **Adzuna, USAJOBS**: Their APIs require registering for an application key; apart from the opt-in
  search key, the project runs with no keys.
-  **The Muse**: The public API answers without a key (500 requests per hour, checked 2026-10-09),
  but its terms require registering an app for any use, keyless access is described as for testing
  only, and results are relevance-ranked with no date sort or filter.

If one of these ever offers a public, unauthenticated, terms-compliant feed, it fits the same
collector pattern; until then, alert email from them is the only planned path, and only as a source
of links.

## Acknowledgements

Daily Job Match Alert consumes the public lists maintained by
[SimplifyJobs](https://github.com/SimplifyJobs), the public job-board APIs of Greenhouse, Lever, and
Ashby, and pairs with [santifer/career-ops](https://github.com/santifer/career-ops). Those projects
and companies are independent and keep their own licenses and trademarks.

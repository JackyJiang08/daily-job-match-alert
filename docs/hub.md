# Hub

The local web app at http://127.0.0.1:4747: reports, resumes, letters, status and settings. It
listens on this Mac only and makes no requests of its own.

## Pages

`npm run hub` serves `http://127.0.0.1:4747/`, loopback only, with no outbound requests of its own:

-  **Reports** renders every stored day with the same components as the Desktop HTML across the full
  width beside the navigation, and links the Desktop copy and workbook. Dates are chosen in the top
  row (below). The date controls and the sidebar read `state/reports-index.json` (match, deferred,
  carried-over, and letter counts per day, kept by the pipeline and by every letter save; built once
  from the payloads when missing) instead of the day payloads, a rendered day stays in memory until
  its payload, its letters, or the config change, a long Job Description carries its first 300
  characters and loads the rest when opened, pages are gzipped with an ETag (304 when unchanged),
  and the stylesheet and scripts are separate files cached for a year. Each report request logs its
  stage timings (index, payload, eligibility re-check, letter scan, render, sidebar, size) to the
  hub log and the Status page's Hub card.
-  **Resumes** shows one card per resume track and accepts a replacement PDF, which tonight's run
  scores against; older versions are kept and can be reselected.
-  **Status** reads only `state/reports-index.json` and `state/status-summary.json` (the newest
  run's fields, written after each run and letter save), never a day payload. It shows the last and
  next run, the lock, the Hub card (recent Reports and Status page timings and the render cache), a
  Sources table (every list and board with its last success, new postings, a Resume Polling button
  and the next 30-day probe for boards that went dormant), seven days of warnings, and a Run Now
  button.
-  **Settings** exposes the match threshold, accepted match levels, the engine and model, the XLSX
  requirement, the hub port, the CLI connection state, and the private cover-letter material.

## The Report Page

-  **The top row** is the only header: "‹ November 14, 2026 › · 42 Jobs" on the left (the date in
  full, in `timeZone`; "1 Job" in the singular), then search, sort, Track and Role Type; Freshness
  (Posted Today, New Since Last Poll, Carried Over, Undated), the score range, Hide Contacted (hub)
  and Clear Filters sit in the Filters popover, and the hub's Open Desktop Copy, Download XLSX,
  Generate Missing Letters and Update Salutations in the "⋯" menu. The row stays at the top of the
  content while the list scrolls, and never wraps at 1100px or wider: when it does not fit, Role
  Type and then Track move into the Filters popover (the date is never cut). ‹ and › (or the ← and →
  keys, unless a text field has focus) go to the previous or next report date that has matches,
  skipping days with 0 matches and days without a report, and are disabled at either end. Clicking
  the date opens a month picker (a bottom sheet at 760px and narrower; a click outside or Escape
  closes it): a Sunday-first grid with the match count under each day, days without a report grey
  and not clickable, days with 0 matches showing a light 0 and still clickable, today ringed and the
  date on view filled; ‹ and › at its top page through months that have reports, and Today at its
  foot opens today's report (or the newest one). The picker opens on the month on view and reads the
  same reports index, with no extra request. The URL stays `/reports/<date>`, the back and forward
  buttons work as usual, and the filters in the URL carry over to the date you move to (a Role Type
  or Track that date does not have stays selected and the list says nothing matches). The Desktop
  HTML holds one day and shows only "November 14, 2026 · 42 Jobs", with no ‹ › or picker; both use
  that text as the browser tab title. The hub's left navigation stays put beside it (one screen
  tall, from 761px up), with Last Run, Next Run, Plan, and Models in its bottom corner: one line
  each for Review, Prescreen, and CoverLetter naming the model that task would use now (the Settings
  → Subscriptions & Models assignment, or the fallback in effect when a weekly limit, a missing
  plan, a signed-out Claude, or a disconnected Codex rules the assigned one out; hover for why). The
  filters are kept in the page URL, so a refresh or a shared link opens the same view. Each card
  reads Company · Title with the track scores and the ring on the right; then location, role type
  and posting time ("Posted Nov 14, 3:12 PM" or "Posted Nov 14"; no Freshness tags), with "Check N
  Details" at the right end when the letter's editor left something to confirm (it opens the letter
  page); then Gaps / Verify, the folded Job Description with a copy icon (the whole JD as formatted
  text and as plain text with "• " list items, a tick for 1.5 seconds), the actions Open Posting,
  Download CoverLetter, Open CoverLetter, Message to Recruiters (Generate CoverLetter until a letter
  exists), and the source line. Date-only and undated postings sit in the main list with the rest;
  postings the review budget carried from an earlier run are grouped under "From Yesterday".

## First Run

A hub with no report yet shows three steps on the Reports page, Upload Resumes, Choose Roles and Run
Now, each with a button to the place where it is done (Resumes, Settings > Pipeline > Role Scope,
and the Run Now card on Status). A finished step is marked. Once any report exists the steps are
gone for good. Role Scope edits the title families, the target role families and the excluded title
words; saving writes `config.json` exactly as editing it by hand would (an unchanged default list is
not written).

## Corners

-  **Corners.** Every box with a border or a fill (cards, panels, popovers, the month picker, the
  Message to Recruiters drawer, settings groups, the Job Description box, logs, buttons, inputs,
  badges) takes its radius from five tokens in `src/report-theme.mjs`: 6px for badges and small icon
  buttons, 10px for buttons and inputs, 14px for the JD box, text blocks and highlighted list rows,
  20px for cards, panels and popovers, 28px for the drawer and the letter sheet, and 999px for
  capsules (the tags in Settings). A box inside another rounded box is concentric with it: its
  radius is the outer radius minus the space between them, never below 6px, written as a `calc()` of
  the tokens. Text stays clear of the corners (padding at least max(12px, 0.6 × radius) in a box, at
  least 0.8 × radius on either side of a button or tag); a box that scrolls sits inside a frame that
  carries the corners and clips, so neither the text nor the scrollbar reaches a corner. Where the
  browser supports `corner-shape` (Chrome and Edge 139 and later; not Safari 27.2 or Firefox),
  corners are drawn as continuous squircles with the radii scaled by 1.6, the factor at which a
  squircle cuts off about as much of a corner as the plain radius; elsewhere they are ordinary
  rounded corners. The score ring and the capsules stay round. Focus rings are outlines and follow
  the corner shape.

Letters and the letter page: [cover-letters.md](cover-letters.md). Message to Recruiters:
[outreach.md](outreach.md).

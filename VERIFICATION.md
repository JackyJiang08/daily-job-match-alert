# Final verification checklist

Use this list to sign off an unattended deployment. Items marked **owner** touch the real
`config.json`, the real Desktop output, or launchd, so they are run by the repository owner
only; automation never runs them.

Record the date and commit next to each item when it passes.

## Automated (safe to run anywhere)

- [ ] **Fresh clone builds and tests green**
  ```bash
  git clone https://github.com/JackyJiang08/daily-job-match-alert.git verify-clone
  cd verify-clone
  npm ci
  npm test
  ```
  Expected: `npm test` reports 0 failures.

- [ ] **Demo run writes HTML plus the xlsx with one score column per track**
  ```bash
  npm run demo
  ```
  Expected: `tests/fixtures/demo-output/2026-08-27/` contains
  `Daily Job Match Alert - 2026-08-27.html` and `Daily Job Match Alert - 2026-08-27.xlsx`.
  The demo config enables three resume tracks (Data, LLM, AI Agent), so the xlsx `Matches`
  sheet has exactly these 12 headers: Company, Title, Location, Role Type, Posted At,
  Data Score, LLM Score, AI Agent Score, Recommended Resume, Why It Matches, Gaps / Verify,
  Posting Link; the Posting Link cell is a clickable hyperlink; Run Summary shows
  `Resume tracks: Data, LLM, AI Agent` and `Scoring model: local_only`; the HTML header
  lists the same tracks and each card carries one score chip per track.

- [ ] **Track configurations are covered by tests**
  `tests/resume-tracks.test.mjs` runs the pipeline end to end with three tracks, one track,
  a disabled track (its profile is deleted and must not be read; it never appears in the
  reports), the legacy `resumes: { data, ai }` + `resumeSources` layout (migrated in memory
  with an upgrade notice), and an all-disabled list (fatal before any report is written).
  `tests/config.test.mjs` covers the normalization rules.

- [ ] **Chaos check passes all five scenarios**
  ```bash
  npm run chaos
  ```
  Expected summary: `5 passed, 0 failed` for `baseline`, `offline`, `llm-down`, `bad-input`,
  and `xlsx-recovery`. Every scenario runs against a temporary config, state, and output directory;
  nothing is written to the Desktop or to the real `state/`, and no subscription call is made.
  Use `npm run chaos -- --keep` to inspect the generated reports.

## Owner-only (real configuration, real Desktop, real schedule)

- [ ] **Manual `npm run run` produces the real nightly artifacts** (owner)
  ```bash
  claude auth status --json   # loggedIn: true, subscription auth, not an API key
  claude --version            # 2.1.250 or newer
  npm run run
  ```
  Expected: `~/Desktop/Daily Job Match Alert/<application date>/` contains the HTML and xlsx;
  the xlsx Run Summary `Scoring model` row and the HTML header show a `claude-fable-*` model;
  no `MODEL MISMATCH` warning; no `XLSX-FAILED.txt`.

- [ ] **launchd reinstalled and the next scheduled run succeeded** (owner)
  ```bash
  chmod +x scripts/run-launchd.sh scripts/install-launchd.sh
  ./scripts/install-launchd.sh 20 0
  launchctl print "gui/$(id -u)/com.dailyjobmatchalert.daily" | head -20
  ```
  Reinstalling replaces any older agent that still pointed at the legacy `run-daily.sh`
  runner and enables `RunAtLoad` catch-up. The next day, confirm that
  `state/logs/daily-YYYY-MM-DD.log` contains `launchd trigger: scheduled`, that
  `state/state.json` has a fresh `lastSuccessfulRun`, and that the next application-date
  folder appeared on the Desktop.

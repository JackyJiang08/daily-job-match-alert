# Configuration

Every setting that makes the hub yours, the subscription engines it uses, what stays private, and
the commands. `config.example.json` carries a note beside each block.

## Make It Yours

`npm run setup` asks for the facts below and writes `config.json` from `config.example.json`; it
never overwrites an existing file. Everything it writes can be changed later in the hub or in
`config.json`.

-  `timeZone`: Time zone for dates, the run date and the schedule shown in the hub. Default
  `America/Chicago`.
-  `outputDirectory`: Where the Desktop HTML and XLSX go. The example uses `~/Desktop/Daily Job
  Match Alert`; left out, `./daily-reports`.
-  `resumes.tracks`: One entry per resume: `id`, `label`, `pdf`, and optionally `keywords` (`{
  "title": [...], "skills": [...] }`) for the local pre-review score. Without `keywords`, the ids
  data, llm, agent and ai use built-in lists and any other id uses all of them.
-  `preferences.roleTypes`: `internship`, `new_grad`, `entry_level`.
-  `preferences.graduationDate`: YYYY-MM. Default 2027-05. Postings whose graduation window excludes
  it are dropped.
-  `preferences.homeState`: US state code; a posting there makes the letter say you are in state.
  `""` for none. Default `IL`.
-  `preferences.degree`: What the internship timeline says you are completing. Default `bachelor's
  degree`.
-  `preferences.plannedProgram`: Further study a letter may mention. `""` for none. Default `a
  master's program`.
-  `preferences.cohortYear`: The class a posting's "Class of" must name to count as new grad.
  Default 2027.
-  `preferences.titleFamilies`: Title words a board posting must contain (Settings > Pipeline > Role
  Scope).
-  `preferences.targetRoleFamilies`: Role families the scoring prompts treat as in scope (same
  place).
-  `preferences.excludeTitleTerms`: Title words that rule a posting out (same place).
-  `preferences.prefilterExcludeOverrides`: Phrases that lift the manager and level exclusions;
  include your class year.
-  `coverLetter.businessRoleTrack`: The track business analyst, operations, product, project and
  consulting roles take under the v2 letter rules; `null` for none. Default `data`.
-  `coverLetter.sampleTracks`: Track ids a sample letter can be tagged with. Default data, llm,
  agent.
-  `coverLetter.availability`: Full-time start, spring term, and where a master's plan may appear
  (v2 rules).
-  `private/cover-letter/profile.json`: Name, phone, email, signature and the company short-name
  table (Settings > Cover Letters).
-  `sources.searchDiscovery.queries`: The web-search query pool (off by default).
-  `hub.port`: The hub's port. Default 4747.

Each owner-specific key has a default equal to what the code did before it became a key, so a config
that leaves a key out behaves exactly as before. The schedule is not in `config.json`: it is the
LaunchAgent that `zsh scripts/install-launchd.sh <hour> <minute>` installs (default 18:00).

Without the wizard: copy `config.example.json` to `config.json`, point each entry of
`resumes.tracks` at a private PDF (the example ships `data`, `llm` and `agent`), set
`preferences.graduationDate` and the keys above, and pick the engine.

## Engines and Billing

The only model access is through two local subscription CLIs, chosen by `semanticMatching.engine`:
-  **`claude` (default)**: CLI: Claude Code 2.1.250+. Accepted sign-in: `claude auth
  login --claudeai`; `claude auth status --json` must report a claude.ai subscription (`pro`, `max`,
  `team`, or `enterprise`).
-  **`codex`**: CLI: OpenAI Codex CLI. Accepted sign-in: `codex login` with the ChatGPT option;
  `codex login status` must say "Logged in using ChatGPT".

When the subscription itself is exhausted the run degrades by class instead of failing: a five-hour
limit is waited out (ten-minute retries for up to 90 minutes, then the rest is deferred to the next
run); a model's weekly limit steps down the configured ladder (when the CLI's notice names no model,
such as "You're out of usage credits. Switch to another model", the same batch is first retried on
the next model: if it answers, the limit was the first model's own and is remembered until the reset
time the CLI gave; without one, until the weekly reset you can enter on the Claude card in Settings,
or else for 24 hours, after which the next run asks the preferred model once more (no reset date is
ever estimated or shown); only a second refusal counts as the account limit)
(`quotaPolicy.modelLadder`, default Fable then Opus) with an info line such as "scored by opus:
fable weekly limit" instead of a mismatch warning and no report banner when every posting was still
reviewed (the step down is a Run Details line); an account-wide weekly limit defers every remaining
posting, puts a banner on the report (with the reset time only when the CLI gave one), and can hand
the run to Codex when `quotaPolicy.fallbackEngine` is `codex` and Codex is signed in. Cover letters
follow the same ladder and offer Generate with Codex; the Status page has a Quota card. A signed-out
Claude is its own case, `auth_expired`, whether the run-start check finds it (`claude auth status`
reports `loggedIn: false` or `authMethod: none`, or the status command itself fails) or a call fails
mid-run ("Failed to authenticate", "OAuth session expired", "not logged in"). When Scoring's chain
ends with a ChatGPT model (`quotaPolicy.fallbackEngine` `codex`) and Codex is signed in, Codex
reviews the rest of the run; otherwise every posting not yet scored waits for the next run (never
marked unreviewed). Either way the report header says "Claude signed out", `warnings.txt` and the
Run Details give the reason, and the macOS notification "Claude is signed out. Run claude auth
login --claudeai" goes out. Once the login works again, the held postings are caught up after each
run's own postings (see Catch-up below). The hub checks the login every 10 minutes: when it finds
Claude signed out, the Status banner, the sidebar, and the Connections card say "Claude signed out",
and the same notification goes out at most once a day. In the hub the card and the panel say "Claude
is signed out. Run `claude auth login --claudeai` in Terminal, then try again." (with Generate with
Codex when Codex is signed in). Any other engine failure is shown as "Generation failed (reason);
details in the hub log"; raw CLI output never reaches a page. The CLI offers no usage query, so the
classes are recognized from its refusal text with a configurable regex table recorded from the
installed binary. The CLI's own wording for every limit event, with paths and any account
identifiers removed, is kept in `state/quota-notices.json` and shown on the Quota card so the
classification can be checked.

The models themselves come from one registry (`models.catalog`, defaulting to ids checked against
the installed CLIs: claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5 for
Claude; gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, and gpt-6-astra for Codex, with the
reasoning efforts `codex debug models` lists). Claude calls pass the registry alias (`--model
fable`), so the CLI picks the current release of that family; Codex models have no alias and get
their full id, and so does Haiku 5.5 (its entry is pinned: Claude Code 2.1.292 still resolves
`--model haiku` to claude-haiku-4-5, while `--model claude-haiku-5-5` answered as claude-haiku-5-5
on 2026-11-15). The full id the CLI actually ran is recorded from its usage report, and when it
differs from the registry id the model table says "New version: <id>". Settings shows two plan cards
side by side (connection, plan in large type with its source, auto or manual, a scheduled change
such as "Max · switches to Pro on Oct 26, 2026", CLI path and version, and seven days of usage),
each with a table of its models: full id, a colored status (Available, Not verified, Weekly limit
until the reset time, Not on plan, Unknown model), last use, the stages that use it, and a Test
button that sends one short prompt after confirmation (refused while a nightly run or a cover letter
is busy). A Model assignments table lists each stage (Scoring, Supplemental, Cover letter draft and
editor, and Prescreen) with its engine, model, Codex effort, and fallback chain, greying out a step
that is currently blocked. The Model Ladder is a reorderable list of Claude models. The ChatGPT plan
is read from `codex login status` or, when it prints none, decoded locally from the plan claim in
`~/.codex/auth.json`; no token is ever logged, stored, or shown.

The hub also knows which plan each subscription is on. The connection probes read the plan the CLIs
report (Claude's subscription type; Codex's account type when its status prints one), and the
sidebar, the Status Quota card, and the Settings engine choices show it. The nightly run remembers
the plan it saw; when it changes, a macOS notification says "Claude plan changed: max → pro. Review
the model ladder in Settings." and the Status page carries a banner with a Review Settings link
(with a hint to run `claude auth login --claudeai` when the login also looks expired, since a stale
session can masquerade as a plan change). Which models a plan can use is never assumed from a table:
when the CLI refuses a model ("not available on your plan", "requires a Max subscription", "model
not found"), that call steps down the ladder at once and the model is recorded in
`state/model-availability.json` with the plan and the time. Later calls, nightly and cover letters
alike, skip it until the plan changes or seven days pass, then try it once more. Settings shows such
models as "(unavailable on Pro)" and disabled, lists the marks beside the ladder, and a Re-check
Models button forgets them.

**Fable on Pro.** On the Pro plan Anthropic bills Fable to paid usage credits from the first call
instead of the plan's allowance, and this project runs on subscription allowances only. So whenever
the Claude plan in effect is Pro (the manual plan in Settings, a scheduled change once its date
arrives, or else the plan the CLI reports, also when it reports Pro at the start of a run), every
task skips Fable before any call: Review starts at Opus 5.5, the weekly-limit ladder starts at Opus,
and letter and prescreen chains drop it (a stage whose own model is Fable gives way to its first
fallback, or Opus). `config.json` is never rewritten: a task whose configured chain still names
Fable shows "Fable Uses Paid Credits On Pro" beside it in Settings → Subscriptions & Models → Task
Assignments (change the model or the chain there), the sidebar's Models line reads "Review ·
Opus 5.5" with the reason on hover, the run's Run Details carry one info line, and the Test button
refuses Fable. Back on Max, everything is as before.

Both run as child processes with every `ANTHROPIC_*`, `AWS_*`, and `OPENAI_*` variable, plus the
Bedrock, Vertex, and Google credential switches, removed from the environment, so neither can be
steered to an API key or a gateway. There is no API client in the project. Console billing, API-key
logins, wrong versions, and batch failures degrade to local keyword scores (labelled `unreviewed`)
and a warning; they never fall back to an API. A posting no model reviewed is never a match: it is
left out of the match list, the match count, and the xlsx Matches sheet, gets no automatic cover
letter, and appears instead in the report's folded "Not Reviewed (Engine Unavailable)" group (and an
xlsx "Not Reviewed" sheet), with a header line saying how many postings were not reviewed by a
model. Older reports that mixed such postings into their matches are shown the same way in the hub.
Subscription runs count against the plan's own limits. The model that actually scored each batch is
read from the CLI output and recorded as `scoringModel`; a mismatch with the configured model is a
warning, never a silent substitution.

## Privacy

Everything personal stays on the Mac and outside Git:

-  `config.json`, `resumes/*.md`, `resumes/*.pdf`, `intake/eml/*.eml`, `state/`, `private/`, logs,
  and generated reports are gitignored. The repository holds `config.example.json` and code only.
-  Resume PDFs are hashed and re-extracted with `pdftotext` when they change; iCloud-evicted files
  are pulled back with `brctl download` before the run.
-  The hub writes only `config.json` (surgically, under the run lock), `state/ats-boards.json` when
  you resume a board, and its own `private/` directory.
-  Posting text is treated as untrusted input, including inside the model prompt. The engines are
  given a temporary read-only workspace and no tools.
-  Nothing is submitted anywhere: no applications, no screening answers, no mailbox changes.

## Commands

```bash
npm run setup                       # first-run wizard; writes config.json and private/ files
npm run doctor                      # one line per check, with a fix for each failure
claude auth login --claudeai        # or: codex login (ChatGPT option)
npm run resume:sync                 # extract the resume text from the PDFs
npm run boards:probe -- --limit 20  # poll a few boards and print each result; saves nothing
npm run payloads:compact            # slim and gzip stored day payloads (-- --dry-run to preview)
npm run backup                      # zip private/, state/ and config.json
npm run restore -- <zip>            # write a backup back
npm test && npm run demo && npm run chaos
npm run run                         # one real run now; check the Desktop folder
zsh scripts/install-launchd.sh 18 0 # nightly schedule
zsh scripts/install-hub-launchd.sh  # keep the hub running
npm run hub:restart                 # after pulling new code
```

Requirements: macOS (Linux works for everything but launchd and iCloud recovery), Node.js 20+,
`pdftotext`, and one signed-in subscription CLI.

# Cover Letters

How letters are drafted, checked, stored and opened. Letters use your playbook, sample letters and
resume, and run on the same subscription CLIs as scoring.

## Writing a Letter

Cover letters are drafted by the same subscription engine from your playbook, up to three of your
sample letters, the chosen resume, and the posting, then reviewed once by the engine as an editor,
rendered to a one-page PDF (local Chrome, pdfkit fallback), and stored under
`private/cover-letters/`. Your name, contact line, playbook, and samples live only under
`private/cover-letter/`; the repository, docs, and tests contain placeholder people such as Jane
Doe.

## Letters Page and Letter Page

-  **Letters** lists every generated cover letter (with its generation time and editor-note count)
  with Open CoverLetter and Download CoverLetter. Each job card offers a one-click Generate
  CoverLetter: the letter is drafted with the recommended track and the cleaned company name,
  reviewed by the editor pass, rendered, and downloaded by the browser without leaving the page; the
  button then becomes Download CoverLetter and Open CoverLetter in place. One letter generates at a
  time, so the other cards' buttons wait, and a failure shows its reason on the card. Download
  CoverLetter is a direct `<a download>` link to the PDF (served as an attachment under the
  short-name file name; no new tab, no page in between). Open CoverLetter opens the letter in a new
  tab, so the report stays put for checking the JD. That page does one thing: it shows the whole
  letter laid out like the PDF and word for word the same (it is read from the saved letter.md the
  PDF was rendered from: name, contact line, date, salutation, body, "Sincerely," and the
  signature), with two buttons at the top right and nothing else (no navigation, notes list, or
  engine and version lines). **Copy** puts the whole letter on the clipboard as plain text (blocks
  separated by a blank line) and reads "Copied" for 1.5 seconds. **Regenerate** reads
  "Regenerating…" while it drafts, saves and renders a new letter for the same posting, track and
  short name, then swaps it in place; when it fails, one plain-language line appears under the
  buttons and the old letter (page and PDF) stays. Notes the editor flagged for checking underline
  the sentence they point at (hover for the note); notes that point at no sentence share one line
  above the letter ("+N More" expands on hover); notes on how the letter was made are not shown, and
  Copy never includes any mark. The old editor (track, short name, Rename Company & Re-render, Save
  & Render) stays at `/letters/<date>/<folder>/edit`; its one entry is **Edit Letter** at the right
  end of each row on the Letters page (job cards do not link it).

## Rules

-  **Letter rules** (Settings → Cover Letters → Letter Rules): `coverLetter.rulesVersion` chooses
  the letter rules. v1 (the default) keeps the rules from before 2026-11-08; v2 adds the
  availability window (`coverLetter.availability`: no term before the full-time date unless a spring
  term is allowed, and the master's plan only where enabled), the opening style (`openingStyle`), a
  candid paragraph for at most three core gaps, number and scenario checks against the selected
  resume, overused openings and closings to avoid, the DA resume for business-facing roles, and a
  one-page flow without B5 (a second condense to 450 words). Failed checks appear as "Check N
  Details" (orange until the letter page has been opened once, then grey) until you press Mark
  Details Checked; Regenerate replaces the letter and its notes, so the badge goes unless the new
  letter has notes of its own; a posting whose term starts too early shows Term Conflict and gets no
  automatic letter. Under v2, letters written within 12 hours of each other avoid each other's
  opening construction and closing, and the thank-you sentence that starts the closing rotates
  through six sentences, none above 30 percent of the last 7 days.
-  **Letter storage**: each letter lives in `private/cover-letters/<date>/<job ID>/` (folders from
  before 2026-11-09 are named after the company and move to the job ID folder when the letter is
  saved again). The PDF name stays `<Prefix>_Cover_Letter_<Company>.pdf`, so two postings of one
  company on one date keep two letters. `npm run letters:audit` (read only) lists postings whose
  letter an older company folder replaced.

## Company Names

Company names go through one candidate chain (the list's name, the board registry label, the
employer name the scorer read in the posting, the cleaned ATS entity, then the URL), each candidate
validated: a name printed by a list or feed is trusted unless it is empty, legal words only, or
shorter than two characters (so `3M`, `7-Eleven`, `Q2`, `S&P Global` pass), while names recovered
from an ATS entity or a URL also face the strict rules, so tenant codes such as `US101` and generic
words never become a salutation on their own. A posting with no usable name shows a "Company name
uncertain" badge; its one-click button opens the panel to confirm the name first, and Save & Render
refuses an unusable one. The editor pass flags "salutation says X, body says Y". Files are named
`Prefix_Cover_Letter_Company.pdf`, with the prefix set under Settings (default from the signature:
"Mary (Molly) Doe" gives `MollyDoe`), and Rename Company & Re-render replaces the salutation and the
file without calling the model.

-  **Company short names in letters.** The salutation ("Dear PwC Recruiting Team,"), the file name
  (`<Prefix>_Cover_Letter_PwC.pdf`, spaces and punctuation removed), and every mention in the body
  after the first use the company's short name. The draft call also returns `shortName`, the name
  the company most often uses for itself in the posting (PwC, HPE, P&G, Dow Jones, Toyota Material
  Handling); it is accepted only when it appears in the posting text or equals the cleaned company
  name, and has at most four words, so an abbreviation the posting never uses (J&J for Johnson &
  Johnson) falls back to the cleaned name. Cleaning always removes parentheses and Inc., LLC, and
  L.P.; Corporation, Corp., Company, Co., Group, Holdings, and a leading "The" go only when the
  posting itself writes the shorter name ("KLA Corporation" becomes KLA when the posting says KLA;
  "The Aerospace Corporation" and "Brain Co." stay whole when the posting writes only the full
  name). Settings → Cover Letters → Company Short Names holds an alias table (`Full Name = Short
  Name` per line) that wins over the model; a name typed in the letter panel wins over both. "Update
  Salutations" on a report date rewrites the salutation and file name of that date's saved letters
  and renders the PDFs again, without an engine call; the bodies are not changed. When the day's
  payload still holds the posting, it picks the name the JD uses most often among the cleaned name,
  the full name, and the company's abbreviations or brands in the JD (an acronym must spell the
  name's initials, as HPE or PwC do, or be a contraction such as FedEx or a known brand); the alias
  table and a manual rename still come first.
-  **Automatic cover letters.** After each run (and Run Now) the hub's cover-letter path writes
  letters for all of the run's new high matches, best scores first
  (`coverLetter.autoGenerate.maxPerRun`, default 0 = no limit; Settings can set one), skipping
  postings that already have a letter or whose company name is uncertain. The report is written and
  the run lock released first; letters follow under their own lock, on the Cover letter draft and
  editor assignments and their fallback chains. A posting whose whole chain fails (a limit, a login,
  an error) stops the pass with a warning; it and every posting the pass did not reach go to
  `state/letters-backlog.json`, and the next run or Run Now writes that queue first (entries leave
  once they have a letter or after 14 days). A report page also has **Generate Missing Letters**,
  which writes every high match of that date without a letter and with a trusted company in the
  background, under the same lock and stage assignments, for reports from before automatic letters
  existed. Cards show "Letter generating…" while it runs, then only Download PDF and Open Letter.
  Editor notes are sorted into needs review (a detail the resume and playbook do not support, a
  salutation that names another company than the body, a number the evidence does not carry) and
  info (engines, models, effort, fallbacks, dashes the editor replaced); a card carries a single
  "Check N Details" link at the end of its posting line (the items on hover; it opens the letter
  page, after which the link turns grey), only when something needs review, and the info notes
  appear in the letter page's footer. Run Details and the Status page report how many were written
  or failed, the engines, and the usage; Settings → Cover Letters turns it off or changes the limit.

## Starting Playbook

`cover-letter/playbook.example.md` is a generic playbook with no personal details. `npm run setup`
copies it to `private/cover-letter/playbook.md` when that file does not exist yet; edit the copy, or
upload your own under Settings > Cover Letters.

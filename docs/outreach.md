# Message to Recruiters

The panel that lists people at the company and the invitation and follow-up text for each. It never
visits or signs in to LinkedIn and never sends anything; you act in your own browser.

## Message to Recruiters

-  **Message to Recruiters** (named Reach Out before 2026-11-15; people list since 2026-11-16) is a
  button on every job card that opens a panel on the right without leaving the report. The hub never
  requests, fetches, or signs in to linkedin.com and never sends anything; it lists people and the
  text for each, and you act in your own browser. The panel holds three things. The top line is
  "Company — Title" with a close button. Below it, up to five people, one row each: the name in
  bold, the headline in grey on one line, a tag (In Posting, Recruiter, Team, or Alumni), ↗ to open
  the profile in a new tab, and a copy icon that copies the message for that person; after a copy
  the row fades with a check and the card shows "Contacted Nov 8". In Posting rows are the
  recruiters the JD itself names and always come first; the others come from the search API in
  `private/search.json` (the same Brave or Tavily key as Search Discovery), read only from its
  titles, snippets and links: one search each for recruiters (university, campus and early-career
  recruiters for internships and new-grad roles, technical recruiters otherwise), for team leads in
  the role's function or the team the JD names (with the city), and for alumni of your school (full
  name, the name without "at", and the short name, all OR-ed; the school comes from the resume
  digest or `outreach.profile.schools`, never from the code). People named as former, ex- or retired
  employees are dropped; at most two recruiters, two team rows and one alumnus are shown unless
  another kind runs short. Searches run only when you open the panel ("Finding People…" while they
  run), never at night, at most three per new company, and their results are kept for 30 days in
  `private/outreach/people-cache.json` (no key in it), so another posting at the same company costs
  nothing. They count against their own monthly cap (Settings → Cover Letters, People Search Monthly
  Cap, default 300, usage shown there), apart from Search Discovery's. Without a key, with the cap
  reached, when the search fails or times out, or when it finds no one, the people row is three
  buttons, Find Recruiters, Find Team and Find Alumni, that open the same searches on Google in a
  new tab. Last comes the message: the LinkedIn invitation note greeting the selected row ("Hi
  Jane,"; "Hi there," without a name; an Alumni row adds "Fellow <School> here." when it still
  fits), with a copy icon, a count such as "187 / 200" (the limit is set in Settings, default 200,
  up to 300), and a Follow-Up link that swaps in the message for after the invitation is accepted.
  Click a row to address the message to that person. Both texts are written in the same engine call
  as the cover letter (no extra call; the panel only changes the greeting); a posting without a
  letter can get them from the panel's Generate Messages. They follow the application-material
  rules: human and professional, no dashes as punctuation, no casual phrasing, and only facts from
  the resume and the scoring evidence. The panel's state is kept in `private/outreach/state.json`.

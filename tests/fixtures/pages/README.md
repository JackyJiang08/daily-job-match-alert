# Posting page fixtures

Synthetic pages for the Job Description extraction tests (`tests/jd-complete.test.mjs`). Each file imitates the
markup shape of one career-site host the pipeline met (container class names, meta tags, embedded JSON, or a
JavaScript shell with no description in the HTML); none is a captured page, and no test fetches anything. The
company is always Example Corp. `manifest.json` lists each file with the host it stands for and the expected
outcome: `page_body` or `embedded_json` (the full description is in the HTML and is extracted), or `incomplete`
(the HTML has only a summary or nothing, so the card links to the posting page instead).

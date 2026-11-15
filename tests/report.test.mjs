import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WARNINGS_FILE_NAME, buildHtml, buildReportView, cardView, jobBadges, mastheadSubtitle, readableDate, warningsFileText, writeReports, writeWarningsFile } from '../src/report.mjs';
import { dateWithOffset } from '../src/utils.mjs';

const job = {
  source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T10:00:00Z', discoveredAt: '2026-08-27T12:00:00Z',
  company: 'Acme, Inc.', title: 'Data & AI Analyst', location: 'Remote', scores: { data: 82, ai: 74 },
  bestScore: 82, recommendedTrack: 'data', recommendedResume: 'Data', reasons: ['SQL & Python'], gaps: ['Verify domain knowledge'], blockers: [],
  matchLevel: 'high', semanticReviewed: true, employmentType: 'FULL_TIME', salary: 'USD 90000–110000 YEAR',
  description: 'Use SQL, Python, and experimentation to help product teams make data-informed decisions.',
  url: 'https://example.com/jobs/1', freshnessBasis: 'jobposting_date_posted', enrichment: 'jobposting_json_ld',
};
const meta = { date: '2026-08-27', lookbackHours: 24 };

// The one top row's title: "Thu, Aug 27 · 1 Job".
function header(html) {
  return html.match(/<div class="bar-title">([\s\S]*?)<\/div>/)[1];
}
const JD_SUMMARY = /<details class="jd"><summary><span>Job Description<\/span><button type="button" class="jd-copy" aria-label="Copy Job Description" title="Copy Job Description"><svg [^>]*>[\s\S]*?<\/svg><\/button><\/summary>/;

test('HTML output escapes remote content, links the posting, and keeps the JD folded', () => {
  const html = buildHtml([{ ...job, title: '<script>alert(1)</script>', company: 'A "quoted" co' }], meta);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-search="a &quot;quoted&quot; co &lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(html, /<a class="apply" target="_blank" rel="noopener noreferrer" href="https:\/\/example\.com\/jobs\/1">Open Posting<\/a>/);
  assert.match(html, /<h2 class="job-title"><span class="company">A &quot;quoted&quot; co<\/span><span class="dot"> · <\/span><a target="_blank" rel="noopener noreferrer" href="https:\/\/example\.com\/jobs\/1">/);
  assert.equal((html.match(/<a /g) || []).length, (html.match(/<a (?:class="apply" )?target="_blank" rel="noopener noreferrer" href=/g) || []).length, 'every link opens in a new tab');
  assert.match(html, JD_SUMMARY, 'the fold carries the copy icon in its summary');
  assert.doesNotMatch(html, /Full Captured JD/);
  assert.doesNotMatch(html, /Pipeline warnings/);
  assert.doesNotMatch(html, /<link |src="http|https:\/\/cdn/);
});

test('the top row is one line: the short date and the job count on the left, no masthead above it', () => {
  assert.equal(readableDate('2026-09-11'), 'September 11, 2026');
  assert.equal(readableDate('not-a-date'), 'not-a-date');
  const nine = buildHtml(Array.from({ length: 9 }, (_, index) => ({ ...job, url: `https://example.com/jobs/${index}` })), { ...meta, date: '2026-09-11' });
  assert.equal(header(nine), '<span class="bar-date">Fri, Sep 11</span><span class="sep">·</span><span class="count" id="count">9 Jobs</span>');
  assert.match(nine, /<title>Daily Job Match Alert — September 11, 2026<\/title>/);
  assert.equal(header(buildHtml([job], meta)), '<span class="bar-date">Thu, Aug 27</span><span class="sep">·</span><span class="count" id="count">1 Job</span>');
  assert.equal(header(buildHtml([], meta)), '<span class="bar-date">Thu, Aug 27</span><span class="sep">·</span><span class="count" id="count">0 Jobs</span>');
  assert.doesNotMatch(nine, /<header class="masthead"|<h1[ >]|Matches · Ran|linear-gradient/);
  assert.match(nine, /<div class="bar-sentinel" id="bar-sentinel" aria-hidden="true"><\/div><form class="toolbar" id="toolbar" autocomplete="off">\s*<div class="bar-title">/, 'the bar is the first thing on the page, after its sticky sentinel');
  assert.match(nine, /IntersectionObserver[\s\S]*classList\.toggle\('stuck'/, 'the script marks the bar once it is stuck');
  assert.doesNotMatch(header(nine), /scored by|Resume tracks|excluded/);
});

test('run metadata lives only in the collapsed Run details block, including the excluded postings', () => {
  const html = buildHtml([{ ...job, matchLevel: 'unreviewed', scoringEngine: 'local_fallback' }, { ...job, url: 'https://example.com/jobs/2' }], {
    ...meta,
    runDate: '2026-08-26',
    timeZone: 'America/Chicago',
    scoringModel: 'claude-fable-5',
    resumeTracks: [{ id: 'data', label: 'Data' }, { id: 'ai', label: 'AI' }],
    minimumMatchScore: 70,
    collectedCount: 12,
    reviewedCount: 7,
    eligibilityExclusions: { location: 2, graduation: 1 },
    excludedPostings: ['Globex — Data Analyst (Toronto): location outside the United States', 'Initech — BI Intern: Class of 2026 only'],
    runsToday: 2,
    lastUpdatedAt: '2026-08-27T13:30:00Z',
    resumeSync: { recovered: ['data'] },
    warnings: [{ stage: 'collector', source: 'Job board', message: 'network unavailable' }, { stage: 'llm', source: 'claude_subscription', message: 'batch fallback' }],
  });
  const details = html.match(/<details class="run" id="run-details"><summary>Run Details<\/summary>([\s\S]*?)<\/details>/)[1];
  assert.ok(details, 'Run details block is missing');
  assert.doesNotMatch(html, /<details class="run"[^>]*\bopen\b/, 'Run details must be collapsed by default');
  assert.match(details, /<dt>Report Date<\/dt><dd>August 27, 2026 \(run on August 26, 2026\)<\/dd>/);
  assert.match(details, /<dt>Lookback Window<\/dt><dd>24 hours<\/dd>/);
  assert.match(details, /<dt>Scoring Model<\/dt><dd>claude-fable-5<\/dd>/);
  assert.match(details, /<dt>Resume Tracks<\/dt><dd>Data, AI<\/dd>/);
  assert.match(details, /<dt>Minimum Score<\/dt><dd>70<\/dd>/);
  assert.match(details, /<dt>Postings<\/dt><dd>12 collected · 7 reviewed · 1 matched<\/dd>/, 'the posting no model reviewed is not a match');
  assert.match(details, /<dt>Hard Filter<\/dt><dd>3 excluded: 2 outside the United States, 1 outside the graduation window<ul><li>Globex — Data Analyst \(Toronto\): location outside the United States<\/li><li>Initech — BI Intern: Class of 2026 only<\/li><\/ul><\/dd>/);
  assert.match(details, /<dt>Updates Today<\/dt><dd>Daily update #2 · last updated Aug 27, 2026, 8:30 AM<\/dd>/);
  assert.doesNotMatch(html, /\bUTC\b/);
  assert.match(details, /<dt>Status<\/dt><dd>1 posting was not reviewed by a model \(engine unavailable\); they are listed under Not Reviewed \(Engine Unavailable\), not among the matches<ul><li>Resume PDF\(s\) recovered from iCloud before this run: data<\/li><li>2 pipeline warning\(s\), see warnings\.txt beside this file<\/li><\/ul><\/dd>/);
  // The warning lines themselves never reach the page.
  assert.doesNotMatch(html, /network unavailable|batch fallback|Pipeline warnings/);
  // Outside the block, none of the run metadata appears.
  const outside = html.replace(details, '');
  assert.doesNotMatch(outside, /claude-fable-5|Lookback|Daily update|excluded|Toronto/);
});

test('the run time stays out of the top row (Run Details has it); mastheadSubtitle is kept for the Status summary', () => {
  const ran = { ...meta, timeZone: 'America/Chicago', completedAt: '2026-09-13T01:00:00Z', trigger: 'scheduled', runsToday: 1, lastUpdatedAt: '2026-09-13T01:00:00Z' };
  const html = buildHtml([job], { ...ran, date: '2026-09-13' });
  assert.equal(header(html), '<span class="bar-date">Sun, Sep 13</span><span class="sep">·</span><span class="count" id="count">1 Job</span>');
  // A folder from before 2026-11 (the evening run wrote the next day's report) keeps the run's date in the summary line.
  assert.equal(mastheadSubtitle([job], { ...ran, date: '2026-09-13' }), '1 Match · Ran Sep 12, 8:00 PM');
  // A run on the report's own day shows the time alone.
  assert.equal(mastheadSubtitle([job], { ...ran, date: '2026-09-12' }), '1 Match · Ran 8:00 PM');
  assert.match(html, /<dt>Posting Window<\/dt><dd>Main List: posted within the last 17 days<\/dd>/, 'the posting window moved to Run Details');
  assert.match(html, /<dt>Trigger<\/dt><dd>scheduled<\/dd>/);
  assert.match(buildHtml([job], { ...ran, engine: 'codex', scoringModel: 'gpt-5.6-sol' }), /<dt>Engine<\/dt><dd>codex<\/dd>/);
  assert.doesNotMatch(html, /\bUTC\b/);
  const embedded = buildReportView([job], { ...ran, date: '2026-09-13' }, { embedded: true });
  assert.equal(embedded.masthead, undefined, 'no masthead view any more');
  assert.deepEqual({ title: embedded.toolbar.title, total: embedded.toolbar.total, menuSlot: embedded.toolbar.menuSlot, quotaNote: embedded.quotaNote }, { title: 'Sun, Sep 13', total: 1, menuSlot: true, quotaNote: null }, 'the hub view gets the menu slot; no quota event, no quota line');
  assert.equal(buildReportView([job], meta).toolbar.menuSlot, false, 'the Desktop file has no menu slot');
  // Older payloads without completedAt fall back to lastUpdatedAt.
  assert.equal(mastheadSubtitle([], { date: '2026-08-27', timeZone: 'America/Chicago', lastUpdatedAt: '2026-08-27T13:30:00Z' }), 'No Matches · Ran 8:30 AM');
});

test('card locations are normalized at render time so historical payloads read correctly', () => {
  const tracks = [{ id: 'data', label: 'Data' }];
  assert.equal(cardView({ ...job, location: 'Boston, MA Johnston, RI Columbus, OH' }, tracks).location, 'Boston, MA · Johnston, RI · Columbus, OH');
  assert.equal(cardView({ ...job, location: '3 locations Boston, MA Remote' }, tracks).location, 'Boston, MA · Remote');
  assert.equal(cardView({ ...job, location: '' }, tracks).location, 'Location not stated');
  const html = buildHtml([{ ...job, location: 'Boston, MA Johnston, RI' }], meta);
  assert.match(html, /<span class="company">Acme, Inc\.<\/span>[\s\S]*?<p class="job-meta"><span>Boston, MA · Johnston, RI<\/span><span class="sep">·<\/span><span>New Grad<\/span>/);
});

test('the empty state uses the same layout and hides the run status behind the same block', () => {
  const html = buildHtml([], { ...meta, scoringModel: 'local_only', warnings: [] });
  assert.match(html, /<div class="empty">No new postings cleared the configured threshold for this date\.<\/div>/);
  assert.match(html, /<form class="toolbar" id="toolbar"/, 'the bar is the same with no jobs');
  assert.match(html, /<details class="run" id="run-details">/);
  assert.match(html, /<dt>Status<\/dt><dd>No pipeline warnings<\/dd>/);
  assert.doesNotMatch(html, /id="jobs"/);
});

test('cards carry the 60px ring, one score line per track with the top one marked, no recommendation text, and sortable data attributes', () => {
  const tracks = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }, { id: 'agent', label: 'AI Agent' }];
  const threeTrack = { ...job, scores: { data: 74, llm: 87, agent: 85 }, bestScore: 87, recommendedTrack: 'llm', recommendedResume: 'LLM', reasons: ['one', 'two', 'three', 'four'], gaps: ['a', 'b', 'c'] };
  const html = buildHtml([threeTrack], { ...meta, resumeTracks: tracks });
  assert.match(html, /<article class="job" data-score="87" data-company="acme, inc\." data-posted="\d+" data-role="new_grad" data-track="llm" data-search="acme, inc\. data &amp; ai analyst" data-freshness="posted-today">/);
  assert.match(html, /<div class="ring" style="--score:87" role="img" aria-label="Best score 87"><b>87<\/b><\/div>/);
  assert.match(html, /<h2 class="job-title"><span class="company">Acme, Inc\.<\/span><span class="dot"> · <\/span><a target="_blank" rel="noopener noreferrer" href="https:\/\/example\.com\/jobs\/1">Data &amp; AI Analyst<\/a><\/h2>/);
  assert.match(html, /<p class="job-meta"><span>Remote<\/span><span class="sep">·<\/span><span>New Grad<\/span><span class="sep">·<\/span><span class="meta"[^>]*>Posted Aug 27, 5:00 AM<\/span><\/p>/, 'the posting time alone: no Freshness tag');
  assert.doesNotMatch(html, /badge fresh|data-badge="freshness"/);
  assert.match(html, /<div class="scores"><span class="track" data-track="data">Data <b>74<\/b><\/span><span class="track top" data-track="llm">LLM <b>87<\/b><\/span><span class="track" data-track="agent">AI Agent <b>85<\/b><\/span><\/div>/, 'one line per track, the highest marked');
  assert.match(html, /<div class="job-score"><div class="scores">[\s\S]*?<\/div><div class="ring"/, 'scores then the ring; no recommendation line');
  assert.doesNotMatch(html, /class="recommend"|Apply with|No Resume Recommended/);
  assert.match(html, /\.ring\{[^}]*width:60px;height:60px/);
  assert.match(html, /\.ring b\{[^}]*font-size:var\(--fs-title\)/);
  assert.match(html, /\.scores\{[^}]*flex-direction:column;align-items:flex-end[^}]*font-variant-numeric:tabular-nums/);
  assert.match(html, /\.scores \.track\.top\{color:var\(--ink\);font-weight:600\}/);
  // A tie marks every holder.
  const tied = buildHtml([{ ...threeTrack, scores: { data: 87, llm: 87, agent: 85 } }], { ...meta, resumeTracks: tracks });
  assert.match(tied, /<span class="track top" data-track="data">Data <b>87<\/b><\/span><span class="track top" data-track="llm">LLM <b>87<\/b><\/span><span class="track" data-track="agent">AI Agent <b>85<\/b><\/span>/);
  // Why It Matches stays in the payload for cover letters and is not shown; Gaps / Verify shows every item.
  assert.doesNotMatch(html, /Why It Matches|class="facts reasons"|<li>one<\/li>/);
  assert.match(html, /<div class="facts-label">Gaps \/ Verify<\/div><ul class="facts gaps"><li>a<\/li><li>b<\/li><li>c<\/li><\/ul>/);
  assert.doesNotMatch(html, /<details class="more">/);
  assert.match(html, /<span class="meta" title="Posted Aug 27, 2026, 5:00 AM">Posted Aug 27, 5:00 AM<\/span>/, 'a JSON-LD datePosted with a clock time is precise and shows the local time');
  const dayOnly = buildHtml([{ ...job, postedAt: '2026-08-27T00:00:00.000Z' }], { ...meta, timeZone: 'America/Chicago' });
  assert.match(dayOnly, /<span class="meta" title="Date only: the source reports no time of day">Posted Aug 27<\/span><\/p>/, 'a bare-date datePosted (stored as UTC midnight by older versions) shows the day it names; "date only" stays in the hover title');
  assert.doesNotMatch(dayOnly, /Date Only|\(date only\)</);
  const found = buildHtml([{ ...job, postedAt: null, discoveredAt: '2026-09-13T01:30:00Z' }], { ...meta, timeZone: 'America/Chicago' });
  assert.match(found, /<span class="meta" title="The source reports no posting date; the day shown is when this pipeline first found it">Posted Unknown \(found Sep 12\)<\/span><\/p>/);
  assert.doesNotMatch(found, /Discovered|Found Sep/);
  assert.doesNotMatch(html, /Match level:|Use LLM|Apply with LLM resume/);

  const multi = buildHtml([{ ...job, location: 'Boston, MA · Johnston, RI · Columbus, OH' }], meta);
  assert.match(multi, /<p class="job-meta"><span>Boston, MA · Johnston, RI · Columbus, OH<\/span><span class="sep">·<\/span><span>New Grad<\/span>/);

  const single = buildHtml([{ ...job, scores: { data: 82 } }], { ...meta, resumeTracks: [{ id: 'data', label: 'Data' }] });
  assert.match(single, /<div class="scores"><span class="track top" data-track="data">Data <b>82<\/b><\/span><\/div>/);

  const legacy = buildHtml([{ ...job, scores: undefined, dataScore: 82, aiScore: 74 }], meta);
  assert.match(legacy, /<span class="track top" data-track="data">Data <b>82<\/b><\/span><span class="track" data-track="ai">AI <b>74<\/b><\/span>/);
});

test('the top row offers search, sort, Track and Role Type; Freshness, the score range and Clear Filters sit in the Filters popover', () => {
  const tracks = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }];
  const many = Array.from({ length: 5 }, (_, index) => ({ ...job, url: `https://example.com/jobs/${index}`, roleType: index % 2 ? 'internship' : 'new_grad' }));
  const html = buildHtml(many, { ...meta, resumeTracks: tracks });
  assert.match(html, /<form class="toolbar" id="toolbar" autocomplete="off">/);
  assert.match(html, /<input type="search" id="q" placeholder="Search company or title"/);
  assert.match(html, /<select id="sort" class="control" aria-label="Sort by"><option value="score" selected>Best Score<\/option><option value="company">Company<\/option><option value="posted">Posted Time<\/option><\/select>/);
  assert.match(html, /<select id="role" class="control" aria-label="Role type"><option value="">All Role Types<\/option><option value="new_grad">New Grad<\/option><option value="internship">Internship<\/option><\/select>/);
  assert.match(html, /<select id="track" class="control" aria-label="Track"><option value="">All Tracks<\/option><option value="data">Data<\/option><option value="llm">LLM<\/option><\/select>/);
  assert.doesNotMatch(html, /Sort: |Data resume<\/option>|All role types|All resumes|All Resumes|<span>Resume<\/span>|<span>Sort by<\/span>/);
  assert.match(html, /<details class="menu" id="filters-menu"><summary class="btn secondary" id="filters-button">Filters<\/summary><div class="menu-list">\s*<label class="control"><span>Freshness<\/span><select id="fresh">[\s\S]*?<span class="control score-range">[\s\S]*?<button type="button" class="btn secondary" id="clear-filters" hidden>Clear Filters<\/button>\s*<\/div><\/details>/);
  assert.doesNotMatch(html, /<!--menu-->/, 'the Desktop file has no hub menu slot');
  assert.match(html, /<span class="count" id="count">5 Jobs<\/span>/);
  assert.match(html, /@media \(min-width:1100px\)\{\.toolbar\{flex-wrap:nowrap\}\}/, 'one line from 1100px');
  assert.match(html, /<div class="empty" id="no-results" hidden>/);
  assert.match(html, /<script>[\s\S]*querySelectorAll\('section\.jobs'\)[\s\S]*localeCompare[\s\S]*<\/script>/);
  assert.doesNotMatch(html, /<script src=/);

  const few = buildHtml(many.slice(0, 4), { ...meta, resumeTracks: tracks });
  assert.match(few, /<form class="toolbar" id="toolbar"/, 'no quiet mode: the bar is the page header');
  assert.doesNotMatch(few, /toolbar quiet/);
});

test('semantic markers render as badges instead of text prefixes', () => {
  assert.deepEqual(jobBadges(job), []);
  assert.deepEqual(jobBadges({ ...job, matchLevel: 'unreviewed', scoringEngine: 'local_fallback' }).map(badge => badge.key), ['unreviewed']);
  assert.deepEqual(jobBadges({ ...job, matchLevel: 'medium' }).map(badge => badge.label), ['Match: medium']);
  assert.deepEqual(jobBadges({ ...job, eligibility: { location: { verdict: 'unverified' } } }).map(badge => badge.key), ['location-unverified']);
  assert.deepEqual(jobBadges({ ...job, enrichment: 'failed', enrichmentReason: 'login_wall' }).map(badge => [badge.key, badge.tone]), [['login_wall', 'warn']]);
  assert.deepEqual(jobBadges({ ...job, enrichment: 'failed', enrichmentReason: 'blocked' }).map(badge => badge.label), ['Fetch Blocked']);
  assert.deepEqual(jobBadges({ ...job, enrichment: 'failed' }).map(badge => badge.label), ['JD Not Fetched']);
  assert.deepEqual(jobBadges({ ...job, enrichment: undefined, source: 'Handshake email alert' }).map(badge => badge.key), ['email-only']);
  assert.deepEqual(jobBadges({ ...job, badges: ['Referral available', { key: 'hot', label: 'Hot', tone: 'bad' }] }).map(badge => badge.key), ['referral-available', 'hot']);

  const html = buildHtml([{ ...job, matchLevel: 'unreviewed', scoringEngine: 'local_fallback', location: 'Remote', gaps: ['Location unverified — confirm US eligibility'], eligibility: { location: { verdict: 'unverified', marker: null }, exclusion: null } }], meta);
  assert.match(html, /<div class="badges"><span class="badge badge-warn" data-badge="unreviewed" title="[^"]+">Unreviewed<\/span><span class="badge" data-badge="location-unverified" title="The posting does not state a US location; confirm you can work from the United States before applying">US Location Not Stated<\/span><\/div>/);
  assert.match(html, /US location not stated: confirm you can work from the United States/, 'an older payload\'s gap reads with the new wording');
  assert.doesNotMatch(html, /\[unreviewed\]|Match level:/);
  const clean = buildHtml([job], meta);
  assert.doesNotMatch(clean, /<div class="badges">/);
});

test('the stylesheet defines the token set, dark mode, and a single-column mobile layout', () => {
  const html = buildHtml([job], meta);
  for (const token of ['--fs-page', '--fs-title', '--fs-body', '--fs-meta', '--accent', '--ink', '--ink-2', '--ink-3', '--line', '--radius', '--space-4', '--font']) {
    assert.match(html, new RegExp(`${token}:`), `missing token ${token}`);
  }
  assert.match(html, /@media \(prefers-color-scheme: dark\)\{:root\{/);
  assert.match(html, /@media \(max-width:640px\)/);
  assert.match(html, /color-scheme: light dark/);
  assert.equal((html.match(/<style>/g) || []).length, 1);
});

test('uses the next Central Time calendar date for the application folder', () => {
  assert.equal(dateWithOffset(new Date('2026-08-28T01:00:00Z'), 'America/Chicago', 1), '2026-08-28');
});

test('writes the HTML plus warnings.txt only when there are warnings, and removes a stale one', async () => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'report-output-test-'));
  const date = '2026-08-28';
  const runDirectory = path.join(outputDirectory, date);
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, 'latest.html'), 'legacy');
  await fs.writeFile(path.join(runDirectory, 'daily-job-match-alert.csv'), 'legacy');
  try {
    const warnings = [
      { stage: 'collector', source: 'SimplifyJobs New Grad', message: 'network unavailable' },
      { stage: 'resume', source: 'Data resume', message: 'Data 简历曾被 iCloud 云端化，已自动取回', level: 'info' },
    ];
    const withWarnings = await writeReports([job], [job], { date, applicationDate: date, lookbackHours: 24, warnings }, outputDirectory);
    assert.deepEqual((await fs.readdir(runDirectory)).sort(), [`Daily Job Match Alert - ${date}.html`, WARNINGS_FILE_NAME]);
    assert.equal(withWarnings.warningsPath, path.join(runDirectory, WARNINGS_FILE_NAME));
    const text = await fs.readFile(withWarnings.warningsPath, 'utf8');
    assert.equal(text, [
      'Daily Job Match Alert — 2026-08-28 — 2 warnings',
      '[collector / SimplifyJobs New Grad] network unavailable',
      '[resume / Data resume] info: Data 简历曾被 iCloud 云端化，已自动取回',
      '',
    ].join('\n'));
    assert.equal(warningsFileText({ date, warnings: warnings.slice(0, 1) }), 'Daily Job Match Alert — 2026-08-28 — 1 warning\n[collector / SimplifyJobs New Grad] network unavailable\n');
    const html = await fs.readFile(withWarnings.htmlPath, 'utf8');
    assert.doesNotMatch(html, /network unavailable|Pipeline warnings|class="warnings"/);
    assert.match(html, /2 pipeline warning\(s\), see warnings\.txt beside this file/);
    assert.equal(await fs.stat(withWarnings.payloadPath).then(() => true), true);
    await assert.rejects(fs.access(path.join(outputDirectory, 'latest.html')));
    await fs.rm(withWarnings.temporaryDirectory, { recursive: true, force: true });

    // A rerun of the same day without warnings must remove the stale file.
    const clean = await writeReports([job], [job], { date, applicationDate: date, lookbackHours: 24, warnings: [] }, outputDirectory);
    assert.equal(clean.warningsPath, null);
    assert.deepEqual(await fs.readdir(runDirectory), [`Daily Job Match Alert - ${date}.html`]);
    await fs.rm(clean.temporaryDirectory, { recursive: true, force: true });
    assert.equal(await writeWarningsFile(runDirectory, { date }), null);
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
});

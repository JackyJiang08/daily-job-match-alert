import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WARNINGS_FILE_NAME, buildHtml, jobBadges, readableDate, warningsFileText, writeReports, writeWarningsFile } from '../src/report.mjs';
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

function header(html) {
  return html.match(/<header class="masthead">([\s\S]*?)<\/header>/)[1];
}

test('HTML output escapes remote content, links the posting, and keeps the JD folded', () => {
  const html = buildHtml([{ ...job, title: '<script>alert(1)</script>', company: 'A "quoted" co' }], meta);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-search="a &quot;quoted&quot; co &lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(html, /<a class="apply" href="https:\/\/example\.com\/jobs\/1">Open posting<\/a>/);
  assert.match(html, /<details class="jd"><summary>Full captured JD<\/summary>/);
  assert.doesNotMatch(html, /Pipeline warnings/);
  assert.doesNotMatch(html, /<link |src="http|https:\/\/cdn/);
});

test('the masthead is two lines: the title, then a readable date with the match count', () => {
  assert.equal(readableDate('2026-09-11'), 'September 11, 2026');
  assert.equal(readableDate('not-a-date'), 'not-a-date');
  const nine = buildHtml(Array.from({ length: 9 }, (_, index) => ({ ...job, url: `https://example.com/jobs/${index}` })), { ...meta, date: '2026-09-11' });
  assert.equal(header(nine), '<h1>Daily Job Match Alert</h1><p class="sub">September 11, 2026 · 9 matches</p>');
  assert.match(nine, /<title>Daily Job Match Alert — September 11, 2026<\/title>/);
  assert.equal(header(buildHtml([job], meta)), '<h1>Daily Job Match Alert</h1><p class="sub">August 27, 2026 · 1 match</p>');
  assert.equal(header(buildHtml([], meta)), '<h1>Daily Job Match Alert</h1><p class="sub">August 27, 2026 · No matches</p>');
  assert.doesNotMatch(nine, /linear-gradient/);
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
  const details = html.match(/<details class="run" id="run-details"><summary>Run details<\/summary>([\s\S]*?)<\/details>/)[1];
  assert.ok(details, 'Run details block is missing');
  assert.doesNotMatch(html, /<details class="run"[^>]*\bopen\b/, 'Run details must be collapsed by default');
  assert.match(details, /<dt>Application date<\/dt><dd>August 27, 2026 \(run on August 26, 2026\)<\/dd>/);
  assert.match(details, /<dt>Lookback window<\/dt><dd>24 hours<\/dd>/);
  assert.match(details, /<dt>Scoring model<\/dt><dd>claude-fable-5<\/dd>/);
  assert.match(details, /<dt>Resume tracks<\/dt><dd>Data, AI<\/dd>/);
  assert.match(details, /<dt>Minimum score<\/dt><dd>70<\/dd>/);
  assert.match(details, /<dt>Postings<\/dt><dd>12 collected · 7 reviewed · 2 matched<\/dd>/);
  assert.match(details, /<dt>Hard filter<\/dt><dd>3 excluded: 2 outside the United States, 1 outside the graduation window<ul><li>Globex — Data Analyst \(Toronto\): location outside the United States<\/li><li>Initech — BI Intern: Class of 2026 only<\/li><\/ul><\/dd>/);
  assert.match(details, /<dt>Updates today<\/dt><dd>Daily update #2 · last updated Aug 27, 2026, 08:30<\/dd>/);
  assert.match(details, /<dt>Status<\/dt><dd>1 of 2 matches kept local scores because semantic review was unavailable \(unreviewed\)<ul><li>Resume PDF\(s\) recovered from iCloud before this run: data<\/li><li>2 pipeline warning\(s\), see warnings\.txt beside this file<\/li><\/ul><\/dd>/);
  // The warning lines themselves never reach the page.
  assert.doesNotMatch(html, /network unavailable|batch fallback|Pipeline warnings/);
  // Outside the block, none of the run metadata appears.
  const outside = html.replace(details, '');
  assert.doesNotMatch(outside, /claude-fable-5|Lookback|Daily update|excluded|Toronto/);
});

test('the empty state uses the same layout and hides the run status behind the same block', () => {
  const html = buildHtml([], { ...meta, scoringModel: 'local_only', warnings: [] });
  assert.match(html, /<div class="empty">No new postings cleared the configured threshold for this date\.<\/div>/);
  assert.match(html, /<form class="toolbar quiet" id="toolbar"/);
  assert.match(html, /<details class="run" id="run-details">/);
  assert.match(html, /<dt>Status<\/dt><dd>No pipeline warnings<\/dd>/);
  assert.doesNotMatch(html, /id="jobs"/);
});

test('cards carry the ring score, compact track scores, the recommendation, and sortable data attributes', () => {
  const tracks = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }, { id: 'agent', label: 'AI Agent' }];
  const threeTrack = { ...job, scores: { data: 74, llm: 87, agent: 85 }, bestScore: 87, recommendedTrack: 'llm', recommendedResume: 'LLM', reasons: ['one', 'two', 'three', 'four'], gaps: ['a', 'b', 'c'] };
  const html = buildHtml([threeTrack], { ...meta, resumeTracks: tracks });
  assert.match(html, /<article class="job" data-score="87" data-company="acme, inc\." data-posted="\d+" data-role="new_grad" data-track="llm" data-search="acme, inc\. data &amp; ai analyst">/);
  assert.match(html, /<div class="ring" style="--score:87" role="img" aria-label="Best score 87"><b>87<\/b><\/div>/);
  assert.match(html, /<h2 class="job-title"><a href="https:\/\/example\.com\/jobs\/1">Data &amp; AI Analyst<\/a><\/h2>/);
  assert.match(html, /<p class="job-meta">Acme, Inc\. · Remote · New grad<\/p>/);
  assert.match(html, /<div class="scores"><span class="track" data-track="data">Data <b>74<\/b><\/span><span class="sep">·<\/span><span class="track best" data-track="llm">LLM <b>87<\/b><\/span><span class="sep">·<\/span><span class="track" data-track="agent">AI Agent <b>85<\/b><\/span><span class="recommend">Apply with LLM resume<\/span><\/div>/);
  assert.match(html, /<div class="facts-label">Why it matches<\/div><ul class="facts reasons"><li>one<\/li><li>two<\/li><\/ul><details class="more"><summary>2 more<\/summary><ul class="facts reasons"><li>three<\/li><li>four<\/li><\/ul><\/details>/);
  assert.match(html, /<div class="facts-label">Gaps \/ verify<\/div><ul class="facts gaps"><li>a<\/li><li>b<\/li><\/ul><details class="more"><summary>1 more<\/summary>/);
  assert.match(html, /<span class="meta">Posted 2026-08-27 · fixture<\/span>/);
  assert.doesNotMatch(html, /Match level:|Use LLM/);

  const single = buildHtml([{ ...job, scores: { data: 82 } }], { ...meta, resumeTracks: [{ id: 'data', label: 'Data' }] });
  assert.match(single, /<div class="scores"><span class="track best" data-track="data">Data <b>82<\/b><\/span><span class="recommend">Apply with Data resume<\/span><\/div>/);

  const legacy = buildHtml([{ ...job, scores: undefined, dataScore: 82, aiScore: 74 }], meta);
  assert.match(legacy, /<span class="track best" data-track="data">Data <b>82<\/b><\/span><span class="sep">·<\/span><span class="track" data-track="ai">AI <b>74<\/b><\/span>/);
});

test('the toolbar offers sort, role and resume filters, and search, and turns quiet below five matches', () => {
  const tracks = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }];
  const many = Array.from({ length: 5 }, (_, index) => ({ ...job, url: `https://example.com/jobs/${index}`, roleType: index % 2 ? 'internship' : 'new_grad' }));
  const html = buildHtml(many, { ...meta, resumeTracks: tracks });
  assert.match(html, /<form class="toolbar" id="toolbar" autocomplete="off">/);
  assert.match(html, /<input type="search" id="q" placeholder="Search company or title"/);
  assert.match(html, /<select id="sort" aria-label="Sort by"><option value="score" selected>Sort: best score<\/option><option value="company">Sort: company<\/option><option value="posted">Sort: posted time<\/option><\/select>/);
  assert.match(html, /<select id="role" aria-label="Role type"><option value="">All role types<\/option><option value="new_grad">New grad<\/option><option value="internship">Internship<\/option><\/select>/);
  assert.match(html, /<select id="track" aria-label="Recommended resume"><option value="">All resumes<\/option><option value="data">Data resume<\/option><option value="llm">LLM resume<\/option><\/select>/);
  assert.match(html, /<span class="count" id="count">5 shown<\/span>/);
  assert.match(html, /<div class="empty" id="no-results" hidden>/);
  assert.match(html, /<script>[\s\S]*getElementById\('jobs'\)[\s\S]*localeCompare[\s\S]*<\/script>/);
  assert.doesNotMatch(html, /<script src=/);

  const few = buildHtml(many.slice(0, 4), { ...meta, resumeTracks: tracks });
  assert.match(few, /<form class="toolbar quiet" id="toolbar"/);
});

test('semantic markers render as badges instead of text prefixes', () => {
  assert.deepEqual(jobBadges(job), []);
  assert.deepEqual(jobBadges({ ...job, matchLevel: 'unreviewed', scoringEngine: 'local_fallback' }).map(badge => badge.key), ['unreviewed']);
  assert.deepEqual(jobBadges({ ...job, matchLevel: 'medium' }).map(badge => badge.label), ['Match: medium']);
  assert.deepEqual(jobBadges({ ...job, eligibility: { location: { verdict: 'unverified' } } }).map(badge => badge.key), ['location-unverified']);
  assert.deepEqual(jobBadges({ ...job, enrichment: 'failed', enrichmentReason: 'login_wall' }).map(badge => [badge.key, badge.tone]), [['login_wall', 'warn']]);
  assert.deepEqual(jobBadges({ ...job, enrichment: 'failed', enrichmentReason: 'blocked' }).map(badge => badge.label), ['Fetch blocked']);
  assert.deepEqual(jobBadges({ ...job, enrichment: 'failed' }).map(badge => badge.label), ['JD not fetched']);
  assert.deepEqual(jobBadges({ ...job, enrichment: undefined, source: 'Handshake email alert' }).map(badge => badge.key), ['email-only']);
  assert.deepEqual(jobBadges({ ...job, badges: ['Referral available', { key: 'hot', label: 'Hot', tone: 'bad' }] }).map(badge => badge.key), ['referral-available', 'hot']);

  const html = buildHtml([{ ...job, matchLevel: 'unreviewed', scoringEngine: 'local_fallback', location: 'Remote', gaps: ['Location unverified — confirm US eligibility'], eligibility: { location: { verdict: 'unverified', marker: null }, exclusion: null } }], meta);
  assert.match(html, /<div class="badges"><span class="badge badge-warn" data-badge="unreviewed" title="[^"]+">Unreviewed<\/span><span class="badge" data-badge="location-unverified" title="[^"]+">Location unverified<\/span><\/div>/);
  assert.match(html, /Location unverified — confirm US eligibility/);
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

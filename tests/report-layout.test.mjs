// The compact cards and page (2026-11-15): the highest score marked (ties included), the copy icon and the
// plain-text form of a Job Description, the card order and the renamed actions, date-only postings in the
// main list, and the one-row top bar (its hub date controls: tests/report-date-nav.test.mjs). Rendering only: no engine,
// no network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { descriptionPlainText } from '../src/jd-html.mjs';
import { COPY_DESCRIPTION_LABEL, MENU_SLOT, renderJobCard } from '../src/report-components.mjs';
import { REPORT_SCRIPT } from '../src/report-theme.mjs';
import { CARRIED_OVER_TITLE, buildHtml, buildReportView, cardView } from '../src/report.mjs';
import { reportsPage } from '../src/hub/views.mjs';
import { jobIdOf } from '../src/hub/letters.mjs';
import { scanTitleCase } from './helpers/title-case.mjs';
import { fixtureJob, fixturePayload, prepareReportProject, selectedMatches, startReportHub, writePayload } from './helpers/report-hub.mjs';

const TRACKS = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }, { id: 'agent', label: 'AI Agent' }];
const META = { ...fixturePayload('2026-11-14', []).meta, resumeTracks: TRACKS };

test('the highest score is marked on the card, every holder when tied, whatever the recommended track says', () => {
  const view = cardView(fixtureJob(1, { scores: { data: 74, llm: 87, agent: 85 }, bestScore: 87, recommendedTrack: 'data' }), TRACKS);
  assert.deepEqual(view.scores.map(score => [score.id, score.value, score.top]), [['data', 74, false], ['llm', 87, true], ['agent', 85, false]]);
  assert.equal(view.recommendedTrack, 'data', 'the filter attribute still follows the recommendation');
  assert.equal(view.recommendation, undefined, 'no "Apply with … Resume" text');
  const tied = cardView(fixtureJob(2, { scores: { data: 87, llm: 87, agent: 60 }, bestScore: 87, recommendedTrack: 'llm' }), TRACKS);
  assert.deepEqual(tied.scores.map(score => score.top), [true, true, false]);
  const html = renderJobCard(tied);
  assert.match(html, /<div class="job-score"><div class="scores"><span class="track top" data-track="data">Data <b>87<\/b><\/span><span class="track top" data-track="llm">LLM <b>87<\/b><\/span><span class="track" data-track="agent">AI Agent <b>60<\/b><\/span><\/div><div class="ring" style="--score:87"/);
  assert.doesNotMatch(html, /recommend|Apply with|No Resume Recommended|class="sep">·<\/span><span class="track/);
  // All zero: every line is the "top" line, none hidden.
  assert.deepEqual(cardView(fixtureJob(3, { scores: {}, bestScore: 0 }), TRACKS).scores.map(score => score.top), [true, true, true]);
});

test('the copy icon: label and title, an inline SVG, no text; the plain-text form keeps headings, bullets and blank lines', () => {
  const html = buildHtml([fixtureJob(1, { descriptionHtml: '<p><strong>About</strong> the role</p><h3>You will</h3><ul><li>Write <b>SQL</b></li><li>Ship dashboards</li></ul><p>Line one<br>Line two</p>' })], META);
  assert.match(html, new RegExp(`<details class="jd"><summary><span>Job Description</span><button type="button" class="jd-copy" aria-label="${COPY_DESCRIPTION_LABEL}" title="${COPY_DESCRIPTION_LABEL}"><svg viewBox="0 0 16 16"[^>]*aria-hidden="true"[^>]*>[\\s\\S]*?</svg></button></summary>`));
  assert.doesNotMatch(html, /<link[^>]*icon|font-awesome|cdn/, 'no icon library');
  assert.equal(descriptionPlainText('<p><strong>About</strong> the role &amp; team</p><h3>You will</h3><ul><li>Write <b>SQL</b></li><li>Ship dashboards</li></ul><p>Line one<br>Line two</p><ol><li>First</li><li>Second</li></ol><p>End…</p>'),
    'About the role & team\n\nYou will\n\n• Write SQL\n• Ship dashboards\n\nLine one\nLine two\n\n• First\n• Second\n\nEnd…');
  assert.equal(descriptionPlainText('<p>Only one paragraph with <a href="https://x.example">a link</a> and &#8217;quotes&#8217;</p>'), 'Only one paragraph with a link and ’quotes’');
  assert.equal(descriptionPlainText(''), '');
  // The page script carries the same function and the clipboard path: both MIME types, then the plain fallback,
  // a tick for 1.5 seconds, and the click never toggles the fold.
  new Function(REPORT_SCRIPT);
  assert.ok(REPORT_SCRIPT.includes(descriptionPlainText.toString()));
  assert.match(REPORT_SCRIPT, /new ClipboardItem\(\{ 'text\/html': new Blob\(\[html\], \{ type: 'text\/html' \}\), 'text\/plain': new Blob\(\[text\], \{ type: 'text\/plain' \}\) \}\)/);
  assert.match(REPORT_SCRIPT, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(REPORT_SCRIPT, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*var details = button\.closest\('details\.jd'\)/);
  assert.match(REPORT_SCRIPT, /fetch\(src, \{ headers: \{ accept: 'text\/html' \} \}\)/, 'a lazy JD is fetched whole before the copy');
  assert.match(REPORT_SCRIPT, /setTimeout\(function \(\) \{ button\.innerHTML = icon; button\.classList\.remove\('done'\); button\.disabled = false; \}, 1500\)/);
});

test('card order: title row, posting row with the Check link, badges, Gaps / Verify, the JD, the four actions, the source', () => {
  const job = fixtureJob(1, { eligibility: { location: { verdict: 'unverified' } }, gaps: ['Verify dbt'] });
  const decorate = () => ({
    actions: [{ href: '/letters/2026-11-14/abc/Letter.pdf', label: 'Download CoverLetter' }, { href: '/letters/2026-11-14/abc', label: 'Open CoverLetter', newTab: true }, { button: true, label: 'Message to Recruiters', data: { reach: '1', date: '2026-11-14', job: 'abc' } }],
    check: { label: 'Check 2 Details', title: 'unverified detail: x\nsalutation says A, body says B', href: '/letters/2026-11-14/abc' },
    flags: { contacted: '0' },
  });
  const html = buildHtml([job], META, { decorate });
  const card = html.match(/<article class="job"[\s\S]*?<\/article>/)[0];
  const order = ['<h2 class="job-title">', '<p class="job-meta">', '<a class="badge badge-warn job-check" data-badge="letter-check" href="/letters/2026-11-14/abc" title="unverified detail: x\nsalutation says A, body says B">Check 2 Details</a></p>', '<div class="job-score">', '<div class="badges">', 'Gaps / Verify', '<details class="jd">', '<div class="actions"><a class="apply"', '>Open Posting</a><a class="btn secondary" href="/letters/2026-11-14/abc/Letter.pdf">Download CoverLetter</a><a class="btn secondary" href="/letters/2026-11-14/abc" target="_blank" rel="noopener noreferrer">Open CoverLetter</a><button type="button" class="btn secondary" data-reach="1" data-date="2026-11-14" data-job="abc">Message to Recruiters</button></div>', '<p class="job-foot">Source: Example Board</p>'];
  let at = -1;
  for (const piece of order) {
    const next = card.indexOf(piece, at + 1);
    assert.ok(next > at, `in order: ${piece.slice(0, 40)}`);
    at = next;
  }
  assert.doesNotMatch(card, /Mark as Applied|Reach Out|badge fresh|Apply with/);
  // The whole page: a card without a letter carries Generate CoverLetter in place of the two letter actions; the
  // spelling passes the Title Case scan.
  const bare = buildHtml([job], META, { decorate: () => ({ actions: [{ button: true, label: 'Generate CoverLetter', data: { oneclick: '1' } }, { button: true, label: 'Message to Recruiters', data: { reach: '1' } }] }) });
  assert.match(bare, /<div class="actions"><a class="apply"[^>]*>Open Posting<\/a><button type="button" class="btn secondary" data-oneclick="1">Generate CoverLetter<\/button><button type="button" class="btn secondary" data-reach="1">Message to Recruiters<\/button><\/div>/);
  assert.deepEqual(scanTitleCase(html).concat(scanTitleCase(bare)), []);
  assert.doesNotMatch(buildHtml([job], META).match(/<article class="job"[\s\S]*?<\/article>/)[0], /job-check|letter-check/, 'no letter, no Check link');
});

test('date-only and undated postings sit in the main list in the current sort; no Date Only tag, filter value or group', () => {
  const meta = { ...META, date: '2026-11-03', runDate: '2026-11-02', generatedAt: '2026-11-03T01:00:00.000Z', completedAt: '2026-11-03T01:40:00.000Z', strictWindow: { enabled: true, hours: 24 } };
  const jobs = [
    fixtureJob(1, { url: 'https://example.com/precise', postedAt: '2026-11-02T18:00:00.000Z', postedAtPrecision: 'datetime', bestScore: 70, scores: { data: 70 } }),
    fixtureJob(2, { url: 'https://example.com/yesterday', postedAt: '2026-11-01T12:00:00.000Z', postedAtPrecision: 'date', bestScore: 90, scores: { data: 90 } }),
    fixtureJob(3, { url: 'https://example.com/undated', postedAt: null, discoveredAt: '2026-11-03T01:10:00.000Z', bestScore: 80, scores: { data: 80 } }),
    fixtureJob(4, { url: 'https://example.com/carried', postedAt: '2026-11-01T12:00:00.000Z', postedAtPrecision: 'date', carriedOver: true, firstSeenAt: '2026-11-02T01:05:00.000Z' }),
  ];
  const view = buildReportView(jobs, meta);
  assert.deepEqual(view.cards.map(card => card.url.split('/').pop()), ['precise', 'yesterday', 'undated'], 'a strictWindow in an old payload is ignored');
  assert.equal(view.dateOnly, undefined);
  assert.deepEqual(view.carried, { title: CARRIED_OVER_TITLE, cards: view.carried.cards });
  assert.equal(view.carried.title, 'From Yesterday');
  assert.equal(view.carried.note, undefined, 'no note line under the group');
  assert.deepEqual(view.toolbar.freshness, [{ value: 'posted-today', label: 'Posted Today' }, { value: 'carried-over', label: 'Carried Over' }, { value: 'undated', label: 'Undated' }], 'no Date Only value');
  assert.equal(view.runDetails.rows.find(row => row.term === 'Strict 24-Hour Window'), undefined);
  const html = buildHtml(jobs, meta);
  assert.doesNotMatch(html.replace(/<(style|script)>[\s\S]*?<\/\1>/g, ''), /Date Only|id="date-only"|jobs-date-only|Strict 24-Hour|group-note/);
  assert.match(html, /<span class="meta" title="Date only: the source reports no time of day">Posted Nov 1<\/span><\/p>/);
  assert.match(html, /<h2 class="group-title" id="carried-over">From Yesterday <span class="group-count">\(1\)<\/span><\/h2><section class="jobs carried" id="jobs-carried">/);
  // Sorted by the page script: the cards carry their sort keys; the yesterday card with score 90 is the first by score.
  const scores = [...html.matchAll(/<article class="job" data-score="(\d+)"[^>]*data-freshness="([a-z-]*)"/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(scores, [['70', 'posted-today'], ['90', 'date-only'], ['80', 'undated'], ['84', 'carried-over']], 'rendered in input order with their keys; data-freshness="date-only" is only a key, never a filter option');
});

test('the top row: one form with the date and count, the four controls, the Filters popover, and the hub menu slot', () => {
  const html = buildHtml(selectedMatches(), META);
  assert.match(html, /<div class="bar-sentinel" id="bar-sentinel" aria-hidden="true"><\/div><form class="toolbar" id="toolbar" autocomplete="off">\s*<div class="bar-title"><span class="bar-date">November 14, 2026<\/span><span class="sep">·<\/span><span class="count" id="count">4 Jobs<\/span><\/div>\s*<input type="search" id="q"[^>]*>\s*<select id="sort" class="control" aria-label="Sort by">[\s\S]*?<select id="track" class="control" aria-label="Track">[\s\S]*?<select id="role" class="control" aria-label="Role type">[\s\S]*?<details class="menu" id="filters-menu"><summary class="btn secondary" id="filters-button">Filters<\/summary>/);
  assert.doesNotMatch(html, /<header|<h1|masthead|Matches · Ran|<!--menu-->/);
  assert.match(html, /\.toolbar\{position:sticky;top:0;z-index:5/);
  assert.match(html, /\.toolbar\.stuck\{[^}]*backdrop-filter:blur\(10px\);border-bottom-color:var\(--line\)\}/);
  assert.match(REPORT_SCRIPT, /label\(shown\)[\s\S]*' Job' : ' Jobs'/);
  const embedded = buildReportView(selectedMatches(), META, { embedded: true, marks: { contacted: true } });
  assert.equal(embedded.toolbar.menuSlot, true);
  const page = reportsPage({ dates: [{ date: '2026-11-14', matchCount: 4 }], selected: '2026-11-14', reportBody: `<form class="toolbar">${MENU_SLOT}</form>`, desktopPath: '/Users/jane/Desktop/x.html', today: '2026-11-14', missingLetters: { count: 2, letters: 1 } });
  assert.match(page, /<form class="toolbar"><details class="menu overflow" id="more-menu"><summary class="btn secondary" aria-label="More Actions" title="More Actions">⋯<\/summary><div class="menu-list"><form class="inline" method="post" action="\/letters\/missing"[\s\S]*?Generate Missing Letters \(2\)<\/button><\/form><form class="inline" method="post" action="\/letters\/update-salutations"[\s\S]*?Update Salutations \(1\)<\/button><\/form><a class="btn secondary small" href="\/desktop\/2026-11-14" target="_blank" rel="noopener noreferrer" title="\/Users\/jane\/Desktop\/x\.html">Open Desktop Copy<\/a><a class="btn secondary small" href="\/desktop\/2026-11-14\/xlsx" title="Download the Desktop workbook">Download XLSX<\/a><\/div><\/details><\/form>/);
  assert.doesNotMatch(page, /<!--menu-->|class="report-head"/);
});

test('the hub card: Check N Details links to the letter page, the actions are the four, and the applied mark is gone', async () => {
  const root = await prepareReportProject();
  const second = selectedMatches()[1];
  const dir = path.join(root, 'private', 'cover-letters', '2026-10-17', jobIdOf(second));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'letter.json'), JSON.stringify({ jobId: jobIdOf(second), date: '2026-10-17', company: second.company, companySlug: 'ExampleCorp2', pdfFileName: 'JaneDoe_Cover_Letter_ExampleCorp2.pdf', pdf: 'JaneDoe_Cover_Letter_ExampleCorp2.pdf', savedAt: '2026-10-17T03:00:00Z', editorNotes: ['unverified detail: the 40% figure', 'Replaced an em dash with a comma'] }));
  await fs.writeFile(path.join(dir, 'letter.md'), 'Dear Example Corp 2,');
  const hub = await startReportHub(root);
  try {
    const page = (await hub.request('/reports/2026-10-17')).text.split('<script')[0];
    const card = new RegExp(`<article class="job"[^>]*data-search="example corp 2 [^"]*"[\\s\\S]*?</article>`).exec(page)[0];
    assert.match(card, /<p class="job-meta"><span>Remote - US<\/span><span class="sep">·<\/span><span>New Grad<\/span><span class="sep">·<\/span><span class="meta"[^>]*>Posted Oct 17[^<]*<\/span><a class="badge badge-warn job-check" data-badge="letter-check" href="\/letters\/2026-10-17\/[A-Za-z0-9]+" title="unverified detail: the 40% figure">Check 1 Detail<\/a><\/p>/, 'the needs-review note alone, as a link at the end of the posting line');
    assert.match(card, /<div class="actions"><a class="apply"[^>]*>Open Posting<\/a><a class="btn secondary" href="\/letters\/2026-10-17\/[A-Za-z0-9]+\/JaneDoe_Cover_Letter_ExampleCorp2\.pdf" download="JaneDoe_Cover_Letter_ExampleCorp2\.pdf">Download CoverLetter<\/a><a class="btn secondary" href="\/letters\/2026-10-17\/[A-Za-z0-9]+" target="_blank" rel="noopener noreferrer">Open CoverLetter<\/a><button type="button" class="btn secondary" data-reach="1" data-date="2026-10-17" data-job="[a-f0-9]{16}">Message to Recruiters<\/button><\/div>/);
    assert.doesNotMatch(card, /<div class="badges">|Mark as Applied|data-applied/);
    const first = new RegExp(`<article class="job"[^>]*data-search="example corp 1 [^"]*"[\\s\\S]*?</article>`).exec(page)[0];
    assert.doesNotMatch(first, /job-check/, 'a letter without needs-review notes shows no link');
    assert.match(page, /Generate CoverLetter<\/button>/);
    assert.doesNotMatch(page, /Reach Out|Hide Applied|hide-applied/);
    assert.match(page, /<aside class="reach-drawer" id="reach-drawer" hidden aria-label="Message to Recruiters"><\/aside>/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

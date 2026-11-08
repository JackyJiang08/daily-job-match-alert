// Title Case across the hub and the report: the text of every button, group name (summary, h1–h3), label,
// table header, definition term, badge and tag in the rendered pages. Short articles, conjunctions and
// prepositions stay lower case after the first word; proper nouns and abbreviations stay as they are.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { identifyBoard, normalizeRegistry, registerBoards } from '../src/collectors/ats-boards.mjs';
import { jobIdOf } from '../src/hub/letters.mjs';
import { buildHtml } from '../src/report.mjs';
import { scanTitleCase, titleCaseViolations } from './helpers/title-case.mjs';
import { fixtureJob, fixturePayload, prepareReportProject, selectedMatches, startReportHub, writePayload } from './helpers/report-hub.mjs';

test('the checker: lower-case words fail, minor words after the first pass, proper nouns and abbreviations pass', () => {
  assert.deepEqual(titleCaseViolations('Carried over from yesterday'), ['over', 'from', 'yesterday']);
  assert.deepEqual(titleCaseViolations('Carried Over From Yesterday'), []);
  assert.deepEqual(titleCaseViolations('Date Only, May Be Older Than 24 Hours'), []);
  assert.deepEqual(titleCaseViolations('Not Reviewed (Engine Unavailable)'), []);
  assert.deepEqual(titleCaseViolations('Rename Company & Re-render'), []);
  assert.deepEqual(titleCaseViolations('Open in LinkedIn for PwC and the JD'), []);
  assert.deepEqual(titleCaseViolations('of the Run'), ['of'], 'a minor word is capitalized when it comes first');
  assert.deepEqual(titleCaseViolations('Generate with Codex'), ['with'], 'a four-letter preposition is capitalized');
  assert.deepEqual(scanTitleCase('<button>Update salutations</button><th>Last Used</th><dt>Model in effect</dt><span class="badge">due now</span><summary>Run Details</summary>').map(item => item.text), ['Update salutations', 'Model in effect', 'due now']);
  assert.deepEqual(scanTitleCase('<label class="check"><input type="checkbox"> Strict 24-Hour Window</label><span class="muted">on: keep only fresh postings</span>'), [], 'the hint after a label is prose');
});

const PAGES = ['/reports', '/reports/2026-10-17', '/reports/2026-10-16', '/resumes', '/status', '/letters', '/settings', '/settings?tab=models', '/settings?tab=pipeline', '/settings?tab=letters'];

test('every hub page and the letter panel: buttons, group names, labels, table headers, terms and badges are Title Case', async () => {
  const root = await prepareReportProject();
  // States that bring more badges: every report group, a dormant board, an installed schedule that is overdue.
  const strict = { strictWindow: { enabled: true, hours: 24 }, runDate: '2026-10-16', completedAt: '2026-10-17T03:00:00.000Z', lastUpdatedAt: '2026-10-17T03:00:00.000Z' };
  const old = fixtureJob(5, { url: 'https://jobs.example.com/5', postedAt: '2026-10-15T12:00:00.000Z', postedAtPrecision: 'date' });
  const unreviewed = fixtureJob(6, { url: 'https://jobs.example.com/6', matchLevel: 'unreviewed', scoringEngine: 'local_fallback', semanticReviewed: false });
  const payload = fixturePayload('2026-10-17', [...selectedMatches(), old, unreviewed], strict);
  await writePayload(root, payload);
  const registry = normalizeRegistry(null);
  registerBoards(registry, [{ ...identifyBoard('https://jobs.lever.co/broken'), company: 'Broken Co' }], { now: new Date('2026-09-01T00:00:00Z') });
  Object.assign(registry.boards['lever:broken'], { dormant: true, dormantSince: '2026-10-01T00:00:00.000Z', consecutiveFailures: 7, lastError: 'HTTP 500' });
  await fs.writeFile(path.join(root, 'state', 'ats-boards.json'), JSON.stringify(registry));
  await fs.mkdir(path.join(root, 'Library', 'LaunchAgents'), { recursive: true });
  await fs.writeFile(path.join(root, 'Library', 'LaunchAgents', 'com.dailyjobmatchalert.daily.plist'), '<plist><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict></plist>');
  const hub = await startReportHub(root);
  try {
    const found = [];
    const scan = (page, html) => { for (const item of scanTitleCase(html)) found.push(`${page} · ${item.kind}: "${item.text}"`); };
    const texts = {};
    for (const page of PAGES) {
      const reply = await hub.request(page);
      assert.equal(reply.status, 200, page);
      texts[page] = reply.text;
      scan(page, reply.text);
    }
    const panels = [`/letters/new?date=2026-10-17&job=${jobIdOf(selectedMatches()[1])}`, ...[...texts['/reports/2026-10-17'].matchAll(/href="(\/letters\/2026-10-17\/[A-Za-z0-9]+)"/g)].map(match => match[1])];
    assert.equal(panels.length, 2, 'a new-letter panel and a saved letter');
    for (const panel of panels) {
      const reply = await hub.request(panel);
      assert.equal(reply.status, 200, panel);
      scan(panel, reply.text);
    }
    // The pages really carry the groups and badges this test is about.
    assert.match(texts['/reports/2026-10-17'], /Date Only, May Be Older Than 24 Hours[\s\S]*Carried Over From Yesterday[\s\S]*Not Reviewed \(Engine Unavailable\)/);
    assert.match(texts['/status'], /data-badge="overdue">Overdue<[\s\S]*data-badge="dormant"/);
    assert.deepEqual(found, []);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the Desktop report: group names, Run Details terms, badges and buttons are Title Case', () => {
  const meta = { ...fixturePayload('2026-10-17', []).meta, runDate: '2026-10-17', strictWindow: { enabled: true, hours: 24 }, completedAt: '2026-10-17T23:02:00.000Z', lastUpdatedAt: '2026-10-17T23:02:00.000Z', networkOutage: { detail: 'The network was down for part of the run' } };
  const jobs = [
    ...selectedMatches(),
    fixtureJob(5, { url: 'https://jobs.example.com/5', postedAt: '2026-10-15T12:00:00.000Z', postedAtPrecision: 'date' }),
    fixtureJob(6, { url: 'https://jobs.example.com/6', matchLevel: 'unreviewed', scoringEngine: 'local_fallback', semanticReviewed: false }),
    fixtureJob(7, { url: 'https://jobs.example.com/7', enrichment: 'failed', enrichmentReason: 'blocked', companyUncertain: true }),
  ];
  const html = buildHtml(jobs, meta, { reviewed: jobs });
  assert.match(html, /<h1>October 17, 2026<\/h1><p class="sub">\d+ Matches · Ran 6:02 PM<\/p>/);
  assert.match(html, /Date Only, May Be Older Than 24 Hours/);
  assert.deepEqual(scanTitleCase(html).map(item => `${item.kind}: "${item.text}"`), []);
});

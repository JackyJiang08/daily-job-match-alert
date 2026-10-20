// Payload size and the Status page: the slim rule (full JDs only for postings that went to the final review),
// the same rule on a same-day rerun, npm run payloads:compact (backups, sizes, gzip after 30 days, matches and
// Run Summary only past the retention period), gzip payloads on the Reports pages, the Status page reading
// only the reports index and state/status-summary.json, and the retention setting.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { identifyBoard, normalizeRegistry, OUTAGE_REPAIR_MIGRATION, registerBoards } from '../src/collectors/ats-boards.mjs';
import { main as runMain, mergeReviewedJobs } from '../src/index.mjs';
import { isEligible } from '../src/match.mjs';
import { maintainPayloads } from '../src/payload-maintenance.mjs';
import { SLIM_JOB_FIELDS, archivePayload, payloadFilePath, readPayloadFile, retentionDays, slimPayload, wentToFinalReview, writePayloadFile } from '../src/payload-store.mjs';
import { main as compactMain } from '../src/payloads-compact.mjs';
import { usageWindow } from '../src/engines/usage.mjs';
import { buildHtml } from '../src/report.mjs';
import { readReportsIndex, syncReportsIndex, updateReportsIndex } from '../src/reports-index.mjs';
import { readStatusSummary, refreshStatusLetters, statusSummaryPath, updateStatusSummary } from '../src/status-summary.mjs';
import { asBefore, countingIo, fixtureJob, fixturePayload, inlineAssets, normalizeHtml, prepareReportProject, selectedMatches, startReportHub, writePayload } from './helpers/report-hub.mjs';
import { addStatusFixture, withoutHubCard } from './helpers/status-fixture.mjs';

const snapshots = new URL('./fixtures/snapshots/', import.meta.url);
const JD = 'Responsibilities: build dashboards, model data in SQL, and present findings. '.repeat(60);

function posting(slug, extra = {}) {
  return {
    title: `Analyst ${slug}`, company: 'Example Corp', location: 'Remote - US', source: 'Example Board', sourceKind: 'public_ats_board',
    url: `https://jobs.example.com/${slug}`, finalUrl: `https://jobs.example.com/${slug}`, postedAt: '2026-10-17T01:00:00.000Z', postedAtPrecision: 'datetime',
    discoveredAt: '2026-10-17T02:00:00.000Z', roleType: 'new_grad', bestScore: 40, scores: { data: 40 }, recommendedTrack: 'data', description: JD,
    reasons: ['matched skills: sql'], gaps: [], blockers: [], enrichment: 'ats_api', companyCandidates: [{ name: 'Example Corp', source: 'list' }],
    scoreDetails: { data: { score: 40, roleRelevance: 5, reasons: ['matched skills: sql'], jdSkills: ['sql', 'python'] } }, eligibility: { location: { verdict: 'us' } },
    ...extra,
  };
}

function legacyPayload(date, extra = {}) {
  const payload = fixturePayload(date, [fixtureJob(1)], extra);
  payload.reviewed.push(posting(`${date}-skipped-a`), posting(`${date}-skipped-b`, { alternates: [{ url: `https://jobs.example.com/${date}-alt`, description: JD }] }));
  payload.meta.sourceCounts = [{ name: 'Example Board', kind: 'builtin', ok: true, count: 3, error: null }];
  payload.meta.prefilter = { titleExcluded: [{ company: 'Example Corp', title: 'Senior Analyst', source: 'Example Board', rule: 'exclude: senior', url: 'https://jobs.example.com/senior', description: JD }], titleExcludedCount: 1, locationExcludedCount: 0, bySource: [] };
  return payload;
}

// ------------------------------------------------------------------------------------------ slim rule

test('slim rule: only postings that went to the final review keep the JD; the rest keep title, company, location, source, links, dates, scores, and the reason', () => {
  const reviewedByModel = posting('model', { semanticReviewed: true, matchLevel: 'medium', scoringEngine: 'claude', scoringModel: 'claude-opus-5-5' });
  const fallback = posting('fallback', { matchLevel: 'unreviewed', scoringEngine: 'local_fallback' });
  const localCandidate = posting('local', { scoringEngine: 'local_only', scoreDetails: { data: { score: 70, roleRelevance: 20 } } });
  const lowRelevance = posting('low');
  const blocked = posting('blocked', { blockers: ['requires 5+ years'], scoreDetails: { data: { score: 70, roleRelevance: 30 } } });
  const hardFiltered = posting('abroad', { eligibility: { location: { verdict: 'non_us' }, exclusion: { kind: 'location', reason: 'outside the United States' } } });
  const oddMatch = posting('odd-match');
  const redirected = posting('redirected', { url: 'https://track.example.com/r', finalUrl: 'https://jobs.example.com/redirected', originalUrl: 'https://alerts.example.com/r' });
  const payload = {
    meta: { date: '2026-10-17', prefilter: { titleExcluded: [{ company: 'Example Corp', title: 'Senior Analyst', source: 'Example Board', rule: 'exclude: senior', url: 'https://jobs.example.com/senior', description: JD }] }, prescreen: { status: 'ok', dropped: [{ url: 'https://jobs.example.com/p', title: 'Analyst P', company: 'Example Corp', score: 20, description: JD }] } },
    matches: [reviewedByModel, oddMatch],
    reviewed: [reviewedByModel, fallback, localCandidate, lowRelevance, blocked, hardFiltered, oddMatch, redirected],
    complete: true,
  };
  const slim = slimPayload(payload);
  assert.deepEqual(slim.matches, payload.matches, 'matches are never touched');
  const byUrl = Object.fromEntries(slim.reviewed.map(job => [job.url.split('/').pop(), job]));
  for (const kept of ['model', 'fallback', 'local', 'odd-match']) assert.equal(byUrl[kept].description, JD, `${kept} keeps its JD`);
  assert.equal(byUrl['odd-match'].scoreDetails.data.roleRelevance, 5, 'a match keeps everything even when it was not a review candidate');
  for (const [key, reason] of [['low', 'not sent to review: role relevance 5 below 14'], ['blocked', 'blocker: requires 5+ years'], ['abroad', 'hard filter: outside the United States']]) {
    const job = byUrl[key];
    assert.equal(job.description, undefined, `${key} has no JD`);
    assert.equal(job.exclusionReason, reason);
    assert.equal(job.jdOmitted, true);
    assert.equal(job.finalUrl, undefined, 'a resolved link equal to the URL is not repeated');
    for (const field of ['title', 'company', 'location', 'source', 'url', 'postedAt', 'discoveredAt', 'bestScore', 'scores']) assert.deepEqual(job[field], payload.reviewed.find(item => item.url === job.url)[field], `${key}.${field}`);
    for (const field of Object.keys(job)) assert.ok([...SLIM_JOB_FIELDS, 'exclusionReason', 'jdOmitted', 'alternates'].includes(field), `${key} keeps no ${field}`);
    assert.equal(isEligible(job, { minimumMatchScore: 0, semanticMatching: { engine: 'local_only' } }), false, 'a slim posting can never become a match');
  }
  const kept = slim.reviewed.find(job => job.url === 'https://track.example.com/r');
  assert.deepEqual([kept.finalUrl, kept.originalUrl, kept.description], ['https://jobs.example.com/redirected', 'https://alerts.example.com/r', undefined], 'links that differ stay');
  assert.equal(slim.meta.prefilter.titleExcluded[0].description, undefined);
  assert.deepEqual(slim.meta.prefilter.titleExcluded[0], { company: 'Example Corp', title: 'Senior Analyst', source: 'Example Board', url: 'https://jobs.example.com/senior', rule: 'exclude: senior' });
  assert.deepEqual(slim.meta.prescreen.dropped[0], { url: 'https://jobs.example.com/p', title: 'Analyst P', company: 'Example Corp', score: 20 });
  assert.equal(slim.storage.form, 'slim');
  assert.deepEqual(slimPayload(slim), slim, 'idempotent');
  assert.ok(JSON.stringify(slim).length < JSON.stringify(payload).length * 0.7, 'four of the eight JDs are gone');
});

test('a same-day rerun merges under the same rule: a slim posting reviewed later gets its JD back, one still unreviewed stays slim', () => {
  const previous = slimPayload({ meta: { date: '2026-10-17' }, matches: [], reviewed: [posting('later-reviewed'), posting('still-skipped')], complete: true });
  assert.ok(previous.reviewed.every(job => job.jdOmitted));
  const incoming = [posting('later-reviewed', { semanticReviewed: true, matchLevel: 'high', scoringEngine: 'claude' }), posting('still-skipped'), posting('new-skipped')];
  const merged = slimPayload({ meta: { date: '2026-10-17' }, matches: [], reviewed: mergeReviewedJobs(previous.reviewed, incoming), complete: true });
  const byUrl = Object.fromEntries(merged.reviewed.map(job => [job.url.split('/').pop(), job]));
  assert.equal(byUrl['later-reviewed'].description, JD);
  assert.equal(byUrl['still-skipped'].description, undefined);
  assert.equal(byUrl['new-skipped'].description, undefined);
  assert.equal(merged.reviewed.length, 3);
  assert.equal(wentToFinalReview(byUrl['still-skipped']), false);
});

test('end to end: the pipeline stores a slim payload, a rerun keeps the rule, the report renders the same from it, and the Status summary is written', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'payload-slim-'));
  await fs.copyFile(new URL('./fixtures/data-resume.md', import.meta.url), path.join(root, 'data-resume.md'));
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 0, reportDateOffsetDays: 0,
    semanticMatching: { engine: 'local_only', acceptedMatchLevels: ['high', 'medium', 'low'], maxReviewedPerRun: 0 },
    prescreen: { enabled: false }, coverLetter: { autoGenerate: { enabled: false } }, reports: { xlsx: { enabled: false, required: false } },
    outputDirectory: './output', requireFullDescription: false,
    resumes: { tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, graduationDate: '2027-05', excludeTitleTerms: ['senior'] },
    sources: {
      githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false },
      emailFiles: { enabled: false }, himalaya: { enabled: false }, careerOps: { enabled: false }, searchDiscovery: { enabled: false }, atsBoards: { enabled: true },
    },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
  };
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  const registry = normalizeRegistry(null);
  registerBoards(registry, [identifyBoard('https://job-boards.greenhouse.io/examplecorp')], { now: new Date('2026-09-01T00:00:00Z') });
  for (const board of Object.values(registry.boards)) Object.assign(board, { baselinedAt: '2026-09-01T00:00:00Z', lastNewAt: '2026-10-15T01:00:00Z', lastSuccessAt: '2026-10-15T01:00:00Z', lastPolledAt: '2026-10-15T01:00:00Z' });
  registry.migrations = { [OUTAGE_REPAIR_MIGRATION]: { at: '2026-09-01T00:00:00Z', runs: [] } };
  await fs.writeFile(path.join(root, 'state', 'ats-boards.json'), JSON.stringify(registry));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const body = title => `${title}. ${/Data|Analyst/.test(title) ? 'Python, SQL, statistics, dashboards, experiment analysis, and stakeholder communication. ' : 'Front desk greetings, visitor badges, and mail sorting. '}`.repeat(8);
  const board = titles => titles.map((title, index) => ({ id: 2000 + index, title, absolute_url: `https://job-boards.greenhouse.io/examplecorp/jobs/${2000 + index}`, updated_at: '2026-10-16T20:00:00Z', first_published: '2026-10-16T20:00:00Z', location: { name: 'Remote - US' }, content: body(title) }));
  const first = ['Data Analyst, New Grad', 'Business Analyst, New Grad', 'Program Manager, Workplace Operations, New Grad'];
  const run = async (titles, now) => {
    const silence = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = () => {};
    try {
      await runMain({
        argv: ['node', 'index.mjs', '--config', configPath, '--now', now], autoLetters: false, notify: async () => {}, atsSleep: async () => {}, runClock: { jumpMs: () => 0 },
        atsFetchImpl: async () => new Response(JSON.stringify({ jobs: board(titles) }), { status: 200, headers: { 'content-type': 'application/json' } }),
      });
    } finally {
      [console.log, console.warn, console.error] = silence;
    }
  };
  const stored = async () => JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-10-16.json'), 'utf8'));
  const check = payload => {
    assert.equal(payload.storage.form, 'slim');
    for (const job of payload.reviewed) {
      const matched = payload.matches.some(item => item.url === job.url);
      if (job.jdOmitted) assert.ok(!job.description && job.exclusionReason && !matched, job.title);
      else assert.ok(wentToFinalReview(job) || matched, `${job.title} keeps its JD only after the final review`);
    }
    for (const job of payload.matches) assert.ok(String(job.description || '').length > 100, `${job.title}: a match keeps its JD`);
  };
  try {
    await run(first, '2026-10-17T01:30:00.000Z');
    const once = await stored();
    check(once);
    assert.ok(once.reviewed.some(job => job.jdOmitted), 'at least one posting was not a review candidate');
    assert.ok(once.reviewed.some(job => !job.jdOmitted), 'at least one went to the review');
    // The Desktop report rendered by the run is what the stored (slim) payload renders.
    const runDirectory = path.join(root, 'output', (await fs.readdir(path.join(root, 'output')))[0]);
    const htmlName = (await fs.readdir(runDirectory)).find(name => name.endsWith('.html'));
    assert.equal(buildHtml(once.matches, once.meta), await fs.readFile(path.join(runDirectory, htmlName), 'utf8'));
    const summary = await readStatusSummary(root);
    assert.equal(summary.source.date, '2026-10-16');
    assert.equal(summary.latest.meta.matchCount, once.matches.length);

    // The board is due again (its poll time put back) and lists one more posting.
    await fs.writeFile(path.join(root, 'state', 'ats-boards.json'), JSON.stringify(registry));
    await run([...first, 'Business Analyst, Facilities, New Grad'], '2026-10-17T03:30:00.000Z');
    const twice = await stored();
    check(twice);
    assert.equal(twice.meta.runsToday, 2);
    assert.equal(twice.reviewed.length, once.reviewed.length + 1, 'the rerun merged one new posting');
    assert.equal(buildHtml(twice.matches, twice.meta), await fs.readFile(path.join(runDirectory, htmlName), 'utf8'));
    assert.equal((await readStatusSummary(root)).latest.meta.runsToday, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ compact

async function compactProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'payload-compact-'));
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.copyFile(new URL('./fixtures/data-resume.md', import.meta.url), path.join(root, 'data-resume.md'));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ timeZone: 'America/Chicago', outputDirectory: './output', reports: { xlsx: { enabled: false } }, resumes: { autoRefresh: false, tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md', enabled: true }] } }));
  for (const date of ['2026-10-15', '2026-09-15', '2026-07-01']) await fs.writeFile(payloadFilePath(root, date), `${JSON.stringify(legacyPayload(date), null, 2)}\n`);
  // Already slim and gzipped: left alone.
  await writePayloadFile(root, slimPayload(legacyPayload('2026-09-01')), { gzip: true });
  return root;
}

test('payloads:compact backs up each file first, slims every payload, gzips those past 30 days, archives those past the retention period, and prints the sizes', async () => {
  const root = await compactProject();
  const originals = {};
  for (const date of ['2026-10-15', '2026-09-15', '2026-07-01']) originals[date] = await fs.readFile(payloadFilePath(root, date));
  const lines = [];
  try {
    const now = new Date('2026-10-20T12:00:00Z');
    const dry = await compactMain(['node', 'x', '--config', path.join(root, 'config.json'), '--dry-run'], { now, log: line => lines.push(line) });
    assert.equal(dry.backupDirectory, null);
    assert.deepEqual(await fs.readFile(payloadFilePath(root, '2026-10-15')), originals['2026-10-15'], 'a dry run writes nothing');
    assert.match(lines[0], /^Dry run: nothing written/);

    lines.length = 0;
    const result = await compactMain(['node', 'x', '--config', path.join(root, 'config.json')], { now, log: line => lines.push(line) });
    const rows = Object.fromEntries(result.rows.map(row => [row.date, row]));
    assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([date, row]) => [date, [row.action, row.form, row.gzip]])), {
      '2026-07-01': ['compacted', 'archived', true], '2026-09-01': ['unchanged', 'slim', true], '2026-09-15': ['compacted', 'slim', true], '2026-10-15': ['compacted', 'slim', false],
    });
    for (const date of ['2026-10-15', '2026-09-15', '2026-07-01']) {
      assert.ok(rows[date].after < rows[date].before, `${date} got smaller`);
      assert.equal(rows[date].before, originals[date].length);
      // The backup is the original file, gzipped.
      assert.deepEqual(zlib.gunzipSync(await fs.readFile(path.join(result.backupDirectory, `report-payload-${date}.json.gz`))), originals[date], `${date} backup`);
    }
    assert.ok(result.backupDirectory.startsWith(path.join(root, 'state', 'backups', 'payloads-')));
    await assert.rejects(fs.stat(path.join(result.backupDirectory, 'report-payload-2026-09-01.json.gz')), 'an unchanged payload is not backed up');
    assert.equal(result.totals.before, Object.values(rows).reduce((sum, row) => sum + row.before, 0));
    assert.ok(result.totals.after < result.totals.before);
    const text = lines.join('\n');
    assert.match(text, /2026-10-15 +\d+(\.\d)? KB → +\d+(\.\d)? KB {2}→ slim/);
    assert.match(text, /2026-07-01 .* → archived \(gzip\)/);
    assert.match(text, /^Total: 4 payload\(s\), 3 rewritten: .+ → .+ \(\d+% smaller\)$/m);
    assert.match(text, /^Backups: /m);

    // The files on disk: the recent one stays plain JSON, the older ones are .json.gz only.
    await fs.stat(payloadFilePath(root, '2026-10-15'));
    for (const date of ['2026-09-15', '2026-07-01']) {
      await assert.rejects(fs.stat(payloadFilePath(root, date)));
      await fs.stat(payloadFilePath(root, date, { gzip: true }));
    }
    const archived = (await readPayloadFile(root, '2026-07-01')).payload;
    assert.deepEqual(archived.matches, legacyPayload('2026-07-01').matches, 'archived: the matches as they were');
    assert.deepEqual(archived.reviewed, []);
    assert.equal(archived.storage.reviewedCount, 4);
    assert.equal(archived.meta.sourceCounts, undefined);
    assert.equal(archived.meta.prefilter, undefined);
    assert.deepEqual(archived.meta.resumeTracks, legacyPayload('2026-07-01').meta.resumeTracks);
    const slim = (await readPayloadFile(root, '2026-09-15')).payload;
    assert.equal(slim.reviewed.filter(job => job.jdOmitted).length, 2);
    assert.equal(slim.meta.prefilter.titleExcluded[0].description, undefined);

    // The index knows each form, so a second pass reads nothing and changes nothing.
    const index = await readReportsIndex(root);
    assert.deepEqual(Object.fromEntries(Object.values(index.dates).map(entry => [entry.date, [entry.form, entry.gzip]])), { '2026-07-01': ['archived', true], '2026-09-01': ['slim', true], '2026-09-15': ['slim', true], '2026-10-15': ['slim', false] });
    assert.equal(index.dates['2026-07-01'].reviewedCount, 4);
    const spy = countingIo();
    const again = await maintainPayloads(root, { now, mode: 'all', io: spy.io });
    assert.ok(again.every(row => row.action === 'unchanged'));
    assert.deepEqual(spy.reads, [], 'nothing read on the second pass');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the nightly pass only touches payloads past 30 days, and the retention period comes from config', async () => {
  const root = await compactProject();
  try {
    const now = new Date('2026-10-20T12:00:00Z');
    const rows = await maintainPayloads(root, { now, retention: 120, mode: 'aged' });
    assert.deepEqual(rows.map(row => [row.date, row.action, row.form]), [['2026-07-01', 'compacted', 'slim'], ['2026-09-01', 'unchanged', 'slim'], ['2026-09-15', 'compacted', 'slim']], 'July is inside a 120-day retention; Oct 15 is left as written');
    assert.equal((await readPayloadFile(root, '2026-10-15')).payload.storage, undefined);
    assert.equal(retentionDays({}), 90);
    assert.equal(retentionDays({ reports: { payloadRetentionDays: 120 } }), 120);
    assert.equal(retentionDays({ reports: { payloadRetentionDays: 5 } }), 90, 'out of range falls back to 90');
    assert.equal(archivePayload(archivePayload(legacyPayload('2026-07-01'))).storage.reviewedCount, 4, 'archiving twice keeps the count');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ hub reads

test('gzip: a slim .json.gz payload renders the same Reports pages (snapshot) and JD route, and the index records it', async () => {
  const root = await prepareReportProject();
  const payload = fixturePayload('2026-10-17', selectedMatches());
  payload.reviewed.push(posting('skipped'));
  await writePayloadFile(root, slimPayload(payload), { gzip: true });
  await writePayloadFile(root, slimPayload(fixturePayload('2026-10-15', [fixtureJob(7)])), { gzip: true });
  const spy = countingIo();
  const hub = await startReportHub(root, { context: { io: spy.io } });
  try {
    await assert.rejects(fs.stat(payloadFilePath(root, '2026-10-17')));
    for (const [name, url] of [['report-page.html', '/reports/2026-10-17'], ['reports-list.html', '/reports'], ['report-page-short.html', '/reports/2026-10-15']]) {
      const page = await hub.request(url);
      assert.equal(page.status, 200, url);
      assert.equal((await asBefore(hub, page.text, root)).text, await fs.readFile(new URL(name, snapshots), 'utf8'), name);
    }
    assert.ok(spy.reads.includes('report-payload-2026-10-17.json.gz'));
    const index = await readReportsIndex(root);
    assert.equal(index.dates['2026-10-17'].gzip, true);
    assert.equal(index.dates['2026-10-17'].form, 'slim');
    assert.equal(index.dates['2026-10-16'].gzip, false);
    assert.equal(index.dates['2026-10-17'].matchCount, 4);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Status page: reads the reports index and state/status-summary.json, never a payload; the same page as before (snapshot); the Hub card shows its timing', async () => {
  const root = await prepareReportProject();
  await addStatusFixture(root, { writePayload, fixturePayload, selectedMatches });
  // As the pipeline leaves the files: the index and the summary written after the payloads.
  await syncReportsIndex(root);
  await updateStatusSummary(root, (await readPayloadFile(root, '2026-10-17')).payload);
  const spy = countingIo();
  const hub = await startReportHub(root, { context: { io: spy.io } });
  try {
    const page = await hub.request('/status');
    assert.equal(page.status, 200);
    assert.deepEqual(spy.reads, [], 'no payload read');
    assert.equal(withoutHubCard(normalizeHtml(inlineAssets(page.text), { port: hub.port(), root })), await fs.readFile(new URL('status-page.html', snapshots), 'utf8'));

    const json = await hub.request('/status/run.json');
    assert.equal(JSON.parse(json.text).lastRun.matchCount, 4);
    assert.deepEqual(spy.reads, [], 'the polling endpoint reads none either');

    const second = await hub.request('/status');
    const card = /<article class="card" id="hub-card">[\s\S]*?<\/article>/.exec(second.text)[0];
    assert.match(card, /<td class="mono">\/status<\/td><td>200<\/td><td>[\d.]+ ms<\/td><td>index [\d.]+ ms · status summary [\d.]+ ms · status data [\d.]+ ms · render [\d.]+ ms · sidebar [\d.]+ ms<\/td>/);
    assert.ok(hub.timingLines.some(line => /^\[hub\] GET \/status 200 in [\d.]+ ms \(index .* status summary .*\)/.test(line)));

    // A payload the summary does not describe yet (another process rewrote it): read once, then not again.
    const payload = (await readPayloadFile(root, '2026-10-17')).payload;
    payload.meta.runsToday = 3;
    await writePayload(root, payload);
    spy.reads.length = 0;
    const rebuilt = await hub.request('/status/run.json');
    assert.equal(JSON.parse(rebuilt.text).lastRun.runsToday, 3);
    assert.ok(spy.reads.length >= 1 && spy.reads.every(name => name === 'report-payload-2026-10-17.json'), spy.reads.join(', '));
    spy.reads.length = 0;
    await hub.request('/status');
    assert.deepEqual(spy.reads, []);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Status page snapshot also holds when the summary is built by the hub itself from the newest payload', async () => {
  const root = await prepareReportProject();
  await addStatusFixture(root, { writePayload, fixturePayload, selectedMatches });
  const hub = await startReportHub(root);
  try {
    const page = await hub.request('/status');
    assert.equal(withoutHubCard(normalizeHtml(inlineAssets(page.text), { port: hub.port(), root })), await fs.readFile(new URL('status-page.html', snapshots), 'utf8'));
    assert.equal((await readStatusSummary(root)).source.date, '2026-10-17');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('status summary: an older date never replaces the newest; a letter save updates its letter count', async () => {
  const root = await prepareReportProject();
  try {
    for (const date of ['2026-10-15', '2026-10-17']) {
      const { payload } = await readPayloadFile(root, date);
      await updateReportsIndex(root, payload);
      await updateStatusSummary(root, payload);
    }
    await updateStatusSummary(root, (await readPayloadFile(root, '2026-10-15')).payload);
    const summary = await readStatusSummary(root);
    assert.equal(summary.source.date, '2026-10-17');
    assert.equal(summary.latest.letterCount, 1);
    const directory = path.join(root, 'private', 'cover-letters', '2026-10-17', 'ExampleCorp2');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'letter.json'), '{}');
    assert.equal((await refreshStatusLetters(root, '2026-10-17')).latest.letterCount, 2);
    assert.equal(await refreshStatusLetters(root, '2026-10-15'), null, 'another date leaves it alone');
    assert.ok(JSON.stringify(summary).length < 20_000);
    assert.equal(path.basename(statusSummaryPath(root)), 'status-summary.json');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Settings → Pipeline: the retention period is shown, saved to config.reports.payloadRetentionDays, and validated', async () => {
  const root = await prepareReportProject();
  const hub = await startReportHub(root);
  const post = body => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: hub.port(), path: '/settings', method: 'POST', headers: { host: `127.0.0.1:${hub.port()}`, origin: `http://127.0.0.1:${hub.port()}`, 'content-type': 'application/x-www-form-urlencoded' } }, res => { res.resume(); res.on('end', () => resolve(res)); });
    request.on('error', reject);
    request.end(new URLSearchParams(body).toString());
  });
  try {
    const page = await hub.request('/settings?tab=pipeline');
    assert.match(page.text, /<input type="number" name="payloadRetentionDays" class="control-input" min="31" max="3650" step="1" value="90" required>/);
    const form = { pipelinePresent: '1', minimumMatchScore: '70', acceptedMatchLevels: 'high', maxReviewedPerRun: '60', hubPort: '4747', payloadRetentionDays: '120' };
    const saved = await post(form);
    assert.equal(saved.statusCode, 303);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).reports.payloadRetentionDays, 120);
    assert.match((await hub.request('/settings?tab=pipeline')).text, /name="payloadRetentionDays"[^>]*value="120"/);
    const rejected = await post({ ...form, payloadRetentionDays: '10' });
    assert.match(String(rejected.headers.location), /error=.*Payload%20retention|error=.*Payload\+retention/);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).reports.payloadRetentionDays, 120);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Status reads state/state.json once per change and without its seen map; the usage window gives the same totals', async () => {
  const root = await prepareReportProject();
  await addStatusFixture(root, { writePayload, fixturePayload, selectedMatches });
  const statePath = path.join(root, 'state', 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  await fs.writeFile(statePath, JSON.stringify({ ...state, seen: { 'https://jobs.example.com/x': { completed: true } } }));
  const stateReads = [];
  const io = { ...fs, readFile: (file, ...rest) => { if (String(file) === statePath) stateReads.push(file); return fs.readFile(file, ...rest); } };
  const hub = await startReportHub(root, { context: { io } });
  try {
    const first = await hub.request('/status');
    await hub.request('/status');
    await hub.request('/settings?tab=pipeline');
    assert.equal(stateReads.length, 1, 'parsed once for Status, the plan banner, and Settings');
    assert.equal(hub.ctx.stateView.value.seen, undefined);
    assert.equal(hub.ctx.stateView.value.lastSuccessfulRun, '2026-10-17T01:00:00.000Z');
    await fs.writeFile(statePath, JSON.stringify({ ...state, lastSuccessfulRun: '2026-10-17T02:00:00.000Z' }));
    await hub.request('/status');
    assert.equal(stateReads.length, 2, 'a changed file is read again');
    assert.equal(withoutHubCard(normalizeHtml(inlineAssets(first.text), { port: hub.port(), root })), await fs.readFile(new URL('status-page.html', snapshots), 'utf8'));
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
  const at = hours => new Date(Date.parse('2026-10-17T12:00:00Z') - hours * 3_600_000).toISOString();
  const entries = [0, 5, 13, 30, 47, 70, 100, 170, 200].map((hours, index) => ({ at: at(hours), purpose: 'review', model: 'claude-opus-5-5', engine: 'claude', calls: 1, input: 10 + index, output: 5, cacheRead: 0, cacheCreation: 0, reasoning: 0 }));
  const window = usageWindow({ entries }, { now: new Date('2026-10-17T12:00:00Z'), timeZone: 'America/Chicago', days: 7 });
  assert.deepEqual(window.nights.map(night => [night.date, night.calls]), [['2026-10-11', 0], ['2026-10-12', 0], ['2026-10-13', 1], ['2026-10-14', 1], ['2026-10-15', 1], ['2026-10-16', 2], ['2026-10-17', 2]], 'the values the earlier implementation gave');
  assert.equal(window.total.calls, 7);
});

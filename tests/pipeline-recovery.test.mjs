import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dedupeByFinalUrl, main, mergeReviewedJobs, preferReportJob, pruneReportPayloads, recoverIncompleteReports, reportPayloadPath } from '../src/index.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const NOW = '2026-08-27T12:00:00Z';

async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

async function prepareProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-alert-recovery-'));
  await fs.mkdir(path.join(root, 'intake'), { recursive: true });
  for (const name of ['data-resume.md', 'ai-resume.md']) await fs.copyFile(new URL(name, fixtures), path.join(root, name));
  await fs.copyFile(new URL('demo-new-grad-alert.eml', fixtures), path.join(root, 'intake', 'demo-new-grad-alert.eml'));
  const claudeLog = path.join(root, 'claude-calls.log');
  const fakeClaude = path.join(root, 'fake-claude.sh');
  await fs.writeFile(fakeClaude, `#!/bin/sh\necho "$@" >> "${claudeLog}"\nexit 1\n`, { mode: 0o755 });
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 20, requireFullDescription: true, minimumDescriptionCharacters: 200,
    semanticMatching: { engine: 'claude_subscription', claudeCommand: fakeClaude, required: true, batchSize: 6, acceptedMatchLevels: ['high'], timeoutMs: 30_000 },
    reports: { xlsx: { enabled: true, required: false } },
    outputDirectory: './output',
    resumes: { tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }, { id: 'ai', label: 'AI', profile: './ai-resume.md' }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, needsSponsorship: null, graduationDate: '2027-05', excludeTitleTerms: [] },
    sources: { simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false }, emailFiles: { enabled: true, directory: './intake' }, himalaya: { enabled: false }, careerOps: { enabled: false } },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
  };
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath, claudeLog };
}

async function addSecondEmail(root) {
  const source = await fs.readFile(new URL('demo-new-grad-alert.eml', fixtures), 'utf8');
  const variant = source
    .replace('Subject: New Grad Data Analyst - Example Analytics', 'Subject: New Grad BI Analyst - Example Analytics')
    .replace('https://www.example.com/careers/new-grad-data-analyst?utm_source=handshake', 'https://www.example.com/careers/new-grad-bi-analyst?utm_source=handshake')
    .replace('Date: Thu, 27 Aug 2026 07:30:00 -0500', 'Date: Thu, 27 Aug 2026 07:45:00 -0500');
  await fs.writeFile(path.join(root, 'intake', 'second-alert.eml'), variant);
}

function jobCards(html) {
  return [...html.matchAll(/<a class="apply" href="([^"]+)">/g)].map(match => match[1]);
}

async function claudeCalls(logPath) {
  try { return (await fs.readFile(logPath, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('an XLSX failure keeps the day payload incomplete; the next run rebuilds both files without re-scoring', async () => {
  const { root, configPath, claudeLog } = await prepareProject();
  const silence = console.log;
  console.log = () => {};
  try {
    const runDirectory = path.join(root, 'output', '2026-08-27');
    const xlsxPath = path.join(runDirectory, 'Daily Job Match Alert - 2026-08-27.xlsx');
    const htmlPath = path.join(runDirectory, 'Daily Job Match Alert - 2026-08-27.html');
    const statePath = path.join(root, 'state', 'state.json');
    const payloadPath = path.join(root, 'state', 'report-payload-2026-08-27.json');
    // A directory squatting on the xlsx name makes the workbook write fail while the HTML still lands.
    await fs.mkdir(xlsxPath, { recursive: true });

    await assert.rejects(main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', NOW] }));
    assert.ok(await exists(htmlPath), 'HTML report from the failed run is missing');
    assert.ok(await exists(path.join(runDirectory, 'XLSX-FAILED.txt')));
    const failedState = await readJson(statePath);
    assert.equal(failedState.lastSuccessfulRun, undefined, 'lastSuccessfulRun must not be recorded when the xlsx failed');
    assert.ok(Object.keys(failedState.seen).length >= 1, 'postings were still marked seen');
    const pending = await readJson(payloadPath);
    assert.equal(pending.complete, false);
    assert.equal(pending.meta.date, '2026-08-27');
    assert.equal(pending.meta.runsToday, 1);
    assert.ok(pending.matches.length >= 1, 'the failed run found no matches to carry');
    assert.equal(pending.reviewed.length, pending.meta.reviewedCount);
    assert.ok(!pending.meta.warnings.some(warning => warning.source === 'XLSX'), 'the stored payload must not carry the xlsx failure warning');
    const callsAfterFirstRun = await claudeCalls(claudeLog);
    assert.ok(callsAfterFirstRun >= 1, 'the first run should have tried the subscription CLI');

    await fs.rm(xlsxPath, { recursive: true, force: true });
    const second = await main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', '2026-08-27T13:00:00Z'] });
    assert.equal(await claudeCalls(claudeLog), callsAfterFirstRun, 'the same-day rerun must not call the subscription CLI again');
    assert.ok(await exists(xlsxPath), 'xlsx was not rebuilt');
    assert.ok(await exists(htmlPath));
    assert.equal(await exists(path.join(runDirectory, 'XLSX-FAILED.txt')), false, 'failure marker should be cleared');
    const completed = await readJson(payloadPath);
    assert.equal(completed.complete, true, 'day payload should be marked complete');
    assert.equal(completed.meta.runsToday, 2);
    const recoveredState = await readJson(statePath);
    assert.equal(recoveredState.lastSuccessfulRun, '2026-08-27T13:00:00.000Z');
    assert.equal(second.meta.matchCount, pending.meta.matchCount, 'the carried matches must survive the same-day rerun');
    assert.equal(second.meta.reviewedCount, pending.meta.reviewedCount);
    assert.equal(second.meta.newThisRun, 0);
    assert.equal(second.xlsxPath, xlsxPath);
    const html = await fs.readFile(htmlPath, 'utf8');
    assert.equal((html.match(/<article class="job">/g) || []).length, pending.meta.matchCount, 'final HTML must list the carried matches, not an empty rerun');
    assert.match(html, /Daily update #2/);
    assert.doesNotMatch(html, /XLSX generation failed/);
  } finally {
    console.log = silence;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a same-day rerun with zero new postings reproduces the earlier report instead of emptying it', async () => {
  const { root, configPath } = await prepareProject();
  const silence = console.log;
  console.log = () => {};
  try {
    const runDirectory = path.join(root, 'output', '2026-08-27');
    const htmlPath = path.join(runDirectory, 'Daily Job Match Alert - 2026-08-27.html');
    const first = await main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', NOW] });
    assert.ok(first.meta.matchCount >= 1, 'the first run produced no match to protect');
    const firstHtml = await fs.readFile(htmlPath, 'utf8');
    const firstXlsx = await fs.readFile(first.xlsxPath);
    assert.equal(first.meta.runsToday, 1);

    const second = await main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', '2026-08-27T13:30:00Z'] });
    assert.equal(second.meta.newThisRun, 0, 'every posting should already be seen');
    assert.equal(second.meta.matchCount, first.meta.matchCount);
    assert.equal(second.meta.reviewedCount, first.meta.reviewedCount);
    assert.equal(second.meta.runsToday, 2);
    assert.equal(second.meta.lastUpdatedAt, '2026-08-27T13:30:00.000Z');
    assert.equal(second.meta.firstGeneratedAt, first.meta.generatedAt);
    const secondHtml = await fs.readFile(htmlPath, 'utf8');
    assert.deepEqual(jobCards(secondHtml), jobCards(firstHtml), 'the job cards must be identical');
    assert.match(secondHtml, /Daily update #2/);
    assert.doesNotMatch(secondHtml, /No new jobs cleared the configured threshold/);
    const xlsxSize = (await fs.stat(second.xlsxPath)).size;
    assert.ok(Math.abs(xlsxSize - firstXlsx.length) < 2048, 'xlsx should carry the same rows');
    const payload = await readJson(reportPayloadPath({ root }, '2026-08-27'));
    assert.equal(payload.complete, true);
    assert.equal(payload.matches.length, first.meta.matchCount);
  } finally {
    console.log = silence;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a same-day rerun that finds a new posting appends it to the existing report without duplicates', async () => {
  const { root, configPath } = await prepareProject();
  const silence = console.log;
  console.log = () => {};
  try {
    const runDirectory = path.join(root, 'output', '2026-08-27');
    const htmlPath = path.join(runDirectory, 'Daily Job Match Alert - 2026-08-27.html');
    const first = await main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', NOW] });
    assert.equal(first.meta.matchCount, 1);

    await addSecondEmail(root);
    const second = await main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', '2026-08-27T13:30:00Z'] });
    assert.equal(second.meta.newThisRun, 1);
    assert.equal(second.meta.matchCount, 2);
    assert.equal(second.meta.reviewedCount, 2);
    assert.equal(second.meta.runsToday, 2);
    const cards = jobCards(await fs.readFile(htmlPath, 'utf8'));
    assert.equal(cards.length, 2);
    assert.equal(new Set(cards).size, 2, 'no duplicate cards');
    assert.ok(cards.some(url => url.includes('new-grad-data-analyst')));
    assert.ok(cards.some(url => url.includes('new-grad-bi-analyst')));

    const third = await main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', '2026-08-27T14:00:00Z'] });
    assert.equal(third.meta.newThisRun, 0);
    assert.equal(third.meta.matchCount, 2, 'a third run with nothing new keeps both');
    assert.equal(third.meta.runsToday, 3);
  } finally {
    console.log = silence;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recoverIncompleteReports rebuilds an earlier incomplete day, skips today, and discards a corrupt file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-alert-pending-'));
  const config = { root, outputDirectory: path.join(root, 'output'), reports: { xlsx: { enabled: true } } };
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  const earlier = reportPayloadPath(config, '2026-08-26');
  const today = reportPayloadPath(config, '2026-08-27');
  try {
    const job = { source: 'fixture', roleType: 'new_grad', company: 'Acme', title: 'Data Analyst', location: 'Remote - US', scores: { data: 80, ai: 60 }, bestScore: 80, recommendedTrack: 'data', recommendedResume: 'Data', reasons: [], gaps: [], blockers: [], description: 'x', url: 'https://example.com/jobs/1', matchLevel: 'high' };
    const meta = { date: '2026-08-26', applicationDate: '2026-08-26', generatedAt: '2026-08-25T20:00:00.000Z', lastUpdatedAt: '2026-08-25T20:00:00.000Z', runsToday: 1, lookbackHours: 24, warnings: [], reviewedCount: 1, matchCount: 1 };
    await fs.writeFile(earlier, JSON.stringify({ meta, matches: [job], reviewed: [job], complete: false }));
    await fs.writeFile(today, JSON.stringify({ meta: { ...meta, date: '2026-08-27', applicationDate: '2026-08-27' }, matches: [job], reviewed: [job], complete: false }));
    const state = { seen: {} };
    const warnings = [];
    const builds = [];
    const result = await recoverIncompleteReports(config, state, { warnings, currentDate: '2026-08-27', xlsxBuilder: async (payloadPath, xlsxPath) => { builds.push({ payloadPath, xlsxPath }); await fs.writeFile(xlsxPath, 'xlsx'); } });
    assert.deepEqual(result.map(item => [item.date, item.recovered]), [['2026-08-26', true]]);
    assert.equal(builds.length, 1, 'today is left to the normal flow');
    assert.equal(builds[0].xlsxPath, path.join(root, 'output', '2026-08-26', 'Daily Job Match Alert - 2026-08-26.xlsx'));
    assert.ok(await exists(result[0].htmlPath));
    assert.ok(await exists(builds[0].xlsxPath));
    assert.equal(await exists(builds[0].payloadPath), false, 'temporary payload directory must be cleaned up');
    assert.equal((await readJson(earlier)).complete, true, 'the day file stays, marked complete');
    assert.equal((await readJson(today)).complete, false);
    assert.equal(state.lastSuccessfulRun, '2026-08-25T20:00:00.000Z');
    assert.equal((await readJson(path.join(root, 'state', 'state.json'))).lastSuccessfulRun, '2026-08-25T20:00:00.000Z');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /Rebuilt the 2026-08-26 HTML and XLSX/);

    assert.deepEqual(await recoverIncompleteReports(config, state, { warnings, currentDate: '2026-08-27' }), [], 'complete days are not rebuilt again');

    await fs.writeFile(earlier, '{not json');
    const discarded = await recoverIncompleteReports(config, state, { warnings, currentDate: '2026-08-27' });
    assert.deepEqual(discarded, []);
    assert.equal(await exists(earlier), false);
    assert.match(warnings.at(-1).message, /Discarded an unreadable report-payload-2026-08-26\.json/);

    await fs.writeFile(earlier, JSON.stringify({ meta, matches: [job], reviewed: [job], complete: false }));
    const failing = [];
    const kept = await recoverIncompleteReports(config, state, { warnings: failing, currentDate: '2026-08-27', xlsxBuilder: async () => { throw new Error('disk full'); } });
    assert.equal(kept[0].recovered, false);
    assert.equal((await readJson(earlier)).complete, false, 'a failed rebuild keeps the day incomplete');
    assert.match(failing[0].message, /kept for the next run.*disk full/);

    await fs.writeFile(reportPayloadPath(config, '2026-05-01'), JSON.stringify({ meta: { date: '2026-05-01' }, matches: [], reviewed: [], complete: true }));
    assert.equal(await pruneReportPayloads(config, new Date('2026-08-27T20:00:00Z'), 90), 1);
    assert.equal(await exists(reportPayloadPath(config, '2026-05-01')), false);
    assert.ok(await exists(earlier));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mergeReviewedJobs keys on the resolved URL and keeps the better-informed copy', () => {
  const local = { url: 'https://jobs.example.com/a', finalUrl: 'https://jobs.example.com/a', description: 'short', bestScore: 50, semanticReviewed: false };
  const reviewed = { url: 'https://track.example.com/x', finalUrl: 'https://jobs.example.com/a?utm_source=x', description: 'short', bestScore: 80, semanticReviewed: true };
  const longer = { url: 'https://jobs.example.com/a', finalUrl: 'https://jobs.example.com/a', description: 'a much longer captured description', bestScore: 55, semanticReviewed: false };
  const other = { url: 'https://jobs.example.com/b', description: 'b', bestScore: 60 };
  assert.equal(preferReportJob(local, reviewed), reviewed, 'semantic review beats a local score');
  assert.equal(preferReportJob(reviewed, local), reviewed);
  assert.equal(preferReportJob(local, longer), longer, 'longer description wins among equals');
  assert.equal(preferReportJob(longer, local), longer);
  const merged = mergeReviewedJobs([local, other], [reviewed, other]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], reviewed);
  assert.equal(merged[1], other);
  assert.deepEqual(mergeReviewedJobs([], [local]), [local]);
});

test('dedupeByFinalUrl keeps the first posting per resolved URL and reports the dropped ones', () => {
  const jobs = [
    { url: 'https://alerts.example.com/a?id=1', originalUrl: 'https://alerts.example.com/a?id=1', finalUrl: 'https://jobs.example.com/data-analyst', source: 'Handshake email alert' },
    { url: 'https://simplify.jobs/p/xyz', originalUrl: 'https://simplify.jobs/p/xyz', finalUrl: 'https://jobs.example.com/data-analyst?utm_source=simplify', source: 'SimplifyJobs New Grad' },
    { url: 'https://jobs.example.com/ml-engineer', originalUrl: 'https://jobs.example.com/ml-engineer', source: 'SimplifyJobs New Grad' },
    { url: 'https://jobs.example.com/failed', originalUrl: 'https://jobs.example.com/failed', enrichment: 'failed', source: 'SimplifyJobs New Grad' },
  ];
  const { jobs: kept, dropped } = dedupeByFinalUrl(jobs);
  assert.equal(kept.length, 3);
  assert.equal(kept[0].source, 'Handshake email alert | SimplifyJobs New Grad');
  assert.equal(kept[0].finalUrl, 'https://jobs.example.com/data-analyst');
  assert.deepEqual(dropped, [{
    url: 'https://simplify.jobs/p/xyz',
    finalUrl: 'https://jobs.example.com/data-analyst?utm_source=simplify',
    source: 'SimplifyJobs New Grad',
    duplicateOf: 'https://alerts.example.com/a?id=1',
  }]);
});

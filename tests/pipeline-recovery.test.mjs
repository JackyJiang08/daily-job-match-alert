import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dedupeByFinalUrl, main, recoverPendingReport } from '../src/index.mjs';

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
    resumes: { data: './data-resume.md', ai: './ai-resume.md' },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, needsSponsorship: null, graduationDate: '2027-05', excludeTitleTerms: [] },
    sources: { simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false }, emailFiles: { enabled: true, directory: './intake' }, himalaya: { enabled: false }, careerOps: { enabled: false } },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
  };
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath, claudeLog };
}

async function claudeCalls(logPath) {
  try { return (await fs.readFile(logPath, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('an XLSX failure keeps the payload pending; the next run rebuilds both files without re-scoring', async () => {
  const { root, configPath, claudeLog } = await prepareProject();
  const silence = console.log;
  console.log = () => {};
  try {
    const runDirectory = path.join(root, 'output', '2026-08-27');
    const xlsxPath = path.join(runDirectory, 'Daily Job Match Alert - 2026-08-27.xlsx');
    const htmlPath = path.join(runDirectory, 'Daily Job Match Alert - 2026-08-27.html');
    const statePath = path.join(root, 'state', 'state.json');
    const pendingPath = path.join(root, 'state', 'pending-report.json');
    // A directory squatting on the xlsx name makes the workbook write fail while the HTML still lands.
    await fs.mkdir(xlsxPath, { recursive: true });

    await assert.rejects(main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', NOW] }));
    assert.ok(await exists(htmlPath), 'HTML report from the failed run is missing');
    assert.ok(await exists(path.join(runDirectory, 'XLSX-FAILED.txt')));
    const failedState = await readJson(statePath);
    assert.equal(failedState.lastSuccessfulRun, undefined, 'lastSuccessfulRun must not be recorded when the xlsx failed');
    assert.ok(Object.keys(failedState.seen).length >= 1, 'postings were still marked seen');
    const pending = await readJson(pendingPath);
    assert.equal(pending.meta.date, '2026-08-27');
    assert.ok(pending.matches.length >= 1, 'the failed run found no matches to carry');
    assert.equal(pending.reviewed.length, pending.meta.reviewedCount);
    const callsAfterFirstRun = await claudeCalls(claudeLog);
    assert.ok(callsAfterFirstRun >= 1, 'the first run should have tried the subscription CLI');

    await fs.rm(xlsxPath, { recursive: true, force: true });
    const second = await main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', '2026-08-27T13:00:00Z'] });
    assert.equal(await claudeCalls(claudeLog), callsAfterFirstRun, 'recovery and the same-day rerun must not call the subscription CLI again');
    assert.equal(second.debug.pendingReport.recovered, true);
    assert.equal(second.debug.pendingReport.date, '2026-08-27');
    assert.ok(await exists(xlsxPath), 'xlsx was not rebuilt');
    assert.ok(await exists(htmlPath));
    assert.equal(await exists(path.join(runDirectory, 'XLSX-FAILED.txt')), false, 'failure marker should be cleared');
    assert.equal(await exists(pendingPath), false, 'pending payload should be consumed');
    const recoveredState = await readJson(statePath);
    assert.equal(recoveredState.lastSuccessfulRun, '2026-08-27T13:00:00.000Z');
    assert.equal(second.meta.matchCount, pending.meta.matchCount, 'the carried matches must survive the same-day rerun');
    assert.equal(second.meta.reviewedCount, pending.meta.reviewedCount);
    assert.equal(second.xlsxPath, xlsxPath);
    assert.ok(second.meta.warnings.some(warning => warning.source === 'pending report' && /Regenerated the 2026-08-27/.test(warning.message)));
    const html = await fs.readFile(htmlPath, 'utf8');
    assert.equal((html.match(/<article class="job">/g) || []).length, pending.meta.matchCount, 'final HTML must list the carried matches, not an empty rerun');
    assert.doesNotMatch(html, /XLSX generation failed/);
  } finally {
    console.log = silence;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recoverPendingReport rebuilds a pending payload for an earlier date and discards a corrupt one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-alert-pending-'));
  const config = { root, outputDirectory: path.join(root, 'output'), reports: { xlsx: { enabled: true } } };
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  const pendingPath = path.join(root, 'state', 'pending-report.json');
  try {
    const job = { source: 'fixture', roleType: 'new_grad', company: 'Acme', title: 'Data Analyst', location: 'Remote - US', dataScore: 80, aiScore: 60, bestScore: 80, recommendedResume: 'Data', reasons: [], gaps: [], blockers: [], description: 'x', url: 'https://example.com/jobs/1', matchLevel: 'high' };
    const meta = { date: '2026-08-26', applicationDate: '2026-08-26', generatedAt: '2026-08-25T20:00:00.000Z', lookbackHours: 24, warnings: [], reviewedCount: 1, matchCount: 1 };
    await fs.writeFile(pendingPath, JSON.stringify({ meta, matches: [job], reviewed: [job] }));
    const state = { seen: {} };
    const warnings = [];
    const builds = [];
    const result = await recoverPendingReport(config, state, { warnings, xlsxBuilder: async (payloadPath, xlsxPath) => { builds.push({ payloadPath, xlsxPath }); await fs.writeFile(xlsxPath, 'xlsx'); } });
    assert.equal(result.recovered, true);
    assert.equal(result.date, '2026-08-26');
    assert.equal(builds.length, 1);
    assert.equal(builds[0].xlsxPath, path.join(root, 'output', '2026-08-26', 'Daily Job Match Alert - 2026-08-26.xlsx'));
    assert.ok(await exists(result.htmlPath));
    assert.ok(await exists(builds[0].xlsxPath));
    assert.equal(await exists(builds[0].payloadPath), false, 'temporary payload directory must be cleaned up');
    assert.equal(await exists(pendingPath), false);
    assert.equal(state.lastSuccessfulRun, '2026-08-25T20:00:00.000Z');
    assert.equal((await readJson(path.join(root, 'state', 'state.json'))).lastSuccessfulRun, '2026-08-25T20:00:00.000Z');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /Regenerated the 2026-08-26 HTML and XLSX/);

    assert.equal(await recoverPendingReport(config, state, { warnings }), null, 'nothing pending returns null');

    await fs.writeFile(pendingPath, '{not json');
    const discarded = await recoverPendingReport(config, state, { warnings });
    assert.equal(discarded, null);
    assert.equal(await exists(pendingPath), false);
    assert.match(warnings.at(-1).message, /Discarded an unreadable pending-report\.json/);

    await fs.writeFile(pendingPath, JSON.stringify({ meta, matches: [job], reviewed: [job] }));
    const failing = [];
    const kept = await recoverPendingReport(config, state, { warnings: failing, xlsxBuilder: async () => { throw new Error('disk full'); } });
    assert.equal(kept.recovered, false);
    assert.ok(await exists(pendingPath), 'a failed rebuild keeps the payload for the next run');
    assert.match(failing[0].message, /kept for the next run.*disk full/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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

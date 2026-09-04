// End-to-end runs of src/index.mjs with different resume track configurations: three tracks (the demo
// layout), a single track, a disabled track, and the legacy two-key layout that is migrated in memory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { main } from '../src/index.mjs';
import { jobScores, pickBestTrack, reportTracks, resumeTrackList } from '../src/resume-tracks.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const NOW = '2026-08-27T12:00:00Z';
const FIXTURE_FILES = { data: 'data-resume.md', ai: 'ai-resume.md', llm: 'llm-resume.md', agent: 'agent-resume.md' };

async function prepareProject(resumes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-alert-tracks-'));
  await fs.mkdir(path.join(root, 'intake'), { recursive: true });
  for (const name of Object.values(FIXTURE_FILES)) await fs.copyFile(new URL(name, fixtures), path.join(root, name));
  await fs.copyFile(new URL('demo-new-grad-alert.eml', fixtures), path.join(root, 'intake', 'demo-new-grad-alert.eml'));
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 20, requireFullDescription: true, minimumDescriptionCharacters: 200,
    semanticMatching: { engine: 'local_only' },
    reports: { xlsx: { enabled: true, required: false } },
    outputDirectory: './output',
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, needsSponsorship: null, graduationDate: '2027-05', excludeTitleTerms: [] },
    sources: { simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false }, emailFiles: { enabled: true, directory: './intake' }, himalaya: { enabled: false }, careerOps: { enabled: false } },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
    ...resumes,
  };
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath };
}

function track(id, label, enabled = true) {
  return { id, label, profile: `./${FIXTURE_FILES[id]}`, enabled };
}

async function runQuietly(configPath) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const stderr = [];
  console.log = () => {};
  console.error = (...args) => stderr.push(args.join(' '));
  console.warn = (...args) => stderr.push(args.join(' '));
  try {
    const summary = await main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', NOW] });
    return { summary, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

async function readOutputs(root, summary) {
  const html = await fs.readFile(summary.htmlPath, 'utf8');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(summary.xlsxPath);
  const matches = workbook.getWorksheet('Matches');
  const headers = [];
  matches.getRow(1).eachCell(cell => headers.push(String(cell.value)));
  const summaryRows = {};
  workbook.getWorksheet('Run Summary').eachRow(row => { if (typeof row.getCell(1).value === 'string') summaryRows[row.getCell(1).value] = row.getCell(2).value; });
  const payload = JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-08-27.json'), 'utf8'));
  return { html, matches, headers, summaryRows, payload };
}

test('three enabled tracks flow through extraction, scoring, and both reports end to end', async () => {
  const { root, configPath } = await prepareProject({ resumes: { autoRefresh: false, tracks: [track('data', 'Data'), track('llm', 'LLM'), track('agent', 'AI Agent')] } });
  try {
    const { summary, stderr } = await runQuietly(configPath);
    assert.ok(summary.meta.matchCount >= 1, 'the demo email did not produce a match');
    assert.deepEqual(summary.meta.resumeTracks, [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }, { id: 'agent', label: 'AI Agent' }]);
    assert.ok(stderr.some(line => /^Resume tracks: Data, LLM, AI Agent$/.test(line)), stderr.join('\n'));
    assert.ok(!stderr.some(line => /legacy/.test(line)), 'no legacy notice for the new layout');
    const { html, matches, headers, summaryRows, payload } = await readOutputs(root, summary);
    assert.deepEqual(headers, ['Company', 'Title', 'Location', 'Role Type', 'Posted At', 'Data Score', 'LLM Score', 'AI Agent Score', 'Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Posting Link']);
    assert.equal(matches.actualRowCount, summary.meta.matchCount + 1);
    assert.equal(summaryRows['Resume tracks'], 'Data, LLM, AI Agent');
    assert.match(html, /Resume tracks: Data · LLM · AI Agent/);
    assert.match(html, /<span>Data \d+<\/span><span>LLM \d+<\/span><span>AI Agent \d+<\/span><span>Use Data<\/span>/);
    const job = payload.matches[0];
    assert.deepEqual(Object.keys(job.scores), ['data', 'llm', 'agent']);
    assert.equal(job.recommendedTrack, 'data');
    assert.equal(job.recommendedResume, 'Data');
    assert.equal(job.bestScore, Math.max(...Object.values(job.scores)));
    assert.equal(matches.getCell('I2').value.result, 'Data');
    assert.equal(job.dataScore, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a single enabled track produces a complete report with one score column', async () => {
  const { root, configPath } = await prepareProject({ resumes: { tracks: [track('data', 'Data')] } });
  try {
    const { summary } = await runQuietly(configPath);
    assert.ok(summary.meta.matchCount >= 1);
    assert.deepEqual(summary.meta.resumeTracks, [{ id: 'data', label: 'Data' }]);
    const { html, headers, summaryRows, payload } = await readOutputs(root, summary);
    assert.deepEqual(headers, ['Company', 'Title', 'Location', 'Role Type', 'Posted At', 'Data Score', 'Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Posting Link']);
    assert.equal(summaryRows['Resume tracks'], 'Data');
    assert.match(html, /<span>Data \d+<\/span><span>Use Data<\/span>/);
    assert.deepEqual(Object.keys(payload.matches[0].scores), ['data']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a disabled track is neither loaded nor scored and never appears in the reports', async () => {
  const { root, configPath } = await prepareProject({ resumes: { tracks: [track('data', 'Data'), track('agent', 'AI Agent', false), track('llm', 'LLM')] } });
  // The disabled track's profile is removed: the run must not even try to read it.
  await fs.rm(path.join(root, FIXTURE_FILES.agent));
  try {
    const { summary, stderr } = await runQuietly(configPath);
    assert.deepEqual(summary.meta.resumeTracks, [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }]);
    assert.ok(stderr.some(line => /^Resume tracks: Data, LLM \(disabled: AI Agent\)$/.test(line)), stderr.join('\n'));
    const { html, headers, summaryRows, payload } = await readOutputs(root, summary);
    assert.deepEqual(headers, ['Company', 'Title', 'Location', 'Role Type', 'Posted At', 'Data Score', 'LLM Score', 'Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Posting Link']);
    assert.equal(summaryRows['Resume tracks'], 'Data, LLM');
    assert.doesNotMatch(html, /AI Agent/);
    assert.doesNotMatch(JSON.stringify(payload), /"agent"/);
    assert.deepEqual(Object.keys(payload.matches[0].scores), ['data', 'llm']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the legacy resumes + resumeSources layout still runs, with an upgrade notice and the Data / AI columns', async () => {
  const { root, configPath } = await prepareProject({
    resumes: { data: `./${FIXTURE_FILES.data}`, ai: `./${FIXTURE_FILES.ai}` },
    resumeSources: { autoRefresh: false, pdftotextCommand: 'pdftotext', dataPdf: '~/Desktop/DA.pdf', aiPdf: '~/Desktop/AI.pdf' },
  });
  try {
    const { summary, stderr } = await runQuietly(configPath);
    assert.ok(stderr.some(line => /legacy "resumes": \{ data, ai \} \+ "resumeSources" layout/.test(line)), stderr.join('\n'));
    assert.deepEqual(summary.meta.resumeTracks, [{ id: 'data', label: 'Data' }, { id: 'ai', label: 'AI' }]);
    const { headers, summaryRows } = await readOutputs(root, summary);
    assert.deepEqual(headers, ['Company', 'Title', 'Location', 'Role Type', 'Posted At', 'Data Score', 'AI Score', 'Recommended Resume', 'Why It Matches', 'Gaps / Verify', 'Posting Link']);
    assert.equal(summaryRows['Resume tracks'], 'Data, AI');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an all-disabled track list fails before any report is written', async () => {
  const { root, configPath } = await prepareProject({ resumes: { tracks: [track('data', 'Data', false), track('llm', 'LLM', false)] } });
  try {
    await assert.rejects(runQuietly(configPath), /all tracks are missing or disabled/);
    await assert.rejects(fs.access(path.join(root, 'output')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('track helpers accept both track lists and legacy score fields', () => {
  assert.deepEqual(resumeTrackList({ data: 'D', ai: 'A' }), [{ id: 'data', label: 'Data', text: 'D' }, { id: 'ai', label: 'AI', text: 'A' }]);
  assert.deepEqual(jobScores({ dataScore: 1, aiScore: 2 }), { data: 1, ai: 2 });
  assert.deepEqual(jobScores({ scores: { llm: 5 } }), { llm: 5 });
  assert.deepEqual(reportTracks({ resumeTracks: [{ id: 'llm', label: 'LLM' }] }, [{ scores: { data: 1 } }]), [{ id: 'llm', label: 'LLM' }]);
  assert.deepEqual(reportTracks({}, [{ scores: { llm: 3, agent: 4 } }, { scores: { data: 1 } }]), [{ id: 'llm', label: 'Llm' }, { id: 'agent', label: 'Agent' }, { id: 'data', label: 'Data' }]);
  assert.deepEqual(reportTracks({}, []), [{ id: 'data', label: 'Data' }, { id: 'ai', label: 'AI' }]);
  assert.deepEqual(pickBestTrack({ a: 5, b: 9, c: 9 }, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]), { id: 'b', label: 'B', score: 9 });
  assert.deepEqual(pickBestTrack({}, [{ id: 'a', label: 'A' }]), { id: 'a', label: 'A', score: 0 });
});

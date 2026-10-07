// Cover letters written automatically after the nightly run: selection (new high matches, best first,
// existing letters and uncertain companies skipped, capped), the stage assignments (engine, model, effort)
// in use, the fallback chain and the stop on failure, the letters lock, and the timing against the report
// (written and unlocked first). Every engine is a fake; the timing test scores with the chaos fake CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { autoLetterSettings, lettersLockPath, readLettersStatus, runAutoLetters, selectAutoLetters } from '../src/auto-letters.mjs';
import { createHubContext } from '../src/hub/server.mjs';
import { jobIdOf, letterCompanyFor } from '../src/hub/letters.mjs';
import { main } from '../src/index.mjs';
import { runDetailsView } from '../src/report.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const projectDirectory = path.dirname(new URL('../package.json', import.meta.url).pathname);
const PROFILE = { name: 'Jane Doe', phone: '555-0100', email: 'jane.doe@example.com', signatureName: 'Jane Doe' };
const NOW = '2026-09-15T15:00:00Z';
const WORDS = ['data', 'model', 'team', 'built', 'shipped', 'metric', 'query', 'result', 'plan', 'growth', 'weekly', 'report'];
const fiveParagraphs = (each = 100) => Array.from({ length: 5 }, (_, index) => `Paragraph ${index + 1} ${Array.from({ length: each - 2 }, (__, i) => WORDS[i % WORDS.length]).join(' ')}.`);

function job(index, extra = {}) {
  return {
    url: `https://example.com/jobs/${index}`, title: `Data Analyst ${index}`, company: `Example Co ${index}`, companySource: 'source', location: 'Remote - US',
    roleType: 'new_grad', bestScore: 70 + index, scores: { data: 70 + index }, recommendedTrack: 'data', recommendedResume: 'Data', matchLevel: 'high', semanticReviewed: true,
    reasons: ['SQL'], gaps: [], blockers: [], description: 'Use SQL and Python to answer product questions every week.', ...extra,
  };
}

async function prepareProject({ matches, letterAssignments = null, autoGenerate = null }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-letters-'));
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  for (const name of ['data-resume.md', 'llm-resume.md']) await fs.copyFile(new URL(name, fixtures), path.join(root, name));
  const config = {
    timeZone: 'America/Chicago', semanticMatching: { engine: 'claude', models: { claude: 'fable' } },
    resumes: { autoRefresh: false, tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md', enabled: true }, { id: 'llm', label: 'LLM', profile: './llm-resume.md', enabled: true }] },
    preferences: { graduationDate: '2027-05' }, outputDirectory: './out',
    ...(letterAssignments ? { models: { assignments: letterAssignments } } : {}),
    ...(autoGenerate ? { coverLetter: { autoGenerate } } : {}),
  };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));
  const meta = { date: '2026-09-15', applicationDate: '2026-09-15', generatedAt: NOW, lookbackHours: 24, runsToday: 1, resumeTracks: [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }], scoringModel: 'claude-fable-5-1', warnings: [], matchCount: matches.length };
  await fs.writeFile(path.join(root, 'state', 'report-payload-2026-09-15.json'), JSON.stringify({ meta, matches, reviewed: matches, complete: true }));
  return root;
}

// A hub context with fake letter engines; `behaviour(choice, kind)` may throw to simulate a refusal.
async function contextFor(root, { codexConnected = true, behaviour = null, calls = [] } = {}) {
  const engineFor = (choice = {}) => ({
    id: choice.engine || 'claude', label: choice.engine || 'claude', model: choice.model || 'claude-fable-5-1', effort: choice.effort || null,
    async generateText(prompt) {
      const kind = prompt.startsWith('EDITOR REVIEW') ? 'editor' : prompt.startsWith('CONDENSE') ? 'condense' : 'draft';
      calls.push({ engine: choice.engine, model: choice.model, effort: choice.effort || null, kind });
      if (behaviour) behaviour(choice, kind);
      const usage = { engine: choice.engine || 'claude', effort: choice.effort || null, models: [{ model: choice.model || 'x', input: 100, output: 40, cacheRead: 0, cacheCreation: 0, reasoning: 0 }] };
      if (kind === 'editor') return { output: { issues: [], revised_paragraphs: [] }, scoringModel: choice.model, usage };
      return { output: { paragraphs: fiveParagraphs(100) }, scoringModel: choice.model, usage };
    },
  });
  const ctx = createHubContext({
    configPath: path.join(root, 'config.json'), now: () => new Date(NOW), homedir: root, chromeCommand: false,
    pidAlive: () => false, letterEngine: engineFor(),
    describeConnections: async () => ({ claude: { installed: true, connected: true, detail: 'Claude · Max' }, codex: { installed: true, connected: codexConnected, detail: 'Codex · ChatGPT' } }),
  });
  ctx.makeLetterEngine = engineFor;
  await ctx.letterStore.saveProfileFields(PROFILE);
  await ctx.letterStore.savePlaybook({ filename: 'playbook.md', data: Buffer.from(`# Playbook\n${'Real evidence line. '.repeat(10)}`) });
  return { ctx, calls };
}

test('settings default to on with up to 8 letters; selection takes this run\'s new matches, best first, and skips letters on file, uncertain companies, and the overflow', () => {
  assert.deepEqual(autoLetterSettings({}), { enabled: true, maxPerRun: 8 });
  assert.deepEqual(autoLetterSettings({ coverLetter: { autoGenerate: { enabled: false, maxPerRun: 3 } } }), { enabled: false, maxPerRun: 3 });
  assert.equal(autoLetterSettings({ coverLetter: { autoGenerate: { maxPerRun: -2 } } }).maxPerRun, 8, 'a bad value falls back');
  const matches = [job(1), job(9), job(5), job(7, { companyUncertain: true, company: '100000 Example', companySource: 'url' }), job(3), job(2)];
  const lettersByJob = new Map([[jobIdOf(job(5)), { jobId: jobIdOf(job(5)) }]]);
  const newMatchUrls = matches.filter(item => item.url !== job(2).url).map(item => item.url);
  const result = selectAutoLetters({ matches, newMatchUrls, lettersByJob, max: 2, jobIdOf, companyFor: letterCompanyFor });
  assert.deepEqual(result.picked.map(item => [item.company, item.bestScore]), [['Example Co 9', 79], ['Example Co 3', 73]], 'best scores first, earlier days\' matches left out');
  assert.deepEqual(result.skipped, { existing: 1, uncertain: 1, overLimit: 1 });
});

test('a pass writes the letters on the draft and editor assignments (engine, model, effort), records them, counts usage, and reports back', async () => {
  const matches = [job(1), job(2), job(3)];
  const root = await prepareProject({ matches, autoGenerate: { enabled: true, maxPerRun: 2 } });
  try {
    const { ctx, calls } = await contextFor(root);
    const reports = [];
    const warnings = [];
    const outcome = await runAutoLetters({ config: await ctx.loadConfig(), date: '2026-09-15', newMatchUrls: matches.map(item => item.url), ctx, warnings, updateReport: async summary => { reports.push(summary); } });
    assert.equal(outcome.state, 'done');
    assert.deepEqual([outcome.generated, outcome.failed, outcome.planned], [2, 0, 2]);
    assert.deepEqual(calls.filter(call => call.kind !== 'condense').map(call => [call.engine, call.model, call.effort, call.kind]), [
      ['codex', 'gpt-5.6-sol', 'medium', 'draft'], ['codex', 'gpt-5.6-sol', 'high', 'editor'],
      ['codex', 'gpt-5.6-sol', 'medium', 'draft'], ['codex', 'gpt-5.6-sol', 'high', 'editor'],
    ], 'the default stage assignments: draft at medium effort, editor at high');
    const letters = await ctx.letterStore.listLetters();
    assert.deepEqual(letters.map(letter => letter.company).sort(), ['Example Co 2', 'Example Co 3'], 'the two best scores');
    const record = letters[0];
    assert.deepEqual([record.source, record.engine, record.model, record.effort, record.reviewEngine, record.reviewModel, record.reviewEffort], ['auto', 'codex', 'gpt-5.6-sol', 'medium', 'codex', 'gpt-5.6-sol', 'high']);
    assert.ok(record.pdf, 'the PDF was rendered');
    assert.deepEqual(outcome.engines, ['codex · gpt-5.6-sol (medium)']);
    assert.equal(outcome.usage.calls, 4, 'only this pass\'s calls, tagged auto-letters');
    const status = await readLettersStatus(root);
    assert.deepEqual([status.state, status.current, status.generated.length, status.skipped.overLimit], ['done', null, 2, 1]);
    assert.equal(existsSync(lettersLockPath(root)), false, 'the letters lock is released');
    assert.equal(reports.length, 1);
    const rows = runDetailsView([], { date: '2026-09-15', resumeTracks: [], warnings: [], autoLetters: reports[0] }, []).rows;
    assert.match(rows.find(row => row.term === 'Automatic cover letters').detail, /^2 generated · 0 failed · codex · gpt-5\.6-sol \(medium\) · 400 in · 160 out \(4 calls\)$/);
    // The next pass finds letters on file and writes only the remaining posting.
    calls.length = 0;
    const second = await runAutoLetters({ config: await ctx.loadConfig(), date: '2026-09-15', newMatchUrls: matches.map(item => item.url), ctx });
    assert.deepEqual([second.generated, second.skipped.existing], [1, 2]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('without Codex the chain falls back to Claude Opus and notes it; a chain that fails completely stops the pass with a warning', async () => {
  const matches = [job(1), job(2), job(3)];
  const root = await prepareProject({ matches });
  try {
    const offline = await contextFor(root, { codexConnected: false });
    const outcome = await runAutoLetters({ config: await offline.ctx.loadConfig(), date: '2026-09-15', newMatchUrls: matches.map(item => item.url), ctx: offline.ctx });
    assert.equal(outcome.generated, 3);
    assert.ok(offline.calls.every(call => call.engine === 'claude' && call.model === 'claude-opus-5-5'), 'every call on the fallback');
    const letter = (await offline.ctx.letterStore.listLetters())[0];
    assert.equal(letter.editorNotes[0], 'Cover letter draft: Codex is not connected; used claude-opus-5-5 from the fallback chain');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  const root2 = await prepareProject({ matches });
  try {
    // The first posting's draft fails on Codex but Opus answers; the second fails on both: the pass stops.
    let drafts = 0;
    const failing = await contextFor(root2, {
      behaviour: (choice, kind) => {
        if (kind !== 'draft') return;
        drafts += 1;
        if (choice.engine === 'codex') throw new Error('codex exited 1: You have reached your usage limit');
        if (drafts > 2) throw new Error("claude exited 1: You've reached your Opus limit.");
      },
    });
    const warnings = [];
    const outcome = await runAutoLetters({ config: await failing.ctx.loadConfig(), date: '2026-09-15', newMatchUrls: matches.map(item => item.url), ctx: failing.ctx, warnings });
    assert.deepEqual([outcome.state, outcome.generated, outcome.failed], ['stopped', 1, 1]);
    assert.match(outcome.stopReason, /^stopped after Example Co 2 failed:/);
    assert.match(warnings[0].message, /stopped after Example Co 2 failed: .*; 1 remaining posting\(s\) keep their Generate Cover Letter button/);
    const written = await failing.ctx.letterStore.listLetters();
    assert.deepEqual(written.map(letter => letter.company), ['Example Co 3']);
    assert.match(written[0].editorNotes.join('\n'), /Cover letter draft: gpt-5\.6-sol failed \(.*usage limit.*\); used claude-opus-5-5/);
  } finally {
    await fs.rm(root2, { recursive: true, force: true });
  }
});

test('the pass is off for a local-only config, incomplete material, or the setting; a held letters lock skips it', async () => {
  const matches = [job(1)];
  const root = await prepareProject({ matches });
  try {
    const { ctx, calls } = await contextFor(root);
    const config = await ctx.loadConfig();
    assert.equal((await runAutoLetters({ config: { ...config, semanticMatching: { engine: 'local_only' } }, date: '2026-09-15', ctx })).state, 'off');
    assert.equal((await runAutoLetters({ config: { ...config, coverLetter: { autoGenerate: { enabled: false } } }, date: '2026-09-15', ctx })).state, 'off');
    await fs.writeFile(lettersLockPath(root), '4242\n');
    const warnings = [];
    const busy = await runAutoLetters({ config, date: '2026-09-15', ctx, lockOptions: { pidAlive: pid => pid === 4242 }, warnings });
    assert.deepEqual([busy.state, busy.pid], ['busy', 4242]);
    assert.match(warnings[0].message, /another letters pass \(PID 4242\) holds the letters lock/);
    assert.equal(calls.length, 0, 'no engine was asked');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('after a full run the report is on disk and the run lock released before the first letter call, which holds the letters lock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-letters-run-'));
  try {
    await fs.mkdir(path.join(root, 'intake'), { recursive: true });
    // Alert emails carry no company name; a board URL gives the posting a certain one (Exampleanalytics).
    const email = (await fs.readFile(new URL('demo-new-grad-alert.eml', fixtures), 'utf8')).replace('https://www.example.com/careers/new-grad-data-analyst?utm_source=handshake', 'https://boards.greenhouse.io/exampleanalytics/jobs/4200001');
    await fs.writeFile(path.join(root, 'intake', 'demo-new-grad-alert.eml'), email);
    for (const name of ['data-resume.md', 'llm-resume.md', 'agent-resume.md']) await fs.copyFile(new URL(name, fixtures), path.join(root, name));
    const demo = JSON.parse(await fs.readFile(new URL('config.demo.json', fixtures), 'utf8'));
    const config = {
      ...demo, outputDirectory: './out', sources: { ...demo.sources, emailFiles: { enabled: true, directory: './intake' }, atsBoards: { enabled: false } },
      semanticMatching: { engine: 'claude', claudeCommand: path.join(projectDirectory, 'scripts', 'chaos', 'fake-claude.sh'), models: { claude: 'fable' }, required: true, batchSize: 6, acceptedMatchLevels: ['high'], timeoutMs: 30_000, quotaPolicy: { fallbackEngine: null } },
    };
    const configPath = path.join(root, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    const observed = [];
    const { ctx } = await contextFor(root, {
      behaviour: (choice, kind) => {
        if (kind !== 'draft' || observed.length) return;
        const out = path.join(root, 'out');
        observed.push({
          html: existsSync(out) && JSON.stringify(require_dir(out)).includes('.html'),
          runLock: existsSync(path.join(root, 'state', '.lock')),
          lettersLock: existsSync(lettersLockPath(root)),
        });
      },
    });
    const summary = await main({ argv: ['node', 'index.mjs', '--config', configPath, '--now', '2026-08-27T12:00:00Z'], lettersContext: ctx });
    assert.ok(summary.meta.matchCount >= 1, 'the fake CLI produced a match');
    assert.deepEqual(observed, [{ html: true, runLock: false, lettersLock: true }], 'report first, run lock free, letters under their own lock');
    assert.equal(summary.autoLetters.generated, summary.meta.matchCount);
    const payload = JSON.parse(await fs.readFile(path.join(root, 'state', `report-payload-${summary.meta.date}.json`), 'utf8'));
    assert.equal(payload.meta.autoLetters.generated, summary.meta.matchCount, 'the outcome reaches the payload');
    const html = await fs.readFile(summary.htmlPath, 'utf8');
    assert.match(html, /<dt>Automatic cover letters<\/dt><dd>\d+ generated · 0 failed · codex · gpt-5\.6-sol \(medium\)/, 'and the Desktop report');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Synchronous directory listing (names only), recursive.
function require_dir(directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    out.push(name);
    if (statSync(full).isDirectory()) out.push(...require_dir(full));
  }
  return out;
}

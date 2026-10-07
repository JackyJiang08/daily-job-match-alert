// The prescreen (two-step scoring): resume digests cached by hash, batches of 25, threshold and ordering,
// shadow mode with recall, the owner's switch to enforced mode, and the fallback when the prescreen fails.
// Fake engines only; no CLI is ever called.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyReviewBudget } from '../src/index.mjs';
import { JD_CHARACTERS, buildPrescreenPrompt, describePrescreen, finishPrescreen, funnelText, prescreenMode, prescreenOverview, prescreenSettings, prescreenStage, semanticIdOf } from '../src/prescreen.mjs';
import { DIGEST_LIMIT, buildDigest, digestPath, ensureDigests } from '../src/resume-digest.mjs';
import { isJobSeen } from '../src/state.mjs';
import { runDetailsView } from '../src/report.mjs';
import { createHubContext } from '../src/hub/server.mjs';
import { readSettings, savePrescreen } from '../src/hub/services.mjs';
import { lightestModelId } from '../src/engines/catalog.mjs';

const NOW = new Date('2026-10-07T03:00:00Z');
const DATE = '2026-10-06';
const RESUME = [
  '# Jane Doe',
  '## Skills',
  'Python, SQL, pandas, Tableau, dbt, Snowflake, A/B testing',
  '## Projects',
  '- Churn Forecast: gradient boosting model that cut churn 12% across 40k accounts',
  '- Example Corp dashboard: Tableau suite used by 300 analysts every week',
  '- Survey pipeline: cleaned and joined five sources in dbt',
  '## Education',
  'Example University, M.S. Statistics, GPA 3.9, May 2027',
].join('\n');

function job(id, extra = {}) {
  return { url: `https://jobs.example.com/${id}`, title: `Data Analyst ${id}`, company: 'Example Corp', location: 'Remote, US', roleType: 'new_grad', description: `Role ${id}. ${'Analyze data with SQL. '.repeat(120)}`, bestScore: 50, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], postedAt: '2026-10-06T20:00:00Z', ...extra };
}

// Scores each posting from a table keyed by its URL id; records every prompt.
function fakeEngine(scoreFor, { fail = null } = {}) {
  const calls = [];
  return {
    calls,
    model: 'gpt-5.6-luna',
    async verifyAuth() { if (fail === 'login') throw new Error('Codex is not signed in'); },
    async reviewBatch(prompt, schema) {
      calls.push({ prompt, schema });
      if (fail === 'limit') throw new Error("You've hit your usage limit");
      if (fail === 'parse') return { results: 'not an array' };
      const { jobs } = JSON.parse(prompt.slice(prompt.lastIndexOf('Postings (JSON):') + 'Postings (JSON):'.length));
      return {
        results: jobs.map(item => ({ id: item.id, prescreenScore: scoreFor(item), bestTrack: 'data' })),
        scoringModel: 'gpt-5.6-luna',
        usage: { engine: 'codex', effort: 'low', models: [{ model: 'gpt-5.6-luna', input: 1000, output: 50, cacheRead: 0, cacheCreation: 0, reasoning: 0 }] },
      };
    },
  };
}

const scoreByTitle = table => item => table[item.title.replace('Data Analyst ', '')] ?? 70;

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'prescreen-'));
}

function stageOptions(root, overrides = {}) {
  return {
    config: { root, semanticMatching: { engine: 'claude' }, prescreen: { enabled: true, threshold: 55, shadowRuns: 3, enforce: false }, ...(overrides.config || {}) },
    state: overrides.state || { seen: {} },
    resumes: [{ id: 'data', label: 'Data', text: RESUME }],
    tracks: [{ id: 'data', label: 'Data' }],
    date: overrides.date || DATE, now: NOW, warnings: overrides.warnings || [],
    makeEngine: overrides.makeEngine,
  };
}

test('the digest keeps skills, project names, and numbers within about 1,200 characters, and is rebuilt only when the resume hash changes', async () => {
  const digest = buildDigest(RESUME);
  assert.ok(digest.length <= DIGEST_LIMIT);
  assert.match(digest, /^Skills: [^\n]*\bpython\b/i);
  assert.match(digest, /^Skills: [^\n]*\bsql\b/i);
  assert.match(digest, /Churn Forecast: .*12%.*40k/);
  assert.match(digest, /GPA 3\.9/);
  assert.match(digest, /Projects/);
  assert.ok(buildDigest(`${RESUME}\n${'- Built a 99-step pipeline for another long project line here\n'.repeat(80)}`).length <= DIGEST_LIMIT, 'a long resume is cut at the limit');

  const root = await tempRoot();
  try {
    const resumes = [{ id: 'data', text: RESUME }, { id: 'llm', text: `${RESUME}\nLLM evaluation harness for 3 models` }];
    const first = await ensureDigests(root, resumes);
    assert.deepEqual(first.rebuilt, ['data', 'llm']);
    assert.match(await fs.readFile(digestPath(root, 'data'), 'utf8'), /^<!-- sha256: [0-9a-f]{64} -->\nSkills:/);
    assert.equal(digestPath(root, 'data'), path.join(root, 'resumes', 'data.digest.md'));
    const second = await ensureDigests(root, resumes);
    assert.deepEqual(second.rebuilt, [], 'unchanged resumes reuse the cache');
    assert.deepEqual(second.digests, first.digests);
    const third = await ensureDigests(root, [{ id: 'data', text: `${RESUME}\n- New project: 5x faster ETL` }, resumes[1]]);
    assert.deepEqual(third.rebuilt, ['data'], 'only the changed track is rebuilt');
    assert.match(third.digests.data, /5x faster ETL/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the prompt carries title, company, location, role type, the first 1,500 JD characters, and every digest; batches hold 25 postings', async () => {
  const batch = [{ ...job('a'), semanticId: 'id-a' }];
  const prompt = buildPrescreenPrompt(batch, [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }], { data: 'DATA DIGEST', llm: 'LLM DIGEST' });
  assert.match(prompt, /DATA DIGEST[\s\S]*LLM DIGEST/);
  const posted = JSON.parse(prompt.slice(prompt.lastIndexOf('Postings (JSON):') + 'Postings (JSON):'.length)).jobs[0];
  assert.deepEqual(Object.keys(posted), ['id', 'title', 'company', 'location', 'roleType', 'description']);
  assert.equal(posted.description.length, JD_CHARACTERS);

  const root = await tempRoot();
  try {
    const engine = fakeEngine(() => 80);
    const jobs = Array.from({ length: 30 }, (_, index) => job(`n${index}`));
    const result = await prescreenStage(jobs, stageOptions(root, { makeEngine: () => engine }));
    assert.equal(engine.calls.length, 2, '30 candidates make two calls of 25 and 5');
    assert.equal(result.meta.scored, 30);
    assert.deepEqual(engine.calls[0].schema.properties.results.items.required, ['id', 'prescreenScore', 'bestTrack']);
    assert.deepEqual(result.usage.map(entry => entry.purpose), ['prescreen', 'prescreen'], 'the calls are logged under their own purpose');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('settings default to threshold 55 and three shadow nights; enforcement needs both the owner switch and the finished shadow period', () => {
  assert.deepEqual(prescreenSettings({}), { enabled: true, threshold: 55, shadowRuns: 3, enforce: false, batchSize: 25 });
  assert.equal(lightestModelId('openai'), 'gpt-5.6-luna');
  const settings = prescreenSettings({ prescreen: { enforce: true } });
  assert.equal(prescreenMode(settings, { prescreen: { shadowRunsDone: 2 } }), 'shadow', 'the switch alone does not enforce early');
  assert.equal(prescreenMode(settings, { prescreen: { shadowRunsDone: 3 } }), 'enforced');
  assert.equal(prescreenMode(prescreenSettings({}), { prescreen: { shadowRunsDone: 9 } }), 'shadow', 'the shadow period ending does not enforce on its own');
});

test('enforced: postings at or above the threshold go on ordered by prescreen score; those below are marked seen and never deferred', async () => {
  const root = await tempRoot();
  try {
    const state = { seen: {}, prescreen: { shadowRunsDone: 3 } };
    const engine = fakeEngine(scoreByTitle({ a: 90, b: 40, c: 60, d: 55, e: 54, f: 75 }));
    const jobs = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => job(id, { bestScore: id === 'c' ? 99 : 50 }));
    const options = stageOptions(root, { state, makeEngine: () => engine, config: { prescreen: { enforce: true } } });
    const result = await prescreenStage(jobs, options);
    assert.equal(result.meta.mode, 'enforced');
    assert.deepEqual(result.dropped.map(item => item.url.split('/').pop()), ['b', 'e'], 'below 55 is dropped; exactly 55 passes');
    assert.deepEqual(result.meta.dropped.map(item => [item.title, item.score]), [['Data Analyst e', 54], ['Data Analyst b', 40]], 'Run Details lists them best first');
    for (const dropped of result.dropped) {
      assert.equal(isJobSeen(state, dropped), true);
      assert.equal(Object.values(state.seen).find(entry => entry.url === dropped.url).lastEnrichment, 'prescreened_out');
    }

    const budget = applyReviewBudget(result.jobs, state, 2, NOW, { rankByPrescreen: true });
    assert.deepEqual(budget.jobs.map(item => item.url.split('/').pop()), ['a', 'f'], 'the cap takes the best prescreen scores, not the best local scores');
    assert.deepEqual(Object.values(state.deferred || {}).map(entry => entry.url.split('/').pop()).sort(), ['c', 'd'], 'only the review overflow is deferred');
    assert.ok(!Object.values(state.deferred || {}).some(entry => /\/(b|e)$/.test(entry.url)), 'prescreened-out postings never enter the deferral queue');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('shadow mode drops nothing, counts the final matches the threshold would have lost, and counts each night once', async () => {
  const root = await tempRoot();
  try {
    const state = { seen: {} };
    const engine = fakeEngine(scoreByTitle({ a: 90, b: 40, c: 30 }));
    const jobs = ['a', 'b', 'c'].map(id => job(id));
    const result = await prescreenStage(jobs, stageOptions(root, { state, makeEngine: () => engine }));
    assert.equal(result.meta.mode, 'shadow');
    assert.equal(result.jobs.length, 3, 'nothing is dropped');
    assert.deepEqual(result.dropped, []);
    assert.equal(result.meta.wouldDrop, 2);
    assert.equal(Object.keys(state.seen).length, 0, 'nothing is marked seen');
    // The final review found a and b high matches; b would have been lost.
    const finalMatches = result.jobs.filter(item => /\/(a|b)$/.test(item.url));
    const meta = finishPrescreen(result.meta, state, { matches: finalMatches, date: DATE, now: NOW });
    assert.deepEqual([meta.finalMatches, meta.lost, meta.recall], [2, 1, 0.5]);
    assert.deepEqual(meta.lostTitles, [{ title: 'Data Analyst b', company: 'Example Corp', score: 40 }]);
    assert.equal(state.prescreen.shadowRunsDone, 1);
    finishPrescreen(result.meta, state, { matches: finalMatches, date: DATE, now: NOW });
    assert.equal(state.prescreen.shadowRunsDone, 1, 'a same-day rerun does not count twice');
    assert.equal(state.prescreen.history.length, 1);
    assert.match(describePrescreen(meta), /^shadow night 1 of 3 · gpt-5\.6-luna \(low\) · 3 of 3 scored · 2 would be dropped below 55 · recall 50% \(1 of 2 final matches would have been dropped\)$/);

    for (const [index, date] of ['2026-10-07', '2026-10-08'].entries()) {
      const next = await prescreenStage(jobs, stageOptions(root, { state, date, makeEngine: () => fakeEngine(() => 80) }));
      finishPrescreen(next.meta, state, { matches: next.jobs.slice(0, 1), date, now: NOW });
      assert.equal(state.prescreen.shadowRunsDone, index + 2);
    }
    const overview = prescreenOverview({}, state);
    assert.deepEqual([overview.mode, overview.canEnforce, overview.finalMatches, overview.lost], ['shadow', true, 4, 1], 'shadow stays on until the owner enables it');
    const enforced = await prescreenStage(jobs, stageOptions(root, { state, date: '2026-10-09', makeEngine: () => engine, config: { prescreen: { enforce: true } } }));
    assert.equal(enforced.meta.mode, 'enforced');
    assert.equal(enforced.dropped.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failed prescreen (login, limit, unparseable reply) keeps every posting in the local order and warns', async () => {
  const root = await tempRoot();
  try {
    for (const fail of ['login', 'limit', 'parse']) {
      const state = { seen: {}, prescreen: { shadowRunsDone: 3 } };
      const warnings = [];
      const jobs = ['a', 'b'].map(id => job(id));
      const result = await prescreenStage(jobs, stageOptions(root, { state, warnings, makeEngine: () => fakeEngine(() => 10, { fail }), config: { prescreen: { enforce: true } } }));
      assert.equal(result.meta.status, 'failed', fail);
      assert.deepEqual(result.jobs, jobs, `${fail}: the jobs pass through untouched`);
      assert.deepEqual(result.dropped, []);
      assert.equal(Object.keys(state.seen).length, 0);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0].message, /the prescreen failed .*used the local order for the review budget and dropped nothing/);
      const meta = finishPrescreen(result.meta, state, { matches: [], date: DATE, now: NOW });
      assert.equal(meta.shadowRunsDone, 3);
      assert.match(describePrescreen(meta), /^failed · gpt-5\.6-luna \(low\): /);
    }
    // An engine that cannot even be built is a failure too.
    const result = await prescreenStage([job('a')], stageOptions(root, { makeEngine: () => { throw new Error('codex: command not found'); } }));
    assert.equal(result.meta.status, 'failed');
    assert.equal(result.jobs.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the prescreen is off for local-only scoring and when switched off, and non-candidates are never sent', async () => {
  const root = await tempRoot();
  try {
    const engine = fakeEngine(() => 80);
    const local = await prescreenStage([job('a')], stageOptions(root, { makeEngine: () => engine, config: { semanticMatching: { engine: 'local_only' } } }));
    assert.equal(local.meta.status, 'off');
    const off = await prescreenStage([job('a')], stageOptions(root, { makeEngine: () => engine, config: { prescreen: { enabled: false } } }));
    assert.equal(off.meta.status, 'off');
    const mixed = await prescreenStage([job('a'), job('b', { blockers: ['senior'] }), job('c', { scoreDetails: { data: { roleRelevance: 2 } } })], stageOptions(root, { makeEngine: () => engine }));
    assert.equal(mixed.meta.candidates, 1);
    assert.equal(engine.calls.length, 1);
    assert.equal(semanticIdOf(job('a')).length, 16);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Run Details shows the funnel with per-stage usage and the prescreened-out list folded', () => {
  const meta = {
    date: DATE, resumeTracks: [], warnings: [],
    funnel: { candidates: 40, prescreened: 40, passed: 25, reviewed: 25, matched: 4 },
    usage: { total: { calls: 3, input: 3000, output: 200, cacheRead: 0, cacheCreation: 0, reasoning: 0 }, byModel: {}, byPurpose: { prescreen: { calls: 2, input: 2000, output: 100, cacheRead: 0, cacheCreation: 0, reasoning: 0 }, review: { calls: 1, input: 1000, output: 100, cacheRead: 0, cacheCreation: 0, reasoning: 0 } } },
    prescreen: { status: 'ok', mode: 'enforced', model: 'gpt-5.6-luna', effort: 'low', threshold: 55, candidates: 40, scored: 40, passed: 25, droppedCount: 15, dropped: [{ title: 'Staff Data Engineer', company: 'Example Corp', score: 20, url: 'https://x/1' }] },
  };
  const byTerm = Object.fromEntries(runDetailsView([], meta, []).rows.map(row => [row.term, row]));
  assert.equal(byTerm.Funnel.detail, '40 candidates → 40 prescreened → 25 passed → 25 reviewed → 4 matched');
  assert.deepEqual(byTerm.Funnel.items, ['prescreen: 2.0k in · 100 out (2 calls)', 'review: 1.0k in · 100 out (1 call)']);
  assert.equal(byTerm.Prescreen.detail, 'enforced · gpt-5.6-luna (low) · 40 of 40 scored · 25 passed · 15 prescreened out below 55 (marked seen)');
  assert.deepEqual(byTerm.Prescreen.folded, { id: 'prescreened-out', summary: 'Show 1 postings prescreened out', items: ['Staff Data Engineer · Example Corp · prescreen 20'] });
  assert.equal(funnelText(null), null);
});

test('Settings refuses to enforce before the shadow period ends, then saves the owner\'s confirmation', async () => {
  const root = await tempRoot();
  try {
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ semanticMatching: { engine: 'claude' }, prescreen: { shadowRuns: 3 } }, null, 2));
    await fs.writeFile(path.join(root, 'state', 'state.json'), JSON.stringify({ seen: {}, prescreen: { shadowRunsDone: 1 } }));
    const ctx = createHubContext({ configPath: path.join(root, 'config.json'), now: () => NOW, homedir: root, chromeCommand: false, pidAlive: () => false });
    await assert.rejects(savePrescreen(ctx, { enabled: 'on', threshold: '55', enforce: 'on' }), /after 3 shadow nights; 1 done so far/);
    await assert.rejects(savePrescreen(ctx, { enabled: 'on', threshold: '101' }), /whole number from 0 to 100/);
    assert.deepEqual(await savePrescreen(ctx, { enabled: 'on', threshold: '60' }), { enabled: true, threshold: 60, enforce: false });
    await fs.writeFile(path.join(root, 'state', 'state.json'), JSON.stringify({ seen: {}, prescreen: { shadowRunsDone: 3 } }));
    assert.deepEqual(await savePrescreen(ctx, { enabled: 'on', threshold: '60', enforce: 'on' }), { enabled: true, threshold: 60, enforce: true });
    const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
    assert.deepEqual(config.prescreen, { shadowRuns: 3, enabled: true, threshold: 60, enforce: true });
    const settings = await readSettings(ctx);
    assert.equal(settings.prescreen.mode, 'enforced');
    assert.equal(settings.maxReviewedPerRun, 60, 'the review cap defaults to 60');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

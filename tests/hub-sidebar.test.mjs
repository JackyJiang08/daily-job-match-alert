// The hub's left navigation (2026-11-15): one screen tall and sticky again, so Last Run, Next Run, Plan and the
// new Models lines stay in the bottom-left corner at any scroll position; the Models lines name the model each
// task would use now, past a weekly limit, a signed-out Claude, or a disconnected Codex. Fakes only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { effectiveStageModels, modelShortName } from '../src/engines/assignments.mjs';
import { prepareReportProject, startReportHub } from './helpers/report-hub.mjs';

const CLAUDE = { semanticMatching: { engine: 'claude', models: { claude: 'claude-fable-5-1' }, quotaPolicy: { modelLadder: ['claude-fable-5-1', 'claude-opus-5-5'] } } };

test('the Models lines: Review, Prescreen, CoverLetter with the assigned model, or the fallback in effect', () => {
  const now = new Date('2026-11-15T15:00:00Z');
  assert.equal(modelShortName('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelShortName('gpt-5.6-sol'), 'GPT-5.6 Sol');
  const plain = effectiveStageModels(CLAUDE, { now });
  assert.deepEqual(plain.map(item => [item.label, item.short, item.fellBack]), [['Review', 'Fable 5.1', false], ['Prescreen', 'GPT-5.6 Luna', false], ['CoverLetter', 'GPT-5.6 Sol', false]]);
  // Fable under a weekly limit: Review steps down the ladder to Opus.
  const record = { models: {}, limits: { 'claude-fable-5-1': { at: '2026-11-15T10:00:00Z', resetsAt: '2026-11-18T10:00:00Z' } }, seen: {} };
  const limited = effectiveStageModels(CLAUDE, { now, record });
  assert.deepEqual([limited[0].short, limited[0].fellBack, limited[0].from, limited[0].reason], ['Opus 5.5', true, 'claude-fable-5-1', 'weekly limit']);
  // Codex not connected: the cover letter falls back to its Claude step (Opus); the prescreen has none.
  const noCodex = effectiveStageModels(CLAUDE, { now, codexConnected: false });
  assert.deepEqual(noCodex.map(item => item.short), ['Fable 5.1', 'Unavailable', 'Opus 5.5']);
  assert.equal(noCodex[2].reason, 'Codex not connected');
  // Claude signed out with Codex as the scoring fallback engine: Review hands over to Codex.
  const handOver = effectiveStageModels({ ...CLAUDE, semanticMatching: { ...CLAUDE.semanticMatching, quotaPolicy: { ...CLAUDE.semanticMatching.quotaPolicy, fallbackEngine: 'codex' } } }, { now, claudeSignedOut: true });
  assert.deepEqual([handOver[0].short, handOver[0].reason], ['GPT-5.6 Sol', 'Claude signed out']);
  // Prescreen switched off, and a local-only config.
  assert.equal(effectiveStageModels({ ...CLAUDE, prescreen: { enabled: false } }, { now })[1].short, 'Off');
  assert.deepEqual(effectiveStageModels({ semanticMatching: { engine: 'local_only' } }, { now }).map(item => item.short), ['Local Only', 'Local Only', 'Local Only']);
});

test('every hub page: .hub-nav holds Last Run, Next Run and Models, and the stylesheet keeps it sticky and one screen tall', async () => {
  const root = await prepareReportProject();
  const configPath = path.join(root, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  await fs.writeFile(configPath, JSON.stringify({ ...config, ...CLAUDE, semanticMatching: { ...config.semanticMatching, ...CLAUDE.semanticMatching } }));
  await fs.writeFile(path.join(root, 'state', 'model-availability.json'), JSON.stringify({ version: 2, models: {}, limits: { 'claude-fable-5-1': { at: '2026-10-17T10:00:00Z', resetsAt: '2026-10-20T10:00:00Z' } }, seen: {} }));
  const hub = await startReportHub(root, { context: { describeConnections: async () => ({ claude: { installed: true, connected: true }, codex: { installed: true, connected: true } }) } });
  try {
    for (const page of ['/reports/2026-10-17', '/status', '/settings']) {
      const html = (await hub.request(page)).text;
      const nav = /<nav class="hub-nav">([\s\S]*?)<\/nav>/.exec(html)[1];
      assert.match(nav, /<div class="mini"><b>Last Run<\/b>[\s\S]*<b>Next Run<\/b>[\s\S]*<b>Models<\/b>/, `${page}: the three labels in the navigation`);
      assert.match(nav, /<b>Models<\/b><span class="model fallback" data-model="review" title="Review: Opus 5\.5 in place of Fable 5\.1 \(weekly limit\)">Review · Opus 5\.5<\/span><span class="model" data-model="prescreen" title="Prescreen: gpt-5\.6-luna">Prescreen · GPT-5\.6 Luna<\/span><span class="model" data-model="coverLetter" title="CoverLetter: gpt-5\.6-sol">CoverLetter · GPT-5\.6 Sol<\/span><\/div>/);
      const cssHref = /<link rel="stylesheet" href="([^"]+)">/.exec(html)[1];
      const css = (await hub.request(cssHref)).text;
      assert.match(css, /\.hub-nav\{position:sticky;top:0;height:100vh;overflow:auto;display:flex;flex-direction:column/);
      assert.match(css, /@media \(max-width:760px\)\{[\s\S]*?\.hub-nav\{position:static;height:auto;/, 'the top strip only below 761px, so 1100px keeps the side navigation');
    }
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

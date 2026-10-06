// The title and location pre-screen in front of enrichment, full-time early-career recognition for the
// review budget, and subscription usage parsed from the CLIs' JSON (recorded fixtures), stored for 35
// days and summarised by full model id and purpose. Fakes only; no CLI, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_PREFILTER_EXCLUDES, DEFAULT_TITLE_FAMILIES, detectEarlyCareer, isEarlyCareerPriority, prefilterJobs, prefilterSettings, titleRule } from '../src/prefilter.mjs';
import { USAGE_RETENTION_DAYS, appendUsage, claudeUsageFromEnvelope, codexUsageFromJsonl, describeTotals, readUsage, summarizeUsage, usageEntries, usagePath, usageWindow } from '../src/engines/usage.mjs';
import { parseStructuredOutput } from '../src/engines/claude.mjs';
import { parseCodexOutput } from '../src/engines/codex.mjs';
import { applyReviewBudget, bumpReviewTotals } from '../src/index.mjs';
import { applySubscriptionMatching } from '../src/subscription-match.mjs';
import { buildHtml, runDetailsView } from '../src/report.mjs';

const fixtures = new URL('./fixtures/usage/', import.meta.url);
const claudeFixture = JSON.parse(await fs.readFile(new URL('claude-result.json', fixtures), 'utf8'));
const codexExec = await fs.readFile(new URL('codex-exec.jsonl', fixtures), 'utf8');
const codexRollout = await fs.readFile(new URL('codex-rollout.jsonl', fixtures), 'utf8');
const NOW = new Date('2026-10-06T01:00:00Z');
const ats = (title, extra = {}) => ({ title, company: 'Example Corp', source: 'Example Corp (Greenhouse)', sourceKind: 'public_ats_board', url: `https://boards.example.com/${encodeURIComponent(title)}`, location: 'New York, NY', ...extra });
const listed = (title, extra = {}) => ({ ...ats(title), source: 'Zapply Internships 2027', sourceKind: 'public_github_list', ...extra });

test('the title families and the extended exclusion list decide what an ATS board may send to enrichment', () => {
  const settings = prefilterSettings({});
  assert.equal(titleRule(ats('Quality Technician Sewing'), settings), 'exclude: technician');
  assert.equal(titleRule(ats('Head of Japan, Divisional Account Management'), settings), 'exclude: head of');
  assert.equal(titleRule(ats('Data Analyst I'), settings), null);
  assert.equal(titleRule(ats('Associate Data Scientist'), settings), null);
  assert.equal(titleRule(ats('Decision Scientist'), settings), null);
  assert.equal(titleRule(ats('Data Analyst II'), settings), 'level suffix: II');
  assert.equal(titleRule(ats('Machine Learning Engineer III, Ranking'), settings), 'level suffix: III');
  assert.equal(titleRule(ats('VP, Data Strategy'), settings), 'exclude: VP');
  assert.equal(titleRule(ats('Vice President, Analytics'), settings), 'exclude: vice president');
  assert.equal(titleRule(ats('Inside Sales Representative'), settings), 'exclude: sales');
  assert.equal(titleRule(ats('Senior Data Engineer'), settings), 'exclude: senior', 'the eligibility list is part of the pre-screen');
  assert.equal(titleRule(ats('Registered Nurse, ICU'), settings), 'exclude: nurse');
  assert.equal(titleRule(ats('Warehouse Associate'), settings), 'no title family');
  assert.equal(titleRule(ats('AI Engineer'), settings), null);
  assert.equal(titleRule(ats('Retail Merchandiser'), settings), 'no title family', '"AI" and "BI" match whole words only');
  assert.equal(titleRule(ats('Software Engineer, Leading Edge Systems'), settings), null, '"lead" does not match "Leading"');
  assert.equal(titleRule(ats('Quant Researcher'), settings), null);
  // Curated lists only face the exclusions; Hacker News and RemoteOK need a family like the boards.
  assert.equal(titleRule(listed('Warehouse Associate'), settings), null);
  assert.equal(titleRule(listed('Quality Technician Sewing'), settings), 'exclude: technician');
  assert.equal(titleRule({ title: 'Warehouse Associate', sourceKind: 'public_json_feed' }, settings), 'no title family');
  assert.equal(titleRule({ title: 'Warehouse Associate', sourceKind: 'official_email_alert' }, settings), null);
  // Everything is configurable.
  const custom = prefilterSettings({ titleFamilies: ['warehouse'], prefilterExcludeTitleTerms: [], excludeTitleTerms: ['intern'], excludeLevelSuffixes: [] });
  assert.equal(titleRule(ats('Warehouse Associate'), custom), null);
  assert.equal(titleRule(ats('Data Analyst II'), custom), 'no title family');
  assert.equal(titleRule(ats('Warehouse Technician'), custom), null, 'an empty extra list removes technician');
  assert.ok(DEFAULT_TITLE_FAMILIES.includes('decision') && DEFAULT_PREFILTER_EXCLUDES.includes('head of'));
});

test('a known non-US location is dropped before enrichment, counted per source, and the title drops are listed for review', () => {
  const jobs = [
    ats('Data Analyst I'),
    ats('Data Scientist', { location: 'Toronto, ON, Canada' }),
    ats('Data Scientist', { location: 'Toronto, ON / New York, NY', url: 'https://boards.example.com/multi' }),
    ats('Quality Technician Sewing'),
    listed('Head of Japan, Divisional Account Management'),
    listed('Business Analyst', { location: '' }),
  ];
  const result = prefilterJobs(jobs, {});
  assert.deepEqual(result.jobs.map(job => [job.title, job.location]), [['Data Analyst I', 'New York, NY'], ['Data Scientist', 'Toronto, ON / New York, NY'], ['Business Analyst', '']]);
  assert.deepEqual(result.titleExcluded.map(item => [item.company, item.title, item.source, item.rule]), [
    ['Example Corp', 'Quality Technician Sewing', 'Example Corp (Greenhouse)', 'exclude: technician'],
    ['Example Corp', 'Head of Japan, Divisional Account Management', 'Zapply Internships 2027', 'exclude: head of'],
  ]);
  assert.equal(result.locationExcluded.length, 1);
  assert.match(result.locationExcluded[0].rule, /^location: /);
  assert.deepEqual(result.bySource, [
    { source: 'Example Corp (Greenhouse)', title: 1, location: 1 },
    { source: 'Zapply Internships 2027', title: 1, location: 0 },
  ]);

  const meta = { date: '2026-10-05', timeZone: 'America/Chicago', lookbackHours: 24, resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [], prefilter: { titleExcluded: result.titleExcluded, titleExcludedCount: 2, locationExcludedCount: 1, bySource: result.bySource } };
  const row = runDetailsView([], meta, meta.resumeTracks).rows.find(item => item.term === 'Prefilter');
  assert.equal(row.detail, '2 skipped by title · 1 skipped by a non-US location (before enrichment)');
  assert.deepEqual(row.items, ['Example Corp (Greenhouse): title 1 · location 1', 'Zapply Internships 2027: title 1 · location 0']);
  const html = buildHtml([], meta);
  assert.match(html, /<details class="more run-list" id="prefilter-titles"><summary>Show 2 postings skipped by title<\/summary><ul><li>Example Corp · Quality Technician Sewing · Example Corp \(Greenhouse\) · exclude: technician<\/li><li>Example Corp · Head of Japan, Divisional Account Management · Zapply Internships 2027 · exclude: head of<\/li><\/ul><\/details>/);
});

test('full-time early-career titles are marked entry_level, a new-grad signal in the JD promotes them, and the budget weighs them like internships', () => {
  const early = (title, description = '') => detectEarlyCareer({ title, description });
  assert.deepEqual(early('Data Analyst I'), { level: 'entry_level', signal: 'level I' });
  assert.deepEqual(early('Associate Data Scientist'), { level: 'entry_level', signal: 'Associate' });
  assert.equal(early('Junior Data Engineer').level, 'entry_level');
  assert.equal(early('Graduate Software Engineer').level, 'entry_level');
  assert.equal(early('University Grad, Machine Learning').level, 'entry_level');
  assert.equal(early('Early Career Quantitative Analyst').level, 'entry_level');
  assert.equal(early('Entry Level Data Scientist').level, 'entry_level');
  assert.equal(early('Rotational Program, Analytics').level, 'entry_level');
  assert.deepEqual(early('Business Analyst'), { level: 'entry_level', signal: 'analyst' }, 'a plain Analyst counts');
  assert.equal(early('Senior Analyst').level, null);
  assert.equal(early('Lead Analyst').level, null);
  assert.equal(early('Analyst III').level, null);
  assert.equal(early('Decision Scientist').level, null, 'no entry signal, no mark');
  assert.equal(early('Data Science Intern').level, null, 'internships keep their own role type');
  assert.deepEqual(early('Data Analyst I', 'We welcome 0-2 years of experience.'), { level: 'new_grad', signal: 'level I; JD: 0-2 years' });
  assert.equal(early('Associate Data Scientist', 'Open to the Class of 2027.').level, 'new_grad');
  assert.equal(early('Business Analyst', 'Ideal for a recent graduate.').level, 'new_grad');
  assert.equal(early('Analyst', 'Our new grad program').level, 'new_grad');
  assert.equal(early('Decision Scientist', 'Ideal for a recent graduate.').level, null, 'the JD only promotes a title that already reads early career');

  // Same freshness bucket: internships and recognised early-career roles rank ahead of the rest, by score among themselves.
  const base = (url, bestScore, extra = {}) => ({ url, title: 'x', bestScore, postedAt: '2026-10-05T20:00:00Z', postedAtPrecision: 'datetime', scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], ...extra });
  const jobs = [
    base('https://x/unknown-high', 95, { roleType: 'unknown' }),
    base('https://x/intern', 60, { roleType: 'internship' }),
    base('https://x/entry', 70, { roleType: 'unknown', earlyCareer: 'entry_level' }),
    base('https://x/new-grad', 50, { roleType: 'unknown', earlyCareer: 'new_grad' }),
  ];
  assert.equal(isEarlyCareerPriority(jobs[2]), true);
  assert.equal(isEarlyCareerPriority(jobs[0]), false);
  const budget = applyReviewBudget(jobs, { seen: {} }, 3, NOW, { lookbackHours: 24 });
  assert.deepEqual(budget.ranking.map(item => [item.url, item.kept]), [['https://x/entry', true], ['https://x/intern', true], ['https://x/new-grad', true], ['https://x/unknown-high', false]]);
  assert.equal(jobs[2].roleType, 'unknown', 'the mark never rewrites roleType, so eligibility and scoring are unchanged');
});

test('Claude usage is read from the recorded result envelope and summed by the full model id, never an alias', () => {
  const usage = claudeUsageFromEnvelope(claudeFixture.envelope);
  assert.deepEqual(usage, {
    engine: 'claude', effort: null,
    models: [
      { model: 'claude-fable-5-1', input: 18, output: 3874, cacheRead: 14120, cacheCreation: 9312, reasoning: 0 },
      { model: 'claude-haiku-4-5-20251001', input: 412, output: 23, cacheRead: 0, cacheCreation: 0, reasoning: 0 },
    ],
  });
  // The structured-output path carries the same usage beside the results.
  const parsed = parseStructuredOutput(JSON.stringify({ ...claudeFixture.envelope, structured_output: { results: [] } }));
  assert.deepEqual(parsed.usage, usage);
  assert.equal(parsed.scoringModel, 'claude-fable-5-1');
  // The recorded error envelope: empty modelUsage and a zero session total produce no entries.
  assert.deepEqual(claudeUsageFromEnvelope(claudeFixture.errorEnvelope).models, []);
  // An envelope with only the session total keeps it under the model it names.
  assert.deepEqual(claudeUsageFromEnvelope({ model: 'claude-opus-5', modelUsage: {}, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } }).models.map(item => item.model), ['claude-opus-5']);

  const at = NOW.toISOString();
  const entries = [
    ...usageEntries(usage, { purpose: 'review', at }),
    ...usageEntries(usage, { purpose: 'review', at }),
    ...usageEntries(claudeUsageFromEnvelope({ modelUsage: { 'claude-fable-5-1[1m]': { inputTokens: 1, outputTokens: 2 } } }), { purpose: 'supplemental', at }),
  ];
  const summary = summarizeUsage(entries);
  assert.deepEqual(Object.keys(summary.byModel).sort(), ['claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-haiku-4-5-20251001'], 'ids stay distinct and verbatim');
  assert.deepEqual(summary.byModel['claude-fable-5-1'], { calls: 2, input: 36, output: 7748, cacheRead: 28240, cacheCreation: 18624, reasoning: 0, engine: 'claude', effort: null });
  assert.deepEqual(Object.keys(summary.byPurpose).sort(), ['review', 'supplemental']);
  assert.equal(summary.total.calls, 5);
  assert.equal(describeTotals(summary.byModel['claude-fable-5-1']), '36 in · 7.7k out · 28k cache read · 19k cache write (2 calls)');
});

test('Codex usage is read from the exec stream and from rollout token counts, with the model id and reasoning effort', () => {
  assert.deepEqual(codexUsageFromJsonl(codexExec, { model: 'gpt-6-astra', effort: 'high' }), {
    engine: 'codex', effort: 'high',
    models: [{ model: 'gpt-6-astra', input: 229211, output: 54, cacheRead: 228736, cacheCreation: 0, reasoning: 0 }],
  });
  assert.deepEqual(codexUsageFromJsonl(codexRollout, { model: 'configured-model' }), {
    engine: 'codex', effort: 'medium',
    models: [{ model: 'gpt-6-astra', input: 229211, output: 54, cacheRead: 228736, cacheCreation: 0, reasoning: 0 }],
  }, 'the stream names the model and effort, which win over the configured ones');
  assert.deepEqual(codexUsageFromJsonl('not json', { model: 'gpt-6-astra' }).models, [], 'no usage event, no entry');
  const parsed = parseCodexOutput('{"results":[]}', codexExec, 'gpt-6-astra', 'low');
  assert.deepEqual([parsed.usage.models[0].model, parsed.usage.effort], ['gpt-6-astra', 'low']);
});

test('the matcher tags review and supplemental calls; the usage file keeps 35 days and the 7-day window sums per night', async () => {
  const recorded = [];
  let call = 0;
  const makeEngine = (id, model) => ({
    id, label: id, model,
    async verifyAuth() {},
    async reviewBatch(prompt) {
      call += 1;
      const ids = [...prompt.matchAll(/"id": "([a-f0-9]{16})"/g)].map(match => match[1]);
      // The first call leaves one id out, which triggers the supplemental call.
      const answered = call === 1 ? ids.slice(1) : ids;
      return { results: answered.map(job => ({ id: job, roleType: 'new_grad', scores: { data: 80 }, recommendedTrack: 'data', matchLevel: 'high', reasons: ['fit'], gaps: [], blockers: [] })), scoringModel: 'claude-fable-5-1', usage: claudeUsageFromEnvelope(claudeFixture.envelope) };
    },
    modelMatches() { return true; },
    describeModel() { return { engine: id, model }; },
  });
  const jobs = [1, 2].map(index => ({ url: `https://example.com/jobs/${index}`, title: `Analyst ${index}`, company: 'Acme', description: 'x', bestScore: 50, scores: { data: 50 }, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [], reasons: [], gaps: [] }));
  await applySubscriptionMatching(jobs, [{ id: 'data', label: 'Data', text: 'resume' }], {}, { engine: 'claude', model: 'fable', batchSize: 2, warnings: [], quotaEvents: [], makeEngine, now: () => NOW, sleep: async () => {}, retryDelayMs: 0, recordUsage: (purpose, usage) => recorded.push([purpose, usage.models.map(item => item.model)]) });
  assert.deepEqual(recorded, [['review', ['claude-fable-5-1', 'claude-haiku-4-5-20251001']], ['supplemental', ['claude-fable-5-1', 'claude-haiku-4-5-20251001']]]);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
  try {
    const file = usagePath(root);
    assert.equal(file, path.join(root, 'state', 'usage.json'));
    const day = offset => new Date(NOW.getTime() - offset * 86_400_000).toISOString();
    await appendUsage(file, usageEntries(claudeUsageFromEnvelope(claudeFixture.envelope), { purpose: 'review', at: day(40) }), { now: new Date(day(40)) });
    await appendUsage(file, usageEntries(claudeUsageFromEnvelope(claudeFixture.envelope), { purpose: 'review', at: day(2) }), { now: NOW });
    await appendUsage(file, usageEntries(codexUsageFromJsonl(codexExec, { model: 'gpt-6-astra', effort: 'medium' }), { purpose: 'letter', at: day(0), source: 'hub' }), { now: NOW });
    const record = await readUsage(file);
    assert.equal(USAGE_RETENTION_DAYS, 35);
    assert.equal(record.entries.some(entry => entry.at === day(40)), false, 'entries older than 35 days are pruned on write');
    assert.equal(record.entries.length, 3);
    const window = usageWindow(record, { now: NOW, timeZone: 'America/Chicago', days: 7 });
    assert.equal(window.nights.length, 7);
    assert.deepEqual(window.nights.map(night => night.calls), [0, 0, 0, 0, 2, 0, 1]);
    assert.deepEqual(Object.keys(window.byModel).sort(), ['claude-fable-5-1', 'claude-haiku-4-5-20251001', 'gpt-6-astra']);
    assert.equal(window.byModel['gpt-6-astra'].effort, 'medium');
    assert.deepEqual(Object.keys(window.byPurpose).sort(), ['letter', 'review']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Run Details shows this run\'s usage totals by model and purpose; the all-time review total seeds from the stored payloads once', async () => {
  const at = NOW.toISOString();
  const usage = summarizeUsage([...usageEntries(claudeUsageFromEnvelope(claudeFixture.envelope), { purpose: 'review', at }), ...usageEntries(codexUsageFromJsonl(codexExec, { model: 'gpt-6-astra', effort: 'medium' }), { purpose: 'supplemental', at })]);
  const meta = { date: '2026-10-05', resumeTracks: [], warnings: [], usage };
  const row = runDetailsView([], meta, []).rows.find(item => item.term === 'Subscription usage');
  assert.equal(row.detail, '230k in · 4.0k out · 243k cache read · 9.3k cache write (3 calls)');
  assert.deepEqual(row.items, [
    'claude-fable-5-1: 18 in · 3.9k out · 14k cache read · 9.3k cache write (1 call)',
    'claude-haiku-4-5-20251001: 412 in · 23 out (1 call)',
    'gpt-6-astra (medium effort): 229k in · 54 out · 229k cache read (1 call)',
    'review: 430 in · 3.9k out · 14k cache read · 9.3k cache write (2 calls)',
    'supplemental: 229k in · 54 out · 229k cache read (1 call)',
  ]);
  assert.equal(runDetailsView([], { ...meta, usage: summarizeUsage([]) }, []).rows.some(item => item.term === 'Subscription usage'), false, 'no calls, no row');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-totals-'));
  try {
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await fs.writeFile(path.join(root, 'state', 'report-payload-2026-10-03.json'), JSON.stringify({ meta: {}, reviewed: [{}, {}, {}] }));
    await fs.writeFile(path.join(root, 'state', 'report-payload-2026-10-04.json'), JSON.stringify({ meta: {}, reviewed: [{}, {}] }));
    const state = {};
    assert.equal(await bumpReviewTotals({ root }, state, 4, NOW), 9, 'seeded with 5 from the payloads, plus this run');
    assert.deepEqual(state.reviewTotals, { count: 9, since: '2026-10-03' });
    assert.equal(await bumpReviewTotals({ root }, state, 6, NOW), 15, 'later runs only add');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

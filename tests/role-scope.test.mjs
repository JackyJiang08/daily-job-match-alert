// Role scope beyond data and software: product management and consulting entry roles. The title families
// and exclusions, entry-level recognition, the target role families in both prompts, and the Run Details
// counts by role family. Fakes only; no model, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyRole } from '../src/classify.mjs';
import { OUTAGE_REPAIR_MIGRATION, identifyBoard, normalizeRegistry, registerBoards } from '../src/collectors/ats-boards.mjs';
import { main } from '../src/index.mjs';
import { isEligible } from '../src/match.mjs';
import { DEFAULT_PREFILTER_EXCLUDES, DEFAULT_TITLE_FAMILIES, detectEarlyCareer, prefilterJobs, prefilterSettings, titleRule } from '../src/prefilter.mjs';
import { buildPrescreenPrompt, prescreenStage } from '../src/prescreen.mjs';
import { runDetailsView } from '../src/report.mjs';
import { DEFAULT_TARGET_ROLE_FAMILIES, countByRoleFamily, roleFamilyCountsText, roleFamilyOf, targetRoleFamilies, targetRoleGuidance } from '../src/role-families.mjs';
import { buildSemanticPrompt } from '../src/subscription-match.mjs';

const ats = title => ({ title, atsKind: 'greenhouse', sourceKind: 'ats_board' });
const listed = title => ({ title, sourceKind: 'public_github_list' });

// ------------------------------------------------------------------------------------------ title families

test('the default families add consulting, strategy, business analyst, and program manager; "associate" alone is never a family', () => {
  for (const term of ['consultant', 'consulting', 'strategy', 'business analyst', 'program manager', 'product manager']) assert.ok(DEFAULT_TITLE_FAMILIES.includes(term), term);
  assert.ok(!DEFAULT_TITLE_FAMILIES.some(term => term.toLowerCase() === 'associate'));
  for (const term of ['sales associate', 'store associate', 'warehouse', 'retail', 'customer success']) assert.ok(DEFAULT_PREFILTER_EXCLUDES.includes(term), term);
  const settings = prefilterSettings({});
  // Beside a family word, Associate passes.
  for (const title of ['Associate Consultant', 'Associate Product Manager', 'Associate, Strategy', 'Associate Program Manager', 'Strategy Associate', 'Consulting Associate, Technology', 'Business Analyst', 'Associate Business Analyst']) {
    assert.equal(titleRule(ats(title), settings), null, title);
  }
  // On its own, or with a store, sales, or service word, it does not.
  assert.equal(titleRule(ats('Associate'), settings), 'no title family');
  assert.equal(titleRule(ats('Associate, Operations'), settings), 'no title family');
  assert.equal(titleRule(ats('Sales Associate'), settings), 'exclude: sales');
  assert.equal(titleRule(ats('Store Associate'), settings), 'exclude: store associate');
  assert.equal(titleRule(ats('Warehouse Associate, Strategy Team'), settings), 'exclude: warehouse', 'an exclusion beats the family word');
  assert.equal(titleRule(ats('Retail Associate'), settings), 'exclude: retail');
  assert.equal(titleRule(ats('Customer Success Associate'), settings), 'exclude: customer success');
  // The exclusions apply to curated lists too; the family check does not.
  assert.equal(titleRule(listed('Store Associate'), settings), 'exclude: store associate');
  assert.equal(titleRule(listed('Associate'), settings), null);
  // A hand-edited config that lists "associate" as a family still does not let a lone Associate through.
  assert.equal(titleRule(ats('Associate'), prefilterSettings({ titleFamilies: ['associate', 'consultant'] })), 'no title family');
  // Program Manager is a family, but the manager exclusion still holds without an early-career word.
  assert.equal(titleRule(ats('Program Manager'), settings), 'exclude: manager');
  assert.equal(titleRule(ats('Senior Consultant'), settings), 'exclude: senior');
  assert.equal(titleRule(ats('Engagement Manager, 2027'), settings), 'exclude: engagement manager', 'the 2027 override lifts "manager" only, not "engagement manager"');

  const { jobs, titleExcluded } = prefilterJobs(['Associate Consultant', 'Associate', 'Sales Associate'].map(ats), {});
  assert.deepEqual(jobs.map(job => job.title), ['Associate Consultant']);
  assert.deepEqual(titleExcluded.map(item => item.rule), ['no title family', 'exclude: sales']);
});

test('the final eligibility check lets an early-career "Manager" title through, and nothing else', () => {
  const config = { minimumMatchScore: 60, requireFullDescription: false, semanticMatching: { engine: 'local_only' }, preferences: { roleTypes: ['entry_level', 'new_grad'], excludeTitleTerms: ['senior', 'staff', 'principal', 'manager', 'director', 'lead'] } };
  const job = title => ({ title, location: 'Remote, US', roleType: 'entry_level', bestScore: 80, blockers: [], scoreDetails: { data: { roleRelevance: 30 } }, description: 'x' });
  assert.equal(isEligible(job('Associate Product Manager'), config), true);
  assert.equal(isEligible(job('Associate Program Manager'), config), true);
  assert.equal(isEligible(job('Product Manager, New Grad'), config), true);
  assert.equal(isEligible(job('Product Manager'), config), false);
  assert.equal(isEligible(job('Senior Associate Product Manager'), config), false, 'senior still excludes');
  assert.equal(isEligible(job('Engagement Manager'), config), false);
  assert.equal(isEligible(job('Principal Consultant'), config), false);
});

// ------------------------------------------------------------------------------------------ entry level

test('product and consulting entry roles read as entry level; senior consulting titles do not', () => {
  const early = title => detectEarlyCareer({ title, description: 'Work with clients and teams.' });
  const samples = {
    'Associate Consultant': 'associate consultant',
    'Business Analyst': 'business analyst',
    'Associate Product Manager': 'associate product manager',
    'APM, Payments': 'APM',
    'Consulting Analyst': 'consulting analyst',
    'Strategy Analyst, Growth': 'strategy analyst',
    'Rotational Program, Analytics': 'rotational program',
    'Graduate Program, Technology Consulting': 'graduate program',
  };
  for (const [title, signal] of Object.entries(samples)) assert.deepEqual(early(title), { level: 'entry_level', signal }, title);
  for (const title of ['Senior Consultant', 'Engagement Manager', 'Principal, Strategy', 'Principal Business Analyst']) assert.equal(early(title).level, null, title);
  // A new-grad line in the JD still promotes to new_grad.
  assert.equal(detectEarlyCareer({ title: 'Business Analyst', description: 'Open to recent graduates.' }).level, 'new_grad');
  // The local role type reads the title, not a JD that mentions analysts.
  assert.equal(classifyRole({ title: 'Business Analyst', description: '' }), 'entry_level');
  assert.equal(classifyRole({ title: 'Strategy Analyst', description: '' }), 'entry_level');
  assert.equal(classifyRole({ title: 'APM', description: '' }), 'entry_level');
  assert.equal(classifyRole({ title: 'Platform Engineer', description: 'Partner with business analysts.' }), 'unknown');
});

// ------------------------------------------------------------------------------------------ prompts

test('targetRoleFamilies (default data, AI/ML, software, product management, consulting/strategy) go into the review and prescreen prompts', () => {
  assert.deepEqual(targetRoleFamilies({}), DEFAULT_TARGET_ROLE_FAMILIES);
  assert.deepEqual(DEFAULT_TARGET_ROLE_FAMILIES, ['data', 'AI/ML', 'software', 'product management', 'consulting/strategy']);
  assert.deepEqual(targetRoleFamilies({ targetRoleFamilies: [' data ', 'Data', 'operations research', ''] }), ['data', 'operations research'], 'trimmed and deduplicated');
  const guidance = targetRoleGuidance({});
  assert.match(guidance, /Target role families \(all in scope for this candidate\): data, AI\/ML, software, product management, consulting\/strategy\./);
  assert.match(guidance, /analytical ability, project and internship experience, communication and collaboration, and business understanding/);
  assert.match(guidance, /do not mark a posting down because it is not a data role/);
  assert.match(guidance, /Choose the recommended resume track from the evidence/);

  const tracks = [{ id: 'data', label: 'Data', text: 'DATA RESUME' }, { id: 'llm', label: 'LLM', text: 'LLM RESUME' }];
  const batch = [{ semanticId: 'a', title: 'Associate Consultant', company: 'Example Corp', description: 'd' }];
  const review = buildSemanticPrompt(batch, tracks, { targetRoleFamilies: ['data', 'consulting/strategy'] });
  assert.match(review, /Target role families \(all in scope for this candidate\): data, consulting\/strategy\./);
  // The score bands are the same text as before.
  assert.match(review, /- 70-84: high overlap; a credible target with limited non-blocking gaps\./);
  assert.ok(review.indexOf('Target role families') < review.indexOf('Candidate preferences:'));
  assert.match(buildSemanticPrompt(batch, tracks, {}), /product management, consulting\/strategy\./, 'the default list when config says nothing');

  const prescreen = buildPrescreenPrompt([{ ...batch[0], location: '', roleType: 'entry_level' }], [{ id: 'data', label: 'Data' }], { data: 'DIGEST' }, { targetRoleFamilies: ['software', 'product management'] });
  assert.match(prescreen, /Target role families \(all in scope for this candidate\): software, product management\./);
  assert.ok(prescreen.indexOf('Target role families') < prescreen.indexOf('Postings (JSON):'));
});

test('the prescreen stage hands config.preferences.targetRoleFamilies to the prompt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'role-scope-prescreen-'));
  const prompts = [];
  const engine = {
    model: 'gpt-5.6-luna',
    async verifyAuth() {},
    async reviewBatch(prompt) {
      prompts.push(prompt);
      const { jobs } = JSON.parse(prompt.slice(prompt.lastIndexOf('Postings (JSON):') + 'Postings (JSON):'.length));
      return { results: jobs.map(item => ({ id: item.id, prescreenScore: 70, bestTrack: 'data' })), scoringModel: 'gpt-5.6-luna' };
    },
  };
  try {
    const job = { url: 'https://jobs.example.com/apm', title: 'Associate Product Manager', company: 'Example Corp', location: 'Remote, US', roleType: 'entry_level', description: 'Own a roadmap. '.repeat(40), bestScore: 50, scoreDetails: { data: { roleRelevance: 25 } }, blockers: [] };
    await prescreenStage([job], {
      config: { root, semanticMatching: { engine: 'claude' }, prescreen: { enabled: true }, preferences: { targetRoleFamilies: ['product management', 'data'] } },
      state: { seen: {} }, resumes: [{ id: 'data', label: 'Data', text: 'Skills: SQL, Python. Project: Churn Forecast.' }], tracks: [{ id: 'data', label: 'Data' }],
      date: '2026-10-17', now: new Date('2026-10-17T01:00:00Z'), warnings: [], makeEngine: () => engine,
    });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Target role families \(all in scope for this candidate\): product management, data\./);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ counts by role family

test('each title falls into one role family bucket: data, AI/ML, software, product, consulting, or other', () => {
  const cases = {
    'Data Analyst': 'data', 'Product Analyst': 'data', 'Quantitative Researcher': 'data',
    'Machine Learning Engineer': 'ai_ml', 'AI Research Scientist': 'ai_ml', 'NLP Engineer': 'ai_ml',
    'Software Engineer, New Grad': 'software', 'Full Stack Developer': 'software',
    'Associate Product Manager': 'product', 'APM': 'product', 'Associate Program Manager': 'product', 'Product Manager, AI Platform': 'product',
    'Associate Consultant': 'consulting', 'Business Analyst': 'consulting', 'Strategy Analyst': 'consulting', 'Associate, Strategy': 'consulting',
    'Retail Merchandiser': 'other', 'Detail Coordinator': 'other',
  };
  for (const [title, bucket] of Object.entries(cases)) assert.equal(roleFamilyOf(title), bucket, title);
  const rows = countByRoleFamily({
    prescreen: ['Data Analyst', 'ML Engineer', 'Associate Consultant', 'Associate Product Manager', 'Associate Product Manager II', 'Office Coordinator'].map(title => ({ title })),
    review: ['Data Analyst', 'Associate Product Manager'].map(title => ({ title })),
    matched: [{ title: 'Associate Product Manager' }],
  });
  assert.deepEqual(rows.map(row => [row.label, row.prescreen, row.review, row.matched]), [
    ['product', 2, 1, 1], ['consulting', 1, 0, 0], ['AI/ML', 1, 0, 0], ['data', 1, 1, 0], ['software', 0, 0, 0], ['other', 1, 0, 0],
  ]);
  assert.deepEqual(countByRoleFamily({}).map(row => row.key), ['product', 'consulting', 'ai_ml', 'data', 'software'], '"other" only when something landed there');
  assert.equal(roleFamilyCountsText(rows.slice(0, 2)), 'product 2 / 1 / 1 · consulting 1 / 0 / 0');
  const view = runDetailsView([], { date: '2026-10-16', roleFamilies: rows }, [{ id: 'data', label: 'Data' }]);
  const row = view.rows.find(item => item.term === 'Candidates by role family');
  assert.equal(row.detail, 'product 2 / 1 / 1 · consulting 1 / 0 / 0 · AI/ML 1 / 0 / 0 · data 1 / 1 / 0 · software 0 / 0 / 0 · other 1 / 0 / 0 (entered prescreen / review / matched)');
  assert.equal(runDetailsView([], { date: '2026-10-16' }, [{ id: 'data', label: 'Data' }]).rows.some(item => item.term === 'Candidates by role family'), false, 'older payloads show no row');
});

test('end to end: meta.roleFamilies counts what reached the prescreen, the review, and the matches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'role-scope-'));
  await fs.copyFile(new URL('./fixtures/data-resume.md', import.meta.url), path.join(root, 'data-resume.md'));
  const now = '2026-10-17T01:30:00.000Z';
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 0, reportDateOffsetDays: 0,
    semanticMatching: { engine: 'local_only', acceptedMatchLevels: ['high', 'medium', 'low'], maxReviewedPerRun: 3 },
    prescreen: { enabled: false }, coverLetter: { autoGenerate: { enabled: false } }, reports: { xlsx: { enabled: false, required: false } },
    outputDirectory: './output', requireFullDescription: false,
    resumes: { tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, graduationDate: '2027-05', excludeTitleTerms: ['senior', 'manager'] },
    sources: {
      githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false },
      emailFiles: { enabled: false }, himalaya: { enabled: false }, careerOps: { enabled: false }, searchDiscovery: { enabled: false },
      atsBoards: { enabled: true },
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
  const titles = ['Data Analyst, New Grad', 'Machine Learning Engineer, New Grad', 'Software Engineer, New Grad', 'Associate Product Manager', 'Associate Consultant', 'Associate', 'Sales Associate'];
  const jobs = titles.map((title, index) => ({ id: 1000 + index, title, absolute_url: `https://job-boards.greenhouse.io/examplecorp/jobs/${1000 + index}`, updated_at: '2026-10-16T20:00:00Z', first_published: '2026-10-16T20:00:00Z', location: { name: 'Remote - US' }, content: `${title}. Python, SQL, analysis, stakeholder communication, and project work. `.repeat(8) }));
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    await main({
      argv: ['node', 'index.mjs', '--config', configPath, '--now', now], autoLetters: false, notify: async () => {}, atsSleep: async () => {}, runClock: { jumpMs: () => 0 },
      atsFetchImpl: async () => new Response(JSON.stringify({ jobs }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
  } finally {
    [console.log, console.warn, console.error] = silence;
  }
  try {
    const payload = JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-10-16.json'), 'utf8'));
    const byKey = Object.fromEntries(payload.meta.roleFamilies.map(row => [row.key, row]));
    assert.deepEqual(Object.fromEntries(Object.entries(byKey).map(([key, row]) => [key, row.prescreen])), { product: 1, consulting: 1, ai_ml: 1, data: 1, software: 1 }, 'the lone and sales Associates were prefiltered out');
    const reviewed = Object.values(byKey).reduce((sum, row) => sum + row.review, 0);
    assert.equal(reviewed, payload.meta.funnel.reviewed, 'the same postings the funnel counts as reviewed');
    assert.ok(reviewed >= 1 && reviewed <= 3, 'inside the review budget of 3');
    const matched = Object.values(byKey).reduce((sum, row) => sum + row.matched, 0);
    assert.equal(matched, payload.matches.length);
    assert.ok(payload.meta.prefilter.titleExcluded.some(item => item.title === 'Associate' && item.rule === 'no title family'));
    const html = await fs.readFile(path.join(root, 'output', (await fs.readdir(path.join(root, 'output')))[0], (await fs.readdir(path.join(root, 'output', (await fs.readdir(path.join(root, 'output')))[0]))).find(name => name.endsWith('.html'))), 'utf8');
    assert.match(html, /Candidates by role family/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

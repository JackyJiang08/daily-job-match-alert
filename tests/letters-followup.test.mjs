// Follow-up fixes around automatic cover letters and the report's notices: letters for every new high
// match (no cap by default) with a carry-over queue after an interruption, Generate Missing Letters on a
// report, two-button cards with a single "Check N details" badge, editor notes split into needs-review and
// info, the US-location flag cleared by evidence in the description, the quota banner only when the run
// lost something, and weekly limits held by the CLI's reset time, the owner's weekly reset, or 24 hours.
// Every engine is a fake; nothing calls a CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { autoLetterSettings, readLettersBacklog, readLettersStatus, runAutoLetters } from '../src/auto-letters.mjs';
import { classifyEditorNotes, reviewBadge } from '../src/cover-letter/notes.mjs';
import { LOCATION_UNVERIFIED_GAP, annotateEligibility, usEvidenceInDescription } from '../src/eligibility.mjs';
import { HOLD_GRACE_MS, limitHold, markWeeklyLimit, modelStatus, nextWeeklyReset, normalizeAvailability, pruneLimits, weeklyResetOf } from '../src/engines/model-availability.mjs';
import { normalizeQuotaPolicy } from '../src/engines/quota.mjs';
import { statusText } from '../src/hub/model-settings.mjs';
import { createHubContext, createHubServer } from '../src/hub/server.mjs';
import { jobIdOf } from '../src/hub/letters.mjs';
import { quotaNote, summarizeQuota } from '../src/index.mjs';
import { buildHtml, jobBadges, runDetailsView } from '../src/report.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const PROFILE = { name: 'Jane Doe', phone: '555-0100', email: 'jane.doe@example.com', signatureName: 'Jane Doe' };
const NOW = '2026-09-15T15:00:00Z';
const WORDS = ['data', 'model', 'team', 'built', 'shipped', 'metric', 'query', 'result', 'plan', 'growth', 'weekly', 'report'];
const fiveParagraphs = () => Array.from({ length: 5 }, (_, index) => `Paragraph ${index + 1} ${Array.from({ length: 98 }, (__, i) => WORDS[i % WORDS.length]).join(' ')}.`);

function job(index, extra = {}) {
  return {
    url: `https://example.com/jobs/${index}`, title: `Data Analyst ${index}`, company: `Example Co ${index}`, companySource: 'source', location: 'Remote - US',
    roleType: 'new_grad', bestScore: 70 + index, scores: { data: 70 + index }, recommendedTrack: 'data', recommendedResume: 'Data', matchLevel: 'high', semanticReviewed: true,
    reasons: ['SQL'], gaps: [], blockers: [], description: 'Use SQL and Python to answer product questions every week.', ...extra,
  };
}

async function writePayload(root, matches, date = '2026-09-15') {
  const meta = { date, applicationDate: date, generatedAt: NOW, lookbackHours: 24, runsToday: 1, resumeTracks: [{ id: 'data', label: 'Data' }], scoringModel: 'claude-fable-5-1', warnings: [], matchCount: matches.length };
  await fs.writeFile(path.join(root, 'state', `report-payload-${date}.json`), JSON.stringify({ meta, matches, reviewed: matches, complete: true }));
}

async function prepareProject(matches, coverLetter = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'letters-followup-'));
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.copyFile(new URL('data-resume.md', fixtures), path.join(root, 'data-resume.md'));
  const config = {
    timeZone: 'America/Chicago', semanticMatching: { engine: 'claude', models: { claude: 'fable' } },
    resumes: { autoRefresh: false, tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md', enabled: true }] },
    preferences: { graduationDate: '2027-05' }, outputDirectory: './out', ...(coverLetter ? { coverLetter } : {}),
  };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));
  await writePayload(root, matches);
  return root;
}

// Fake letter engines; `behaviour(kind)` may throw, `gate` (a promise) holds every draft until it resolves.
async function contextFor(root, { behaviour = null, gate = null, editorIssues = [] } = {}) {
  const companies = [];
  const engineFor = (choice = {}) => ({
    id: choice.engine || 'claude', label: choice.engine || 'claude', model: choice.model || 'claude-fable-5-1', effort: choice.effort || null,
    async generateText(prompt) {
      const kind = prompt.startsWith('EDITOR REVIEW') ? 'editor' : prompt.startsWith('CONDENSE') ? 'condense' : 'draft';
      if (kind === 'draft' && gate) await gate;
      if (behaviour) behaviour(kind, choice);
      const usage = { engine: choice.engine || 'claude', effort: null, models: [{ model: choice.model || 'x', input: 10, output: 5, cacheRead: 0, cacheCreation: 0, reasoning: 0 }] };
      if (kind === 'editor') return { output: { issues: editorIssues, revised_paragraphs: editorIssues.length ? fiveParagraphs() : [] }, scoringModel: choice.model, usage };
      return { output: { paragraphs: fiveParagraphs() }, scoringModel: choice.model, usage };
    },
  });
  const ctx = createHubContext({
    configPath: path.join(root, 'config.json'), port: 0, now: () => new Date(NOW), homedir: root, chromeCommand: false,
    // The letters lock is "held" while this process holds it.
    pidAlive: pid => pid === process.pid, letterEngine: engineFor(),
    describeConnections: async () => ({ claude: { installed: true, connected: true }, codex: { installed: true, connected: true } }),
  });
  ctx.makeLetterEngine = engineFor;
  await ctx.letterStore.saveProfileFields(PROFILE);
  await ctx.letterStore.savePlaybook({ filename: 'playbook.md', data: Buffer.from(`# Playbook\n${'Real evidence line. '.repeat(10)}`) });
  return { ctx, companies };
}

async function startServer(ctx) {
  const server = createHubServer(ctx);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.port = server.address().port;
  const request = (method, pathname, body = null) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${ctx.port}${pathname}`, { method, headers: { host: `127.0.0.1:${ctx.port}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(new URLSearchParams(body).toString());
    req.end();
  });
  return { request, close: () => new Promise(resolve => server.close(resolve)) };
}

const cardOf = (html, company) => {
  const start = html.indexOf(`href="https://example.com/jobs/${company.replace('Example Co ', '')}"`);
  return start < 0 ? '' : html.slice(html.lastIndexOf('<article', start), html.indexOf('</article>', start));
};

test('automatic letters cover every new high match by default, best score first', async () => {
  assert.deepEqual(autoLetterSettings({}), { enabled: true, maxPerRun: 0 });
  const matches = Array.from({ length: 10 }, (_, index) => job(index + 1));
  const root = await prepareProject(matches);
  try {
    const { ctx } = await contextFor(root);
    const outcome = await runAutoLetters({ config: await ctx.loadConfig(), date: '2026-09-15', newMatchUrls: matches.map(item => item.url), ctx });
    assert.deepEqual([outcome.state, outcome.planned, outcome.generated, outcome.skipped.overLimit], ['done', 10, 10, 0], 'more than the old cap of 8, nothing over a limit');
    const status = await readLettersStatus(root);
    assert.deepEqual(status.generated.map(item => item.company).slice(0, 3), ['Example Co 10', 'Example Co 9', 'Example Co 8']);
    assert.deepEqual(await readLettersBacklog(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an interrupted pass queues what it did not write, and the next run or Run Now writes the queue first', async () => {
  const matches = [job(1), job(2), job(3)];
  const root = await prepareProject(matches);
  try {
    let failing = true;
    let drafts = 0;
    const { ctx } = await contextFor(root, {
      behaviour: kind => {
        if (kind !== 'draft' || !failing) return;
        drafts += 1;
        if (drafts > 1) throw new Error("claude exited 1: You've reached your usage limit.");
      },
    });
    const warnings = [];
    const first = await runAutoLetters({ config: await ctx.loadConfig(), date: '2026-09-15', newMatchUrls: matches.map(item => item.url), ctx, warnings });
    assert.deepEqual([first.state, first.generated, first.failed, first.queued], ['stopped', 1, 1, 2]);
    assert.match(warnings[0].message, /2 posting\(s\) are queued for the next run or Run Now/);
    assert.deepEqual((await readLettersBacklog(root)).map(item => [item.date, item.company]), [['2026-09-15', 'Example Co 2'], ['2026-09-15', 'Example Co 1']], 'the failed posting and the one never reached');

    // The next night: a new, better match arrives, but the queue goes first.
    failing = false;
    const next = [...matches, job(9)];
    await writePayload(root, next);
    const second = await runAutoLetters({ config: await ctx.loadConfig(), date: '2026-09-15', newMatchUrls: [job(9).url], ctx });
    assert.deepEqual([second.state, second.generated, second.carriedOver, second.queued], ['done', 3, 2, 0]);
    assert.deepEqual((await readLettersStatus(root)).generated.map(item => item.company), ['Example Co 2', 'Example Co 1', 'Example Co 9']);
    assert.deepEqual(await readLettersBacklog(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Generate Missing Letters writes every high match without a letter and with a trusted company, in the background, under the letters lock', async () => {
  const matches = [job(1), job(2), job(3, { companyUncertain: true, company: '100000 Example', companySource: 'url' }), job(4)];
  // The automatic pass is off: the button still works (older reports, before automatic letters existed).
  const root = await prepareProject(matches, { autoGenerate: { enabled: false, maxPerRun: 0 } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { ctx } = await contextFor(root, { gate });
  const hub = await startServer(ctx);
  try {
    await ctx.letterStore.saveLetter({ date: '2026-09-15', company: 'Example Co 4', markdown: '# Letter', meta: { jobId: jobIdOf(job(4)), company: 'Example Co 4', paragraphs: ['x'] } });
    const before = (await hub.request('GET', '/reports/2026-09-15')).text;
    assert.match(before, /<form class="inline" method="post" action="\/letters\/missing" id="missing-letters-form"><input type="hidden" name="date" value="2026-09-15"><button class="btn small" type="submit" id="missing-letters"[^>]*>Generate Missing Letters \(2\)<\/button><\/form>/, 'two missing: the uncertain company and the letter on file are left out');

    const started = await hub.request('POST', '/letters/missing', { date: '2026-09-15' });
    assert.equal(started.status, 303);
    assert.match(decodeURIComponent(started.headers.location), /Writing 2 missing cover letter\(s\) in the background/);
    const during = (await hub.request('GET', '/reports/2026-09-15')).text;
    assert.match(cardOf(during, 'Example Co 2'), /Letter generating…/, 'progress shows on the cards');
    assert.match(during, /id="missing-letters" disabled[^>]*>Writing letters… 0 of 2<\/button>/);
    assert.equal((await hub.request('POST', '/letters/oneclick', { date: '2026-09-15', job: jobIdOf(job(3)) })).status, 409, 'the same letters lock: a one-click letter waits');

    release();
    const outcome = await ctx.missingLetters;
    assert.deepEqual([outcome.state, outcome.generated], ['done', 2]);
    assert.equal((await readLettersStatus(root)).mode, 'missing');
    const after = (await hub.request('GET', '/reports/2026-09-15')).text;
    assert.doesNotMatch(after, /id="missing-letters"/, 'nothing left to write');
    assert.match(cardOf(after, 'Example Co 1'), />Download PDF<\/a><a class="btn secondary small" href="\/letters\/2026-09-15\/[^"]+">Open Letter<\/a>/);
  } finally {
    release();
    await ctx.missingLetters?.catch(() => {});
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('editor notes split into needs-review and info; the card shows only "Check N details", and only when something needs review', async () => {
  const notes = [
    'Cover letter draft: Codex is not connected; used claude-opus-5-5 from the fallback chain',
    'Editor: gpt-5.6-sol failed (timeout); reviewed with claude-opus-5-5',
    'unverified detail: a retail inventory dashboard',
    'salutation says Example Corp, body says Example Labs',
    'Paragraph 3 uses an em dash; replaced with a comma',
    'The 35% figure does not appear in the resume or the playbook',
    'Generated with claude-opus-5-5: claude-fable-5-1 weekly limit',
    'Condensed by the engine after the first render ran to 2 pages',
  ];
  const levels = classifyEditorNotes(notes);
  assert.deepEqual(levels.needsReview, [notes[2], notes[3], notes[5]]);
  assert.deepEqual(levels.info, [notes[0], notes[1], notes[4], notes[6], notes[7]]);
  assert.deepEqual(reviewBadge(notes), { key: 'letter-check', label: 'Check 3 details', tone: 'warn', title: [notes[2], notes[3], notes[5]].join('\n') });
  assert.equal(reviewBadge([notes[0], notes[4]]), null, 'info only: no badge');
  assert.equal(reviewBadge(['unverified detail: a churn study']).label, 'Check 1 detail');

  const matches = [job(1), job(2)];
  const root = await prepareProject(matches);
  const { ctx } = await contextFor(root);
  const hub = await startServer(ctx);
  try {
    await ctx.letterStore.saveLetter({ date: '2026-09-15', company: 'Example Co 1', markdown: '# Letter', meta: { jobId: jobIdOf(job(1)), company: 'Example Co 1', source: 'auto', editorNotes: [notes[0], notes[4]], paragraphs: ['x'] } });
    await ctx.letterStore.saveLetter({ date: '2026-09-15', company: 'Example Co 2', markdown: '# Letter', meta: { jobId: jobIdOf(job(2)), company: 'Example Co 2', source: 'auto', editorNotes: notes, paragraphs: ['x'] } });
    const page = (await hub.request('GET', '/reports/2026-09-15')).text.split('<script>')[0];
    const quiet = cardOf(page, 'Example Co 1');
    assert.doesNotMatch(quiet, /class="badges"/, 'no badge at all without needs-review notes');
    assert.match(quiet, /<div class="actions"><a class="apply"[^>]*>Open Posting<\/a><a class="btn secondary small" href="\/letters\/2026-09-15\/[^"]+">Open Letter<\/a><span class="meta"/, 'no PDF rendered yet: Open Letter only');
    assert.doesNotMatch(page, /Letter ready|editor note/);
    assert.match(cardOf(page, 'Example Co 2'), /<span class="badge badge-warn" data-badge="letter-check" title="unverified detail: a retail inventory dashboard\nsalutation says Example Corp, body says Example Labs\nThe 35% figure does not appear in the resume or the playbook">Check 3 details<\/span>/);
    const letters = await ctx.letterStore.listLetters();
    const opened = (await hub.request('GET', `/letters/2026-09-15/${letters.find(item => item.company === 'Example Co 2').slug}`)).text;
    assert.match(opened, /<details class="notes" id="editor-notes" open><summary>Check before sending<\/summary><ul class="issues" id="editor-notes-list"><li>unverified detail: a retail inventory dashboard<\/li><li>salutation says Example Corp, body says Example Labs<\/li><li>The 35% figure does not appear in the resume or the playbook<\/li><\/ul><\/details>/);
    assert.match(opened, /<ul class="letter-foot foot-notes" id="letter-info-notes"><li>Cover letter draft: Codex is not connected[^<]*<\/li><li>Editor: gpt-5\.6-sol failed[^<]*<\/li><li>Paragraph 3 uses an em dash[^<]*<\/li><li>Generated with claude-opus-5-5[^<]*<\/li><li>Condensed by the engine[^<]*<\/li><\/ul>/, 'info only in the footer');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('US evidence in the description clears the location flag; without it the badge says "US location not stated"', () => {
  const remote = { title: 'Data Analyst', company: 'Example Corp', companySource: 'source', location: 'Remote', gaps: [] };
  for (const description of ['Candidates must be authorized to work in the United States.', 'This is a US-based remote role.', 'Our team sits in Austin and travels quarterly.', 'Open to candidates across the United States.', 'Hybrid from our Illinois office.']) {
    const annotated = annotateEligibility({ ...remote, description });
    assert.equal(annotated.eligibility.location.verdict, 'us', description);
    assert.equal(annotated.eligibility.location.source, 'description');
    assert.deepEqual(annotated.gaps, []);
    assert.deepEqual(jobBadges(annotated).map(badge => badge.key), []);
  }
  assert.equal(usEvidenceInDescription('Contact us to learn more about our product.'), null, 'a lowercase "us" is not evidence');
  const silent = annotateEligibility({ ...remote, description: 'Work with SQL and dashboards. Remote friendly.' });
  assert.equal(silent.eligibility.location.verdict, 'unverified');
  assert.deepEqual(silent.gaps, [LOCATION_UNVERIFIED_GAP]);
  assert.deepEqual(jobBadges(silent).map(badge => [badge.label, badge.title]), [['US location not stated', 'The posting does not state a US location; confirm you can work from the United States before applying']]);
  // An older payload annotated before the description check: the card re-checks at render time.
  const legacy = { ...remote, matchLevel: 'high', semanticReviewed: true, bestScore: 80, scores: { data: 80 }, url: 'https://example.com/j', description: 'You must be authorized to work in the United States.', gaps: ['Location unverified — confirm US eligibility'], eligibility: { location: { verdict: 'unverified', marker: null }, exclusion: null } };
  const html = buildHtml([legacy], { date: '2026-09-15', resumeTracks: [{ id: 'data', label: 'Data' }], warnings: [] });
  assert.doesNotMatch(html, /location-unverified|Location unverified|US location not stated/);
});

test('the quota banner and header line appear only when postings went unreviewed or Codex took over', () => {
  const policy = normalizeQuotaPolicy({ fallbackEngine: null });
  const config = { timeZone: 'America/Chicago', semanticMatching: { engine: 'claude', models: { claude: 'fable' } } };
  const downgrade = [{ kind: 'modelWeeklyLimit', model: 'claude-fable-5-1', action: 'downgraded', detail: 'switched to claude-opus-5-5', engine: 'claude', at: NOW }];
  const quiet = summarizeQuota(downgrade, policy, config, 0);
  assert.equal(quiet.banner, null);
  assert.equal(quotaNote(quiet, 0), null);
  const rows = runDetailsView([], { date: '2026-09-15', resumeTracks: [], warnings: [], quota: quiet }, []).rows;
  assert.match(rows.find(row => row.term === 'Subscription quota').detail, /^1 event\(s\) · scored by claude · claude-opus-5-5$/, 'the downgrade is a Run Details line');
  const html = buildHtml([], { date: '2026-09-15', resumeTracks: [], warnings: [], quota: quiet, quotaNote: quotaNote(quiet, 0) });
  assert.doesNotMatch(html, /data-banner="quota"|class="quota-note"/);

  const deferred = summarizeQuota([{ kind: 'accountWeeklyLimit', model: null, action: 'deferred', detail: 'no fallback engine configured', engine: 'claude', at: NOW }], policy, config, 12);
  assert.match(deferred.banner, /12 posting\(s\) were deferred to the next run/);
  assert.match(quotaNote(deferred, 12), /12 posting\(s\) were not reviewed/);
  const handed = summarizeQuota([{ kind: 'accountWeeklyLimit', model: null, action: 'fallback-engine', detail: 'switched to codex', engine: 'claude', at: NOW }], normalizeQuotaPolicy({ fallbackEngine: 'codex' }), config, 0);
  assert.match(handed.banner, /the rest of the run was scored by codex/);
  assert.match(quotaNote(handed, 0), /codex took over/);
});

test('a weekly limit with no CLI reset time is held 24 hours (or to the owner\'s weekly reset), never shown with an estimated date, and old 7-day estimates are recomputed', () => {
  const zone = 'America/Chicago';
  // Wednesday Oct 7, 2026, 8:11 PM in Chicago.
  const at = '2026-10-08T01:11:38.336Z';
  const record = normalizeAvailability(null);
  markWeeklyLimit(record, 'claude-fable-5-1', { at, resetsAt: null, notice: "You're out of usage credits." });
  assert.equal(record.limits['claude-fable-5-1'].resetsAt, null);
  assert.deepEqual(limitHold(record.limits['claude-fable-5-1']), { until: '2026-10-09T01:11:38.336Z', source: 'hold' });
  const held = modelStatus(record, 'claude-fable-5-1', { now: new Date('2026-10-08T12:00:00Z'), timeZone: zone });
  assert.deepEqual([held.state, held.resetsAt], ['weekly_limit', null], 'no reset time is ever shown for a hold');
  assert.equal(statusText(held, zone), 'Weekly limit since Oct 7, 2026, 8:11 PM · no reset time given');
  // The next nightly run (Thursday 8:00 PM) already tries Fable again.
  const copy = structuredClone(record);
  assert.deepEqual(pruneLimits(copy, { now: new Date('2026-10-09T01:00:00Z'), graceMs: HOLD_GRACE_MS }).map(item => item.model), ['claude-fable-5-1']);
  assert.deepEqual(pruneLimits(structuredClone(record), { now: new Date('2026-10-08T20:00:00Z'), graceMs: HOLD_GRACE_MS }), [], 'still held earlier that day');

  // With the owner's weekly reset (Thursday 17:00), the hold runs to that moment.
  const weeklyReset = weeklyResetOf({ plans: { claude: { weeklyReset: { day: 'thu', time: '17:00' } } } });
  assert.deepEqual(weeklyReset, { day: 'thu', time: '17:00' });
  assert.equal(nextWeeklyReset(at, weeklyReset, zone), '2026-10-08T22:00:00.000Z');
  const weekly = modelStatus(record, 'claude-fable-5-1', { now: new Date('2026-10-08T12:00:00Z'), weeklyReset, timeZone: zone });
  assert.equal(statusText(weekly, zone), 'Weekly limit until Oct 8, 2026, 5:00 PM (weekly reset)');
  assert.deepEqual(pruneLimits(structuredClone(record), { now: new Date('2026-10-08T22:00:00Z'), weeklyReset, timeZone: zone }).map(item => item.model), ['claude-fable-5-1']);
  assert.equal(weeklyResetOf({ plans: { claude: { weeklyReset: { day: 'someday', time: '25:00' } } } }), null);

  // A reset time the CLI gave is kept and shown.
  markWeeklyLimit(record, 'claude-opus-5-5', { at, resetsAt: '2026-10-09T14:00:00Z' });
  assert.equal(statusText(modelStatus(record, 'claude-opus-5-5', { now: new Date('2026-10-08T12:00:00Z'), weeklyReset, timeZone: zone }), zone), 'Weekly limit until Oct 9, 2026, 9:00 AM');

  // Migration: the 7-day estimate an older version wrote (Fable "until Oct 14") is dropped and recomputed.
  const migrated = normalizeAvailability({ version: 2, models: {}, limits: { 'claude-fable-5-1': { model: 'claude-fable-5-1', kind: 'weekly_limit', at, resetsAt: '2026-10-15T01:11:38.336Z' } } });
  assert.equal(migrated.limits['claude-fable-5-1'].resetsAt, null);
  assert.equal(modelStatus(migrated, 'claude-fable-5-1', { now: new Date('2026-10-09T02:00:00Z'), timeZone: zone }).state, 'not_verified', 'usable again a day later');
  assert.equal(modelStatus(migrated, 'claude-fable-5-1', { now: new Date('2026-10-08T23:00:00Z'), weeklyReset, timeZone: zone }).state, 'not_verified', 'or after the owner\'s weekly reset');
  // A seven-day reset the CLI really gave survives a reload.
  const real = normalizeAvailability(record);
  markWeeklyLimit(real, 'claude-sonnet-5-5', { at, resetsAt: '2026-10-15T01:11:38.336Z' });
  assert.equal(normalizeAvailability(real).limits['claude-sonnet-5-5'].resetsAt, '2026-10-15T01:11:38.336Z');
});

test('Settings > Subscriptions > Claude saves and clears the optional weekly reset', async () => {
  const root = await prepareProject([job(1)]);
  const { ctx } = await contextFor(root);
  const hub = await startServer(ctx);
  try {
    const page = (await hub.request('GET', '/settings')).text;
    assert.match(page, /<dt>Weekly reset<\/dt><dd data-weekly-reset><form class="inline weekly-reset" method="post" action="\/settings\/plans\/weekly-reset"><select name="day"[^>]*><option value="" selected>Not set<\/option>/);
    assert.equal((page.match(/data-weekly-reset/g) || []).length, 1, 'Claude card only');
    assert.equal((await hub.request('POST', '/settings/plans/weekly-reset', { day: 'thu', time: '17:00' })).status, 303);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).plans.claude.weeklyReset, { day: 'thu', time: '17:00' });
    assert.match((await hub.request('GET', '/settings')).text, /<option value="thu" selected>Thursday<\/option>[\s\S]*?<input type="time" name="time"[^>]*value="17:00">/);
    assert.match(decodeURIComponent((await hub.request('POST', '/settings/plans/weekly-reset', { day: 'thu', time: '5pm' })).headers.location), /error=The weekly reset time is a local time such as 17:00/);
    await hub.request('POST', '/settings/plans/weekly-reset', { day: '', time: '' });
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).plans.claude.weeklyReset, undefined);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

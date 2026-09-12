// Route-level tests for the local hub: a temporary project on disk, an injected spawn fake for Run Now,
// an injected pidAlive for the lock, and a fake text extractor so no pdftotext is needed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createHubContext, createHubServer } from '../src/hub/server.mjs';
import { detectIndent } from '../src/hub/config-file.mjs';
import { parseMultipart } from '../src/hub/multipart.mjs';
import { nextScheduledRun, validateSettings } from '../src/hub/services.mjs';
import { hostIsLocal, originIsLocal } from '../src/hub/routes.mjs';

const NOW = '2026-08-27T12:00:00Z';
const fixtures = new URL('./fixtures/', import.meta.url);

const CONFIG_TEXT = `{
  "lookbackHours": 24,
  "timeZone": "America/Chicago",
  "minimumMatchScore": 70,
  "semanticMatching": {
    "engine": "local_only",
    "model": "fable",
    "acceptedMatchLevels": ["high"],
    "batchSize": 6
  },
  "reports": { "xlsx": { "enabled": true, "required": false } },
  "outputDirectory": "./output",
  "resumes": {
    "autoRefresh": false,
    "pdftotextCommand": "/custom/pdftotext",
    "tracks": [
      { "id": "data", "label": "Data", "pdf": "./external/Data Resume.pdf", "profile": "./data-resume.md", "enabled": true },
      { "id": "llm", "label": "LLM", "profile": "./llm-resume.md", "enabled": true }
    ]
  },
  "preferences": { "roleTypes": ["internship", "new_grad", "entry_level"], "graduationDate": "2027-05" },
  "sources": { "emailFiles": { "enabled": true, "directory": "./intake" } },
  "network": { "fetchDescriptions": false }
}
`;

function job(overrides = {}) {
  return {
    source: 'fixture', roleType: 'new_grad', postedAt: '2026-08-27T10:00:00Z', company: 'Acme', title: 'Data Analyst', location: 'Remote - US',
    scores: { data: 82, llm: 60 }, bestScore: 82, recommendedTrack: 'data', recommendedResume: 'Data', reasons: ['SQL'], gaps: [], blockers: [],
    matchLevel: 'high', semanticReviewed: true, description: 'Analyze.', url: 'https://example.com/jobs/1', enrichment: 'jobposting_json_ld', ...overrides,
  };
}

async function prepareProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-test-'));
  await fs.mkdir(path.join(root, 'state', 'logs'), { recursive: true });
  await fs.mkdir(path.join(root, 'external'), { recursive: true });
  await fs.mkdir(path.join(root, 'output', '2026-08-27'), { recursive: true });
  await fs.writeFile(path.join(root, 'config.json'), CONFIG_TEXT);
  await fs.writeFile(path.join(root, 'external', 'Data Resume.pdf'), '%PDF-1.4 external');
  await fs.copyFile(new URL('data-resume.md', fixtures), path.join(root, 'data-resume.md'));
  const tracks = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }];
  const meta = (date, extra = {}) => ({ date, applicationDate: date, generatedAt: `${date}T01:00:00.000Z`, lastUpdatedAt: `${date}T01:00:00.000Z`, lookbackHours: 24, runsToday: 1, resumeTracks: tracks, scoringModel: 'local_only', warnings: [], matchCount: 1, reviewedCount: 3, ...extra });
  await fs.writeFile(path.join(root, 'state', 'report-payload-2026-08-27.json'), JSON.stringify({ meta: meta('2026-08-27', { warnings: [{ stage: 'collector', source: 'Job board', message: 'network unavailable' }, { stage: 'llm', source: 'x', message: 'y' }] }), matches: [job()], reviewed: [job()], complete: true }));
  await fs.writeFile(path.join(root, 'state', 'report-payload-2026-08-26.json'), JSON.stringify({ meta: meta('2026-08-26'), matches: [], reviewed: [], complete: false }));
  await fs.writeFile(path.join(root, 'state', 'state.json'), JSON.stringify({ seen: {}, lastSuccessfulRun: '2026-08-27T01:00:00.000Z' }));
  await fs.writeFile(path.join(root, 'state', 'logs', 'daily-2026-08-26.log'), '[2026-08-27T01:00:00.000Z] launchd trigger: scheduled\n');
  await fs.writeFile(path.join(root, 'output', '2026-08-27', 'warnings.txt'), 'Daily Job Match Alert — 2026-08-27 — 2 warnings\n[collector / Job board] network unavailable\n[llm / x] y\n');
  await fs.writeFile(path.join(root, 'output', 'ERROR-2026-08-20.html'), '<html><body>boom</body></html>');
  return root;
}

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

async function startHub(root, overrides = {}) {
  const spawnCalls = [];
  const children = [];
  const alivePids = new Set(overrides.alivePids || []);
  const extractions = [];
  const ctx = createHubContext({
    configPath: path.join(root, 'config.json'),
    port: 0,
    now: () => new Date(overrides.now || NOW),
    homedir: root,
    pidAlive: pid => alivePids.has(pid),
    spawn: (command, args, options) => { spawnCalls.push({ command, args, options }); const child = fakeChild(); children.push(child); return child; },
    extractText: async (file, settings) => { extractions.push({ file, settings }); if (overrides.extractionError) throw new Error(overrides.extractionError); return 'x'.repeat(1234); },
    nodeBinary: '/fake/node',
    entrypoint: '/fake/index.mjs',
  });
  const server = createHubServer(ctx);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.port = server.address().port;
  const base = `http://127.0.0.1:${ctx.port}`;
  const request = (method, pathname, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers: { host: `127.0.0.1:${ctx.port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  const form = (pathname, fields, headers = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) for (const item of [].concat(value)) params.append(key, item);
    return request('POST', pathname, { headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: params.toString() });
  };
  const upload = (pathname, fields, file, headers = {}) => {
    const boundary = '----hubtestboundary';
    const parts = [];
    for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    if (file) parts.push(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/pdf\r\n\r\n`), file.data, Buffer.from('\r\n')]));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return request('POST', pathname, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers }, body: Buffer.concat(parts) });
  };
  return { ctx, base, request, form, upload, spawnCalls, children, extractions, alivePids, close: () => new Promise(resolve => server.close(resolve)) };
}

async function readConfig(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
}

test('Reports lists payload dates newest first and renders the selected day with the Desktop copy path', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const list = await hub.request('GET', '/reports');
    assert.equal(list.status, 200);
    assert.match(list.text, /<ul class="datelist"><li><a href="\/reports\/2026-08-27" class="active">2026-08-27<\/a><\/li><li><a href="\/reports\/2026-08-26">2026-08-26<\/a><\/li><\/ul>/);
    assert.match(list.text, /<article class="job"/);
    assert.match(list.text, /Desktop copy: <code>[^<]*output\/2026-08-27\/Daily Job Match Alert - 2026-08-27\.html<\/code>/);
    assert.match(list.text, /<form class="toolbar/);
    assert.match(list.text, /Analyze\./, 'the card carries the captured JD');
    assert.match(list.text, /<a href="\/reports" class="active">Reports<\/a>/);
    const day = await hub.request('GET', '/reports/2026-08-26');
    assert.equal(day.status, 200);
    assert.match(day.text, /No new postings cleared the configured threshold/);
    assert.match(day.text, /<a href="\/reports\/2026-08-26" class="active">/);
    assert.equal((await hub.request('GET', '/reports/2026-01-01')).status, 404);
    assert.equal((await hub.request('GET', '/reports/../state')).status, 404);
    const home = await hub.request('GET', '/');
    assert.equal(home.status, 303);
    assert.equal(home.headers.location, '/reports');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploading a PDF stores it under private/resumes, repoints only that track, and keeps five versions', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const before = await hub.request('GET', '/resumes');
    assert.match(before.text, /<article class="card" data-track="data">[\s\S]*?data-badge="external">External file/);
    assert.match(before.text, /<article class="card" data-track="llm">[\s\S]*?data-badge="no-pdf"/);
    assert.doesNotMatch(before.text, /Data analyst and early-career/, 'resume text is never rendered');

    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\nbinary bytes\r\n--not-a-boundary\n', 'latin1');
    const response = await hub.upload('/resumes/upload', { trackId: 'llm' }, { name: 'My LLM Résumé (v2).pdf', data: pdf });
    assert.equal(response.status, 303);
    assert.match(decodeURIComponent(response.headers.location), /\/resumes\?notice=llm: stored 2026-08-27T12-00-00-000Z-My LLM R.*1234 characters extracted/);

    const config = await readConfig(root);
    assert.deepEqual(Object.keys(config), ['lookbackHours', 'timeZone', 'minimumMatchScore', 'semanticMatching', 'reports', 'outputDirectory', 'resumes', 'preferences', 'sources', 'network'], 'key order is preserved');
    assert.equal(config.resumes.tracks[0].pdf, './external/Data Resume.pdf', 'the external track is untouched');
    assert.match(config.resumes.tracks[1].pdf, /^\.\/private\/resumes\/llm\/2026-08-27T12-00-00-000Z-My LLM R.*\.pdf$/);
    assert.equal(config.resumes.pdftotextCommand, '/custom/pdftotext');
    const stored = await fs.readFile(path.join(root, config.resumes.tracks[1].pdf), null);
    assert.ok(stored.equals(pdf), 'binary content is stored byte for byte');
    assert.equal(hub.extractions.length, 1);
    assert.equal(hub.extractions[0].settings.pdftotextCommand, '/custom/pdftotext');
    assert.equal(detectIndent(await fs.readFile(path.join(root, 'config.json'), 'utf8')), 2);

    const after = await hub.request('GET', '/resumes');
    assert.match(after.text, /<article class="card" data-track="llm">[\s\S]*?data-badge="managed">Managed by hub/);
    assert.match(after.text, /1234 characters extracted by the hub check/);
    assert.match(after.text, /<article class="card" data-track="data">[\s\S]*?data-badge="external">External file/);

    // Five more uploads: only the newest five files survive, and config follows the latest.
    for (let index = 0; index < 5; index += 1) {
      hub.ctx.now = () => new Date(`2026-08-28T0${index}:00:00Z`);
      assert.equal((await hub.upload('/resumes/upload', { trackId: 'llm' }, { name: `v${index}.pdf`, data: pdf })).status, 303);
    }
    const kept = (await fs.readdir(path.join(root, 'private', 'resumes', 'llm'))).sort();
    assert.equal(kept.length, 5);
    assert.ok(!kept.some(name => name.includes('My LLM')), 'the oldest upload was pruned');
    assert.match((await readConfig(root)).resumes.tracks[1].pdf, /2026-08-28T04-00-00-000Z-v4\.pdf$/);
    const hubState = JSON.parse(await fs.readFile(path.join(root, 'private', 'hub', 'hub-state.json'), 'utf8'));
    assert.equal(hubState.resumes.llm.extraction.ok, true);

    // Roll back to an older kept version.
    const rollback = await hub.form('/resumes/select', { trackId: 'llm', file: kept[1] });
    assert.equal(rollback.status, 303);
    assert.ok((await readConfig(root)).resumes.tracks[1].pdf.endsWith(kept[1]));
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploads reject non-PDF content, oversized files, and unknown or invalid track ids', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const pdf = Buffer.from('%PDF-1.4 ok');
    const cases = [
      [{ trackId: 'llm' }, { name: 'resume.docx', data: pdf }, /Only \.pdf files/],
      [{ trackId: 'llm' }, { name: 'resume.pdf', data: Buffer.from('hello') }, /missing %PDF header/],
      [{ trackId: 'llm' }, { name: 'big.pdf', data: Buffer.concat([pdf, Buffer.alloc(5 * 1024 * 1024)]) }, /5 MB limit/],
      [{ trackId: '../etc' }, { name: 'resume.pdf', data: pdf }, /Track id must be/],
      [{ trackId: 'ghost' }, { name: 'resume.pdf', data: pdf }, /Unknown track "ghost"/],
      [{ trackId: 'llm' }, null, /Choose a PDF file/],
    ];
    for (const [fields, file, pattern] of cases) {
      const response = await hub.upload('/resumes/upload', fields, file);
      assert.equal(response.status, 303, `${JSON.stringify(fields)} ${file?.name}`);
      assert.match(decodeURIComponent(response.headers.location), pattern);
    }
    assert.equal((await readConfig(root)).resumes.tracks[1].pdf, undefined, 'config.json was never touched by a rejected upload');
    await assert.rejects(fs.access(path.join(root, 'private', 'resumes')));

    const added = await hub.upload('/resumes/add', { trackId: 'agent', label: 'AI Agent' }, { name: 'agent.pdf', data: pdf });
    assert.equal(added.status, 303);
    const config = await readConfig(root);
    assert.deepEqual(config.resumes.tracks.map(track => [track.id, track.label, track.enabled]), [['data', 'Data', true], ['llm', 'LLM', true], ['agent', 'AI Agent', true]]);
    const duplicate = await hub.upload('/resumes/add', { trackId: 'agent', label: 'Again' }, { name: 'agent.pdf', data: pdf });
    assert.match(decodeURIComponent(duplicate.headers.location), /already exists/);

    assert.equal((await hub.form('/resumes/toggle', { trackId: 'agent', enabled: 'false' })).status, 303);
    assert.equal((await readConfig(root)).resumes.tracks[2].enabled, false);
    assert.match((await hub.request('GET', '/resumes')).text, /data-track="agent">[\s\S]*?data-badge="disabled">Disabled/);
    await hub.form('/resumes/toggle', { trackId: 'llm', enabled: 'false' });
    const last = await hub.form('/resumes/toggle', { trackId: 'data', enabled: 'false' });
    assert.match(decodeURIComponent(last.headers.location), /At least one track must stay enabled/);
    assert.equal((await readConfig(root)).resumes.tracks[0].enabled, true);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Run Now is refused while the pipeline lock is held, then spawns the pipeline with the manual trigger', async () => {
  const root = await prepareProject();
  const hub = await startHub(root, { alivePids: [777] });
  try {
    await fs.writeFile(path.join(root, 'state', '.lock'), '777\n');
    const lockedPage = await hub.request('GET', '/status');
    assert.match(lockedPage.text, /<button class="btn" id="run-button" type="button" disabled>Run Now<\/button>/);
    assert.match(lockedPage.text, /already running \(PID 777\)/);
    assert.match(lockedPage.text, /Held by PID 777/);
    const refused = await hub.form('/run', { confirm: 'yes' });
    assert.equal(refused.status, 409);
    assert.match(JSON.parse(refused.text).error, /PID 777/);
    assert.deepEqual(hub.spawnCalls, []);

    await fs.rm(path.join(root, 'state', '.lock'));
    assert.equal((await hub.form('/run', {})).status, 400, 'confirmation is required');
    const started = await hub.form('/run', { confirm: 'yes' });
    assert.equal(started.status, 202);
    assert.equal(JSON.parse(started.text).run.running, true);
    assert.equal(hub.spawnCalls.length, 1);
    assert.equal(hub.spawnCalls[0].command, '/fake/node');
    assert.deepEqual(hub.spawnCalls[0].args, ['/fake/index.mjs', '--config', path.join(root, 'config.json')]);
    assert.equal(hub.spawnCalls[0].options.env.DAILY_JOB_MATCH_ALERT_TRIGGER, 'manual');
    assert.equal(hub.spawnCalls[0].options.cwd, root);
    assert.equal((await hub.form('/run', { confirm: 'yes' })).status, 409, 'a second run cannot start while the first is in progress');

    const child = hub.children[0];
    child.stderr.write('Resume tracks: Data, LLM\n');
    for (let index = 0; index < 60; index += 1) child.stdout.write(`line ${index}\n`);
    child.stdout.write(`${JSON.stringify({ meta: { matchCount: 3 } })}\n`);
    await new Promise(resolve => setTimeout(resolve, 20));
    const running = JSON.parse((await hub.request('GET', '/status/run.json')).text);
    assert.equal(running.run.running, true);
    assert.equal(running.run.tail.length, 50, 'the tail is capped at 50 lines');
    child.emit('close', 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    const done = JSON.parse((await hub.request('GET', '/status/run.json')).text);
    assert.equal(done.run.running, false);
    assert.equal(done.run.exitCode, 0);
    assert.equal(done.run.matchCount, 3);
    assert.equal(done.runNow.available, true);
    assert.match(await fs.readFile(done.run.logPath, 'utf8'), /line 59/);
    const runs = JSON.parse(await fs.readFile(path.join(root, 'private', 'hub', 'runs.json'), 'utf8'));
    assert.equal(runs[0].trigger, 'manual');
    assert.match((await hub.request('GET', '/status')).text, /<dt>Trigger<\/dt><dd>manual<\/dd>/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Settings writes only its keys, preserves the rest and their order, and validates input', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const page = await hub.request('GET', '/settings');
    assert.match(page.text, /name="minimumMatchScore"[^>]*value="70"/);
    assert.match(page.text, /value="high" checked/);
    const saved = await hub.form('/settings', { minimumMatchScore: '75', acceptedMatchLevels: 'high', model: 'claude-fable-5', xlsxRequired: 'on', hubPort: '5000' });
    assert.equal(saved.status, 303);
    assert.match(saved.headers.location, /notice=/);
    const text = await fs.readFile(path.join(root, 'config.json'), 'utf8');
    const config = JSON.parse(text);
    assert.deepEqual(Object.keys(config), ['lookbackHours', 'timeZone', 'minimumMatchScore', 'semanticMatching', 'reports', 'outputDirectory', 'resumes', 'preferences', 'sources', 'network', 'hub']);
    assert.deepEqual(Object.keys(config.semanticMatching), ['engine', 'model', 'acceptedMatchLevels', 'batchSize']);
    assert.equal(config.minimumMatchScore, 75);
    assert.equal(config.semanticMatching.model, 'claude-fable-5');
    assert.equal(config.semanticMatching.engine, 'local_only');
    assert.equal(config.semanticMatching.batchSize, 6);
    assert.equal(config.reports.xlsx.required, true);
    assert.equal(config.reports.xlsx.enabled, true);
    assert.equal(config.hub.port, 5000);
    assert.deepEqual(config.preferences, { roleTypes: ['internship', 'new_grad', 'entry_level'], graduationDate: '2027-05' });
    assert.match(text, /\n  "lookbackHours": 24,\n/, 'two-space indentation is kept');

    const multi = await hub.form('/settings', { minimumMatchScore: '60', acceptedMatchLevels: ['low', 'high'], model: 'fable', hubPort: '4747' });
    assert.equal(multi.status, 303);
    const again = await readConfig(root);
    assert.deepEqual(again.semanticMatching.acceptedMatchLevels, ['high', 'low']);
    assert.equal(again.reports.xlsx.required, false);

    const invalid = await hub.form('/settings', { minimumMatchScore: '120', acceptedMatchLevels: 'maybe', model: 'bad model!', hubPort: '80' });
    assert.equal(invalid.status, 303);
    const message = decodeURIComponent(invalid.headers.location);
    assert.match(message, /error=/);
    assert.match(message, /0 to 100/);
    assert.match(message, /high, medium, low/);
    assert.match(message, /Model must be/);
    assert.match(message, /1024 to 65535/);
    assert.equal((await readConfig(root)).minimumMatchScore, 60, 'nothing written on validation failure');
    assert.throws(() => validateSettings({ minimumMatchScore: '70', acceptedMatchLevels: 'high', model: 'fable', hubPort: 'abc' }), /Hub port/);

    hub.alivePids.add(9001);
    await fs.writeFile(path.join(root, 'state', '.lock'), '9001\n');
    const locked = await hub.form('/settings', { minimumMatchScore: '61', acceptedMatchLevels: 'high', model: 'fable', hubPort: '4747' });
    assert.match(decodeURIComponent(locked.headers.location), /error=The pipeline is running \(PID 9001\)/);
    assert.equal((await readConfig(root)).minimumMatchScore, 60);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('POST requests from a non-local Origin or Host are rejected before any work happens', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const evilOrigin = await hub.form('/settings', { minimumMatchScore: '10', acceptedMatchLevels: 'high', model: 'fable', hubPort: '4747' }, { origin: 'http://evil.example' });
    assert.equal(evilOrigin.status, 403);
    const evilHost = await hub.form('/settings', { minimumMatchScore: '10', acceptedMatchLevels: 'high', model: 'fable', hubPort: '4747' }, { host: 'hub.example.com' });
    assert.equal(evilHost.status, 403);
    const evilRun = await hub.form('/run', { confirm: 'yes' }, { origin: 'https://127.0.0.1.evil.example' });
    assert.equal(evilRun.status, 403);
    assert.deepEqual(hub.spawnCalls, []);
    assert.equal((await readConfig(root)).minimumMatchScore, 70);
    const localOrigin = await hub.form('/settings', { minimumMatchScore: '71', acceptedMatchLevels: 'high', model: 'fable', hubPort: '4747' }, { origin: `http://localhost:${hub.ctx.port}` });
    assert.equal(localOrigin.status, 303);
    assert.equal((await readConfig(root)).minimumMatchScore, 71);
    assert.equal(hostIsLocal('127.0.0.1:4747'), true);
    assert.equal(hostIsLocal('[::1]:4747'), true);
    assert.equal(hostIsLocal('127.0.0.1.evil.example:4747'), false);
    assert.equal(originIsLocal('http://localhost:4747'), true);
    assert.equal(originIsLocal('https://127.0.0.1:4747'), false, 'the hub is plain http on loopback');
    assert.equal(originIsLocal('null'), false);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Status shows the last run, the next scheduled time, warnings per day, and fatal error reports', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const page = await hub.request('GET', '/status');
    assert.equal(page.status, 200);
    assert.match(page.text, /<dt>Report date<\/dt><dd><a href="\/reports\/2026-08-27">2026-08-27<\/a><\/dd>/);
    assert.match(page.text, /<dt>Trigger<\/dt><dd>scheduled<\/dd>/);
    assert.match(page.text, /<dt>Result<\/dt><dd>success<\/dd>/);
    assert.match(page.text, /<dt>Matches<\/dt><dd>1<\/dd>/);
    assert.match(page.text, /<dt>Next scheduled run<\/dt><dd>2026-08-28 01:00 UTC \(20:00 America\/Chicago\)/);
    assert.match(page.text, /LaunchAgent not installed/);
    assert.match(page.text, /<dd id="lock-line">Free<\/dd>/);
    assert.match(page.text, /<summary>2026-08-27 · 2 warnings · 1 match<\/summary><pre class="log">Daily Job Match Alert — 2026-08-27 — 2 warnings\n\[collector \/ Job board\] network unavailable/);
    assert.match(page.text, /<summary>2026-08-26 · 0 warnings · 1 match<\/summary><p class="muted">No warnings\.txt/);
    assert.match(page.text, /<a href="\/status\/error\/ERROR-2026-08-20\.html">ERROR-2026-08-20\.html<\/a>/);
    const report = await hub.request('GET', '/status/error/ERROR-2026-08-20.html');
    assert.equal(report.status, 200);
    assert.match(report.text, /boom/);
    assert.equal((await hub.request('GET', '/status/error/..%2Fconfig.json')).status, 404);

    // An installed LaunchAgent plist overrides the default schedule.
    await fs.mkdir(path.join(root, 'Library', 'LaunchAgents'), { recursive: true });
    await fs.writeFile(path.join(root, 'Library', 'LaunchAgents', 'com.dailyjobmatchalert.daily.plist'), '<plist><dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict></dict></plist>');
    const installed = await hub.request('GET', '/status');
    assert.match(installed.text, /<dt>Next scheduled run<\/dt><dd>2026-08-28 11:30 UTC \(06:30 America\/Chicago\)<\/dd>/);
    assert.doesNotMatch(installed.text, /LaunchAgent not installed/);

    assert.equal(nextScheduledRun(new Date('2026-08-27T12:00:00Z'), 'America/Chicago', 20, 0).toISOString(), '2026-08-28T01:00:00.000Z');
    assert.equal(nextScheduledRun(new Date('2026-08-27T01:30:00Z'), 'America/Chicago', 20, 0).toISOString(), '2026-08-28T01:00:00.000Z', 'after 20:00 local the next slot is tomorrow');
    assert.equal(nextScheduledRun(new Date('2026-12-01T12:00:00Z'), 'America/Chicago', 20, 0).toISOString(), '2026-12-02T02:00:00.000Z', 'standard time offset');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the multipart parser keeps binary bodies intact and reads quoted filenames', () => {
  const boundary = 'xyz';
  const data = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a, 0x00, 0xff, 0x2d, 0x2d]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="trackId"\r\n\r\nllm\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a \\"b\\".pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(parsed.fields, { trackId: 'llm' });
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].filename, 'a "b".pdf');
  assert.ok(parsed.files[0].data.equals(data));
  assert.throws(() => parseMultipart(body, 'text/plain'), /boundary is missing/);
});

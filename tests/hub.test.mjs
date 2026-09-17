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
import { formatDateLabel, formatLocalDateTime, formatLocalShort, localDate } from '../src/time-format.mjs';
import { createConnectionsProbe } from '../src/hub/connections.mjs';

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
      { "id": "data", "label": "Data", "pdf": "./Desktop/Data Resume.pdf", "profile": "./data-resume.md", "enabled": true },
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

function payloadMeta(date, extra = {}) {
  const tracks = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }];
  return { date, applicationDate: date, generatedAt: `${date}T01:00:00.000Z`, lastUpdatedAt: `${date}T01:00:00.000Z`, completedAt: `${date}T01:00:00.000Z`, trigger: 'scheduled', lookbackHours: 24, runsToday: 1, resumeTracks: tracks, scoringModel: 'local_only', warnings: [], matchCount: 1, reviewedCount: 3, ...extra };
}

async function prepareProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-test-'));
  await fs.mkdir(path.join(root, 'state', 'logs'), { recursive: true });
  await fs.mkdir(path.join(root, 'Desktop'), { recursive: true });
  await fs.mkdir(path.join(root, 'output', '2026-08-27'), { recursive: true });
  await fs.writeFile(path.join(root, 'config.json'), CONFIG_TEXT);
  await fs.writeFile(path.join(root, 'Desktop', 'Data Resume.pdf'), '%PDF-1.4 external');
  await fs.copyFile(new URL('data-resume.md', fixtures), path.join(root, 'data-resume.md'));
  await fs.writeFile(path.join(root, 'state', 'report-payload-2026-08-27.json'), JSON.stringify({ meta: payloadMeta('2026-08-27', { warnings: [{ stage: 'collector', source: 'Job board', message: 'network unavailable' }, { stage: 'llm', source: 'x', message: 'y' }] }), matches: [job()], reviewed: [job()], complete: true }));
  await fs.writeFile(path.join(root, 'state', 'report-payload-2026-08-26.json'), JSON.stringify({ meta: payloadMeta('2026-08-26', { matchCount: 0 }), matches: [], reviewed: [], complete: false }));
  await fs.writeFile(path.join(root, 'state', 'state.json'), JSON.stringify({ seen: {}, lastSuccessfulRun: '2026-08-27T01:00:00.000Z' }));
  await fs.writeFile(path.join(root, 'state', 'resume-sources.json'), JSON.stringify({ sources: { data: { sha256: 'abc', refreshedAt: '2026-08-20T02:00:00.000Z' } } }));
  await fs.writeFile(path.join(root, 'output', '2026-08-27', 'warnings.txt'), 'Daily Job Match Alert — 2026-08-27 — 2 warnings\n[collector / Job board] network unavailable\n[llm / x] y\n');
  await fs.writeFile(path.join(root, 'output', 'ERROR-2026-08-20.html'), '<html><body>boom</body></html>');
  await fs.writeFile(path.join(root, 'output', '2026-08-27', 'Daily Job Match Alert - 2026-08-27.html'), '<!doctype html><html><body><h1>Desktop copy</h1></body></html>');
  await fs.writeFile(path.join(root, 'output', '2026-08-27', 'Daily Job Match Alert - 2026-08-27.xlsx'), Buffer.from('PK\u0003\u0004fake-xlsx'));
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
  const clock = { value: overrides.now || NOW };
  const connectionCalls = [];
  const ctx = createHubContext({
    configPath: path.join(root, 'config.json'),
    port: 0,
    now: () => new Date(clock.value),
    describeConnections: async () => { connectionCalls.push(clock.value); return overrides.connections || { claude: { installed: true, connected: true, detail: 'Claude · Max · claude.ai', hint: null, reason: null }, codex: { installed: true, connected: false, detail: null, hint: 'codex login', reason: 'Codex is not signed in with a ChatGPT subscription (not logged in).' } }; },
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
  return { ctx, base, request, form, upload, spawnCalls, children, extractions, alivePids, clock, connectionCalls, close: () => new Promise(resolve => server.close(resolve)) };
}

async function readConfig(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
}

test('Reports lists dates newest first with counts, titles the report by date, and links the Desktop copy', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const list = await hub.request('GET', '/reports');
    assert.equal(list.status, 200);
    assert.match(list.text, /<title>Report 2026-08-27 — Daily Job Match Alert Hub<\/title>/);
    assert.match(list.text, /<p class="brand">Job Match Hub<\/p>/);
    assert.match(list.text, /<div class="datetools"><a class="today-link" href="\/reports\/2026-08-27" id="today-link" title="Today's report \(2026-08-27\)">Today<\/a><label><input type="checkbox" id="only-matches"> Only days with matches<\/label><\/div>/);
    assert.match(list.text, /<ul class="datelist" id="datelist"><li class="month" data-month="2026-08">August 2026<\/li><li data-month="2026-08"><a href="\/reports\/2026-08-27" class="active today" title="2026-08-27 \(today\)"><span>Thu, Aug 27<\/span><span class="n">1 match<\/span><span class="tag" data-tag="today">Today<\/span><\/a><\/li><li data-month="2026-08" data-empty="1"><a href="\/reports\/2026-08-26" class="quiet" title="2026-08-26"><span>Wed, Aug 26<\/span><span class="n">0 matches<\/span><\/a><\/li><\/ul>/);
    assert.match(list.text, /localStorage\.getItem\(key\)/, 'the toggle remembers itself');
    assert.doesNotMatch(list.text, /<h1 class="hub-title">Reports<\/h1>/, 'no page heading above the report');
    assert.match(list.text, /<header class="masthead"><h1>August 27, 2026<\/h1><p class="sub">1 match · Ran Aug 26, 8:00 PM<\/p><\/header>/);
    assert.equal((list.text.match(/<h1/g) || []).length, 1, 'a single h1 on the page');
    assert.match(list.text, /<a class="btn secondary small" href="\/desktop\/2026-08-27" target="_blank" rel="noopener noreferrer" title="[^"]*output\/2026-08-27\/Daily Job Match Alert - 2026-08-27\.html">Open Desktop Copy<\/a><a class="btn secondary small" href="\/desktop\/2026-08-27\/xlsx"[^>]*>Download XLSX<\/a>/);
    assert.doesNotMatch(list.text, /file:\/\//);
    assert.doesNotMatch(list.text, /Desktop copy:/);
    assert.match(list.text, /<article class="job"/);
    assert.match(list.text, /<form class="toolbar/);
    assert.match(list.text, /<dt>Trigger<\/dt><dd>scheduled<\/dd>/);
    assert.match(list.text, /<div class="mini"><b>Last run<\/b><span class="ok">✓<\/span> Aug 26, 2026, 8:00 PM<b>Next run<\/b>Aug 27, 2026, 8:00 PM<\/div>/);
    assert.doesNotMatch(list.text, /\bUTC\b/);
    assert.match(list.text, /<a href="\/reports" class="active">Reports<\/a>/);
    const day = await hub.request('GET', '/reports/2026-08-26');
    assert.equal(day.status, 200);
    assert.match(day.text, /<h1>August 26, 2026<\/h1><p class="sub">No matches · Ran Aug 25, 8:00 PM<\/p>/);
    assert.match(day.text, /No new postings cleared the configured threshold/);
    assert.match(day.text, /<a href="\/reports\/2026-08-26" class="active quiet"/);
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

test('Reports reads payloads from disk on every request and normalizes locations without rewriting the file', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const before = await hub.request('GET', '/reports');
    assert.doesNotMatch(before.text, /2026-08-28/);
    const file = path.join(root, 'state', 'report-payload-2026-08-28.json');
    const raw = JSON.stringify({ meta: payloadMeta('2026-08-28', { matchCount: 1, trigger: 'manual' }), matches: [job({ location: 'Boston, MA Johnston, RI Columbus, OH', title: 'Multi Site Analyst' })], reviewed: [], complete: true });
    await fs.writeFile(file, raw);
    const listed = await hub.request('GET', '/reports');
    assert.match(listed.text, /<a href="\/reports\/2026-08-28"[^>]*><span>Fri, Aug 28<\/span><span class="n">1 match<\/span><span class="tag" data-tag="tomorrow">Tomorrow<\/span><\/a>/, 'the new payload is visible on the very next request');
    assert.match(listed.text, /<a href="\/reports\/2026-08-27" class="active today"/, 'calendar today stays selected by default');
    const after = await hub.request('GET', '/reports/2026-08-28');
    assert.match(after.text, /<a href="\/reports\/2026-08-28" class="active"[^>]*><span>Fri, Aug 28<\/span>/);
    const sept = path.join(root, 'state', 'report-payload-2026-09-02.json');
    await fs.writeFile(sept, JSON.stringify({ meta: payloadMeta('2026-09-02', { matchCount: 2 }), matches: [job(), job({ url: 'https://example.com/jobs/9' })], reviewed: [], complete: true }));
    const grouped = await hub.request('GET', '/reports/2026-08-27');
    assert.match(grouped.text, /<li class="month" data-month="2026-09">September 2026<\/li><li data-month="2026-09"><a href="\/reports\/2026-09-02"[^>]*><span>Wed, Sep 2<\/span><span class="n">2 matches<\/span><span class="tag" data-tag="tomorrow">Tomorrow<\/span><\/a><\/li><li class="month" data-month="2026-08">August 2026<\/li>/, 'months are grouped newest first');
    assert.match(grouped.text, /<a class="today-link" href="\/reports\/2026-08-27" id="today-link" title="Today's report \(2026-08-27\)">Today<\/a>/, 'Today keeps pointing at the calendar day even when newer reports exist');
    assert.match(grouped.text, /<a href="\/reports\/2026-09-02"[^>]*title="2026-09-02 \(after today\)"><span>Wed, Sep 2<\/span><span class="n">2 matches<\/span><span class="tag" data-tag="tomorrow">Tomorrow<\/span><\/a>/, 'dates after today are tagged Tomorrow');
    assert.match((await hub.request('GET', '/reports')).text, /<a href="\/reports\/2026-08-27" class="active today"/, 'the default selection is calendar today, not the newest report');
    await fs.rm(sept);
    assert.match(after.text, /Acme · Boston, MA · Johnston, RI · Columbus, OH · New Grad/);
    assert.doesNotMatch(after.text, /Boston, MA Johnston/);
    assert.equal(await fs.readFile(file, 'utf8'), raw, 'the payload on disk is untouched');
    await fs.writeFile(file, JSON.stringify({ meta: payloadMeta('2026-08-28', { matchCount: 0 }), matches: [], reviewed: [], complete: true }));
    assert.match((await hub.request('GET', '/reports/2026-08-28')).text, /No matches/, 'a rewritten payload is re-read, never served from memory');
    await fs.rm(file);
    assert.equal((await hub.request('GET', '/reports/2026-08-28')).status, 404);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('without a report for today the list opens the newest one and the shortcut reads Latest', async () => {
  const root = await prepareProject();
  const hub = await startHub(root, { now: '2026-08-30T12:00:00Z' });
  try {
    const page = await hub.request('GET', '/reports');
    assert.match(page.text, /<a href="\/reports\/2026-08-27" class="active"[^>]*title="2026-08-27"><span>Thu, Aug 27<\/span><span class="n">1 match<\/span><\/a>/, 'newest report selected, no Today tag');
    assert.match(page.text, /<a class="today-link" href="\/reports\/2026-08-27" id="today-link" title="No report for today; newest report \(2026-08-27\)">Latest<\/a>/);
    assert.doesNotMatch(page.text, /data-tag="today"|data-tag="tomorrow"/);
    assert.match(page.text, /<h1>August 27, 2026<\/h1>/);
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
    assert.match(before.text, /<p class="hub-sub">One PDF per resume track; upload a new version here and tonight's run scores against it\.<\/p>/);
    const dataCard = before.text.match(/<article class="card" data-track="data">[\s\S]*?<\/article>/)[0];
    assert.match(dataCard, /<span class="badge badge-good" data-badge="enabled">Enabled<\/span><span class="badge" data-badge="desktop" title="[^"]*Desktop\/Data Resume\.pdf">On Desktop<\/span>/);
    assert.match(dataCard, /<span class="mono" title="[^"]*Desktop\/Data Resume\.pdf">Data Resume\.pdf<\/span>/);
    assert.doesNotMatch(dataCard, /Not uploaded through the hub|Not checked|Last upload|Text extraction/);
    assert.match(dataCard, /<dt>Profile<\/dt><dd><span title="[^"]*data-resume\.md">Profile synced Aug 19 · 770 characters<\/span><\/dd>/);
    assert.match(dataCard, /<span class="btn secondary">Choose PDF…<\/span><span class="file-name">No file chosen<\/span>/);
    assert.match(dataCard, /Upload Replacement PDF<\/button>/);
    assert.match(dataCard, /Disable Track<\/button>/);
    assert.match(before.text, /<article class="card" data-track="llm">[\s\S]*?data-badge="no-pdf"/);
    assert.match(before.text, /<h2>Add Track<\/h2>[\s\S]*?<span>ID \(letters, digits, _ or -\)<\/span>[\s\S]*?Add Track<\/button>/);
    assert.doesNotMatch(before.text, /Data analyst and early-career/, 'resume text is never rendered');
    assert.doesNotMatch(before.text, /\bUTC\b/);

    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\nbinary bytes\r\n--not-a-boundary\n', 'latin1');
    const response = await hub.upload('/resumes/upload', { trackId: 'llm' }, { name: 'My LLM Résumé (v2).pdf', data: pdf });
    assert.equal(response.status, 303);
    assert.match(decodeURIComponent(response.headers.location), /\/resumes\?notice=llm: stored 2026-08-27T12-00-00-000Z-My LLM R.*1234 characters extracted/);

    const config = await readConfig(root);
    assert.deepEqual(Object.keys(config), ['lookbackHours', 'timeZone', 'minimumMatchScore', 'semanticMatching', 'reports', 'outputDirectory', 'resumes', 'preferences', 'sources', 'network'], 'key order is preserved');
    assert.equal(config.resumes.tracks[0].pdf, './Desktop/Data Resume.pdf', 'the external track is untouched');
    assert.match(config.resumes.tracks[1].pdf, /^\.\/private\/resumes\/llm\/2026-08-27T12-00-00-000Z-My LLM R.*\.pdf$/);
    const stored = await fs.readFile(path.join(root, config.resumes.tracks[1].pdf), null);
    assert.ok(stored.equals(pdf), 'binary content is stored byte for byte');
    assert.equal(hub.extractions[0].settings.pdftotextCommand, '/custom/pdftotext');
    assert.equal(detectIndent(await fs.readFile(path.join(root, 'config.json'), 'utf8')), 2);

    const after = await hub.request('GET', `/resumes?notice=${encodeURIComponent('llm: stored')}`);
    assert.match(after.text, /<div class="flash notice">llm: stored<\/div>/);
    const llmCard = after.text.match(/<article class="card" data-track="llm">[\s\S]*?<\/article>/)[0];
    assert.match(llmCard, /<span class="badge" data-badge="hub" title="[^"]*private\/resumes\/llm\/[^"]*">Hub<\/span>/);
    assert.match(llmCard, /<dt>Last upload<\/dt><dd>Aug 27, 2026, 7:00 AM<\/dd>/);
    assert.match(llmCard, /<dt>Text extraction<\/dt><dd>1,234 characters \(checked Aug 27, 2026, 7:00 AM\)<\/dd>/);
    assert.match(llmCard, /Profile not extracted yet/);

    for (let index = 0; index < 5; index += 1) {
      hub.ctx.now = () => new Date(`2026-08-28T0${index}:00:00Z`);
      assert.equal((await hub.upload('/resumes/upload', { trackId: 'llm' }, { name: `v${index}.pdf`, data: pdf })).status, 303);
    }
    const kept = (await fs.readdir(path.join(root, 'private', 'resumes', 'llm'))).sort();
    assert.equal(kept.length, 5);
    assert.ok(!kept.some(name => name.includes('My LLM')), 'the oldest upload was pruned');
    assert.match((await readConfig(root)).resumes.tracks[1].pdf, /2026-08-28T04-00-00-000Z-v4\.pdf$/);
    const rollback = await hub.form('/resumes/select', { trackId: 'llm', file: kept[1] });
    assert.equal(rollback.status, 303);
    assert.ok((await readConfig(root)).resumes.tracks[1].pdf.endsWith(kept[1]));
    assert.match((await hub.request('GET', '/resumes')).text, /Use This Version<\/button>/);
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
    assert.match((await hub.request('GET', '/resumes')).text, /data-track="agent">[\s\S]*?<span class="badge badge-muted" data-badge="disabled">Disabled<\/span>[\s\S]*?Enable Track<\/button>/);
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
    assert.match(lockedPage.text, /<dd id="lock-line">Held by PID 777/);
    assert.match(lockedPage.text, /<div id="run-progress" hidden>/, 'idle: no run details shown');
    assert.match(lockedPage.text, /<h2>Run Now<\/h2>\s*<p class="muted">Runs the full pipeline now using your Claude subscription\. Results merge into today's report\.<\/p>/);
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
    assert.match((await hub.request('GET', '/status')).text, /<div id="run-progress">/, 'progress block appears once a run started');

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
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Settings groups the fields, writes only its keys, preserves the rest and their order, and validates input', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const page = await hub.request('GET', '/settings');
    assert.match(page.text, /<fieldset class="group"><legend>Matching<\/legend>[\s\S]*?Minimum Match Score \(0–100\)[\s\S]*?Accepted Match Levels[\s\S]*?value="high" checked> High[\s\S]*?value="medium"> Medium[\s\S]*?value="low"> Low[\s\S]*?Scoring Model[\s\S]*?<\/fieldset>/);
    assert.match(page.text, /<legend>Reports<\/legend>[\s\S]*?Require XLSX Workbook/);
    assert.match(page.text, /<legend>Hub<\/legend>[\s\S]*?<span>Port/);
    assert.match(page.text, /<p class="form-foot">Changes apply to the next run\.<\/p>/);
    assert.match(page.text, /name="minimumMatchScore"[^>]*value="70"/);
    const saved = await hub.form('/settings', { minimumMatchScore: '75', acceptedMatchLevels: 'high', model: 'claude-fable-5', xlsxRequired: 'on', hubPort: '5000' });
    assert.equal(saved.status, 303);
    assert.match(saved.headers.location, /notice=/);
    assert.match((await hub.request('GET', saved.headers.location)).text, /<div class="flash notice">Settings saved to config\.json<\/div>/);
    const text = await fs.readFile(path.join(root, 'config.json'), 'utf8');
    const config = JSON.parse(text);
    assert.deepEqual(Object.keys(config), ['lookbackHours', 'timeZone', 'minimumMatchScore', 'semanticMatching', 'reports', 'outputDirectory', 'resumes', 'preferences', 'sources', 'network', 'hub']);
    assert.deepEqual(Object.keys(config.semanticMatching), ['engine', 'model', 'acceptedMatchLevels', 'batchSize'], 'no engine field in the form: engine and models are left alone');
    assert.equal(config.minimumMatchScore, 75);
    assert.equal(config.semanticMatching.model, 'claude-fable-5');
    assert.equal(config.semanticMatching.engine, 'local_only');
    assert.equal(config.reports.xlsx.required, true);
    assert.equal(config.hub.port, 5000);
    assert.deepEqual(config.preferences, { roleTypes: ['internship', 'new_grad', 'entry_level'], graduationDate: '2027-05' });
    assert.match(text, /\n  "lookbackHours": 24,\n/, 'two-space indentation is kept');

    const multi = await hub.form('/settings', { minimumMatchScore: '60', acceptedMatchLevels: ['low', 'high'], model: 'fable', hubPort: '4747' });
    assert.equal(multi.status, 303);
    const again = await readConfig(root);
    assert.deepEqual(again.semanticMatching.acceptedMatchLevels, ['high', 'low']);
    assert.equal(again.reports.xlsx.required, false);

    const invalid = await hub.form('/settings', { minimumMatchScore: '120', acceptedMatchLevels: 'maybe', model: 'bad model!', hubPort: '80' });
    const message = decodeURIComponent(invalid.headers.location);
    assert.match(message, /error=.*0 to 100.*high, medium, low.*Model must be.*1024 to 65535/);
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

test('Status merges runs into one card, formats every time in the configured zone, and lists warnings and errors', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const page = await hub.request('GET', '/status');
    assert.equal(page.status, 200);
    assert.match(page.text, /<h2>Runs<\/h2><dl class="kv">\s*<dt>Last run<\/dt><dd>Aug 26, 2026, 8:00 PM · scheduled · success · 1 match · <a href="\/reports\/2026-08-27">report<\/a><\/dd>\s*<dt>Engine<\/dt><dd>local_only<\/dd>\s*<dt>Next run<\/dt><dd>Aug 27, 2026, 8:00 PM <span class="badge badge-warn" data-badge="not-installed">[^<]*<\/span><\/dd>\s*<dt>Lock<\/dt><dd id="lock-line">Free<\/dd>/);
    assert.doesNotMatch(page.text, /<h2>Last run<\/h2>|<h2>Schedule<\/h2>|<h2>Fatal error reports<\/h2>|\bUTC\b/);
    assert.match(page.text, /<div id="run-progress" hidden>/);
    assert.match(page.text, /<h2>Warnings<\/h2>/);
    assert.match(page.text, /<summary>Thu, Aug 27 · <span class="count-some">2 warnings<\/span> <span class="muted">· 1 match<\/span><\/summary><pre class="log">Daily Job Match Alert — 2026-08-27 — 2 warnings\n\[collector \/ Job board\] network unavailable/);
    assert.match(page.text, /<summary>Wed, Aug 26 · <span class="count-zero">0 warnings<\/span> <span class="muted">· 0 matches<\/span><\/summary><p class="muted">No warnings\.txt/);
    assert.match(page.text, /<h2>Error Reports<\/h2><table class="plain">[\s\S]*?<a href="\/status\/error\/ERROR-2026-08-20\.html" title="[^"]*">ERROR-2026-08-20\.html<\/a>/);
    assert.match(page.text, /id="run-card" data-time-zone="America\/Chicago"/);
    const report = await hub.request('GET', '/status/error/ERROR-2026-08-20.html');
    assert.equal(report.status, 200);
    assert.match(report.text, /boom/);
    assert.equal((await hub.request('GET', '/status/error/..%2Fconfig.json')).status, 404);

    // The trigger comes from the payload written by the pipeline, never from logs.
    await fs.writeFile(path.join(root, 'state', 'logs', 'daily-2026-08-27.log'), '[2026-08-27T11:00:00.000Z] launchd trigger: catchup\n');
    assert.match((await hub.request('GET', '/status')).text, /· scheduled · success/);
    const older = JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-08-27.json'), 'utf8'));
    delete older.meta.trigger;
    await fs.writeFile(path.join(root, 'state', 'report-payload-2026-08-27.json'), JSON.stringify(older));
    assert.match((await hub.request('GET', '/status')).text, /<dt>Last run<\/dt><dd>Aug 26, 2026, 8:00 PM · success · 1 match/, 'no trigger shown when the payload has none');

    await fs.mkdir(path.join(root, 'Library', 'LaunchAgents'), { recursive: true });
    await fs.writeFile(path.join(root, 'Library', 'LaunchAgents', 'com.dailyjobmatchalert.daily.plist'), '<plist><dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict></dict></plist>');
    const installed = await hub.request('GET', '/status');
    assert.match(installed.text, /<dt>Next run<\/dt><dd>Aug 28, 2026, 6:30 AM<\/dd>/);
    assert.doesNotMatch(installed.text, /LaunchAgent not installed/);
    assert.match(installed.text, /<b>Next run<\/b>Aug 28, 2026, 6:30 AM<\/div>/, 'the sidebar follows the installed schedule');

    assert.equal(nextScheduledRun(new Date('2026-08-27T12:00:00Z'), 'America/Chicago', 20, 0).toISOString(), '2026-08-28T01:00:00.000Z');
    assert.equal(nextScheduledRun(new Date('2026-08-27T01:30:00Z'), 'America/Chicago', 20, 0).toISOString(), '2026-08-28T01:00:00.000Z', 'after 20:00 local the next slot is tomorrow');
    assert.equal(nextScheduledRun(new Date('2026-12-01T12:00:00Z'), 'America/Chicago', 20, 0).toISOString(), '2026-12-02T02:00:00.000Z', 'standard time offset');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('/desktop serves the Desktop HTML and workbook read-only, and refuses anything but a valid date', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const html = await hub.request('GET', '/desktop/2026-08-27');
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /^text\/html/);
    assert.equal(html.headers['cache-control'], 'no-store');
    assert.equal(html.text, '<!doctype html><html><body><h1>Desktop copy</h1></body></html>');
    const xlsx = await hub.request('GET', '/desktop/2026-08-27/xlsx');
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers['content-type'], /spreadsheetml/);
    assert.equal(xlsx.headers['content-disposition'], 'attachment; filename="Daily Job Match Alert - 2026-08-27.xlsx"');
    assert.equal(xlsx.text, 'PK\u0003\u0004fake-xlsx');
    const missing = await hub.request('GET', '/desktop/2026-08-26');
    assert.equal(missing.status, 404);
    assert.match(missing.text, /No Desktop report for 2026-08-26/);
    assert.equal((await hub.request('GET', '/desktop/2026-08-26/xlsx')).status, 404);
    for (const bad of ['/desktop/2026-8-27', '/desktop/20260827', '/desktop/../config.json', '/desktop/2026-08-27/../../config.json', '/desktop/2026-08-27/html']) {
      assert.equal((await hub.request('GET', bad)).status, 404, bad);
    }
    assert.equal((await hub.form('/desktop/2026-08-27', {})).status, 404, 'the route is read-only');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Settings offers an engine choice with a model dropdown per engine, a custom entry, and cached connections', async () => {
  const root = await prepareProject();
  const hub = await startHub(root);
  try {
    const page = await hub.request('GET', '/settings');
    assert.doesNotMatch(page.text, /Only these values are written/);
    assert.match(page.text, /<h2>Connections<\/h2><dl class="conn"><dt>Claude<\/dt><dd><span class="badge badge-good" data-conn="connected">Connected<\/span> Claude · Max · claude\.ai<\/dd><dt>Codex<\/dt><dd><span class="badge badge-warn" data-conn="disconnected">Not connected<\/span> <span class="muted">Sign in from a terminal: <code>codex login<\/code><\/span>/);
    assert.match(page.text, /Checked Aug 27, 2026, 7:00 AM; refreshed every minute\. The hub never signs in for you\./);
    assert.match(page.text, /<span>Engine<\/span><div class="radio-row"><label><input type="radio" name="engine" value="claude" checked data-connected="yes"> Claude subscription <span class="badge badge-good" data-engine-state="connected">Connected<\/span><\/label><label><input type="radio" name="engine" value="codex" data-connected="no"> ChatGPT subscription via Codex <span class="badge badge-warn" data-engine-state="disconnected">Not connected<\/span><\/label><\/div><p class="engine-warning" id="engine-warning" hidden>/);
    assert.match(page.text, /<select name="model_claude" class="model-select control-input">/);
    assert.match(page.text, /<div class="model-group" data-engine="claude">\s*<label class="field"><span>Scoring Model<\/span><select name="model_claude" class="model-select control-input"><option value="fable" selected>Fable \(recommended\)<\/option><option value="opus">Opus<\/option><option value="sonnet">Sonnet<\/option><option value="haiku">Haiku<\/option><option value="__custom__">Custom…<\/option><\/select><\/label>\s*<label class="field model-custom" hidden>/);
    assert.match(page.text, /<div class="model-group" data-engine="codex" hidden>\s*<label class="field"><span>Scoring Model<\/span><select name="model_codex" class="model-select control-input"><option value="gpt-5\.6-sol" selected>gpt-5\.6-sol \(Codex default\)<\/option><option value="__custom__">Custom…<\/option><\/select>/);
    assert.match(page.text, /form\.querySelectorAll\('\.model-group'\)\.forEach/, 'the switch script is inlined');
    await hub.request('GET', '/settings');
    assert.equal(hub.connectionCalls.length, 1, 'connection probes are cached for a minute');
    hub.clock.value = '2026-08-27T12:01:05Z';
    await hub.request('GET', '/settings');
    assert.equal(hub.connectionCalls.length, 2);

    const saved = await hub.form('/settings', { minimumMatchScore: '70', acceptedMatchLevels: 'high', engine: 'codex', model_claude: 'opus', model_codex: '__custom__', modelCustom_codex: 'gpt-5.5-mini', hubPort: '4747' });
    assert.equal(saved.status, 303);
    assert.match(saved.headers.location, /notice=/);
    const config = await readConfig(root);
    assert.equal(config.semanticMatching.engine, 'codex');
    assert.equal(config.semanticMatching.model, 'gpt-5.5-mini');
    assert.deepEqual(config.semanticMatching.models, { codex: 'gpt-5.5-mini' });
    assert.deepEqual(Object.keys(config.semanticMatching), ['engine', 'model', 'acceptedMatchLevels', 'batchSize', 'models']);
    const after = await hub.request('GET', '/settings');
    assert.match(after.text, /<input type="radio" name="engine" value="codex" checked data-connected="no">/);
    assert.match(after.text, /<div class="model-group" data-engine="claude" hidden>/);
    assert.match(after.text, /<div class="model-group" data-engine="codex">\s*<label class="field"><span>Scoring Model<\/span><select name="model_codex" class="model-select control-input"><option value="gpt-5\.6-sol">gpt-5\.6-sol \(Codex default\)<\/option><option value="__custom__" selected>Custom…<\/option><\/select><\/label>\s*<label class="field model-custom"><span>Custom model name<\/span><input type="text" name="modelCustom_codex" value="gpt-5\.5-mini"/);
    assert.match(after.text, /<select name="model_claude" class="model-select control-input"><option value="fable" selected>/, 'the Claude choice was not written, so it keeps its default');

    const back = await hub.form('/settings', { minimumMatchScore: '70', acceptedMatchLevels: 'high', engine: 'claude', model_claude: 'sonnet', model_codex: 'gpt-5.6-sol', hubPort: '4747' });
    assert.equal(back.status, 303);
    const again = await readConfig(root);
    assert.equal(again.semanticMatching.engine, 'claude');
    assert.equal(again.semanticMatching.model, 'sonnet');
    assert.deepEqual(again.semanticMatching.models, { codex: 'gpt-5.5-mini', claude: 'sonnet' });

    const bad = await hub.form('/settings', { minimumMatchScore: '70', acceptedMatchLevels: 'high', engine: 'openai_api', model_claude: 'fable', hubPort: '4747' });
    assert.match(decodeURIComponent(bad.headers.location), /Engine must be claude or codex/);
    const badModel = await hub.form('/settings', { minimumMatchScore: '70', acceptedMatchLevels: 'high', engine: 'codex', model_codex: '__custom__', modelCustom_codex: 'not a model!', hubPort: '4747' });
    assert.match(decodeURIComponent(badModel.headers.location), /Model must be a Codex model name/);
    assert.equal((await readConfig(root)).semanticMatching.engine, 'claude');

    const status = await hub.request('GET', '/status');
    assert.match(status.text, /<dt>Engine<\/dt><dd>local_only<\/dd>/, 'the fixture payload predates meta.engine, so only the scoring model shows');
    const payload = JSON.parse(await fs.readFile(path.join(root, 'state', 'report-payload-2026-08-27.json'), 'utf8'));
    payload.meta.engine = 'codex';
    payload.meta.scoringModel = 'gpt-5.6-sol';
    await fs.writeFile(path.join(root, 'state', 'report-payload-2026-08-27.json'), JSON.stringify(payload));
    assert.match((await hub.request('GET', '/status')).text, /<dt>Engine<\/dt><dd>codex · gpt-5\.6-sol<\/dd>/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Connections shows the resolved CLI path, a not-found message with the install command, and saves a path to config', async () => {
  const root = await prepareProject();
  const hub = await startHub(root, {
    connections: {
      claude: { installed: true, connected: true, detail: 'Claude · Max · claude.ai', hint: null, reason: null, path: '/Users/me/.local/bin/claude', source: 'extra', configured: null, searched: ['/usr/bin/claude', '/Users/me/.local/bin/claude'] },
      codex: { installed: false, connected: false, detail: null, hint: 'npm i -g @openai/codex', reason: 'Codex CLI was not found on this Mac', path: null, source: 'missing', configured: '/nowhere/codex', searched: ['/nowhere/codex', '/usr/bin/codex'] },
    },
  });
  try {
    const page = await hub.request('GET', '/settings');
    assert.match(page.text, /<dt>Claude<\/dt><dd><span class="badge badge-good" data-conn="connected">Connected<\/span> Claude · Max · claude\.ai<br><span class="muted mono" title="\/usr\/bin\/claude\n\/Users\/me\/\.local\/bin\/claude">\/Users\/me\/\.local\/bin\/claude<\/span> <form class="inline" method="post" action="\/settings\/cli-path"><input type="hidden" name="engine" value="claude"><input type="hidden" name="path" value="\/Users\/me\/\.local\/bin\/claude"><button class="btn secondary small" type="submit">Save this path to config<\/button><\/form><\/dd>/);
    assert.match(page.text, /<dt>Codex<\/dt><dd><span class="badge badge-muted" data-conn="missing">Not found on this Mac<\/span> <span class="muted">Install with <code>npm i -g @openai\/codex<\/code>; config points at <code>\/nowhere\/codex<\/code><\/span><br><span class="muted" title="[^"]*">Searched PATH, ~\/\.local\/bin, \/opt\/homebrew\/bin, \/usr\/local\/bin, ~\/\.npm-global\/bin, and nvm\.<\/span><\/dd>/);
    assert.doesNotMatch(page.text, /Not installed/);
    assert.match(page.text, /value="codex" data-connected="no"> ChatGPT subscription via Codex <span class="badge badge-muted" data-engine-state="missing">Not found<\/span>/);

    const binary = path.join(root, 'claude-bin');
    await fs.writeFile(binary, '#!/bin/sh\n');
    const saved = await hub.form('/settings/cli-path', { engine: 'claude', path: binary });
    assert.equal(saved.status, 303);
    assert.match(decodeURIComponent(saved.headers.location), /Saved .*claude-bin as semanticMatching\.claudeCommand/);
    const config = await readConfig(root);
    assert.equal(config.semanticMatching.claudeCommand, binary);
    assert.deepEqual(Object.keys(config.semanticMatching), ['engine', 'model', 'acceptedMatchLevels', 'batchSize', 'claudeCommand']);
    await hub.request('GET', '/settings');
    assert.equal(hub.connectionCalls.length, 2, 'saving a path resets the connection cache');
    assert.match(decodeURIComponent((await hub.form('/settings/cli-path', { engine: 'claude', path: 'relative/claude' })).headers.location), /must be absolute/);
    assert.match(decodeURIComponent((await hub.form('/settings/cli-path', { engine: 'claude', path: path.join(root, 'missing') })).headers.location), /No executable found/);
    assert.match(decodeURIComponent((await hub.form('/settings/cli-path', { engine: 'gpt', path: binary })).headers.location), /Engine must be claude or codex/);
    assert.equal((await readConfig(root)).semanticMatching.claudeCommand, binary);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('time formatting renders in the configured zone in the "Sep 13, 2026, 8:00 PM" style', () => {
  const zone = 'America/Chicago';
  assert.equal(formatLocalDateTime('2026-09-14T01:00:00Z', zone), 'Sep 13, 2026, 8:00 PM');
  assert.equal(formatLocalDateTime('2026-01-14T01:00:00Z', zone), 'Jan 13, 2026, 7:00 PM', 'standard time');
  assert.equal(formatLocalDateTime('2026-09-14T01:00:00Z', 'Asia/Shanghai'), 'Sep 14, 2026, 9:00 AM');
  assert.equal(formatLocalDateTime('2026-09-14T01:00:00Z', 'Not/AZone'), 'Sep 13, 2026, 8:00 PM', 'an unknown zone falls back to Chicago');
  assert.equal(formatLocalShort('2026-09-13T01:00:00Z', zone), 'Sep 12, 8:00 PM');
  assert.equal(formatDateLabel('2026-09-13'), 'Sun, Sep 13');
  assert.equal(localDate(new Date('2026-09-13T03:30:00Z'), zone), '2026-09-12');
  assert.equal(formatLocalDateTime('', zone), '');
  assert.equal(formatLocalDateTime('garbage', zone), 'garbage');
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

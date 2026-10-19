// A small project for the Reports page tests: three report dates, matches with long and short JDs
// (markup and non-ASCII characters included), a carried-over card, an unverified location, a saved
// letter, and an in-process hub on a random port.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHubContext, createHubServer } from '../../src/hub/server.mjs';
import { jobIdOf } from '../../src/hub/letters.mjs';
import { readAsset } from '../../src/hub/assets.mjs';

export const NOW = '2026-10-17T15:00:00Z';
export const DATES = ['2026-10-15', '2026-10-16', '2026-10-17'];

const LONG_JD = [
  'About the role: You will build <b>analytics</b> pipelines & dashboards for "Example Corp" teams. ',
  'Responsibilities include SQL modelling, experiment design, stakeholder updates, and résumé-grade documentation — naïve café data included. ',
  'Requirements: Python, SQL, statistics; 0-2 years of experience. ',
].join('').repeat(6);

export function fixtureJob(index, overrides = {}) {
  return {
    source: 'Example Board', roleType: 'new_grad', postedAt: '2026-10-17T14:00:00Z', company: `Example Corp ${index}`, title: `Data Analyst ${index}`,
    location: 'Remote - US', scores: { data: 80 + index, llm: 60 }, bestScore: 80 + index, recommendedTrack: 'data', recommendedResume: 'Data',
    reasons: ['SQL', 'Python'], gaps: ['JD skill not found in resume: dbt'], blockers: [], matchLevel: 'high', semanticReviewed: true,
    description: LONG_JD, url: `https://jobs.example.com/${index}`, enrichment: 'jobposting_json_ld', eligibility: { location: { verdict: 'us' } }, ...overrides,
  };
}

export function fixturePayload(date, matches, extra = {}) {
  const tracks = [{ id: 'data', label: 'Data' }, { id: 'llm', label: 'LLM' }];
  return {
    meta: {
      date, applicationDate: date, generatedAt: `${date}T01:00:00.000Z`, lastUpdatedAt: `${date}T01:00:00.000Z`, completedAt: `${date}T01:00:00.000Z`,
      trigger: 'scheduled', lookbackHours: 24, runsToday: 1, resumeTracks: tracks, scoringModel: 'local_only', warnings: [], timeZone: 'America/Chicago',
      matchCount: matches.length, reviewedCount: matches.length + 2, deferredCount: 2, ...extra,
    },
    matches,
    reviewed: [...matches, fixtureJob(90, { title: 'Reviewed only', url: 'https://jobs.example.com/90' })],
    complete: true,
  };
}

export function selectedMatches() {
  return [
    fixtureJob(1),
    fixtureJob(2, { description: 'Short JD: under three hundred characters, kept whole. <i>tags</i> & "quotes".' }),
    fixtureJob(3, { carriedOver: true, firstSeenAt: '2026-10-16T02:00:00Z', location: 'Somewhere', eligibility: { location: { verdict: 'unverified' } }, gaps: ['Location not stated: verify the posting allows work from the United States'] }),
    fixtureJob(4, { description: `${'é'.repeat(299)}😀 tail after the emoji at index 299` }),
  ];
}

export async function prepareReportProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'report-speed-'));
  await fs.mkdir(path.join(root, 'state', 'logs'), { recursive: true });
  await fs.copyFile(new URL('../fixtures/data-resume.md', import.meta.url), path.join(root, 'data-resume.md'));
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 70, outputDirectory: './output',
    semanticMatching: { engine: 'local_only', acceptedMatchLevels: ['high'] }, reports: { xlsx: { enabled: false } },
    resumes: { autoRefresh: false, tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md', enabled: true }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], graduationDate: '2027-05' }, network: { fetchDescriptions: false },
  };
  await fs.writeFile(path.join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  await writePayload(root, fixturePayload('2026-10-15', [fixtureJob(7)]));
  await writePayload(root, fixturePayload('2026-10-16', [], { matchCount: 0 }));
  await writePayload(root, fixturePayload('2026-10-17', selectedMatches()));
  // A saved letter for the first match of the 17th.
  const letterDirectory = path.join(root, 'private', 'cover-letters', '2026-10-17', 'ExampleCorp1');
  await fs.mkdir(letterDirectory, { recursive: true });
  await fs.writeFile(path.join(letterDirectory, 'letter.json'), JSON.stringify({ jobId: jobIdOf(selectedMatches()[0]), date: '2026-10-17', company: 'Example Corp 1', companySlug: 'ExampleCorp1', pdfFileName: 'JaneDoe_Cover_Letter_ExampleCorp1.pdf', savedAt: '2026-10-17T03:00:00Z', editorNotes: [] }));
  await fs.writeFile(path.join(letterDirectory, 'letter.md'), 'Dear Example Corp 1,');
  return root;
}

export async function writePayload(root, payload) {
  await fs.writeFile(path.join(root, 'state', `report-payload-${payload.meta.date}.json`), JSON.stringify(payload));
}

export async function startReportHub(root, overrides = {}) {
  const clock = { value: overrides.now || NOW };
  const timingLines = [];
  const ctx = createHubContext({
    configPath: path.join(root, 'config.json'), port: 0, now: () => new Date(clock.value), homedir: root,
    describeConnections: async () => ({ claude: { installed: true, connected: true }, codex: { installed: false, connected: false } }),
    pidAlive: () => false, spawn: () => { throw new Error('no spawn in tests'); }, nodeBinary: '/fake/node', entrypoint: '/fake/index.mjs',
    timingLog: line => timingLines.push(line),
    ...overrides.context,
  });
  const server = createHubServer(ctx);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.port = server.address().port;
  const request = (pathname, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: ctx.port, path: pathname, headers: { host: `127.0.0.1:${ctx.port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const decoded = res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(body) : body;
        resolve({ status: res.statusCode, headers: res.headers, raw: body, text: decoded.toString('utf8') });
      });
    }).on('error', reject);
  });
  return { ctx, clock, timingLines, request, port: () => ctx.port, close: () => new Promise(resolve => server.close(resolve)) };
}

// The port the hub happened to listen on and the temporary project directory appear in the page;
// snapshots compare without them.
export function normalizeHtml(html, { port, root }) {
  return html.split(`127.0.0.1:${port}`).join('127.0.0.1:PORT').split(`port ${port}`).join('port PORT').split(root).join('ROOT');
}

// Puts the hub's /assets stylesheet and script back inline, as the pages carried them before the split:
// `<link rel="stylesheet" href="/assets/x.css">` → `<style>…</style>`, `<script src="/assets/y.js"></script>`
// → `<script>…</script>`. Tests that look at the CSS or the page script read the page through this.
export function inlineAssets(html) {
  return String(html)
    .replace(/<link rel="stylesheet" href="\/assets\/(hub-[a-f0-9]{16}\.css)">/g, (all, name) => `<style>${readAsset(name)?.body.toString('utf8') ?? ''}</style>`)
    .replace(/<script src="\/assets\/(hub-[a-f0-9]{16}\.js)"><\/script>/g, (all, name) => `<script>${readAsset(name)?.body.toString('utf8') ?? ''}</script>`);
}

// Reports page speed work: the reports index, the render cache and its invalidations, the on-demand JD,
// gzip / ETag / 304, the static assets, and the stage timings. The snapshot test proves the pages are the
// same HTML as before the change once the assets are inlined again and the JD sections are opened.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ASSET_CACHE_CONTROL } from '../src/hub/assets.mjs';
import { createReportCache } from '../src/hub/report-cache.mjs';
import { createTimingLog, timingLine } from '../src/hub/report-timing.mjs';
import { etagMatches } from '../src/hub/routes.mjs';
import { refreshIndexLetters, readReportsIndex, reportsIndexPath, syncReportsIndex, updateReportsIndex } from '../src/reports-index.mjs';
import { htmlEscape } from '../src/utils.mjs';
import { DATES, LAZY, asBefore, countingIo, fixtureJob, fixturePayload, inlineAssets, prepareReportProject, selectedMatches, startReportHub, writePayload } from './helpers/report-hub.mjs';

const snapshots = new URL('./fixtures/snapshots/', import.meta.url);
async function withHub(fn, options = {}) {
  const root = await prepareReportProject();
  const spy = countingIo();
  const hub = await startReportHub(root, { context: { io: spy.io, ...(options.context || {}) } });
  try {
    await fn({ root, hub, reads: spy.reads });
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------ snapshots

test('snapshot: the day page, the list page, and a short-JD day are the same HTML as before, apart from the JD sections', async () => {
  await withHub(async ({ root, hub }) => {
    for (const [name, url, lazyCount] of [['report-page.html', '/reports/2026-10-17', 3], ['reports-list.html', '/reports', 3], ['report-page-short.html', '/reports/2026-10-15', 1]]) {
      const page = await hub.request(url);
      assert.equal(page.status, 200);
      assert.doesNotMatch(page.text, /<style>|<script>/, 'the CSS and the page script are separate files now');
      assert.match(page.text, /<link rel="stylesheet" href="\/assets\/hub-[a-f0-9]{16}\.css">/);
      const before = await asBefore(hub, page.text, root);
      assert.equal(before.lazy.length, lazyCount, `${name}: every JD over 300 characters loads on demand`);
      assert.equal(before.text, await fs.readFile(new URL(name, snapshots), 'utf8'), name);
    }
  });
});

test('the JD section embeds the first 300 characters (code points) and the route returns exactly the text the page used to embed', async () => {
  await withHub(async ({ hub }) => {
    const page = await hub.request('/reports/2026-10-17');
    const lazy = [...page.text.matchAll(LAZY)];
    const matches = selectedMatches();
    const byId = new Map(matches.map(job => [job.semanticId || null, job]));
    assert.equal(byId.size, 1, 'fixtures carry no semanticId; cards use the URL hash');
    for (const [, src, preview] of lazy) {
      const full = (await hub.request(src)).text;
      const original = matches.find(job => job.description.trim() === full);
      assert.ok(original, `${src} returns one posting's full description`);
      assert.equal(preview, htmlEscape(Array.from(full).slice(0, 300).join('')));
    }
    // The emoji at index 299 is kept whole, not cut into half a surrogate pair.
    const emoji = lazy.find(([, , preview]) => preview.startsWith('ééé'))[2];
    assert.ok(emoji.endsWith('😀'));
    assert.equal(Array.from(emoji).length, 300);
    // The short JD is embedded as before.
    assert.match(page.text, /<details class="jd"><summary>Job Description<\/summary><p>Short JD: under three hundred characters, kept whole\. &lt;i&gt;tags&lt;\/i&gt; &amp; &quot;quotes&quot;\.<\/p><\/details>/);
    // Unknown posting, unknown date, bad id.
    assert.equal((await hub.request('/reports/2026-10-17/jd/0000000000000000')).status, 404);
    assert.equal((await hub.request('/reports/2026-10-01/jd/0000000000000000')).status, 404);
    assert.equal((await hub.request('/reports/2026-10-17/jd/not-an-id')).status, 404);
    // The script that opens a section loads the route once and drops the marker.
    const script = inlineAssets(page.text);
    assert.match(script, /details\.jd\[data-jd-src\]/);
    assert.match(script, /details\.querySelector\('p'\)\.textContent = text;\s*details\.removeAttribute\('data-jd-src'\);/);
  });
});

test('the Desktop report keeps the whole JD inline', async () => {
  const { buildHtml } = await import('../src/report.mjs');
  const html = buildHtml(selectedMatches(), fixturePayload('2026-10-17', selectedMatches()).meta);
  assert.doesNotMatch(html, /data-jd-src/);
  assert.ok(html.includes(htmlEscape(selectedMatches()[0].description.trim())));
});

// ------------------------------------------------------------------------------------------ the index

test('reports index: built once from the payloads when missing, then the list page reads no payload', async () => {
  await withHub(async ({ root, hub, reads }) => {
    assert.equal(await readReportsIndex(root), null);
    await hub.request('/reports/2026-10-16');
    const index = await readReportsIndex(root);
    assert.deepEqual(Object.keys(index.dates).sort(), DATES);
    assert.deepEqual(reads.filter(name => name !== 'report-payload-2026-10-16.json').sort(), ['report-payload-2026-10-15.json', 'report-payload-2026-10-17.json'], 'each payload read once to build it (plus the page’s own day)');
    const entry = index.dates['2026-10-17'];
    assert.equal(entry.generatedAt, '2026-10-17T01:00:00.000Z');
    assert.equal(entry.matchCount, 4);
    assert.equal(entry.deferredCount, 2);
    assert.equal(entry.carriedCount, 1);
    assert.equal(entry.letterCount, 1);
    assert.equal(entry.complete, true);
    assert.equal(index.dates['2026-10-16'].matchCount, 0);

    reads.length = 0;
    const list = await hub.request('/reports/2026-10-16');
    assert.equal(list.status, 200);
    assert.deepEqual(reads, [], 'list, counts, and sidebar come from the index; the cached day needs no read');
    assert.match(list.text, /<a href="\/reports\/2026-10-17" class="today" title="2026-10-17 \(today\)"><span>Sat, Oct 17<\/span><span class="n">4 matches<\/span>/);
  });
});

test('reports index: the pipeline write, a changed or removed payload, and a letter save each update their entry only', async () => {
  const root = await prepareReportProject();
  try {
    await syncReportsIndex(root);
    // The pipeline wrote a new day: its entry is updated from the payload in memory.
    const payload = fixturePayload('2026-10-18', [fixtureJob(5), fixtureJob(6, { carriedOver: true })], { deferredCount: 7 });
    await writePayload(root, payload);
    const written = await updateReportsIndex(root, payload);
    assert.equal(written.matchCount, 2);
    assert.equal(written.deferredCount, 7);
    assert.equal(written.carriedCount, 1);
    let sync = await syncReportsIndex(root);
    assert.deepEqual(sync.rebuilt, [], 'nothing to read: every entry matches its payload');
    assert.equal(sync.changed, false);
    assert.deepEqual(sync.entries.map(entry => entry.date), ['2026-10-18', ...[...DATES].reverse()]);

    // A payload rewritten without the index (an older pipeline, a crash) is re-read on its own.
    await new Promise(resolve => setTimeout(resolve, 15));
    await writePayload(root, fixturePayload('2026-10-15', [fixtureJob(7), fixtureJob(8)]));
    sync = await syncReportsIndex(root);
    assert.deepEqual(sync.rebuilt, ['2026-10-15']);
    assert.equal(sync.entries.find(entry => entry.date === '2026-10-15').matchCount, 2);

    // A pruned payload leaves the index.
    await fs.rm(path.join(root, 'state', 'report-payload-2026-10-16.json'));
    sync = await syncReportsIndex(root);
    assert.equal(sync.entries.some(entry => entry.date === '2026-10-16'), false);
    assert.equal((await readReportsIndex(root)).dates['2026-10-16'], undefined);

    // A letter saved for the 18th.
    const directory = path.join(root, 'private', 'cover-letters', '2026-10-18', 'ExampleCorp5');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'letter.json'), '{}');
    assert.equal((await refreshIndexLetters(root, '2026-10-18')).letterCount, 1);
    // A letter folder written by someone else is recounted on the next sync.
    const other = path.join(root, 'private', 'cover-letters', '2026-10-17', 'ExampleCorp2');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'letter.json'), '{}');
    sync = await syncReportsIndex(root);
    assert.equal(sync.entries.find(entry => entry.date === '2026-10-17').letterCount, 2);
    assert.deepEqual(sync.rebuilt, []);
    // An unreadable index is rebuilt.
    await fs.writeFile(reportsIndexPath(root), 'not json');
    sync = await syncReportsIndex(root);
    assert.equal(sync.rebuilt.length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------ the render cache

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  return child;
}

test('render cache: a repeat load is a hit with no payload read, letter scan, review, or render; each invalidation forces one re-render', async () => {
  const children = [];
  await withHub(async ({ root, hub, reads }) => {
    const load = async () => {
      reads.length = 0;
      const page = await hub.request('/reports/2026-10-17');
      assert.equal(page.status, 200);
      const record = hub.ctx.reportTimings.recent()[0];
      return { page, record, reads: [...reads] };
    };
    const first = await load();
    assert.equal(first.record.cache, 'miss');
    assert.ok(['payload', 'review', 'letters', 'render'].every(key => key in first.record.phases));
    const second = await load();
    assert.equal(second.record.cache, 'hit');
    assert.deepEqual(second.reads, []);
    assert.equal('payload' in second.record.phases || 'review' in second.record.phases || 'render' in second.record.phases, false, 'the re-check and the render come with the cache');
    assert.equal(second.page.text, first.page.text);

    // 1. The payload changed on disk (a nightly run outside the hub).
    await new Promise(resolve => setTimeout(resolve, 15));
    await writePayload(root, fixturePayload('2026-10-17', [...selectedMatches(), fixtureJob(9, { title: 'Brand New Posting' })]));
    const changed = await load();
    assert.equal(changed.record.cache, 'miss');
    assert.match(changed.page.text, /Brand New Posting/);
    assert.equal((await load()).record.cache, 'hit');

    // 2. A letter generated (saved through the store).
    await hub.ctx.letterStore.saveLetter({ date: '2026-10-17', company: 'Example Corp 2', markdown: 'Dear Example Corp 2,', meta: { jobId: hub.ctx.reportCache && (await import('../src/hub/letters.mjs')).jobIdOf(selectedMatches()[1]), company: 'Example Corp 2', editorNotes: [] } });
    const lettered = await load();
    assert.equal(lettered.record.cache, 'miss');
    assert.equal((lettered.page.text.match(/>Open Letter</g) || []).length, 2, 'the new letter shows on its card');
    assert.equal((await readReportsIndex(root)).dates['2026-10-17'].letterCount, 2);

    // 3. Rename & Re-render.
    await hub.ctx.letterStore.renameLetter('2026-10-17', 'ExampleCorp2', { company: 'Example Corporation Two', markdown: 'Dear Example Corporation Two,', pdfFileName: null, meta: {} });
    assert.equal((await load()).record.cache, 'miss');
    assert.equal(hub.ctx.reportCache.stats().invalidations[0].reason, 'letters');

    // 4. Settings saved.
    const saved = await new Promise((resolve, reject) => {
      const body = 'minimumMatchScore=70&acceptedMatchLevels=high&hubPort=4747';
      const req = http.request({ host: '127.0.0.1', port: hub.port(), path: '/settings', method: 'POST', headers: { host: `127.0.0.1:${hub.port()}`, origin: `http://127.0.0.1:${hub.port()}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(saved, 303);
    assert.equal(hub.ctx.reportCache.stats().invalidations[0].reason, 'config');
    assert.equal((await load()).record.cache, 'miss');

    // 5. A Run Now run finished.
    await hub.ctx.runManager.start();
    const versionBefore = hub.ctx.reportCache.versions.run;
    children[0].emit('close', 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(hub.ctx.reportCache.versions.run, versionBefore + 1);
    const afterRun = await load();
    assert.equal(afterRun.record.cache, 'miss');
    assert.deepEqual(afterRun.reads, ['report-payload-2026-10-17.json'], 'a finished run drops the cached day too');

    // 6. The automatic letters pass (another process) wrote its status file.
    await fs.writeFile(path.join(root, 'state', 'letters-auto.json'), JSON.stringify({ state: 'finished', date: '2026-10-17', planned: [], generated: [], failed: [] }));
    assert.equal((await load()).record.cache, 'miss');
    assert.equal((await load()).record.cache, 'hit');
  }, { context: { spawn: () => { const child = fakeChild(); children.push(child); return child; } } });
});

test('the cache module: LRU limits, keys by mtime and size, and only known invalidation reasons', () => {
  const cache = createReportCache({ dayLimit: 2, renderLimit: 2 });
  const key = cache.dayKey('2026-10-17', { mtimeMs: 1, size: 10 });
  assert.notEqual(key, cache.dayKey('2026-10-17', { mtimeMs: 2, size: 10 }));
  assert.notEqual(key, cache.dayKey('2026-10-17', { mtimeMs: 1, size: 11 }));
  cache.setDay('a', 1); cache.setDay('b', 2); cache.getDay('a'); cache.setDay('c', 3);
  assert.equal(cache.getDay('b'), undefined, 'least recently used goes first');
  assert.equal(cache.getDay('a'), 1);
  cache.setRender('r', 'html');
  cache.invalidate('letters');
  assert.equal(cache.getRender('r'), undefined);
  assert.equal(cache.getDay('a'), 1, 'a letter change keeps the parsed day');
  cache.invalidate('run');
  assert.equal(cache.getDay('a'), undefined);
  assert.throws(() => cache.invalidate('weather'), /Unknown cache invalidation/);
  assert.deepEqual(cache.stats().versions, { run: 1, letters: 1, config: 0 });
});

// ------------------------------------------------------------------------------------------ the response layer

test('HTML, the JD route, and the assets carry an ETag; a matching If-None-Match gets 304; gzip when asked', async () => {
  await withHub(async ({ hub }) => {
    const plain = await hub.request('/reports/2026-10-17');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.headers['cache-control'], 'private, no-cache');
    const etag = plain.headers.etag;
    assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
    const zipped = await hub.request('/reports/2026-10-17', { 'accept-encoding': 'gzip, br' });
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.equal(zipped.headers.vary, 'Accept-Encoding');
    assert.equal(zipped.text, plain.text);
    assert.ok(zipped.raw.length < plain.raw.length / 2);
    assert.equal(zipped.headers.etag, etag, 'the tag names the content, not the encoding');

    const again = await hub.request('/reports/2026-10-17', { 'if-none-match': etag, 'accept-encoding': 'gzip' });
    assert.equal(again.status, 304);
    assert.equal(again.raw.length, 0);
    assert.equal(hub.ctx.reportTimings.recent()[0].notModified, true);
    assert.equal((await hub.request('/reports/2026-10-17', { 'if-none-match': '"stale"' })).status, 200);
    assert.equal((await hub.request('/reports/2026-10-17', { 'if-none-match': `W/${etag}` })).status, 304);

    const src = [...plain.text.matchAll(LAZY)][0][1];
    const jd = await hub.request(src);
    assert.equal(jd.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal((await hub.request(src, { 'if-none-match': jd.headers.etag })).status, 304);

    const css = /href="(\/assets\/hub-[a-f0-9]{16}\.css)"/.exec(plain.text)[1];
    const js = /src="(\/assets\/hub-[a-f0-9]{16}\.js)"/.exec(plain.text)[1];
    for (const asset of [css, js]) {
      const reply = await hub.request(asset, { 'accept-encoding': 'gzip' });
      assert.equal(reply.status, 200);
      assert.equal(reply.headers['cache-control'], ASSET_CACHE_CONTROL);
      assert.equal(reply.headers['content-encoding'], 'gzip');
      assert.equal((await hub.request(asset, { 'if-none-match': reply.headers.etag })).status, 304);
    }
    assert.match((await hub.request(css)).headers['content-type'], /^text\/css/);
    assert.equal((await hub.request('/assets/hub-0000000000000000.css')).status, 404);
    // Error pages are never cached.
    const missing = await hub.request('/reports/2026-01-01');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.etag, undefined);
  });
  assert.equal(etagMatches('"a", "b"', '"b"'), true);
  assert.equal(etagMatches('*', '"b"'), true);
  assert.equal(etagMatches(undefined, '"b"'), false);
});

// ------------------------------------------------------------------------------------------ timings

test('each report request logs its stage timings to the hub log and the Status Hub card', async () => {
  await withHub(async ({ hub }) => {
    await hub.request('/reports/2026-10-17', { 'accept-encoding': 'gzip' });
    await hub.request('/reports/2026-10-17');
    assert.match(hub.timingLines[0], /^\[hub\] GET \/reports\/2026-10-17 200 in [\d.]+ ms \(index [\d.]+ ms · payload [\d.]+ ms · review [\d.]+ ms · letters [\d.]+ ms · render [\d.]+ ms · sidebar [\d.]+ ms\) \d+ KB, gzip \d+ KB, cache miss$/);
    assert.match(hub.timingLines[1], /cache hit$/);
    const status = await hub.request('/status');
    const card = status.text.match(/<article class="card" id="hub-card">([\s\S]*?)<\/article>/)[1];
    assert.match(card, /<h2>Hub<\/h2>/);
    assert.match(card, /<td class="mono">\/reports\/2026-10-17<\/td><td>200<\/td><td>[\d.]+ ms<\/td><td>index [\d.]+ ms · payload/);
    assert.match(card, /\(gzip \d+ KB\)/);
    assert.match(card, /id="hub-cache">1 hit\(s\), 1 miss\(es\)/);
  });
  const lines = [];
  const clock = { t: 0 };
  const log = createTimingLog({ log: line => lines.push(line), clock: () => clock.t, now: () => new Date('2026-10-17T15:00:00Z'), limit: 2 });
  const timer = log.start('/reports');
  await timer.phase('index', async () => { clock.t += 4; });
  await timer.phase('render', async () => { clock.t += 2; });
  timer.note('cache', 'hit');
  timer.finish({ bytes: 2048, encodedBytes: 512 });
  assert.equal(lines[0], '[hub] GET /reports 200 in 6 ms (index 4 ms · render 2 ms) 2 KB, gzip 512 B, cache hit');
  log.start('/a').finish(); log.start('/b').finish();
  assert.deepEqual(log.recent().map(record => record.path), ['/b', '/a'], 'only the last N are kept');
  assert.equal(timingLine({ path: '/x', status: 200, totalMs: 1, phases: {}, notModified: true }), '[hub] GET /x 200 in 1 ms (no stages) 304 not modified');
});

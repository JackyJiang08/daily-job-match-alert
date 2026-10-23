// State file safety (2026-10-23): atomic writes, rolling backups with automatic fallback, the integrity
// check (seen-count drop), and the zip backup / restore round trip.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJsonWithBackups, writeFileAtomic, writeJsonAtomic } from '../src/json-file.mjs';
import { checkIntegrity, recordSeenCount, seenDrop } from '../src/state-integrity.mjs';
import { BACKUP_FILE_PATTERN, autoBackupAfterRun, collectBackupFiles, createBackup, listBackups, readBackup, restoreBackup, resolveBackupDirectory } from '../src/backup.mjs';
import { main as backupCli } from '../src/backup-cli.mjs';
import { readZip } from '../src/zip.mjs';
import { main, restoredFromBackupMessage } from '../src/index.mjs';
import { readRegistry, writeRegistry } from '../src/collectors/ats-boards.mjs';
import { fixturePayload, prepareReportProject, selectedMatches, startReportHub, writePayload } from './helpers/report-hub.mjs';
import { addStatusFixture } from './helpers/status-fixture.mjs';

const execFileAsync = promisify(execFile);
const fixtures = new URL('./fixtures/', import.meta.url);
const jsonFileModule = fileURLToPath(new URL('../src/json-file.mjs', import.meta.url));
const NOW = '2026-08-27T12:00:00Z';

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------------------------- atomic writes

test('writeJsonAtomic: a write cut off halfway (or failing at the rename) leaves the previous file whole and no temporary file', async () => {
  const directory = await temporaryDirectory('atomic-');
  const file = path.join(directory, 'state.json');
  try {
    await writeJsonAtomic(file, { version: 1, seen: { a: 1 } });
    // The disk fills (or the process dies) halfway through the new contents.
    const halfWrite = {
      ...fs,
      open: async (target, flags, mode) => {
        const handle = await fs.open(target, flags, mode);
        return {
          writeFile: async data => { await handle.writeFile(String(data).slice(0, 10)); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    await assert.rejects(writeJsonAtomic(file, { version: 2, seen: { a: 1, b: 2 } }, { io: halfWrite }), /ENOSPC/);
    assert.deepEqual(await readJson(file), { version: 1, seen: { a: 1 } });
    const failedRename = { ...fs, rename: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    await assert.rejects(writeJsonAtomic(file, { version: 3 }, { io: failedRename }), /EIO/);
    assert.deepEqual(await readJson(file), { version: 1, seen: { a: 1 } });
    assert.deepEqual((await fs.readdir(directory)).sort(), ['state.json'], 'the temporary files were removed');
    // The data is fsynced before the rename.
    const calls = [];
    const traced = { ...fs, open: async (...args) => { const handle = await fs.open(...args); return { writeFile: data => { calls.push('write'); return handle.writeFile(data); }, sync: () => { calls.push('sync'); return handle.sync(); }, close: () => handle.close() }; }, rename: (...args) => { calls.push('rename'); return fs.rename(...args); } };
    await writeJsonAtomic(file, { version: 4 }, { io: traced });
    assert.deepEqual(calls.slice(0, 3), ['write', 'sync', 'rename']);
    assert.deepEqual(await readJson(file), { version: 4 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('writeJsonAtomic: a writer killed with SIGKILL at random moments never leaves a file that does not parse', async () => {
  const directory = await temporaryDirectory('atomic-kill-');
  const file = path.join(directory, 'state.json');
  const script = `import(${JSON.stringify(jsonFileModule)}).then(async m => {
    const value = { seen: Object.fromEntries(Array.from({ length: 40000 }, (_, k) => ['key' + k, { url: 'https://example.com/jobs/' + k, attempts: 1 }])) };
    for (let i = 0; ; i += 1) { value.round = i; await m.writeJsonAtomic(${JSON.stringify(file)}, value, { backups: 3 }); process.stdout.write('w'); }
  });`;
  try {
    for (let round = 0; round < 6; round += 1) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise(resolve => child.stdout.once('data', resolve));
      await new Promise(resolve => setTimeout(resolve, 5 + Math.floor(Math.random() * 60)));
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
      const value = await readJson(file);
      assert.equal(Object.keys(value.seen).length, 40000, `round ${round}: the file is complete`);
      for (const generation of [1, 2, 3]) if (await exists(`${file}.${generation}`)) await readJson(`${file}.${generation}`);
    }
    // What the kills left behind is swept once it is old enough (the run does this at startup).
    const { sweepTemporaryFiles } = await import('../src/json-file.mjs');
    assert.deepEqual(await sweepTemporaryFiles(directory), [], 'fresh temporary files stay (a writer may still own them)');
    const left = (await fs.readdir(directory)).filter(name => name.endsWith('.tmp'));
    const swept = await sweepTemporaryFiles(directory, { now: new Date(Date.now() + 11 * 60_000) });
    assert.deepEqual(swept.sort(), left.sort());
    assert.ok((await fs.readdir(directory)).every(name => !name.endsWith('.tmp')));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the JSON files under state/ and private/ go through writeJsonAtomic (no direct writeFile of a JSON path left)', async () => {
  const sources = ['src/index.mjs', 'src/collectors/ats-boards.mjs', 'src/resume-sync.mjs', 'src/collectors/search-discovery.mjs', 'src/engines/model-availability.mjs', 'src/engines/claude.mjs', 'src/hub/run.mjs', 'src/hub/auto-catchup.mjs', 'src/hub/services.mjs', 'src/cover-letter/store.mjs', 'src/payload-store.mjs'];
  for (const source of sources) {
    const text = await fs.readFile(new URL(`../${source}`, import.meta.url), 'utf8');
    assert.match(text, /write(Json|File)Atomic/, `${source} uses the atomic writer`);
    assert.doesNotMatch(text, /writeFile\([^)]*JSON\.stringify/, `${source} writes no JSON with a bare writeFile`);
  }
});

// ---------------------------------------------------------------------------------------------- rolling backups

test('state.json and the board registry keep the three previous generations; a file that does not parse falls back to the newest readable one', async () => {
  const directory = await temporaryDirectory('rolling-');
  const file = path.join(directory, 'state.json');
  try {
    for (let version = 1; version <= 5; version += 1) await writeJsonAtomic(file, { version }, { backups: 3 });
    assert.deepEqual(await readJson(file), { version: 5 });
    assert.deepEqual(await Promise.all([1, 2, 3].map(generation => readJson(`${file}.${generation}`))), [{ version: 4 }, { version: 3 }, { version: 2 }]);
    assert.equal(await exists(`${file}.4`), false);

    // A torn file and a torn first backup: the second backup is used.
    await fs.writeFile(file, '{"version": 5, "seen": {');
    await fs.writeFile(`${file}.1`, '');
    const read = await readJsonWithBackups(file, { now: new Date(NOW) });
    assert.deepEqual(read.value, { version: 3 });
    assert.equal(read.restored.generation, 2);
    assert.match(read.restored.error, /JSON/);
    assert.equal(await fs.readFile(file, 'utf8'), '{"version": 5, "seen": {', 'a read without restore leaves the files alone (the hub)');
    const restored = await readJsonWithBackups(file, { now: new Date(NOW), restore: true });
    assert.deepEqual(await readJson(file), { version: 3 }, 'restore puts the backup in place');
    assert.equal(await fs.readFile(restored.restored.quarantined, 'utf8'), '{"version": 5, "seen": {', 'the broken copy is kept aside');
    // The next write rotates the restored (good) file, not the broken one.
    await writeJsonAtomic(file, { version: 6 }, { backups: 3 });
    assert.deepEqual(await readJson(`${file}.1`), { version: 3 });

    // The registry: same rule through readRegistry / writeRegistry.
    const registryFile = path.join(directory, 'ats-boards.json');
    await writeRegistry(registryFile, { boards: { 'greenhouse:alpha': { key: 'greenhouse:alpha', kind: 'greenhouse', token: 'alpha' } } });
    await writeRegistry(registryFile, { boards: { 'greenhouse:alpha': { key: 'greenhouse:alpha', kind: 'greenhouse', token: 'alpha' }, 'greenhouse:bravo': { key: 'greenhouse:bravo', kind: 'greenhouse', token: 'bravo' } } });
    await fs.writeFile(registryFile, '\0\0\0');
    const events = [];
    const registry = await readRegistry(registryFile, fs, { onRestore: restoredInfo => events.push(restoredInfo) });
    assert.deepEqual(Object.keys(registry.boards), ['greenhouse:alpha']);
    assert.equal(events.length, 1);
    assert.equal(path.basename(events[0].from), 'ats-boards.json.1');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function prepareProject() {
  const root = await temporaryDirectory('state-safety-');
  await fs.mkdir(path.join(root, 'intake'), { recursive: true });
  for (const name of ['data-resume.md', 'ai-resume.md']) await fs.copyFile(new URL(name, fixtures), path.join(root, name));
  await fs.copyFile(new URL('demo-new-grad-alert.eml', fixtures), path.join(root, 'intake', 'demo-new-grad-alert.eml'));
  const config = {
    lookbackHours: 24, timeZone: 'America/Chicago', minimumMatchScore: 20, requireFullDescription: true, minimumDescriptionCharacters: 200,
    semanticMatching: { engine: 'local_only' },
    prescreen: { enabled: false },
    reports: { xlsx: { enabled: false } },
    outputDirectory: './output',
    backup: { directory: './backups' },
    resumes: { autoRefresh: false, tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }, { id: 'ai', label: 'AI', profile: './ai-resume.md' }] },
    preferences: { roleTypes: ['internship', 'new_grad', 'entry_level'], locations: ['Remote'], remoteOkay: true, maxYearsExperience: 3, needsSponsorship: null, graduationDate: '2027-05', excludeTitleTerms: [] },
    sources: { githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, simplifyInternships: { enabled: false }, simplifyNewGrad: { enabled: false }, emailFiles: { enabled: true, directory: './intake' }, himalaya: { enabled: false }, careerOps: { enabled: false }, atsBoards: { enabled: true, boards: [] } },
    network: { fetchDescriptions: false, concurrency: 2, timeoutMs: 1000 },
  };
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return { root, configPath };
}

async function quietRun(configPath, options = {}) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await main({ argv: ['node', 'src/index.mjs', '--config', configPath, '--now', options.now || NOW], autoLetters: false, ...options });
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('end to end: a corrupt state.json is restored from its newest readable backup with a warning and the notification; the run finishes', async () => {
  const { root, configPath } = await prepareProject();
  const statePath = path.join(root, 'state', 'state.json');
  try {
    const first = await quietRun(configPath);
    assert.ok(first.meta.matchCount >= 1);
    const good = await readJson(statePath);
    assert.ok(Object.keys(good.seen).length >= 1);
    assert.ok(await exists(`${statePath}.1`), 'the run wrote state.json more than once, keeping the earlier copy');
    // A torn write from some other tool: the run must not stop and must not start over.
    await fs.writeFile(statePath, (await fs.readFile(statePath, 'utf8')).slice(0, 100));
    const notifications = [];
    const second = await quietRun(configPath, { notify: async text => { notifications.push(text); } });
    const backupTime = second.meta.warnings.find(warning => warning.source === 'state.json');
    assert.ok(backupTime, 'a warning names state.json');
    assert.match(backupTime.message, /^state\.json was corrupt, restored from backup \([A-Z][a-z]{2} \d+, \d{4}, \d+:\d{2} [AP]M\) \(state\.json\.1\)/);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /^state\.json was corrupt, restored from backup \([A-Z][a-z]{2} \d+, \d{4}, \d+:\d{2} [AP]M\)$/);
    const after = await readJson(statePath);
    assert.ok(Object.keys(good.seen).every(key => after.seen[key]), 'the seen marks of the first run survived');
    assert.equal(second.meta.integrity, undefined, 'a restore from a recent backup is no seen-count drop');
    assert.match(await fs.readFile(path.join(root, 'output', '2026-08-27', 'warnings.txt'), 'utf8'), /state\.json was corrupt, restored from backup/);
    assert.ok((await fs.readdir(path.join(root, 'state'))).some(name => name.startsWith('state.json.corrupt-')), 'the broken copy is kept for a look');
    assert.equal(restoredFromBackupMessage('state.json', { none: true }, 'America/Chicago'), 'state.json was corrupt and no backup could be read; started from an empty file');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('end to end: a corrupt board registry is restored from its backup with a warning and a notification', async () => {
  const { root, configPath } = await prepareProject();
  const registryFile = path.join(root, 'state', 'ats-boards.json');
  try {
    await writeRegistry(registryFile, { boards: { 'greenhouse:alpha': { key: 'greenhouse:alpha', kind: 'greenhouse', token: 'alpha', enabled: false } } });
    await writeRegistry(registryFile, { boards: { 'greenhouse:alpha': { key: 'greenhouse:alpha', kind: 'greenhouse', token: 'alpha', enabled: false } } });
    await fs.writeFile(registryFile, '{"boards": {"greenhouse:al');
    const notifications = [];
    const run = await quietRun(configPath, { notify: async text => { notifications.push(text); } });
    assert.ok(run.meta.warnings.some(warning => warning.source === 'ats-boards.json' && /^ats-boards\.json was corrupt, restored from backup/.test(warning.message)));
    assert.ok(notifications.some(text => /^ats-boards\.json was corrupt, restored from backup \(/.test(text)));
    assert.ok((await readJson(registryFile)).boards['greenhouse:alpha'], 'the registry is whole again');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------- integrity

test('integrity check: every state JSON parses (payloads excluded), and a seen count below half of the recorded one is a drop', async () => {
  const root = await temporaryDirectory('integrity-');
  try {
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await fs.writeFile(path.join(root, 'state', 'state.json'), JSON.stringify({ seen: { a: {}, b: {}, c: {} } }));
    await fs.writeFile(path.join(root, 'state', 'usage.json'), '{"entries": [');
    await fs.writeFile(path.join(root, 'state', 'report-payload-2026-08-27.json'), 'not read');
    await recordSeenCount(root, 10, { now: new Date(NOW) });
    const check = await checkIntegrity(root, { now: new Date(NOW) });
    assert.deepEqual(check.corrupt, ['usage.json']);
    assert.deepEqual(check.files.map(file => file.name), ['integrity.json', 'usage.json']);
    assert.deepEqual(check.seen, { current: 3, previous: 10, recordedAt: '2026-08-27T12:00:00.000Z' });
    assert.equal(check.seenDrop.previous, 10);
    assert.equal(seenDrop({ seenCount: 10 }, 5), null, 'exactly half is not a drop');
    assert.equal(seenDrop({ seenCount: 10 }, 4).current, 4);
    assert.equal(seenDrop(null, 0), null, 'no record yet');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('end to end: state.json losing most of its seen entries between runs puts a banner in the report header and a warning; a rerun the same day keeps it', async () => {
  const { root, configPath } = await prepareProject();
  const statePath = path.join(root, 'state', 'state.json');
  try {
    await quietRun(configPath);
    const recorded = await readJson(path.join(root, 'state', 'integrity.json'));
    const state = await readJson(statePath);
    assert.equal(recorded.seenCount, Object.keys(state.seen).length);
    // Pad the record so the fixture's few seen postings stand for a real seen map, then lose it.
    await recordSeenCount(root, 400, { now: new Date('2026-08-27T11:00:00Z') });
    await fs.writeFile(statePath, JSON.stringify({ ...state, seen: {} }));
    const second = await quietRun(configPath, { now: '2026-08-27T13:00:00Z' });
    assert.equal(second.meta.integrity.seenDrop.previous, 400);
    assert.equal(second.meta.integrity.seenDrop.current, 0);
    assert.ok(second.meta.warnings.some(warning => warning.source === 'seen state' && /lost most of its seen postings: 0 now against 400/.test(warning.message)));
    const html = await fs.readFile(second.htmlPath, 'utf8');
    assert.match(html, /<div class="banner" data-banner="integrity">state\.json lost most of its seen postings: 0 now against 400 since it was last written \(Aug 27, 2026, 6:00 AM\), 100% fewer\./);
    const third = await quietRun(configPath, { now: '2026-08-27T14:00:00Z' });
    assert.equal(third.meta.integrity.seenDrop.previous, 400, 'the day report keeps the finding');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Status: a seen-count drop, a state.json read from its backup, and a corrupt state file each show in the integrity banner; none without them', async () => {
  const root = await prepareReportProject();
  await addStatusFixture(root, { writePayload, fixturePayload, selectedMatches });
  const statePath = path.join(root, 'state', 'state.json');
  const state = await readJson(statePath);
  let hub = await startReportHub(root);
  try {
    assert.doesNotMatch((await hub.request('/status')).text, /data-banner="integrity"/);
  } finally {
    await hub.close();
  }
  await fs.writeFile(statePath, JSON.stringify({ ...state, seen: { a: {} } }));
  await recordSeenCount(root, 1000, { now: new Date('2026-10-17T01:00:00Z') });
  await fs.writeFile(path.join(root, 'state', 'search-usage.json'), '{"months": {');
  hub = await startReportHub(root);
  try {
    const { checkHubIntegrity } = await import('../src/hub/server.mjs');
    await checkHubIntegrity(hub.ctx);
    const html = (await hub.request('/status')).text;
    assert.match(html, /<div class="flash error" data-banner="integrity">state\.json lost most of its seen postings: 1 now against 1,000 since it was last written \(Oct 16, 2026, 8:00 PM\), 100% fewer\./);
    assert.match(html, /state\/search-usage\.json does not parse/);
    // state.json torn: the hub reads its backup and says so; it never rewrites the file.
    // Written twice the way the pipeline writes it, so state.json.1 holds the full seen map.
    for (let round = 0; round < 2; round += 1) await writeJsonAtomic(statePath, { ...state, seen: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`k${index}`, {}])) }, { backups: 3 });
    await fs.writeFile(path.join(root, 'state', 'search-usage.json'), '{}');
    await fs.writeFile(statePath, '{"lastSuccessfulRun": ');
    const torn = (await hub.request('/status')).text;
    assert.match(torn, /state\/state\.json does not parse; showing its backup state\.json\.1/);
    assert.doesNotMatch(torn, /lost most of its seen postings/, 'the backup holds the seen postings');
    assert.doesNotMatch(torn, /search-usage\.json does not parse/, 'a file that parses again leaves the banner');
    assert.equal(await fs.readFile(statePath, 'utf8'), '{"lastSuccessfulRun": ');
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------- backup and restore

async function backupProject() {
  const root = await temporaryDirectory('backup-project-');
  const write = async (relative, data, mode) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data, mode ? { mode } : undefined);
  };
  await write('config.json', JSON.stringify({ timeZone: 'America/Chicago', outputDirectory: './output', backup: { directory: './backups' }, resumes: { tracks: [{ id: 'data', label: 'Data', profile: './data-resume.md' }] } }, null, 2));
  await fs.copyFile(new URL('data-resume.md', fixtures), path.join(root, 'data-resume.md'));
  await write('state/state.json', JSON.stringify({ seen: { a: { url: 'https://example.com/a' } }, deferred: { b: {} } }));
  await write('state/state.json.1', '{"seen": {}}');
  await write('state/ats-boards.json', JSON.stringify({ version: 1, boards: {} }));
  await write('state/ats-snapshots.json', '{"version":1,"boards":{}}');
  await write('state/resume-sources.json', '{"sources":{}}', 0o600);
  await write('state/report-payload-2026-08-27.json', '{"meta":{"date":"2026-08-27"},"matches":[]}');
  await write('state/report-payload-2026-07-01.json.gz', Buffer.from([0x1f, 0x8b]));
  await write('state/logs/daily-2026-08-27.log', 'log line');
  await write('state/backups/payloads-x/report-payload-2026-07-01.json.gz', Buffer.from([0x1f, 0x8b]));
  await write('state/.lock.tmp', 'x');
  await write('private/cover-letter/profile.json', '{"name":"Jane Doe"}', 0o600);
  await write('private/cover-letters/2026-08-27/ExampleCorp/Jane_Doe_Cover_Letter_ExampleCorp.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]), 0o600);
  await write('private/hub/runs.json', '[]', 0o600);
  await write('private/hub/logs/run-1.log', 'hub log');
  return root;
}

test('backup: private/, state/, and config.json go into a dated zip without payloads, logs, payload backups, or the rolling copies; restore brings back the same bytes and modes', async () => {
  const root = await backupProject();
  const config = { root, timeZone: 'America/Chicago', backup: { directory: './backups' } };
  try {
    assert.equal(resolveBackupDirectory(config, { home: '/Users/jane' }), path.join(root, 'backups'));
    assert.equal(resolveBackupDirectory({ root }, { home: '/Users/jane' }), '/Users/jane/Library/Application Support/daily-job-match-alert/backups');
    assert.equal(resolveBackupDirectory({ root, backup: { directory: '~/Backups/alert' } }, { home: '/Users/jane' }), '/Users/jane/Backups/alert');
    const expected = ['config.json', 'private/cover-letter/profile.json', 'private/cover-letters/2026-08-27/ExampleCorp/Jane_Doe_Cover_Letter_ExampleCorp.pdf', 'private/hub/runs.json', 'state/ats-boards.json', 'state/ats-snapshots.json', 'state/resume-sources.json', 'state/state.json'];
    assert.deepEqual(await collectBackupFiles(root), expected);

    const backup = await createBackup(config, { now: new Date('2026-08-28T02:05:09Z') });
    assert.equal(backup.name, 'daily-job-match-alert-backup-2026-08-27-210509.zip', 'named by the local date and time');
    assert.equal(backup.files, expected.length);
    const { manifest, entries } = await readBackup(backup.file);
    assert.deepEqual(entries.map(entry => entry.name).sort(), expected);
    assert.deepEqual(manifest.files.map(file => file.path).sort(), expected);
    assert.ok(!entries.some(entry => /report-payload|\/logs\/|\.log$|state\/backups|state\.json\.1/.test(entry.name)), 'no payload, log, payload backup, or rolling copy');
    // The system unzip reads the archive and agrees on the contents.
    const { stdout } = await execFileAsync('unzip', ['-Z1', backup.file]).catch(() => ({ stdout: null }));
    if (stdout != null) assert.deepEqual(stdout.trim().split('\n').sort(), ['backup-manifest.json', ...expected].sort());

    const originals = Object.fromEntries(await Promise.all(expected.map(async relative => [relative, await fs.readFile(path.join(root, relative))])));
    const modes = Object.fromEntries(await Promise.all(expected.map(async relative => [relative, (await fs.stat(path.join(root, relative))).mode & 0o777])));
    // Damage and delete: the restore brings every file back byte for byte.
    await fs.writeFile(path.join(root, 'state', 'state.json'), '{"seen": {');
    await fs.rm(path.join(root, 'private', 'cover-letters'), { recursive: true });
    await fs.writeFile(path.join(root, 'config.json'), '{}');
    const restored = await restoreBackup(config, backup.file, { now: new Date('2026-08-28T03:00:00Z') });
    assert.deepEqual(restored.restored.sort(), expected);
    for (const relative of expected) {
      assert.deepEqual(await fs.readFile(path.join(root, relative)), originals[relative], `${relative} is the same`);
      assert.equal((await fs.stat(path.join(root, relative))).mode & 0o777, modes[relative], `${relative} keeps its mode`);
    }
    assert.equal(await fs.readFile(path.join(root, 'state', 'state.json.1'), 'utf8'), '{"seen": {', 'the replaced state.json is kept as .1');
    assert.ok(await exists(path.join(root, 'state', 'report-payload-2026-08-27.json')), 'files outside the backup are left alone');
    assert.match(path.basename(restored.preRestore.file), /-pre-restore\.zip$/);
    const preRestore = await readBackup(restored.preRestore.file);
    assert.equal(preRestore.entries.find(entry => entry.name === 'config.json').data.toString(), '{}', 'the pre-restore backup holds what the restore replaced');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('backup: a damaged or foreign zip and unsafe paths are refused; the newest seven are kept; the nightly backup runs once a day after scheduled runs only', async () => {
  const root = await backupProject();
  const config = { root, timeZone: 'America/Chicago', backup: { directory: './backups' } };
  try {
    const backup = await createBackup(config, { now: new Date('2026-08-28T02:00:00Z') });
    const bytes = await fs.readFile(backup.file);
    const damaged = Buffer.from(bytes);
    damaged[60] ^= 0xff;
    await fs.writeFile(path.join(root, 'damaged.zip'), damaged);
    await assert.rejects(restoreBackup(config, path.join(root, 'damaged.zip')), /checksum|corrupt|invalid|incorrect/i);
    const { createZip } = await import('../src/zip.mjs');
    await fs.writeFile(path.join(root, 'foreign.zip'), await createZip([{ name: 'notes.txt', data: Buffer.from('x') }]));
    await assert.rejects(restoreBackup(config, path.join(root, 'foreign.zip')), /not a Daily Job Match Alert backup/);
    const manifest = Buffer.from(JSON.stringify({ version: 1, app: 'daily-job-match-alert', files: [] }));
    await fs.writeFile(path.join(root, 'escape.zip'), await createZip([{ name: 'backup-manifest.json', data: manifest }, { name: '../outside.txt', data: Buffer.from('x') }]));
    await assert.rejects(restoreBackup(config, path.join(root, 'escape.zip')), /not a plain project path/);
    await fs.writeFile(path.join(root, 'other.zip'), await createZip([{ name: 'backup-manifest.json', data: manifest }, { name: 'src/index.mjs', data: Buffer.from('x') }]));
    await assert.rejects(restoreBackup(config, path.join(root, 'other.zip')), /only config\.json, private\/, and state\/ are restored/);
    assert.equal(await exists(path.join(root, '..', 'outside.txt')), false);

    // Nine more nights: seven stay.
    for (let night = 1; night <= 9; night += 1) await createBackup(config, { now: new Date(Date.parse('2026-08-28T02:00:00Z') + night * 86_400_000) });
    const kept = await listBackups(path.join(root, 'backups'));
    assert.equal(kept.length, 7);
    assert.equal(kept[0].date, '2026-09-05');
    assert.equal(kept.at(-1).date, '2026-08-30');
    assert.ok(kept.every(item => BACKUP_FILE_PATTERN.test(item.name)));

    const directory = path.join(root, 'nightly');
    const nightlyConfig = { ...config, backup: { directory } };
    assert.deepEqual(await autoBackupAfterRun(nightlyConfig, { trigger: 'manual', now: new Date('2026-09-10T01:30:00Z') }), { skipped: 'trigger' });
    const made = await autoBackupAfterRun(nightlyConfig, { trigger: 'scheduled', now: new Date('2026-09-10T01:30:00Z') });
    assert.equal(path.basename(made.file), 'daily-job-match-alert-backup-2026-09-09-203000.zip');
    assert.deepEqual(await autoBackupAfterRun(nightlyConfig, { trigger: 'catchup', now: new Date('2026-09-10T03:00:00Z') }), { skipped: 'done today' });
    assert.equal((await autoBackupAfterRun(nightlyConfig, { trigger: 'auto_catchup', now: new Date('2026-09-11T01:30:00Z') })).name, 'daily-job-match-alert-backup-2026-09-10-203000.zip');
    assert.deepEqual(await autoBackupAfterRun({ ...nightlyConfig, backup: { directory, auto: false } }, { trigger: 'scheduled', now: new Date('2026-09-12T01:30:00Z') }), { skipped: 'off' });
    await fs.writeFile(path.join(root, 'state', '.lock'), `${process.pid}\n`);
    assert.equal((await autoBackupAfterRun(nightlyConfig, { trigger: 'scheduled', now: new Date('2026-09-12T01:30:00Z') })).skipped, 'locked', 'never during a run');
    assert.equal((await restoreBackup(config, kept[0].file)).skipped, true, 'no restore during a run');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the backup command and restore command (npm run backup / npm run restore -- <zip>)', async () => {
  const root = await backupProject();
  const lines = [];
  try {
    const made = await backupCli(['node', 'src/backup-cli.mjs', 'backup', '--config', path.join(root, 'config.json')], { now: new Date('2026-08-28T02:00:00Z'), log: line => lines.push(line), home: root });
    assert.match(lines[0], /^Backed up 8 file\(s\) to .*daily-job-match-alert-backup-2026-08-27-210000\.zip \(\d+(\.\d)? (KB|B)\)\.$/);
    await fs.writeFile(path.join(root, 'state', 'state.json'), '{}');
    await backupCli(['node', 'src/backup-cli.mjs', 'restore', '--config', path.join(root, 'config.json'), made.file], { now: new Date('2026-08-28T03:00:00Z'), log: line => lines.push(line), home: root });
    assert.match(lines.join('\n'), /Restored 8 file\(s\) from daily-job-match-alert-backup-2026-08-27-210000\.zip/);
    assert.deepEqual((await readJson(path.join(root, 'state', 'state.json'))).deferred, { b: {} });
    const usage = await backupCli(['node', 'src/backup-cli.mjs', 'restore', '--config', path.join(root, 'config.json')], { log: line => lines.push(line), home: root });
    assert.equal(usage.usage, true);
    assert.match(lines.at(-1), /^Usage: npm run restore -- <zip>\nBackups in /);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Status Runs card shows the newest backup time and size', async () => {
  const root = await prepareReportProject();
  const hub = await startReportHub(root);
  try {
    assert.match((await hub.request('/status')).text, /<dt>Backup<\/dt><dd id="backup-line">No backup yet/);
    const directory = path.join(root, 'Library', 'Application Support', 'daily-job-match-alert', 'backups');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'daily-job-match-alert-backup-2026-10-16-200500.zip');
    await fs.writeFile(file, Buffer.alloc(3 * 1024 * 1024 + 200 * 1024));
    await fs.utimes(file, new Date('2026-10-17T01:05:00Z'), new Date('2026-10-17T01:05:00Z'));
    const html = (await hub.request('/status')).text;
    assert.match(html, /<dt>Backup<\/dt><dd id="backup-line">Oct 16, 2026, 8:05 PM · 3\.2 MB <span class="muted">·<\/span> <span class="muted" title="[^"]+">1 kept · nightly after the scheduled run · <code>npm run backup<\/code><\/span><\/dd>/);
  } finally {
    await hub.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('zip: entries round-trip with their names, bytes, modes, and times; empty and incompressible files too', async () => {
  const { createZip } = await import('../src/zip.mjs');
  const random = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 7919 + 13) % 256));
  const when = new Date(2026, 7, 27, 20, 5, 10);
  const entries = [
    { name: 'a.json', data: Buffer.from('{"a":1}'.repeat(500)), mode: 0o644, mtime: when },
    { name: 'dir/ü.txt', data: Buffer.from('unicode name'), mode: 0o600, mtime: when },
    { name: 'empty.txt', data: Buffer.alloc(0), mode: 0o644, mtime: when },
    { name: 'random.bin', data: random, mode: 0o600, mtime: when },
  ];
  const read = await readZip(await createZip(entries));
  assert.deepEqual(read.map(entry => [entry.name, entry.data.toString('base64'), entry.mode, entry.mtime.getTime()]), entries.map(entry => [entry.name, entry.data.toString('base64'), entry.mode, when.getTime()]));
});

test('writeFileAtomic keeps the requested mode and works with a test double that has no open()', async () => {
  const directory = await temporaryDirectory('atomic-mode-');
  try {
    const file = path.join(directory, 'runs.json');
    await writeFileAtomic(file, '[]\n', { mode: 0o600 });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const { open, ...withoutOpen } = fs;
    await writeJsonAtomic(path.join(directory, 'x.json'), { ok: true }, { io: withoutOpen });
    assert.deepEqual(await readJson(path.join(directory, 'x.json')), { ok: true });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


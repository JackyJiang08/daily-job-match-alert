import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readResumeSource, syncResumes, isCloudEvictionError } from '../src/resume-sync.mjs';
import { warningText } from '../src/warnings.mjs';

function trackConfig(root, sources, overrides = {}) {
  return {
    root,
    resumes: {
      autoRefresh: true,
      pdftotextCommand: '/custom/pdftotext',
      tracks: [
        { id: 'data', label: 'Data', profile: path.join(root, 'resumes', 'data.md'), pdf: sources.data, enabled: true },
        { id: 'llm', label: 'LLM', profile: path.join(root, 'resumes', 'llm.md'), pdf: sources.llm, enabled: true },
        { id: 'agent', label: 'AI Agent', profile: path.join(root, 'resumes', 'agent.md'), pdf: sources.agent, enabled: false },
      ],
      ...overrides,
    },
  };
}

function pdftotextRunner(calls) {
  return async (command, args) => {
    assert.equal(command, '/custom/pdftotext');
    calls.push(args[1]);
    return { stdout: `${path.basename(args[1])}\n${'resume evidence '.repeat(30)}` };
  };
}

// The exact error Node raises for a cloud-only iCloud placeholder.
function evictedError(file) {
  const error = new Error(`Unknown system error -11: Unknown system error -11, open '${file}'`);
  error.errno = -11;
  error.syscall = 'open';
  error.path = file;
  return error;
}

test('refreshes private resume text per enabled track when a source PDF changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-sync-test-'));
  const sources = { data: path.join(root, 'data.pdf'), llm: path.join(root, 'llm.pdf'), agent: path.join(root, 'agent.pdf') };
  await fs.writeFile(sources.data, 'data-v1');
  await fs.writeFile(sources.llm, 'llm-v1');
  // The disabled track's PDF is deliberately missing: it must never be read.
  const config = trackConfig(root, sources);
  const calls = [];
  const runner = pdftotextRunner(calls);

  try {
    const first = await syncResumes(config, { runner });
    assert.deepEqual(first.refreshed, ['data', 'llm']);
    assert.deepEqual(first.skipped, ['agent']);
    assert.deepEqual(first.recovered, []);
    assert.deepEqual(first.warnings, []);
    assert.equal(calls.length, 2);
    const second = await syncResumes(config, { runner });
    assert.deepEqual(second.unchanged, ['data', 'llm']);
    assert.equal(calls.length, 2);
    await fs.writeFile(sources.llm, 'llm-v2');
    const third = await syncResumes(config, { runner });
    assert.deepEqual(third.refreshed, ['llm']);
    assert.equal(calls.length, 3);
    const llm = await fs.readFile(config.resumes.tracks[1].profile, 'utf8');
    assert.match(llm, /Generated locally from a private PDF/);
    assert.match(llm, /Track: llm/);
    assert.match(llm, /^# LLM resume$/m);
    await assert.rejects(fs.access(config.resumes.tracks[2].profile), 'disabled track must not be extracted');
    const state = JSON.parse(await fs.readFile(path.join(root, 'state', 'resume-sources.json'), 'utf8'));
    assert.deepEqual(Object.keys(state.sources), ['data', 'llm']);
    assert.equal(state.sources.llm.label, 'LLM');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('autoRefresh requires a pdf on every enabled track and does nothing when disabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-sync-off-'));
  try {
    const off = await syncResumes(trackConfig(root, {}, { autoRefresh: false }));
    assert.deepEqual(off, { refreshed: [], unchanged: [], skipped: [], recovered: [], warnings: [], enabled: false });
    await assert.rejects(syncResumes(trackConfig(root, {})), /"data" needs a pdf path/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recognizes the iCloud eviction signatures and nothing else', () => {
  assert.equal(isCloudEvictionError(evictedError('/x.pdf')), true);
  assert.equal(isCloudEvictionError(Object.assign(new Error('resource temporarily unavailable'), { code: 'EAGAIN' })), true);
  assert.equal(isCloudEvictionError(new Error('Unknown system error -11')), true);
  assert.equal(isCloudEvictionError(Object.assign(new Error('no such file'), { code: 'ENOENT', errno: -2 })), false);
  assert.equal(isCloudEvictionError(null), false);
});

test('an evicted PDF is downloaded with brctl, re-read after polling, and disclosed as an info warning', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-sync-icloud-'));
  const sources = { data: path.join(root, 'data.pdf'), llm: path.join(root, 'llm.pdf') };
  await fs.writeFile(sources.data, 'data-v1');
  await fs.writeFile(sources.llm, 'llm-v1');
  const config = trackConfig(root, sources);
  const pdfCalls = [];
  const commands = [];
  const runner = async (command, args, options) => {
    if (command === 'brctl') {
      commands.push(args);
      assert.deepEqual(args, ['download', sources.data]);
      return { stdout: '', stderr: '' };
    }
    return pdftotextRunner(pdfCalls)(command, args, options);
  };
  // The Data PDF reports errno -11 for the first read and the first two polls, then materializes.
  let dataReads = 0;
  const readFile = async file => {
    if (file === sources.data && dataReads++ < 3) throw evictedError(file);
    return fs.readFile(file);
  };
  const sleeps = [];
  const warnings = [];
  try {
    const result = await syncResumes(config, { runner, readFile, platform: 'darwin', sleep: async ms => sleeps.push(ms), warnings });
    assert.deepEqual(result.refreshed, ['data', 'llm']);
    assert.deepEqual(result.recovered, ['data']);
    assert.deepEqual(commands, [['download', sources.data]], 'brctl runs exactly once, for the evicted file only');
    assert.deepEqual(sleeps, [2000, 2000, 2000], 'polls every 2 seconds until the read succeeds');
    assert.equal(result.warnings.length, 1);
    assert.deepEqual(warnings, result.warnings, 'the same notice is pushed to the caller-supplied sink');
    assert.deepEqual(warnings[0], { stage: 'resume', source: 'Data resume', message: 'Data 简历曾被 iCloud 云端化，已自动取回', level: 'info' });
    assert.equal(warningText(warnings[0]), '[resume / Data resume] info: Data 简历曾被 iCloud 云端化，已自动取回');
    assert.deepEqual(pdfCalls, [sources.data, sources.llm], 'extraction still ran on the recovered file');
    const state = JSON.parse(await fs.readFile(path.join(root, 'state', 'resume-sources.json'), 'utf8'));
    assert.equal(state.sources.data.sourcePath, sources.data);

    // An empty read of a non-empty file is the other eviction signature.
    let emptyReads = 0;
    const emptyThenReal = async file => (file === sources.llm && emptyReads++ < 1 ? Buffer.alloc(0) : fs.readFile(file));
    const again = await readResumeSource(config.resumes.tracks[1], sources.llm, { runner, readFile: emptyThenReal, platform: 'darwin', sleep: async () => {} });
    assert.equal(again.recovered, true);
    assert.equal(again.buffer.toString(), 'llm-v1');

    // A genuinely empty file is not an eviction and is returned as-is.
    await fs.writeFile(sources.llm, '');
    const empty = await readResumeSource(config.resumes.tracks[1], sources.llm, { runner, platform: 'darwin', sleep: async () => {} });
    assert.deepEqual(empty, { buffer: Buffer.alloc(0), recovered: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an evicted PDF that never materializes fails after 60 seconds with a plain-language message', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-sync-icloud-timeout-'));
  const sources = { data: path.join(root, 'data.pdf'), llm: path.join(root, 'llm.pdf') };
  await fs.writeFile(sources.data, 'data-v1');
  await fs.writeFile(sources.llm, 'llm-v1');
  const config = trackConfig(root, sources);
  const commands = [];
  const pdfCalls = [];
  const runner = async (command, args, options) => {
    if (command === 'brctl') { commands.push(args); return { stdout: '', stderr: '' }; }
    return pdftotextRunner(pdfCalls)(command, args, options);
  };
  const readFile = async file => { if (file === sources.data) throw evictedError(file); return fs.readFile(file); };
  const sleeps = [];
  const warnings = [];
  try {
    await assert.rejects(
      syncResumes(config, { runner, readFile, platform: 'darwin', sleep: async ms => sleeps.push(ms), warnings }),
      error => {
        assert.equal(error.code, 'ICLOUD_EVICTED');
        assert.match(error.message, /^Data 简历文件被 iCloud 移至云端且自动下载失败，请在 Finder 中右键该文件选择“立即下载”，或将简历移出 iCloud 同步目录。/);
        assert.ok(error.message.includes(sources.data), 'the failure names the file');
        assert.match(error.message, /Unknown system error -11/);
        assert.equal(error.cause?.errno, -11);
        return true;
      },
    );
    assert.equal(commands.length, 1);
    assert.equal(sleeps.length, 30, '30 polls of 2 s cover the 60 s budget');
    assert.ok(sleeps.every(ms => ms === 2000));
    assert.deepEqual(warnings, [], 'a failed recovery is fatal, not a warning');
    assert.deepEqual(pdfCalls, [], 'nothing was extracted');
    await assert.rejects(fs.access(path.join(root, 'state', 'resume-sources.json')), 'state must not be written by a failed sync');

    // brctl complaining does not shorten the wait: the download request is usually still queued.
    const grumpy = async (command, args, options) => {
      if (command === 'brctl') throw Object.assign(new Error('brctl exited 1'), { code: 1 });
      return pdftotextRunner(pdfCalls)(command, args, options);
    };
    const polls = [];
    await assert.rejects(
      readResumeSource(config.resumes.tracks[0], sources.data, { runner: grumpy, readFile, platform: 'darwin', sleep: async ms => polls.push(ms) }),
      /ICLOUD|iCloud/,
    );
    assert.equal(polls.length, 30);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('off macOS, or without brctl, the original read error propagates and nothing is retried', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-sync-nonmac-'));
  const sources = { data: path.join(root, 'data.pdf'), llm: path.join(root, 'llm.pdf') };
  await fs.writeFile(sources.data, 'data-v1');
  await fs.writeFile(sources.llm, 'llm-v1');
  const config = trackConfig(root, sources);
  const readFile = async file => { if (file === sources.data) throw evictedError(file); return fs.readFile(file); };
  const sleeps = [];
  try {
    // Linux: brctl there is the bridge-utils tool, so it must never be invoked.
    const commands = [];
    const runner = async (command, args) => { commands.push([command, ...args]); return { stdout: '' }; };
    await assert.rejects(
      syncResumes(config, { runner, readFile, platform: 'linux', sleep: async ms => sleeps.push(ms) }),
      error => error.errno === -11 && /Unknown system error -11/.test(error.message) && error.code !== 'ICLOUD_EVICTED',
    );
    assert.deepEqual(commands, []);
    assert.deepEqual(sleeps, []);

    // macOS shell without brctl on PATH: same untouched error, no polling.
    const noBrctl = async command => { if (command === 'brctl') throw Object.assign(new Error('spawn brctl ENOENT'), { code: 'ENOENT' }); return { stdout: '' }; };
    await assert.rejects(
      readResumeSource(config.resumes.tracks[0], sources.data, { runner: noBrctl, readFile, platform: 'darwin', sleep: async ms => sleeps.push(ms) }),
      error => error.errno === -11 && error.code !== 'ICLOUD_EVICTED',
    );
    assert.deepEqual(sleeps, []);

    // Unrelated read errors are never treated as eviction, on any platform.
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open 'x'"), { code: 'ENOENT', errno: -2 });
    await assert.rejects(
      readResumeSource(config.resumes.tracks[0], sources.data, { runner: noBrctl, readFile: async () => { throw enoent; }, platform: 'darwin', sleep: async ms => sleeps.push(ms) }),
      error => error === enoent,
    );
    assert.deepEqual(sleeps, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

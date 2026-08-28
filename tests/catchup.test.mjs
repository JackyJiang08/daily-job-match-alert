import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCatchup, shouldRunCatchup } from '../src/catchup.mjs';

test('catch-up skips a recent success and runs after the 26-hour threshold', () => {
  const now = new Date('2026-08-28T18:00:00.000Z');
  assert.equal(shouldRunCatchup({ lastSuccessfulRun: '2026-08-27T17:00:01.000Z' }, now), false);
  assert.equal(shouldRunCatchup({ lastSuccessfulRun: '2026-08-27T15:59:59.000Z' }, now), true);
  assert.equal(shouldRunCatchup({}, now), true);
});

test('runCatchup invokes the full index run only when state is overdue', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-alert-catchup-'));
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    outputDirectory: './reports',
    resumes: { data: './data.md', ai: './ai.md' },
  }));
  const calls = [];
  try {
    const skipped = await runCatchup({
      configPath,
      now: new Date('2026-08-28T18:00:00.000Z'),
      readState: async () => ({ seen: {}, lastSuccessfulRun: '2026-08-28T17:00:00.000Z' }),
      runner: async (...args) => calls.push(args),
    });
    assert.equal(skipped.ran, false);
    assert.equal(calls.length, 0);

    const ran = await runCatchup({
      configPath,
      now: new Date('2026-08-28T18:00:00.000Z'),
      readState: async () => ({ seen: {}, lastSuccessfulRun: '2026-08-27T15:00:00.000Z' }),
      runner: async (...args) => calls.push(args),
    });
    assert.equal(ran.ran, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][0].some(value => String(value).endsWith('/src/index.mjs')));
    assert.deepEqual(calls[0][0].slice(-2), ['--now', '2026-08-28T18:00:00.000Z']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

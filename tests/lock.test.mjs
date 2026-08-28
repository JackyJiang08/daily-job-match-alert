import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireRunLock, releaseRunLock } from '../src/lock.mjs';

test('a live lock owner prevents a second unattended run', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-alert-lock-live-'));
  const lockPath = path.join(directory, 'state', '.lock');
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, '4242\n');
    const lock = await acquireRunLock(lockPath, { pid: 5151, pidAlive: pid => pid === 4242 });
    assert.deepEqual(lock, { acquired: false, pid: 4242, lockPath });
    assert.equal(await fs.readFile(lockPath, 'utf8'), '4242\n');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a stale lock is removed and replaced atomically', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-alert-lock-stale-'));
  const lockPath = path.join(directory, 'state', '.lock');
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, '4242\n');
    const lock = await acquireRunLock(lockPath, { pid: 5151, pidAlive: () => false });
    assert.equal(lock.acquired, true);
    assert.equal(await fs.readFile(lockPath, 'utf8'), '5151\n');
    await releaseRunLock(lock);
    await assert.rejects(fs.access(lockPath), error => error.code === 'ENOENT');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

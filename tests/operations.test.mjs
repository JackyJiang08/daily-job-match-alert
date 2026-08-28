import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeFatalErrorReport } from '../src/index.mjs';
import { launchdTrigger } from '../src/launchd-dispatch.mjs';
import { prepareDailyLog } from '../src/logs.mjs';

test('launchd auto mode separates scheduled execution from RunAtLoad catch-up', () => {
  assert.equal(launchdTrigger({
    requested: 'auto',
    now: new Date('2026-08-27T08:00:00'),
    hour: 20,
    minute: 0,
    lastSuccessfulRun: '2026-08-26T20:00:00',
  }), 'catchup');
  assert.equal(launchdTrigger({
    requested: 'auto',
    now: new Date('2026-08-27T20:00:00'),
    hour: 20,
    minute: 0,
    lastSuccessfulRun: '2026-08-27T08:00:00',
  }), 'scheduled');
  assert.equal(launchdTrigger({
    requested: 'auto',
    now: new Date('2026-08-27T21:00:00'),
    hour: 20,
    minute: 0,
    lastSuccessfulRun: '2026-08-27T20:30:00',
  }), 'catchup');
});

test('fatal errors produce a visible HTML artifact in the configured output directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-alert-fatal-'));
  const configPath = path.join(directory, 'config.json');
  const outputDirectory = path.join(directory, 'reports');
  try {
    await fs.writeFile(configPath, JSON.stringify({
      timeZone: 'America/Chicago',
      outputDirectory: './reports',
      resumes: { data: './data.md', ai: './ai.md' },
    }));
    const reportPath = await writeFatalErrorReport(new Error('collector setup exploded'), {
      argv: ['node', 'src/index.mjs', '--config', configPath, '--now', '2026-08-27T20:00:00-05:00'],
    });
    assert.equal(reportPath, path.join(outputDirectory, 'ERROR-2026-08-27.html'));
    const html = await fs.readFile(reportPath, 'utf8');
    assert.match(html, /collector setup exploded/);
    assert.match(html, /Error: collector setup exploded/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('dated launchd logs retain only the newest 30 files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-alert-logs-'));
  try {
    await Promise.all(Array.from({ length: 31 }, (_, index) => {
      const day = String(index + 1).padStart(2, '0');
      return fs.writeFile(path.join(directory, `daily-2026-07-${day}.log`), 'old');
    }));
    const logPath = await prepareDailyLog(directory, new Date('2026-08-27T20:00:00Z'), 30);
    assert.match(path.basename(logPath), /^daily-2026-08-\d{2}\.log$/);
    const names = (await fs.readdir(directory)).filter(name => name.startsWith('daily-'));
    assert.equal(names.length, 30);
    assert.equal(names.includes('daily-2026-07-01.log'), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

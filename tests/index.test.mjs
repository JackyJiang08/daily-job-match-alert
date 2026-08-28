import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnabledSources, resolveRunDates } from '../src/index.mjs';

test('collector failures become warnings while other sources still return jobs', async () => {
  const warnings = [];
  const config = {
    sources: {
      simplifyInternships: { enabled: true, url: 'internships' },
      simplifyNewGrad: { enabled: true, url: 'new-grad' },
      emailFiles: { enabled: true, directory: '/mail' },
      himalaya: { enabled: false },
      careerOps: { enabled: false },
    },
  };
  const jobs = await collectEnabledSources(config, new Date('2026-08-27T00:00:00Z'), {
    warnings,
    collectors: {
      simplify: async options => {
        if (options.roleType === 'internship') throw new Error('network unavailable');
        return [{ url: 'https://example.com/new-grad', title: 'Data Analyst', description: '' }];
      },
      emailFiles: async () => [{ url: 'https://example.com/email', title: 'ML Engineer', description: '' }],
    },
  });

  assert.equal(jobs.length, 2);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].source, 'SimplifyJobs Summer Internships');
  assert.match(warnings[0].message, /network unavailable/);
});

test('a --now morning catch-up uses the same local day as the application date', () => {
  const dates = resolveRunDates(
    ['node', 'src/index.mjs', '--now', '2026-08-27T09:00:00-05:00'],
    'America/Chicago',
    1,
  );
  assert.equal(dates.runDate, '2026-08-27');
  assert.equal(dates.applicationDate, '2026-08-27');
  assert.equal(dates.reportDateOffsetDays, 0);
});

test('a --now run after 14:00 keeps the next-day application date', () => {
  const dates = resolveRunDates(
    ['node', 'src/index.mjs', '--now', '2026-08-27T20:00:00-05:00'],
    'America/Chicago',
    1,
  );
  assert.equal(dates.runDate, '2026-08-27');
  assert.equal(dates.applicationDate, '2026-08-28');
  assert.equal(dates.reportDateOffsetDays, 1);
});

test('the --now 14:00 boundary still belongs to the same-day catch-up window', () => {
  const dates = resolveRunDates(
    ['node', 'src/index.mjs', '--now', '2026-08-27T14:00:00-05:00'],
    'America/Chicago',
    1,
  );
  assert.equal(dates.applicationDate, '2026-08-27');
  assert.equal(dates.reportDateOffsetDays, 0);
});

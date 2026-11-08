import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnabledSources, resolveRunDates } from '../src/index.mjs';

test('collector failures become warnings while other sources still return jobs', async () => {
  const warnings = [];
  const config = {
    sources: {
      githubLists: { enabled: false }, hackerNewsHiring: { enabled: false }, remoteOk: { enabled: false }, 
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

test('the report date is the run\'s local day, also when 18:00 Chicago is already the next day in UTC', () => {
  for (const [now, day] of [
    ['2026-11-08T18:00:00-06:00', '2026-11-08'], // 2026-11-09T00:00Z
    ['2026-11-08T18:02:00-06:00', '2026-11-08'],
    ['2026-11-08T23:59:00-06:00', '2026-11-08'],
    ['2026-08-27T18:00:00-05:00', '2026-08-27'], // daylight time: 23:00Z the same day
    ['2026-08-27T20:00:00-05:00', '2026-08-27'], // a run after the old 14:00 cut-off no longer moves to the next day
    ['2026-08-27T09:00:00-05:00', '2026-08-27'],
    ['2026-11-09T00:30:00-06:00', '2026-11-09'],
  ]) {
    const dates = resolveRunDates(['node', 'src/index.mjs', '--now', now], 'America/Chicago');
    assert.equal(dates.runDate, day, now);
    assert.equal(dates.applicationDate, day, now);
  }
  // An old config that still carries reportDateOffsetDays: 1 changes nothing.
  assert.equal(resolveRunDates(['node', 'src/index.mjs', '--now', '2026-11-08T18:00:00-06:00'], 'America/Chicago', 1).applicationDate, '2026-11-08');
});

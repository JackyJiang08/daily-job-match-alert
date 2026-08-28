import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEnabledSources } from '../src/index.mjs';

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

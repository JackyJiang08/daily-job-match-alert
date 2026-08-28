import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalUrl } from '../src/utils.mjs';

test('canonical URL retains Greenhouse gh_jid while removing actual tracking parameters', () => {
  const first = canonicalUrl('https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=12345&gh_src=alert&utm_source=email');
  const second = canonicalUrl('https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=67890&gh_src=alert&utm_source=email');

  assert.equal(first, 'https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=12345');
  assert.equal(second, 'https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=67890');
  assert.notEqual(first, second);
});

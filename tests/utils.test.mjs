import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCATION_SEPARATOR, canonicalUrl, locationsFromHtmlCell, normalizeLocation, splitLocations } from '../src/utils.mjs';

test('canonical URL retains Greenhouse gh_jid while removing actual tracking parameters', () => {
  const first = canonicalUrl('https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=12345&gh_src=alert&utm_source=email');
  const second = canonicalUrl('https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=67890&gh_src=alert&utm_source=email');

  assert.equal(first, 'https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=12345');
  assert.equal(second, 'https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=67890');
  assert.notEqual(first, second);
});

test('multiple locations are split at state-code boundaries and joined with one separator', () => {
  assert.equal(LOCATION_SEPARATOR, ' · ');
  assert.equal(normalizeLocation('Boston, MA Johnston, RI Columbus, OH'), 'Boston, MA · Johnston, RI · Columbus, OH');
  assert.equal(normalizeLocation('3 locations Boston, MA Johnston, RI Columbus, OH'), 'Boston, MA · Johnston, RI · Columbus, OH');
  assert.equal(normalizeLocation('Charlotte, North Carolina / Chandler, Arizona'), 'Charlotte, North Carolina · Chandler, Arizona');
  assert.equal(normalizeLocation(['Boston, MA', 'Remote', 'Boston, MA']), 'Boston, MA · Remote');
  assert.equal(normalizeLocation('San Francisco, CA'), 'San Francisco, CA');
  assert.equal(normalizeLocation('Remote in USA'), 'Remote in USA');
  assert.equal(normalizeLocation('Austin, TX 78701'), 'Austin, TX 78701', 'a ZIP after the state code is not a new location');
  assert.equal(normalizeLocation('Toronto, ON Canada'), 'Toronto, ON Canada', 'a country after a province code is not a new location');
  assert.equal(normalizeLocation(''), '');
  assert.deepEqual(splitLocations('New York, NY · Remote'), ['New York, NY', 'Remote']);
  assert.equal(
    locationsFromHtmlCell('<details><summary><strong>3 locations</strong></summary>Boston, MA</br>Johnston, RI</br>Columbus, OH</details>'),
    'Boston, MA · Johnston, RI · Columbus, OH',
  );
  assert.equal(locationsFromHtmlCell('Chicago, IL<br/>Remote'), 'Chicago, IL · Remote');
});

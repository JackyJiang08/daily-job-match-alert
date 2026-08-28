import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichJob } from '../src/enrich.mjs';
import { isJobSeen, markJobSeen } from '../src/state.mjs';
import { canonicalUrl, sha256 } from '../src/utils.mjs';

test('records both a tracked original URL and its redirect target so the next day is not new', async () => {
  const collectedUrl = canonicalUrl('https://alerts.example.com/click?job=42&utm_source=handshake');
  const finalUrl = canonicalUrl('https://jobs.example.com/data-analyst?job=42&utm_source=email');
  const response = {
    ok: true,
    status: 200,
    url: finalUrl,
    headers: { get: () => 'text/html' },
    text: async () => '<html><head><title>Data Analyst</title></head><body></body></html>',
  };
  const enriched = await enrichJob({
    url: collectedUrl,
    title: 'Data Analyst',
    company: 'Acme',
    location: 'Remote',
    description: '',
  }, {}, async () => response);

  assert.equal(enriched.originalUrl, collectedUrl);
  assert.equal(enriched.finalUrl, finalUrl);
  assert.equal(enriched.url, finalUrl);

  const state = { seen: {} };
  markJobSeen(state, enriched, '2026-08-27T20:00:00.000Z');
  assert.ok(state.seen[sha256(collectedUrl)]);
  assert.ok(state.seen[sha256(finalUrl)]);
  assert.equal(isJobSeen(state, { url: collectedUrl }), true);

  const legacyState = { seen: { [sha256(finalUrl)]: { url: finalUrl, firstSeen: '2026-08-26T20:00:00.000Z' } } };
  assert.equal(isJobSeen(legacyState, enriched), true);
  markJobSeen(legacyState, enriched, '2026-08-27T20:00:00.000Z');
  assert.ok(legacyState.seen[sha256(collectedUrl)]);
});

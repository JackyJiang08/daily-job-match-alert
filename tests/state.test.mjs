import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichJob } from '../src/enrich.mjs';
import { isJobSeen, jobSeenStatus, markJobSeen, pruneSeen } from '../src/state.mjs';
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

test('prunes 90-day seen state while aging unfinished entries from their last attempt', () => {
  const state = { seen: {
    completedOld: { completed: true, firstSeen: '2026-01-01T00:00:00.000Z', lastAttempt: '2026-01-01T00:00:00.000Z' },
    completedRecent: { completed: true, firstSeen: '2026-08-01T00:00:00.000Z', lastAttempt: '2026-08-01T00:00:00.000Z' },
    unfinishedRetried: { completed: false, attempts: 2, firstSeen: '2026-01-01T00:00:00.000Z', lastAttempt: '2026-08-26T00:00:00.000Z' },
    unfinishedAbandoned: { completed: false, attempts: 2, firstSeen: '2026-01-01T00:00:00.000Z', lastAttempt: '2026-02-01T00:00:00.000Z' },
  } };

  assert.equal(pruneSeen(state, new Date('2026-08-27T20:00:00.000Z'), 90), 2);
  assert.deepEqual(Object.keys(state.seen).sort(), ['completedRecent', 'unfinishedRetried']);
});

test('failed enrichment is retried until the third failed attempt', async () => {
  const failed = await enrichJob({
    url: 'https://example.com/jobs/retry', title: 'Data Analyst', company: 'Acme', location: 'Remote', description: '',
  }, {}, async () => { throw new Error('offline'); });
  assert.equal(failed.enrichment, 'failed');

  const state = { seen: {} };
  const first = markJobSeen(state, failed, '2026-08-27T20:00:00.000Z');
  assert.deepEqual(first, { attempts: 1, completed: false });
  assert.equal(isJobSeen(state, failed), false);
  const second = markJobSeen(state, failed, '2026-08-28T20:00:00.000Z');
  assert.deepEqual(second, { attempts: 2, completed: false });
  assert.equal(isJobSeen(state, failed), false);
  const third = markJobSeen(state, failed, '2026-08-29T20:00:00.000Z');
  assert.deepEqual(third, { attempts: 3, completed: true });
  assert.equal(isJobSeen(state, failed), true);
  assert.deepEqual(jobSeenStatus(state, failed), third);
});

test('unrecoverable HTTP failures are closed on the first attempt', async () => {
  for (const status of [403, 404, 410]) {
    const blocked = await enrichJob({
      url: `https://example.com/jobs/${status}`, title: 'Data Analyst', company: 'Acme', location: 'Remote', description: '',
    }, {}, async () => new Response('', { status }));
    assert.equal(blocked.enrichment, 'failed');
    assert.equal(blocked.enrichmentRetryable, false);

    const state = { seen: {} };
    assert.deepEqual(markJobSeen(state, blocked, '2026-08-27T20:00:00.000Z'), { attempts: 1, completed: true });
    assert.equal(isJobSeen(state, blocked), true);
    assert.equal(state.seen[sha256(canonicalUrl(blocked.url))].lastError, `http_${status}`);
  }
});

test('retryable HTTP failures keep the three-attempt budget', async () => {
  for (const status of [429, 500, 503]) {
    const flaky = await enrichJob({
      url: `https://example.com/jobs/${status}`, title: 'Data Analyst', company: 'Acme', location: 'Remote', description: '',
    }, {}, async () => new Response('', { status }));
    assert.equal(flaky.enrichment, 'failed');
    assert.equal(flaky.enrichmentRetryable, true);

    const state = { seen: {} };
    assert.deepEqual(markJobSeen(state, flaky, '2026-08-27T20:00:00.000Z'), { attempts: 1, completed: false });
    assert.equal(isJobSeen(state, flaky), false);
    markJobSeen(state, flaky, '2026-08-28T20:00:00.000Z');
    assert.deepEqual(markJobSeen(state, flaky, '2026-08-29T20:00:00.000Z'), { attempts: 3, completed: true });
  }
});

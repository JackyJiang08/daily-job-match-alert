// The Status page fixture: the Reports test project (tests/helpers/report-hub.mjs) with a fuller newest
// run (sources, quota, prescreen, usage, review budget, warnings), a state file, and a Desktop
// warnings.txt, so the Status snapshot covers every card that reads the latest run.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function statusMeta() {
  return JSON.parse(await fs.readFile(new URL('../fixtures/status-meta.json', import.meta.url), 'utf8'));
}

export async function addStatusFixture(root, { writePayload, fixturePayload, selectedMatches }) {
  await writePayload(root, fixturePayload('2026-10-17', selectedMatches(), await statusMeta()));
  await fs.writeFile(path.join(root, 'state', 'state.json'), `${JSON.stringify({
    lastSuccessfulRun: '2026-10-17T01:00:00.000Z',
    deferred: { a: { deferredAt: '2026-10-17T01:00:00.000Z' }, b: { deferredAt: '2026-10-17T01:00:00.000Z' } },
    budgetHistory: [{ date: '2026-10-16', at: '2026-10-16T01:00:00.000Z', candidates: 41, inWindow: 40, limit: 30, reviewed: 30 }, { date: '2026-10-17', at: '2026-10-17T01:00:00.000Z', candidates: 40, inWindow: 38, limit: 30, reviewed: 30 }],
  }, null, 2)}\n`);
  const warnings = path.join(root, 'output', '2026-10-17');
  await fs.mkdir(warnings, { recursive: true });
  await fs.writeFile(path.join(warnings, 'warnings.txt'), 'deferred 10 postings to the next run\n');
}

// The Status page without the Hub card (its timings and cache counters differ per request).
export function withoutHubCard(html) {
  return String(html).replace(/<article class="card" id="hub-card">[\s\S]*?<\/article>/, '<!-- hub card -->');
}

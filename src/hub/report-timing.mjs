// Per-request timings for the Reports pages and the Status page. Every request to /reports, /reports/<date>,
// or /status records how long each stage took (the reports index, reading the payload, the eligibility and
// location re-check, the letter status scan, the Status summary and the rest of the Status data, the HTML
// render, the sidebar), the response size before and after gzip, and whether the render cache answered. One line goes to the hub log; the last REPORT_TIMING_LIMIT requests are kept
// in memory for the Status page's Hub card.
import { performance } from 'node:perf_hooks';

export const REPORT_TIMING_LIMIT = 20;
export const TIMING_PHASES = [
  { key: 'index', label: 'index' },
  { key: 'payload', label: 'payload' },
  { key: 'review', label: 'review' },
  { key: 'letters', label: 'letters' },
  { key: 'summary', label: 'status summary' },
  { key: 'status', label: 'status data' },
  { key: 'render', label: 'render' },
  { key: 'sidebar', label: 'sidebar' },
];

function round(ms) {
  return Math.round(ms * 10) / 10;
}

export function createTimingLog({ limit = REPORT_TIMING_LIMIT, log = line => console.log(line), now = () => new Date(), clock = () => performance.now() } = {}) {
  const records = [];

  function start(pathname) {
    const startedAt = clock();
    const phases = {};
    const extra = {};
    const add = (key, ms) => { phases[key] = round((phases[key] || 0) + ms); };
    return {
      async phase(key, fn) {
        const begin = clock();
        try { return await fn(); } finally { add(key, clock() - begin); }
      },
      note(key, value) { extra[key] = value; },
      finish({ status = 200, bytes = 0, encodedBytes = null, notModified = false } = {}) {
        const record = { at: now().toISOString(), path: pathname, status, totalMs: round(clock() - startedAt), phases: { ...phases }, bytes, encodedBytes, notModified, ...extra };
        records.unshift(record);
        records.length = Math.min(records.length, limit);
        try { log(timingLine(record)); } catch {}
        return record;
      },
    };
  }

  return { start, recent: () => records.map(record => ({ ...record, phases: { ...record.phases } })) };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function phasesText(phases = {}) {
  return TIMING_PHASES.filter(phase => phases[phase.key] != null).map(phase => `${phase.label} ${phases[phase.key]} ms`).join(' · ');
}

// "[hub] GET /reports/2026-10-17 200 in 41.2 ms (index 1.1 ms · payload 0 ms · …) 412 KB, gzip 61 KB, cache hit"
export function timingLine(record) {
  const size = record.notModified ? '304 not modified' : `${formatBytes(record.bytes)}${record.encodedBytes != null ? `, gzip ${formatBytes(record.encodedBytes)}` : ''}`;
  const cache = record.cache ? `, cache ${record.cache}` : '';
  return `[hub] GET ${record.path} ${record.status} in ${record.totalMs} ms (${phasesText(record.phases) || 'no stages'}) ${size}${cache}`;
}

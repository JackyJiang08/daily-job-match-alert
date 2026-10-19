// In-memory cache for the single-day report page, in two layers:
//   day      keyed by the payload file's date, mtime and size: the matches and meta (the reviewed list is
//            not kept), the render-time eligibility/location re-check (reviewReportJobs), and each card's
//            full job description for the on-demand JD route.
//   render   keyed by the day key plus the letter status version and the config version: the rendered
//            report body and the "missing letters" count.
// A changed payload, letter, or config simply produces a new key; the explicit invalidations (a run
// finished, a letter saved or renamed, Settings saved) also bump a version and drop the renders, so a
// write the hub made itself never waits on file timestamps. Both layers are small LRU maps.
export const DAY_CACHE_LIMIT = 4;
export const RENDER_CACHE_LIMIT = 8;
export const INVALIDATION_REASONS = ['run', 'letters', 'config'];

function remember(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
  return value;
}

function recall(map, key) {
  if (!map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
}

export function createReportCache({ dayLimit = DAY_CACHE_LIMIT, renderLimit = RENDER_CACHE_LIMIT, now = () => new Date() } = {}) {
  const days = new Map();
  const renders = new Map();
  const versions = { run: 0, letters: 0, config: 0 };
  const counters = { dayHits: 0, dayMisses: 0, renderHits: 0, renderMisses: 0 };
  const invalidations = [];

  return {
    versions,
    dayKey(date, info) {
      return `${date}|${info.mtimeMs}|${info.size}|run:${versions.run}`;
    },
    getDay(key) {
      const value = recall(days, key);
      counters[value ? 'dayHits' : 'dayMisses'] += 1;
      return value;
    },
    setDay(key, value) {
      return remember(days, key, value, dayLimit);
    },
    // The day entry of a date whatever its mtime (the JD route accepts the newest one it has).
    latestDay(date) {
      const keys = [...days.keys()].filter(key => key.startsWith(`${date}|`));
      return keys.length ? days.get(keys[keys.length - 1]) : undefined;
    },
    getRender(key) {
      const value = recall(renders, key);
      counters[value ? 'renderHits' : 'renderMisses'] += 1;
      return value;
    },
    setRender(key, value) {
      return remember(renders, key, value, renderLimit);
    },
    // reason: 'run' (a run finished: the payloads change), 'letters' (a letter was saved or renamed),
    // 'config' (Settings saved). Every reason drops the renders; 'run' drops the day entries too.
    invalidate(reason) {
      if (!INVALIDATION_REASONS.includes(reason)) throw new Error(`Unknown cache invalidation: ${reason}`);
      versions[reason] += 1;
      renders.clear();
      if (reason === 'run') days.clear();
      invalidations.unshift({ reason, at: now().toISOString() });
      invalidations.length = Math.min(invalidations.length, 10);
    },
    stats() {
      return { ...counters, days: days.size, renders: renders.size, versions: { ...versions }, invalidations: invalidations.map(item => ({ ...item })) };
    },
  };
}

// The strict 24-hour window (Settings > Pipeline "Strict 24-Hour Window", semanticMatching.strict24HourWindow,
// 2026-11-03; default on since 2026-11-08: only an explicit false turns it off). The run records the setting in meta.strictWindow and the report splits the day's
// reviewed matches with it at render time; scoring, matching and letters are unchanged.
//
// On, the main list keeps only postings known to be inside the 24 hours before the run:
//   - a board posting new since the last poll;
//   - a precise posting time at most 24 hours before the run;
//   - a date-only posting whose date is the run's own local day.
// Everything else (a date-only posting from yesterday or earlier, a posting with no date, a precise time
// older than 24 hours such as an alert email's received time) moves to the folded group
// "Date Only, May Be Older Than 24 Hours". Off, nothing moves. The Carried over and Not reviewed groups are
// split before this and stay as they are.
import { isNewSinceLastPoll, postedAtPrecision, postingDay } from './posting-fields.mjs';
import { localDate } from './time-format.mjs';

export const STRICT_WINDOW_HOURS = 24;
export const STRICT_WINDOW_LABEL = 'Strict 24-Hour Window';
export const DATE_ONLY_GROUP_TITLE = 'Date Only, May Be Older Than 24 Hours';

export function strictWindowEnabled(config) {
  return config?.semanticMatching?.strict24HourWindow !== false;
}

// The run's moment and local day the window is measured from: the run start, as the lookback cutoff is.
function runClock(meta) {
  const ranAt = meta?.generatedAt || meta?.completedAt || meta?.lastUpdatedAt || null;
  const instant = ranAt ? new Date(ranAt) : null;
  if (!instant || Number.isNaN(instant.getTime())) return null;
  const timeZone = meta?.timeZone || 'America/Chicago';
  return { at: instant.getTime(), day: meta?.runDate || localDate(instant, timeZone), timeZone };
}

// 'main' or 'date-only' for one posting under the strict window.
export function strictWindowPlacement(job, meta) {
  if (isNewSinceLastPoll(job)) return 'main';
  const clock = runClock(meta);
  if (!clock) return 'main';
  const precision = postedAtPrecision(job);
  if (precision === 'datetime') {
    const stamp = new Date(job.postedAt).getTime();
    return Number.isFinite(stamp) && clock.at - stamp <= STRICT_WINDOW_HOURS * 3_600_000 ? 'main' : 'date-only';
  }
  if (precision === 'date') {
    const day = postingDay(job, clock.timeZone);
    return day && day >= clock.day ? 'main' : 'date-only';
  }
  return 'date-only';
}

// { enabled, main, dateOnly } for the day's matches outside the Carried over group.
export function splitStrictWindow(jobs, meta) {
  const list = Array.isArray(jobs) ? jobs : [];
  const enabled = meta?.strictWindow?.enabled === true;
  if (!enabled) return { enabled, main: list, dateOnly: [] };
  const main = [];
  const dateOnly = [];
  for (const job of list) (strictWindowPlacement(job, meta) === 'main' ? main : dateOnly).push(job);
  return { enabled, main, dateOnly };
}

// The Run Details line: whether the strict window is on, and how many postings each group holds. The main
// list is always named; a group with nothing in it is left out, as it is on the page.
export function strictWindowDetail({ enabled, groups = [] }) {
  const parts = groups.filter((group, index) => index === 0 || Number(group.count) > 0).map(group => `${group.title} (${Number(group.count) || 0})`);
  return [enabled ? 'On' : 'Off', ...parts].join(' · ');
}

// Every timestamp shown to the owner is rendered in config.timeZone (America/Chicago by default), in the
// "Sep 13, 2026, 8:00 PM" style, never in UTC. Shared by the Desktop report and the hub.
export const DEFAULT_TIME_ZONE = 'America/Chicago';

function safeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone || DEFAULT_TIME_ZONE });
    return timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function parse(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// "Sep 13, 2026, 8:00 PM"
export function formatLocalDateTime(value, timeZone) {
  const date = parse(value);
  if (!date) return value ? String(value) : '';
  return date.toLocaleString('en-US', { timeZone: safeZone(timeZone), dateStyle: 'medium', timeStyle: 'short' });
}

// "Sep 12, 8:00 PM" (year omitted; used where the year is obvious from context)
export function formatLocalShort(value, timeZone) {
  const date = parse(value);
  if (!date) return value ? String(value) : '';
  return date.toLocaleString('en-US', { timeZone: safeZone(timeZone), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "Sep 4" from an ISO timestamp
export function formatLocalDay(value, timeZone) {
  const date = parse(value);
  if (!date) return value ? String(value) : '';
  return date.toLocaleString('en-US', { timeZone: safeZone(timeZone), month: 'short', day: 'numeric' });
}

// "Sat, Sep 13" from a YYYY-MM-DD application date (calendar dates carry no zone)
export function formatDateLabel(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return String(date || '');
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return value.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// YYYY-MM-DD of `now` in the zone
export function localDate(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: safeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

// The last instant (23:59:59.999) of the calendar day that `value` falls on in the zone. Day-level posting
// dates are held to the window by this instant, so "posted yesterday" stays fresh for the whole day.
export function endOfLocalDay(value, timeZone) {
  const date = parse(value);
  if (!date) return null;
  const zone = safeZone(timeZone);
  const [year, month, day] = localDate(date, zone).split('-').map(Number);
  // Start from the wall-clock instant read as UTC, then correct by the zone's offset at that instant
  // (twice, so a DST switch inside the day lands on the right offset).
  let guess = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess));
    const value = type => Number(parts.find(part => part.type === type)?.value);
    const wall = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'), value('second'), 999);
    guess -= wall - Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  }
  return new Date(guess).toISOString();
}

// The instant a wall-clock time (year, month 1-12, day, hour, minute) has in the zone.
export function zonedInstant(year, month, day, hour, minute, timeZone) {
  const zone = safeZone(timeZone);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess));
    const value = type => Number(parts.find(part => part.type === type)?.value);
    const wall = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'), value('second'), 0);
    guess -= wall - target;
  }
  return new Date(guess);
}

// A scheduled time that passed this long ago without a completed run reads as "overdue"; inside the
// window it reads "due now", since the run itself takes a few minutes.
export const OVERDUE_GRACE_MS = 30 * 60_000;

// "in 3h 20m" / "in 45m" / "in 2d 4h" for a future instant; "due now" or "overdue" once it has passed.
export function formatRelativeTime(target, now) {
  const date = parse(target);
  const base = parse(now) || new Date();
  if (!date) return '';
  const diff = date.getTime() - base.getTime();
  if (diff <= -OVERDUE_GRACE_MS) return 'overdue';
  if (diff <= 0) return 'due now';
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `in ${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

// "12m" / "1h 5m" / "2d 3h" of time elapsed since `start`.
export function formatElapsed(start, now) {
  const from = parse(start);
  const base = parse(now) || new Date();
  if (!from) return '';
  const minutes = Math.max(0, Math.floor((base.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

export function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

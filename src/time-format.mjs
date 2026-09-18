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

export function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

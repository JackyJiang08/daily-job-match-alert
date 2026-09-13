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

export function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

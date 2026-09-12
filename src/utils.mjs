import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function resolveFrom(baseDirectory, value) {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDirectory, expanded);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function cleanText(value = '') {
  return decodeEntities(String(value))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeEntities(value = '') {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
    copy: '©', reg: '®', trade: '™',
  };
  return String(value)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

export function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    const trackingKeys = [...url.searchParams.keys()].filter(key =>
      /^(utm_|ref$|ref_|source$|source_|gh_src$|trk$|tracking)/i.test(key),
    );
    for (const key of trackingKeys) url.searchParams.delete(key);
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return '';
  }
}

export function isoDate(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

export function dateWithOffset(now, timeZone = 'America/Chicago', offsetDays = 0) {
  const shifted = new Date(now.getTime() + Number(offsetDays) * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted);
}

export function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

// Multiple locations are stored as one string joined with LOCATION_SEPARATOR; the HTML card and the
// xlsx Location column print that string verbatim. Sources that hand over several locations in one
// cell (Simplify's "3 locations" details block, or "Boston, MA Johnston, RI" flattened by cleanText)
// are split at ", ST" state-code boundaries and joined consistently here.
export const LOCATION_SEPARATOR = ' · ';
const LOCATION_COUNT_PREFIX = /^\d+\s+locations?\b:?\s*/i;

// A ", ST" boundary counts only when a new "City, ST" (or "Remote") follows it, so "Toronto, ON Canada"
// and "Austin, TX 78701" stay whole.
const STATE_CODE_BOUNDARY = /,\s*([A-Z]{2})\s+(?=(?:[A-Z][A-Za-z.'\- ]*,\s*[A-Z]{2}\b)|Remote\b)/g;

export function splitLocations(value) {
  const text = cleanText(String(value ?? '')).replace(LOCATION_COUNT_PREFIX, '');
  if (!text) return [];
  return unique(text
    .split(/\s*(?:\u00b7|\||;|\/|\u2022)\s*/)
    .flatMap(part => part.replace(STATE_CODE_BOUNDARY, ', $1\u0000').split('\u0000'))
    .map(part => part.trim())
    .filter(Boolean));
}

export function normalizeLocation(value) {
  const values = Array.isArray(value) ? value.flatMap(splitLocations) : splitLocations(value);
  return unique(values).join(LOCATION_SEPARATOR);
}

// Splits an HTML table cell into its locations before tags are flattened, so line breaks survive.
export function locationsFromHtmlCell(html) {
  const pieces = String(html ?? '')
    .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/gi, ' ')
    .split(/<\s*\/?\s*br\s*\/?\s*>|\n/gi);
  return normalizeLocation(pieces.flatMap(splitLocations));
}

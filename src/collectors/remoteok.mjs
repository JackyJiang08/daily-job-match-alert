// RemoteOK's public JSON feed, GET https://remoteok.com/api (no key). Its terms, carried in the first
// array element ({ legal, last_updated }), ask for a user agent and for a follow link back to the
// posting on remoteok.com naming RemoteOK as the source; the report links each card to that page and
// labels the source. robots.txt allows "/" with a one-second crawl delay; the feed is read once per night.
// Elements after the first: { id, slug, date (ISO), company, position, tags: [], location, description
// (HTML), salary_min, salary_max, url (posting page), apply_url }.
import { REMOTEOK_SOURCE } from './catalog.mjs';
import { canonicalUrl, cleanText, isoDate, normalizeLocation } from '../utils.mjs';
import { createWarning } from '../warnings.mjs';

export const REMOTEOK_API_URL = 'https://remoteok.com/api';
// A remote posting is kept only when it is open to someone working from the United States.
const US_WORKABLE = /\b(united states|usa|u\.s\.a?|us only|us[- ]based|north america|americas|worldwide|anywhere|global)\b|\bUS\b|,\s*[A-Z]{2}$/i;
const REMOTE_WORD = /\bremote\b/i;

export function remoteOkRoleType(job) {
  const text = `${job?.position || ''} ${(Array.isArray(job?.tags) ? job.tags : []).join(' ')}`;
  if (/\bintern(?:ship)?s?\b/i.test(text)) return 'internship';
  if (/\b(new[- ]grads?(?:uate)?|graduate)\b/i.test(text)) return 'new_grad';
  if (/\b(entry[- ]level|junior)\b/i.test(text)) return 'entry_level';
  return null;
}

export function remoteOkLocation(raw) {
  const text = cleanText(raw || '');
  if (!text || REMOTE_WORD.test(text) && text.length <= 8) return 'Remote';
  if (!US_WORKABLE.test(text)) return null;
  const normalized = normalizeLocation(text);
  return REMOTE_WORD.test(normalized) ? normalized : `Remote · ${normalized}`;
}

function salary(job) {
  const minimum = Number(job.salary_min || 0);
  const maximum = Number(job.salary_max || 0);
  if (!minimum && !maximum) return '';
  return `USD ${minimum && maximum && minimum !== maximum ? `${minimum}–${maximum}` : minimum || maximum} per year`;
}

export function parseRemoteOkJobs(payload) {
  const items = Array.isArray(payload) ? payload.filter(item => item && typeof item === 'object' && !('legal' in item)) : [];
  const jobs = [];
  for (const item of items) {
    const roleType = remoteOkRoleType(item);
    if (!roleType) continue;
    const location = remoteOkLocation(item.location);
    if (!location) continue;
    const url = canonicalUrl(item.url || item.apply_url);
    const title = cleanText(item.position || '');
    if (!url || !title) continue;
    jobs.push({
      source: REMOTEOK_SOURCE,
      sourceKind: 'public_json_feed',
      company: cleanText(item.company || ''),
      title,
      location,
      url,
      finalUrl: url,
      roleType,
      postedAt: isoDate(item.date) || null,
      freshnessBasis: 'remoteok_date',
      postedAtPrecision: 'datetime',
      salary: salary(item),
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      description: cleanText(item.description || '').slice(0, 50000),
      enrichment: 'source_api',
    });
  }
  return jobs;
}

export async function collectRemoteOk({ fetchImpl = fetch, userAgent = 'DailyJobMatchAlert/0.1', warnings = null, url = REMOTEOK_API_URL } = {}) {
  const response = await fetchImpl(url, { headers: { 'user-agent': userAgent, accept: 'application/json' } });
  if (!response.ok) throw new Error(`${REMOTEOK_SOURCE}: HTTP ${response.status}`);
  const payload = await response.json();
  const listed = Array.isArray(payload) ? payload.filter(item => item && typeof item === 'object' && !('legal' in item)).length : 0;
  if (!listed && Array.isArray(warnings)) {
    warnings.push(createWarning('collector', REMOTEOK_SOURCE, `HTTP ${response.status} but no postings were parsed; the feed format may have changed, check the source and the parser`));
  }
  return parseRemoteOkJobs(payload);
}

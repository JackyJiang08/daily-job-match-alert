// Zapply list links (https://zapply.jobs/l/d/<slug>?s=<list>) point at a redirect service, not at the
// employer. Probed live on 2026-10-07: every link answers 301 (adds a trailing slash) and then 302 with
// the employer's own posting URL in Location (a Workday, Greenhouse, Ashby, Oracle Cloud, Amazon, or
// SmartRecruiters page); a listing that is gone redirects back to https://zapply.jobs/jobs instead. No
// meta refresh or script is involved. The pipeline resolves each link before enrichment so the existing
// ATS-aware fetchers (Workday CXS, Greenhouse API, ...) see the employer URL, and a posting listed both
// on Zapply and by the employer dedupes on the resolved URL.
//
// When the redirect cannot be followed (offline, timeout), slugs that carry the whole address are decoded:
// greenhouse-{board}-{id}, lever-{company}-{uuid}, ashby-{org}-{uuid}, sr-{Company}-{id}. Workday,
// Oracle, and Amazon slugs lack the host or site name, so those stay unresolved and the caller warns.
import { canonicalUrl } from '../utils.mjs';

const ZAPPLY_HOST = /(^|\.)zapply\.jobs$/i;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MAX_HOPS = 4;

export function isZapplyLink(raw) {
  try {
    const url = new URL(raw);
    return ZAPPLY_HOST.test(url.hostname) && /^\/l\/d\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function zapplySlug(raw) {
  try {
    return decodeURIComponent(new URL(raw).pathname.replace(/^\/l\/d\//, '').replace(/\/$/, ''));
  } catch {
    return '';
  }
}

// The employer URL a slug spells out completely, or null.
export function decodeZapplySlug(raw) {
  const slug = zapplySlug(raw);
  let match = /^greenhouse-([a-z0-9][a-z0-9_-]*)-(\d{5,})$/i.exec(slug);
  if (match) return `https://boards.greenhouse.io/${match[1]}/jobs/${match[2]}`;
  match = new RegExp(`^lever-([a-z0-9][a-z0-9_-]*)-(${UUID})$`, 'i').exec(slug);
  if (match) return `https://jobs.lever.co/${match[1]}/${match[2]}`;
  match = new RegExp(`^ashby-([a-z0-9][a-z0-9_.-]*)-(${UUID})$`, 'i').exec(slug);
  if (match) return `https://jobs.ashbyhq.com/${match[1]}/${match[2]}`;
  match = /^sr-([A-Za-z0-9][A-Za-z0-9_-]*)-(\d{6,})$/.exec(slug);
  if (match) return `https://jobs.smartrecruiters.com/${match[1]}/${match[2]}`;
  return null;
}

// Tidies an employer URL: Ashby's "/application" step points at the same posting.
function employerUrl(raw) {
  const url = new URL(raw);
  if (/(^|\.)ashbyhq\.com$/i.test(url.hostname)) url.pathname = url.pathname.replace(/\/application\/?$/, '');
  return canonicalUrl(url.href);
}

// { url, via: 'redirect' | 'slug' } or { url: null, reason }. Redirects are walked one hop at a time
// (redirect: 'manual'), never more than MAX_HOPS, and only while they stay on zapply.jobs; the first
// off-site Location is the employer URL. A redirect back to a zapply.jobs page that is not a link means
// the listing is gone.
export async function resolveZapplyLink(raw, { fetchImpl = fetch, timeoutMs = 10_000, userAgent = 'DailyJobMatchAlert/0.1', network = true } = {}) {
  const decoded = decodeZapplySlug(raw);
  if (!network) return decoded ? { url: employerUrl(decoded), via: 'slug' } : { url: null, reason: 'offline and the slug does not spell out the employer URL' };
  let current = raw;
  try {
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(current, { method: 'GET', redirect: 'manual', headers: { 'user-agent': userAgent }, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const location = response.headers?.get?.('location');
      if (response.status < 300 || response.status >= 400 || !location) {
        return decoded ? { url: employerUrl(decoded), via: 'slug' } : { url: null, reason: `HTTP ${response.status} without a redirect` };
      }
      const next = new URL(location, current);
      if (!ZAPPLY_HOST.test(next.hostname)) return { url: employerUrl(next.href), via: 'redirect' };
      if (!/^\/l\/d\//.test(next.pathname)) return { url: null, reason: `the listing is gone (redirects to ${next.origin}${next.pathname})` };
      current = next.href;
    }
    return decoded ? { url: employerUrl(decoded), via: 'slug' } : { url: null, reason: `more than ${MAX_HOPS} redirects` };
  } catch (error) {
    if (decoded) return { url: employerUrl(decoded), via: 'slug' };
    return { url: null, reason: error?.name === 'AbortError' ? 'timed out' : String(error?.message || error).slice(0, 120) };
  }
}

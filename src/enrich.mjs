import { canonicalUrl, cleanText, isoDate } from './utils.mjs';

function meta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return cleanText(match[1]);
  }
  return '';
}

function jobPostingObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const child of value) jobPostingObjects(child, output);
  } else if (value && typeof value === 'object') {
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.includes('JobPosting')) output.push(value);
    for (const child of Object.values(value)) jobPostingObjects(child, output);
  }
  return output;
}

function parseJsonLd(html) {
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const posting = jobPostingObjects(JSON.parse(match[1]))[0];
      if (posting) return posting;
    } catch {
      // Ignore malformed third-party markup and continue to ordinary metadata.
    }
  }
  return null;
}

function locationFromPosting(posting) {
  if (posting.jobLocationType === 'TELECOMMUTE') return 'Remote';
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
  return locations.filter(Boolean).map(item => {
    const address = item.address || item;
    return [address.addressLocality, address.addressRegion, address.addressCountry].filter(Boolean).join(', ');
  }).filter(Boolean).join(' / ');
}

function employmentTypeFromPosting(posting) {
  const value = posting.employmentType;
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join(' / ');
}

function salaryFromPosting(posting) {
  const salary = posting.baseSalary;
  if (!salary) return '';
  const value = salary.value || salary;
  const minimum = value.minValue ?? value.value;
  const maximum = value.maxValue;
  const amount = maximum != null && maximum !== minimum ? `${minimum ?? '?'}–${maximum}` : `${minimum ?? maximum ?? ''}`;
  if (!amount) return '';
  return [salary.currency, amount, value.unitText].filter(Boolean).join(' ');
}

function greenhouseApiUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)job-boards\.greenhouse\.io$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    return match ? `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs/${match[2]}` : null;
  } catch {
    return null;
  }
}

const WORKDAY_HOST = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i;
const WORKDAY_LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

// Workday career sites render job pages client-side, but every tenant also exposes a public
// JSON endpoint under /wday/cxs/ that returns the posting the page would render.
function workdayCxsUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.match(WORKDAY_HOST);
    if (!host) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length && WORKDAY_LOCALE.test(segments[0])) segments.shift();
    const [site, marker, ...rest] = segments;
    if (!site || marker !== 'job' || rest.length === 0) return null;
    const jobId = rest[rest.length - 1];
    if (!jobId) return null;
    const tenant = host[1].toLowerCase();
    return `https://${tenant}.${host[2].toLowerCase()}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${jobId}`;
  } catch {
    return null;
  }
}

// Workday reports freshness as "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", or
// "Posted 30+ Days Ago"; the open-ended form has no usable date.
function workdayPostedOn(text, now = new Date()) {
  const value = cleanText(text).toLowerCase();
  if (!value) return null;
  let daysAgo = null;
  if (/\btoday\b/.test(value)) daysAgo = 0;
  else if (/\byesterday\b/.test(value)) daysAgo = 1;
  else {
    const match = value.match(/(\d+)\s*days?\s+ago/);
    if (match && !value.includes(`${match[1]}+`)) daysAgo = Number(match[1]);
  }
  if (daysAgo == null) return null;
  return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function workdayLocation(info) {
  const extra = Array.isArray(info.additionalLocations) ? info.additionalLocations : [];
  return [info.location, ...extra].map(item => cleanText(item || '')).filter(Boolean).join(' / ');
}

async function fetchWorkdayPosting(cxsUrl, headers, timeoutMs, fetchImpl) {
  try {
    const response = await fetchWithTimeout(cxsUrl, { headers: { ...headers, accept: 'application/json' } }, timeoutMs, fetchImpl);
    if (!response.ok) return null;
    const payload = await response.json();
    const info = payload?.jobPostingInfo;
    if (!info || typeof info !== 'object' || typeof info.jobDescription !== 'string') return null;
    return { info, company: cleanText(payload.hiringOrganization?.name || '') };
  } catch {
    return null;
  }
}

function workdayEnrichment(originalJob, posting, finalUrl) {
  const { info, company } = posting;
  const startDate = isoDate(info.startDate);
  const postedOn = startDate ? null : workdayPostedOn(info.postedOn);
  return {
    ...originalJob,
    company: company || originalJob.company,
    title: cleanText(info.title || originalJob.title),
    location: workdayLocation(info) || originalJob.location,
    employmentType: cleanText(info.timeType || '') || originalJob.employmentType || '',
    salary: originalJob.salary || '',
    description: (cleanText(info.jobDescription) || originalJob.description || '').slice(0, 50000),
    postedAt: startDate || postedOn || originalJob.postedAt,
    freshnessBasis: startDate ? 'workday_start_date' : postedOn ? 'workday_posted_on' : originalJob.freshnessBasis,
    finalUrl,
    url: finalUrl,
    enrichment: 'workday_cxs',
  };
}

// The site refused us or the posting is gone; another night will not change that.
const UNRECOVERABLE_HTTP = { 403: 'blocked', 404: 'removed', 410: 'removed' };

function enrichmentFailure(job, enrichmentError, reason = null) {
  return {
    ...job,
    enrichment: 'failed',
    enrichmentError,
    enrichmentRetryable: !reason,
    ...(reason ? { enrichmentReason: reason } : {}),
  };
}

function httpFailure(job, status) {
  return enrichmentFailure(job, `http_${status}`, UNRECOVERABLE_HTTP[status] || null);
}

export function enrichmentWarningMessage(job, status) {
  const label = [job.company, job.title].filter(Boolean).join(' — ') || job.url;
  const origin = job.source ? ` (${job.source})` : '';
  const error = job.enrichmentError || 'unknown error';
  if (job.enrichmentRetryable === false) {
    const outcome = job.enrichmentReason === 'blocked' ? 'blocked: the site refused the fetch' : 'removed: the posting is no longer available';
    return `${label}${origin} ${outcome} (${error}); marked as seen and will not be retried`;
  }
  return status.completed
    ? `${label}${origin} failed enrichment ${status.attempts} times and will not be retried: ${error}`
    : `${label}${origin} enrichment attempt ${status.attempts}/3 failed and will be retried next run: ${error}`;
}

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichJob(job, network = {}, fetchImpl = fetch) {
  const timeoutMs = Number(network.timeoutMs || 15000);
  const headers = { 'user-agent': network.userAgent || 'DailyJobMatchAlert/0.1', accept: 'text/html,application/json' };
  const originalUrl = canonicalUrl(job.originalUrl || job.url) || job.originalUrl || job.url;
  const originalJob = { ...job, originalUrl };
  try {
    const greenhouse = greenhouseApiUrl(originalJob.url);
    if (greenhouse) {
      const response = await fetchWithTimeout(greenhouse, { headers }, timeoutMs, fetchImpl);
      if (response.ok) {
        const payload = await response.json();
        return {
          ...originalJob,
          company: originalJob.company || payload.company_name || '',
          title: payload.title || originalJob.title,
          location: payload.location?.name || originalJob.location,
          description: cleanText(payload.content || originalJob.description),
          postedAt: isoDate(payload.updated_at) || originalJob.postedAt,
          freshnessBasis: payload.updated_at ? 'greenhouse_updated_at' : originalJob.freshnessBasis,
          finalUrl: originalJob.url,
          enrichment: 'greenhouse_api',
        };
      }
    }

    const directCxs = workdayCxsUrl(originalJob.url);
    if (directCxs) {
      const posting = await fetchWorkdayPosting(directCxs, headers, timeoutMs, fetchImpl);
      if (posting) return workdayEnrichment(originalJob, posting, originalJob.url);
    }

    const response = await fetchWithTimeout(originalJob.url, { headers }, timeoutMs, fetchImpl);
    const finalUrl = canonicalUrl(response.url || originalJob.url) || originalJob.url;
    const redirectedCxs = workdayCxsUrl(finalUrl);
    if (redirectedCxs && redirectedCxs !== directCxs) {
      const posting = await fetchWorkdayPosting(redirectedCxs, headers, timeoutMs, fetchImpl);
      if (posting) return workdayEnrichment(originalJob, posting, finalUrl);
    }
    if (!response.ok) return httpFailure(originalJob, response.status);
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    if (contentType.includes('application/json')) return enrichmentFailure({ ...originalJob, finalUrl, url: finalUrl }, 'json_unparsed');
    const posting = parseJsonLd(body);
    const htmlTitle = meta(body, 'og:title') || cleanText(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const postingDescription = posting?.description ? cleanText(posting.description) : '';
    return {
      ...originalJob,
      company: posting?.hiringOrganization?.name || originalJob.company,
      title: cleanText(posting?.title || htmlTitle || originalJob.title),
      location: locationFromPosting(posting || {}) || originalJob.location,
      employmentType: employmentTypeFromPosting(posting || {}) || originalJob.employmentType || '',
      salary: salaryFromPosting(posting || {}) || originalJob.salary || '',
      description: (postingDescription || meta(body, 'description') || meta(body, 'og:description') || originalJob.description || '').slice(0, 50000),
      postedAt: isoDate(posting?.datePosted) || originalJob.postedAt,
      finalUrl,
      url: finalUrl,
      freshnessBasis: posting?.datePosted ? 'jobposting_date_posted' : originalJob.freshnessBasis,
      enrichment: posting ? 'json_ld_jobposting' : 'html_metadata',
    };
  } catch (error) {
    return enrichmentFailure(originalJob, error.name === 'AbortError' ? 'timeout' : error.message);
  }
}

export { greenhouseApiUrl, parseJsonLd, workdayCxsUrl, workdayPostedOn };

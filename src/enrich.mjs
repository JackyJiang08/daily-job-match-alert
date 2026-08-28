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

    const response = await fetchWithTimeout(originalJob.url, { headers }, timeoutMs, fetchImpl);
    if (!response.ok) return { ...originalJob, enrichment: 'failed', enrichmentError: `http_${response.status}` };
    const finalUrl = canonicalUrl(response.url || originalJob.url) || originalJob.url;
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    if (contentType.includes('application/json')) return { ...originalJob, finalUrl, url: finalUrl, enrichment: 'failed', enrichmentError: 'json_unparsed' };
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
    return { ...originalJob, enrichment: 'failed', enrichmentError: error.name === 'AbortError' ? 'timeout' : error.message };
  }
}

export { greenhouseApiUrl, parseJsonLd };

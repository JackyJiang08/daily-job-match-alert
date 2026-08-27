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
  try {
    const greenhouse = greenhouseApiUrl(job.url);
    if (greenhouse) {
      const response = await fetchWithTimeout(greenhouse, { headers }, timeoutMs, fetchImpl);
      if (response.ok) {
        const payload = await response.json();
        return {
          ...job,
          company: job.company || payload.company_name || '',
          title: payload.title || job.title,
          location: payload.location?.name || job.location,
          description: cleanText(payload.content || job.description),
          postedAt: isoDate(payload.updated_at) || job.postedAt,
          freshnessBasis: payload.updated_at ? 'greenhouse_updated_at' : job.freshnessBasis,
          finalUrl: job.url,
          enrichment: 'greenhouse_api',
        };
      }
    }

    const response = await fetchWithTimeout(job.url, { headers }, timeoutMs, fetchImpl);
    if (!response.ok) return { ...job, enrichment: `http_${response.status}` };
    const finalUrl = canonicalUrl(response.url || job.url) || job.url;
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    if (contentType.includes('application/json')) return { ...job, finalUrl, enrichment: 'json_unparsed' };
    const posting = parseJsonLd(body);
    const htmlTitle = meta(body, 'og:title') || cleanText(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const postingDescription = posting?.description ? cleanText(posting.description) : '';
    return {
      ...job,
      company: posting?.hiringOrganization?.name || job.company,
      title: cleanText(posting?.title || htmlTitle || job.title),
      location: locationFromPosting(posting || {}) || job.location,
      description: (postingDescription || meta(body, 'description') || meta(body, 'og:description') || job.description || '').slice(0, 50000),
      postedAt: isoDate(posting?.datePosted) || job.postedAt,
      finalUrl,
      url: finalUrl,
      freshnessBasis: posting?.datePosted ? 'jobposting_date_posted' : job.freshnessBasis,
      enrichment: posting ? 'json_ld_jobposting' : 'html_metadata',
    };
  } catch (error) {
    return { ...job, enrichment: 'failed', enrichmentError: error.name === 'AbortError' ? 'timeout' : error.message };
  }
}

export { greenhouseApiUrl, parseJsonLd };

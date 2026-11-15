import { LOCATION_SEPARATOR, normalizeLocation, canonicalUrl, cleanText, htmlEscape, isoDate } from './utils.mjs';
import { cleanWorkdayCompany, isTrustedSourceName, parsePostingDate } from './posting-fields.mjs';
import { cleanDescriptionHtml, textToParagraphs } from './jd-html.mjs';
import { DEFAULT_MINIMUM_DESCRIPTION_CHARACTERS, extractEmbeddedDescription, extractJobBody, isCompleteText } from './jd-extract.mjs';

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
  }).filter(Boolean).join(LOCATION_SEPARATOR);
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
    // EU-region postings (job-boards.eu.greenhouse.io) are served by the same global API host.
    if (!/(^|\.)job-boards(\.eu)?\.greenhouse\.io$/i.test(parsed.hostname)) return null;
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
  return normalizeLocation([info.location, ...extra].map(item => cleanText(item || '')).filter(Boolean));
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
  // startDate is a bare calendar date ("2026-10-08"); it is stored as that day, not as UTC midnight.
  const startDate = info.startDate ? parsePostingDate(info.startDate)?.postedAt || null : null;
  const postedOn = startDate ? null : workdayPostedOn(info.postedOn);
  return {
    ...originalJob,
    // A valid company name the list or board registry supplied is never overwritten by the tenant's
    // internal entity name ("100000 Motorola Solutions, Inc."); the raw entity is kept as a candidate.
    company: isTrustedSourceName(originalJob.company) ? originalJob.company : (cleanWorkdayCompany(company) || originalJob.company),
    companyFromSource: originalJob.companyFromSource ?? (originalJob.company || null),
    atsCompany: company || originalJob.atsCompany || null,
    title: cleanText(info.title || originalJob.title),
    location: workdayLocation(info) || originalJob.location,
    employmentType: cleanText(info.timeType || '') || originalJob.employmentType || '',
    salary: originalJob.salary || '',
    description: (cleanText(info.jobDescription) || originalJob.description || '').slice(0, 50000),
    descriptionHtml: cleanText(info.jobDescription) ? cleanDescriptionHtml(info.jobDescription) : originalJob.descriptionHtml,
    postedAt: startDate || postedOn || originalJob.postedAt,
    freshnessBasis: startDate ? 'workday_start_date' : postedOn ? 'workday_posted_on' : originalJob.freshnessBasis,
    postedAtPrecision: startDate || postedOn ? 'date' : originalJob.postedAtPrecision,
    finalUrl,
    url: finalUrl,
    enrichment: 'workday_cxs',
  };
}

// SmartRecruiters posting pages (jobs.smartrecruiters.com/{company}/{id}[-slug]) have a public detail
// endpoint, GET https://api.smartrecruiters.com/v1/companies/{company}/postings/{id} (no key), whose
// jobAd.sections { companyDescription, jobDescription, qualifications, additionalInformation } hold the
// description as HTML (verified 2026-10-09; fixture tests/fixtures/ats/smartrecruiters-posting.json).
export function smartRecruitersApiUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return null; }
  if (!/^(?:jobs|careers)\.smartrecruiters\.com$/i.test(url.hostname)) return null;
  const [company, posting] = url.pathname.split('/').filter(Boolean);
  const id = /^(\d+)/.exec(posting || '')?.[1];
  if (!company || !id || !/^[A-Za-z0-9._-]+$/.test(company)) return null;
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${id}`;
}

export function smartRecruitersEnrichment(originalJob, payload) {
  const sections = payload?.jobAd?.sections && typeof payload.jobAd.sections === 'object' ? payload.jobAd.sections : {};
  const keys = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'].filter(key => sections[key]?.text);
  const text = keys.map(key => `${cleanText(sections[key].title || '')}\n${cleanText(sections[key].text)}`).join('\n');
  // Each section under its own heading, in the same order as the text.
  const html = keys.map(key => `${sections[key].title ? `<h3>${htmlEscape(cleanText(sections[key].title))}</h3>` : ''}${sections[key].text}`).join('');
  if (!text) return null;
  const company = cleanText(payload.company?.name || '');
  const released = isoDate(payload.releasedDate);
  return {
    ...originalJob,
    company: isTrustedSourceName(originalJob.company) ? originalJob.company : (company || originalJob.company || ''),
    companyFromSource: originalJob.companyFromSource ?? (originalJob.company || null),
    atsCompany: company || originalJob.atsCompany || null,
    title: cleanText(payload.name || originalJob.title),
    location: originalJob.location || normalizeLocation(cleanText(String(payload.location?.fullLocation || '').replace(/(?:,\s*)+/g, ', '))),
    employmentType: cleanText(payload.typeOfEmployment?.label || '') || originalJob.employmentType || '',
    description: text.slice(0, 50000),
    descriptionHtml: cleanDescriptionHtml(html),
    postedAt: released || originalJob.postedAt,
    freshnessBasis: released ? 'smartrecruiters_released_date' : originalJob.freshnessBasis,
    postedAtPrecision: released ? 'datetime' : originalJob.postedAtPrecision,
    finalUrl: originalJob.url,
    enrichment: 'smartrecruiters_api',
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

// ------------------------------------------------------------------------------------------ Lever and Ashby

// A Lever posting page (jobs.lever.co/{company}/{posting id}[/apply]) has a public detail endpoint,
// GET https://api.lever.co/v0/postings/{company}/{posting id} (the Postings API; same shape as one entry of
// the board listing the collector reads). EU boards use api.eu.lever.co.
export function leverApiUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return null; }
  const host = /^jobs(\.eu)?\.lever\.co$/i.exec(url.hostname);
  if (!host) return null;
  const [company, id] = url.pathname.split('/').filter(Boolean);
  if (!company || !id || !/^[A-Za-z0-9._-]+$/.test(company) || !/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(id)) return null;
  return `https://api${host[1] ? '.eu' : ''}.lever.co/v0/postings/${encodeURIComponent(company)}/${id}`;
}

export function leverEnrichment(originalJob, payload, pageUrl) {
  if (!payload || typeof payload !== 'object' || !payload.text) return null;
  const lists = Array.isArray(payload.lists) ? payload.lists : [];
  const sections = lists.map(list => `${cleanText(list?.text || '')} ${cleanText(list?.content || '')}`);
  const text = [payload.descriptionPlain || cleanText(payload.description || ''), ...sections, payload.additionalPlain || ''].filter(Boolean).join('\n');
  if (!text) return null;
  const html = [payload.description || '', ...lists.map(list => `<h3>${htmlEscape(cleanText(list?.text || ''))}</h3><ul>${list?.content || ''}</ul>`), payload.additional || ''].join('');
  const categories = payload.categories && typeof payload.categories === 'object' ? payload.categories : {};
  const locations = Array.isArray(categories.allLocations) && categories.allLocations.length ? categories.allLocations : [categories.location];
  const createdAt = Number(payload.createdAt);
  const dated = Number.isFinite(createdAt) && createdAt > 0;
  return {
    ...originalJob,
    title: cleanText(payload.text) || originalJob.title,
    location: normalizeLocation(locations.filter(Boolean)) || originalJob.location,
    employmentType: cleanText(categories.commitment || '') || originalJob.employmentType || '',
    description: text.slice(0, 50000),
    descriptionHtml: cleanDescriptionHtml(html),
    postedAt: dated ? isoDate(new Date(createdAt)) : originalJob.postedAt,
    freshnessBasis: dated ? 'lever_created_at' : originalJob.freshnessBasis,
    postedAtPrecision: dated ? 'datetime' : originalJob.postedAtPrecision,
    finalUrl: pageUrl,
    url: pageUrl,
    enrichment: 'lever_api',
  };
}

// An Ashby posting page (jobs.ashbyhq.com/{org}/{job id}[/application]) is one entry of the organisation's
// public board, GET https://api.ashbyhq.com/posting-api/job-board/{org} (descriptionHtml and descriptionPlain).
export function ashbyApiUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return null; }
  if (url.hostname.toLowerCase() !== 'jobs.ashbyhq.com') return null;
  const [rawOrg, id] = url.pathname.split('/').filter(Boolean);
  // The organisation segment is decoded before it is checked (jobs.ashbyhq.com/Acme%20Co/<id>) and encoded again
  // in the API address.
  let org;
  try { org = decodeURIComponent(rawOrg || ''); } catch { return null; }
  if (!org || !id || !/^[A-Za-z0-9._ -]+$/.test(org) || !/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(id)) return null;
  return { apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`, id };
}

export function ashbyEnrichment(originalJob, payload, id, pageUrl) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const job = jobs.find(item => String(item?.id || '') === id || String(item?.jobUrl || '').includes(id));
  if (!job) return null;
  const text = cleanText(job.descriptionPlain || '') || cleanText(job.descriptionHtml || '');
  if (!text) return null;
  const secondary = (Array.isArray(job.secondaryLocations) ? job.secondaryLocations : []).map(item => item?.location).filter(Boolean);
  const locations = [job.location, ...secondary].filter(Boolean);
  if (job.isRemote === true && !locations.some(item => /remote/i.test(item))) locations.push('Remote');
  const published = isoDate(job.publishedAt);
  return {
    ...originalJob,
    title: cleanText(job.title || '') || originalJob.title,
    location: normalizeLocation(locations) || originalJob.location,
    employmentType: cleanText(job.employmentType || '') || originalJob.employmentType || '',
    description: text.slice(0, 50000),
    descriptionHtml: cleanDescriptionHtml(job.descriptionHtml || ''),
    postedAt: published || originalJob.postedAt,
    freshnessBasis: published ? 'ashby_published_at' : originalJob.freshnessBasis,
    postedAtPrecision: published ? 'datetime' : originalJob.postedAtPrecision,
    finalUrl: pageUrl,
    url: pageUrl,
    enrichment: 'ashby_api',
  };
}

function greenhouseEnrichment(originalJob, payload, pageUrl) {
  return {
    ...originalJob,
    company: isTrustedSourceName(originalJob.company) ? originalJob.company : (payload.company_name || originalJob.company || ''),
    companyFromSource: originalJob.companyFromSource ?? (originalJob.company || null),
    atsCompany: payload.company_name || originalJob.atsCompany || null,
    title: payload.title || originalJob.title,
    location: normalizeLocation(payload.location?.name || '') || originalJob.location,
    description: cleanText(payload.content || originalJob.description),
    descriptionHtml: payload.content ? cleanDescriptionHtml(payload.content) : originalJob.descriptionHtml,
    postedAt: isoDate(payload.updated_at) || originalJob.postedAt,
    freshnessBasis: payload.updated_at ? 'greenhouse_updated_at' : originalJob.freshnessBasis,
    postedAtPrecision: payload.updated_at ? 'datetime' : originalJob.postedAtPrecision,
    finalUrl: pageUrl,
    url: pageUrl,
    enrichment: 'greenhouse_api',
  };
}

// ------------------------------------------------------------------------------------------ completeness

// The posting with descriptionSource and descriptionComplete: complete when the text did not come from a meta
// tag, has at least `minimum` characters and, for a JSON-LD or list summary, is not cut with an ellipsis
// (isCompleteText, src/jd-extract.mjs).
function withStatus(result, source, minimum) {
  const text = String(result.description || '').trim();
  const resolved = text ? source : null;
  return { ...result, descriptionSource: resolved, descriptionComplete: resolved != null && isCompleteText(text, minimum, resolved) };
}

// An API answer: the text is the API's when it gave one, else the list's.
function fromApi(result, originalJob, apiText, minimum) {
  return withStatus(result, apiText ? 'ats_api' : 'list', minimum);
}

// The public JSON entry of the ATS behind `url`, when it has one: Greenhouse, SmartRecruiters, Lever, Ashby,
// Workday CXS. `tried` keeps an entry from being asked twice when the page redirects within the same ATS.
async function fromPublicApis(originalJob, url, { headers, timeoutMs, fetchImpl, minimum, tried }) {
  // An entry that fails (not ok, no JSON, no such posting) gives way to the next entry and the page itself.
  const once = async (apiUrl, work) => {
    if (!apiUrl || tried.has(apiUrl)) return null;
    tried.add(apiUrl);
    try {
      return await work(apiUrl);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return null;
    }
  };
  const greenhouse = await once(greenhouseApiUrl(url), async apiUrl => {
    const response = await fetchWithTimeout(apiUrl, { headers }, timeoutMs, fetchImpl);
    if (!response.ok) return null;
    const payload = await response.json();
    return fromApi(greenhouseEnrichment(originalJob, payload, url), originalJob, Boolean(cleanText(payload.content || '')), minimum);
  });
  if (greenhouse) return greenhouse;

  const smartRecruiters = await once(smartRecruitersApiUrl(url), async apiUrl => {
    const response = await fetchWithTimeout(apiUrl, { headers: { ...headers, accept: 'application/json' } }, timeoutMs, fetchImpl);
    if (!response.ok) return null;
    const enriched = smartRecruitersEnrichment(originalJob, await response.json());
    return enriched ? fromApi({ ...enriched, finalUrl: url, url }, originalJob, true, minimum) : null;
  });
  if (smartRecruiters) return smartRecruiters;

  const lever = await once(leverApiUrl(url), async apiUrl => {
    const response = await fetchWithTimeout(apiUrl, { headers: { ...headers, accept: 'application/json' } }, timeoutMs, fetchImpl);
    if (!response.ok) return null;
    const enriched = leverEnrichment(originalJob, await response.json(), url);
    return enriched ? fromApi(enriched, originalJob, true, minimum) : null;
  });
  if (lever) return lever;

  const ashbyEntry = ashbyApiUrl(url);
  const ashby = await once(ashbyEntry?.apiUrl, async apiUrl => {
    const response = await fetchWithTimeout(apiUrl, { headers: { ...headers, accept: 'application/json' } }, timeoutMs, fetchImpl);
    if (!response.ok) return null;
    const enriched = ashbyEnrichment(originalJob, await response.json(), ashbyEntry.id, url);
    return enriched ? fromApi(enriched, originalJob, true, minimum) : null;
  });
  if (ashby) return ashby;

  return once(workdayCxsUrl(url), async cxsUrl => {
    const posting = await fetchWorkdayPosting(cxsUrl, headers, timeoutMs, fetchImpl);
    return posting ? fromApi(workdayEnrichment(originalJob, posting, url), originalJob, Boolean(cleanText(posting.info.jobDescription)), minimum) : null;
  });
}

// The description of a fetched page, the first complete one of: the JSON-LD JobPosting's, the page body
// (src/jd-extract.mjs containers, then the densest block), the page's embedded JSON, the list's own text.
// With none complete, the longest partial text of the JSON-LD, the list, or the page body (extractJobBody with
// no minimum, as long as it is more than a crumb: a quarter of the minimum, so a shell's "Loading…" does not
// stand in for the meta summary); the meta description only when there is no text at all, and never complete.
// { source, text, html (markup to clean) | null, keepHtml }.
export function pickDescription({ body, posting, originalJob, minimum = DEFAULT_MINIMUM_DESCRIPTION_CHARACTERS }) {
  const jsonLd = posting?.description ? { source: 'json_ld', html: String(posting.description), text: cleanText(posting.description) } : null;
  if (jsonLd && isCompleteText(jsonLd.text, minimum, 'json_ld')) return jsonLd;
  const page = extractJobBody(body, { minimum });
  if (page) return { source: 'page_body', html: page.html, text: page.text, ats: page.ats, method: page.method };
  const embedded = extractEmbeddedDescription(body, { minimum });
  if (embedded) return { source: 'embedded_json', html: embedded.html, text: embedded.text };
  const listText = String(originalJob.description || '').trim();
  const list = listText ? { source: 'list', html: null, text: listText, keepHtml: true } : null;
  if (list && isCompleteText(list.text, minimum, 'list')) return list;
  const partialBody = extractJobBody(body, { minimum: 1 });
  const bodyPart = partialBody && partialBody.text.length >= Math.ceil(Number(minimum) / 4) ? { source: 'page_body', html: partialBody.html, text: partialBody.text, ats: partialBody.ats, method: partialBody.method } : null;
  const partial = [jsonLd, list, bodyPart].filter(Boolean).sort((a, b) => b.text.length - a.text.length)[0];
  if (partial) return partial;
  const metaText = meta(body, 'description') || meta(body, 'og:description');
  return { source: metaText ? 'meta' : null, html: null, text: metaText };
}

function pageEnrichment(originalJob, body, finalUrl, minimum) {
  const posting = parseJsonLd(body);
  const htmlTitle = meta(body, 'og:title') || cleanText(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const picked = pickDescription({ body, posting, originalJob, minimum });
  const posted = parsePostingDate(posting?.datePosted, { url: finalUrl });
  const fromPage = picked.source === 'page_body' || picked.source === 'embedded_json';
  return withStatus({
    ...originalJob,
    company: isTrustedSourceName(originalJob.company) ? originalJob.company : (posting?.hiringOrganization?.name || originalJob.company),
    companyFromSource: originalJob.companyFromSource ?? (originalJob.company || null),
    ...(posting?.hiringOrganization?.name ? { atsCompany: posting.hiringOrganization.name } : {}),
    title: cleanText(posting?.title || htmlTitle || originalJob.title),
    location: locationFromPosting(posting || {}) || originalJob.location,
    employmentType: employmentTypeFromPosting(posting || {}) || originalJob.employmentType || '',
    salary: salaryFromPosting(posting || {}) || originalJob.salary || '',
    description: String(picked.text || '').slice(0, 50000),
    // The markup of what was picked (plain text with line breaks, as embedded JSON often carries, is split into
    // paragraphs); the list's own markup stays with the list's text; a meta tag has none.
    descriptionHtml: picked.keepHtml ? originalJob.descriptionHtml : picked.html ? cleanDescriptionHtml(/<[a-z!/]|&lt;[a-z]/i.test(picked.html) ? picked.html : textToParagraphs(picked.html)) : undefined,
    ...(picked.ats ? { descriptionContainer: picked.ats } : {}),
    postedAt: posted?.postedAt || originalJob.postedAt,
    finalUrl,
    url: finalUrl,
    freshnessBasis: posted ? 'jobposting_date_posted' : originalJob.freshnessBasis,
    // JSON-LD datePosted is sometimes a bare date, a padded midnight, or a clock time without a zone;
    // parsePostingDate keeps only what the page actually says (a calendar date unless the zone is known).
    postedAtPrecision: posted ? posted.precision : originalJob.postedAtPrecision,
    ...(posted?.zoneless ? { postedAtZoneless: posted.zone ? `read as ${posted.zone}` : 'no zone: date only' } : {}),
    enrichment: posting ? 'json_ld_jobposting' : fromPage ? 'html_page' : 'html_metadata',
  }, picked.source, minimum);
}

// network: config.network plus minimumDescriptionCharacters (config.minimumDescriptionCharacters).
export async function enrichJob(job, network = {}, fetchImpl = fetch) {
  const timeoutMs = Number(network.timeoutMs || 15000);
  const headers = { 'user-agent': network.userAgent || 'DailyJobMatchAlert/0.1', accept: 'text/html,application/json' };
  const minimum = Number(network.minimumDescriptionCharacters) > 0 ? Number(network.minimumDescriptionCharacters) : DEFAULT_MINIMUM_DESCRIPTION_CHARACTERS;
  const originalUrl = canonicalUrl(job.originalUrl || job.url) || job.originalUrl || job.url;
  const originalJob = { ...job, originalUrl };
  const api = { headers, timeoutMs, fetchImpl, minimum, tried: new Set() };
  try {
    const direct = await fromPublicApis(originalJob, originalJob.url, api);
    if (direct) return direct;

    const response = await fetchWithTimeout(originalJob.url, { headers }, timeoutMs, fetchImpl);
    const finalUrl = canonicalUrl(response.url || originalJob.url) || originalJob.url;
    // A redirect into an ATS (a list's short link, a careers site that forwards to its board): that ATS's
    // public entry is asked before the page is read.
    if (finalUrl !== originalJob.url) {
      const redirected = await fromPublicApis(originalJob, finalUrl, api);
      if (redirected) return redirected;
    }
    if (!response.ok) return httpFailure(originalJob, response.status);
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    if (contentType.includes('application/json')) return enrichmentFailure({ ...originalJob, finalUrl, url: finalUrl }, 'json_unparsed');
    let result = pageEnrichment(originalJob, body, finalUrl, minimum);
    // Still incomplete after a redirect: the landing page is asked once more by its own address (a tracked
    // redirect can land on a lighter page than a direct visit).
    if (!result.descriptionComplete && finalUrl !== originalJob.url) {
      try {
        const again = await fetchWithTimeout(finalUrl, { headers }, timeoutMs, fetchImpl);
        if (again.ok && !(again.headers.get('content-type') || '').includes('application/json')) {
          const retry = pageEnrichment(originalJob, await again.text(), canonicalUrl(again.url || finalUrl) || finalUrl, minimum);
          if (retry.descriptionComplete || String(retry.description || '').length > String(result.description || '').length) result = retry;
        }
      } catch {
        // The first answer stands.
      }
    }
    return result;
  } catch (error) {
    return enrichmentFailure(originalJob, error.name === 'AbortError' ? 'timeout' : error.message);
  }
}

export { greenhouseApiUrl, parseJsonLd, workdayCxsUrl, workdayPostedOn };

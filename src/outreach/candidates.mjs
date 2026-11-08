// Optional recruiter candidates from a web search API (Settings > Cover Letters "Search Candidates", default
// off). It reuses the search-discovery provider and key (private/search.json, Brave or Tavily) and counts
// against the same monthly query cap (state/search-usage.json). One query per posting at most (the panel
// keeps the result); up to three LinkedIn profile results, read only from the API's own titles and snippets:
// no profile page, and nothing on linkedin.com, is ever requested. Without a key the feature stays silent.
import fs from 'node:fs/promises';
import { parseSearchResults, readSearchKey, readSearchUsage, searchRequest, searchSettings, searchUsagePath, writeSearchUsage, monthKey } from '../collectors/search-discovery.mjs';
import { errorSummary } from '../warnings.mjs';
import { PROFILE_TERMS, assertNotLinkedIn, companyTerm, isLinkedInUrl } from './links.mjs';

export const MAX_CANDIDATES = 3;
export const CANDIDATES_NOTE = 'From search results, may be outdated, verify before reaching out';

export function candidateSearchEnabled(config) {
  return config?.outreach?.searchCandidates === true;
}

export function candidateQuery(company) {
  const term = companyTerm(company);
  return `site:linkedin.com/in ${/^"/.test(term) ? term : `"${term}"`} ${PROFILE_TERMS}`;
}

// What the panel may offer: { available, provider, reason }. Off, or no key: not available, and nothing shown.
export async function candidateSearchStatus(config, io = fs) {
  if (!candidateSearchEnabled(config)) return { available: false, reason: 'off' };
  const { provider } = searchSettings(config);
  const key = await readSearchKey(config, provider, io);
  return key.apiKey ? { available: true, provider } : { available: false, provider, reason: 'no-key' };
}

// "Jane Doe - University Recruiter - Example Corp | LinkedIn" → { name: 'Jane Doe', headline: 'University Recruiter - Example Corp' }.
function profileFromResult(result) {
  const title = String(result.title || '').replace(/\s*[|·]\s*LinkedIn.*$/i, '').trim();
  const [name, ...rest] = title.split(/\s+[-–—|]\s+/);
  const headline = [rest.join(' · '), result.snippet].filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim();
  return { name: name.trim(), headline: headline.length > 200 ? `${headline.slice(0, 199).trimEnd()}…` : headline, url: result.url };
}

// One search for one posting: { status: 'ok' | 'off' | 'no-key' | 'cap' | 'error', provider, results, reason }.
export async function searchCandidates({ config, company, io = fs, fetchImpl = fetch, now = new Date(), userAgent } = {}) {
  const status = await candidateSearchStatus(config, io);
  if (!status.available) return { status: status.reason, provider: status.provider || null, results: [] };
  const settings = searchSettings(config);
  const { apiKey } = await readSearchKey(config, settings.provider, io);
  const usageFile = searchUsagePath(config);
  const month = monthKey(now, config.timeZone || null);
  const stored = await readSearchUsage(usageFile, io);
  const usage = stored.month === month ? { ...stored } : { month, queries: 0 };
  if (Number(usage.queries || 0) >= settings.monthlyQueryCap) {
    return { status: 'cap', provider: settings.provider, results: [], reason: `The monthly search cap is reached (${usage.queries}/${settings.monthlyQueryCap})` };
  }
  usage.queries = Number(usage.queries || 0) + 1;
  usage.provider = settings.provider;
  usage.lastQueryAt = now.toISOString();
  await writeSearchUsage(usageFile, usage, io);
  const request = searchRequest(settings.provider, candidateQuery(company), apiKey, userAgent || config.network?.userAgent, { recent: false, count: 10 });
  try {
    const response = await fetchImpl(assertNotLinkedIn(request.url), request.init);
    if (!response.ok) return { status: 'error', provider: settings.provider, results: [], reason: `HTTP ${response.status}` };
    const results = parseSearchResults(settings.provider, await response.json())
      .filter(item => isLinkedInUrl(item.url) && /\/in\//.test(new URL(item.url).pathname))
      .map(profileFromResult)
      .filter(item => item.name)
      .slice(0, MAX_CANDIDATES);
    return { status: 'ok', provider: settings.provider, results };
  } catch (error) {
    return { status: 'error', provider: settings.provider, results: [], reason: errorSummary(error).split(apiKey).join('[redacted]') };
  }
}

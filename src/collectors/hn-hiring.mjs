// Hacker News "Ask HN: Who is hiring?" through the public Algolia HN Search API (no key, no login):
//   GET https://hn.algolia.com/api/v1/search_by_date?query="who is hiring"&tags=story,author_whoishiring
//       { hits: [{ objectID, title, created_at, num_comments }] }  newest first; the monthly thread is
//       the hit titled "Ask HN: Who is hiring? (<Month> <Year>)".
//   GET https://hn.algolia.com/api/v1/items/{id}
//       { id, title, children: [{ id, author, created_at, parent_id, text (HTML), children: [...] }] }
//       Top-level children are the job posts; deeper children are replies and are ignored.
// Posts follow the thread's convention "Company | Role | Location | Remote/Onsite | Salary | ...".
import { HACKER_NEWS_SOURCE } from './catalog.mjs';
import { cleanText, decodeEntities, isoDate, normalizeLocation } from '../utils.mjs';
import { createWarning } from '../warnings.mjs';

export const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date?query=%22who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=10';
export const HN_ITEM_URL = 'https://hn.algolia.com/api/v1/items/';
const HIRING_TITLE = /^Ask HN: Who is hiring\?/i;
// Only posts that say so are early-career; everything else in the thread is left alone.
const EARLY_CAREER = /\b(intern(?:ship)?s?|new[- ]grads?(?:uate)?s?|entry[- ]level|junior)\b/i;
// "Remote (US)", "Austin, TX", "Bengaluru, India", "ONSITE", or a well-known city or region name.
const LOCATION_HINT = /\b(remote|hybrid|on-?site|in[- ]office|relocat)|,\s*[A-Z]{2}\b|^[A-Z][A-Za-z.' -]+,\s*[A-Z][A-Za-z.' -]+$|\b(USA?|United States|NYC|SF|Bay Area|New York|San Francisco|Seattle|Boston|Austin|Chicago|London|Berlin|Europe|EU|UK|Canada|India)\b/;

export function roleTypeFromText(text) {
  const value = String(text || '');
  if (/\bintern(?:ship)?s?\b/i.test(value)) return 'internship';
  if (/\bnew[- ]grads?(?:uate)?s?\b/i.test(value)) return 'new_grad';
  if (/\b(entry[- ]level|junior)\b/i.test(value)) return 'entry_level';
  return null;
}

// The first line of a post is its header; segments are separated by pipes.
export function parseHiringHeader(html) {
  const decoded = decodeEntities(String(html || ''));
  const firstLine = decoded.split(/<p>|<br\s*\/?>|\n/i)[0] || '';
  const segments = cleanText(firstLine).split('|').map(part => part.trim()).filter(Boolean);
  if (!segments.length) return null;
  const company = segments[0].replace(/\s*\(.*?\)\s*$/, '').trim();
  const rest = segments.slice(1);
  const isLocation = part => LOCATION_HINT.test(part) || /\b(remote|hybrid|on-?site|in[- ]office|relocat)/i.test(part);
  const title = rest.find(part => EARLY_CAREER.test(part)) || rest.find(part => !isLocation(part)) || rest[0] || '';
  const location = rest.filter(part => part !== title && isLocation(part)).join(' · ');
  return { company, title, location: normalizeLocation(location), segments };
}

export function parseHiringComments(story, { now = new Date() } = {}) {
  const storyId = String(story?.id || '');
  const children = Array.isArray(story?.children) ? story.children : [];
  const jobs = [];
  for (const comment of children) {
    if (!comment?.text || String(comment.parent_id || storyId) !== storyId) continue;
    const text = cleanText(comment.text);
    if (!EARLY_CAREER.test(text)) continue;
    const header = parseHiringHeader(comment.text);
    if (!header || !header.company || !header.title) continue;
    const id = String(comment.id);
    const url = `https://news.ycombinator.com/item?id=${id}`;
    jobs.push({
      source: HACKER_NEWS_SOURCE,
      sourceKind: 'public_forum_thread',
      company: header.company,
      title: header.title,
      location: header.location,
      url,
      finalUrl: url,
      roleType: roleTypeFromText(`${header.title} ${text}`),
      postedAt: isoDate(comment.created_at) || now.toISOString(),
      freshnessBasis: 'hn_comment_created_at',
      description: text.slice(0, 50000),
      hnCommentId: id,
      hnStoryTitle: story.title || '',
      enrichment: 'source_api',
    });
  }
  return jobs;
}

async function getJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', ...headers } });
  if (!response.ok) throw new Error(`${HACKER_NEWS_SOURCE}: HTTP ${response.status} for ${url}`);
  return response.json();
}

export async function findHiringStory(fetchImpl, headers = {}) {
  const search = await getJson(fetchImpl, HN_SEARCH_URL, headers);
  const hit = (Array.isArray(search?.hits) ? search.hits : []).find(item => HIRING_TITLE.test(String(item?.title || '')));
  return hit ? { id: String(hit.objectID), title: hit.title, createdAt: hit.created_at } : null;
}

export async function collectHackerNewsHiring({ fetchImpl = fetch, userAgent = 'DailyJobMatchAlert/0.1', warnings = null, now = new Date() } = {}) {
  const headers = { 'user-agent': userAgent };
  const story = await findHiringStory(fetchImpl, headers);
  if (!story) throw new Error(`${HACKER_NEWS_SOURCE}: no "Ask HN: Who is hiring?" thread found in the Algolia index`);
  const item = await getJson(fetchImpl, `${HN_ITEM_URL}${story.id}`, headers);
  const posts = (Array.isArray(item?.children) ? item.children : []).filter(child => child?.text);
  if (!posts.length && Array.isArray(warnings)) {
    warnings.push(createWarning('collector', HACKER_NEWS_SOURCE, `${story.title} (${story.id}) returned no top-level posts; the Algolia item format may have changed, check the source and the parser`));
  }
  return parseHiringComments(item, { now });
}

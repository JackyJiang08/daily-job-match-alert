// Job Description completeness (2026-11-14). A posting page without JSON-LD used to hand its <meta
// name="description"> (a one- or two-hundred-character search-engine summary ending in "…") to the report as the
// whole JD. This module reads the description out of the page itself and says whether what was found is complete:
//   - extractJobBody(html, { minimum }): the posting's body as the page's own markup, from the content container
//     the common applicant-tracking systems render (iCIMS, Taleo, SuccessFactors, Oracle HCM, Jobvite, BambooHR,
//     Workable, Paylocity, ADP, UKG, then [itemprop=description], job-description classes and ids, main, article),
//     or, failing those, the block with the most text and few links once nav, header, footer, aside, form, script
//     and style are gone;
//   - extractEmbeddedDescription(html, { minimum }): the longest description field with markup or line breaks in
//     the page's embedded JSON (__NEXT_DATA__, window.__INITIAL_STATE__ and the like);
//   - isCompleteText(text, minimum) and descriptionStatus(job, { minimum }): a description is complete when it
//     did not come from a meta tag, has at least `minimum` characters (config.minimumDescriptionCharacters), and
//     does not end in "…" or "...". Every posting carries descriptionComplete and descriptionSource (ats_api,
//     json_ld, page_body, embedded_json, list, meta, or null when there is no text at all);
//   - incompleteDescriptionSummary(jobs): the run's info warning (count and the first hosts).
// Nothing here fetches: enrich.mjs feeds it the page it already has. The extracted markup goes through
// cleanDescriptionHtml (src/jd-html.mjs) like every other source.
import { cleanText, decodeEntities } from './utils.mjs';

export const DEFAULT_MINIMUM_DESCRIPTION_CHARACTERS = 200;
export const DESCRIPTION_SOURCES = ['ats_api', 'json_ld', 'page_body', 'embedded_json', 'list', 'meta'];
// Links may make up this share of a block's text before it reads as navigation rather than a description.
export const MAXIMUM_LINK_SHARE = 0.3;
// A page larger than this is read up to here (a JD never needs more; embedded data can be huge).
const MAXIMUM_PAGE_CHARACTERS = 3_000_000;
const ELLIPSIS_END = /(?:…|\.\.\.)\s*$/;

export function endsTruncated(text) {
  return ELLIPSIS_END.test(String(text || '').trim());
}

export function isCompleteText(text, minimum = DEFAULT_MINIMUM_DESCRIPTION_CHARACTERS) {
  const value = String(text || '').trim();
  return value.length >= Number(minimum) && !endsTruncated(value);
}

// ------------------------------------------------------------------------------------------ the page tree

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Never part of a description; dropped with their content before the page is read.
const ALWAYS_DROPPED = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'select', 'textarea', 'button'];
// Page furniture, never part of a description either: dropped before the containers are looked for. Forms go
// only before the densest block is looked for: Taleo renders the whole posting inside one.
const FURNITURE = ['nav', 'header', 'footer', 'aside'];
const FORMS = ['form'];
// A description container is a block; these never are one.
const NOT_A_CONTAINER = new Set(['a', 'b', 'strong', 'em', 'i', 'u', 'small', 'sup', 'sub', 'label', 'time', 'code', 'abbr', 'html', 'head', 'title', 'body', '#root']);

function stripElements(html, names) {
  let out = html;
  for (const name of names) out = out.replace(new RegExp(`<${name}\\b[\\s\\S]*?(?:<\\/${name}\\s*>|$)`, 'gi'), ' ');
  return out;
}

function prepare(html, furniture) {
  const source = String(html || '').slice(0, MAXIMUM_PAGE_CHARACTERS).replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  return stripElements(source, furniture ? [...ALWAYS_DROPPED, ...FURNITURE, ...FORMS] : [...ALWAYS_DROPPED, ...FURNITURE]);
}

function textLength(raw) {
  return decodeEntities(raw).replace(/[\s ]+/g, ' ').trim().length;
}

// A small element tree: name, attributes, where the content starts and ends in `html`, the text length of the
// element's own text nodes, and the children. Closing tags close everything opened inside the element they
// name; a closing tag with no open element is ignored; the end of the page closes the rest.
export function parseTree(html) {
  const root = { name: '#root', attrs: '', children: [], start: 0, contentStart: 0, contentEnd: html.length, end: html.length, ownText: 0, parent: null };
  const stack = [root];
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*)>|([^<]+)|(<)/g;
  for (const match of html.matchAll(pattern)) {
    const [, slash, rawName, attrs, text, stray] = match;
    const top = stack[stack.length - 1];
    if (text != null || stray != null) {
      top.ownText += textLength(text ?? stray);
      continue;
    }
    const name = rawName.toLowerCase();
    if (slash === '/') {
      const index = stack.findLastIndex(node => node.name === name);
      if (index <= 0) continue;
      while (stack.length > index) {
        const node = stack.pop();
        node.contentEnd = match.index;
        node.end = match.index + match[0].length;
      }
      continue;
    }
    const node = { name, attrs: attrs || '', children: [], parent: top, start: match.index, contentStart: match.index + match[0].length, contentEnd: -1, end: -1, ownText: 0 };
    top.children.push(node);
    if (VOID.has(name) || /\/\s*$/.test(attrs || '')) {
      node.contentEnd = node.end = node.contentStart;
      continue;
    }
    stack.push(node);
  }
  while (stack.length > 1) {
    const node = stack.pop();
    node.contentEnd = node.end = html.length;
  }
  measure(root);
  return root;
}

// text: the element's whole text length; link: the part of it inside links.
function measure(node) {
  let text = node.ownText;
  let link = 0;
  for (const child of node.children) {
    measure(child);
    text += child.text;
    link += child.name === 'a' ? child.text : child.link;
  }
  node.text = text;
  node.link = link;
}

function attribute(node, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(node.attrs);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function classes(node) {
  return attribute(node, 'class').split(/\s+/).filter(Boolean);
}

function walk(node, visit) {
  for (const child of node.children) {
    visit(child);
    walk(child, visit);
  }
}

function innerHtml(html, node) {
  return html.slice(node.contentStart, node.contentEnd);
}

function isInside(node, candidates) {
  for (let current = node.parent; current; current = current.parent) if (candidates.includes(current)) return true;
  return false;
}

// ------------------------------------------------------------------------------------------ containers

const classMatches = pattern => node => classes(node).some(name => pattern.test(name));
const idMatches = pattern => node => pattern.test(attribute(node, 'id'));
const dataMatches = (name, pattern) => node => pattern.test(attribute(node, name));
const anyOf = (...tests) => node => tests.some(test => test(node));

// In order: the vendor containers, then the generic ones. The first rule whose matches hold a complete
// description wins; every match of that rule (outermost ones only) is kept, in page order.
export const CONTAINER_RULES = [
  { ats: 'iCIMS', test: anyOf(classMatches(/^iCIMS_JobContent$/i), idMatches(/^iCIMS_JobContent$/i)) },
  { ats: 'iCIMS', test: classMatches(/^iCIMS_(?:InfoMsg_Job|Expandable_Container|JobsTable)$/i) },
  // Taleo: the description rows (requisitionDescriptionInterface.ID1540.row1), not the page wrapper of that name.
  { ats: 'Taleo', test: anyOf(idMatches(/^requisitionDescriptionInterface\.ID\d+\.row\d+$/i), classMatches(/^(?:requisitionDescriptionInterface|editablesection)$/i)) },
  { ats: 'SuccessFactors', test: anyOf(classMatches(/^(?:jobdescription|jobDisplay(?:Shell)?|job-description-content)$/i), idMatches(/^(?:job-?content|jobDisplayShell)$/i)) },
  { ats: 'Oracle HCM', test: classMatches(/^job-details__(?:description|section|description-content)/i) },
  { ats: 'Jobvite', test: classMatches(/^jv-job-detail-(?:description|meta|body)$/i) },
  { ats: 'BambooHR', test: anyOf(classMatches(/^(?:js-jobs-description|BambooHR-ATS-Description|ResAts__description)/i), idMatches(/^(?:js-jobs-description|BambooHR-ATS-Description)/i)) },
  { ats: 'Workable', test: anyOf(dataMatches('data-ui', /^job-(?:description|requirements|benefits)$/i), classMatches(/^section--text$/i)) },
  { ats: 'Paylocity', test: anyOf(classMatches(/^(?:job-preview-details|preview-description|job-description-content)$/i), idMatches(/^(?:job-preview-details|jobDescription)$/i)) },
  { ats: 'ADP', test: anyOf(classMatches(/^(?:job-description|sectionDescription|jobDescription)$/i), idMatches(/^(?:jobDescription|job-description)$/i)) },
  { ats: 'UKG', test: anyOf(dataMatches('data-automation', /^job-description$/i), classMatches(/^(?:opportunity-description|opportunity-details)$/i)) },
  // SmartRecruiters posting pages: every section (description, qualifications, additional information) at once.
  { ats: 'SmartRecruiters', test: classMatches(/^job-sections$/i) },
  { ats: null, test: dataMatches('itemprop', /^description$/i) },
  { ats: null, test: anyOf(classMatches(/job[-_]?description/i), idMatches(/job[-_]?description/i)) },
  { ats: null, test: anyOf(classMatches(/^(?:posting|job)-?(?:details|content|body)$/i), idMatches(/^(?:posting|job)-?(?:details|content|body)$/i)) },
  { ats: null, test: node => node.name === 'main' },
  { ats: null, test: node => node.name === 'article' },
];

function outermost(nodes) {
  return nodes.filter(node => !isInside(node, nodes));
}

function fromRule(html, root, rule, minimum) {
  const matches = [];
  walk(root, node => { if (!NOT_A_CONTAINER.has(node.name) && rule.test(node)) matches.push(node); });
  const kept = outermost(matches);
  if (!kept.length) return null;
  const markup = kept.map(node => innerHtml(html, node)).join('\n');
  const text = cleanText(markup);
  return isCompleteText(text, minimum) ? { html: markup, text, ats: rule.ats, method: 'container' } : null;
}

// The block with the most text whose links make up at most MAXIMUM_LINK_SHARE of it, tightened to the
// innermost block that still carries the description: a wrapper gives way to its largest child when that child
// holds four fifths of the text, or when every other child is navigation (mostly links) or a crumb (a title
// line, a location), so a page column keeps its sections while a sidebar of related jobs is left behind.
function densest(html, root, minimum) {
  const qualifies = node => !NOT_A_CONTAINER.has(node.name) && node.text >= minimum && node.link <= node.text * MAXIMUM_LINK_SHARE;
  let best = null;
  walk(root, node => { if (qualifies(node) && (!best || node.text > best.text)) best = node; });
  if (!best) return null;
  for (;;) {
    const children = best.children.filter(node => node.text > 0);
    const child = children.filter(qualifies).sort((a, b) => b.text - a.text)[0];
    if (!child) break;
    const others = children.filter(node => node !== child);
    const furniture = others.every(node => node.link > node.text * MAXIMUM_LINK_SHARE || node.text < minimum / 4);
    if (!(child.text >= best.text * 0.8 || furniture)) break;
    best = child;
  }
  const markup = innerHtml(html, best);
  const text = cleanText(markup);
  return isCompleteText(text, minimum) ? { html: markup, text, ats: null, method: 'density' } : null;
}

// { html, text, ats, method: 'container' | 'density' } or null when the page holds no complete description.
export function extractJobBody(page, { minimum = DEFAULT_MINIMUM_DESCRIPTION_CHARACTERS } = {}) {
  if (!page || !/<[a-z][\s\S]*>/i.test(String(page))) return null;
  const html = prepare(page, false);
  const root = parseTree(html);
  for (const rule of CONTAINER_RULES) {
    const found = fromRule(html, root, rule, minimum);
    if (found) return found;
  }
  const bare = prepare(page, true);
  return densest(bare, parseTree(bare), minimum);
}

// ------------------------------------------------------------------------------------------ embedded JSON

const EMBEDDED_KEY = /"((?:[A-Za-z0-9_]*[dD]escription(?:Html|HTML|Text|Plain|_html|_text)?)|job_description)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

// The longest description field in the page's inline JSON (__NEXT_DATA__, window.__INITIAL_STATE__, …) that
// carries markup or line breaks and is complete; { html, text } or null. JSON-LD blocks are left to the
// JobPosting reader.
export function extractEmbeddedDescription(page, { minimum = DEFAULT_MINIMUM_DESCRIPTION_CHARACTERS } = {}) {
  let best = null;
  for (const [, attrs, body] of String(page || '').slice(0, MAXIMUM_PAGE_CHARACTERS).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/type\s*=\s*["']application\/ld\+json["']/i.test(attrs) || !/description/i.test(body)) continue;
    for (const match of body.matchAll(EMBEDDED_KEY)) {
      let value;
      try { value = JSON.parse(`"${match[2]}"`); } catch { continue; }
      if (typeof value !== 'string' || !/<[a-z][^>]*>|&lt;[a-z]|\n/i.test(value)) continue;
      const text = cleanText(value);
      if (!isCompleteText(text, minimum)) continue;
      if (!best || text.length > best.text.length) best = { html: value, text };
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------------ status

// The source of a posting's description when enrich did not record one (board and feed APIs, failed fetches,
// runs without page fetches): by the enrichment label, else the list's text.
export function inferDescriptionSource(job) {
  if (DESCRIPTION_SOURCES.includes(job?.descriptionSource)) return job.descriptionSource;
  const text = String(job?.description || '').trim();
  switch (job?.enrichment) {
    case 'ats_api': case 'source_api': case 'greenhouse_api': case 'workday_cxs': case 'smartrecruiters_api': case 'lever_api': case 'ashby_api':
      return text ? 'ats_api' : null;
    case 'json_ld_jobposting':
      return text ? 'json_ld' : null;
    case 'html_metadata':
      return text ? 'meta' : null;
    default:
      return text ? 'list' : null;
  }
}

// { descriptionComplete, descriptionSource } for one posting.
export function descriptionStatus(job, { minimum = DEFAULT_MINIMUM_DESCRIPTION_CHARACTERS } = {}) {
  const source = inferDescriptionSource(job);
  const complete = source != null && source !== 'meta' && isCompleteText(job?.description, minimum);
  return { descriptionComplete: complete, descriptionSource: source };
}

// The posting with its status filled in; one that already carries both fields is returned as it is.
export function withDescriptionStatus(job, options = {}) {
  if (typeof job?.descriptionComplete === 'boolean' && (job.descriptionSource === null || DESCRIPTION_SOURCES.includes(job.descriptionSource))) return job;
  return { ...job, ...descriptionStatus(job, options) };
}

export function hostOf(url) {
  try { return new URL(String(url || '')).hostname.replace(/^www\./, ''); } catch { return 'unknown host'; }
}

// { count, hosts: [{ host, count }], message } for the run's postings whose description is incomplete; failed
// fetches are left out (they have their own warning). hosts holds the first `limit` by count.
export function incompleteDescriptionSummary(jobs, { limit = 8, minimum = DEFAULT_MINIMUM_DESCRIPTION_CHARACTERS } = {}) {
  const incomplete = (Array.isArray(jobs) ? jobs : []).filter(job => job && job.enrichment !== 'failed' && job.descriptionComplete === false);
  const counts = new Map();
  for (const job of incomplete) {
    const host = hostOf(job.finalUrl || job.url);
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  const hosts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([host, count]) => ({ host, count }));
  const shown = hosts.slice(0, limit);
  const more = hosts.length - shown.length;
  const message = incomplete.length
    ? `${incomplete.length} posting(s) have an incomplete Job Description (a page summary, fewer than ${minimum} characters, or cut with an ellipsis); their cards link to the posting page instead: ${shown.map(item => `${item.host} (${item.count})`).join(', ')}${more > 0 ? `, and ${more} more host(s)` : ''}`
    : '';
  return { count: incomplete.length, hosts: shown, message };
}

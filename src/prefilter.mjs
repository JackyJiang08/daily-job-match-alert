// Narrows what reaches enrichment and the review budget, before any page fetch or model call. Final
// scoring and eligibility (match.mjs, eligibility.mjs) are untouched: this layer only decides which
// postings are worth fetching at all, and it reports every title it drops so the owner can spot a
// false positive.
//
//   title families   config.preferences.titleFamilies; postings from sources that are not curated by a
//                    person (public ATS boards, the Hacker News thread, RemoteOK) must name one.
//   exclusions       preferences.excludeTitleTerms (the eligibility list, default senior/staff/principal/
//                    lead/manager/director) plus preferences.prefilterExcludeTitleTerms (head of, vice
//                    president, VP, account manager, sales, technician, nurse, driver, mechanic) and
//                    preferences.excludeLevelSuffixes (II, III, IV); applied to every source.
//   location         a location assessLocation() calls non-US is dropped before enrichment.
import { assessLocation } from './eligibility.mjs';
import { ATS_SOURCE_KIND } from './collectors/ats-boards.mjs';

export const DEFAULT_TITLE_FAMILIES = [
  'data', 'analytics', 'analyst', 'scientist', 'machine learning', 'ML', 'AI', 'quantitative', 'quant',
  'business intelligence', 'BI', 'data engineer', 'software engineer', 'developer', 'product analyst',
  'research', 'insights', 'decision',
];
export const DEFAULT_ELIGIBILITY_EXCLUDES = ['senior', 'staff', 'principal', 'lead', 'manager', 'director'];
export const DEFAULT_PREFILTER_EXCLUDES = ['head of', 'vice president', 'VP', 'account manager', 'sales', 'technician', 'nurse', 'driver', 'mechanic'];
export const DEFAULT_LEVEL_SUFFIXES = ['II', 'III', 'IV'];

// Sources a person already curated for early-career roles only face the exclusion list.
const CURATED_SOURCE_KINDS = new Set(['public_github_list', 'official_email_alert', 'official_email_alert_via_himalaya', 'career_ops_scan']);
const WHITELIST_SOURCE_KINDS = new Set([ATS_SOURCE_KIND, 'public_forum_thread', 'public_json_feed']);

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A configured phrase matches as whole words, case-insensitively ("AI" never matches "Retail"; "lead"
// never matches "leading").
function phrasePattern(term) {
  const words = String(term || '').trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!words.length) return null;
  return new RegExp(`(?<![A-Za-z0-9])${words.join('[\\s/-]+')}(?![A-Za-z0-9])`, 'i');
}

// A level suffix is a standalone uppercase roman numeral ("Data Analyst II", "Engineer III, Platform").
function suffixPattern(suffix) {
  const text = String(suffix || '').trim();
  if (!text) return null;
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(text)}(?![A-Za-z0-9])`);
}

function listOr(value, fallback) {
  return Array.isArray(value) ? value.map(item => String(item)).filter(item => item.trim()) : fallback;
}

export function prefilterSettings(preferences = {}) {
  const families = listOr(preferences.titleFamilies, DEFAULT_TITLE_FAMILIES);
  const excludes = [...new Set([...listOr(preferences.excludeTitleTerms, DEFAULT_ELIGIBILITY_EXCLUDES), ...listOr(preferences.prefilterExcludeTitleTerms, DEFAULT_PREFILTER_EXCLUDES)])];
  const suffixes = listOr(preferences.excludeLevelSuffixes, DEFAULT_LEVEL_SUFFIXES);
  return {
    families: families.map(term => ({ term, pattern: phrasePattern(term) })).filter(item => item.pattern),
    excludes: excludes.map(term => ({ term, pattern: phrasePattern(term) })).filter(item => item.pattern),
    suffixes: suffixes.map(term => ({ term, pattern: suffixPattern(term) })).filter(item => item.pattern),
  };
}

export function requiresTitleFamily(job) {
  if (CURATED_SOURCE_KINDS.has(job?.sourceKind)) return false;
  return WHITELIST_SOURCE_KINDS.has(job?.sourceKind) || Boolean(job?.atsKind);
}

// null when the title passes, else the rule that dropped it ("exclude: technician", "level suffix: II",
// "no title family").
export function titleRule(job, settings) {
  const title = String(job?.title || '');
  const exclusion = settings.excludes.find(item => item.pattern.test(title));
  if (exclusion) return `exclude: ${exclusion.term}`;
  const suffix = settings.suffixes.find(item => item.pattern.test(title));
  if (suffix) return `level suffix: ${suffix.term}`;
  if (requiresTitleFamily(job) && !settings.families.some(item => item.pattern.test(title))) return 'no title family';
  return null;
}

// Splits the candidates into the ones worth enriching and the ones dropped by title or location, with
// per-source counts for Run Details.
export function prefilterJobs(jobs, preferences = {}) {
  const settings = prefilterSettings(preferences);
  const kept = [];
  const titleExcluded = [];
  const locationExcluded = [];
  const bySource = new Map();
  const count = (source, key) => {
    const name = String(source || 'unknown source');
    if (!bySource.has(name)) bySource.set(name, { source: name, title: 0, location: 0 });
    bySource.get(name)[key] += 1;
  };
  for (const job of jobs) {
    const rule = titleRule(job, settings);
    if (rule) {
      titleExcluded.push({ company: job.company || '', title: job.title || '', source: job.source || '', rule, url: job.url });
      count(job.source, 'title');
      continue;
    }
    const location = job.location ? assessLocation(job.location) : { verdict: 'unverified' };
    if (location.verdict === 'non_us') {
      locationExcluded.push({ company: job.company || '', title: job.title || '', source: job.source || '', rule: `location: ${location.marker}`, url: job.url });
      count(job.source, 'location');
      continue;
    }
    kept.push(job);
  }
  const sources = [...bySource.values()].sort((a, b) => (b.title + b.location) - (a.title + a.location) || a.source.localeCompare(b.source));
  return { jobs: kept, titleExcluded, locationExcluded, bySource: sources };
}

// ---- full-time early-career recognition (used by the review budget only; roleType is not changed)

const ENTRY_TITLE = /(?<![A-Za-z0-9])(?:associate|junior|jr\.?|graduate|university|early[\s-]+career|entry(?:[\s-]+level)?|rotational)(?![A-Za-z0-9])/i;
const LEVEL_ONE = /(?<![A-Za-z0-9])I(?![A-Za-z0-9])(?!\s*(?:\/|&))/;
const ANALYST = /(?<![A-Za-z0-9])analyst(?![A-Za-z0-9])/i;
const NEW_GRAD_JD = /(?<![A-Za-z0-9])(?:0\s*[-–]\s*2\s*(?:\+\s*)?years?|recent(?:ly)?\s+graduate[ds]?|class\s+of\s+2027|new[\s-]+grad(?:uate)?s?)(?![A-Za-z0-9])/i;
const INTERN = /(?<![A-Za-z0-9])(?:intern(?:ship)?s?|co[\s-]?op)(?![A-Za-z0-9])/i;

// 'new_grad' when the title reads entry level (or is a plain Analyst) and the description names an early-
// career signal; 'entry_level' for the title alone; null otherwise. Internships are left to their own
// role type, and a senior word or level suffix in the title rules a posting out.
export function detectEarlyCareer(job, preferences = {}) {
  const title = String(job?.title || '');
  if (!title || job?.roleType === 'internship' || INTERN.test(title)) return { level: null, signal: null };
  const settings = prefilterSettings(preferences);
  const senior = settings.excludes.some(item => item.pattern.test(title)) || settings.suffixes.some(item => item.pattern.test(title));
  if (senior) return { level: null, signal: null };
  const titleSignal = ENTRY_TITLE.exec(title)?.[0] || (LEVEL_ONE.test(title) ? 'level I' : null) || (ANALYST.test(title) ? 'analyst' : null);
  const jdSignal = NEW_GRAD_JD.exec(String(job?.description || ''))?.[0] || null;
  if (titleSignal && jdSignal) return { level: 'new_grad', signal: `${titleSignal}; JD: ${jdSignal}` };
  if (titleSignal) return { level: 'entry_level', signal: titleSignal };
  return { level: null, signal: null };
}

// The review budget weighs internships and recognised early-career full-time roles the same.
export function isEarlyCareerPriority(job) {
  return job?.roleType === 'internship' || job?.earlyCareer === 'new_grad' || job?.earlyCareer === 'entry_level';
}

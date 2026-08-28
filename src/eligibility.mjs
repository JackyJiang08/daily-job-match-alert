// Deterministic eligibility rules. They run inside isEligible for every posting, whether it was scored by
// the subscription model or by the local fallback, so an outage of the semantic layer can never let a
// non-US or wrong-cohort posting into the report. Every rule prefers letting a posting through over
// excluding it wrongly: ambiguous wording is left to the semantic review.
import { unique } from './utils.mjs';

export const LOCATION_UNVERIFIED_GAP = 'Location unverified — confirm US eligibility';

// Any of these in the location field marks a posting as outside the United States, unless a US marker is
// also present (multi-location postings such as "Toronto / New York, NY" pass to the semantic layer).
// Extend freely: entries are matched as whole words or phrases, case-insensitively.
export const NON_US_LOCATION_MARKERS = [
  // Canada and Mexico
  'Canada', 'Toronto', 'Vancouver', 'Montreal', 'Montréal', 'Ottawa', 'Calgary', 'Edmonton', 'Waterloo', 'Mississauga',
  'Ontario', 'Quebec', 'Québec', 'British Columbia', 'Alberta', 'Mexico', 'Mexico City', 'Guadalajara', 'Monterrey',
  // United Kingdom and Ireland
  'United Kingdom', 'UK', 'U.K.', 'Great Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland', 'Ireland',
  'London', 'Manchester', 'Edinburgh', 'Dublin',
  // Europe
  'Germany', 'France', 'Spain', 'Italy', 'Netherlands', 'Belgium', 'Luxembourg', 'Austria', 'Switzerland',
  'Sweden', 'Denmark', 'Norway', 'Finland', 'Iceland', 'Poland', 'Portugal', 'Czech Republic', 'Czechia',
  'Slovakia', 'Hungary', 'Romania', 'Bulgaria', 'Greece', 'Croatia', 'Slovenia', 'Estonia', 'Latvia', 'Lithuania',
  'Serbia', 'Ukraine', 'Turkey', 'Türkiye', 'Berlin', 'Munich', 'Paris', 'Amsterdam', 'Zurich', 'Zürich',
  'Stockholm', 'Copenhagen', 'Oslo', 'Helsinki', 'Warsaw', 'Lisbon', 'Madrid', 'Barcelona', 'Milan', 'Prague',
  'Europe', 'European Union', 'EMEA',
  // Asia-Pacific
  'India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'China', 'Hong Kong', 'Taiwan', 'Japan', 'South Korea', 'Korea',
  'Singapore', 'Malaysia', 'Indonesia', 'Philippines', 'Vietnam', 'Thailand', 'Australia', 'New Zealand',
  'Bengaluru', 'Bangalore', 'Hyderabad', 'Mumbai', 'Pune', 'Chennai', 'Gurgaon', 'Gurugram', 'Noida', 'New Delhi',
  'Tokyo', 'Seoul', 'Taipei', 'Shanghai', 'Beijing', 'Shenzhen', 'Sydney', 'Melbourne', 'APAC',
  // Middle East and Africa
  'Israel', 'Tel Aviv', 'United Arab Emirates', 'UAE', 'Dubai', 'Abu Dhabi', 'Saudi Arabia', 'Qatar', 'Egypt',
  'South Africa', 'Nigeria', 'Kenya',
  // Central and South America
  'Brazil', 'Argentina', 'Chile', 'Colombia', 'Peru', 'Uruguay', 'Costa Rica', 'LATAM', 'Latin America',
  'São Paulo', 'Sao Paulo', 'Buenos Aires', 'Bogotá', 'Bogota',
];

const US_STATE_NAMES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida',
  'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
  'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma',
  'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia', 'Puerto Rico',
];
const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR',
];
// Cities that appear in postings without a state; names that also belong to well-known non-US cities are
// deliberately left out (Cambridge, Richmond, Portland is kept because the Oregon one dominates postings).
const US_CITY_NAMES = [
  'New York City', 'NYC', 'Manhattan', 'Brooklyn', 'San Francisco', 'Bay Area', 'Silicon Valley', 'San Jose',
  'Mountain View', 'Palo Alto', 'Menlo Park', 'Sunnyvale', 'Santa Clara', 'Cupertino', 'Redwood City', 'San Mateo',
  'Oakland', 'Berkeley', 'Los Angeles', 'Santa Monica', 'Irvine', 'San Diego', 'Seattle', 'Redmond', 'Bellevue',
  'Portland', 'Austin', 'Dallas', 'Houston', 'Plano', 'Chicago', 'Boston', 'Washington, D.C.', 'Washington DC',
  'Arlington', 'Reston', 'McLean', 'Atlanta', 'Denver', 'Boulder', 'Phoenix', 'Tempe', 'Scottsdale', 'Pittsburgh',
  'Philadelphia', 'Miami', 'Tampa', 'Orlando', 'Minneapolis', 'Detroit', 'Ann Arbor', 'Raleigh', 'Durham',
  'Charlotte', 'Nashville', 'Salt Lake City', 'Columbus', 'Cincinnati', 'Cleveland', 'Indianapolis', 'Kansas City',
  'St. Louis', 'Milwaukee', 'Madison', 'Baltimore', 'Jersey City', 'Hoboken', 'Stamford', 'Hartford', 'Princeton',
  'Las Vegas', 'Sacramento', 'Fremont', 'Bentonville', 'Louisville', 'Omaha', 'Des Moines', 'Boise', 'Albuquerque',
  'Champaign', 'Urbana',
];
export const US_LOCATION_MARKERS = ['United States', 'United States of America', 'USA', 'U.S.A.', 'U.S.', 'US', ...US_STATE_NAMES, ...US_CITY_NAMES];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phrasePattern(marker, flags = 'i') {
  // "U.S." and "U.K." end in a period, which is not a word character; use lookarounds instead of \b.
  return new RegExp(`(?<![A-Za-z])${escapeRegExp(marker)}(?![A-Za-z])`, flags);
}

// Two-letter codes and the bare "US"/"USA" abbreviations are matched case-sensitively so that ordinary
// words such as "in", "or", or "us" cannot pass a posting; state codes must also follow a separator.
const US_PATTERNS = [
  ...['USA', 'U.S.A.', 'U.S.', 'US'].map(marker => ({ marker, pattern: phrasePattern(marker, '') })),
  ...['United States', 'United States of America', ...US_STATE_NAMES, ...US_CITY_NAMES].map(marker => ({ marker, pattern: phrasePattern(marker) })),
  { marker: 'state code', pattern: new RegExp(`(?:^|[,(/\\-–—]|\\bin)\\s*(?:${US_STATE_CODES.join('|')})(?![A-Za-z])`) },
];
const NON_US_PATTERNS = NON_US_LOCATION_MARKERS.map(marker => ({
  marker,
  pattern: phrasePattern(marker, /^[A-Z.]+$/.test(marker) ? '' : 'i'),
}));

function firstMarker(text, patterns) {
  for (const { marker, pattern } of patterns) {
    if (pattern.test(text)) return marker;
  }
  return null;
}

// verdict: 'us' passes, 'non_us' is excluded, 'unverified' passes with a gap the reader must confirm.
export function assessLocation(location) {
  const text = String(location || '').replace(/\s+/g, ' ').trim();
  if (!text) return { verdict: 'unverified', marker: null };
  const us = firstMarker(text, US_PATTERNS);
  if (us) return { verdict: 'us', marker: us };
  const nonUs = firstMarker(text, NON_US_PATTERNS);
  if (nonUs) return { verdict: 'non_us', marker: nonUs };
  return { verdict: 'unverified', marker: null };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// A season resolves to the month a graduation or start date in that season would usually fall on.
const SEASONS = { spring: 5, summer: 8, fall: 12, autumn: 12, winter: 12 };
const DATE_TOKEN = /\b(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+|(spring|summer|fall|autumn|winter)\s+(?:of\s+)?|(\d{1,2})\/)?(20[2-3]\d)\b/g;
// Wording after the anchor that widens the window ("2026 or later", "December 2026 onward") means the
// owner's later date is acceptable, so the rule stands down.
const OPEN_ENDED_WINDOW = /\b(?:or|and)\s+(?:later|after|beyond)\b|\bonwards?\b|\bor\s+earlier\s+is\s+not\b|\+\s*$/;

export function parseGraduationDate(value) {
  const match = String(value || '').match(/^(20\d\d)(?:-(\d{1,2}))?$/);
  if (!match) return null;
  const month = match[2] ? Number(match[2]) : 5;
  if (month < 1 || month > 12) return null;
  return { year: Number(match[1]), month };
}

function datesIn(window) {
  const dates = [];
  for (const match of window.matchAll(DATE_TOKEN)) {
    const [, month, season, numericMonth, year] = match;
    dates.push({
      year: Number(year),
      month: month ? MONTHS[month] : season ? SEASONS[season] : numericMonth ? Number(numericMonth) : null,
    });
  }
  return dates.filter(date => date.month == null || (date.month >= 1 && date.month <= 12));
}

// A year without a month only excludes when the whole year is over before the threshold.
function earlierThan(date, threshold) {
  if (date.year !== threshold.year) return date.year < threshold.year;
  return date.month != null && date.month < threshold.month;
}

function monthAfter({ year, month }) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

const GRADUATION_WORD = 'graduat(?:e|es|ed|ing|ion)(?:\\s+date)?';
// Each rule: an anchor regex, a window of text after the anchor in which dates are collected, which
// threshold the dates are compared against, and the intent that justifies excluding on it. A rule fires
// only when the window holds at least one date and every date is earlier than the threshold; a window
// that also names an acceptable date ("Class of 2026 or 2027") or is open-ended never fires.
export const GRADUATION_EXCLUSION_RULES = [
  {
    name: 'class_of',
    // "Class of 2026" names the cohort the employer hires; the owner belongs to the class of 2027.
    anchor: /\bclass\s+of\b/g,
    windowLength: 40,
    threshold: 'graduation',
  },
  {
    name: 'graduate_by',
    // "graduating by/before/no later than December 2026" caps the graduation date below May 2027.
    anchor: new RegExp(`\\b${GRADUATION_WORD}\\b[^.;:\\n]{0,40}?\\b(?:by|before|prior\\s+to|no\\s+later\\s+than|on\\s+or\\s+before|earlier\\s+than)\\b`, 'g'),
    windowLength: 50,
    threshold: 'graduation',
  },
  {
    name: 'graduate_between',
    // "graduation date between December 2025 and December 2026": the upper bound is before May 2027.
    anchor: new RegExp(`\\b${GRADUATION_WORD}\\b[^.;:\\n]{0,40}?\\bbetween\\b`, 'g'),
    windowLength: 70,
    threshold: 'graduation',
  },
  {
    name: 'full_time_start',
    // "must be able to start/work full-time by January 2027": a full-time start before June 2027 is
    // impossible for a May 2027 graduate. Requires requirement wording ("must", "able to", ...) so that
    // descriptive text such as "interns work full-time from June" is ignored; internships skip this rule.
    anchor: /\b(?:must|should|need(?:s)?\s+to|required\s+to|able\s+to|ability\s+to|expected\s+to|willing\s+to|availab(?:le|ility)\s+to)\b[^.;:\n]{0,30}?\b(?:begin|start|starting|commence|work|working|join|joining)\b[^.;:\n]{0,30}?\bfull[\s-]?time\b[^.;:\n]{0,40}?\b(?:by|on|in|starting|beginning|no\s+later\s+than|before|as\s+of|from)\b/g,
    windowLength: 50,
    threshold: 'fullTimeStart',
    skipRoleTypes: ['internship'],
  },
];

export function assessGraduationWindow(text, graduationDate, roleType = null) {
  const graduation = parseGraduationDate(graduationDate);
  if (!graduation) return { excluded: false, skipped: true, reason: null };
  const thresholds = { graduation, fullTimeStart: monthAfter(graduation) };
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  for (const rule of GRADUATION_EXCLUSION_RULES) {
    if (rule.skipRoleTypes?.includes(roleType)) continue;
    for (const match of normalized.matchAll(rule.anchor)) {
      const window = normalized.slice(match.index + match[0].length, match.index + match[0].length + rule.windowLength);
      if (OPEN_ENDED_WINDOW.test(window)) continue;
      const dates = datesIn(window);
      if (!dates.length) continue;
      if (dates.every(date => earlierThan(date, thresholds[rule.threshold]))) {
        const snippet = normalized.slice(match.index, match.index + match[0].length + rule.windowLength).trim();
        return { excluded: true, skipped: false, rule: rule.name, reason: `${rule.name.replace(/_/g, ' ')}: "${snippet}"` };
      }
    }
  }
  return { excluded: false, skipped: false, reason: null };
}

export function assessEligibility(job, preferences = {}) {
  const location = assessLocation(job.location);
  if (location.verdict === 'non_us') {
    return { location, exclusion: { kind: 'location', reason: `location outside the United States (${location.marker})` } };
  }
  const graduation = assessGraduationWindow(`${job.title || ''} ${job.description || ''}`, preferences.graduationDate, job.roleType);
  if (graduation.excluded) {
    return { location, exclusion: { kind: 'graduation', reason: `outside the graduation window (${graduation.reason})` } };
  }
  return { location, exclusion: null };
}

// Stores the assessment on the job and surfaces an unverified location as a gap the reader must confirm.
export function annotateEligibility(job, preferences = {}) {
  const eligibility = assessEligibility(job, preferences);
  const gaps = eligibility.location.verdict === 'unverified'
    ? unique([...(job.gaps || []), LOCATION_UNVERIFIED_GAP])
    : (job.gaps || []).filter(gap => gap !== LOCATION_UNVERIFIED_GAP);
  return { ...job, eligibility, gaps };
}

export function summarizeExclusions(jobs) {
  const counts = { location: 0, graduation: 0 };
  const examples = [];
  for (const job of jobs) {
    const exclusion = job.eligibility?.exclusion;
    if (!exclusion) continue;
    counts[exclusion.kind] = (counts[exclusion.kind] || 0) + 1;
    examples.push(`${[job.company, job.title].filter(Boolean).join(' — ') || job.url}: ${exclusion.reason}`);
  }
  return { counts, total: counts.location + counts.graduation, examples };
}

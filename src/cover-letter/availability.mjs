// Letter rules settings (config.coverLetter) and the owner's availability window, used by the v2 letter rules
// (2026-11-08): the availability sentence the prompt and the playbook carry, the check that a letter names no
// work term the owner cannot take, and the posting-term check that keeps the automatic pass from writing a
// letter for a term that starts too early (the card shows "Term Conflict"; the owner can still generate one).
//   config.coverLetter.rulesVersion   "v1" (the rules before 2026-11-08) | "v2"
//   config.coverLetter.openingStyle   "limit-writing-to" (an "I am writing to apply" opening at most 30 percent of
//                                     the last 7 days' letters) | "ban-writing-to" (never)
//   config.coverLetter.availability   { fullTimeFrom: "June 2027", springTerm: false,
//                                       mentionMasters: { internship: true, newGrad: false } }

export const RULES_VERSIONS = ['v1', 'v2'];
export const OPENING_STYLES = ['limit-writing-to', 'ban-writing-to'];
export const WRITING_TO_LIMIT = 0.3;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// When a season's term starts: spring and winter terms run from January, summer from June, fall from September.
const SEASONS = { winter: 0, spring: 0, summer: 5, fall: 8, autumn: 8 };
const TERM = new RegExp(`\\b(${[...Object.keys(SEASONS), ...MONTHS].join('|')})(?:\\s+(?:semester|term|quarter|session|of))?\\s+(\\d{4})\\b`, 'gi');

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// "June 2027" → { year: 2027, month: 5, label: "June 2027" }; null when it does not parse.
export function parseMonthYear(value) {
  const match = /^\s*([A-Za-z]+)\s+(\d{4})\s*$/.exec(String(value || ''));
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  return { year: Number(match[2]), month, label: `${capitalize(MONTHS[month])} ${match[2]}` };
}

function graduationParts(graduationDate) {
  const match = /^(\d{4})-(\d{2})/.exec(String(graduationDate || '2027-05'));
  return match ? { year: Number(match[1]), month: Number(match[2]) - 1 } : { year: 2027, month: 4 };
}

// The month after graduation, the default start of full-time availability.
function defaultFullTimeFrom(graduationDate) {
  const { year, month } = graduationParts(graduationDate);
  const next = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
  return `${capitalize(MONTHS[next.month])} ${next.year}`;
}

export function normalizeAvailability(raw = {}, graduationDate = null) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const from = parseMonthYear(value.fullTimeFrom) || parseMonthYear(defaultFullTimeFrom(graduationDate));
  const masters = value.mentionMasters && typeof value.mentionMasters === 'object' ? value.mentionMasters : {};
  return {
    fullTimeFrom: from.label,
    springTerm: value.springTerm === true,
    mentionMasters: { internship: masters.internship !== false, newGrad: masters.newGrad === true },
  };
}

// Everything the letters read from config.coverLetter, with defaults.
export function letterRulesSettings(config = {}) {
  const raw = config.coverLetter && typeof config.coverLetter === 'object' ? config.coverLetter : {};
  return {
    rulesVersion: RULES_VERSIONS.includes(raw.rulesVersion) ? raw.rulesVersion : 'v1',
    openingStyle: OPENING_STYLES.includes(raw.openingStyle) ? raw.openingStyle : 'limit-writing-to',
    availability: normalizeAvailability(raw.availability, config.preferences?.graduationDate),
  };
}

// The earliest work start the owner can take: January of the graduation year when a spring term is possible,
// otherwise the full-time date.
export function earliestStart(availability, graduationDate = null) {
  if (availability.springTerm) return { year: graduationParts(graduationDate).year, month: 0 };
  const from = parseMonthYear(availability.fullTimeFrom);
  return { year: from.year, month: from.month };
}

function before(a, b) {
  return a.year < b.year || (a.year === b.year && a.month < b.month);
}

// Every "<season|month> <year>" in the text with its start: [{ text, year, month, index }].
export function termMentions(text) {
  const found = [];
  for (const match of String(text || '').matchAll(TERM)) {
    const word = match[1].toLowerCase();
    const month = word in SEASONS ? SEASONS[word] : MONTHS.indexOf(word);
    found.push({ text: match[0], year: Number(match[2]), month, index: match.index });
  }
  return found;
}

// Should the master's plan be mentioned for this role type?
export function mastersAllowed(roleType, availability) {
  return roleType === 'internship' ? availability.mentionMasters.internship : availability.mentionMasters.newGrad;
}

// The availability rule as the prompt and the playbook state it ({{AVAILABILITY}} in the playbook).
export function availabilityText({ roleType = 'unknown', availability, graduation }) {
  const from = availability.fullTimeFrom;
  const window = `Enrolled through ${graduation.month}; available full time from ${from}.`;
  const terms = availability.springTerm
    ? ` A spring term starting no earlier than January ${graduation.year} may be accepted when the posting asks for one; never name an earlier term or start date, and never promise an end date.`
    : ` Never name, accept, or imply a work term, season, or start date earlier than ${from} (spring or winter co-ops, January starts, part-time work during the semester), and never promise an end date. If the posting's term starts earlier or is not stated, write "I am available full time from ${from}" and nothing else about dates.`;
  const masters = mastersAllowed(roleType, availability)
    ? ` For this role, the timeline sentence mentions the plan to begin a master's program in ${graduation.nextFall}.`
    : ` Do not mention a master's program, graduate school, or any study plan after ${graduation.month}.`;
  return `${window}${terms}${masters}`;
}

// The v2 timeline sentence for the role type, following the master's setting.
export function timelineRuleV2(roleType, graduation, availability) {
  if (roleType === 'internship') {
    return mastersAllowed(roleType, availability)
      ? `say you are completing your bachelor's degree in ${graduation.month} with plans to begin a master's program in ${graduation.nextFall}`
      : `say you are completing your bachelor's degree in ${graduation.month}`;
  }
  return `state that your ${graduation.month} graduation falls inside the employer's start window, with no mention of further study`;
}

// Terms in a letter body that start before the owner can work; the graduation month itself is allowed.
export function availabilityConflicts(body, { availability, graduation, graduationDate = null }) {
  const earliest = earliestStart(availability, graduationDate);
  const graduationLabel = String(graduation.month || '').toLowerCase();
  return termMentions(body)
    .filter(term => term.text.toLowerCase() !== graduationLabel && before(term, earliest))
    .map(term => term.text);
}

const MASTERS_MENTION = /\bmaster'?s(?:\s+(?:program|programme|degree|studies))|\bgraduate\s+(?:school|program|programme|studies)\b/i;

export function mentionsMasters(body) {
  return MASTERS_MENTION.test(String(body || ''));
}

// The posting's own work term when it starts before the owner can work: the title, or a description sentence
// about the term or the start (sentences about graduation, enrollment, or the application process are ignored).
// Returns { term, source } or null.
const TERM_CONTEXT = /\b(?:start|starts|starting|begin|begins|beginning|term|session|semester|co-?op|internship|program runs|dates?|duration|period)\b/i;
const NOT_THE_TERM = /\b(?:graduat\w*|degree|enrolled|enrollment|class of|pursuing|completion|apply|applications?|recruit\w*|interview\w*|deadline|posted|review(?:ed|ing)?)\b/i;

export function postingTermConflict(job, { availability, graduationDate = null }) {
  const earliest = earliestStart(availability, graduationDate);
  const early = (text, source) => {
    const term = termMentions(text).filter(item => before(item, earliest)).sort((a, b) => a.year - b.year || a.month - b.month)[0];
    return term ? { term: term.text, source } : null;
  };
  const fromTitle = early(job?.title, 'title');
  if (fromTitle) return fromTitle;
  const sentences = String(job?.description || '').split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    if (!TERM_CONTEXT.test(sentence) || NOT_THE_TERM.test(sentence)) continue;
    const found = early(sentence, 'description');
    if (found) return found;
  }
  return null;
}

export function termConflictBadge(conflict, availability) {
  return {
    key: 'term-conflict', label: 'Term Conflict', tone: 'warn',
    title: `The posting's term (${conflict.term}, from the ${conflict.source}) starts before you are available (${availability.springTerm ? 'spring term allowed' : `full time from ${availability.fullTimeFrom}`}), so no letter is written automatically. You can still generate one.`,
  };
}

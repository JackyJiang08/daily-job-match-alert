// Evidence helpers for the v2 letter checks: the experiences a resume lists (employers and projects, read from
// the resume text itself, so no name is written in code), which of them a text mentions, and the numbers a
// letter may use (the selected resume, the playbook, and the posting), compared by value with the formats
// normalized: "500K+" = "500,000" = "more than 500,000", "$150,000+" = "150,000", "40%" = "40 percent".

// Words too common to identify an experience on their own.
const GENERIC = new Set(['International', 'Company', 'Corporation', 'Association', 'Professional', 'Financial', 'Group', 'Holdings', 'University',
  'World', 'Global', 'Agent', 'Daily', 'Data', 'Analytics', 'Platform', 'Industry', 'Research', 'Live', 'System', 'Systems', 'Services', 'Solutions',
  'Technologies', 'Technology', 'Labs', 'Intern', 'Internship', 'Project', 'Projects', 'Assistant', 'Engineer', 'Analyst', 'Model', 'Models', 'Inc',
  'LLC', 'PLC', 'Limited', 'Partners', 'Consulting', 'Management', 'Marketing', 'Strategy', 'Operations', 'Quantitative', 'Finance', 'Learning',
  'Machine', 'Deep', 'Large', 'Language', 'Workshop']);
const LEGAL = /,?\s+(?:Inc\.?|LLC|PLC|Ltd\.?|Limited|Company)$/i;
const DATE_TAIL = /\s{2,}(?:[A-Z][a-z]{2,8}\.?\s+\d{4}|\d{4}).*$/;

function cleanName(name) {
  return String(name || '').replace(DATE_TAIL, '').replace(LEGAL, '').replace(/\s+/g, ' ').trim();
}

function keysFor(name) {
  const keys = new Set([name]);
  for (const word of name.split(/[\s:&/,]+/)) {
    const bare = word.replace(/[^A-Za-z0-9'-]/g, '');
    if (bare.length >= 4 && /^[A-Z0-9]/.test(bare) && !GENERIC.has(bare)) keys.add(bare);
  }
  return [...keys];
}

// [{ name, kind: 'employer' | 'project', keys }] in resume order. Employers are "Employer | Role | Place"
// lines; projects are heading lines in a projects or research section ("Title (tools)  Aug 2026",
// "Title: subtitle | Role  ...").
export function resumeExperiences(text) {
  const found = [];
  const seen = new Set();
  let section = '';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^[A-Z][A-Z /&-]{3,}$/.test(line.trim())) { section = line.trim(); continue; }
    // Bullet lines start with spaces or a bullet glyph; headings start with a letter or a digit.
    if (!/^[A-Za-z0-9]/.test(line)) continue;
    let name = null;
    let kind = null;
    const employer = /^([^|]{2,80}?)\s+\|\s+[^|]+\|/.exec(line);
    if (employer && /EXPERIENCE/.test(section) && !/PROJECT|RESEARCH/.test(section)) { name = cleanName(employer[1]); kind = 'employer'; }
    else if (/PROJECT|RESEARCH/.test(section) && /\s{2,}\S|\(|\||:/.test(line) && /[A-Za-z]/.test(line)) {
      name = cleanName(line.split(/\s+\(|:\s|\s\|\s/)[0]);
      kind = 'project';
    }
    if (!name || name.length < 3 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    found.push({ name, kind, keys: keysFor(name) });
  }
  return found;
}

// Does the text mention the experience? The full name in any case, or a distinctive word as written.
export function mentionsExperience(text, experience) {
  const body = String(text || '');
  const lower = body.toLowerCase();
  return experience.keys.some((key, index) => {
    if (index === 0) return lower.includes(key.toLowerCase());
    return new RegExp(`(?<![A-Za-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(body);
  });
}

export function experiencesIn(text, experiences) {
  return experiences.filter(experience => mentionsExperience(text, experience)).map(experience => experience.name);
}

// ----------------------------------------------------------------------------------------------- numbers

// A number as written, with its unit: "$150K+", "500,000", "8.2", "40%". Numbers glued to letters or a hyphen
// before them ("GPT-4", "Qwen-2.5", "S3") are names, not quantities.
const NUMBER = /(?<![A-Za-z0-9.\-])\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s?[KkMm](?![A-Za-z]))?\+?|(?<![A-Za-z0-9.\-])\$?\d+(?:\.\d+)?(?:\s?[KkMm](?![A-Za-z]))?\+?/g;

export function normalizeNumber(raw) {
  let text = String(raw).replace(/[$+,\s]/g, '');
  let scale = 1;
  if (/[Kk]$/.test(text)) { scale = 1000; text = text.slice(0, -1); }
  else if (/[Mm]$/.test(text)) { scale = 1_000_000; text = text.slice(0, -1); }
  const value = Number(text) * scale;
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : null;
}

export function isYear(raw) {
  return /^(?:19|20)\d{2}$/.test(String(raw).trim());
}

// [{ raw, value, index }] for every quantity in the text (years excluded).
export function numberTokens(text) {
  const out = [];
  for (const match of String(text || '').matchAll(NUMBER)) {
    const raw = match[0].trim();
    if (isYear(raw)) continue;
    const value = normalizeNumber(raw);
    if (value != null) out.push({ raw, value, index: match.index });
  }
  return out;
}

export function numberWhitelist(...sources) {
  const values = new Set();
  for (const source of sources) for (const token of numberTokens(source)) values.add(token.value);
  return values;
}

// Numbers in the body that neither the sources nor the posting carry: [raw].
export function numbersOutside(body, whitelist, postingText = '') {
  const posting = numberWhitelist(postingText);
  return [...new Set(numberTokens(body).filter(token => !whitelist.has(token.value) && !posting.has(token.value)).map(token => token.raw))];
}

// Metric values the body states more than once: [{ raw, count }]. Small counts (12 and under, written without a
// unit) are left out: "three backends" and "10 node" are descriptions, not metrics.
export function repeatedMetrics(body, postingText = '') {
  const posting = numberWhitelist(postingText);
  const counts = new Map();
  for (const token of numberTokens(body)) {
    const plain = /^\d+$/.test(token.raw) && Number(token.raw) <= 12;
    if (plain || posting.has(token.value)) continue;
    const entry = counts.get(token.value) || { raw: token.raw, count: 0 };
    entry.count += 1;
    counts.set(token.value, entry);
  }
  return [...counts.values()].filter(entry => entry.count > 1);
}

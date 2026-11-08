// Title Case check for the hub and the report: the visible text of buttons, group names (summary, h1–h3),
// labels, table headers, definition terms, badges and tags. Short articles, conjunctions and prepositions
// stay lower case after the first word; proper nouns and abbreviations (PwC, JD, LinkedIn, iCloud) pass as
// they are because only a word that starts lower case with no capital in it is flagged.
const MINOR_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'in', 'of', 'on', 'to', 'via', 'per', 'vs', 'vs.']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', middot: '·', rarr: '→', hellip: '…' };

export function visibleText(html) {
  return String(html)
    .replace(/<(script|style|template|textarea|select)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (all, name) => ENTITIES[name] ?? (name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : all))
    .replace(/\s+/g, ' ')
    .trim();
}

// The words of `text` that break Title Case: a word that begins with a lower-case letter and has no capital
// in it, unless it is a minor word after the first.
export function titleCaseViolations(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const bad = [];
  let first = true;
  for (const raw of words) {
    const word = raw.replace(/^[("'“‘[]+/, '');
    if (!/^[a-z]/.test(word)) { if (/[A-Za-z0-9]/.test(word)) first = false; continue; }
    const bare = word.replace(/[)"'”’\].,:;!?…]+$/, '').toLowerCase();
    if (!first && MINOR_WORDS.has(bare)) continue;
    if (/[A-Z]/.test(word)) { first = false; continue; }
    bad.push(raw);
    first = false;
  }
  return bad;
}

const PATTERNS = [
  ['button', /<button\b[^>]*>([\s\S]*?)<\/button>/gi],
  ['link button', /<a\b[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi],
  ['summary', /<summary\b[^>]*>([\s\S]*?)<\/summary>/gi],
  ['heading', /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi],
  ['table header', /<th\b[^>]*>([\s\S]*?)<\/th>/gi],
  ['term', /<dt\b[^>]*>([\s\S]*?)<\/dt>/gi],
  ['legend', /<legend\b[^>]*>([\s\S]*?)<\/legend>/gi],
  ['badge', /<span\b[^>]*class="[^"]*\b(?:badge|tag)\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi],
  ['label', /<label\b[^>]*>([\s\S]*?)<\/label>/gi],
  ['bold label', /<b>([^<]*)<\/b>/gi],
];

// The name part of an element: a nested hint (muted text, a paragraph, a form control) and anything after
// a colon, a dash or a sentence end is prose, not part of the name.
const HINT = /<(?:span\b[^>]*class="[^"]*\b(?:muted|hint|note|sub|count|file-name)\b|small\b|code\b|p\b|div\b|br\b|input\b|select\b|textarea\b|label\b)/i;
function nameText(inner) {
  return visibleText(String(inner).replace(/^\s*<input\b[^>]*>/i, '').split(HINT)[0]).split(/\s[—–-]\s|:\s|\.\s|;\s|\s\(/)[0];
}

export function scanTitleCase(html) {
  const found = [];
  const source = String(html).replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ');
  for (const [kind, pattern] of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const text = nameText(match[1]);
      if (!text) continue;
      const bad = titleCaseViolations(text);
      if (bad.length) found.push({ kind, text, bad });
    }
  }
  return found;
}

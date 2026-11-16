// Where a needs-review editor note belongs in the letter body, for the letter page's underlines. A note points
// at text in a few recurring shapes: a quoted phrase ('The number "40%" does not appear …'), "unverified detail:
// <phrase>", "salutation says A, body says B" (B is in the body), or a bare number ("The number 12 …"). Each
// candidate phrase is looked up in the body's sentences, longest first; a long "unverified detail" phrase that
// is not verbatim falls back to the sentence sharing most of its words. A note no sentence matches is returned
// in `unplaced` (the page shows it in one line above the letter). Only needs-review notes are passed in.

const WORD = /[a-z0-9%$]+(?:['’][a-z]+)?/gi;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'that', 'this', 'is', 'was', 'as', 'it', 'my', 'i']);
const FUZZY_MIN_WORDS = 3;
const FUZZY_SHARE = 0.6;

// A paragraph's sentences, split after . ! ? followed by a space; joined with one space they give the
// paragraph back (bodies are stored with single spaces).
export function splitSentences(paragraph) {
  return String(paragraph || '').split(/(?<=[.!?]["”’)]?)\s+(?=["“(]?[A-Z0-9$])/).filter(Boolean);
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

// Candidate phrases a note points at, longest first.
export function notePhrases(note) {
  const text = String(note || '');
  const found = [];
  for (const match of text.matchAll(/"([^"]{2,200})"|“([^”]{2,200})”/g)) found.push(match[1] || match[2]);
  const detail = /^\s*unverified detail\s*:\s*(.+)$/i.exec(text);
  if (detail) found.push(detail[1].replace(/[.;]\s*$/, '').replace(/^(?:the )?(?:claim|statement|mention|line) that\s+/i, ''));
  const body = /\bbody says\s+(.+?)\s*\.?$/i.exec(text);
  if (body) found.push(body[1]);
  const number = /\bnumber(?:s)?\s+([$]?\d[\d,.]*(?:%|\+|k\b|m\b)?)/i.exec(text);
  if (number) found.push(number[1].replace(/[.,]$/, ''));
  return [...new Set(found.map(item => item.trim().replace(/[,;:.]+$/, '')).filter(item => item.length >= 2))].sort((a, b) => b.length - a.length);
}

function contentWords(text) {
  return (normalize(text).match(WORD) || []).filter(word => !STOP.has(word));
}

// { marks: Map<"p:s", string[]> (paragraph index : sentence index → notes), unplaced: string[] }
export function placeNotes(paragraphs, notes) {
  const sentences = [];
  (paragraphs || []).forEach((paragraph, p) => splitSentences(paragraph).forEach((sentence, s) => sentences.push({ key: `${p}:${s}`, text: normalize(sentence), words: new Set(contentWords(sentence)) })));
  const marks = new Map();
  const unplaced = [];
  for (const note of notes || []) {
    let hit = null;
    for (const phrase of notePhrases(note)) {
      const needle = normalize(phrase);
      // A short number ("12") must stand alone, not inside "2012" or "12.5".
      const pattern = /^[$]?\d[\d,.]*[%+km]?$/i.test(needle) ? new RegExp(`(^|[^\\d.,])${needle.replace(/[$.+]/g, '\\$&')}(?![\\d])`, 'i') : null;
      hit = sentences.find(sentence => (pattern ? pattern.test(sentence.text) : sentence.text.includes(needle)));
      if (hit) break;
      const words = contentWords(phrase);
      if (words.length >= FUZZY_MIN_WORDS) {
        let best = null;
        for (const sentence of sentences) {
          const share = words.filter(word => sentence.words.has(word)).length / words.length;
          if (share >= FUZZY_SHARE && (!best || share > best.share)) best = { sentence, share };
        }
        if (best) { hit = best.sentence; break; }
      }
    }
    if (hit) marks.set(hit.key, [...(marks.get(hit.key) || []), note]);
    else unplaced.push(note);
  }
  return { marks, unplaced };
}

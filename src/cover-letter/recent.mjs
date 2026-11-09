// What the letters of the trailing days have in common (2026-11-08, v2 rules): the share of the most used
// opening (first six words of the first sentence) and closing (first sentence of the last paragraph), the
// share of "I am writing to" openings, and how often each resume experience appears. Nothing fails on these:
// the next letter's prompt is told which openings, closings, and experiences to avoid, and Status shows the
// two repetition rates.
import { mentionsExperience } from './evidence.mjs';

export const RECENT_DAYS = 7;
export const REPEAT_LIMIT = 0.15;
export const EXPERIENCE_LIMIT = 0.6;
// Letters written within this many hours count as one night's batch: each later letter is told the earlier
// ones' opening and closing so that letters written together do not share them (2026-11-09).
export const BATCH_HOURS = 12;
// The thank-you sentence that opens the closing paragraph rotates through these; one is assigned per letter, and a
// sentence used by more than CLOSING_LIMIT of the last 7 days' letters, or already used tonight, is not assigned.
export const CLOSING_LIMIT = 0.3;
export const THANK_YOU_SENTENCES = [
  'Thank you for your consideration.',
  'Thank you for reading my application.',
  'I appreciate your time and consideration.',
  'Thank you for taking the time to review my application.',
  'I am grateful for your time and attention.',
  'Thank you for reviewing my materials.',
];
export const WRITING_TO = /^\s*I am writing to\b/i;

function firstSentence(text) {
  return (String(text || '').match(/^.*?[.!?](?=\s|$)/) || [String(text || '')])[0].trim();
}

export function closingKey(text) {
  return key(text);
}

function key(text) {
  return String(text || '').toLowerCase().replace(/[“”"'’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// "I am writing to apply for" (as written) and its comparison key.
export function openingOf(paragraphs) {
  const words = firstSentence((paragraphs || [])[0]).split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  return { text: words, key: key(words) };
}

export function closingOf(paragraphs) {
  const sentence = firstSentence((paragraphs || []).at(-1));
  return { text: sentence, key: key(sentence) };
}

function shares(items, total) {
  const groups = new Map();
  for (const item of items) {
    if (!item.key) continue;
    const entry = groups.get(item.key) || { text: item.text, count: 0 };
    entry.count += 1;
    groups.set(item.key, entry);
  }
  return [...groups.values()].map(entry => ({ ...entry, share: total ? entry.count / total : 0 })).sort((a, b) => b.count - a.count);
}

// letters: saved letter records ({ paragraphs, createdAt|savedAt }); experiences: resumeExperiences() entries.
export function recentLetterStats(letters, { now = new Date(), days = RECENT_DAYS, experiences = [] } = {}) {
  const since = now.getTime() - days * 86_400_000;
  const recent = (letters || []).filter(letter => {
    const at = Date.parse(letter.createdAt || letter.savedAt || '');
    return Number.isFinite(at) && at >= since && at <= now.getTime() + 60_000 && Array.isArray(letter.paragraphs) && letter.paragraphs.length;
  });
  const total = recent.length;
  const openings = shares(recent.map(letter => openingOf(letter.paragraphs)), total);
  const closings = shares(recent.map(letter => closingOf(letter.paragraphs)), total);
  const writingTo = recent.filter(letter => WRITING_TO.test(letter.paragraphs[0] || '')).length;
  const experienceShares = experiences.map(experience => {
    const count = recent.filter(letter => mentionsExperience(letter.paragraphs.join(' '), experience)).length;
    return { name: experience.name, count, share: total ? count / total : 0 };
  }).sort((a, b) => b.count - a.count);
  return {
    days, total,
    openings, closings,
    topOpening: openings[0] || null,
    topClosing: closings[0] || null,
    writingToShare: total ? writingTo / total : 0,
    overusedOpenings: openings.filter(entry => entry.share > REPEAT_LIMIT),
    overusedClosings: closings.filter(entry => entry.share > REPEAT_LIMIT),
    overusedExperiences: experienceShares.filter(entry => entry.share > EXPERIENCE_LIMIT),
    experienceShares,
  };
}

export function percent(share) {
  return `${Math.round((share || 0) * 100)}%`;
}

function createdAt(letter) {
  return Date.parse(letter?.createdAt || letter?.savedAt || '');
}

function words(text) {
  return String(text || '').toLowerCase().replace(/[“”"'’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
}

// The construction of a letter's first sentence with the posting's own words masked: the words of the job title
// and the company become "*" (runs collapse), so "The Data Analyst role at Acme in…" and "The Machine Learning
// Intern role at Initech…" share the shape "the * role at * in".
export function openingShape(paragraphs, { title = '', company = '' } = {}) {
  const masked = new Set([...words(title), ...words(company)].filter(word => word.length > 2 || /\d/.test(word)));
  const shape = [];
  for (const word of words(firstSentence((paragraphs || [])[0]))) {
    const token = masked.has(word) ? '*' : word;
    if (token === '*' && shape.at(-1) === '*') continue;
    shape.push(token);
    if (shape.length >= 5) break;
  }
  return shape.join(' ');
}

function shapeFields(letter) {
  return { title: letter.jobTitle || letter.job?.title || '', company: [letter.company, letter.fullName, letter.job?.company].filter(Boolean).join(' ') };
}

// The letters written in the last BATCH_HOURS (tonight's batch), excluding the posting being written, and what
// the next letter must not repeat: their first sentences (with shapes) and their closing paragraphs.
export function batchAvoid(letters, { now = new Date(), hours = BATCH_HOURS, jobId = null } = {}) {
  const since = now.getTime() - hours * 3_600_000;
  const batch = (letters || []).filter(letter => {
    const at = createdAt(letter);
    return Number.isFinite(at) && at >= since && at <= now.getTime() + 60_000 && Array.isArray(letter.paragraphs) && letter.paragraphs.length && (!jobId || letter.jobId !== jobId);
  }).sort((a, b) => createdAt(a) - createdAt(b));
  return {
    hours,
    openings: batch.map(letter => ({ text: firstSentence(letter.paragraphs[0]), shape: openingShape(letter.paragraphs, shapeFields(letter)), company: letter.company || '' })),
    closings: batch.map(letter => ({ text: String(letter.paragraphs.at(-1) || '').trim(), sentence: closingOf(letter.paragraphs).text, company: letter.company || '' })),
  };
}

// The thank-you sentence for the next letter: one not used tonight and used by at most CLOSING_LIMIT of the last
// 7 days' letters, the least used first (ties in list order, starting after the last one used). Falls back to
// the least used sentence under the limit, then to the least used overall.
export function pickClosing({ recent = [], batch = { closings: [] }, sentences = THANK_YOU_SENTENCES, now = new Date(), days = RECENT_DAYS } = {}) {
  const since = now.getTime() - days * 86_400_000;
  const window = (recent || []).filter(letter => {
    const at = createdAt(letter);
    return Number.isFinite(at) && at >= since && at <= now.getTime() + 60_000 && Array.isArray(letter.paragraphs) && letter.paragraphs.length;
  });
  const total = window.length;
  const counts = sentences.map(sentence => {
    const target = key(sentence);
    const count = window.filter(letter => closingOf(letter.paragraphs).key === target).length;
    return { text: sentence, count, share: total ? count / total : 0 };
  });
  const tonight = new Set((batch?.closings || []).map(entry => key(entry.sentence || firstSentence(entry.text))));
  const latest = window.slice().sort((a, b) => createdAt(b) - createdAt(a))[0];
  const lastIndex = latest ? sentences.findIndex(sentence => key(sentence) === closingOf(latest.paragraphs).key) : -1;
  const order = counts.map((entry, index) => ({ ...entry, rank: (index - lastIndex - 1 + sentences.length) % sentences.length }));
  const best = list => list.slice().sort((a, b) => a.count - b.count || a.rank - b.rank)[0] || null;
  const pick = best(order.filter(entry => !tonight.has(key(entry.text)) && entry.share <= CLOSING_LIMIT))
    || best(order.filter(entry => entry.share <= CLOSING_LIMIT))
    || best(order);
  return { sentence: pick.text, shares: counts, total };
}

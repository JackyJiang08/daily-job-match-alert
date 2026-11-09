// What the letters of the trailing days have in common (2026-11-08, v2 rules): the share of the most used
// opening (first six words of the first sentence) and closing (first sentence of the last paragraph), the
// share of "I am writing to" openings, and how often each resume experience appears. Nothing fails on these:
// the next letter's prompt is told which openings, closings, and experiences to avoid, and Status shows the
// two repetition rates.
import { mentionsExperience } from './evidence.mjs';

export const RECENT_DAYS = 7;
export const REPEAT_LIMIT = 0.15;
export const EXPERIENCE_LIMIT = 0.6;
export const WRITING_TO = /^\s*I am writing to\b/i;

function firstSentence(text) {
  return (String(text || '').match(/^.*?[.!?](?=\s|$)/) || [String(text || '')])[0].trim();
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

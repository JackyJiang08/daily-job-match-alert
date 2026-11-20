// The example numbers the letter prompts show (2026-11-19): how a GPA is written, numbers in prose, and which
// values count as the same. The code carries made-up numbers; an owner who wants their own puts them in the
// optional private/cover-letter/prompt-examples.json (every field optional, a missing one keeps the generic):
//   { "gpa": "3.8",
//     "proseNumbers": ["12 percent", "at least 90 percent", "a factor of 3", "cut runtime by 40 percent"],
//     "sameValue": ["10K+", "10,000"], "differentValue": ["0.75", "0.756"] }
// npm run setup does not create the file.
import fs from 'node:fs/promises';
import path from 'node:path';

export const PROMPT_EXAMPLES_FILE = path.join('private', 'cover-letter', 'prompt-examples.json');

export const GENERIC_PROMPT_EXAMPLES = Object.freeze({
  gpa: '3.8',
  proseNumbers: Object.freeze(['12 percent', 'at least 90 percent', 'a factor of 3', 'cut runtime by 40 percent']),
  sameValue: Object.freeze(['10K+', '10,000']),
  differentValue: Object.freeze(['0.75', '0.756']),
});

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const list = (value, length = null) => (Array.isArray(value) && value.length && value.every(text) && (length == null || value.length === length) ? value.map(item => item.trim()) : null);

// Fills every missing or malformed field from the generic examples.
export function normalizePromptExamples(raw = null) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    gpa: text(value.gpa) || GENERIC_PROMPT_EXAMPLES.gpa,
    proseNumbers: list(value.proseNumbers) || [...GENERIC_PROMPT_EXAMPLES.proseNumbers],
    sameValue: list(value.sameValue, 2) || [...GENERIC_PROMPT_EXAMPLES.sameValue],
    differentValue: list(value.differentValue, 2) || [...GENERIC_PROMPT_EXAMPLES.differentValue],
  };
}

// The examples for a project root: the private file when it exists and parses, otherwise the generic ones.
export async function loadPromptExamples(root, io = fs) {
  if (!root) return normalizePromptExamples();
  const raw = await io.readFile(path.join(root, PROMPT_EXAMPLES_FILE), 'utf8').catch(() => null);
  if (raw == null) return normalizePromptExamples();
  try {
    return normalizePromptExamples(JSON.parse(raw));
  } catch {
    return normalizePromptExamples();
  }
}

const quoted = items => items.map(item => `"${item}"`).join(', ');

// 'State the GPA as "with a 3.8 GPA" (...), never as "3.8/4.00" or "3.8 out of 4.0".'
export function gpaRule(examples) {
  const { gpa } = normalizePromptExamples(examples);
  return `State the GPA as "with a ${gpa} GPA" (the number exactly as the RESUME or PLAYBOOK gives it), never as "${gpa}/4.00" or "${gpa} out of 4.0".`;
}

// '"12 percent", "at least 90 percent", ...'
export function proseNumberExamples(examples) {
  return quoted(normalizePromptExamples(examples).proseNumbers);
}

// '(10K+ and 10,000 match; 0.75 and 0.756 do not)'
export function sameValueExample(examples) {
  const { sameValue, differentValue } = normalizePromptExamples(examples);
  return `(${sameValue[0]} and ${sameValue[1]} match; ${differentValue[0]} and ${differentValue[1]} do not)`;
}

// The Reach Out panel's state, per posting (by job id, so a posting keeps it across report dates):
// private/outreach/state.json (gitignored with the rest of private/). Written atomically.
//   { version: 1, updatedAt, jobs: { <jobId>: { firstName, contactedAt, appliedAt, messages: { connectionNote,
//     followUpMessage, limit, source: 'letter' | 'panel', generatedAt }, candidates: { at, provider, status,
//     results: [{ name, headline, url }] } } } }
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../json-file.mjs';
import { formatLocalDay } from '../time-format.mjs';

export function outreachPath(root) {
  return path.join(root, 'private', 'outreach', 'state.json');
}

export async function readOutreach(root, io = fs) {
  try {
    const raw = JSON.parse(await io.readFile(outreachPath(root), 'utf8'));
    return raw && typeof raw === 'object' && raw.jobs && typeof raw.jobs === 'object' ? raw : { version: 1, jobs: {} };
  } catch {
    return { version: 1, jobs: {} };
  }
}

// Applies `change(entry)` to one posting's entry and saves the file; returns the entry.
export async function updateOutreach(root, jobId, change, { io = fs, now = new Date() } = {}) {
  const key = String(jobId || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) throw new Error('Unknown posting');
  const state = await readOutreach(root, io);
  const entry = state.jobs[key] && typeof state.jobs[key] === 'object' ? state.jobs[key] : {};
  change(entry);
  state.jobs[key] = entry;
  state.updatedAt = now.toISOString();
  await io.mkdir(path.dirname(outreachPath(root)), { recursive: true });
  await writeJsonAtomic(outreachPath(root), state, { io, mode: 0o600 });
  return entry;
}

export async function saveOutreachMessages(root, jobId, messages, { io = fs, now = new Date(), source = 'letter' } = {}) {
  if (!messages?.connectionNote && !messages?.followUpMessage) return null;
  return updateOutreach(root, jobId, entry => {
    entry.messages = { connectionNote: messages.connectionNote || '', followUpMessage: messages.followUpMessage || '', limit: messages.limit || null, source, generatedAt: now.toISOString() };
  }, { io, now });
}

// "Contacted Nov 8", or null.
export function contactedLabel(entry, timeZone) {
  return entry?.contactedAt ? `Contacted ${formatLocalDay(entry.contactedAt, timeZone)}` : null;
}

// "Applied Nov 8" (the card's Mark as Applied button once pressed), or null.
export function appliedLabel(entry, timeZone) {
  return entry?.appliedAt ? `Applied ${formatLocalDay(entry.appliedAt, timeZone)}` : null;
}

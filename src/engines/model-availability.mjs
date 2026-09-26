// Which Claude models the current plan cannot use, learned from refusals rather than from a plan → model
// table: a "not available on your plan" answer marks the model with the plan it was seen on. The mark is
// skipped by the pipeline and the hub until the plan changes or seven days pass, then tried once more.
// Stored in state/model-availability.json; the hub writes it under the run lock.
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeModelName } from './shared.mjs';

export const RETRY_AFTER_DAYS = 7;

// Marks are keyed by model family so "claude-fable-5", "claude-fable-5[1m]", and the alias "fable" meet.
export function modelKey(value) {
  const name = normalizeModelName(value);
  const family = /^(?:claude-)?(fable|opus|sonnet|haiku)(?:-[\d.-]+)?$/.exec(name);
  return family ? family[1] : name;
}

export function availabilityPath(root) {
  return path.join(root, 'state', 'model-availability.json');
}

export function normalizeAvailability(raw) {
  const models = {};
  const source = raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object' ? raw.models : {};
  for (const [key, entry] of Object.entries(source)) {
    const name = modelKey(entry?.model || key);
    const stamp = entry?.detectedAt ? new Date(entry.detectedAt) : null;
    if (!name || !stamp || Number.isNaN(stamp.getTime())) continue;
    models[name] = { model: name, plan: entry?.plan ? String(entry.plan).toLowerCase() : null, detectedAt: stamp.toISOString(), notice: entry?.notice ? String(entry.notice).slice(0, 200) : null };
  }
  return { version: 1, models };
}

export async function readAvailability(file, io = fs) {
  try { return normalizeAvailability(JSON.parse(await io.readFile(file, 'utf8'))); } catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return normalizeAvailability(null); throw error; }
}

export async function writeAvailability(file, record, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true });
  await io.writeFile(file, `${JSON.stringify(normalizeAvailability(record), null, 2)}\n`);
}

export function markModelUnavailable(record, model, { plan = null, at = new Date().toISOString(), notice = null } = {}) {
  const name = modelKey(model);
  if (!name) return record;
  record.models[name] = { model: name, plan: plan ? String(plan).toLowerCase() : null, detectedAt: at, notice: notice ? String(notice).slice(0, 200) : null };
  return record;
}

// Drops marks that no longer apply: the plan changed, or the retry window passed (one fresh try; a new
// refusal marks the model again). Returns what was dropped and why.
export function pruneAvailability(record, { now = new Date(), plan = null, retryAfterDays = RETRY_AFTER_DAYS } = {}) {
  const removed = [];
  const cutoff = now.getTime() - Number(retryAfterDays) * 24 * 60 * 60 * 1000;
  for (const [name, entry] of Object.entries(record.models)) {
    const stamp = entry?.detectedAt ? new Date(entry.detectedAt).getTime() : Number.NaN;
    if (plan && entry?.plan && String(entry.plan).toLowerCase() !== String(plan).toLowerCase()) { removed.push({ model: name, reason: `plan changed to ${String(plan).toLowerCase()}` }); delete record.models[name]; continue; }
    if (!Number.isFinite(stamp) || stamp <= cutoff) { removed.push({ model: name, reason: 'retry after 7 days' }); delete record.models[name]; }
  }
  return removed;
}

export function unavailableModelNames(record) {
  return Object.keys(record?.models || {});
}

// The first model, starting at `preferred` and walking down the ladder, that is not marked unavailable;
// `preferred` itself when every step is marked (the call will fail and re-mark it, which is the retry).
export function firstAvailableModel(preferred, ladder, unavailable) {
  const skip = new Set([...(unavailable || [])].map(modelKey));
  const start = normalizeModelName(preferred);
  if (!skip.has(modelKey(start))) return start;
  const steps = (ladder || []).map(normalizeModelName);
  const index = steps.indexOf(start);
  for (const candidate of index >= 0 ? steps.slice(index + 1) : steps) if (!skip.has(modelKey(candidate))) return candidate;
  return start;
}

// The next ladder step after `model` that is not marked unavailable, or null.
export function nextAvailableModel(ladder, model, unavailable) {
  const skip = new Set([...(unavailable || [])].map(modelKey));
  const steps = (ladder || []).map(normalizeModelName);
  const index = steps.findIndex(step => modelKey(step) === modelKey(model));
  for (const candidate of steps.slice(index + 1)) if (!skip.has(modelKey(candidate))) return candidate;
  return null;
}

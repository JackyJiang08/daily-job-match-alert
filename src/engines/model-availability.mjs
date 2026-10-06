// Which Claude models the current plan cannot use, learned from refusals rather than from a plan → model
// table: a "not available on your plan" answer marks the model with the plan it was seen on. The mark is
// skipped by the pipeline and the hub until the plan changes or seven days pass, then tried once more.
// Stored in state/model-availability.json; the hub writes it under the run lock.
import { DEFAULT_CATALOG, findModel } from './catalog.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeModelName } from './shared.mjs';

export const RETRY_AFTER_DAYS = 7;

// Marks are keyed by the registry id, so "claude-fable-5-1", "claude-fable-5-1[1m]", a dated variant, and
// the alias "fable" meet; a name outside the registry keys as itself.
export function modelKey(value) {
  const name = normalizeModelName(value);
  return findModel(DEFAULT_CATALOG, name)?.id || name;
}

export function availabilityPath(root) {
  return path.join(root, 'state', 'model-availability.json');
}

// The record (version 2):
//   models  marks the skip logic honours: kind 'not_on_plan' (the plan does not include the model) or
//           'unknown_model' (the CLI does not know the id, or the account type cannot use it); cleared by a
//           plan change, after 7 days, by Re-check Models, or by a successful call.
//   limits  weekly-limit records { model, at, resetsAt }: shown on the Settings badge only (the ladder
//           already steps down per call); they clear at resetsAt, or 7 days after `at` when the CLI gave
//           no reset time, or on a successful call.
//   seen    per model { resolvedId, lastUsedAt }: the id the CLI actually reported on its last successful
//           call; "Available" means a successful call happened.
// Version 1 files (models only) load unchanged.
export const MARK_KINDS = ['not_on_plan', 'unknown_model'];

function stampOf(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function normalizeAvailability(raw) {
  const models = {};
  const limits = {};
  const seen = {};
  const source = raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object' ? raw.models : {};
  for (const [key, entry] of Object.entries(source)) {
    const name = modelKey(entry?.model || key);
    const detectedAt = stampOf(entry?.detectedAt);
    if (!name || !detectedAt) continue;
    models[name] = { model: name, plan: entry?.plan ? String(entry.plan).toLowerCase() : null, detectedAt, notice: entry?.notice ? String(entry.notice).slice(0, 200) : null, kind: MARK_KINDS.includes(entry?.kind) ? entry.kind : 'not_on_plan' };
  }
  for (const [key, entry] of Object.entries(raw?.limits && typeof raw.limits === 'object' ? raw.limits : {})) {
    const name = modelKey(entry?.model || key);
    const at = stampOf(entry?.at);
    if (!name || !at) continue;
    limits[name] = { model: name, kind: 'weekly_limit', at, resetsAt: stampOf(entry?.resetsAt), notice: entry?.notice ? String(entry.notice).slice(0, 200) : null };
  }
  for (const [key, entry] of Object.entries(raw?.seen && typeof raw.seen === 'object' ? raw.seen : {})) {
    const name = modelKey(key);
    const lastUsedAt = stampOf(entry?.lastUsedAt);
    if (!name || !lastUsedAt) continue;
    seen[name] = { resolvedId: entry?.resolvedId ? String(entry.resolvedId).slice(0, 80) : null, lastUsedAt };
  }
  return { version: 2, models, limits, seen };
}

export async function readAvailability(file, io = fs) {
  try { return normalizeAvailability(JSON.parse(await io.readFile(file, 'utf8'))); } catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return normalizeAvailability(null); throw error; }
}

export async function writeAvailability(file, record, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true });
  await io.writeFile(file, `${JSON.stringify(normalizeAvailability(record), null, 2)}\n`);
}

export function markModelUnavailable(record, model, { plan = null, at = new Date().toISOString(), notice = null, kind = 'not_on_plan' } = {}) {
  const name = modelKey(model);
  if (!name) return record;
  record.models[name] = { model: name, plan: plan ? String(plan).toLowerCase() : null, detectedAt: at, notice: notice ? String(notice).slice(0, 200) : null, kind: MARK_KINDS.includes(kind) ? kind : 'not_on_plan' };
  return record;
}

// A weekly limit the CLI reported for a model; shown as "Weekly limit until <reset>" on Settings.
export function markWeeklyLimit(record, model, { at = new Date().toISOString(), resetsAt = null, notice = null } = {}) {
  const name = modelKey(model);
  if (!name) return record;
  record.limits ||= {};
  record.limits[name] = { model: name, kind: 'weekly_limit', at, resetsAt: stampOf(resetsAt), notice: notice ? String(notice).slice(0, 200) : null };
  return record;
}

// A successful call: the model is available, the id the CLI reported is remembered, and any mark or limit
// on it is cleared (the call itself proved them stale).
export function markModelUsed(record, model, { resolvedId = null, at = new Date().toISOString() } = {}) {
  const name = modelKey(model);
  if (!name) return record;
  record.seen ||= {};
  record.seen[name] = { resolvedId: resolvedId ? String(resolvedId).slice(0, 80) : (record.seen[name]?.resolvedId || null), lastUsedAt: at };
  delete record.models[name];
  if (record.limits) delete record.limits[name];
  return record;
}

// Weekly limits clear at their reset time, or 7 days after they were seen when no reset time was given.
export function pruneLimits(record, { now = new Date(), retryAfterDays = RETRY_AFTER_DAYS } = {}) {
  const removed = [];
  for (const [name, entry] of Object.entries(record.limits || {})) {
    const resets = entry.resetsAt ? new Date(entry.resetsAt).getTime() : new Date(entry.at).getTime() + Number(retryAfterDays) * 86_400_000;
    if (!Number.isFinite(resets) || resets <= now.getTime()) { removed.push({ model: name, reason: 'weekly limit reset' }); delete record.limits[name]; }
  }
  return removed;
}

// The badge a model gets on Settings: unknown_model > not_on_plan > weekly_limit > available > not_verified.
export function modelStatus(record, model, { now = new Date() } = {}) {
  const name = modelKey(model);
  const mark = record?.models?.[name];
  const limit = record?.limits?.[name];
  const seen = record?.seen?.[name] || null;
  const base = { resolvedId: seen?.resolvedId || null, lastUsedAt: seen?.lastUsedAt || null };
  if (mark?.kind === 'unknown_model') return { ...base, state: 'unknown_model', at: mark.detectedAt, notice: mark.notice, plan: mark.plan };
  if (mark) return { ...base, state: 'not_on_plan', at: mark.detectedAt, notice: mark.notice, plan: mark.plan };
  if (limit) {
    const resets = limit.resetsAt ? new Date(limit.resetsAt).getTime() : null;
    if (resets == null || resets > now.getTime()) return { ...base, state: 'weekly_limit', at: limit.at, resetsAt: limit.resetsAt, notice: limit.notice };
  }
  if (seen) return { ...base, state: 'available' };
  return { ...base, state: 'not_verified' };
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

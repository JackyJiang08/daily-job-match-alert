// Which Claude models the current plan cannot use, learned from refusals rather than from a plan → model
// table: a "not available on your plan" answer marks the model with the plan it was seen on. The mark is
// skipped by the pipeline and the hub until the plan changes or seven days pass, then tried once more.
// Stored in state/model-availability.json; the hub writes it under the run lock.
import { DEFAULT_CATALOG, findModel } from './catalog.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeModelName } from './shared.mjs';
import { localDate, zonedInstant } from '../time-format.mjs';

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
//   limits  weekly-limit records { model, at, resetsAt }: resetsAt is only ever the time the CLI itself
//           gave, never an estimate. A limit is held until that time; without one, until the owner's
//           weekly reset (config.plans.claude.weeklyReset { day, time }, set in Settings) that follows
//           `at`; without that, for 24 hours, after which the next run tries the preferred model once
//           more. A successful call clears it. Older records whose resetsAt was a 7-day estimate (exactly
//           `at` + 7 days) lose that estimate when they are read.
//   seen    per model { resolvedId, lastUsedAt }: the id the CLI actually reported on its last successful
//           call; "Available" means a successful call happened.
// Version 1 files (models only) load unchanged.
export const MARK_KINDS = ['not_on_plan', 'unknown_model'];
export const LIMIT_HOLD_HOURS = 24;
// A nightly run that starts this close to the end of a 24-hour hold already retries the model, so a limit
// met at 20:05 is tried again by the next 20:00 run.
export const HOLD_GRACE_MS = 2 * 60 * 60 * 1000;
const ESTIMATED_RESET_MS = 7 * 24 * 60 * 60 * 1000;
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const WEEKDAY_LABELS = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

// { day: 'thu', time: '17:00' } from config.plans.claude.weeklyReset, or null.
export function weeklyResetOf(config = {}) {
  const raw = config?.plans?.claude?.weeklyReset;
  const day = String(raw?.day || '').slice(0, 3).toLowerCase();
  const time = String(raw?.time || '');
  return WEEKDAYS.includes(day) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? { day, time } : null;
}

// The first weekly reset strictly after `after`, in the zone.
export function nextWeeklyReset(after, weeklyReset, timeZone = 'America/Chicago') {
  const start = new Date(after);
  if (!weeklyReset || Number.isNaN(start.getTime())) return null;
  const [hour, minute] = weeklyReset.time.split(':').map(Number);
  for (let offset = 0; offset <= 8; offset += 1) {
    const [year, month, day] = localDate(new Date(start.getTime() + offset * 86_400_000), timeZone).split('-').map(Number);
    if (WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] !== weeklyReset.day) continue;
    const instant = zonedInstant(year, month, day, hour, minute, timeZone);
    if (instant.getTime() > start.getTime()) return instant.toISOString();
  }
  return null;
}

// How long a weekly limit is held: { until, source: 'cli' | 'weekly_reset' | 'hold' }.
export function limitHold(entry, { weeklyReset = null, timeZone = 'America/Chicago' } = {}) {
  if (entry?.resetsAt) return { until: entry.resetsAt, source: 'cli' };
  const weekly = weeklyReset ? nextWeeklyReset(entry?.at, weeklyReset, timeZone) : null;
  if (weekly) return { until: weekly, source: 'weekly_reset' };
  const at = new Date(entry?.at).getTime();
  return { until: Number.isFinite(at) ? new Date(at + LIMIT_HOLD_HOURS * 3_600_000).toISOString() : null, source: 'hold' };
}

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
    let resetsAt = stampOf(entry?.resetsAt);
    // Migration: a reset exactly seven days after the limit was an estimate the CLI never gave.
    if (resetsAt && !entry?.resetFromCli && Math.abs(new Date(resetsAt).getTime() - new Date(at).getTime() - ESTIMATED_RESET_MS) < 60_000) resetsAt = null;
    limits[name] = { model: name, kind: 'weekly_limit', at, resetsAt, resetFromCli: Boolean(resetsAt), notice: entry?.notice ? String(entry.notice).slice(0, 200) : null };
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
  record.limits[name] = { model: name, kind: 'weekly_limit', at, resetsAt: stampOf(resetsAt), resetFromCli: Boolean(stampOf(resetsAt)), notice: notice ? String(notice).slice(0, 200) : null };
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

// Weekly limits clear when their hold ends (limitHold); a 24-hour hold with no reset time ends
// `graceMs` early, so the next nightly run asks the preferred model again.
export function pruneLimits(record, { now = new Date(), weeklyReset = null, timeZone = 'America/Chicago', graceMs = 0 } = {}) {
  const removed = [];
  for (const [name, entry] of Object.entries(record.limits || {})) {
    const hold = limitHold(entry, { weeklyReset, timeZone });
    const ends = new Date(hold.until).getTime() - (hold.source === 'hold' ? Number(graceMs) || 0 : 0);
    if (!Number.isFinite(ends) || ends <= now.getTime()) { removed.push({ model: name, reason: hold.source === 'hold' ? 'no reset time given; trying again' : 'weekly limit reset' }); delete record.limits[name]; }
  }
  return removed;
}

// The badge a model gets on Settings: unknown_model > not_on_plan > weekly_limit > available > not_verified.
export function modelStatus(record, model, { now = new Date(), weeklyReset = null, timeZone = 'America/Chicago' } = {}) {
  const name = modelKey(model);
  const mark = record?.models?.[name];
  const limit = record?.limits?.[name];
  const seen = record?.seen?.[name] || null;
  const base = { resolvedId: seen?.resolvedId || null, lastUsedAt: seen?.lastUsedAt || null };
  if (mark?.kind === 'unknown_model') return { ...base, state: 'unknown_model', at: mark.detectedAt, notice: mark.notice, plan: mark.plan };
  if (mark) return { ...base, state: 'not_on_plan', at: mark.detectedAt, notice: mark.notice, plan: mark.plan };
  if (limit) {
    const hold = limitHold(limit, { weeklyReset, timeZone });
    const ends = new Date(hold.until).getTime();
    // resetsAt is shown only when it is the CLI's time or the owner's weekly reset, never an estimate.
    if (!Number.isFinite(ends) || ends > now.getTime()) return { ...base, state: 'weekly_limit', at: limit.at, resetsAt: hold.source === 'hold' ? null : hold.until, resetSource: hold.source, holdUntil: hold.until, notice: limit.notice };
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

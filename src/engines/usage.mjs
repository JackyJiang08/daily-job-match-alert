// Subscription usage, as the CLIs report it. Claude's `--output-format json` envelope carries `usage`
// (the session total) and `modelUsage` keyed by the model id that actually ran ("claude-fable-5-1",
// "claude-haiku-4-5-20251001"); the id is recorded verbatim, never folded into an alias. Codex `exec
// --json` emits `turn.completed` events with `usage` (input_tokens, cached_input_tokens, output_tokens,
// reasoning_output_tokens). Entries are stored per call, model, and purpose (review, supplemental,
// editor, letter) in state/usage.json for 35 days; the hub's Quota card and Run Details summarise them.
import fs from 'node:fs/promises';
import path from 'node:path';
import { localDate } from '../time-format.mjs';

export const USAGE_RETENTION_DAYS = 35;
export const USAGE_PURPOSES = ['review', 'supplemental', 'editor', 'letter'];

const number = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

function emptyTotals() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 };
}

// [{ model, input, output, cacheRead, cacheCreation, reasoning }] from a Claude result envelope. When
// modelUsage is empty (an error envelope) but the session total is not, the total is kept under the
// model the envelope names, or "unknown".
export function claudeUsageFromEnvelope(parsed) {
  const models = [];
  const perModel = parsed?.modelUsage && typeof parsed.modelUsage === 'object' ? parsed.modelUsage : {};
  for (const [id, stats] of Object.entries(perModel)) {
    if (!id) continue;
    models.push({
      model: id,
      input: number(stats?.inputTokens), output: number(stats?.outputTokens),
      cacheRead: number(stats?.cacheReadInputTokens), cacheCreation: number(stats?.cacheCreationInputTokens), reasoning: 0,
    });
  }
  if (!models.length && parsed?.usage && typeof parsed.usage === 'object') {
    const usage = parsed.usage;
    const total = { input: number(usage.input_tokens), output: number(usage.output_tokens), cacheRead: number(usage.cache_read_input_tokens), cacheCreation: number(usage.cache_creation_input_tokens), reasoning: number(usage.output_tokens_details?.thinking_tokens) };
    if (total.input + total.output + total.cacheRead + total.cacheCreation > 0) models.push({ model: typeof parsed.model === 'string' && parsed.model ? parsed.model : 'unknown', ...total });
  }
  return { engine: 'claude', effort: null, models };
}

function eventsOf(jsonl) {
  const events = [];
  for (const line of String(jsonl || '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

function findString(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  for (const key of keys) if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  for (const child of Object.values(value)) {
    const found = findString(child, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

// Codex `exec --json`: every turn.completed usage is added up (one turn per call in practice). The model
// id is the one the stream names (else the -m we passed); the reasoning effort comes from the stream when
// it carries one, else from the configured value.
export function codexUsageFromJsonl(jsonl, { model = null, effort = null } = {}) {
  const events = eventsOf(jsonl);
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 };
  let seen = false;
  for (const event of events) {
    const usage = event?.type === 'turn.completed' ? event.usage : event?.type === 'event_msg' && event.payload?.type === 'token_count' ? event.payload.info?.last_token_usage : null;
    if (!usage || typeof usage !== 'object') continue;
    seen = true;
    totals.input += number(usage.input_tokens);
    totals.output += number(usage.output_tokens);
    totals.cacheRead += number(usage.cached_input_tokens);
    totals.cacheCreation += number(usage.cache_write_input_tokens);
    totals.reasoning += number(usage.reasoning_output_tokens);
  }
  const named = events.map(event => findString(event, ['model'])).find(Boolean) || model;
  const namedEffort = events.map(event => findString(event, ['effort', 'reasoning_effort', 'model_reasoning_effort'])).find(Boolean) || effort;
  return { engine: 'codex', effort: namedEffort || null, models: seen ? [{ model: named || 'unknown', ...totals }] : [] };
}

// One stored entry per model of one call.
export function usageEntries(usage, { purpose, at, source = 'nightly' }) {
  if (!usage || !Array.isArray(usage.models)) return [];
  return usage.models.map(item => ({
    at, purpose: USAGE_PURPOSES.includes(purpose) ? purpose : 'review', source, engine: usage.engine || null, effort: usage.effort || null,
    model: String(item.model || 'unknown'), input: number(item.input), output: number(item.output), cacheRead: number(item.cacheRead), cacheCreation: number(item.cacheCreation), reasoning: number(item.reasoning),
  }));
}

export function usagePath(root) {
  return path.join(root, 'state', 'usage.json');
}

export function normalizeUsage(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries.filter(entry => entry && typeof entry === 'object' && entry.at && entry.model) : [];
  return { version: 1, entries };
}

export async function readUsage(file, io = fs) {
  try { return normalizeUsage(JSON.parse(await io.readFile(file, 'utf8'))); } catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return normalizeUsage(null); throw error; }
}

export function pruneUsage(record, now = new Date(), retentionDays = USAGE_RETENTION_DAYS) {
  const cutoff = now.getTime() - Number(retentionDays) * 86_400_000;
  record.entries = record.entries.filter(entry => new Date(entry.at).getTime() >= cutoff);
  return record;
}

// Re-reads the file and appends, so the nightly run and the hub (cover letters) never drop each other's
// entries; written through a temp file and rename.
export async function appendUsage(file, entries, { now = new Date(), io = fs } = {}) {
  if (!entries.length) return null;
  const record = await readUsage(file, io);
  record.entries.push(...entries);
  pruneUsage(record, now);
  await io.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await io.writeFile(temp, `${JSON.stringify(record, null, 1)}\n`);
  await io.rename(temp, file);
  return record;
}

function add(target, entry) {
  target.calls += 1;
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreation', 'reasoning']) target[key] += number(entry[key]);
  return target;
}

// Totals by full model id and by purpose, plus the grand total.
export function summarizeUsage(entries) {
  const byModel = {};
  const byPurpose = {};
  const total = emptyTotals();
  for (const entry of entries || []) {
    add(byModel[entry.model] ||= { ...emptyTotals(), engine: entry.engine || null, effort: entry.effort || null }, entry);
    add(byPurpose[entry.purpose] ||= emptyTotals(), entry);
    add(total, entry);
  }
  return { byModel, byPurpose, total };
}

// The last `days` local days: the summary over the whole span and one total per night (oldest first).
export function usageWindow(record, { now = new Date(), timeZone = null, days = 7 } = {}) {
  const dates = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) dates.push(localDate(new Date(now.getTime() - offset * 86_400_000), timeZone || 'America/Chicago'));
  const inWindow = (record?.entries || []).filter(entry => dates.includes(localDate(new Date(entry.at), timeZone || 'America/Chicago')));
  const nights = dates.map(date => ({ date, ...summarizeUsage(inWindow.filter(entry => localDate(new Date(entry.at), timeZone || 'America/Chicago') === date)).total }));
  return { ...summarizeUsage(inWindow), nights, days };
}

// "1.2M in · 34k out · 980k cache read"
export function formatTokens(value) {
  const amount = number(value);
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  return String(amount);
}

export function describeTotals(totals) {
  const parts = [`${formatTokens(totals.input)} in`, `${formatTokens(totals.output)} out`];
  if (totals.cacheRead) parts.push(`${formatTokens(totals.cacheRead)} cache read`);
  if (totals.cacheCreation) parts.push(`${formatTokens(totals.cacheCreation)} cache write`);
  if (totals.reasoning) parts.push(`${formatTokens(totals.reasoning)} reasoning`);
  return `${parts.join(' · ')} (${totals.calls} call${totals.calls === 1 ? '' : 's'})`;
}

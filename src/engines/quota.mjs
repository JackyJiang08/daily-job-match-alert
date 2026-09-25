// Subscription quota handling for the Claude Code CLI. Claude Code 2.1.269 offers no command that reports
// remaining usage (`claude --help` lists none; `claude auth status --json` carries no limit fields), so the
// only signal is the error text of a refused call. The CLI bundle names four limit windows internally
// (five_hour, seven_day, seven_day_opus, seven_day_sonnet) and shows users these notices (recorded from the
// installed binary on 2026-09-19, see tests/fixtures/quota-errors.json):
//   "Usage limit reached"                              generic; the reset time tells which window
//   "you have reached your weekly usage limit"          account-wide weekly window
//   "You've reached your Fable limit." / "Fable limit reached" / "Opus limit" / "Sonnet limit"
//                                                       one model's weekly window
//   "Your organization is out of usage credits."        account-wide (credits)
//   "Server is temporarily limiting requests (not your usage limit)", "Opus is experiencing high load"
//                                                       NOT a quota: transient, handled by the normal retry
// Classification is conservative: a limit that names a model is modelWeeklyLimit; anything that says
// weekly, seven-day, or credits is accountWeeklyLimit; a generic notice is fiveHourLimit only when its
// reset time is at most five hours away, otherwise accountWeeklyLimit.
import { normalizeModelName } from './shared.mjs';

export const QUOTA_KINDS = ['fiveHourLimit', 'modelWeeklyLimit', 'accountWeeklyLimit'];
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

// Each list is tried in order; the first list with a match wins. Config may override any list under
// semanticMatching.quotaPolicy.patterns.<kind> (strings compiled with the "i" flag).
export const DEFAULT_QUOTA_PATTERNS = {
  // A login that no longer works. Recorded from the Claude Code 2.1.269 binary: "Failed to authenticate:
  // OAuth session expired and could not be refreshed", "You are not logged in. Run …", "Please run /login
  // and sign in with your Claude.ai account (not Console)", "OAuth token revoked", "authentication_error".
  // Not a quota: handled by engine-errors.mjs as auth_expired.
  authExpired: [
    'failed to authenticate',
    'oauth session expired',
    'could not be refreshed',
    'not logged in',
    'oauth token revoked',
    'please run /login',
    'authentication_error',
    'invalid authentication credentials',
    // The engine's own auth check when the CLI reports no login at all (a Console or API-key login is a
    // configuration problem, not an expiry, and keeps the local fallback).
    'loggedin=false',
  ],
  notQuota: [
    'not your usage limit',
    'experiencing high load',
    'overloaded',
  ],
  modelWeeklyLimit: [
    "(?:reached your|hit your) (?:fable|opus|sonnet|haiku)(?: \\d+(?:\\.\\d+)?)? limit",
    '\\b(?:fable|opus|sonnet|haiku)(?: \\d+(?:\\.\\d+)?)? limit(?: reached)?\\b',
    'seven_day_(?:opus|sonnet|fable|haiku)',
    '\\b(?:fable|opus|sonnet|haiku)\\b[^.\\n]{0,40}requires usage credits',
  ],
  accountWeeklyLimit: [
    'weekly (?:usage )?limit',
    'seven[_ -]day',
    '\\b7[- ]day\\b',
    'out of (?:usage )?credits',
    'usage credit (?:cap|limit)',
    'weekly-limit-reached',
  ],
  fiveHourLimit: [
    'five[_ -]hour',
    '\\b5[- ]hour',
    'session[- ]limit',
    'current session',
  ],
  genericLimit: [
    'usage limit (?:reached|hit)',
    'hit your limit',
    'limit reached',
    "you've hit your",
    'rate_limit',
  ],
};

export const DEFAULT_QUOTA_POLICY = {
  fiveHourLimit: { retryIntervalMs: 10 * 60 * 1000, maxWaitMs: 90 * 60 * 1000 },
  modelLadder: ['fable', 'opus'],
  fallbackEngine: null,
  patterns: {},
};

function compile(list) {
  return (Array.isArray(list) ? list : []).map(pattern => (pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')));
}

export function normalizeQuotaPolicy(raw = {}) {
  const policy = raw && typeof raw === 'object' ? raw : {};
  const fiveHour = policy.fiveHourLimit && typeof policy.fiveHourLimit === 'object' ? policy.fiveHourLimit : {};
  const ladder = (Array.isArray(policy.modelLadder) ? policy.modelLadder : typeof policy.modelLadder === 'string' ? policy.modelLadder.split(',') : DEFAULT_QUOTA_POLICY.modelLadder)
    .map(item => normalizeModelName(item)).filter(Boolean);
  const overrides = policy.patterns && typeof policy.patterns === 'object' ? policy.patterns : {};
  const patterns = Object.fromEntries(Object.keys(DEFAULT_QUOTA_PATTERNS).map(kind => [kind, compile(Array.isArray(overrides[kind]) ? overrides[kind] : DEFAULT_QUOTA_PATTERNS[kind])]));
  return {
    fiveHourLimit: {
      retryIntervalMs: Math.max(1000, Number(fiveHour.retryIntervalMs ?? DEFAULT_QUOTA_POLICY.fiveHourLimit.retryIntervalMs) || DEFAULT_QUOTA_POLICY.fiveHourLimit.retryIntervalMs),
      maxWaitMs: Math.max(0, Number(fiveHour.maxWaitMs ?? DEFAULT_QUOTA_POLICY.fiveHourLimit.maxWaitMs) || 0),
    },
    modelLadder: ladder.length ? ladder : [...DEFAULT_QUOTA_POLICY.modelLadder],
    fallbackEngine: String(policy.fallbackEngine || '').toLowerCase() === 'codex' ? 'codex' : null,
    patterns,
  };
}

// "…|1751749200" (epoch seconds appended by print mode), an ISO instant, "resets at 3pm (America/Chicago)",
// "resets in 2 hours" / "in 45 minutes". Returns an ISO string or null.
export function parseResetTime(text, now = new Date()) {
  const value = String(text || '');
  const epoch = /\|\s*(\d{9,10})\b/.exec(value) || /resets?_?at\D{0,6}(\d{9,10})\b/i.exec(value);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(value);
  if (iso) { const parsed = new Date(iso[1]); if (!Number.isNaN(parsed.getTime())) return parsed.toISOString(); }
  const relative = /resets? in (\d+)\s*(minutes?|mins?|hours?|hrs?|days?)/i.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith('d') ? amount * 86_400_000 : unit.startsWith('h') ? amount * 3_600_000 : amount * 60_000;
    return new Date(now.getTime() + ms).toISOString();
  }
  const clock = /resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(value);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if ((clock[3] || '').toLowerCase() === 'pm') hour += 12;
    if (!clock[3] && Number(clock[1]) > 12) hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    const zone = clock[4] || 'UTC';
    const at = nextClockInZone(now, hour, minute, zone);
    if (at) return at.toISOString();
  }
  return null;
}

function nextClockInZone(now, hour, minute, zone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
    const value = type => Number(parts.find(part => part.type === type)?.value || 0);
    const localNowMinutes = value('hour') * 60 + value('minute');
    const targetMinutes = hour * 60 + minute;
    const dayOffset = targetMinutes > localNowMinutes ? 0 : 1;
    const guess = Date.UTC(value('year'), value('month') - 1, value('day') + dayOffset, hour, minute);
    const offsetParts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
    const offsetValue = type => Number(offsetParts.find(part => part.type === type)?.value || 0);
    const asUtc = Date.UTC(offsetValue('year'), offsetValue('month') - 1, offsetValue('day'), offsetValue('hour'), offsetValue('minute'));
    return new Date(guess - (asUtc - guess));
  } catch {
    return null;
  }
}

// "Fable limit", "seven_day_opus": model names may sit between underscores as well as spaces.
function modelNamed(text) {
  const match = /(?:^|[^a-z])(fable|opus|sonnet|haiku)(?![a-z])/i.exec(String(text || ''));
  return match ? match[1].toLowerCase() : null;
}

// { kind, model, resetsAt, message } for a quota refusal, or null when the error is something else.
export function classifyQuotaError(error, { now = new Date(), policy = normalizeQuotaPolicy() } = {}) {
  const message = String(error?.message || error?.stderr || error || '').trim();
  if (!message) return null;
  const { patterns } = policy;
  if (patterns.notQuota.some(pattern => pattern.test(message))) return null;
  const resetsAt = parseResetTime(message, now);
  const base = { message: message.slice(0, 500), resetsAt, model: modelNamed(message) };
  if (patterns.modelWeeklyLimit.some(pattern => pattern.test(message))) return { kind: 'modelWeeklyLimit', ...base };
  if (patterns.accountWeeklyLimit.some(pattern => pattern.test(message))) return { kind: 'accountWeeklyLimit', ...base };
  if (patterns.fiveHourLimit.some(pattern => pattern.test(message))) return { kind: 'fiveHourLimit', ...base };
  if (patterns.genericLimit.some(pattern => pattern.test(message))) {
    // A generic notice: the reset time decides; without one the conservative reading is the weekly window.
    const withinFiveHours = resetsAt && new Date(resetsAt).getTime() - now.getTime() <= FIVE_HOURS_MS;
    return { kind: withinFiveHours ? 'fiveHourLimit' : 'accountWeeklyLimit', ...base };
  }
  return null;
}

export class QuotaError extends Error {
  constructor(quota, cause = null) {
    super(describeQuota(quota));
    this.name = 'QuotaError';
    this.code = 'SUBSCRIPTION_QUOTA';
    this.quota = quota;
    this.cause = cause;
  }
}

export const QUOTA_LABELS = { fiveHourLimit: 'five-hour usage limit', modelWeeklyLimit: 'weekly model limit', accountWeeklyLimit: 'weekly account limit' };

// One plain sentence for reports, cards, and the panel.
export function describeQuota(quota, { timeZone = 'America/Chicago' } = {}) {
  if (!quota) return '';
  const label = quota.kind === 'modelWeeklyLimit' && quota.model ? `${quota.model.charAt(0).toUpperCase()}${quota.model.slice(1)} weekly limit` : QUOTA_LABELS[quota.kind] || 'usage limit';
  const reset = quota.resetsAt ? `; expected to reset ${new Date(quota.resetsAt).toLocaleString('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' })}` : '';
  return `Claude subscription ${label} reached${reset}`;
}

// The next model down the ladder after `model`, or null at the bottom (or when the model is not on it).
export function nextLadderModel(policy, model) {
  const ladder = policy.modelLadder || [];
  const index = ladder.indexOf(normalizeModelName(model));
  return index >= 0 && index + 1 < ladder.length ? ladder[index + 1] : null;
}

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
import { DEFAULT_CATALOG, canonicalModelId, defaultLadder, providerModels } from './catalog.mjs';
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
  // A model the plan does not include or the CLI does not know. Conservative: the text must name a
  // model or a plan; recorded in tests/fixtures/engine-errors.json.
  modelUnavailable: [
    'not available (?:on|for|with) your (?:plan|subscription|account)',
    'requires an? (?:pro|max|team|enterprise) (?:plan|subscription)',
    'upgrade to (?:pro|max|team|enterprise) to use',
    'model[^.\\n]{0,60}(?:not found|does not exist|is not available|not available)',
    'unknown model',
  ],
  // The subset that means the id itself is wrong for this CLI or account (Settings badge "Unknown model"),
  // not that the plan lacks it: "Unknown model `x`" is verbatim from the codex 0.153.0 binary; the
  // ChatGPT-account sentence comes from the server and was given by the owner.
  unknownModel: [
    'unknown model',
    'model[^.\\n]{0,60}(?:not found|does not exist)',
    'not supported when using codex with a chatgpt account',
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
  modelLadder: defaultLadder(),
  fallbackEngine: null,
  patterns: {},
};

function compile(list) {
  return (Array.isArray(list) ? list : []).map(pattern => (pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')));
}

export function normalizeQuotaPolicy(raw = {}) {
  const policy = raw && typeof raw === 'object' ? raw : {};
  const fiveHour = policy.fiveHourLimit && typeof policy.fiveHourLimit === 'object' ? policy.fiveHourLimit : {};
  // Ladder steps are registry ids; an alias written by an older config ("fable") maps to its entry.
  const ladder = (Array.isArray(policy.modelLadder) ? policy.modelLadder : typeof policy.modelLadder === 'string' ? policy.modelLadder.split(',') : DEFAULT_QUOTA_POLICY.modelLadder)
    .map(item => normalizeModelName(item)).filter(Boolean).map(item => canonicalModelId(item, 'anthropic', Array.isArray(policy.catalog) ? policy.catalog : DEFAULT_CATALOG));
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
// The model a refusal names, as its registry id: a full id ("claude-opus-5-5"), or a family word the CLI
// uses in its notices ("Your Fable limit") matched against the registry aliases.
const ALIAS_WORDS = providerModels(DEFAULT_CATALOG, 'anthropic').map(entry => entry.alias).filter(Boolean);
const NAMED_MODEL = new RegExp(`(?:^|[^a-z])(${ALIAS_WORDS.join('|')})(?![a-z])`, 'i');
const MODEL_ID_IN_TEXT = /(?:^|[^a-z0-9.-])((?:claude|gpt)-[a-z0-9][a-z0-9.-]*[a-z0-9])(?:\[1m\])?(?![a-z0-9])/i;
export function modelNamed(text) {
  const value = String(text || '');
  const written = MODEL_ID_IN_TEXT.exec(value);
  if (written) return canonicalModelId(written[1], null, DEFAULT_CATALOG).toLowerCase();
  const match = NAMED_MODEL.exec(value);
  return match ? canonicalModelId(match[1].toLowerCase(), 'anthropic', DEFAULT_CATALOG) : null;
}

// { kind, model, resetsAt, message } for a quota refusal, or null when the error is something else.
// The CLI's notice as it is stored and shown: the "<path to claude> exited 1:" prefix (the path carries
// the macOS user name), e-mail addresses, UUIDs and other long ids, organization and account ids, and URL
// query strings are removed; the rest is kept verbatim up to `limit` characters.
export function sanitizeNotice(text, limit = 300) {
  let value = String(text || '');
  // Whatever command ran (the CLI, or a wrapper script configured in its place), its path is dropped.
  value = value.replace(/^\s*\S+\s+exited\s+-?\d+:\s*/i, '');
  value = value.replace(/(?:\/Users|\/home)\/[^/\s]+/g, '~');
  value = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
  value = value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]');
  value = value.replace(/\b(?:org|acct|account|user|organization)[-_:=]\s*[A-Za-z0-9_-]{6,}/gi, '[id]');
  value = value.replace(/\b[0-9a-f]{24,}\b/gi, '[id]');
  value = value.replace(/(https?:\/\/[^\s?#),]+)[?#][^\s),]*?([.;:!]?)(?=[\s),]|$)/gi, '$1$2');
  value = value.replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function classifyQuotaError(error, { now = new Date(), policy = normalizeQuotaPolicy() } = {}) {
  const message = String(error?.message || error?.stderr || error || '').trim();
  if (!message) return null;
  const { patterns } = policy;
  if (patterns.notQuota.some(pattern => pattern.test(message))) return null;
  const resetsAt = parseResetTime(message, now);
  const named = modelNamed(message);
  // The stored text is the CLI's own notice, cut to 300 characters, with the CLI path and anything that
  // could identify the account removed (see sanitizeNotice).
  const base = { message: sanitizeNotice(message), resetsAt, model: named };
  if (patterns.modelWeeklyLimit.some(pattern => pattern.test(message))) return { kind: 'modelWeeklyLimit', ...base };
  // A weekly notice that names no model cannot tell a per-model limit from the account's: it is
  // ambiguousWeeklyLimit, and the caller settles it by trying the next model on the ladder (a model that
  // answers means the first one hit its own limit; a second refusal means the account is out).
  if (patterns.accountWeeklyLimit.some(pattern => pattern.test(message))) return { kind: named ? 'modelWeeklyLimit' : 'ambiguousWeeklyLimit', ...base };
  if (patterns.fiveHourLimit.some(pattern => pattern.test(message))) return { kind: 'fiveHourLimit', ...base };
  if (patterns.genericLimit.some(pattern => pattern.test(message))) {
    // A generic notice: a reset within five hours is the rolling window; anything longer is a weekly limit,
    // per model when the notice names one, otherwise ambiguous.
    const withinFiveHours = resetsAt && new Date(resetsAt).getTime() - now.getTime() <= FIVE_HOURS_MS;
    return { kind: withinFiveHours ? 'fiveHourLimit' : named ? 'modelWeeklyLimit' : 'ambiguousWeeklyLimit', ...base };
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

export const QUOTA_LABELS = { fiveHourLimit: 'five-hour usage limit', modelWeeklyLimit: 'weekly model limit', accountWeeklyLimit: 'weekly account limit', ambiguousWeeklyLimit: 'weekly limit (the notice names no model)' };

// One plain sentence for reports, cards, and the panel.
export function describeQuota(quota, { timeZone = 'America/Chicago' } = {}) {
  if (!quota) return '';
  if (quota.kind === 'model_unavailable') return `Claude model ${quota.model || 'unknown'} is not available on ${planLabel(quota.plan)}`;
  if (quota.kind === 'auth_expired') return 'Claude session expired';
  // Older payloads stored the family word ("fable"); it is shown as the registry id like everything else.
  const label = quota.kind === 'modelWeeklyLimit' && quota.model ? `${canonicalModelId(quota.model, null, DEFAULT_CATALOG)} weekly limit` : QUOTA_LABELS[quota.kind] || 'usage limit';
  const reset = quota.resetsAt ? `; expected to reset ${new Date(quota.resetsAt).toLocaleString('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' })}` : '';
  return `Claude subscription ${label} reached${reset}`;
}

// The next model down the ladder after `model`, or null at the bottom (or when the model is not on it).
export function nextLadderModel(policy, model) {
  const ladder = policy.modelLadder || [];
  const index = ladder.indexOf(canonicalModelId(normalizeModelName(model), 'anthropic', DEFAULT_CATALOG));
  return index >= 0 && index + 1 < ladder.length ? ladder[index + 1] : null;
}

// "Max" / "Pro" / "this plan" for sentences.
export function planLabel(plan) {
  const value = String(plan || '').trim();
  return value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : 'this plan';
}

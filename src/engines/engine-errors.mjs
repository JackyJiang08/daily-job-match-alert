// One place that turns whatever a subscription CLI threw into a classification and a sentence a person
// can act on. Nothing here ever returns raw JSON: the CLI's print-mode result envelope ({ type: "result",
// is_error: true, result: "<notice>" }, recorded in tests/fixtures/engine-errors.json) is unwrapped to its
// notice, quota notices go through quota.mjs, an expired login becomes auth_expired, and anything else
// becomes a short "Generation failed" line while the full text stays in the hub log.
import { classifyQuotaError, describeQuota, normalizeQuotaPolicy } from './quota.mjs';

export const AUTH_EXPIRED_MESSAGE = 'Claude session expired. Run `claude auth login --claudeai` in Terminal, then try again.';
export const AUTH_EXPIRED_NOTIFICATION = 'Claude login expired, run claude auth login';

// The CLI writes its JSON envelope to stdout even on a failed exit, and run() folds that into the error
// message ("claude exited 1: {…}"). Returns { notice, envelope } when a result envelope is present.
export function unwrapCliEnvelope(text) {
  const value = String(text || '');
  const start = value.indexOf('{');
  if (start < 0) return null;
  for (let end = value.lastIndexOf('}'); end > start; end = value.lastIndexOf('}', end - 1)) {
    try {
      const envelope = JSON.parse(value.slice(start, end + 1));
      if (envelope && typeof envelope === 'object' && ('is_error' in envelope || 'result' in envelope || envelope.type === 'result')) {
        const notice = typeof envelope.result === 'string' ? envelope.result.trim() : '';
        return { notice, envelope };
      }
      return null;
    } catch {
      // keep shrinking the candidate window
    }
  }
  return null;
}

// The plain notice behind an engine error: the envelope's result text when there is one, else the message.
export function engineNotice(error) {
  if (error?.notice) return String(error.notice);
  const message = String(error?.message || error || '');
  const unwrapped = unwrapCliEnvelope(message);
  if (unwrapped?.notice) return unwrapped.notice;
  return message.replace(/\{[\s\S]*\}/, '').replace(/\s+/g, ' ').trim();
}

export function isAuthExpiredText(text, policy = normalizeQuotaPolicy()) {
  const value = String(text || '');
  return (policy.patterns.authExpired || []).some(pattern => pattern.test(value));
}

// { kind: 'auth_expired' | <quota kind> | 'engine_error' | 'missing_cli', notice, quota? } for any error
// thrown by an engine call; null for a value that is not an error at all.
export function classifyEngineError(error, { now = new Date(), policy = normalizeQuotaPolicy() } = {}) {
  if (error == null) return null;
  const notice = engineNotice(error);
  const haystack = `${notice}\n${String(error?.message || '')}`;
  if (error?.code === 'SUBSCRIPTION_AUTH' || isAuthExpiredText(haystack, policy)) return { kind: 'auth_expired', notice };
  const quota = error?.code === 'SUBSCRIPTION_QUOTA' ? error.quota : classifyQuotaError(new Error(notice || String(error?.message || '')), { now, policy });
  if (quota) return { kind: quota.kind, notice, quota };
  if (error?.code === 'ENOENT' || /\bENOENT\b/.test(String(error?.message || ''))) return { kind: 'missing_cli', notice };
  return { kind: 'engine_error', notice };
}

export class AuthExpiredError extends Error {
  constructor(notice, cause = null) {
    super(AUTH_EXPIRED_MESSAGE);
    this.name = 'AuthExpiredError';
    this.code = 'SUBSCRIPTION_AUTH';
    this.notice = notice;
    this.cause = cause;
  }
}

// A generic engine failure whose user-facing text is already humanized; the raw text rides along for logs.
export class EngineError extends Error {
  constructor(message, cause = null, kind = 'engine_error') {
    super(message);
    this.name = 'EngineError';
    this.code = 'ENGINE_FAILURE';
    this.kind = kind;
    this.cause = cause;
    this.raw = String(cause?.message || cause || '');
  }
}

function shortReason(notice, error) {
  const text = String(notice || engineNotice(error) || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'unknown error';
  const first = text.split(/(?<=[.!?])\s|\n/)[0] || text;
  return first.length > 100 ? `${first.slice(0, 97)}…` : first;
}

// Every user-visible engine error passes through here: cards, the panel, one-click status, warnings.
export function humanizeEngineError(error, { now = new Date(), policy = normalizeQuotaPolicy(), timeZone = 'America/Chicago' } = {}) {
  const verdict = classifyEngineError(error, { now, policy });
  if (!verdict) return { kind: 'engine_error', message: 'Generation failed (unknown error); details in the hub log', codexSuggested: false };
  if (verdict.kind === 'auth_expired') return { kind: 'auth_expired', message: AUTH_EXPIRED_MESSAGE, codexSuggested: true, notice: verdict.notice };
  if (verdict.quota) return { kind: verdict.kind, message: describeQuota(verdict.quota, { timeZone }), codexSuggested: true, quota: verdict.quota, notice: verdict.notice };
  if (verdict.kind === 'missing_cli') return { kind: 'missing_cli', message: 'Generation failed (the Claude CLI was not found on this Mac); details in the hub log', codexSuggested: true, notice: verdict.notice };
  if (error?.code === 'ENGINE_FAILURE' && error.message) return { kind: 'engine_error', message: error.message, codexSuggested: false, notice: verdict.notice };
  return { kind: 'engine_error', message: `Generation failed (${shortReason(verdict.notice, error)}); details in the hub log`, codexSuggested: false, notice: verdict.notice };
}

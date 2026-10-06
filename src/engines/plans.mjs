// How each subscription's plan is shown. The detected plan comes from the connection probes (Claude:
// `claude auth status --json`; ChatGPT: `codex login status`, else the plan claim in ~/.codex/auth.json).
// config.plans.<provider>.manual (set from Settings) is used when nothing was detected, or overrides a
// detection the owner knows is wrong; every plan carries its source, 'auto' or 'manual'.
// config.plans.claude.scheduledChange { plan, effectiveDate: 'YYYY-MM-DD' } announces a known switch:
// before the date the card reads "Max · switches to Pro on Oct 26, 2026"; from that local date on it
// reads "Pro" with no config change.
import { localDate } from '../time-format.mjs';
import { planLabel } from './quota.mjs';

export const PLAN_PROVIDERS = ['claude', 'chatgpt'];
const PLAN_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function planName(value) {
  const text = String(value || '').trim().toLowerCase();
  return PLAN_NAME.test(text) ? text : null;
}

// "Max", "Pro", "Plus", "Team"; any other plan name title-cased.
export function displayPlan(value) {
  const name = planName(value);
  if (!name) return 'Unknown';
  const known = planLabel(name);
  if (known !== 'this plan') return known;
  return name.split(/[_-]/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function dateLabel(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function scheduledOf(config, provider) {
  const raw = config?.plans?.[provider]?.scheduledChange;
  const plan = planName(raw?.plan);
  const effectiveDate = DATE.test(String(raw?.effectiveDate || '')) ? String(raw.effectiveDate) : null;
  return plan && effectiveDate ? { plan, effectiveDate } : null;
}

// { plan, label, source, detected, scheduled, pending, line, sidebar } for one provider.
export function planView(provider, { detected = null, detectedSource = null, config = {}, now = new Date(), timeZone = 'America/Chicago' } = {}) {
  const manual = planName(config?.plans?.[provider]?.manual);
  const auto = planName(detected);
  const base = manual || auto;
  const source = manual ? 'manual' : auto ? 'auto' : null;
  const scheduled = scheduledOf(config, provider);
  const today = localDate(now, timeZone);
  const reached = scheduled && today >= scheduled.effectiveDate;
  const plan = reached ? scheduled.plan : base;
  const pending = scheduled && !reached && scheduled.plan !== base ? { ...scheduled, dateLabel: dateLabel(scheduled.effectiveDate) } : null;
  const name = provider === 'claude' ? 'Claude' : 'ChatGPT';
  const label = displayPlan(plan);
  const shortDate = pending ? dateLabel(pending.effectiveDate).replace(/, \d{4}$/, '') : null;
  return {
    // After the date the plan is the owner's scheduled value (manual) unless the CLI already reports it.
    provider, plan: plan || null, label, source: reached ? (auto === scheduled.plan ? 'auto' : 'manual') : source, detected: auto, detectedSource: auto ? detectedSource : null, manual,
    scheduled, pending,
    line: pending ? `${label} · switches to ${displayPlan(pending.plan)} on ${pending.dateLabel}` : label,
    sidebar: pending ? `${name} ${label} → ${displayPlan(pending.plan)} ${shortDate}` : `${name} ${label}`,
  };
}

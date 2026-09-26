// Assembles the daily HTML report from a payload: turns jobs and run metadata into view objects and
// hands them to report-components.mjs. Pipeline warnings are not rendered in the page; they go to
// warnings.txt beside it (see writeWarningsFile).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jobScores, reportTracks, trackScore } from './resume-tracks.mjs';
import { renderReportPage } from './report-components.mjs';
import { warningText } from './warnings.mjs';
import { formatLocalDateTime, formatLocalDay, formatLocalShort } from './time-format.mjs';
import { normalizeLocation, sha256 } from './utils.mjs';
import { companyIsUncertain, displayCompanyName, postedAtPrecision } from './posting-fields.mjs';
import { describeQuota } from './engines/quota.mjs';

export const REPORT_TITLE = 'Daily Job Match Alert';
export const WARNINGS_FILE_NAME = 'warnings.txt';

const ROLE_LABELS = { internship: 'Internship', new_grad: 'New Grad', entry_level: 'Entry Level', unknown: 'Unknown Role Type' };
const ENRICHMENT_BADGES = {
  blocked: { key: 'blocked', label: 'Fetch blocked', tone: 'bad', title: 'The site refused the description fetch; only the alert text was scored' },
  removed: { key: 'removed', label: 'Posting removed', tone: 'bad', title: 'The posting returned 404 or 410 when fetched' },
  login_wall: { key: 'login_wall', label: 'Login wall', tone: 'warn', title: 'The posting sits behind a login; only the alert text was scored' },
};

export function roleLabel(roleType) {
  return ROLE_LABELS[roleType] || String(roleType || 'unknown').replace(/_/g, ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

// "September 11, 2026" from a YYYY-MM-DD application date; falls back to the raw value.
export function readableDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return String(date || '');
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return value.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function readableTimestamp(value, timeZone) {
  return formatLocalDateTime(value, timeZone);
}

function matchLabel(count) {
  if (count === 0) return 'No matches';
  return `${count} ${count === 1 ? 'match' : 'matches'}`;
}

// Semantic markers shown as small badges instead of text prefixes.
export function jobBadges(job) {
  const badges = [];
  const unreviewed = job.matchLevel === 'unreviewed' || job.scoringEngine === 'local_fallback';
  if (unreviewed) badges.push({ key: 'unreviewed', label: 'Unreviewed', tone: 'warn', title: 'Semantic review was unavailable; the local triage score was kept' });
  else if (job.semanticReviewed && job.matchLevel && job.matchLevel !== 'high') {
    badges.push({ key: `match-${job.matchLevel}`, label: `Match: ${job.matchLevel}`, tone: 'note' });
  }
  if (job.eligibility?.location?.verdict === 'unverified') {
    badges.push({ key: 'location-unverified', label: 'Location unverified', tone: 'note', title: 'The posting only says Remote or gives no location; confirm it permits work from the United States' });
  }
  if (companyIsUncertain(job)) {
    badges.push({ key: 'company-uncertain', label: 'Company name uncertain', tone: 'warn', title: 'No source gave a usable employer name; confirm it before applying or generating a letter' });
  }
  if (job.enrichment === 'failed') {
    badges.push(ENRICHMENT_BADGES[job.enrichmentReason] || { key: 'jd-not-fetched', label: 'JD not fetched', tone: 'warn', title: job.enrichmentError || 'The posting could not be fetched; only the alert text was scored' });
  } else if (!job.enrichment && /email/i.test(String(job.source || ''))) {
    badges.push({ key: 'email-only', label: 'Email only', tone: 'note', title: 'The description comes from the alert email; the posting page was not fetched' });
  }
  for (const extra of Array.isArray(job.badges) ? job.badges : []) {
    const label = String(extra?.label ?? extra ?? '').trim();
    if (label) badges.push({ key: String(extra?.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '-'), label, tone: extra?.tone || 'note', title: extra?.title });
  }
  return badges;
}

function postedEpoch(job) {
  const stamp = new Date(job.postedAt || job.discoveredAt || '');
  return Number.isNaN(stamp.getTime()) ? '' : String(stamp.getTime());
}

// "Posted Sep 18 · source" for day-level dates (hover says the source gives no time of day) and
// "Posted Sep 18, 8:00 PM · source" when the posting time is precise.
function footnote(job, timeZone) {
  const parts = [];
  let title = '';
  if (job.postedAt) {
    const precision = postedAtPrecision(job);
    if (precision === 'datetime') {
      parts.push(`Posted ${formatLocalShort(job.postedAt, timeZone)}`);
      title = `Posted ${formatLocalDateTime(job.postedAt, timeZone)}`;
    } else {
      parts.push(`Posted ${formatLocalDay(job.postedAt, timeZone)}`);
      title = 'Date only: the source reports no time of day';
    }
  } else if (job.discoveredAt) parts.push(`Found ${formatLocalDay(job.discoveredAt, timeZone)}`);
  if (job.source) parts.push(String(job.source));
  return { text: parts.join(' · '), title };
}

export function cardView(job, tracks, timeZone = null, decorate = null) {
  const scores = tracks.map(track => ({ id: track.id, label: track.label, value: trackScore(job, track.id), best: track.id === job.recommendedTrack }));
  if (!scores.some(score => score.best) && scores.length) {
    const top = scores.reduce((best, score) => (score.value > best.value ? score : best), scores[0]);
    top.best = true;
  }
  const recommendedTrack = job.recommendedTrack || scores.find(score => score.best)?.id || '';
  const recommendedLabel = job.recommendedResume || scores.find(score => score.best)?.label || '';
  const company = displayCompanyName(job) || 'Company not resolved';
  const extra = typeof decorate === 'function' ? decorate(job) || {} : {};
  const note = footnote(job, timeZone);
  return {
    id: job.semanticId || sha256(job.url || '').slice(0, 16),
    actions: Array.isArray(extra.actions) ? extra.actions : [],
    title: job.title || 'Untitled posting',
    url: job.url,
    company,
    location: normalizeLocation(job.location) || 'Location not stated',
    roleType: job.roleType || 'unknown',
    roleLabel: roleLabel(job.roleType),
    bestScore: Number(job.bestScore) || 0,
    scores,
    recommendedTrack,
    recommendation: recommendedLabel ? `Apply with ${recommendedLabel} Resume` : 'No Resume Recommended',
    badges: [...jobBadges(job), ...(Array.isArray(extra.badges) ? extra.badges : [])],
    reasons: (job.reasons || []).map(String),
    gaps: (job.gaps || []).map(String),
    description: String(job.description || '').trim(),
    footnote: note.text,
    footnoteTitle: note.title,
    alternates: (Array.isArray(job.alternates) ? job.alternates : []).map(item => ({ url: String(item?.url || ''), label: [item?.source, item?.location].filter(Boolean).join(' · ') || 'alternate listing' })).filter(item => item.url),
    sort: {
      score: Number(job.bestScore) || 0,
      company: company.toLowerCase(),
      posted: postedEpoch(job),
      search: `${company} ${job.title || ''}`.toLowerCase(),
    },
  };
}

// One line per source for Run Details: "Greenhouse · Acme: 3 new (216 listed)", "SimplifyJobs New Grad: failed …".
export function sourceLine(stat) {
  const name = String(stat?.name || 'unknown source');
  if (stat?.skipped) return `${name}: not polled (${stat.skipped})`;
  if (stat?.ok === false) return `${name}: failed (${stat.error || 'unknown error'})`;
  if (stat?.baseline) return `${name}: first poll, ${Number(stat.baselineCount ?? stat.jobCount ?? 0)} older posting(s) recorded as seen (baseline), ${Number(stat.count || 0)} new`;
  const count = Number(stat?.count || 0);
  const parts = [stat?.kind === 'ats' ? `${count} new` : `${count} collected`];
  if (stat?.notModified) parts.push('unchanged since the last poll');
  else if (stat?.kind === 'ats' && stat.jobCount != null) parts.push(`${Number(stat.jobCount)} listed`);
  return `${name}: ${parts.join(', ')}`;
}

function sourcesSummary(stats) {
  const polled = stats.filter(stat => !stat.skipped);
  const failed = polled.filter(stat => stat.ok === false).length;
  const collected = polled.reduce((sum, stat) => sum + Number(stat.count || 0), 0);
  const baselined = polled.filter(stat => stat.baseline).length;
  const parts = [`${polled.length} polled`, `${collected} posting(s) collected`];
  if (failed) parts.push(`${failed} failed`);
  if (baselined) parts.push(`${baselined} baselined`);
  if (stats.length > polled.length) parts.push(`${stats.length - polled.length} not polled`);
  return parts.join(' · ');
}

// Everything that used to sit in the page header or the warnings panel, folded into one list.
export function runDetailsView(jobs, meta, tracks) {
  const rows = [];
  const exclusions = meta.eligibilityExclusions || null;
  const warnings = meta.warnings || [];
  rows.push({ term: 'Application date', detail: `${readableDate(meta.date)}${meta.runDate && meta.runDate !== meta.date ? ` (run on ${readableDate(meta.runDate)})` : ''}` });
  if (meta.lookbackHours != null) rows.push({ term: 'Lookback window', detail: `${meta.lookbackHours} hours` });
  rows.push({ term: 'Resume tracks', detail: tracks.map(track => track.label).join(', ') });
  rows.push({ term: 'Scoring model', detail: meta.scoringModel || 'unknown' });
  if (meta.minimumMatchScore != null) rows.push({ term: 'Minimum score', detail: String(meta.minimumMatchScore) });
  if (meta.reviewedCount != null || meta.collectedCount != null) {
    const counts = [];
    if (meta.collectedCount != null) counts.push(`${meta.collectedCount} collected`);
    if (meta.reviewedCount != null) counts.push(`${meta.reviewedCount} reviewed`);
    counts.push(`${jobs.length} matched`);
    rows.push({ term: 'Postings', detail: counts.join(' · ') });
  }
  if (meta.authExpired) rows.push({ term: 'Claude login', detail: `${meta.authExpired.message}${meta.authExpired.deferred ? ` (${meta.authExpired.deferred} deferred)` : ''}` });
  if (meta.quota?.events?.length) {
    const events = meta.quota.events.map(event => `${describeQuota(event, { timeZone: meta.timeZone })}: ${event.action}${event.detail ? ` (${event.detail})` : ''}`);
    rows.push({ term: 'Subscription quota', detail: `${events.length} event(s)${meta.quota.effectiveModel || meta.quota.effectiveEngine ? ` · scored by ${meta.quota.effectiveEngine || 'claude'}${meta.quota.effectiveModel ? ` · ${meta.quota.effectiveModel}` : ''}` : ''}${meta.quota.deferredByQuota ? ` · ${meta.quota.deferredByQuota} deferred` : ''}`, items: events });
  }
  if (meta.droppedAfterPreciseTimestamps != null) {
    rows.push({ term: 'Freshness check', detail: `dropped ${Number(meta.droppedAfterPreciseTimestamps)} postings after precise timestamps` });
  }
  if (meta.candidateCount != null) {
    const limit = Number(meta.maxReviewedPerRun || 0);
    const inWindow = meta.candidateInWindowCount != null ? ` (${Number(meta.candidateInWindowCount)} within the window)` : '';
    const expired = meta.expiredBacklogCount != null ? ` · expired ${Number(meta.expiredBacklogCount)} backlog postings` : '';
    rows.push({ term: 'Review budget', detail: `${Number(meta.candidateCount)} candidates${inWindow} · ${Number(meta.reviewedThisRun || 0)} reviewed · ${Number(meta.deferredCount || 0)} deferred${expired}${limit > 0 ? ` (limit ${limit} per run)` : ' (no limit)'}`, items: meta.budgetAlert ? [meta.budgetAlert.message] : [] });
  }
  if (Array.isArray(meta.sourceCounts) && meta.sourceCounts.length) {
    rows.push({ term: 'Sources', detail: sourcesSummary(meta.sourceCounts), items: meta.sourceCounts.map(sourceLine) });
  }
  if (exclusions) {
    const total = Number(exclusions.location || 0) + Number(exclusions.graduation || 0);
    rows.push({
      term: 'Hard filter',
      detail: total
        ? `${total} excluded: ${Number(exclusions.location || 0)} outside the United States, ${Number(exclusions.graduation || 0)} outside the graduation window`
        : 'Nothing excluded',
      items: Array.isArray(meta.excludedPostings) ? meta.excludedPostings.map(String) : [],
    });
  }
  if (meta.trigger) rows.push({ term: 'Trigger', detail: String(meta.trigger) });
  if (meta.engine) rows.push({ term: 'Engine', detail: String(meta.engine) });
  if (meta.runsToday) {
    rows.push({ term: 'Updates today', detail: `Daily update #${Number(meta.runsToday)}${meta.lastUpdatedAt ? ` · last updated ${readableTimestamp(meta.lastUpdatedAt, meta.timeZone)}` : ''}` });
  } else if (meta.generatedAt) {
    rows.push({ term: 'Generated', detail: readableTimestamp(meta.generatedAt, meta.timeZone) });
  }

  const status = [];
  const unreviewed = jobs.filter(job => job.matchLevel === 'unreviewed' || job.scoringEngine === 'local_fallback').length;
  if (unreviewed) status.push(`${unreviewed} of ${jobs.length} matches kept local scores because semantic review was unavailable (unreviewed)`);
  if (!unreviewed && (meta.scoringModel === 'local_only' || meta.scoringModel === 'none') && jobs.length) status.push('No semantic review ran; scores are local triage only');
  const unverified = jobs.filter(job => job.eligibility?.location?.verdict === 'unverified').length;
  if (unverified) status.push(`${unverified} match(es) have an unverified location; confirm US eligibility before applying`);
  const enrichmentFailures = jobs.filter(job => job.enrichment === 'failed');
  if (enrichmentFailures.length) {
    const reasons = enrichmentFailures.map(job => job.enrichmentReason).filter(Boolean);
    status.push(`${enrichmentFailures.length} match(es) were scored from alert text only because the posting could not be fetched${reasons.length ? ` (${[...new Set(reasons)].join(', ')})` : ''}`);
  }
  const recoveredResumes = meta.resumeSync?.recovered || [];
  if (recoveredResumes.length) status.push(`Resume PDF(s) recovered from iCloud before this run: ${recoveredResumes.join(', ')}`);
  status.push(warnings.length ? `${warnings.length} pipeline warning(s), see ${WARNINGS_FILE_NAME} beside this file` : 'No pipeline warnings');
  rows.push({ term: 'Status', detail: status[0], items: status.slice(1) });
  return { rows };
}

// The view object consumed by report-components; the hub renders the same view inside its shell.
// "1 match · Ran Sep 12, 8:00 PM"; the run time comes from the pipeline's own meta.completedAt.
// "posted within the last 24 hours" / "last 2 days" from the oldest posting date actually in the report,
// measured at the run time; absent when no card carries a date or the payload records no run time.
export function postingWindowLabel(jobs, meta) {
  const ranAt = meta.completedAt || meta.lastUpdatedAt || meta.generatedAt || null;
  if (!ranAt || Number.isNaN(new Date(ranAt).getTime())) return null;
  const end = new Date(ranAt).getTime();
  const stamps = jobs.map(job => new Date(job.postedAt || job.discoveredAt || '').getTime()).filter(Number.isFinite);
  if (!stamps.length) return null;
  const hours = Math.max(0, (end - Math.min(...stamps)) / 3_600_000);
  if (hours <= 24) return 'posted within the last 24 hours';
  const days = Math.ceil(hours / 24);
  return `posted within the last ${days} days`;
}

export function mastheadSubtitle(jobs, meta, { withDate = true } = {}) {
  const parts = [];
  if (withDate) parts.push(readableDate(meta.date));
  parts.push(matchLabel(jobs.length));
  const window = postingWindowLabel(jobs, meta);
  if (window) parts.push(window);
  const ranAt = meta.completedAt || meta.lastUpdatedAt || null;
  if (ranAt) parts.push(`Ran ${formatLocalShort(ranAt, meta.timeZone)}`);
  return parts.join(' · ');
}

// The view object consumed by report-components; the hub renders the same view inside its shell with
// `embedded: true`, which titles the masthead with the date instead of repeating the product name.
export function buildReportView(jobs, meta, options = {}) {
  const tracks = reportTracks(meta, jobs);
  const cards = jobs.map(job => cardView(job, tracks, meta.timeZone, options.decorate));
  const roleTypes = [...new Set(jobs.map(job => job.roleType || 'unknown'))].map(value => ({ value, label: roleLabel(value) }));
  const embedded = options.embedded === true;
  return {
    title: REPORT_TITLE,
    dateLabel: readableDate(meta.date),
    matchLabel: matchLabel(jobs.length),
    masthead: embedded
      ? { title: readableDate(meta.date), subtitle: mastheadSubtitle(jobs, meta, { withDate: false }) }
      : { title: REPORT_TITLE, subtitle: mastheadSubtitle(jobs, meta) },
    toolbar: { roleTypes, tracks, quiet: jobs.length < 5, total: jobs.length },
    banner: meta.authExpired ? `${meta.authExpired.message}${meta.authExpired.deferred ? ` ${meta.authExpired.deferred} posting(s) were deferred to the next run and are not lost.` : ''}` : (meta.quota?.banner || null),
    cards,
    emptyMessage: 'No new postings cleared the configured threshold for this date.',
    runDetails: runDetailsView(jobs, meta, tracks),
    footer: `Generated locally. Scores are triage aids, not facts. Verify eligibility, posting date, and JD before applying. No applications were submitted.${meta.authExpired ? ` ${meta.authExpired.message}` : ''}`,
  };
}

export function buildHtml(jobs, meta) {
  return renderReportPage(buildReportView(jobs, meta));
}

export function warningsFileText(meta) {
  const warnings = meta.warnings || [];
  const header = `${REPORT_TITLE} — ${meta.date} — ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
  return `${[header, ...warnings.map(warningText)].join('\n')}\n`;
}

// warnings.txt exists only when the run has at least one warning; a rerun that cleared them removes it.
export async function writeWarningsFile(runDirectory, meta) {
  const file = path.join(runDirectory, WARNINGS_FILE_NAME);
  if (!(meta.warnings || []).length) {
    await fs.rm(file, { force: true });
    return null;
  }
  await fs.writeFile(file, warningsFileText(meta));
  return file;
}

export async function writeReports(jobs, allJobs, meta, outputDirectory) {
  const runDirectory = path.join(outputDirectory, meta.date);
  await fs.mkdir(runDirectory, { recursive: true });
  const reportBaseName = `${REPORT_TITLE} - ${meta.date}`;
  const htmlPath = path.join(runDirectory, `${reportBaseName}.html`);
  const legacyNames = [
    'daily-job-match-alert.json', 'daily-job-match-alert.csv', 'daily-job-match-alert.html', 'daily-job-match-alert.xlsx',
    'daily-job-match-alert.xlsx.inspect.ndjson',
    'job-radar.json', 'job-radar.csv', 'job-radar.html', 'job-radar.xlsx',
    'job-radar.xlsx.inspect.ndjson',
  ];
  await Promise.all([
    ...legacyNames.map(name => fs.rm(path.join(runDirectory, name), { force: true })),
    fs.rm(path.join(runDirectory, '.verification'), { recursive: true, force: true }),
    fs.rm(path.join(outputDirectory, 'latest.html'), { force: true }),
  ]);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-job-match-alert-report-'));
  const payloadPath = path.join(temporaryDirectory, 'report-payload.json');
  const [, , warningsPath] = await Promise.all([
    fs.writeFile(payloadPath, JSON.stringify({ meta, matches: jobs, reviewed: allJobs }, null, 2) + '\n'),
    fs.writeFile(htmlPath, buildHtml(jobs, meta)),
    writeWarningsFile(runDirectory, meta),
  ]);
  return { runDirectory, payloadPath, temporaryDirectory, reportBaseName, htmlPath, warningsPath };
}

export { jobScores };

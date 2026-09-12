// Assembles the daily HTML report from a payload: turns jobs and run metadata into view objects and
// hands them to report-components.mjs. Pipeline warnings are not rendered in the page; they go to
// warnings.txt beside it (see writeWarningsFile).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jobScores, reportTracks, trackScore } from './resume-tracks.mjs';
import { renderReportPage } from './report-components.mjs';
import { warningText } from './warnings.mjs';

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
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  try {
    return parsed.toLocaleString('en-US', { timeZone: timeZone || 'UTC', dateStyle: 'medium', timeStyle: 'short', hour12: false });
  } catch {
    return parsed.toISOString();
  }
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

function footnote(job) {
  const parts = [];
  if (job.postedAt) parts.push(`Posted ${String(job.postedAt).slice(0, 10)}`);
  else if (job.discoveredAt) parts.push(`Discovered ${String(job.discoveredAt).slice(0, 10)}`);
  if (job.source) parts.push(String(job.source));
  return parts.join(' · ');
}

export function cardView(job, tracks) {
  const scores = tracks.map(track => ({ id: track.id, label: track.label, value: trackScore(job, track.id), best: track.id === job.recommendedTrack }));
  if (!scores.some(score => score.best) && scores.length) {
    const top = scores.reduce((best, score) => (score.value > best.value ? score : best), scores[0]);
    top.best = true;
  }
  const recommendedTrack = job.recommendedTrack || scores.find(score => score.best)?.id || '';
  const recommendedLabel = job.recommendedResume || scores.find(score => score.best)?.label || '';
  const company = job.company || 'Company not resolved';
  return {
    title: job.title || 'Untitled posting',
    url: job.url,
    company,
    location: job.location || 'Location not stated',
    roleType: job.roleType || 'unknown',
    roleLabel: roleLabel(job.roleType),
    bestScore: Number(job.bestScore) || 0,
    scores,
    recommendedTrack,
    recommendation: recommendedLabel ? `Apply with ${recommendedLabel} Resume` : 'No Resume Recommended',
    badges: jobBadges(job),
    reasons: (job.reasons || []).map(String),
    gaps: (job.gaps || []).map(String),
    description: String(job.description || '').trim(),
    footnote: footnote(job),
    sort: {
      score: Number(job.bestScore) || 0,
      company: company.toLowerCase(),
      posted: postedEpoch(job),
      search: `${company} ${job.title || ''}`.toLowerCase(),
    },
  };
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
export function buildReportView(jobs, meta) {
  const tracks = reportTracks(meta, jobs);
  const cards = jobs.map(job => cardView(job, tracks));
  const roleTypes = [...new Set(jobs.map(job => job.roleType || 'unknown'))].map(value => ({ value, label: roleLabel(value) }));
  return {
    title: REPORT_TITLE,
    dateLabel: readableDate(meta.date),
    matchLabel: matchLabel(jobs.length),
    toolbar: { roleTypes, tracks, quiet: jobs.length < 5, total: jobs.length },
    cards,
    emptyMessage: 'No new postings cleared the configured threshold for this date.',
    runDetails: runDetailsView(jobs, meta, tracks),
    footer: 'Generated locally. Scores are triage aids, not facts. Verify eligibility, posting date, and JD before applying. No applications were submitted.',
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

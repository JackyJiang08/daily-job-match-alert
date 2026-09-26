import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { enabledResumeTracks, loadConfig, loadResumes } from './config.mjs';
import { syncResumes } from './resume-sync.mjs';
import { collectSimplifyList } from './collectors/simplify-github.mjs';
import { collectEmailFiles } from './collectors/email-files.mjs';
import { collectHimalaya } from './collectors/himalaya.mjs';
import { collectCareerOps } from './collectors/career-ops.mjs';
import { collectGithubList } from './collectors/github-lists.mjs';
import { collectHackerNewsHiring } from './collectors/hn-hiring.mjs';
import { collectRemoteOk } from './collectors/remoteok.mjs';
import { HACKER_NEWS_SOURCE, REMOTEOK_SOURCE, githubLists } from './collectors/catalog.mjs';
import { applyConfigBoards, collectAtsBoards, discoverBoards, readRegistry, registerBoards, registryPath, withinWindow, writeRegistry } from './collectors/ats-boards.mjs';
import { enrichJob, enrichmentWarningMessage } from './enrich.mjs';
import { evaluateJob, isEligible } from './match.mjs';
import { annotateEligibility, summarizeExclusions } from './eligibility.mjs';
import { applySubscriptionMatching, isSemanticCandidate, localFallbackJob, summarizeScoringModel } from './subscription-match.mjs';
import { normalizeEngineId } from './engines/index.mjs';
import { buildHtml, writeReports, writeWarningsFile } from './report.mjs';
import { clearDeferred, deferredStatus, expireDeferred, isJobSeen, markDeferred, markJobSeen, normalizeState, pruneSeen, releaseRecentBaselines } from './state.mjs';
import { acquireRunLock, releaseRunLock } from './lock.mjs';
import { canonicalUrl, dateWithOffset, htmlEscape, mapLimit, normalizeLocation, resolveFrom, sha256 } from './utils.mjs';
import { createWarning, errorSummary } from './warnings.mjs';
import { formatLocalDateTime } from './time-format.mjs';
import { holdsToExactWindow, resolveCompanyName } from './posting-fields.mjs';
import { describeConnections } from './engines/index.mjs';
import { describeQuota, normalizeQuotaPolicy } from './engines/quota.mjs';
import { AUTH_EXPIRED_MESSAGE, AUTH_EXPIRED_NOTIFICATION, classifyEngineError } from './engines/engine-errors.mjs';

const execFileAsync = promisify(execFile);
const REPORT_PAYLOAD_PREFIX = 'report-payload-';
const REPORT_PAYLOAD_PATTERN = /^report-payload-(\d{4}-\d{2}-\d{2})\.json$/;
export const DEFAULT_MAX_REVIEWED_PER_RUN = 120;
// A deferred posting may wait this long beyond the lookback window before it leaves the backlog unscored.
export const DEFAULT_DEFERRAL_GRACE_HOURS = 24;
// Nights in a row the in-window candidates must exceed the budget before the report says so.
export const BUDGET_ALERT_NIGHTS = 3;
export const BUDGET_HISTORY_NIGHTS = 7;
const BASELINE_RELEASE_HOURS = 48;

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function localTimeSeconds(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = type => Number(parts.find(item => item.type === type)?.value || 0);
  return (value('hour') % 24) * 3600 + value('minute') * 60 + value('second');
}

export function resolveRunDates(argv = process.argv, timeZone = 'America/Chicago', configuredOffsetDays = 1) {
  const now = new Date(arg(argv, '--now', new Date().toISOString()));
  if (Number.isNaN(now.getTime())) throw new Error('--now must be a valid ISO date');
  const reportDateOffsetDays = localTimeSeconds(now, timeZone) <= 14 * 60 * 60 ? 0 : Number(configuredOffsetDays);
  return {
    now,
    runDate: dateWithOffset(now, timeZone, 0),
    applicationDate: dateWithOffset(now, timeZone, reportDateOffsetDays),
    reportDateOffsetDays,
  };
}

async function readState(file) {
  try { return normalizeState(JSON.parse(await fs.readFile(file, 'utf8'))); } catch (error) {
    if (error.code === 'ENOENT') return { seen: {} };
    throw error;
  }
}

async function optionallyRunCareerOps(config, runner = execFileAsync) {
  const source = config.sources.careerOps;
  if (!source?.enabled || !source.runScanFirst) return;
  await runner(process.execPath, ['scan.mjs', '--since', String(Math.max(1, Math.ceil(config.lookbackHours / 24)))], {
    cwd: source.projectDirectory,
    timeout: 20 * 60 * 1000,
  });
}

// A posting is inside the lookback window when its source dates it (postedAt, or an approximate age)
// at or after the cutoff; a posting without any date counts as old.
export function insideLookbackWindow(job, cutoff, lookbackHours) {
  if (job?.postedAt) return new Date(job.postedAt) >= cutoff;
  if (job?.sourceAgeDays != null) return Number(job.sourceAgeDays) * 24 <= Number(lookbackHours);
  return false;
}

// Collects every enabled built-in source. When `options.sourceStats` is an array, one entry per source
// ({ name, kind, ok, count, error }) is pushed so the report can count postings by source. With
// `options.baseline = { state, now, lookbackHours }`, a source flagged `baseline` that has never been
// collected before marks the postings older than the lookback window as seen (recorded under
// state.sourceBaselines) and returns only the ones inside the window, so a newly enabled list does not
// flood one report with its backlog while its genuinely new postings still go through. A posting that
// another source collected this run is never swallowed by a baseline.
export async function collectEnabledSources(config, cutoff, options = {}) {
  const warnings = options.warnings || [];
  const sourceStats = Array.isArray(options.sourceStats) ? options.sourceStats : null;
  const userAgent = config.network?.userAgent || 'DailyJobMatchAlert/0.1';
  const collectors = {
    simplify: collectSimplifyList,
    emailFiles: collectEmailFiles,
    himalaya: collectHimalaya,
    careerOps: collectCareerOps,
    githubList: collectGithubList,
    hackerNewsHiring: collectHackerNewsHiring,
    remoteOk: collectRemoteOk,
    ...options.collectors,
  };
  const sources = [];
  if (config.sources.simplifyInternships?.enabled) sources.push({
    name: 'SimplifyJobs Summer Internships',
    collect: () => collectors.simplify({
      ...config.sources.simplifyInternships, source: 'SimplifyJobs Summer Internships', roleType: 'internship', warnings,
    }),
  });
  if (config.sources.simplifyNewGrad?.enabled) sources.push({
    name: 'SimplifyJobs New Grad',
    collect: () => collectors.simplify({
      ...config.sources.simplifyNewGrad, source: 'SimplifyJobs New Grad', roleType: 'new_grad', warnings,
    }),
  });
  for (const list of githubLists(config)) {
    if (!list.enabled) continue;
    sources.push({ name: list.name, baseline: true, collect: () => collectors.githubList({ url: list.url, source: list.name, roleType: list.roleType, format: list.format, warnings, userAgent }) });
  }
  if (config.sources.hackerNewsHiring?.enabled !== false) sources.push({
    name: HACKER_NEWS_SOURCE, baseline: true,
    collect: () => collectors.hackerNewsHiring({ warnings, userAgent, now: options.baseline?.now }),
  });
  if (config.sources.remoteOk?.enabled !== false) sources.push({
    name: REMOTEOK_SOURCE, baseline: true,
    collect: () => collectors.remoteOk({ warnings, userAgent }),
  });
  if (config.sources.emailFiles?.enabled) sources.push({
    name: 'Email files',
    collect: () => collectors.emailFiles(config.sources.emailFiles.directory, { warnings }),
  });
  if (config.sources.himalaya?.enabled) sources.push({
    name: 'Himalaya job-alert mailbox',
    collect: () => collectors.himalaya(config.sources.himalaya, cutoff),
  });
  if (config.sources.careerOps?.enabled) {
    if (config.sources.careerOps.runScanFirst) {
      try {
        await optionallyRunCareerOps(config, options.careerOpsRunner);
      } catch (error) {
        warnings.push(createWarning('collector', 'career-ops scan', errorSummary(error)));
      }
    }
    sources.push({
      name: 'career-ops history',
      collect: () => collectors.careerOps(config.sources.careerOps.scanHistoryPath, cutoff),
    });
  }

  const batches = await Promise.all(sources.map(async source => {
    try {
      const jobs = await source.collect();
      if (!Array.isArray(jobs)) throw new Error('collector returned a non-array result');
      return { source, jobs };
    } catch (error) {
      warnings.push(createWarning('collector', source.name, errorSummary(error)));
      return { source, jobs: [], error: errorSummary(error) };
    }
  }));
  const state = options.baseline?.state || null;
  const lookbackHours = Number(options.baseline?.lookbackHours ?? config.lookbackHours ?? 24);
  const isDeferred = job => Boolean(state) && deferredStatus(state, job).deferred;
  const needsBaseline = ({ source }) => source.baseline && state && !state.sourceBaselines?.[source.name];
  // Everything that reaches the normal flow this run: postings of established sources, plus the
  // in-window postings of sources that baseline tonight. A baseline may not mark any of these URLs.
  const normalUrls = new Set();
  for (const batch of batches) {
    for (const job of batch.jobs) {
      const url = canonicalUrl(job.url);
      if (url && (!needsBaseline(batch) || insideLookbackWindow(job, cutoff, lookbackHours) || isDeferred(job))) normalUrls.add(url);
    }
  }
  const collected = [];
  for (const batch of batches) {
    const { source, jobs } = batch;
    if (batch.error) {
      sourceStats?.push({ name: source.name, kind: 'builtin', ok: false, count: 0, error: batch.error });
      continue;
    }
    if (!needsBaseline(batch)) {
      sourceStats?.push({ name: source.name, kind: 'builtin', ok: true, count: jobs.length, error: null });
      collected.push(...jobs);
      continue;
    }
    const at = (options.baseline.now || new Date()).toISOString();
    const fresh = jobs.filter(job => insideLookbackWindow(job, cutoff, lookbackHours) || isDeferred(job));
    const old = jobs.filter(job => !fresh.includes(job) && !normalUrls.has(canonicalUrl(job.url)));
    for (const job of old) markJobSeen(state, { ...job, enrichment: 'source_baseline' }, at);
    state.sourceBaselines = { ...(state.sourceBaselines || {}), [source.name]: { baselinedAt: at, count: old.length } };
    warnings.push(createWarning('collector', source.name, `First collection recorded ${old.length} posting(s) older than the ${lookbackHours}-hour window as already seen (baseline); ${fresh.length} inside the window go through the normal flow`, 'info'));
    sourceStats?.push({ name: source.name, kind: 'builtin', ok: true, count: fresh.length, jobCount: jobs.length, baselineCount: old.length, baseline: true, error: null });
    collected.push(...fresh);
  }
  return collected;
}

// Public ATS boards: discover new boards from this run's posting URLs, apply the manual entries from
// config.sources.atsBoards, poll every active board once, and record the first poll of a board as a
// baseline (its postings are marked seen, never scored). Returns the postings to score plus one stat row
// per board; the registry is persisted before anything is scored.
export async function collectAtsBoardSources(config, state, collectedJobs, { now, warnings, sourceStats, fetchImpl } = {}) {
  const settings = config.sources.atsBoards || {};
  if (settings.enabled === false) return { jobs: [], results: [], registry: null };
  const file = registryPath(config);
  const registry = await readRegistry(file);
  registerBoards(registry, discoverBoards(collectedJobs), { now, origin: 'discovered' });
  applyConfigBoards(registry, settings.boards, { now });
  const polled = await collectAtsBoards({
    registry, settings, network: config.network, now, lookbackHours: config.lookbackHours, warnings,
    isSeen: job => isJobSeen(state, job),
    isDeferred: job => deferredStatus(state, job).deferred,
    excludeUrls: new Set(collectedJobs.map(job => canonicalUrl(job.url)).filter(Boolean)),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  for (const job of polled.baseline) markJobSeen(state, { ...job, enrichment: 'ats_baseline' }, now.toISOString());
  await writeRegistry(file, registry);
  for (const result of polled.results) {
    sourceStats?.push({ name: result.label, kind: 'ats', key: result.key, ok: result.ok, count: result.newCount, jobCount: result.jobCount, baseline: result.baseline, baselineCount: result.baselineCount, skipped: result.skipped, notModified: result.notModified, dormant: result.dormant, quiet: result.quiet, error: result.error });
  }
  return { jobs: polled.jobs, results: polled.results, registry };
}

function dedupe(jobs) {
  const found = new Map();
  for (const job of jobs) {
    if (!job) continue;
    const url = canonicalUrl(job.url);
    if (!url) continue;
    const key = sha256(url);
    const existing = found.get(key);
    // A second copy of the same posting only adds what it knows; blank fields never erase filled ones.
    const filled = Object.fromEntries(Object.entries(job).filter(([, value]) => value != null && value !== ''));
    found.set(key, existing ? {
      ...existing,
      ...filled,
      source: [...new Set(`${existing.source}|${job.source}`.split('|'))].join(' | '),
      company: job.company || existing.company,
      description: String(job.description || '').length > String(existing.description || '').length ? job.description : existing.description,
      url,
    } : { ...job, url });
  }
  return [...found.values()];
}

// Two tracked links that resolve to the same posting must not become two report rows; the first one wins
// and inherits the other's source label.
export function dedupeByFinalUrl(jobs) {
  const kept = new Map();
  const dropped = [];
  for (const job of jobs) {
    const key = sha256(canonicalUrl(job.finalUrl || job.url) || job.url);
    const existing = kept.get(key);
    if (!existing) {
      kept.set(key, job);
      continue;
    }
    const sources = [...new Set(`${existing.source}|${job.source}`.split('|').map(item => item.trim()).filter(Boolean))];
    kept.set(key, { ...existing, source: sources.join(' | ') });
    dropped.push({ url: job.originalUrl || job.url, finalUrl: job.finalUrl || job.url, source: job.source, duplicateOf: existing.originalUrl || existing.url });
  }
  return { jobs: [...kept.values()], dropped };
}

function statePathFor(config) {
  return path.join(config.root, 'state', 'state.json');
}

async function writeState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
}

async function buildXlsx(payloadPath, xlsxPath, cwd) {
  const xlsxBuilder = fileURLToPath(new URL('./report-xlsx.mjs', import.meta.url));
  await execFileAsync(process.execPath, [xlsxBuilder, payloadPath, xlsxPath], { cwd, timeout: 2 * 60 * 1000 });
}

// One payload file per application date holds everything reported for that day so far. Every run merges
// its own findings into it and renders the report from the merged whole, so a rerun that finds nothing
// new reproduces the earlier report instead of replacing it with an empty one. `complete` flips to true
// once both the HTML and the XLSX exist; an incomplete file is rebuilt at the start of the next run.
export function reportPayloadPath(config, date) {
  return path.join(config.root, 'state', `${REPORT_PAYLOAD_PREFIX}${date}.json`);
}

export async function readReportPayload(config, date) {
  let raw;
  try {
    raw = await fs.readFile(reportPayloadPath(config, date), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const payload = JSON.parse(raw);
  if (!payload?.meta?.date || !Array.isArray(payload.matches) || !Array.isArray(payload.reviewed)) {
    throw new Error('payload lacks meta.date, matches[], or reviewed[]');
  }
  return payload;
}

async function writeReportPayload(config, payload) {
  const file = reportPayloadPath(config, payload.meta.date);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n');
  return file;
}

export async function listReportPayloadDates(config) {
  let names;
  try {
    names = await fs.readdir(path.join(config.root, 'state'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.map(name => name.match(REPORT_PAYLOAD_PATTERN)?.[1]).filter(Boolean).sort();
}

// Payload files age out with the seen state: a day older than the retention window is never rerun.
export async function pruneReportPayloads(config, now = new Date(), retentionDays = 90) {
  const cutoff = new Date(now.getTime() - Number(retentionDays) * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const date of await listReportPayloadDates(config)) {
    const timestamp = new Date(`${date}T23:59:59Z`).getTime();
    if (!Number.isFinite(timestamp) || timestamp >= cutoff.getTime()) continue;
    await fs.rm(reportPayloadPath(config, date), { force: true });
    removed += 1;
  }
  return removed;
}

export function reportJobKey(job) {
  return sha256(canonicalUrl(job.finalUrl || job.url) || job.finalUrl || job.url);
}

// When the same posting is reported twice in one day, keep the copy with more information: a semantic
// review beats a local score, a longer captured description beats a shorter one, and otherwise the newer
// copy wins.
export function preferReportJob(existing, incoming) {
  const rank = job => (job.semanticReviewed ? 2 : 0) + (String(job.description || '').length > 0 ? 1 : 0);
  if (rank(incoming) !== rank(existing)) return rank(incoming) > rank(existing) ? incoming : existing;
  const incomingLength = String(incoming.description || '').length;
  const existingLength = String(existing.description || '').length;
  return incomingLength >= existingLength ? incoming : existing;
}

export function mergeReviewedJobs(existing, incoming) {
  const merged = new Map(existing.map(job => [reportJobKey(job), job]));
  for (const job of incoming) {
    const key = reportJobKey(job);
    const current = merged.get(key);
    merged.set(key, current ? preferReportJob(current, job) : job);
  }
  return [...merged.values()];
}

async function renderReports(config, payload, options = {}) {
  const { meta, matches, reviewed } = payload;
  const paths = await writeReports(matches, reviewed, meta, config.outputDirectory);
  const result = {
    runDirectory: paths.runDirectory,
    htmlPath: paths.htmlPath,
    xlsxPath: null,
    attemptedXlsxPath: null,
    xlsxError: null,
    xlsxFailurePath: path.join(paths.runDirectory, 'XLSX-FAILED.txt'),
  };
  try {
    if (config.reports?.xlsx?.enabled !== false) {
      result.attemptedXlsxPath = path.join(paths.runDirectory, `${paths.reportBaseName}.xlsx`);
      try {
        await (options.xlsxBuilder || buildXlsx)(paths.payloadPath, result.attemptedXlsxPath, config.root);
        result.xlsxPath = result.attemptedXlsxPath;
      } catch (error) {
        result.xlsxError = error;
      }
    }
  } finally {
    await fs.rm(paths.temporaryDirectory, { recursive: true, force: true });
  }
  if (!result.xlsxError) await fs.rm(result.xlsxFailurePath, { force: true });
  return result;
}

async function markPayloadComplete(config, payload, state, successAt) {
  payload.complete = true;
  await writeReportPayload(config, payload);
  state.lastSuccessfulRun = successAt;
  await writeState(statePathFor(config), state);
}

// Payload files left incomplete by an earlier day (its XLSX failed, or the run died before rendering) are
// rebuilt here without collecting or scoring anything. The current application date is skipped because
// the normal flow below merges into it and renders it anyway.
export async function recoverIncompleteReports(config, state, options = {}) {
  const warnings = options.warnings || [];
  const recovered = [];
  for (const date of await listReportPayloadDates(config)) {
    if (date === options.currentDate) continue;
    let payload;
    try {
      payload = await readReportPayload(config, date);
    } catch (error) {
      warnings.push(createWarning('report', 'report payload', `Discarded an unreadable ${REPORT_PAYLOAD_PREFIX}${date}.json: ${errorSummary(error)}`));
      await fs.rm(reportPayloadPath(config, date), { force: true });
      continue;
    }
    if (!payload || payload.complete === true) continue;
    const rendered = await renderReports(config, payload, options).catch(error => ({ xlsxError: error, htmlPath: null, xlsxPath: null }));
    if (rendered.xlsxError) {
      warnings.push(createWarning('report', 'report payload', `Could not rebuild the ${date} reports from ${REPORT_PAYLOAD_PREFIX}${date}.json; it was kept for the next run: ${errorSummary(rendered.xlsxError)}`));
      recovered.push({ date, recovered: false, htmlPath: rendered.htmlPath, xlsxPath: null });
      continue;
    }
    await markPayloadComplete(config, payload, state, payload.meta.lastUpdatedAt || payload.meta.generatedAt || state.lastSuccessfulRun);
    warnings.push(createWarning('report', 'report payload', `Rebuilt the ${date} HTML and XLSX from ${REPORT_PAYLOAD_PREFIX}${date}.json (update #${payload.meta.runsToday || 1} of that day); no postings were collected or scored again`));
    recovered.push({ date, recovered: true, htmlPath: rendered.htmlPath, xlsxPath: rendered.xlsxPath });
  }
  return recovered;
}

// Second freshness check, after enrichment: a posting whose own publish time is known to the minute
// (board APIs, JSON-LD datePosted with a clock time) must fall inside the lookback window; day-level
// sources keep the lenient rule. Dropped postings are not marked seen, so a still-old posting is dropped
// again next run and a deferred one is never dropped.
export function applyFreshnessRecheck(jobs, cutoff, isDeferred = () => false) {
  const kept = [];
  const dropped = [];
  for (const job of jobs) {
    const precise = holdsToExactWindow(job) && !isDeferred(job);
    if (precise && new Date(job.postedAt) < cutoff) dropped.push(job);
    else kept.push(job);
  }
  return { jobs: kept, dropped };
}

// What the report and the hub show about quota handling: every event of this run, the model and engine
// that ended up scoring, and how many postings the refusal pushed to the next run.
export function summarizeQuota(events, policy, config, deferredCount = 0) {
  const last = events.length ? events[events.length - 1] : null;
  const configuredModel = resolveModelFor(config);
  const downgrade = [...events].reverse().find(event => event.action === 'downgraded');
  const fallback = [...events].reverse().find(event => event.action === 'fallback-engine');
  return {
    events,
    lastEvent: last,
    effectiveEngine: fallback ? policy.fallbackEngine : (normalizeEngineId(config.semanticMatching?.engine || 'claude') || 'claude'),
    effectiveModel: fallback ? null : downgrade ? String(downgrade.detail || '').replace(/^switched to /, '') : configuredModel,
    configuredModel,
    modelLadder: policy.modelLadder,
    fallbackEngine: policy.fallbackEngine,
    deferredByQuota: deferredCount,
    banner: bannerFor(events, deferredCount, config.timeZone || 'America/Chicago'),
  };
}

function resolveModelFor(config) {
  const semantic = config.semanticMatching || {};
  const engineId = normalizeEngineId(semantic.engine || 'claude') || 'claude';
  return semantic.models?.[engineId] || semantic.model || (engineId === 'claude' ? 'fable' : null);
}

// A report banner only for an account-wide refusal (or a ladder that ran out), never for a wait that
// succeeded or a model downgrade, which Run Details already explains.
function bannerFor(events, deferredCount, timeZone) {
  const halted = [...events].reverse().find(event => event.action === 'deferred' || event.action === 'fallback-engine');
  if (!halted) return null;
  const parts = [describeQuota(halted, { timeZone })];
  if (halted.action === 'fallback-engine') parts.push(`the rest of the run was scored by ${halted.detail?.replace(/^switched to /, '') || 'the fallback engine'}`);
  else if (deferredCount) parts.push(`${deferredCount} posting(s) were deferred to the next run and are not lost`);
  return parts.join('; ');
}

export function finalizeCompany(job) {
  const resolved = resolveCompanyName(job);
  return { ...job, company: resolved.name || job.company || '', companySource: resolved.source, companyUncertain: resolved.uncertain, companyCandidates: resolved.candidates };
}

// How old a posting is, in hours, by its posting date or (day-level sources) its discovery time.
export function postingAgeHours(job, now = new Date()) {
  const basis = job?.postedAt || job?.discoveredAt || null;
  if (!basis) return null;
  const stamp = new Date(basis).getTime();
  return Number.isFinite(stamp) ? Math.max(0, (now.getTime() - stamp) / 3_600_000) : null;
}

// Freshness bucket: 0 for postings inside the lookback window (tonight's), 1 for anything older (the
// backlog). A posting with no date at all counts as tonight's, since only tonight's sources produce one.
export function freshnessBucket(job, now = new Date(), lookbackHours = 24) {
  const age = postingAgeHours(job, now);
  return age == null || age <= Number(lookbackHours) ? 0 : 1;
}

// Deferred postings that enrichment has now dated past the grace period leave the backlog unscored and
// unseen; the next collection drops them by the lookback window on its own.
export function applyBacklogExpiry(jobs, state, now = new Date(), maxAgeHours = 48) {
  const kept = [];
  const expired = [];
  for (const job of jobs) {
    const age = postingAgeHours(job, now);
    if (deferredStatus(state, job).deferred && age != null && age > Number(maxAgeHours)) { clearDeferred(state, job); expired.push(job); }
    else kept.push(job);
  }
  return { jobs: kept, expired };
}

// Keeps the best `limit` local candidates for the engine (0 or a non-number means no limit). Ranking:
// the freshness bucket first (tonight's postings always ahead of last night's backlog), then local best
// score with a bonus per deferral, and a twice-deferred posting ahead of its bucket-mates. Non-candidates
// (no role relevance or a hard blocker) never reach the engine and pass through as-is.
export function applyReviewBudget(jobs, state, configuredLimit, now = new Date(), { lookbackHours = 24 } = {}) {
  const limit = configuredLimit == null || configuredLimit === '' ? DEFAULT_MAX_REVIEWED_PER_RUN : Math.max(0, Math.floor(Number(configuredLimit)) || 0);
  const candidates = jobs.filter(isSemanticCandidate);
  const others = jobs.filter(job => !isSemanticCandidate(job));
  const ranked = candidates
    .map(job => ({ job, deferredCount: deferredStatus(state, job).deferredCount, bucket: freshnessBucket(job, now, lookbackHours) }))
    .sort((a, b) => (a.bucket - b.bucket)
      || (Number(b.deferredCount >= 2) - Number(a.deferredCount >= 2))
      || ((Number(b.job.bestScore) || 0) + 10 * b.deferredCount) - ((Number(a.job.bestScore) || 0) + 10 * a.deferredCount));
  const kept = limit > 0 ? ranked.slice(0, limit) : ranked;
  const deferred = limit > 0 ? ranked.slice(limit) : [];
  const at = now.toISOString();
  for (const entry of kept) clearDeferred(state, entry.job);
  for (const entry of deferred) markDeferred(state, entry.job, at);
  const ranking = ranked.map(entry => ({ url: entry.job.url, bucket: entry.bucket, bestScore: Number(entry.job.bestScore) || 0, deferredCount: entry.deferredCount, kept: kept.includes(entry) }));
  return {
    jobs: [...others, ...kept.map(entry => entry.job)], deferred: deferred.map(entry => entry.job),
    candidateCount: candidates.length, inWindowCount: ranked.filter(entry => entry.bucket === 0).length, reviewedCount: kept.length, limit, ranking,
  };
}

// One entry per application date (a same-day rerun overwrites its own), last seven kept. Returns the
// alert when the in-window candidates have exceeded a positive budget on the last three nights.
export function recordBudgetHistory(state, { date, at, candidates, inWindow, limit, reviewed }) {
  const history = (Array.isArray(state.budgetHistory) ? state.budgetHistory : []).filter(entry => entry && entry.date !== date);
  history.push({ date, at, candidates: Number(candidates) || 0, inWindow: Number(inWindow) || 0, limit: Number(limit) || 0, reviewed: Number(reviewed) || 0 });
  history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  state.budgetHistory = history.slice(-BUDGET_HISTORY_NIGHTS);
  const recent = state.budgetHistory.slice(-BUDGET_ALERT_NIGHTS);
  const over = recent.length === BUDGET_ALERT_NIGHTS && recent.every(entry => entry.limit > 0 && entry.inWindow > entry.limit);
  if (!over) return null;
  const curve = recent.map(entry => `${entry.date}: ${entry.inWindow}/${entry.limit}`).join(', ');
  return {
    nights: BUDGET_ALERT_NIGHTS,
    message: `Candidates inside the lookback window have exceeded the review budget for ${BUDGET_ALERT_NIGHTS} nights in a row (${curve}); raise semanticMatching.maxReviewedPerRun or tighten the prefilter`,
    history: state.budgetHistory,
  };
}

// The same requisition listed on several career-site paths (Workday multi-site postings): one company,
// one normalized title, one location, different URLs. The copy with the most description becomes the
// card; the others ride along as alternates. URL dedupe is untouched; this affects only the card and
// the review (one call instead of several).
const REQUISITION_ID = /\s*[\[(]?\b(?:R|JR|REQ|ID)?[-_ ]?\d{4,}[-_]?\d*\b[\])]?/gi;
function duplicateKey(job) {
  const company = String(job.company || '').toLowerCase().replace(/\b(?:inc|llc|ltd|corp|corporation|company|co|holdings|group|limited)\b\.?/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const title = String(job.title || '').toLowerCase().replace(REQUISITION_ID, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const location = normalizeLocation(job.location || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return company && title ? `${company}|${title}|${location}` : null;
}

export function mergeNearDuplicates(jobs) {
  const groups = new Map();
  const order = [];
  for (const job of jobs) {
    const key = duplicateKey(job);
    if (!key) { order.push({ primary: job, others: [] }); continue; }
    if (!groups.has(key)) { const group = { primary: job, others: [] }; groups.set(key, group); order.push(group); continue; }
    groups.get(key).others.push(job);
  }
  const merged = [];
  const report = [];
  let mergedCount = 0;
  for (const group of order) {
    if (!group.others.length) { merged.push(group.primary); continue; }
    const all = [group.primary, ...group.others];
    const best = [...all].sort((a, b) => String(b.description || '').length - String(a.description || '').length || String(a.postedAt || '').localeCompare(String(b.postedAt || '')))[0];
    const rest = all.filter(job => job !== best);
    const sources = [...new Set(all.flatMap(job => String(job.source || '').split(' | ')).map(item => item.trim()).filter(Boolean))];
    merged.push({ ...best, source: sources.join(' | '), alternates: [...(best.alternates || []), ...rest.map(job => ({ url: job.url, source: job.source || null, location: job.location || null }))] });
    mergedCount += rest.length;
    report.push({ primary: best.url, alternates: rest.map(job => job.url) });
  }
  return { jobs: merged, mergedCount, groups: report };
}

// Keeps the best `limit` local candidates for the engine

async function runPipeline(config, clock, options = {}) {
  const { now, runDate, applicationDate: date } = clock;
  const warnings = [];
  // Resume sync may recover an iCloud-evicted PDF; that disclosure belongs in the day's report.
  const resumeSync = await syncResumes(config, { warnings });
  const resumes = await loadResumes(config);
  const resumeTracks = enabledResumeTracks(config).map(track => ({ id: track.id, label: track.label }));
  const disabledTracks = (config.resumes?.tracks || []).filter(track => track.enabled === false).map(track => track.label);
  console.error(`Resume tracks: ${resumeTracks.map(track => track.label).join(', ')}${disabledTracks.length ? ` (disabled: ${disabledTracks.join(', ')})` : ''}`);
  await fs.mkdir(config.outputDirectory, { recursive: true });
  const statePath = statePathFor(config);
  const state = await readState(statePath);
  const cutoff = new Date(now.getTime() - config.lookbackHours * 60 * 60 * 1000);
  const debug = {};
  const prefs = config.preferences || {};

  const recoveredReports = await recoverIncompleteReports(config, state, { warnings, currentDate: date });
  if (recoveredReports.length) debug.recoveredReports = recoveredReports;
  // Baselines taken before in-window postings were exempt swallowed genuinely new postings; let them
  // through once. Idempotent: released entries are gone, so a later run finds nothing to release.
  const releasedBaselines = releaseRecentBaselines(state, now, BASELINE_RELEASE_HOURS);
  if (releasedBaselines) warnings.push(createWarning('collector', 'baseline', `released ${releasedBaselines} baseline postings for review`, 'info'));
  // The backlog only holds postings still worth reviewing: anything older than the lookback window plus
  // the grace period leaves the queue now (this also migrates queues written under the old one-week rule).
  const deferralMaxAgeHours = Number(config.lookbackHours || 24) + Number(config.deferralGraceHours ?? DEFAULT_DEFERRAL_GRACE_HOURS);
  const staleBacklog = expireDeferred(state, now, deferralMaxAgeHours);
  if (staleBacklog.removed) warnings.push(createWarning('llm', 'review budget', `expired ${staleBacklog.removed} backlog postings older than ${deferralMaxAgeHours} hours (not scored, not marked seen)`, 'info'));
  if (!prefs.graduationDate) {
    warnings.push(createWarning('eligibility', 'graduation window', 'preferences.graduationDate is not set, so the graduation-window hard filter is disabled and only the semantic review checks cohort wording'));
  }

  const sourceStats = [];
  const collectedRaw = await collectEnabledSources(config, cutoff, { warnings, sourceStats, baseline: { state, now, lookbackHours: config.lookbackHours } });
  const atsSources = await collectAtsBoardSources(config, state, collectedRaw, { now, warnings, sourceStats });
  // A baseline is only safe once the seen marks are on disk; otherwise a crash before the final state
  // write would let the next run score a source's whole backlog.
  await writeState(statePath, state);
  const collected = dedupe([...collectedRaw, ...atsSources.jobs]).filter(job => {
    // A posting deferred by the review budget is due whatever its age.
    if (deferredStatus(state, job).deferred) return true;
    if (job.sourceAgeDays != null && job.sourceAgeDays > Math.ceil(config.lookbackHours / 24)) return false;
    const timestamp = job.postedAt || job.discoveredAt;
    return !timestamp || new Date(timestamp) >= cutoff;
  });
  const unseenCandidates = collected.filter(job => !isJobSeen(state, job));
  const stamped = unseenCandidates.map(job => ({
    ...job,
    originalUrl: job.originalUrl || job.url,
    discoveredAt: job.discoveredAt || now.toISOString(),
  }));
  const enrichedCandidates = config.network.fetchDescriptions === false ? stamped : await mapLimit(
    stamped,
    Number(config.network.concurrency || 3),
    async job => {
      // A posting whose description came straight from a board or feed API needs no page fetch.
      if (job.enrichment === 'ats_api' || job.enrichment === 'source_api') return job;
      try {
        return await enrichJob(job, config.network);
      } catch (error) {
        return { ...job, enrichment: 'failed', enrichmentError: errorSummary(error) };
      }
    },
  );
  const unseenEnriched = enrichedCandidates.filter(job => {
    if (!isJobSeen(state, job)) return true;
    markJobSeen(state, job, now.toISOString());
    return false;
  });
  const deduped = dedupeByFinalUrl(unseenEnriched);
  if (deduped.dropped.length) {
    debug.droppedDuplicateFinalUrls = deduped.dropped;
    for (const item of deduped.dropped) console.warn(`Dropped ${item.url} (${item.source}): same final URL as ${item.duplicateOf}`);
  }
  const enriched = deduped.jobs.map(job => {
    if (job.enrichment !== 'failed') return job;
    const status = markJobSeen(state, job, now.toISOString());
    warnings.push(createWarning('enrichment', job.source || 'job posting', enrichmentWarningMessage(job, status)));
    return { ...job, enrichmentAttempts: status.attempts, enrichmentTerminal: status.completed };
  });
  const freshness = applyFreshnessRecheck(enriched, cutoff, job => deferredStatus(state, job).deferred);
  if (freshness.dropped.length) {
    warnings.push(createWarning('collector', 'freshness', `dropped ${freshness.dropped.length} postings after precise timestamps put them outside the ${config.lookbackHours}-hour window`, 'info'));
  }
  // A deferred posting whose enriched date now puts it past the grace period leaves the backlog here.
  const backlog = applyBacklogExpiry(freshness.jobs, state, now, deferralMaxAgeHours);
  const expiredBacklogCount = staleBacklog.removed + backlog.expired.length;
  if (backlog.expired.length) warnings.push(createWarning('llm', 'review budget', `expired ${backlog.expired.length} backlog postings after enrichment dated them past ${deferralMaxAgeHours} hours`, 'info'));
  // The same requisition on several career-site paths (Workday multi-site postings) is one card and one
  // review; the extra links ride along as alternates and are marked seen with the primary.
  const merged = mergeNearDuplicates(backlog.jobs);
  if (merged.mergedCount) debug.nearDuplicates = merged.groups;
  const locallyEvaluated = merged.jobs.map(job => evaluateJob(job, resumes, prefs));
  // Review budget: tonight's postings first (freshness bucket), then local score; the rest are deferred
  // (not marked seen) and come back next run while they are still inside the grace period.
  const budget = applyReviewBudget(locallyEvaluated, state, config.semanticMatching?.maxReviewedPerRun, now, { lookbackHours: config.lookbackHours });
  debug.reviewBudget = { kept: budget.ranking.filter(item => item.kept).map(item => ({ url: item.url, bucket: item.bucket, bestScore: item.bestScore, deferredCount: item.deferredCount })), deferred: budget.ranking.filter(item => !item.kept).map(item => ({ url: item.url, bucket: item.bucket, bestScore: item.bestScore, deferredCount: item.deferredCount })), expired: [...staleBacklog.urls, ...backlog.expired.map(job => job.url)] };
  if (budget.deferred.length) {
    warnings.push(createWarning('llm', 'review budget', `deferred ${budget.deferred.length} postings to the next run (review limit ${budget.limit} per run); they are not marked as seen`, 'info'));
  }
  const budgetAlert = recordBudgetHistory(state, { date, at: now.toISOString(), candidates: budget.candidateCount, inWindow: budget.inWindowCount, limit: budget.limit, reviewed: budget.reviewedCount });
  if (budgetAlert) warnings.push(createWarning('llm', 'review budget', budgetAlert.message));
  let evaluated;
  const quotaEvents = [];
  const quotaPolicy = normalizeQuotaPolicy(config.semanticMatching?.quotaPolicy);
  try {
    evaluated = await applySubscriptionMatching(budget.jobs, resumes, prefs, {
      ...(config.semanticMatching || {}),
      warnings,
      quotaEvents,
      now: () => new Date(),
      // The Codex fallback only runs when the CLI is installed and signed in with a ChatGPT subscription.
      fallbackConnected: async engineId => (await describeConnections({ ...(config.semanticMatching || {}) }))[engineId]?.connected === true,
    });
  } catch (error) {
    warnings.push(createWarning('llm', config.semanticMatching?.engine || 'subscription', `Semantic matching failed; all jobs used local fallback: ${errorSummary(error)}`));
    evaluated = budget.jobs.map(localFallbackJob);
  }
  // Postings a quota refusal left unscored wait for the next run like budget deferrals: never seen, never unreviewed.
  const quotaDeferred = evaluated.filter(job => job.quotaDeferred);
  for (const job of quotaDeferred) markDeferred(state, job, now.toISOString());
  evaluated = evaluated.filter(job => !job.quotaDeferred);
  const quota = summarizeQuota(quotaEvents, quotaPolicy, config, quotaDeferred.length);
  // An expired login is surfaced everywhere at once: the report, the hub, and a desktop notification.
  const authEvent = quotaEvents.find(event => event.kind === 'auth_expired') || null;
  const authExpired = authEvent ? { at: authEvent.at, notice: authEvent.detail || null, deferred: quotaDeferred.length, message: AUTH_EXPIRED_MESSAGE } : null;
  if (authExpired) {
    try {
      await (options.notifier || notifyAuthExpired)({ runner: options.notificationRunner });
    } catch (error) {
      console.warn(`Could not send the login-expired notification: ${errorSummary(error)}`);
    }
  }
  // Deterministic eligibility is applied after semantic review so the location gap survives the merge.
  evaluated = evaluated.map(job => annotateEligibility(job, prefs));
  // The company name is settled last: list name → board label → the scorer's employerName → cleaned
  // ATS entity → URL; nothing valid leaves the job marked uncertain for the card and the letter panel.
  evaluated = evaluated.map(job => finalizeCompany(job));

  // Fold this run into whatever the day already holds; the report is rendered from the merged whole.
  let previous = null;
  try {
    previous = await readReportPayload(config, date);
  } catch (error) {
    warnings.push(createWarning('report', 'report payload', `Ignored an unreadable ${REPORT_PAYLOAD_PREFIX}${date}.json and started the day's report over: ${errorSummary(error)}`));
  }
  const reviewed = previous ? mergeReviewedJobs(previous.reviewed, evaluated) : evaluated;
  for (const warning of previous?.meta?.warnings || []) {
    if (!warnings.some(item => warningTextEquals(item, warning))) warnings.push(warning);
  }
  reviewed.sort((a, b) => b.bestScore - a.bestScore);
  const matches = reviewed.filter(job => isEligible(job, config));
  const exclusions = summarizeExclusions(reviewed);
  const exclusionWarning = exclusions.total
    ? createWarning('eligibility', 'hard filter', `Excluded ${exclusions.total} posting(s) deterministically: ${exclusions.counts.location} outside the United States, ${exclusions.counts.graduation} outside the graduation window. ${exclusions.examples.slice(0, 5).join('; ')}${exclusions.examples.length > 5 ? '; …' : ''}`)
    : null;
  // The day's totals supersede any exclusion summary carried over from an earlier run today.
  const finalWarnings = warnings.filter(warning => !(warning.stage === 'eligibility' && warning.source === 'hard filter'));
  if (exclusionWarning) finalWarnings.push(exclusionWarning);
  const timeZone = config.timeZone || 'America/Chicago';
  const runsToday = Number(previous?.meta?.runsToday || 0) + 1;
  // How this run was started (the launchd dispatcher and the hub set the variable; a bare `npm run run` is manual).
  const trigger = ['scheduled', 'catchup', 'manual'].includes(process.env.DAILY_JOB_MATCH_ALERT_TRIGGER) ? process.env.DAILY_JOB_MATCH_ALERT_TRIGGER : 'manual';
  const meta = {
    generatedAt: now.toISOString(), date, applicationDate: date, runDate, timeZone, lookbackHours: config.lookbackHours,
    minimumMatchScore: config.minimumMatchScore, resumeSync, resumeTracks, collectedCount: collected.length,
    sourceCounts: sourceStats,
    newCount: reviewed.length, newThisRun: enriched.length, reviewedCount: reviewed.length, matchCount: matches.length,
    candidateCount: budget.candidateCount, candidateInWindowCount: budget.inWindowCount, reviewedThisRun: budget.reviewedCount, deferredCount: budget.deferred.length, expiredBacklogCount, maxReviewedPerRun: budget.limit,
    budgetAlert, budgetHistory: (state.budgetHistory || []).slice(-BUDGET_HISTORY_NIGHTS),
    droppedAfterPreciseTimestamps: freshness.dropped.length,
    quota,
    authExpired,
    warnings: finalWarnings,
    runsToday, firstGeneratedAt: previous?.meta?.firstGeneratedAt || now.toISOString(), lastUpdatedAt: now.toISOString(),
    trigger, completedAt: now.toISOString(), completedAtLocal: formatLocalDateTime(now, timeZone),
    eligibilityExclusions: exclusions.counts,
    excludedPostings: exclusions.examples,
    engine: normalizeEngineId(config.semanticMatching?.engine || 'claude') || String(config.semanticMatching?.engine),
    scoringModel: summarizeScoringModel(reviewed, normalizeEngineId(config.semanticMatching?.engine || 'claude') || 'claude'),
  };
  const payload = { meta, matches, reviewed, complete: false };

  // The payload is persisted before the postings are marked as seen, so a rerun can always rebuild the
  // day's report even though its postings will no longer be collected.
  await writeReportPayload(config, payload);
  for (const job of reviewed) {
    if (job.enrichment !== 'failed') markJobSeen(state, job, now.toISOString());
    for (const alternate of job.alternates || []) markJobSeen(state, { url: alternate.url, enrichment: 'near_duplicate' }, now.toISOString());
  }
  pruneSeen(state, now, 90);
  await pruneReportPayloads(config, now, 90);
  await writeState(statePath, state);

  const rendered = await renderReports(config, payload);
  const paths = { runDirectory: rendered.runDirectory, htmlPath: rendered.htmlPath, xlsxPath: rendered.xlsxPath };
  if (rendered.xlsxError) {
    const error = rendered.xlsxError;
    paths.xlsxFailurePath = rendered.xlsxFailurePath;
    paths.xlsxWarning = `XLSX generation failed; the HTML report and persisted seen state were preserved, and the day's payload stays in state/${REPORT_PAYLOAD_PREFIX}${date}.json so the next run rebuilds both files.`;
    finalWarnings.push(createWarning('report', 'XLSX', `${paths.xlsxWarning} ${errorSummary(error)}`));
    const failureText = [
      'Daily Job Match Alert XLSX generation failed.',
      `Generated at: ${now.toISOString()}`,
      `HTML report: ${paths.htmlPath}`,
      `Attempted XLSX: ${rendered.attemptedXlsxPath}`,
      `Day payload: ${reportPayloadPath(config, date)}`,
      '',
      error.stack || error.message || String(error),
      '',
    ].join('\n');
    try {
      await fs.writeFile(rendered.xlsxFailurePath, failureText);
    } catch (markerError) {
      paths.xlsxMarkerWarning = `Could not write XLSX-FAILED.txt: ${markerError.message}`;
      finalWarnings.push(createWarning('report', 'XLSX failure marker', paths.xlsxMarkerWarning));
    }
    try {
      await fs.writeFile(paths.htmlPath, buildHtml(matches, meta));
      await writeWarningsFile(rendered.runDirectory, meta);
    } catch (htmlUpdateError) {
      console.warn(`Could not add the XLSX warning to the report files: ${errorSummary(htmlUpdateError)}`);
    }
    console.warn(`${paths.xlsxWarning} ${error.message}`);
  } else {
    // Only a run that left both files on disk counts as a success for the catch-up logic.
    await markPayloadComplete(config, payload, state, now.toISOString());
  }

  const summary = { meta, ...paths, ...(Object.keys(debug).length ? { debug } : {}) };
  console.log(JSON.stringify(summary, null, 2));
  if (rendered.xlsxError) throw rendered.xlsxError;
  return summary;
}

function warningTextEquals(left, right) {
  return left?.stage === right?.stage && left?.source === right?.source && left?.message === right?.message;
}

export async function main(options = {}) {
  const argv = options.argv || process.argv;
  const configPath = arg(argv, '--config', 'config.json');
  const config = await loadConfig(configPath);
  const clock = resolveRunDates(argv, config.timeZone || 'America/Chicago', Number(config.reportDateOffsetDays ?? 1));
  const lock = await acquireRunLock(path.join(config.root, 'state', '.lock'), options.lockOptions);
  if (!lock.acquired) {
    console.warn(`Daily Job Match Alert is already running with PID ${lock.pid}; this invocation will exit.`);
    return { skipped: true, reason: 'active_lock', pid: lock.pid };
  }
  try {
    return await runPipeline(config, clock, options);
  } finally {
    try {
      await releaseRunLock(lock);
    } catch (error) {
      console.warn(`Could not release run lock; the next run will clear it as stale: ${errorSummary(error)}`);
    }
  }
}

async function fatalReportContext(argv) {
  const configPath = path.resolve(arg(argv, '--config', 'config.json'));
  let outputDirectory = path.resolve('daily-reports');
  let timeZone = 'America/Chicago';
  try {
    const config = await loadConfig(configPath);
    outputDirectory = config.outputDirectory;
    timeZone = config.timeZone || timeZone;
  } catch {
    try {
      const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
      outputDirectory = resolveFrom(path.dirname(configPath), raw.outputDirectory || './daily-reports');
      timeZone = raw.timeZone || timeZone;
    } catch {}
  }
  const requestedNow = new Date(arg(argv, '--now', new Date().toISOString()));
  const now = Number.isNaN(requestedNow.getTime()) ? new Date() : requestedNow;
  let runDate;
  try {
    runDate = dateWithOffset(now, timeZone, 0);
  } catch {
    timeZone = 'UTC';
    runDate = dateWithOffset(now, timeZone, 0);
  }
  return { outputDirectory, now, runDate, timeZone };
}

export async function writeFatalErrorReport(error, options = {}) {
  const context = await fatalReportContext(options.argv || process.argv);
  await fs.mkdir(context.outputDirectory, { recursive: true });
  const reportPath = path.join(context.outputDirectory, `ERROR-${context.runDate}.html`);
  const warning = createWarning('pipeline', 'fatal error', errorSummary(error, 1000));
  const stack = String(error?.stack || error?.message || error || 'Unknown fatal error').slice(0, 12_000);
  const authNote = classifyEngineError(error)?.kind === 'auth_expired' ? `<p><strong>${htmlEscape(AUTH_EXPIRED_MESSAGE)}</strong></p>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daily Job Match Alert failed — ${htmlEscape(context.runDate)}</title><style>body{margin:0;background:#f8fafc;color:#172033;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:900px;margin:48px auto;padding:0 20px}.panel{background:#fff;border:1px solid #fecaca;border-left:6px solid #dc2626;border-radius:14px;padding:24px;box-shadow:0 14px 40px #0f172a14}h1{margin:0 0 8px;font-size:28px}p{color:#475569}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff7ed;border-radius:10px;padding:16px;color:#7f1d1d}</style></head><body><main class="wrap"><section class="panel"><h1>Daily Job Match Alert did not complete</h1>${authNote}<p>${htmlEscape(warning.message)}</p><p>Run date: ${htmlEscape(context.runDate)} · Generated: ${htmlEscape(context.now.toISOString())}</p><pre>${htmlEscape(stack)}</pre><p>The scheduled catch-up path can retry this run. Existing reports and state were not deleted.</p></section></main></body></html>`;
  await fs.writeFile(reportPath, html);
  return reportPath;
}

// macOS notification for an expired Claude login; a no-op off macOS.
export async function notifyAuthExpired(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  const runner = options.runner || execFileAsync;
  await runner('osascript', ['-e', `display notification "${AUTH_EXPIRED_NOTIFICATION}" with title "Daily Job Match Alert"`], { timeout: 10_000 });
  return true;
}

export async function notifyFatalError(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  const runner = options.runner || execFileAsync;
  await runner('osascript', [
    '-e',
    'display notification "A fatal error report was written. The catch-up runner will retry later." with title "Daily Job Match Alert"',
  ], { timeout: 10_000 });
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    console.error(error.stack || error.message);
    try {
      const fatalReportPath = await writeFatalErrorReport(error, { argv: process.argv });
      console.error(`Fatal error report: ${fatalReportPath}`);
    } catch (reportError) {
      console.error(`Could not write fatal error report: ${errorSummary(reportError)}`);
    }
    try {
      await notifyFatalError({ argv: process.argv });
    } catch {}
    process.exitCode = 1;
  });
}

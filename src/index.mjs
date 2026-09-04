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
import { enrichJob, enrichmentWarningMessage } from './enrich.mjs';
import { evaluateJob, isEligible } from './match.mjs';
import { annotateEligibility, summarizeExclusions } from './eligibility.mjs';
import { applySubscriptionMatching, localFallbackJob, summarizeScoringModel } from './subscription-match.mjs';
import { buildHtml, writeReports } from './report.mjs';
import { isJobSeen, markJobSeen, normalizeState, pruneSeen } from './state.mjs';
import { acquireRunLock, releaseRunLock } from './lock.mjs';
import { canonicalUrl, dateWithOffset, htmlEscape, mapLimit, resolveFrom, sha256 } from './utils.mjs';
import { createWarning, errorSummary } from './warnings.mjs';

const execFileAsync = promisify(execFile);
const REPORT_PAYLOAD_PREFIX = 'report-payload-';
const REPORT_PAYLOAD_PATTERN = /^report-payload-(\d{4}-\d{2}-\d{2})\.json$/;

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

export async function collectEnabledSources(config, cutoff, options = {}) {
  const warnings = options.warnings || [];
  const collectors = {
    simplify: collectSimplifyList,
    emailFiles: collectEmailFiles,
    himalaya: collectHimalaya,
    careerOps: collectCareerOps,
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
      return jobs;
    } catch (error) {
      warnings.push(createWarning('collector', source.name, errorSummary(error)));
      return [];
    }
  }));
  return batches.flat();
}

function dedupe(jobs) {
  const found = new Map();
  for (const job of jobs) {
    if (!job) continue;
    const url = canonicalUrl(job.url);
    if (!url) continue;
    const key = sha256(url);
    const existing = found.get(key);
    found.set(key, existing ? {
      ...existing,
      ...job,
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

async function runPipeline(config, clock) {
  const { now, runDate, applicationDate: date } = clock;
  const resumeSync = await syncResumes(config);
  const resumes = await loadResumes(config);
  const resumeTracks = enabledResumeTracks(config).map(track => ({ id: track.id, label: track.label }));
  const disabledTracks = (config.resumes?.tracks || []).filter(track => track.enabled === false).map(track => track.label);
  console.error(`Resume tracks: ${resumeTracks.map(track => track.label).join(', ')}${disabledTracks.length ? ` (disabled: ${disabledTracks.join(', ')})` : ''}`);
  await fs.mkdir(config.outputDirectory, { recursive: true });
  const statePath = statePathFor(config);
  const state = await readState(statePath);
  const cutoff = new Date(now.getTime() - config.lookbackHours * 60 * 60 * 1000);
  const warnings = [];
  const debug = {};
  const prefs = config.preferences || {};

  const recoveredReports = await recoverIncompleteReports(config, state, { warnings, currentDate: date });
  if (recoveredReports.length) debug.recoveredReports = recoveredReports;
  if (!prefs.graduationDate) {
    warnings.push(createWarning('eligibility', 'graduation window', 'preferences.graduationDate is not set, so the graduation-window hard filter is disabled and only the semantic review checks cohort wording'));
  }

  const collected = dedupe(await collectEnabledSources(config, cutoff, { warnings })).filter(job => {
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
  const locallyEvaluated = enriched.map(job => evaluateJob(job, resumes, prefs));
  let evaluated;
  try {
    evaluated = await applySubscriptionMatching(locallyEvaluated, resumes, prefs, {
      ...(config.semanticMatching || {}),
      warnings,
    });
  } catch (error) {
    warnings.push(createWarning('llm', config.semanticMatching?.engine || 'subscription', `Semantic matching failed; all jobs used local fallback: ${errorSummary(error)}`));
    evaluated = locallyEvaluated.map(localFallbackJob);
  }
  // Deterministic eligibility is applied after semantic review so the location gap survives the merge.
  evaluated = evaluated.map(job => annotateEligibility(job, prefs));

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
  const meta = {
    generatedAt: now.toISOString(), date, applicationDate: date, runDate, timeZone, lookbackHours: config.lookbackHours,
    minimumMatchScore: config.minimumMatchScore, resumeSync, resumeTracks, collectedCount: collected.length,
    newCount: reviewed.length, newThisRun: enriched.length, reviewedCount: reviewed.length, matchCount: matches.length,
    warnings: finalWarnings,
    runsToday, firstGeneratedAt: previous?.meta?.firstGeneratedAt || now.toISOString(), lastUpdatedAt: now.toISOString(),
    eligibilityExclusions: exclusions.counts,
    scoringModel: summarizeScoringModel(reviewed, config.semanticMatching?.engine || 'claude_subscription'),
  };
  const payload = { meta, matches, reviewed, complete: false };

  // The payload is persisted before the postings are marked as seen, so a rerun can always rebuild the
  // day's report even though its postings will no longer be collected.
  await writeReportPayload(config, payload);
  for (const job of reviewed) {
    if (job.enrichment !== 'failed') markJobSeen(state, job, now.toISOString());
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
    } catch (htmlUpdateError) {
      console.warn(`Could not add the XLSX warning to HTML: ${errorSummary(htmlUpdateError)}`);
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
    return await runPipeline(config, clock);
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daily Job Match Alert failed — ${htmlEscape(context.runDate)}</title><style>body{margin:0;background:#f8fafc;color:#172033;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:900px;margin:48px auto;padding:0 20px}.panel{background:#fff;border:1px solid #fecaca;border-left:6px solid #dc2626;border-radius:14px;padding:24px;box-shadow:0 14px 40px #0f172a14}h1{margin:0 0 8px;font-size:28px}p{color:#475569}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff7ed;border-radius:10px;padding:16px;color:#7f1d1d}</style></head><body><main class="wrap"><section class="panel"><h1>Daily Job Match Alert did not complete</h1><p>${htmlEscape(warning.message)}</p><p>Run date: ${htmlEscape(context.runDate)} · Generated: ${htmlEscape(context.now.toISOString())}</p><pre>${htmlEscape(stack)}</pre><p>The scheduled catch-up path can retry this run. Existing reports and state were not deleted.</p></section></main></body></html>`;
  await fs.writeFile(reportPath, html);
  return reportPath;
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

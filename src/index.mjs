import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadResumes } from './config.mjs';
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
const PENDING_REPORT_FILE = 'pending-report.json';

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

function pendingReportPath(config) {
  return path.join(config.root, 'state', PENDING_REPORT_FILE);
}

async function writeState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
}

async function buildXlsx(payloadPath, xlsxPath, cwd) {
  const xlsxBuilder = fileURLToPath(new URL('./report-xlsx.mjs', import.meta.url));
  await execFileAsync(process.execPath, [xlsxBuilder, payloadPath, xlsxPath], { cwd, timeout: 2 * 60 * 1000 });
}

// A run whose XLSX failed leaves its full report payload in state/pending-report.json. Every later run,
// scheduled or catch-up, first rebuilds that day's HTML and XLSX from the payload (no collection, no
// scoring), then records the success and continues with its own work.
export async function recoverPendingReport(config, state, options = {}) {
  const pendingPath = pendingReportPath(config);
  const warnings = options.warnings || [];
  let raw;
  try {
    raw = await fs.readFile(pendingPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let pending;
  try {
    pending = JSON.parse(raw);
    if (!pending?.meta?.date || !Array.isArray(pending.matches) || !Array.isArray(pending.reviewed)) {
      throw new Error('payload lacks meta.date, matches[], or reviewed[]');
    }
  } catch (error) {
    warnings.push(createWarning('report', 'pending report', `Discarded an unreadable ${PENDING_REPORT_FILE}: ${errorSummary(error)}`));
    await fs.rm(pendingPath, { force: true });
    return null;
  }
  const { meta, matches, reviewed } = pending;
  try {
    const paths = await writeReports(matches, reviewed, meta, config.outputDirectory);
    let xlsxPath = null;
    try {
      if (config.reports?.xlsx?.enabled !== false) {
        xlsxPath = path.join(paths.runDirectory, `${paths.reportBaseName}.xlsx`);
        await (options.xlsxBuilder || buildXlsx)(paths.payloadPath, xlsxPath, config.root);
      }
      await fs.rm(path.join(paths.runDirectory, 'XLSX-FAILED.txt'), { force: true });
    } finally {
      await fs.rm(paths.temporaryDirectory, { recursive: true, force: true });
    }
    await fs.rm(pendingPath, { force: true });
    if (meta.generatedAt) state.lastSuccessfulRun = meta.generatedAt;
    await writeState(statePathFor(config), state);
    warnings.push(createWarning('report', 'pending report', `Regenerated the ${meta.date} HTML and XLSX from the payload left by the run at ${meta.generatedAt || 'an earlier time'}; no postings were collected or scored again`));
    return { date: meta.date, htmlPath: paths.htmlPath, xlsxPath, recovered: true, payload: pending };
  } catch (error) {
    warnings.push(createWarning('report', 'pending report', `Could not regenerate the ${meta.date} reports from ${PENDING_REPORT_FILE}; the payload was kept for the next run: ${errorSummary(error)}`));
    return { date: meta.date, htmlPath: null, xlsxPath: null, recovered: false, payload: pending };
  }
}

async function runPipeline(config, clock) {
  const { now, runDate, applicationDate: date } = clock;
  const resumeSync = await syncResumes(config);
  const resumes = await loadResumes(config);
  await fs.mkdir(config.outputDirectory, { recursive: true });
  const statePath = statePathFor(config);
  const state = await readState(statePath);
  const cutoff = new Date(now.getTime() - config.lookbackHours * 60 * 60 * 1000);
  const warnings = [];
  const debug = {};
  const prefs = config.preferences || {};

  const recovered = await recoverPendingReport(config, state, { warnings });
  if (recovered) debug.pendingReport = { date: recovered.date, recovered: recovered.recovered, htmlPath: recovered.htmlPath, xlsxPath: recovered.xlsxPath };
  // A pending payload for the same application date is folded into this run so the day ends with one
  // report instead of an empty rerun overwriting the recovered one.
  const carried = recovered?.date === date ? recovered.payload : null;
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
  let carriedCount = 0;
  if (carried) {
    const current = new Set(evaluated.map(job => sha256(canonicalUrl(job.url) || job.url)));
    const carriedReviewed = carried.reviewed
      .filter(job => !current.has(sha256(canonicalUrl(job.url) || job.url)))
      .map(job => annotateEligibility(job, prefs));
    carriedCount = carriedReviewed.length;
    evaluated = [...carriedReviewed, ...evaluated];
    for (const warning of carried.meta.warnings || []) {
      if (!warnings.some(item => warningTextEquals(item, warning))) warnings.push(warning);
    }
  }
  evaluated.sort((a, b) => b.bestScore - a.bestScore);
  const matches = evaluated.filter(job => isEligible(job, config));
  const exclusions = summarizeExclusions(evaluated);
  if (exclusions.total) {
    const detail = exclusions.examples.slice(0, 5).join('; ') + (exclusions.examples.length > 5 ? '; …' : '');
    warnings.push(createWarning('eligibility', 'hard filter', `Excluded ${exclusions.total} posting(s) deterministically: ${exclusions.counts.location} outside the United States, ${exclusions.counts.graduation} outside the graduation window. ${detail}`));
  }
  const timeZone = config.timeZone || 'America/Chicago';
  const meta = {
    generatedAt: now.toISOString(), date, applicationDate: date, runDate, timeZone, lookbackHours: config.lookbackHours,
    minimumMatchScore: config.minimumMatchScore, resumeSync, collectedCount: collected.length,
    newCount: enriched.length + carriedCount, reviewedCount: evaluated.length, matchCount: matches.length, warnings,
    eligibilityExclusions: exclusions.counts,
    scoringModel: summarizeScoringModel(evaluated, config.semanticMatching?.engine || 'claude_subscription'),
  };
  const paths = await writeReports(matches, evaluated, meta, config.outputDirectory);

  // The payload outlives the temporary directory until both report files exist, so a failed XLSX can be
  // rebuilt by the next run even though the postings below are already marked as seen.
  const pendingPath = pendingReportPath(config);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.copyFile(paths.payloadPath, pendingPath);
  for (const job of evaluated) {
    if (job.enrichment !== 'failed') markJobSeen(state, job, now.toISOString());
  }
  pruneSeen(state, now, 90);
  await writeState(statePath, state);

  const xlsxFailurePath = path.join(paths.runDirectory, 'XLSX-FAILED.txt');
  let xlsxFailure = null;
  try {
    await fs.rm(xlsxFailurePath, { force: true });
    if (config.reports?.xlsx?.enabled !== false) {
      const xlsxPath = path.join(paths.runDirectory, `${paths.reportBaseName}.xlsx`);
      try {
        await buildXlsx(paths.payloadPath, xlsxPath, config.root);
        paths.xlsxPath = xlsxPath;
      } catch (error) {
        xlsxFailure = error;
        paths.xlsxPath = null;
        paths.xlsxFailurePath = xlsxFailurePath;
        paths.xlsxWarning = `XLSX generation failed; the HTML report and persisted seen state were preserved, and the report payload was kept in state/${PENDING_REPORT_FILE} so the next run rebuilds both files.`;
        warnings.push(createWarning('report', 'XLSX', `${paths.xlsxWarning} ${errorSummary(error)}`));
        const failureText = [
          'Daily Job Match Alert XLSX generation failed.',
          `Generated at: ${now.toISOString()}`,
          `HTML report: ${paths.htmlPath}`,
          `Attempted XLSX: ${xlsxPath}`,
          `Pending payload: ${pendingPath}`,
          '',
          error.stack || error.message || String(error),
          '',
        ].join('\n');
        try {
          await fs.writeFile(xlsxFailurePath, failureText);
        } catch (markerError) {
          paths.xlsxMarkerWarning = `Could not write XLSX-FAILED.txt: ${markerError.message}`;
          warnings.push(createWarning('report', 'XLSX failure marker', paths.xlsxMarkerWarning));
        }
        try {
          await fs.writeFile(paths.htmlPath, buildHtml(matches, meta));
        } catch (htmlUpdateError) {
          console.warn(`Could not add the XLSX warning to HTML: ${errorSummary(htmlUpdateError)}`);
        }
        console.warn(`${paths.xlsxWarning} ${error.message}`);
      }
    }
  } finally {
    await fs.rm(paths.temporaryDirectory, { recursive: true, force: true });
    delete paths.payloadPath;
    delete paths.temporaryDirectory;
    delete paths.reportBaseName;
  }

  // Only a run that left both files on disk counts as a success for the catch-up logic.
  if (!xlsxFailure) {
    state.lastSuccessfulRun = now.toISOString();
    await writeState(statePath, state);
    await fs.rm(pendingPath, { force: true });
  }

  const summary = { meta, ...paths, ...(Object.keys(debug).length ? { debug } : {}) };
  console.log(JSON.stringify(summary, null, 2));
  if (xlsxFailure) throw xlsxFailure;
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

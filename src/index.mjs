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
import { enrichJob } from './enrich.mjs';
import { evaluateJob, isEligible } from './match.mjs';
import { applySubscriptionMatching, localFallbackJob, summarizeScoringModel } from './subscription-match.mjs';
import { buildHtml, writeReports } from './report.mjs';
import { isJobSeen, markJobSeen, normalizeState, pruneSeen } from './state.mjs';
import { acquireRunLock, releaseRunLock } from './lock.mjs';
import { canonicalUrl, dateWithOffset, htmlEscape, mapLimit, resolveFrom, sha256 } from './utils.mjs';
import { createWarning, errorSummary } from './warnings.mjs';

const execFileAsync = promisify(execFile);

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
      ...config.sources.simplifyInternships, source: 'SimplifyJobs Summer Internships', roleType: 'internship',
    }),
  });
  if (config.sources.simplifyNewGrad?.enabled) sources.push({
    name: 'SimplifyJobs New Grad',
    collect: () => collectors.simplify({
      ...config.sources.simplifyNewGrad, source: 'SimplifyJobs New Grad', roleType: 'new_grad',
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

async function runPipeline(config, clock) {
  const { now, runDate, applicationDate: date } = clock;
  const resumeSync = await syncResumes(config);
  const resumes = await loadResumes(config);
  await fs.mkdir(config.outputDirectory, { recursive: true });
  const statePath = path.join(config.root, 'state', 'state.json');
  const state = await readState(statePath);
  const cutoff = new Date(now.getTime() - config.lookbackHours * 60 * 60 * 1000);
  const warnings = [];

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
  const enriched = enrichedCandidates.filter(job => {
    if (!isJobSeen(state, job)) return true;
    markJobSeen(state, job, now.toISOString());
    return false;
  }).map(job => {
    if (job.enrichment !== 'failed') return job;
    const status = markJobSeen(state, job, now.toISOString());
    const label = [job.company, job.title].filter(Boolean).join(' — ') || job.url;
    warnings.push(createWarning(
      'enrichment',
      job.source || 'job posting',
      status.completed
        ? `${label} failed enrichment ${status.attempts} times and will not be retried: ${job.enrichmentError || 'unknown error'}`
        : `${label} enrichment attempt ${status.attempts}/3 failed and will be retried next run: ${job.enrichmentError || 'unknown error'}`,
    ));
    return { ...job, enrichmentAttempts: status.attempts, enrichmentTerminal: status.completed };
  });
  const locallyEvaluated = enriched.map(job => evaluateJob(job, resumes, config.preferences));
  let evaluated;
  try {
    evaluated = await applySubscriptionMatching(locallyEvaluated, resumes, config.preferences, {
      ...(config.semanticMatching || {}),
      warnings,
    });
  } catch (error) {
    warnings.push(createWarning('llm', config.semanticMatching?.engine || 'subscription', `Semantic matching failed; all jobs used local fallback: ${errorSummary(error)}`));
    evaluated = locallyEvaluated.map(localFallbackJob);
  }
  evaluated.sort((a, b) => b.bestScore - a.bestScore);
  const matches = evaluated.filter(job => isEligible(job, config));
  const timeZone = config.timeZone || 'America/Chicago';
  const meta = {
    generatedAt: now.toISOString(), date, applicationDate: date, runDate, timeZone, lookbackHours: config.lookbackHours,
    minimumMatchScore: config.minimumMatchScore, resumeSync, collectedCount: collected.length,
    newCount: enriched.length, reviewedCount: evaluated.length, matchCount: matches.length, warnings,
    scoringModel: summarizeScoringModel(evaluated, config.semanticMatching?.engine || 'claude_subscription'),
  };
  const paths = await writeReports(matches, evaluated, meta, config.outputDirectory);

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  for (const job of evaluated) {
    if (job.enrichment !== 'failed') markJobSeen(state, job, now.toISOString());
  }
  state.lastSuccessfulRun = now.toISOString();
  pruneSeen(state, now, 90);
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n');

  const xlsxFailurePath = path.join(paths.runDirectory, 'XLSX-FAILED.txt');
  let xlsxFailure = null;
  try {
    await fs.rm(xlsxFailurePath, { force: true });
    if (config.reports?.xlsx?.enabled !== false) {
      const xlsxPath = path.join(paths.runDirectory, `${paths.reportBaseName}.xlsx`);
      const xlsxBuilder = fileURLToPath(new URL('./report-xlsx.mjs', import.meta.url));
      try {
        await execFileAsync(process.execPath, [xlsxBuilder, paths.payloadPath, xlsxPath], {
          cwd: config.root,
          timeout: 2 * 60 * 1000,
        });
        paths.xlsxPath = xlsxPath;
      } catch (error) {
        xlsxFailure = error;
        paths.xlsxPath = null;
        paths.xlsxFailurePath = xlsxFailurePath;
        paths.xlsxWarning = 'XLSX generation failed; the HTML report and persisted seen state were preserved.';
        warnings.push(createWarning('report', 'XLSX', `${paths.xlsxWarning} ${errorSummary(error)}`));
        const failureText = [
          'Daily Job Match Alert XLSX generation failed.',
          `Generated at: ${now.toISOString()}`,
          `HTML report: ${paths.htmlPath}`,
          `Attempted XLSX: ${xlsxPath}`,
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

  console.log(JSON.stringify({ meta, ...paths }, null, 2));
  if (xlsxFailure) throw xlsxFailure;
  return { meta, ...paths };
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

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
import { applySubscriptionMatching } from './subscription-match.mjs';
import { writeReports } from './report.mjs';
import { isJobSeen, markJobSeen, normalizeState } from './state.mjs';
import { canonicalUrl, dateWithOffset, mapLimit, sha256 } from './utils.mjs';

const execFileAsync = promisify(execFile);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function readState(file) {
  try { return normalizeState(JSON.parse(await fs.readFile(file, 'utf8'))); } catch (error) {
    if (error.code === 'ENOENT') return { seen: {} };
    throw error;
  }
}

async function optionallyRunCareerOps(config) {
  const source = config.sources.careerOps;
  if (!source?.enabled || !source.runScanFirst) return;
  await execFileAsync(process.execPath, ['scan.mjs', '--since', String(Math.max(1, Math.ceil(config.lookbackHours / 24)))], {
    cwd: source.projectDirectory,
    timeout: 20 * 60 * 1000,
  });
}

function dedupe(jobs) {
  const found = new Map();
  for (const job of jobs) {
    const url = canonicalUrl(job.url);
    if (!url) continue;
    const key = sha256(url);
    const existing = found.get(key);
    found.set(key, existing ? {
      ...existing,
      ...job,
      source: [...new Set(`${existing.source}|${job.source}`.split('|'))].join(' | '),
      company: job.company || existing.company,
      description: job.description.length > existing.description.length ? job.description : existing.description,
      url,
    } : { ...job, url });
  }
  return [...found.values()];
}

async function main() {
  const configPath = arg('--config', 'config.json');
  const now = new Date(arg('--now', new Date().toISOString()));
  if (Number.isNaN(now.getTime())) throw new Error('--now must be a valid ISO date');
  const config = await loadConfig(configPath);
  const resumeSync = await syncResumes(config);
  const resumes = await loadResumes(config);
  await fs.mkdir(config.outputDirectory, { recursive: true });
  const statePath = path.join(config.root, 'state', 'state.json');
  const state = await readState(statePath);
  const cutoff = new Date(now.getTime() - config.lookbackHours * 60 * 60 * 1000);

  await optionallyRunCareerOps(config);
  const tasks = [];
  if (config.sources.simplifyInternships?.enabled) tasks.push(collectSimplifyList({
    ...config.sources.simplifyInternships, source: 'SimplifyJobs Summer Internships', roleType: 'internship',
  }));
  if (config.sources.simplifyNewGrad?.enabled) tasks.push(collectSimplifyList({
    ...config.sources.simplifyNewGrad, source: 'SimplifyJobs New Grad', roleType: 'new_grad',
  }));
  if (config.sources.emailFiles?.enabled) tasks.push(collectEmailFiles(config.sources.emailFiles.directory));
  if (config.sources.himalaya?.enabled) tasks.push(collectHimalaya(config.sources.himalaya, cutoff));
  if (config.sources.careerOps?.enabled) tasks.push(collectCareerOps(config.sources.careerOps.scanHistoryPath, cutoff));

  const collected = dedupe((await Promise.all(tasks)).flat()).filter(job => {
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
  const enrichedCandidates = config.network.fetchDescriptions === false ? stamped : await mapLimit(stamped, Number(config.network.concurrency || 3), job => enrichJob(job, config.network));
  const enriched = enrichedCandidates.filter(job => {
    if (!isJobSeen(state, job)) return true;
    markJobSeen(state, job, now.toISOString());
    return false;
  });
  const locallyEvaluated = enriched.map(job => evaluateJob(job, resumes, config.preferences));
  const evaluated = (await applySubscriptionMatching(locallyEvaluated, resumes, config.preferences, config.semanticMatching || {}))
    .sort((a, b) => b.bestScore - a.bestScore);
  const matches = evaluated.filter(job => isEligible(job, config));
  const timeZone = config.timeZone || 'America/Chicago';
  const runDate = dateWithOffset(now, timeZone, 0);
  const date = dateWithOffset(now, timeZone, Number(config.reportDateOffsetDays ?? 1));
  const meta = {
    generatedAt: now.toISOString(), date, applicationDate: date, runDate, timeZone, lookbackHours: config.lookbackHours,
    minimumMatchScore: config.minimumMatchScore, resumeSync, collectedCount: collected.length,
    newCount: enriched.length, reviewedCount: evaluated.length, matchCount: matches.length,
  };
  const paths = await writeReports(matches, evaluated, meta, config.outputDirectory);

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  for (const job of evaluated) markJobSeen(state, job, now.toISOString());
  state.lastSuccessfulRun = now.toISOString();
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
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

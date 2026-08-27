import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadResumes } from './config.mjs';
import { collectSimplifyList } from './collectors/simplify-github.mjs';
import { collectEmailFiles } from './collectors/email-files.mjs';
import { collectHimalaya } from './collectors/himalaya.mjs';
import { collectCareerOps } from './collectors/career-ops.mjs';
import { enrichJob } from './enrich.mjs';
import { evaluateJob, isEligible } from './match.mjs';
import { applySubscriptionMatching } from './subscription-match.mjs';
import { writeReports } from './report.mjs';
import { canonicalUrl, mapLimit, sha256 } from './utils.mjs';

const execFileAsync = promisify(execFile);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function currentDate(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

async function readState(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
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
  const newJobs = collected.filter(job => !state.seen[sha256(job.url)]);
  const stamped = newJobs.map(job => ({ ...job, discoveredAt: job.discoveredAt || now.toISOString() }));
  const enriched = config.network.fetchDescriptions === false ? stamped : await mapLimit(stamped, Number(config.network.concurrency || 3), job => enrichJob(job, config.network));
  const locallyEvaluated = enriched.map(job => evaluateJob(job, resumes, config.preferences));
  const evaluated = (await applySubscriptionMatching(locallyEvaluated, resumes, config.preferences, config.semanticMatching || {}))
    .sort((a, b) => b.bestScore - a.bestScore);
  const matches = evaluated.filter(job => isEligible(job, config));
  const date = currentDate(now);
  const meta = {
    generatedAt: now.toISOString(), date, lookbackHours: config.lookbackHours,
    minimumMatchScore: config.minimumMatchScore, collectedCount: collected.length,
    newCount: newJobs.length, reviewedCount: evaluated.length, matchCount: matches.length,
  };
  const paths = await writeReports(matches, evaluated, meta, config.outputDirectory);
  if (config.reports?.xlsx?.enabled !== false) {
    const xlsxPath = path.join(paths.runDirectory, 'job-radar.xlsx');
    const xlsxBuilder = fileURLToPath(new URL('./report-xlsx.mjs', import.meta.url));
    try {
      await execFileAsync(process.execPath, [xlsxBuilder, paths.jsonPath, xlsxPath], {
        cwd: config.root,
        timeout: 2 * 60 * 1000,
      });
      paths.xlsxPath = xlsxPath;
    } catch (error) {
      if (config.reports?.xlsx?.required) throw error;
      paths.xlsxPath = null;
      paths.xlsxWarning = 'XLSX writer unavailable; HTML, CSV, and JSON reports were still created.';
      console.warn(`${paths.xlsxWarning} ${error.message}`);
    }
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  for (const job of evaluated) state.seen[sha256(job.url)] = { url: job.url, firstSeen: now.toISOString() };
  state.lastSuccessfulRun = now.toISOString();
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ meta, ...paths }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

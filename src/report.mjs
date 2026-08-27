import fs from 'node:fs/promises';
import path from 'node:path';
import { csvEscape, htmlEscape } from './utils.mjs';

const COLUMNS = [
  ['source', 'Source'], ['roleType', 'Role Type'], ['postedAt', 'Posted At'], ['discoveredAt', 'Discovered At'],
  ['company', 'Company'], ['title', 'Title'], ['location', 'Location'], ['dataScore', 'Data Score'],
  ['aiScore', 'AI Score'], ['bestScore', 'Best Score'], ['recommendedResume', 'Resume'], ['reasons', 'Why It Matches'],
  ['gaps', 'Gaps'], ['blockers', 'Blockers'], ['url', 'Posting Link'], ['freshnessBasis', 'Freshness Basis'],
];

function flatten(value) {
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

export function buildCsv(jobs) {
  return [
    COLUMNS.map(([, label]) => csvEscape(label)).join(','),
    ...jobs.map(job => COLUMNS.map(([key]) => csvEscape(flatten(job[key]))).join(',')),
  ].join('\n') + '\n';
}

function jobCard(job) {
  const reasons = (job.reasons || []).map(item => `<li>${htmlEscape(item)}</li>`).join('');
  const gaps = (job.gaps || []).map(item => `<li>${htmlEscape(item)}</li>`).join('');
  return `<article class="job">
    <div class="score">${job.bestScore}</div>
    <div class="job-main">
      <div class="eyebrow">${htmlEscape(job.roleType)} · ${htmlEscape(job.source)}</div>
      <h2>${htmlEscape(job.title)}</h2>
      <p class="company">${htmlEscape(job.company || 'Company not resolved')} · ${htmlEscape(job.location || 'Location not stated')}</p>
      <div class="chips"><span>Data ${job.dataScore}</span><span>AI ${job.aiScore}</span><span>Use ${htmlEscape(job.recommendedResume)}</span></div>
      ${reasons ? `<h3>Match reasons</h3><ul>${reasons}</ul>` : ''}
      ${gaps ? `<details><summary>Gaps / verify before applying</summary><ul>${gaps}</ul></details>` : ''}
      <p class="meta">Freshness: ${htmlEscape(job.freshnessBasis)}${job.postedAt ? ` · ${htmlEscape(job.postedAt)}` : ''}</p>
      <a class="apply" href="${htmlEscape(job.url)}">Open original posting →</a>
    </div>
  </article>`;
}

export function buildHtml(jobs, meta) {
  const byType = Object.fromEntries(['internship', 'new_grad', 'entry_level'].map(type => [type, jobs.filter(job => job.roleType === type).length]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Job Radar — ${htmlEscape(meta.date)}</title><style>
  :root{--ink:#14213d;--muted:#64748b;--line:#dbe4ee;--accent:#0f766e;--soft:#f0fdfa;--warn:#fff7ed}*{box-sizing:border-box}
  body{margin:0;background:#f8fafc;color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1000px;margin:auto;padding:36px 20px 64px}
  header{background:linear-gradient(135deg,#0f766e,#164e63);color:#fff;border-radius:20px;padding:28px 30px;box-shadow:0 18px 50px #0f172a22}h1{margin:0 0 4px;font-size:32px}.sub{opacity:.85;margin:0}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 26px}.stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px}.stat b{display:block;font-size:25px}.stat span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
  .job{display:grid;grid-template-columns:68px 1fr;gap:18px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;margin:14px 0}.score{width:58px;height:58px;border-radius:50%;display:grid;place-items:center;background:var(--soft);color:var(--accent);font-size:22px;font-weight:750;border:2px solid #99f6e4}
  h2{font-size:21px;margin:2px 0}.eyebrow,.meta{color:var(--muted);font-size:12px}.company{margin:2px 0 10px}.chips{display:flex;gap:8px;flex-wrap:wrap}.chips span{background:#eef2ff;border-radius:999px;padding:4px 9px;font-size:12px}h3{font-size:13px;margin:14px 0 4px}ul{margin:4px 0 8px;padding-left:20px}.apply{display:inline-block;margin-top:10px;color:#fff;background:var(--accent);padding:8px 13px;border-radius:9px;text-decoration:none;font-weight:650}details{background:var(--warn);padding:8px 10px;border-radius:9px;margin-top:10px}
  .empty{padding:50px;text-align:center;background:#fff;border:1px dashed var(--line);border-radius:16px;color:var(--muted)}footer{color:var(--muted);font-size:12px;margin-top:30px}
  @media(max-width:650px){.stats{grid-template-columns:1fr 1fr}.job{grid-template-columns:1fr}.score{width:48px;height:48px}}
  </style></head><body><main class="wrap"><header><h1>Job Radar</h1><p class="sub">Data + AI/ML matches discovered in the last ${meta.lookbackHours} hours · ${htmlEscape(meta.date)}</p></header>
  <section class="stats"><div class="stat"><b>${jobs.length}</b><span>High matches</span></div><div class="stat"><b>${byType.internship}</b><span>Internships</span></div><div class="stat"><b>${byType.new_grad}</b><span>New grad</span></div><div class="stat"><b>${byType.entry_level}</b><span>Entry level</span></div></section>
  ${jobs.length ? jobs.map(jobCard).join('\n') : '<div class="empty">No new jobs cleared the configured threshold today.</div>'}
  <footer>Generated locally. Scores are triage aids, not facts. Verify eligibility, posting date, and JD before applying. No applications were submitted.</footer></main></body></html>`;
}

export async function writeReports(jobs, allJobs, meta, outputDirectory) {
  const runDirectory = path.join(outputDirectory, meta.date);
  await fs.mkdir(runDirectory, { recursive: true });
  const jsonPath = path.join(runDirectory, 'job-radar.json');
  const csvPath = path.join(runDirectory, 'job-radar.csv');
  const htmlPath = path.join(runDirectory, 'job-radar.html');
  await Promise.all([
    fs.writeFile(jsonPath, JSON.stringify({ meta, matches: jobs, reviewed: allJobs }, null, 2) + '\n'),
    fs.writeFile(csvPath, buildCsv(jobs)),
    fs.writeFile(htmlPath, buildHtml(jobs, meta)),
  ]);
  await fs.writeFile(path.join(outputDirectory, 'latest.html'), buildHtml(jobs, meta));
  return { runDirectory, jsonPath, csvPath, htmlPath };
}

export { COLUMNS };

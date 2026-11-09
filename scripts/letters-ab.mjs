#!/usr/bin/env node
// Letter rules A/B check (src/letters-ab.mjs): writes new letters with the v2 rules for the postings listed in a
// jobs file and puts each next to its old letter. Calls the real letter engines (the current Cover letter draft
// and editor assignments) once per posting; saves nothing to the letter store.
//   node scripts/letters-ab.mjs --config config.json --jobs private/review/ab-jobs.json [--out private/review/ab-<date>]
// The jobs file: [{ "date": "2026-11-08", "jobId": "<16 hex>", "label": "…", "old": { "paragraphs": [...],
// "editorNotes": [...], "track": "data", "pages": 1 } }]
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHubContext } from '../src/hub/server.mjs';
import { runLettersAb } from '../src/letters-ab.mjs';
import { localDate } from '../src/time-format.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const configPath = path.resolve(arg('config', 'config.json'));
const jobsPath = arg('jobs');
if (!jobsPath) {
  console.error('Usage: node scripts/letters-ab.mjs --config config.json --jobs <jobs.json> [--out <directory>]');
  process.exit(2);
}
const ctx = createHubContext({ configPath, timingLog: () => {} });
const config = await ctx.loadConfig();
const jobs = JSON.parse(await fs.readFile(path.resolve(jobsPath), 'utf8'));
const outDir = path.resolve(arg('out', path.join(ctx.root, 'private', 'review', `ab-${localDate(new Date(), config.timeZone || 'America/Chicago')}`)));
ctx.usageSource = 'letters-ab';
const result = await runLettersAb({ ctx, config, jobs, outDir, rulesVersion: 'v2', log: line => console.error(`[ab] ${line}`) });
console.log(result.summary);
console.log(`Written to ${outDir}`);

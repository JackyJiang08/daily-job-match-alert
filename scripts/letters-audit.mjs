#!/usr/bin/env node
// Letter overwrite audit (src/letters-audit.mjs), read only: lists postings whose letter was replaced by another
// posting's letter of the same company and date before letters were stored by job ID. Writes nothing unless --out
// is given (then only that Markdown file); never regenerates a letter. Every match counts (the letters of the signed-out
// nights 2026-10-26..29 were written for postings that are not model-reviewed high matches).
//   node scripts/letters-audit.mjs [--config config.json] [--out private/review/letter-overwrites-<date>.md]
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHubContext } from '../src/hub/server.mjs';
import { readReportPayload } from '../src/hub/services.mjs';
import { jobIdOf, letterCompanyFor } from '../src/hub/letters.mjs';
import { listPayloadFiles } from '../src/payload-store.mjs';
import { auditLetterOverwrites, auditMarkdown } from '../src/letters-audit.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const ctx = createHubContext({ configPath: path.resolve(arg('config', 'config.json')), timingLog: () => {} });
const letters = await ctx.letterStore.listLetters();
const letterDates = new Set(letters.map(letter => letter.date));
const days = [];
for (const { date } of await listPayloadFiles(ctx.root)) {
  if (!letterDates.has(date)) continue;
  const payload = await readReportPayload(ctx, date).catch(() => null);
  if (payload) days.push({ date, matches: payload.matches, autoLetters: payload.meta?.autoLetters || null });
}
const outreach = JSON.parse(await fs.readFile(path.join(ctx.root, 'private', 'outreach', 'state.json'), 'utf8').catch(() => '{}'));
const result = auditLetterOverwrites({ letters, days, outreachJobs: outreach.jobs || {}, jobIdOf, companyFor: letterCompanyFor, isCandidate: () => true });
const markdown = auditMarkdown(result);
const out = arg('out');
if (out) await fs.writeFile(path.resolve(out), markdown, { mode: 0o600 });
console.log(markdown);

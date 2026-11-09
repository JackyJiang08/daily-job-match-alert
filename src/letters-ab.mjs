// A/B check of a letter rules version (2026-11-08): for a handful of postings, write a new letter with the given
// rules (the current stage engines and models), render it, and put it next to the old letter with a summary
// table (needs-review notes, unverified details, words, pages, every automatic check, experiences used). Nothing
// is saved to the letter store, the Reach Out state is not touched, and no old letter is regenerated in place.
// Output: <outDir>/index.html (summary and side by side), summary.md, and per posting <slug>/old.md, new.md, new.pdf.
import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyEditorNotes } from './cover-letter/notes.mjs';
import { CHECK_IDS, CHECK_LABELS } from './cover-letter/checks.mjs';
import { checkLetter } from './cover-letter/generate-v2.mjs';
import { experiencesIn, resumeExperiences } from './cover-letter/evidence.mjs';
import { letterRulesSettings } from './cover-letter/availability.mjs';
import { enabledResumeTracks } from './config.mjs';
import { htmlEscape } from './utils.mjs';
import { findLetterJob, finishLetterV2, generateLetter, letterCompanyFor, resumeTextFor, v2RulesInputs } from './hub/letters.mjs';

function slugOf(text) {
  return String(text || 'letter').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'letter';
}

function words(paragraphs) {
  return (paragraphs || []).join(' ').split(/\s+/).filter(Boolean).length;
}

function unverifiedCount(notes) {
  return (notes || []).filter(note => /^\s*unverified detail\b/i.test(String(note))).length;
}

function letterText(paragraphs) {
  return (paragraphs || []).join('\n\n');
}

// The old letter's candid paragraph had no recorded position; the v1 rules opened it with "straightforward".
function oldCandidIndex(paragraphs) {
  return (paragraphs || []).findIndex(paragraph => /\bstraightforward\b/i.test(paragraph));
}

async function allExperiences(ctx, config) {
  const found = [];
  for (const track of enabledResumeTracks(config)) {
    const text = await ctx.io.readFile(track.profile, 'utf8').catch(() => '');
    for (const experience of resumeExperiences(text)) if (!found.some(item => item.name === experience.name)) found.push(experience);
  }
  return found;
}

// jobs: [{ date, jobId, label, old: { paragraphs, editorNotes, track, pages } }]
export async function runLettersAb({ ctx, config, jobs, outDir, rulesVersion = 'v2', log = () => {} }) {
  if (rulesVersion !== 'v2') throw new Error('The A/B check compares against the v2 rules');
  await fs.mkdir(outDir, { recursive: true });
  const { profile } = await ctx.letterStore.readiness();
  const timeZone = config.timeZone || 'America/Chicago';
  const experiences = await allExperiences(ctx, config);
  const rows = [];
  for (const item of jobs) {
    const { job } = await findLetterJob(ctx, item.date, item.jobId);
    const label = item.label || `${letterCompanyFor(job).name} · ${job.title}`;
    const directory = path.join(outDir, slugOf(label));
    await fs.mkdir(directory, { recursive: true });
    log(`${label}: drafting with the ${rulesVersion} rules`);
    const draft = await generateLetter(ctx, { date: item.date, jobId: item.jobId, trackId: null, company: letterCompanyFor(job).name, rulesVersion, saveOutreach: false });
    const finished = await finishLetterV2(ctx, config, { job, trackId: draft.track.id, profile, company: draft.company, paragraphs: draft.paragraphs, now: ctx.now(), timeZone, pdfPath: path.join(directory, 'new.pdf'), engine: draft.engine, rules: draft.rules, editorNotes: draft.editorNotes });
    await fs.writeFile(path.join(directory, 'new.md'), finished.letter.markdown);
    const old = item.old || {};
    const oldTrack = old.track || job.recommendedTrack || draft.track.id;
    const { text: oldResume } = await resumeTextFor(ctx, config, oldTrack);
    const { playbook } = await ctx.letterStore.loadMaterial({ rulesVersion: 'v2' });
    const oldInputs = { job, resumeText: oldResume, playbook, rules: await v2RulesInputs(ctx, config, { job, trackId: oldTrack, resumeText: oldResume, settings: letterRulesSettings(config), withRecent: false }) };
    const oldChecks = checkLetter(old.paragraphs || [], oldInputs, { candidParagraphIndex: oldCandidIndex(old.paragraphs), candidGaps: [], pages: old.pages ?? null });
    await fs.writeFile(path.join(directory, 'old.md'), letterText(old.paragraphs));
    const oldNotes = classifyEditorNotes(old.editorNotes || []);
    const newNotes = classifyEditorNotes(finished.editorNotes);
    const row = {
      label, slug: path.basename(directory), job: { title: job.title, company: letterCompanyFor(job).name, roleType: job.roleType },
      old: { track: oldTrack, needsReview: oldNotes.needsReview.length, unverified: unverifiedCount(old.editorNotes), words: words(old.paragraphs), pages: old.pages ?? null, checks: oldChecks.results, experiences: experiencesIn(letterText(old.paragraphs), experiences), paragraphs: old.paragraphs || [], notes: old.editorNotes || [] },
      new: { track: draft.track.id, needsReview: newNotes.needsReview.length, unverified: unverifiedCount(finished.editorNotes), words: words(finished.paragraphs), pages: finished.pdf.pages, checks: finished.checks, experiences: experiencesIn(letterText(finished.paragraphs), experiences), paragraphs: finished.paragraphs, notes: finished.editorNotes, company: draft.company, engine: `${draft.engine} · ${draft.model}${draft.effort ? ` · ${draft.effort}` : ''}`, editor: draft.reviewModel ? `${draft.reviewEngine} · ${draft.reviewModel}${draft.reviewEffort ? ` · ${draft.reviewEffort}` : ''}` : 'none', pdfNote: finished.pdf.note || null },
    };
    rows.push(row);
    log(`${label}: ${row.new.words} words, ${row.new.pages} page(s), ${row.new.needsReview} needs-review`);
  }
  const summary = summaryMarkdown(rows, { rulesVersion });
  await fs.writeFile(path.join(outDir, 'summary.md'), summary);
  await fs.writeFile(path.join(outDir, 'index.html'), indexHtml(rows, { rulesVersion }));
  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(rows.map(({ old, new: next, ...rest }) => ({ ...rest, old: { ...old, paragraphs: undefined }, new: { ...next, paragraphs: undefined } })), null, 2)}\n`);
  return { rows, summary, outDir };
}

const mark = value => (value === true ? 'pass' : value === false ? 'FAIL' : 'n/a');

export function summaryMarkdown(rows, { rulesVersion = 'v2' } = {}) {
  const head = ['Posting', 'Version', 'Track', 'Needs-Review', 'Unverified', 'Words', 'Pages', ...CHECK_IDS.map(id => CHECK_LABELS[id]), 'Experiences'];
  const line = cells => `| ${cells.join(' | ')} |`;
  const out = [`# Letter A/B: v1 (old) vs ${rulesVersion} (new)`, '', line(head), line(head.map(() => '---'))];
  for (const row of rows) {
    for (const [name, side] of [['old (v1)', row.old], [`new (${rulesVersion})`, row.new]]) {
      out.push(line([row.label, name, side.track, side.needsReview, side.unverified, side.words, side.pages ?? 'n/a', ...CHECK_IDS.map(id => mark(side.checks?.[id])), side.experiences.join(', ') || 'none']));
    }
  }
  const total = side => rows.reduce((sum, row) => sum + row[side].needsReview, 0);
  const fails = side => rows.reduce((sum, row) => sum + CHECK_IDS.filter(id => row[side].checks?.[id] === false).length, 0);
  out.push('', `Totals: needs-review ${total('old')} (old) → ${total('new')} (new); failed checks ${fails('old')} → ${fails('new')}.`,
    'The old letters\' checks were run with the v2 checks for comparison (their candid paragraph is the one that says "straightforward"); their needs-review counts are the editor notes they were saved with.');
  return `${out.join('\n')}\n`;
}

function indexHtml(rows, { rulesVersion }) {
  const column = (title, side) => `<div class="col"><h3>${htmlEscape(title)}</h3><p class="meta">${htmlEscape(side.track)} · ${side.words} words · ${side.pages ?? 'n/a'} page(s) · ${side.needsReview} needs-review</p>${side.paragraphs.map(p => `<p>${htmlEscape(p)}</p>`).join('')}<h4>Notes</h4><ul>${(side.notes || []).map(note => `<li>${htmlEscape(note)}</li>`).join('') || '<li>none</li>'}</ul></div>`;
  const table = summaryMarkdown(rows, { rulesVersion }).split('\n').filter(line => line.startsWith('|') && !/^\|\s*---/.test(line));
  const tableHtml = `<table>${table.map((line, index) => `<tr>${line.split('|').slice(1, -1).map(cell => index ? `<td>${htmlEscape(cell.trim())}</td>` : `<th>${htmlEscape(cell.trim())}</th>`).join('')}</tr>`).join('')}</table>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Letter A/B</title><style>
body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:24px;color:#1c2430}table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #d0d5dd;padding:4px 6px;vertical-align:top}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:16px 0 40px}.col{background:#f6f7f9;padding:12px 16px;border-radius:8px}.meta{color:#5b6472;font-size:12px}h2{margin-top:40px}
</style></head><body><h1>Letter A/B: v1 (old) vs ${htmlEscape(rulesVersion)} (new)</h1>${tableHtml}
${rows.map(row => `<h2>${htmlEscape(row.label)}</h2><p class="meta">New: ${htmlEscape(row.new.engine)}; editor ${htmlEscape(row.new.editor)}${row.new.pdfNote ? `; ${htmlEscape(row.new.pdfNote)}` : ''}</p><div class="pair">${column('Old (v1)', row.old)}${column(`New (${rulesVersion})`, row.new)}</div>`).join('\n')}
</body></html>`;
}

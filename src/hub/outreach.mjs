// Message to Recruiters (2026-11-08, people list 2026-11-16): the services behind the Reports page's drawer.
// Hard limits: nothing here requests, fetches, or signs in to linkedin.com, and nothing is ever sent; the hub
// lists people found through the search API (src/outreach/people.mjs) and the text for each, and the owner
// does the rest in the browser. State lives in private/outreach/state.json (src/outreach/store.mjs).
import { enabledResumeTracks } from '../config.mjs';
import { readRegistry, registryPath } from '../collectors/ats-boards.mjs';
import { resolveCompanyName } from '../posting-fields.mjs';
import { digestPath } from '../resume-digest.mjs';
import { extractJdContacts } from '../outreach/contacts.mjs';
import { connectionNoteLimit } from '../outreach/messages.mjs';
import { BIG_COMPANY_JOBS, fallbackSearches, findPeople, outreachProfile, peopleCached, postingPeople, peopleSearchStatus, readPeopleUsage, peopleSearchSettings } from '../outreach/people.mjs';
import { contactedLabel, readOutreach, updateOutreach } from '../outreach/store.mjs';
import { findLetterJob, initialShortName, letterCompanyFor } from './letters.mjs';
import { HubInputError } from './services.mjs';
import { outreachPanel, peopleSection } from './outreach-views.mjs';

// Everything a people search for one posting needs: the short name, the names to recognize the company by,
// the owner's schools, the JD contacts, and whether the company is large (its board lists > 200 postings).
async function searchInputs(ctx, config, job) {
  const readiness = await ctx.letterStore.readiness().catch(() => ({ profile: {} }));
  const aliases = readiness.profile?.companyAliases || [];
  const company = initialShortName(job, aliases).name || letterCompanyFor(job).name || job.company || '';
  const chain = [letterCompanyFor(job).name, job.company, ...resolveCompanyName(job).candidates.filter(item => item.source !== 'url').map(item => item.value)].filter(Boolean);
  const lower = new Set([company, ...chain].map(name => String(name).toLowerCase()));
  const aliasNames = aliases.filter(item => lower.has(String(item.full || '').toLowerCase()) || lower.has(String(item.short || '').toLowerCase())).flatMap(item => [item.full, item.short]);
  const digests = [];
  for (const track of enabledResumeTracks(config)) {
    const text = await ctx.io.readFile(digestPath(config.root || ctx.root, track.id), 'utf8').catch(() => null);
    if (text) digests.push(text);
  }
  let bigCompany = false;
  if (job.board) {
    const registry = await readRegistry(registryPath({ ...config, root: config.root || ctx.root }), ctx.io).catch(() => null);
    bigCompany = Number(registry?.boards?.[job.board]?.lastJobCount || 0) > BIG_COMPANY_JOBS;
  }
  return { company, companyNames: [...chain, ...aliasNames], profile: outreachProfile({ digests, config }), contacts: extractJdContacts(job.description), bigCompany };
}

function rootConfig(ctx, config) {
  return config.root ? config : { ...config, root: ctx.root };
}

// One search per posting at a time: a second open of the same panel waits for the first.
const inFlight = new Map();

async function runSearch(ctx, config, job, id, inputs) {
  if (!inFlight.has(id)) {
    const work = findPeople({ root: ctx.root, config, job, ...inputs, io: ctx.io, fetchImpl: ctx.fetchImpl, now: ctx.now(), timeoutMs: ctx.peopleTimeoutMs }).finally(() => inFlight.delete(id));
    inFlight.set(id, work);
  }
  return inFlight.get(id);
}

function sectionView(result, inputs, job, entry) {
  return { people: result.people, status: result.status, fallback: fallbackSearches({ company: inputs.company, job, profile: inputs.profile }), copied: entry?.copied || {}, fellow: inputs.profile.schools[0]?.short || '' };
}

// The panel. People come straight from the cache when every query is there, or when no search can run (no key,
// switched off, cap reached: the three Find buttons); otherwise the panel says "Finding People…" and its
// script asks POST /outreach/people.
export async function outreachPanelHtml(ctx, { date, jobId }) {
  const config = rootConfig(ctx, await ctx.loadConfig());
  const { job, id } = await findLetterJob(ctx, date, jobId);
  const inputs = await searchInputs(ctx, config, job);
  const entry = (await readOutreach(ctx.root, ctx.io)).jobs[id] || {};
  const status = await peopleSearchStatus(ctx.root, config, { io: ctx.io, now: ctx.now() });
  const ready = !status.available || await peopleCached({ root: ctx.root, company: inputs.company, job, profile: inputs.profile, io: ctx.io, now: ctx.now() });
  const section = ready
    ? sectionView(await runSearch(ctx, config, job, id, inputs), inputs, job, entry)
    : { loading: true, people: postingPeople(inputs.contacts), copied: entry.copied || {}, fallback: fallbackSearches({ company: inputs.company, job, profile: inputs.profile }) };
  return outreachPanel({ date, jobId: id, job, company: inputs.company, section, entry, limit: connectionNoteLimit(config) });
}

// POST /outreach/people: the search (cached queries cost nothing). A failed or capped search is not an error
// here: the section falls back to the three Find buttons.
export async function peopleHtml(ctx, { date, jobId }) {
  const config = rootConfig(ctx, await ctx.loadConfig());
  const { job, id } = await findLetterJob(ctx, date, jobId);
  const inputs = await searchInputs(ctx, config, job);
  const entry = (await readOutreach(ctx.root, ctx.io)).jobs[id] || {};
  const result = await runSearch(ctx, config, job, id, inputs);
  return { status: result.status, calls: result.calls, html: peopleSection(sectionView(result, inputs, job, entry)) };
}

function validJobId(value) {
  const id = String(value || '');
  if (!/^[a-f0-9]{16}$/.test(id)) throw new HubInputError('Invalid job id');
  return id;
}

// A row's copy icon: the person is marked copied (the row fades and shows a check), and the first copy for a
// posting sets contactedAt, which the card shows as "Contacted Nov 8".
export async function markCopied(ctx, { jobId, person }) {
  const config = await ctx.loadConfig();
  const key = String(person || '');
  if (!/^[\p{L}\p{N}%._-]{1,100}$/u.test(key)) throw new HubInputError('Invalid person');
  const entry = await updateOutreach(ctx.root, validJobId(jobId), item => {
    const at = ctx.now().toISOString();
    item.copied = { ...(item.copied && typeof item.copied === 'object' ? item.copied : {}), [key]: at };
    item.contactedAt = item.contactedAt || at;
  }, { io: ctx.io, now: ctx.now() });
  return { copied: key, label: contactedLabel(entry, config.timeZone || 'America/Chicago') };
}

// For the cards: job id → "Contacted Nov 8" (labels) and a signature of the map for the render cache key.
export async function contactedByJob(ctx, timeZone) {
  const state = await readOutreach(ctx.root, ctx.io);
  const labels = new Map();
  for (const [id, entry] of Object.entries(state.jobs)) {
    const label = contactedLabel(entry, timeZone);
    if (label) labels.set(id, label);
  }
  return { labels, version: [...labels].map(([id, label]) => `${id}:${label}`).sort().join(',') };
}

// Settings > Cover Letters "Message to Recruiters": the note limit and the people search (switch and cap).
export function validateOutreachSettings(form) {
  const limit = Number(form.connectionNoteLimit);
  if (!Number.isInteger(limit) || limit < 100 || limit > 300) throw new HubInputError('Connection note limit must be a whole number from 100 to 300 characters');
  const cap = Number(form.peopleSearchCap ?? 300);
  if (!Number.isInteger(cap) || cap < 0 || cap > 10000) throw new HubInputError('People search monthly cap must be a whole number from 0 to 10000');
  const on = value => value === 'on' || value === 'true' || value === true;
  return { connectionNoteLimit: limit, peopleSearch: { enabled: on(form.peopleSearch), monthlyCap: cap } };
}

// The Settings card's view: the saved values, this month's use, and whether a key is there.
export async function outreachSettingsView(ctx, config) {
  const withRoot = rootConfig(ctx, config);
  const settings = peopleSearchSettings(withRoot);
  const usage = await readPeopleUsage(ctx.root, withRoot, { io: ctx.io, now: ctx.now() });
  const status = await peopleSearchStatus(ctx.root, withRoot, { io: ctx.io, now: ctx.now() });
  return { connectionNoteLimit: connectionNoteLimit(config), peopleSearch: settings, usage, keyMissing: status.reason === 'no-key' };
}

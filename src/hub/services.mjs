// Data layer for the hub. Reads pipeline artifacts (payloads, state, logs, Desktop folders) read-only;
// writes only config.json (through config-file.mjs, under the run lock) and the hub's own private
// directory (uploaded PDFs, hub-state.json, run logs). Every filesystem call goes through ctx.io so
// tests can point the hub at a temporary project.
import path from 'node:path';
import { enabledResumeTracks, normalizeResumeConfig } from '../config.mjs';
import { TRACK_ID_PATTERN, defaultTrackLabel } from '../resume-tracks.mjs';
import { REPORT_TITLE } from '../report.mjs';
import { resolveFrom } from '../utils.mjs';
import { localDate } from '../time-format.mjs';
import { readConfigFile, updateConfigFile } from './config-file.mjs';
import { readLockStatus } from './run.mjs';

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ERROR_FILE_PATTERN = /^ERROR-\d{4}-\d{2}-\d{2}\.html$/;
export const MAXIMUM_PDF_BYTES = 5 * 1024 * 1024;
export const KEEP_PDF_VERSIONS = 5;
const PAYLOAD_PATTERN = /^report-payload-(\d{4}-\d{2}-\d{2})\.json$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9.\-]{0,63}(\[1m\])?$/i;
const MATCH_LEVELS = ['high', 'medium', 'low'];

export class HubInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HubInputError';
    this.code = 'HUB_INPUT';
    this.status = 400;
  }
}

async function exists(io, file) {
  try { await io.stat(file); return true; } catch { return false; }
}

async function readJson(io, file, fallback = null) {
  try { return JSON.parse(await io.readFile(file, 'utf8')); } catch { return fallback; }
}

// ---------------------------------------------------------------------------------------------- reports

export async function listReportDates(ctx) {
  let names = [];
  try { names = await ctx.io.readdir(path.join(ctx.root, 'state')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return names.map(name => PAYLOAD_PATTERN.exec(name)?.[1]).filter(Boolean).sort().reverse();
}

// Dates with their match counts for the Reports sidebar; each payload is read from disk on every call.
export async function listReportSummaries(ctx) {
  const summaries = [];
  for (const date of await listReportDates(ctx)) {
    const payload = await readReportPayload(ctx, date);
    summaries.push({ date, matchCount: payload ? (payload.meta?.matchCount ?? payload.matches.length) : null, complete: payload?.complete === true });
  }
  return summaries;
}

export function assertDate(value) {
  if (!DATE_PATTERN.test(String(value || ''))) throw new HubInputError('Invalid date');
  return String(value);
}

export async function readReportPayload(ctx, date) {
  assertDate(date);
  const payload = await readJson(ctx.io, path.join(ctx.root, 'state', `report-payload-${date}.json`));
  if (!payload?.meta?.date || !Array.isArray(payload.matches)) return null;
  return payload;
}

export function desktopCopyPath(config, date) {
  return path.join(config.outputDirectory, date, `${REPORT_TITLE} - ${date}.html`);
}

// ---------------------------------------------------------------------------------------------- hub state

function hubStatePath(ctx) {
  return path.join(ctx.hubDirectory, 'hub-state.json');
}

export async function readHubState(ctx) {
  const state = await readJson(ctx.io, hubStatePath(ctx), {});
  return { resumes: {}, ...(state && typeof state === 'object' ? state : {}) };
}

export async function writeHubState(ctx, state) {
  await ctx.io.mkdir(ctx.hubDirectory, { recursive: true });
  await ctx.io.writeFile(hubStatePath(ctx), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------------------------- resumes

function managedDirectoryFor(ctx, trackId) {
  return path.join(ctx.managedResumeDirectory, trackId);
}

function isManagedPath(ctx, trackId, absolutePath) {
  const directory = managedDirectoryFor(ctx, trackId);
  return typeof absolutePath === 'string' && absolutePath.startsWith(`${directory}${path.sep}`);
}

async function listVersions(ctx, trackId) {
  const directory = managedDirectoryFor(ctx, trackId);
  let names = [];
  try { names = await ctx.io.readdir(directory); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const versions = [];
  for (const name of names.filter(item => /\.pdf$/i.test(item))) {
    const info = await ctx.io.stat(path.join(directory, name));
    versions.push({ name, path: path.join(directory, name), size: info.size, modifiedAt: info.mtime.toISOString() });
  }
  return versions.sort((a, b) => b.name.localeCompare(a.name));
}

export function assertTrackId(value) {
  const id = String(value || '').trim();
  if (!TRACK_ID_PATTERN.test(id)) throw new HubInputError('Track id must be letters, digits, "_" or "-" (for example "data", "llm", "agent")');
  return id;
}

function rawTracks(rawConfig) {
  const tracks = rawConfig?.resumes?.tracks;
  return Array.isArray(tracks) ? tracks : null;
}

export async function loadTracksView(ctx) {
  const { config: rawConfig } = await readConfigFile(ctx.configPath, ctx.io);
  const legacy = !rawTracks(rawConfig);
  let normalized;
  try {
    normalized = normalizeResumeConfig(rawConfig, ctx.root, { notify: () => {} });
  } catch (error) {
    return { legacy, tracks: [], error: error.message, autoRefresh: false };
  }
  const hubState = await readHubState(ctx);
  const sources = (await readJson(ctx.io, path.join(ctx.root, 'state', 'resume-sources.json'), {}))?.sources || {};
  const tracks = [];
  for (const track of normalized.tracks) {
    const record = hubState.resumes?.[track.id] || null;
    const versions = await listVersions(ctx, track.id);
    const pdfExists = track.pdf ? await exists(ctx.io, track.pdf) : false;
    let profile = { exists: false, characters: 0 };
    try {
      const text = await ctx.io.readFile(track.profile, 'utf8');
      profile = { exists: true, characters: text.length };
    } catch {}
    tracks.push({
      id: track.id,
      label: track.label,
      enabled: track.enabled,
      pdf: track.pdf,
      pdfName: track.pdf ? path.basename(track.pdf) : null,
      pdfExists,
      managed: isManagedPath(ctx, track.id, track.pdf),
      onDesktop: Boolean(track.pdf) && track.pdf.startsWith(`${path.join(ctx.homedir, 'Desktop')}${path.sep}`),
      versions,
      uploadedAt: record?.uploadedAt || (isManagedPath(ctx, track.id, track.pdf) ? versions.find(version => version.path === track.pdf)?.modifiedAt || null : null),
      extraction: record?.extraction || null,
      profile: { ...profile, path: track.profile },
      lastSync: sources[track.id]?.refreshedAt || null,
    });
  }
  return { legacy, tracks, error: null, autoRefresh: normalized.autoRefresh, pdftotextCommand: normalized.pdftotextCommand };
}

function safeFileName(name) {
  const base = path.basename(String(name || 'resume.pdf')).replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, ' ').trim();
  const stem = base.replace(/\.pdf$/i, '') || 'resume';
  return `${stem.slice(0, 80)}.pdf`;
}

export function validatePdfUpload(file) {
  if (!file || !file.data?.length) throw new HubInputError('Choose a PDF file to upload');
  if (!/\.pdf$/i.test(String(file.filename || ''))) throw new HubInputError('Only .pdf files are accepted');
  if (file.data.length > MAXIMUM_PDF_BYTES) throw new HubInputError('The PDF is larger than the 5 MB limit');
  if (file.data.slice(0, 5).toString('latin1') !== '%PDF-') throw new HubInputError('The file does not look like a PDF (missing %PDF header)');
}

async function checkExtraction(ctx, absolutePath, pdftotextCommand) {
  const checkedAt = ctx.now().toISOString();
  try {
    const text = await ctx.extractText(absolutePath, { pdftotextCommand });
    return { ok: true, characters: text.length, error: null, checkedAt };
  } catch (error) {
    return { ok: false, characters: 0, error: String(error?.message || error).slice(0, 300), checkedAt };
  }
}

// Stores the PDF under private/resumes/<id>/, points the track at it, keeps the newest five versions,
// and records a trial text extraction so the card can say whether pdftotext will succeed tonight.
export async function uploadResumePdf(ctx, { trackId, file, create = false, label = '' }) {
  const id = assertTrackId(trackId);
  validatePdfUpload(file);
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
  const fileName = `${stamp}-${safeFileName(file.filename)}`;
  const directory = managedDirectoryFor(ctx, id);
  const absolutePath = path.join(directory, fileName);
  const relativePath = `./${path.relative(ctx.root, absolutePath).split(path.sep).join('/')}`;
  let pdftotextCommand = 'pdftotext';

  await updateConfigFile(ctx.configPath, config => {
    const tracks = rawTracks(config);
    if (!tracks) throw new HubInputError('config.json uses the legacy resumes layout; move to resumes.tracks before managing resumes from the hub');
    pdftotextCommand = config.resumes.pdftotextCommand || 'pdftotext';
    const existing = tracks.find(track => track?.id === id);
    if (create) {
      if (existing) throw new HubInputError(`A track with id "${id}" already exists`);
      tracks.push({ id, label: String(label || '').trim() || defaultTrackLabel(id), pdf: relativePath, enabled: true });
    } else {
      if (!existing) throw new HubInputError(`Unknown track "${id}"`);
      existing.pdf = relativePath;
    }
    return true;
  }, { fs: ctx.io, pidAlive: ctx.pidAlive });

  await ctx.io.mkdir(directory, { recursive: true });
  await ctx.io.writeFile(absolutePath, file.data, { mode: 0o600 });
  const versions = await listVersions(ctx, id);
  for (const stale of versions.slice(KEEP_PDF_VERSIONS)) await ctx.io.rm(stale.path, { force: true });

  const extraction = await checkExtraction(ctx, absolutePath, pdftotextCommand);
  const hubState = await readHubState(ctx);
  hubState.resumes[id] = { uploadedAt: ctx.now().toISOString(), file: fileName, path: absolutePath, extraction };
  await writeHubState(ctx, hubState);
  return { id, fileName, path: absolutePath, extraction };
}

export async function setTrackEnabled(ctx, trackId, enabled) {
  const id = assertTrackId(trackId);
  await updateConfigFile(ctx.configPath, config => {
    const tracks = rawTracks(config);
    if (!tracks) throw new HubInputError('config.json uses the legacy resumes layout; move to resumes.tracks before managing resumes from the hub');
    const track = tracks.find(item => item?.id === id);
    if (!track) throw new HubInputError(`Unknown track "${id}"`);
    if (!enabled && !tracks.some(item => item !== track && item?.enabled !== false)) {
      throw new HubInputError('At least one track must stay enabled');
    }
    track.enabled = Boolean(enabled);
    return true;
  }, { fs: ctx.io, pidAlive: ctx.pidAlive });
  return { id, enabled: Boolean(enabled) };
}

// Points a managed track back at one of its kept versions.
export async function selectResumeVersion(ctx, trackId, fileName) {
  const id = assertTrackId(trackId);
  const name = path.basename(String(fileName || ''));
  const versions = await listVersions(ctx, id);
  const version = versions.find(item => item.name === name);
  if (!version) throw new HubInputError('Unknown version');
  const relativePath = `./${path.relative(ctx.root, version.path).split(path.sep).join('/')}`;
  await updateConfigFile(ctx.configPath, config => {
    const track = rawTracks(config)?.find(item => item?.id === id);
    if (!track) throw new HubInputError(`Unknown track "${id}"`);
    track.pdf = relativePath;
    return true;
  }, { fs: ctx.io, pidAlive: ctx.pidAlive });
  return { id, path: version.path };
}

// ---------------------------------------------------------------------------------------------- status

function tzOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const value = type => Number(parts.find(part => part.type === type)?.value || 0);
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'), value('second'));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

// Next wall-clock occurrence of hour:minute in the given zone strictly after `now`.
export function nextScheduledRun(now, timeZone, hour = 20, minute = 0) {
  const zone = timeZone || 'America/Chicago';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = type => Number(parts.find(part => part.type === type)?.value || 0);
  for (let offset = 0; offset <= 2; offset += 1) {
    const guess = Date.UTC(value('year'), value('month') - 1, value('day') + offset, Number(hour), Number(minute));
    let instant = guess - tzOffsetMinutes(new Date(guess), zone) * 60_000;
    instant = guess - tzOffsetMinutes(new Date(instant), zone) * 60_000;
    if (instant > now.getTime()) return new Date(instant);
  }
  return null;
}

async function installedSchedule(ctx) {
  const plist = path.join(ctx.homedir, 'Library', 'LaunchAgents', 'com.dailyjobmatchalert.daily.plist');
  try {
    const text = await ctx.io.readFile(plist, 'utf8');
    const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1];
    const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1];
    if (hour != null) return { hour: Number(hour), minute: Number(minute || 0), installed: true, path: plist };
  } catch {}
  return { hour: 20, minute: 0, installed: false, path: plist };
}

// Small summary for the sidebar of every page: last run time and result, next run time.
export async function sidebarSummary(ctx, config) {
  const dates = await listReportDates(ctx);
  const latest = dates[0] ? await readReportPayload(ctx, dates[0]) : null;
  const schedule = await installedSchedule(ctx);
  const next = nextScheduledRun(ctx.now(), config.timeZone || 'America/Chicago', schedule.hour, schedule.minute);
  return {
    lastRunAt: latest?.meta?.completedAt || latest?.meta?.lastUpdatedAt || latest?.meta?.generatedAt || null,
    lastResult: latest ? (latest.complete === true ? 'success' : 'incomplete') : null,
    nextRunAt: next ? next.toISOString() : null,
  };
}

export async function buildStatusView(ctx, config) {
  const now = ctx.now();
  const state = await readJson(ctx.io, path.join(ctx.root, 'state', 'state.json'), {}) || {};
  const dates = await listReportDates(ctx);
  const latestDate = dates[0] || null;
  const latest = latestDate ? await readReportPayload(ctx, latestDate) : null;
  const lastUpdatedAt = latest?.meta?.completedAt || latest?.meta?.lastUpdatedAt || latest?.meta?.generatedAt || null;

  const lastRun = {
    at: lastUpdatedAt,
    date: latestDate,
    // Written by the pipeline itself (scheduled / catchup / manual); older payloads carry none.
    trigger: latest?.meta?.trigger || null,
    matchCount: latest?.meta?.matchCount ?? latest?.matches?.length ?? null,
    runsToday: latest?.meta?.runsToday ?? null,
    complete: latest?.complete === true,
    lastSuccessfulRun: state.lastSuccessfulRun || null,
    result: latest ? (latest.complete === true ? 'success' : 'incomplete (xlsx missing; rebuilt on the next run)') : 'no report yet',
  };
  const schedule = await installedSchedule(ctx);
  const next = nextScheduledRun(now, config.timeZone || 'America/Chicago', schedule.hour, schedule.minute);
  const lock = await readLockStatus(ctx.runManager.lockPath, ctx.pidAlive, ctx.io);
  const availability = await ctx.runManager.availability();

  const days = [];
  for (const date of dates.slice(0, 7)) {
    const payload = await readReportPayload(ctx, date);
    const file = path.join(config.outputDirectory, date, 'warnings.txt');
    const text = await ctx.io.readFile(file, 'utf8').catch(() => null);
    days.push({ date, count: payload?.meta?.warnings?.length || 0, matchCount: payload?.meta?.matchCount ?? null, warningsFile: file, warningsText: text });
  }

  const errors = [];
  try {
    for (const name of await ctx.io.readdir(config.outputDirectory)) {
      if (!ERROR_FILE_PATTERN.test(name)) continue;
      const file = path.join(config.outputDirectory, name);
      const info = await ctx.io.stat(file);
      errors.push({ name, path: file, modifiedAt: info.mtime.toISOString() });
    }
  } catch {}
  errors.sort((a, b) => b.name.localeCompare(a.name));

  return {
    now: now.toISOString(),
    today: localDate(now, config.timeZone || 'America/Chicago'),
    timeZone: config.timeZone || 'America/Chicago',
    lastRun,
    nextRun: { at: next ? next.toISOString() : null, hour: schedule.hour, minute: schedule.minute, installed: schedule.installed, plist: schedule.path },
    lock: { ...lock, path: ctx.runManager.lockPath },
    runNow: availability,
    run: ctx.runManager.status(),
    days,
    errors,
    outputDirectory: config.outputDirectory,
  };
}

export async function readErrorReport(ctx, config, name) {
  if (!ERROR_FILE_PATTERN.test(String(name || ''))) throw new HubInputError('Invalid error report name');
  return ctx.io.readFile(path.join(config.outputDirectory, name), 'utf8');
}

// ---------------------------------------------------------------------------------------------- settings

export async function readSettings(ctx) {
  const { config } = await readConfigFile(ctx.configPath, ctx.io);
  return {
    minimumMatchScore: config.minimumMatchScore ?? 60,
    acceptedMatchLevels: Array.isArray(config.semanticMatching?.acceptedMatchLevels) ? config.semanticMatching.acceptedMatchLevels : ['high'],
    model: config.semanticMatching?.model || '',
    xlsxRequired: config.reports?.xlsx?.required === true,
    hubPort: Number(config.hub?.port || 4747),
  };
}

export function validateSettings(form) {
  const errors = [];
  const minimumMatchScore = Number(form.minimumMatchScore);
  if (!Number.isInteger(minimumMatchScore) || minimumMatchScore < 0 || minimumMatchScore > 100) errors.push('Minimum match score must be a whole number from 0 to 100');
  const levels = (Array.isArray(form.acceptedMatchLevels) ? form.acceptedMatchLevels : [form.acceptedMatchLevels]).filter(Boolean).map(String);
  if (!levels.length || levels.some(level => !MATCH_LEVELS.includes(level))) errors.push('Accepted match levels must include at least one of high, medium, low');
  const model = String(form.model || '').trim();
  if (!MODEL_PATTERN.test(model)) errors.push('Model must be a Claude Code alias (fable, opus, sonnet) or a full model name such as claude-fable-5');
  const hubPort = Number(form.hubPort);
  if (!Number.isInteger(hubPort) || hubPort < 1024 || hubPort > 65535) errors.push('Hub port must be a whole number from 1024 to 65535');
  const xlsxRequired = form.xlsxRequired === 'on' || form.xlsxRequired === 'true' || form.xlsxRequired === true;
  if (errors.length) throw new HubInputError(errors.join('; '));
  return { minimumMatchScore, acceptedMatchLevels: MATCH_LEVELS.filter(level => levels.includes(level)), model, xlsxRequired, hubPort };
}

export async function saveSettings(ctx, form) {
  const settings = validateSettings(form);
  await updateConfigFile(ctx.configPath, config => {
    config.minimumMatchScore = settings.minimumMatchScore;
    config.semanticMatching = config.semanticMatching && typeof config.semanticMatching === 'object' ? config.semanticMatching : {};
    config.semanticMatching.acceptedMatchLevels = settings.acceptedMatchLevels;
    config.semanticMatching.model = settings.model;
    config.reports = config.reports && typeof config.reports === 'object' ? config.reports : {};
    config.reports.xlsx = config.reports.xlsx && typeof config.reports.xlsx === 'object' ? config.reports.xlsx : {};
    config.reports.xlsx.required = settings.xlsxRequired;
    config.hub = config.hub && typeof config.hub === 'object' ? config.hub : {};
    config.hub.port = settings.hubPort;
    return true;
  }, { fs: ctx.io, pidAlive: ctx.pidAlive });
  return settings;
}

export { enabledResumeTracks, resolveFrom };

// HTTP routing for the hub. GET renders pages; every state change is a POST whose Host and Origin must
// be this machine. Path parameters are validated against strict patterns before they touch the
// filesystem, and request bodies are capped just above the 5 MB upload limit.
import { buildReportView } from '../report.mjs';
import path from 'node:path';
import { renderReportBody } from '../report-components.mjs';
import { HubLockedError } from './config-file.mjs';
import { parseMultipart } from './multipart.mjs';
import {
  HubInputError, assertDate, buildStatusView, configuredCliCommands, desktopCopyPath, desktopWorkbookPath, listReportSummaries, loadTracksView, readErrorReport,
  readReportPayload, readSettings, resumeAtsBoard, saveCliPath, saveSettings, selectResumeVersion, setTrackEnabled, sidebarSummary, uploadResumePdf,
} from './services.mjs';
import { localDate } from '../time-format.mjs';
import { LETTER_SCRIPT, ONECLICK_SCRIPT, SAMPLE_TRACK_SCRIPT, letterPanel, lettersPage, trackLabelOf } from './letter-views.mjs';
import { todayTarget } from './views.mjs';
import { findLetterJob, generateLetter, jobIdOf, letterEngineFor, oneClickLetter, saveLetter } from './letters.mjs';
import { LetterBusyError } from './letter-jobs.mjs';
import { LetterInputError } from '../cover-letter/store.mjs';
import { displayCompanyName } from '../posting-fields.mjs';
import { REPORTS_SCRIPT, SETTINGS_SCRIPT, STATUS_SCRIPT, renderHubPage, reportsPage, resumesPage, settingsPage, statusPage } from './views.mjs';

const MAXIMUM_BODY_BYTES = 6 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function hostIsLocal(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOCAL_HOSTS.has(name);
}

export function originIsLocal(originHeader) {
  if (originHeader == null || originHeader === '') return true;
  try {
    const url = new URL(String(originHeader));
    return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function requestIsLocal(headers) {
  return hostIsLocal(headers.host) && originIsLocal(headers.origin) && (!headers.referer || originIsLocal(new URL(headers.referer, 'http://127.0.0.1').origin));
}

function readBody(request, limit = MAXIMUM_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('Request body is too large');
        error.status = 413;
        request.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function parseBody(buffer, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.startsWith('multipart/form-data')) return parseMultipart(buffer, contentType);
  const fields = {};
  const params = new URLSearchParams(buffer.toString('utf8'));
  for (const [key, value] of params) {
    if (key in fields) fields[key] = [].concat(fields[key], value);
    else fields[key] = value;
  }
  return { fields, files: [] };
}

export function createHubHandler(ctx) {
  const send = (response, status, body, type = 'text/html; charset=utf-8') => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
    response.end(body);
  };
  const json = (response, status, value) => send(response, status, JSON.stringify(value), 'application/json; charset=utf-8');
  const redirect = (response, location, message = null, kind = 'notice') => {
    // The query string must precede any #fragment, or browsers fold the notice into the fragment.
    const [base, fragment] = String(location).split('#');
    const target = message ? `${base}${base.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(message)}${fragment ? `#${fragment}` : ''}` : location;
    response.writeHead(303, { location: target, 'cache-control': 'no-store' });
    response.end();
  };
  // Every page carries the sidebar summary; config is re-read per request so nothing is cached in-process.
  const page = async (response, status, options) => {
    const config = await ctx.loadConfig().catch(() => ({}));
    const timeZone = config.timeZone || 'America/Chicago';
    const sidebar = await sidebarSummary(ctx, config).catch(() => null);
    send(response, status, renderHubPage({ port: ctx.port, timeZone, sidebar, now: ctx.now(), ...options }));
  };

  async function getReports(url, response) {
    const config = await ctx.loadConfig();
    const timeZone = config.timeZone || 'America/Chicago';
    const dates = await listReportSummaries(ctx);
    const today = localDate(ctx.now(), timeZone);
    const match = /^\/reports\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
    // No date in the URL: open the calendar-today report when it exists, otherwise the newest one.
    const selected = match ? assertDate(match[1]) : todayTarget(dates, today).date;
    let reportBody = null;
    let desktopPath = null;
    if (selected) {
      const payload = await readReportPayload(ctx, selected);
      if (!payload) {
        await page(response, 404, { active: 'reports', title: 'Reports', content: reportsPage({ dates, selected: null, reportBody: null, desktopPath: null, today }), error: `No report payload for ${selected}` });
        return;
      }
      const lettersByJob = await ctx.letterStore.lettersByJob().catch(() => new Map());
      const decorate = job => {
        const id = jobIdOf(job);
        const letter = lettersByJob.get(id);
        // A saved letter gets Open Letter plus a direct PDF download; the PDF link exists only once rendered.
        // Without one the card carries a one-click button that the page script drives (see ONECLICK_SCRIPT).
        const download = letter?.pdf && letter.pdfFileName ? [{ href: `/letters/${letter.date}/${letter.slug}/${encodeURIComponent(letter.pdfFileName)}`, label: 'Download PDF' }] : [];
        return {
          actions: letter
            ? [{ href: `/letters/${letter.date}/${letter.slug}`, label: 'Open Letter' }, ...download]
            : [{ button: true, label: 'Generate Cover Letter', data: { oneclick: '1', date: selected, job: id } }],
          badges: letter ? [{ key: 'letter-ready', label: 'Letter ready', tone: 'good', title: `Cover letter saved ${letter.savedAt || ''}` }] : [],
        };
      };
      reportBody = renderReportBody(buildReportView(payload.matches, { timeZone, ...payload.meta }, { embedded: true, decorate }));
      desktopPath = desktopCopyPath(config, selected);
    }
    await page(response, 200, { active: 'reports', title: selected ? `Report ${selected}` : 'Reports', content: reportsPage({ dates, selected, reportBody, desktopPath, today }), script: REPORTS_SCRIPT + ONECLICK_SCRIPT, notice: url.searchParams.get('notice') || '', error: url.searchParams.get('error') || '' });
  }

  async function getResumes(url, response) {
    const tracksView = await loadTracksView(ctx);
    const timeZone = (await ctx.loadConfig()).timeZone || 'America/Chicago';
    await page(response, 200, { active: 'resumes', title: 'Resumes', content: resumesPage({ tracksView, timeZone }), notice: url.searchParams.get('notice') || '', error: url.searchParams.get('error') || '' });
  }

  async function getStatus(url, response) {
    const config = await ctx.loadConfig();
    const status = await buildStatusView(ctx, config);
    await page(response, 200, { active: 'status', title: 'Status', content: statusPage({ status, timeZone: status.timeZone }).replace('id="run-card"', `id="run-card" data-time-zone="${status.timeZone}"`), script: STATUS_SCRIPT, notice: url.searchParams.get('notice') || '', error: url.searchParams.get('error') || '' });
  }

  async function getSettings(url, response) {
    const settings = await readSettings(ctx);
    const config = await ctx.loadConfig().catch(() => ({}));
    const connections = ctx.connections ? await ctx.connections.status({ commands: configuredCliCommands(config) }).catch(() => null) : null;
    const timeZone = config.timeZone || 'America/Chicago';
    const readiness = await ctx.letterStore.readiness();
    await page(response, 200, { active: 'settings', title: 'Settings', content: settingsPage({ settings, connections, timeZone, coverLetter: { profile: readiness.profile, readiness } }), script: SETTINGS_SCRIPT + SAMPLE_TRACK_SCRIPT, notice: url.searchParams.get('notice') || '', error: url.searchParams.get('error') || '' });
  }

  // Read-only pass-through of the Desktop folder's own files: the HTML report and the workbook.
  async function getDesktop(date, kind, response) {
    const config = await ctx.loadConfig();
    const file = kind === 'xlsx' ? desktopWorkbookPath(config, date) : desktopCopyPath(config, date);
    let content;
    try {
      content = await ctx.io.readFile(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return send(response, 404, `No Desktop ${kind === 'xlsx' ? 'workbook' : 'report'} for ${date} at ${file}`, 'text/plain; charset=utf-8');
    }
    if (kind === 'xlsx') {
      response.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="Daily Job Match Alert - ${date}.xlsx"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return response.end(content);
    }
    return send(response, 200, content);
  }

  async function getLetters(url, response) {
    const config = await ctx.loadConfig();
    const letters = await ctx.letterStore.listLetters();
    await page(response, 200, { active: 'letters', title: 'Letters', content: lettersPage({ letters, timeZone: config.timeZone || 'America/Chicago' }), notice: url.searchParams.get('notice') || '', error: url.searchParams.get('error') || '' });
  }

  async function getLetterPanel(url, response, { date, jobId, existing = null }) {
    const config = await ctx.loadConfig();
    const readiness = await ctx.letterStore.readiness();
    const { job, id, tracks } = await findLetterJob(ctx, date, jobId);
    const selectedTrack = url.searchParams.get('track') || existing?.record?.track || job.recommendedTrack || tracks[0]?.id || '';
    const engine = letterEngineFor(ctx, config);
    const shownJob = { ...job, company: displayCompanyName(job) };
    const content = letterPanel({ date, jobId: id, job: shownJob, tracks, selectedTrack, company: existing?.record?.company || shownJob.company || '', readiness, existing, engineLabel: `${engine.label} · ${engine.model}` });
    await page(response, 200, { active: 'letters', title: `Cover letter · ${job.company || job.title}`, content, script: LETTER_SCRIPT, error: url.searchParams.get('error') || '' });
  }

  async function getLetterDownload(date, slug, fileName, response) {
    const file = await ctx.letterStore.resolveDownload(date, slug, decodeURIComponent(fileName));
    if (!file) return send(response, 404, 'No such letter file', 'text/plain; charset=utf-8');
    const content = await ctx.io.readFile(file);
    if (file.endsWith('.pdf')) {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${path.basename(file)}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return response.end(content);
    }
    return send(response, 200, content, 'text/markdown; charset=utf-8');
  }

  async function handlePost(url, request, response) {
    if (!requestIsLocal(request.headers)) {
      json(response, 403, { error: 'POST requests are accepted only from this machine (Host/Origin must be 127.0.0.1 or localhost)' });
      return;
    }
    const body = parseBody(await readBody(request), request.headers['content-type']);
    const { fields, files } = body;
    switch (url.pathname) {
      case '/resumes/upload': {
        const result = await uploadResumePdf(ctx, { trackId: fields.trackId, file: files.find(file => file.field === 'file') });
        redirect(response, '/resumes', `${result.id}: stored ${result.fileName}; ${result.extraction.ok ? `${result.extraction.characters} characters extracted` : `extraction check failed (${result.extraction.error})`}`);
        return;
      }
      case '/resumes/add': {
        const result = await uploadResumePdf(ctx, { trackId: fields.trackId, label: fields.label, file: files.find(file => file.field === 'file'), create: true });
        redirect(response, '/resumes', `Added track ${result.id} with ${result.fileName}`);
        return;
      }
      case '/resumes/toggle': {
        const result = await setTrackEnabled(ctx, fields.trackId, fields.enabled === 'true');
        redirect(response, '/resumes', `${result.id} is now ${result.enabled ? 'enabled' : 'disabled'}`);
        return;
      }
      case '/resumes/select': {
        const result = await selectResumeVersion(ctx, fields.trackId, fields.file);
        redirect(response, '/resumes', `${result.id} now uses ${result.path}`);
        return;
      }
      case '/settings': {
        await saveSettings(ctx, fields);
        redirect(response, '/settings', 'Settings saved to config.json');
        return;
      }
      case '/settings/cli-path': {
        const result = await saveCliPath(ctx, fields.engine, fields.path);
        if (ctx.connections?.reset) ctx.connections.reset();
        redirect(response, '/settings', `Saved ${result.path} as semanticMatching.${result.engine}Command`);
        return;
      }
      case '/letters/generate': {
        json(response, 200, await generateLetter(ctx, { date: assertDate(fields.date), jobId: fields.job, trackId: fields.track || null, company: fields.company }));
        return;
      }
      case '/letters/oneclick': {
        const date = assertDate(fields.date);
        const readiness = await ctx.letterStore.readiness();
        if (!readiness.ready) throw new HubInputError(`Cover-letter material is incomplete (${readiness.missing.join(', ')}); upload it under Settings first`);
        const { job, id } = await findLetterJob(ctx, date, fields.job);
        const started = ctx.letterJobs.start({ date, jobId: id, company: displayCompanyName(job) || job.company || null, run: () => oneClickLetter(ctx, { date, jobId: id }) });
        json(response, 202, started);
        return;
      }
      case '/letters/save': {
        let issues = [];
        try { issues = JSON.parse(fields.issues || '[]'); } catch { issues = []; }
        let editorNotes = [];
        try { editorNotes = JSON.parse(fields.editorNotes || '[]'); } catch { editorNotes = []; }
        let samplesUsed = [];
        try { samplesUsed = JSON.parse(fields.samplesUsed || '[]'); } catch { samplesUsed = []; }
        json(response, 200, await saveLetter(ctx, { date: assertDate(fields.date), jobId: fields.job, trackId: fields.track || null, company: fields.company, paragraphs: [].concat(fields.paragraph || []), engine: fields.engine, model: fields.model, issues: Array.isArray(issues) ? issues : [], editorNotes: Array.isArray(editorNotes) ? editorNotes.map(String) : [], samplesUsed: Array.isArray(samplesUsed) ? samplesUsed : [] }));
        return;
      }
      case '/settings/cover-letter': {
        await ctx.letterStore.saveProfileFields(fields);
        const notes = ['Contact block saved'];
        const playbook = files.find(file => file.field === 'playbook' && file.data?.length);
        if (playbook) { const saved = await ctx.letterStore.savePlaybook(playbook); notes.push(`playbook ${saved.originalName} (${saved.characters} characters)`); }
        // Every file chosen in this batch gets the "Track for these files" tag; rows can be retagged later.
        const samples = files.filter(file => file.field === 'sample' && file.data?.length);
        for (const sample of samples) {
          const saved = await ctx.letterStore.saveSample(sample, { track: fields.sampleTrack || null });
          notes.push(`${saved.replaced ? 'replaced' : 'added'} sample ${saved.originalName}${saved.track ? ` as ${trackLabelOf(saved.track)}` : ''} (${saved.characters} characters)`);
        }
        redirect(response, '/settings#cover-letters', notes.join('; '));
        return;
      }
      case '/settings/cover-letter/remove-playbook': {
        await ctx.letterStore.removePlaybook();
        redirect(response, '/settings#cover-letters', 'Playbook removed');
        return;
      }
      case '/settings/cover-letter/remove-sample': {
        await ctx.letterStore.removeSample(fields.file);
        redirect(response, '/settings#cover-letters', 'Sample removed');
        return;
      }
      case '/settings/cover-letter/sample-track': {
        const sample = await ctx.letterStore.setSampleTrack(fields.file, fields.track || null);
        json(response, 200, { file: sample.file, track: sample.track, trackLabel: sample.track ? trackLabelOf(sample.track) : null });
        return;
      }
      case '/status/sources/resume': {
        const result = await resumeAtsBoard(ctx, fields.board);
        redirect(response, '/status', `${result.label} will be polled again on the next run`);
        return;
      }
      case '/run': {
        if (fields.confirm !== 'yes') {
          json(response, 400, { error: 'Confirmation is required' });
          return;
        }
        try {
          await ctx.runManager.start();
        } catch (error) {
          if (error?.code === 'RUN_UNAVAILABLE') {
            json(response, 409, { error: error.message, ...(await buildStatusView(ctx, await ctx.loadConfig())) });
            return;
          }
          throw error;
        }
        json(response, 202, await buildStatusView(ctx, await ctx.loadConfig()));
        return;
      }
      default:
        json(response, 404, { error: 'Not found' });
    }
  }

  return async function handle(request, response) {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (url.pathname === '/') return redirect(response, '/reports');
        if (url.pathname === '/reports' || /^\/reports\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) return await getReports(url, response);
        if (url.pathname === '/resumes') return await getResumes(url, response);
        if (url.pathname === '/status') return await getStatus(url, response);
        if (url.pathname === '/status/run.json') return json(response, 200, await buildStatusView(ctx, await ctx.loadConfig()));
        const errorMatch = /^\/status\/error\/(ERROR-\d{4}-\d{2}-\d{2}\.html)$/.exec(url.pathname);
        if (errorMatch) return send(response, 200, await readErrorReport(ctx, await ctx.loadConfig(), errorMatch[1]));
        const desktopMatch = /^\/desktop\/(\d{4}-\d{2}-\d{2})(\/xlsx)?$/.exec(url.pathname);
        if (desktopMatch) return await getDesktop(assertDate(desktopMatch[1]), desktopMatch[2] ? 'xlsx' : 'html', response);
        if (url.pathname === '/settings') return await getSettings(url, response);
        if (url.pathname === '/letters') return await getLetters(url, response);
        if (url.pathname === '/letters/oneclick.json') return json(response, 200, ctx.letterJobs.status());
        if (url.pathname === '/letters/new') return await getLetterPanel(url, response, { date: assertDate(url.searchParams.get('date')), jobId: url.searchParams.get('job') });
        const letterOpen = /^\/letters\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9]{1,80})$/.exec(url.pathname);
        if (letterOpen) {
          const existing = await ctx.letterStore.loadLetter(letterOpen[1], letterOpen[2]);
          if (!existing) return await page(response, 404, { active: 'letters', title: 'Not found', content: '<h1 class="hub-title">Letter not found</h1>' });
          return await getLetterPanel(url, response, { date: letterOpen[1], jobId: existing.record.jobId, existing });
        }
        const letterFile = /^\/letters\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9]{1,80})\/([^/]{1,200})$/.exec(url.pathname);
        if (letterFile) return await getLetterDownload(letterFile[1], letterFile[2], letterFile[3], response);
        if (url.pathname === '/healthz') return json(response, 200, { ok: true });
        return await page(response, 404, { active: '', title: 'Not found', content: '<h1 class="hub-title">Not found</h1>' });
      }
      if (request.method === 'POST') return await handlePost(url, request, response);
      return send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    } catch (error) {
      const wantsJson = url.pathname === '/run' || url.pathname === '/letters/generate' || url.pathname === '/letters/save' || url.pathname === '/letters/oneclick' || url.pathname === '/settings/cover-letter/sample-track' || url.pathname.endsWith('.json');
      const status = error instanceof HubInputError || error instanceof LetterInputError ? 400 : error instanceof HubLockedError || error instanceof LetterBusyError ? 409 : Number(error?.status) || 500;
      const message = status === 500 ? `Hub error: ${error?.message || error}` : String(error.message || error);
      if (status === 500) console.error(error?.stack || error);
      if (wantsJson) return json(response, status, { error: message, ...(error instanceof LetterBusyError ? { job: error.job } : {}) });
      const back = url.pathname.startsWith('/resumes') ? '/resumes' : url.pathname.startsWith('/settings/cover-letter') ? '/settings#cover-letters' : url.pathname.startsWith('/settings') ? '/settings' : url.pathname.startsWith('/status') ? '/status' : url.pathname.startsWith('/letters') ? '/letters' : '/reports';
      if (request.method === 'POST' && status !== 403) return redirect(response, back, message, 'error');
      return await page(response, status, { active: '', title: 'Error', content: '<h1 class="hub-title">Error</h1>', error: message });
    }
  };
}

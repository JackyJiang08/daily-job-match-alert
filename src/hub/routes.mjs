// HTTP routing for the hub. GET renders pages; every state change is a POST whose Host and Origin must
// be this machine. Path parameters are validated against strict patterns before they touch the
// filesystem, and request bodies are capped just above the 5 MB upload limit.
import { buildReportView } from '../report.mjs';
import { renderReportBody } from '../report-components.mjs';
import { HubLockedError } from './config-file.mjs';
import { parseMultipart } from './multipart.mjs';
import {
  HubInputError, assertDate, buildStatusView, desktopCopyPath, desktopWorkbookPath, listReportSummaries, loadTracksView, readErrorReport,
  readReportPayload, readSettings, saveSettings, selectResumeVersion, setTrackEnabled, sidebarSummary, uploadResumePdf,
} from './services.mjs';
import { localDate } from '../time-format.mjs';
import { SETTINGS_SCRIPT, STATUS_SCRIPT, renderHubPage, reportsPage, resumesPage, settingsPage, statusPage } from './views.mjs';

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
    const target = message ? `${location}${location.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(message)}` : location;
    response.writeHead(303, { location: target, 'cache-control': 'no-store' });
    response.end();
  };
  // Every page carries the sidebar summary; config is re-read per request so nothing is cached in-process.
  const page = async (response, status, options) => {
    const config = await ctx.loadConfig().catch(() => ({}));
    const timeZone = config.timeZone || 'America/Chicago';
    const sidebar = await sidebarSummary(ctx, config).catch(() => null);
    send(response, status, renderHubPage({ port: ctx.port, timeZone, sidebar, ...options }));
  };

  async function getReports(url, response) {
    const config = await ctx.loadConfig();
    const timeZone = config.timeZone || 'America/Chicago';
    const dates = await listReportSummaries(ctx);
    const today = localDate(ctx.now(), timeZone);
    const match = /^\/reports\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
    const selected = match ? assertDate(match[1]) : dates[0]?.date || null;
    let reportBody = null;
    let desktopPath = null;
    if (selected) {
      const payload = await readReportPayload(ctx, selected);
      if (!payload) {
        await page(response, 404, { active: 'reports', title: 'Reports', content: reportsPage({ dates, selected: null, reportBody: null, desktopPath: null, today }), error: `No report payload for ${selected}` });
        return;
      }
      reportBody = renderReportBody(buildReportView(payload.matches, { timeZone, ...payload.meta }, { embedded: true }));
      desktopPath = desktopCopyPath(config, selected);
    }
    await page(response, 200, { active: 'reports', title: selected ? `Report ${selected}` : 'Reports', content: reportsPage({ dates, selected, reportBody, desktopPath, today }), notice: url.searchParams.get('notice') || '', error: url.searchParams.get('error') || '' });
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
    const connections = ctx.connections ? await ctx.connections.status().catch(() => null) : null;
    const timeZone = (await ctx.loadConfig().catch(() => ({}))).timeZone || 'America/Chicago';
    await page(response, 200, { active: 'settings', title: 'Settings', content: settingsPage({ settings, connections, timeZone }), script: SETTINGS_SCRIPT, notice: url.searchParams.get('notice') || '', error: url.searchParams.get('error') || '' });
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
        if (url.pathname === '/healthz') return json(response, 200, { ok: true });
        return await page(response, 404, { active: '', title: 'Not found', content: '<h1 class="hub-title">Not found</h1>' });
      }
      if (request.method === 'POST') return await handlePost(url, request, response);
      return send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    } catch (error) {
      const wantsJson = url.pathname === '/run' || url.pathname.endsWith('.json');
      const status = error instanceof HubInputError ? 400 : error instanceof HubLockedError ? 409 : Number(error?.status) || 500;
      const message = status === 500 ? `Hub error: ${error?.message || error}` : String(error.message || error);
      if (status === 500) console.error(error?.stack || error);
      if (wantsJson) return json(response, status, { error: message });
      const back = url.pathname.startsWith('/resumes') ? '/resumes' : url.pathname.startsWith('/settings') ? '/settings' : url.pathname.startsWith('/status') ? '/status' : '/reports';
      if (request.method === 'POST' && status !== 403) return redirect(response, back, message, 'error');
      return await page(response, status, { active: '', title: 'Error', content: '<h1 class="hub-title">Error</h1>', error: message });
    }
  };
}

// Local-only hub server. Binds 127.0.0.1 exclusively, never makes outbound network requests, reads the
// pipeline's artifacts, and writes only config.json and private/ inside the project.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { isPidAlive } from '../lock.mjs';
import { extractPdfText } from '../resume-sync.mjs';
import { createHubHandler } from './routes.mjs';
import { createRunManager } from './run.mjs';
import { createAutoCatchUp } from './auto-catchup.mjs';
import { configuredCliCommands, installedSchedule, nextScheduledRun, readStateView } from './services.mjs';
import { checkIntegrity } from '../state-integrity.mjs';
import { createConnectionsProbe } from './connections.mjs';
import { describeConnections } from '../engines/index.mjs';
import { createLetterStore } from '../cover-letter/store.mjs';
import { createLetterJobs } from './letter-jobs.mjs';
import { createTimingLog } from './report-timing.mjs';
import { createReportCache } from './report-cache.mjs';
import { refreshIndexLetters } from '../reports-index.mjs';
import { refreshStatusLetters } from '../status-summary.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAuthWatch } from './auth-watch.mjs';

export const DEFAULT_HUB_PORT = 4747;
export const HUB_HOST = '127.0.0.1';

export function createHubContext(options) {
  const configPath = path.resolve(options.configPath);
  const root = options.root || path.dirname(configPath);
  const io = options.io || fs;
  const now = options.now || (() => new Date());
  const pidAlive = options.pidAlive || isPidAlive;
  const privateDirectory = path.join(root, 'private');
  const hubDirectory = path.join(privateDirectory, 'hub');
  const ctx = {
    root,
    configPath,
    io,
    now,
    pidAlive,
    port: Number(options.port || DEFAULT_HUB_PORT),
    homedir: options.homedir || os.homedir(),
    privateDirectory,
    hubDirectory,
    managedResumeDirectory: path.join(privateDirectory, 'resumes'),
    extractText: options.extractText || ((file, settings) => extractPdfText(file, settings)),
    loadConfig: options.loadConfig || (() => loadConfig(configPath, { notify: () => {} })),
  };
  ctx.letterStore = options.letterStore || createLetterStore({
    root, io, now,
    extractText: async file => ctx.extractText(file, { pdftotextCommand: (await ctx.loadConfig().catch(() => ({}))).resumes?.pdftotextCommand || 'pdftotext', minimumCharacters: 50 }),
  });
  // Rendered report days (src/hub/report-cache.mjs). A saved or renamed letter drops the renders and
  // updates the letter count in state/reports-index.json and state/status-summary.json, whichever process (the hub, the nightly letters
  // pass) wrote it.
  ctx.reportCache = options.reportCache || createReportCache({ now });
  for (const method of ['saveLetter', 'renameLetter']) {
    const original = ctx.letterStore[method];
    if (typeof original !== 'function') continue;
    ctx.letterStore[method] = async (...args) => {
      const result = await original(...args);
      ctx.reportCache.invalidate('letters');
      const date = method === 'saveLetter' ? args[0]?.date : args[0];
      await refreshIndexLetters(root, date, { io, now: now() }).catch(() => {});
      await refreshStatusLetters(root, date, { io, now: now() }).catch(() => {});
      return result;
    };
  }
  ctx.letterEngine = options.letterEngine || null;
  // Stage timings of the Reports pages: one hub log line per request, the last 20 on Status (Hub card).
  ctx.reportTimings = options.reportTimings || createTimingLog({ log: options.timingLog || (line => console.log(line)) });
  ctx.letterJobs = options.letterJobs || createLetterJobs({ now });
  // Desktop notification from the hub itself (plan changes seen by the probe); a no-op off macOS.
  ctx.notify = options.notify || (async text => {
    if (process.platform !== 'darwin') return false;
    await promisify(execFile)('osascript', ['-e', `display notification "${String(text).replace(/["\\]/g, ' ')}" with title "Daily Job Match Alert"`], { timeout: 10_000 });
    return true;
  });
  // Plan changes the hub has already announced in this process, and when Settings was last opened.
  ctx.planNotices = options.planNotices || new Set();
  ctx.planReviewedAt = null;
  // The most recent quota refusal seen by the hub itself (cover letters); the pipeline's own events live in the day payload.
  ctx.quotaLog = options.quotaLog || { last: null, record(event) { this.last = event; return event; } };
  // Whether the hub has seen Claude's login fail since the last successful call or manual refresh.
  ctx.authState = options.authState || {
    claude: { expired: false, at: null, notice: null, clearedAt: null, source: null },
    expire(notice, source = 'hub') { this.claude = { expired: true, at: now().toISOString(), notice: notice || null, clearedAt: null, source }; },
    clear() { this.claude = { expired: false, at: null, notice: null, clearedAt: now().toISOString(), source: null }; },
  };
  ctx.renderPdf = options.renderPdf || null;
  ctx.chromeCommand = options.chromeCommand;
  ctx.connections = options.connections || createConnectionsProbe({ now, runner: options.cliRunner, describe: options.describeConnections || (commands => describeConnections({ runner: options.cliRunner, homedir: ctx.homedir, env: process.env, ...commands })) });
  ctx.runManager = options.runManager || createRunManager({
    root, configPath, hubDirectory, io, now, pidAlive,
    spawn: options.spawn, nodeBinary: options.nodeBinary, entrypoint: options.entrypoint,
    // A finished Run Now rewrote the day payload: drop the cached days and renders.
    onFinished: async () => { ctx.reportCache.invalidate('run'); },
    ...(options.platform ? { platform: options.platform } : {}),
  });
  // Checks every 10 minutes for a run the network cut short; startHub starts the timer.
  ctx.autoCatchUp = options.autoCatchUp || createAutoCatchUp({
    io, hubDirectory, now, runManager: ctx.runManager,
    // The cached state view (src/hub/services.mjs): parsed once per state.json write, not every 10 minutes.
    readState: () => readStateView(ctx).catch(() => ({})),
    loadConfig: () => ctx.loadConfig(),
    schedule: () => installedSchedule(ctx),
    nextScheduledRun,
    notify: text => ctx.notify(text),
    ...(options.networkProbe ? { probe: options.networkProbe } : {}),
  });
  // Checks Claude's login every 10 minutes; startHub starts the timer (src/hub/auth-watch.mjs).
  ctx.authWatch = options.authWatch || createAuthWatch({
    io, hubDirectory, now, authState: ctx.authState,
    probe: async () => {
      const config = await ctx.loadConfig().catch(() => ({}));
      return (await ctx.connections.status({ force: true, commands: configuredCliCommands(config) }))?.claude || null;
    },
    notify: text => ctx.notify(text),
    timeZone: async () => (await ctx.loadConfig().catch(() => ({}))).timeZone || 'America/Chicago',
  });
  return ctx;
}

export function createHubServer(ctx) {
  const handler = createHubHandler(ctx);
  const server = http.createServer((request, response) => {
    handler(request, response).catch(error => {
      console.error(error?.stack || error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('Hub error');
    });
  });
  server.keepAliveTimeout = 5000;
  return server;
}

export async function checkHubIntegrity(ctx) {
  try {
    await readStateView(ctx);
    ctx.integrity = await checkIntegrity(ctx.root, { io: ctx.io, now: ctx.now(), seenCount: ctx.stateView?.seenCount ?? null });
    for (const file of ctx.integrity.files.filter(item => !item.ok)) console.warn(`[hub] state/${file.name} does not parse: ${file.error}`);
    if (ctx.stateView?.restored) console.warn(`[hub] state/state.json does not parse; reading ${ctx.stateView.restored.from || 'nothing'} until the next run restores it`);
    if (ctx.integrity.seenDrop) console.warn(`[hub] state.json holds ${ctx.integrity.seenDrop.current} seen postings against ${ctx.integrity.seenDrop.previous} at the last run`);
  } catch (error) {
    console.warn(`[hub] state integrity check failed: ${error?.message || error}`);
  }
  return ctx.integrity || null;
}

export async function startHub(options = {}) {
  const configPath = path.resolve(options.configPath || 'config.json');
  const config = await loadConfig(configPath, { notify: message => console.warn(message) });
  const port = Number(options.port || config.hub?.port || DEFAULT_HUB_PORT);
  const ctx = createHubContext({ ...options, configPath, port });
  const server = createHubServer(ctx);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HUB_HOST, () => { server.off('error', reject); resolve(); });
  });
  ctx.autoCatchUp.start();
  // Startup integrity check of state/ (src/state-integrity.mjs), in the background: every JSON parses, and
  // the seen count against the one the last run recorded. The Status banner shows what it finds.
  ctx.integrityCheck = checkHubIntegrity(ctx);
  // Claude's login: checked now and every 10 minutes; signed out → banner, sidebar, one notification a day.
  ctx.authWatch.start();
  ctx.loginCheck = ctx.authWatch.check();
  server.on('close', () => { ctx.autoCatchUp.stop(); ctx.authWatch.stop(); });
  return { server, ctx, url: `http://${HUB_HOST}:${port}/` };
}

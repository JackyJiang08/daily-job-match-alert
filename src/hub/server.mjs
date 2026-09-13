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
import { createConnectionsProbe } from './connections.mjs';

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
  ctx.connections = options.connections || createConnectionsProbe({ now, runner: options.cliRunner, describe: options.describeConnections });
  ctx.runManager = options.runManager || createRunManager({
    root, configPath, hubDirectory, io, now, pidAlive,
    spawn: options.spawn, nodeBinary: options.nodeBinary, entrypoint: options.entrypoint,
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
  return { server, ctx, url: `http://${HUB_HOST}:${port}/` };
}

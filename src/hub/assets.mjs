// The hub's stylesheet and page scripts, served as content-addressed files (/assets/hub-<hash>.css|js)
// with a one-year immutable cache instead of being inlined in every page. The name changes whenever the
// content does, so a new hub version is picked up at once. Only strings the views register are served.
import { createHash } from 'node:crypto';

const TYPES = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8' };
const byName = new Map();
const byContent = new Map();
export const ASSET_PATTERN = /^\/assets\/(hub-[a-f0-9]{16}\.(?:css|js))$/;
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function assetPath(content, ext) {
  if (!TYPES[ext]) throw new Error(`Unknown asset type: ${ext}`);
  const memo = `${ext}\u0000${content}`;
  let name = byContent.get(memo);
  if (!name) {
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    name = `hub-${hash}.${ext}`;
    byContent.set(memo, name);
    byName.set(name, { body: Buffer.from(content, 'utf8'), type: TYPES[ext], etag: `"${hash}"` });
  }
  return `/assets/${name}`;
}

export function readAsset(name) {
  return byName.get(name) || null;
}

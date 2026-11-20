// Corner shapes (2026-11-19): every radius comes from the tokens in report-theme.mjs, the restyle changed only
// classes, styles and the frame wrappers (the text, links, fields and scripts of every page are the same as
// before it), and in Chrome no text enters a rounded corner and nested corners are concentric
// (scripts/shape-check.mjs; skipped where playwright-core or Chrome is not installed, as on CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORNER_K, RADIUS_TOKENS, REPORT_STYLES, SQUIRCLE_STYLES } from '../src/report-theme.mjs';
import { createHash } from 'node:crypto';
import { readAsset } from '../src/hub/assets.mjs';
import { buildUiPages } from './helpers/ui-pages.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOTS = new URL('./fixtures/snapshots/shapes/', import.meta.url);

async function sourceFiles(directory) {
  const out = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(file));
    else if (/\.(mjs|js|css|html|sh)$/.test(entry.name)) out.push(file);
  }
  return out;
}

test('every border radius names a token: no length in a border-radius outside the token definitions', async () => {
  const files = [...await sourceFiles(path.join(ROOT, 'src')), ...await sourceFiles(path.join(ROOT, 'scripts'))];
  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    for (const [declaration, value] of text.matchAll(/border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius\s*:\s*([^;}"'`]*)/g)) {
      // Allowed: var(--…) and calc()/max() of tokens, 0, and 50% for a circle. Not allowed: any other length.
      const rest = value.replace(/var\(--[\w-]+(?:,\s*var\(--[\w-]+\))?\)/g, '').replace(/\b50%/g, '');
      if (/\d*\.?\d+(px|rem|em|%|vh|vw)\b/.test(rest) || /(?<![\w.-])[1-9]\d*(?![\w.%-])/.test(rest)) offenders.push(`${path.relative(ROOT, file)}: ${declaration.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(REPORT_STYLES, /--radius(-sm)?\b/, 'the old --radius / --radius-sm tokens are gone');
  for (const [token, px] of [['xs', 6], ['sm', 10], ['md', 14], ['lg', 20], ['xl', 28]]) assert.ok(RADIUS_TOKENS.includes(`--r-${token}: calc(${px}px * var(--corner-k))`), token);
  assert.match(RADIUS_TOKENS, /--r-pill: 999px/);
  assert.match(SQUIRCLE_STYLES, /^@supports \(corner-shape: squircle\)\{/);
  assert.ok(SQUIRCLE_STYLES.includes(`--corner-k:${CORNER_K}`));
  assert.match(SQUIRCLE_STYLES, /\.ring,\.ring::before[^{]*\{corner-shape:round\}/, 'the score ring stays a circle');
  assert.doesNotMatch(REPORT_STYLES, /clip-path|mask-image|-webkit-mask/, 'no mask or clip-path stands in for the corners');
});

// The wrappers the restyle added: each holds the corners and clips, while the element inside it scrolls.
const WRAPPERS = ['jd-frame', 'log-frame', 'table-wrap', 'cal-body', 'text-frame'];
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// A page reduced to what it says and does: the stylesheets and the asset hashes left out, class and style
// attributes dropped, the frame wrappers taken out (their contents kept), the hub's render timings blanked.
export function contentOf(html) {
  const tokens = String(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/\/assets\/hub-[a-f0-9]{16}\.(css|js)/g, '/assets/hub-HASH.$1')
    .split(/(<[^>]+>)/);
  const out = [];
  const stack = [];
  let raw = null;
  for (const token of tokens) {
    if (raw) {
      if (token.toLowerCase() === `</${raw}>`) raw = null;
      out.push(token);
      continue;
    }
    const open = /^<([a-zA-Z][\w-]*)\b([^>]*)>$/.exec(token);
    const close = /^<\/([a-zA-Z][\w-]*)\s*>$/.exec(token);
    if (open) {
      const tag = open[1].toLowerCase();
      const classes = (/\sclass="([^"]*)"/.exec(open[2])?.[1] || '').split(/\s+/);
      const selfClosing = VOID.has(tag) || open[2].trim().endsWith('/');
      const wrapper = classes.some(name => WRAPPERS.includes(name)) && !selfClosing;
      if (!selfClosing) stack.push({ tag, wrapper });
      if (tag === 'script' || tag === 'textarea') raw = tag;
      if (!wrapper) out.push(`<${open[1]}${open[2].replace(/\s(class|style)="[^"]*"/g, '')}>`);
    } else if (close) {
      const tag = close[1].toLowerCase();
      let item = stack.pop();
      while (item && item.tag !== tag) item = stack.pop();
      if (!item?.wrapper) out.push(token);
    } else {
      out.push(token);
    }
  }
  // The Status page's table of the hub's own page timings records wall-clock times: its rows are left out.
  // The backup folder differs by platform (Application Support on macOS); the snapshots were taken on macOS.
  return out.join('').replace(/title="ROOT\/[^"]*\/backups"/g, 'title="ROOT/BACKUPS"').replace(/(<table id="hub-timings">)[\s\S]*?<\/table>/, '$1</table>').replace(/\d+(?:\.\d+)? ms\b/g, 'N ms');
}

// The one script change: the letter editor puts a new paragraph's text area in its frame. With that change
// undone, the page script is byte for byte the one the snapshot was taken with (its content hash matches).
const SCRIPT_CHANGES = [[
  "var frame = document.createElement('div'); frame.className = 'text-frame'; frame.appendChild(area);\n      row.appendChild(num); row.appendChild(frame); box.appendChild(row);",
  'row.appendChild(num); row.appendChild(area); box.appendChild(row);',
]];

function assertSameScript(name, before, after) {
  const was = /<script src="\/assets\/(hub-[a-f0-9]{16}\.js)"><\/script>/.exec(before)?.[1];
  const now = /<script src="\/assets\/(hub-[a-f0-9]{16}\.js)"><\/script>/.exec(after)?.[1];
  assert.equal(Boolean(was), Boolean(now), `${name}: page script link`);
  if (!was || was === now) return;
  let script = readAsset(now).body.toString('utf8');
  for (const [changed, original] of SCRIPT_CHANGES) script = script.split(changed).join(original);
  assert.equal(`hub-${createHash('sha256').update(script).digest('hex').slice(0, 16)}.js`, was, `${name}: the page script changed beyond the text-area frame`);
}

test('content snapshots: each page says and does what it did before the restyle; only classes, styles and frame wrappers changed', async () => {
  const ui = await buildUiPages();
  try {
    for (const page of ui.pages) {
      const before = await fs.readFile(new URL(`${page.name}.html`, SNAPSHOTS), 'utf8');
      const after = await ui.html(page);
      assertSameScript(page.name, before, after);
      const a = contentOf(before);
      const b = contentOf(after);
      if (a !== b) {
        let at = 0;
        while (a[at] === b[at]) at += 1;
        assert.fail(`${page.name}: content changed at ${at}\nbefore: …${a.slice(Math.max(0, at - 120), at + 160)}\nafter:  …${b.slice(Math.max(0, at - 120), at + 160)}`);
      }
      // The wrappers are there: the JD, the logs and the picker each have their frame.
      if (page.name === 'report') {
        assert.match(after, /<div class="jd-frame"><div class="jd-body">/);
        assert.match(after, /<div class="cal" id="calendar"[^>]*><div class="cal-body">/);
      }
      if (page.name === 'desktop') assert.match(after, /<div class="jd-frame"><div class="jd-body">/);
      if (page.name === 'status') assert.match(after, /<div class="log-frame"><pre class="log"/);
      if (page.name === 'settings-letters') assert.match(after, /<div class="text-frame"><textarea name="companyAliases"/);
    }
  } finally {
    await ui.close();
  }
});

test('contentOf keeps text, links and fields, and drops only classes, styles and the named wrappers', () => {
  const before = '<div class="a" style="x"><p>Hi <a href="/x">there</a></p><input id="q" name="q" value="1"></div>';
  assert.equal(contentOf(before), contentOf('<div class="b"><div class="jd-frame"><p>Hi <a href="/x" class="c">there</a></p></div><input id="q" name="q" value="1" style="y"></div>'));
  assert.notEqual(contentOf(before), contentOf(before.replace('there', 'here')));
  assert.notEqual(contentOf(before), contentOf(before.replace('/x', '/y')));
  assert.notEqual(contentOf(before), contentOf(before.replace('value="1"', 'value="2"')));
  assert.notEqual(contentOf(before), contentOf(before.replace('<p>', '<section><p>').replace('</p>', '</p></section>')), 'a new element that is not a frame wrapper counts');
});

async function chromeAvailable() {
  try {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

test('in Chrome, on every page at 1440 and 1100, light and dark, squircle and plain corners: no text in a corner, concentric nesting, padding, no rounded scroller', { timeout: 600_000 }, async t => {
  if (!await chromeAvailable()) {
    t.skip('playwright-core or Chrome is not installed (npm install --no-save playwright-core; Chrome channel)');
    return;
  }
  const { runShapeCheck, summarize } = await import('../scripts/shape-check.mjs');
  const { results, outside } = await runShapeCheck();
  assert.ok(results.length >= 100, `${results.length} page states checked`);
  assert.ok(results.every(result => result.checked > 0));
  const failures = summarize(results).map(failure => `${failure.page} [${failure.rule}] ${failure.element}: ${failure.detail} (${failure.where[0]})`);
  assert.deepEqual(failures, []);
  assert.deepEqual(outside, [], 'no request leaves the machine');
});

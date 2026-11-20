// Corner and padding checks for every rounded box on the hub pages and the Desktop HTML (2026-11-19), run in
// Chrome through playwright-core against placeholder data (tests/helpers/ui-pages.mjs; no real engine, search
// API or job site is reached). For each element with a border radius it asserts:
//   corner   – no text box enters the area a rounded corner cuts off (the curve itself: a circle, or the
//              superellipse corner-shape: squircle draws);
//   nested   – inside a rounded box, an element in one of the box's corners has radius = max(outer radius − gap,
//              --r-xs) within 1px (the gap measured from the outer box's border);
//   padding  – text sits at least max(12px, 0.6 × radius) from a box's edges, and at least 0.8 × radius from the
//              left and right edge of a control (48px tall or less: buttons, tags, inputs, list rows);
//   scroll   – a rounded box does not scroll itself, and a scrolling box inside one stays clear of its corners;
//   clip     – a rounded box that clips content (overflow hidden) has nothing cut off sideways;
//   round    – a circle (50%) or capsule stays round where corner-shape is supported.
// The radius in the padding rule is the token value (the drawn radius divided by --corner-k).
//
// Usage: node scripts/shape-check.mjs [--shots <dir>]   (playwright-core and Chrome must be installed)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUiPages } from '../tests/helpers/ui-pages.mjs';

export const WIDTHS = [1440, 1100];
export const SCHEMES = ['light', 'dark'];
// Chrome draws squircles; "plain" puts back the rounded corners a browser without corner-shape draws (Safari 27).
export const MODES = ['squircle', 'plain'];
const PLAIN_CORNERS = ':root:root{--corner-k:1}*,*::before,*::after{corner-shape:round!important}';

// Runs in the page. Returns { checked, violations: [{ rule, element, detail }] }.
export function auditShapes() {
  const root = getComputedStyle(document.documentElement);
  const k = parseFloat(root.getPropertyValue('--corner-k')) || 1;
  const xs = 6 * k;
  const squircleSupported = typeof CSS !== 'undefined' && CSS.supports('corner-shape: squircle');
  const violations = [];
  const label = element => {
    const classes = [...element.classList].slice(0, 3).join('.');
    const text = (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32);
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes ? `.${classes}` : ''}${text ? ` "${text}"` : ''}`;
  };
  const px = value => parseFloat(value) || 0;
  const visible = element => {
    if (element.checkVisibility && !element.checkVisibility({ visibilityProperty: true, opacityProperty: false })) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  };
  // The four corner radii as drawn: [horizontal, vertical] each, percentages resolved, scaled down together
  // when they do not fit (CSS Backgrounds 3, "corner overlap").
  function radii(element, rect, style) {
    const corner = value => {
      const parts = String(value).split(' ');
      const one = (part, size) => (part.endsWith('%') ? (parseFloat(part) / 100) * size : px(part));
      return [one(parts[0], rect.width), one(parts[1] ?? parts[0], rect.height)];
    };
    const tl = corner(style.borderTopLeftRadius);
    const tr = corner(style.borderTopRightRadius);
    const br = corner(style.borderBottomRightRadius);
    const bl = corner(style.borderBottomLeftRadius);
    const ratio = (size, a, b) => (a + b > 0 ? size / (a + b) : Infinity);
    const f = Math.min(1, ratio(rect.width, tl[0], tr[0]), ratio(rect.width, bl[0], br[0]), ratio(rect.height, tl[1], bl[1]), ratio(rect.height, tr[1], br[1]));
    return { tl: tl.map(v => v * f), tr: tr.map(v => v * f), br: br.map(v => v * f), bl: bl.map(v => v * f) };
  }
  // corner-shape as an exponent: round = superellipse(1) → 2 (a circle), squircle = superellipse(2) → 4.
  const shapeOf = style => {
    const value = style.cornerShape || 'round';
    if (value === 'round') return 2;
    if (value === 'squircle') return 4;
    const match = /superellipse\(([\d.]+)\)/.exec(value);
    return match ? 2 ** Number(match[1]) : 2;
  };
  // Is the point inside the rounded shape of `box` (radii r, exponent n: 2 round, 4 squircle)?
  function inside(point, box, r, n, slack = 0.5) {
    const corners = [
      ['tl', box.left + r.tl[0], box.top + r.tl[1], point.x < box.left + r.tl[0] && point.y < box.top + r.tl[1]],
      ['tr', box.right - r.tr[0], box.top + r.tr[1], point.x > box.right - r.tr[0] && point.y < box.top + r.tr[1]],
      ['br', box.right - r.br[0], box.bottom - r.br[1], point.x > box.right - r.br[0] && point.y > box.bottom - r.br[1]],
      ['bl', box.left + r.bl[0], box.bottom - r.bl[1], point.x < box.left + r.bl[0] && point.y > box.bottom - r.bl[1]],
    ];
    for (const [name, cx, cy, inZone] of corners) {
      if (!inZone) continue;
      const [rx, ry] = r[name];
      if (rx <= 0 || ry <= 0) continue;
      const u = Math.max(0, Math.abs(point.x - cx) - slack) / rx;
      const v = Math.max(0, Math.abs(point.y - cy) - slack) / ry;
      if (u ** n + v ** n > 1) return name;
    }
    return null;
  }
  const clipsOverflow = style => style.overflowX !== 'visible' || style.overflowY !== 'visible';
  // The text boxes under `element`, each cut to the boxes that clip it (scrolling or hidden overflow).
  function textRects(element, options = {}) {
    const out = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue.trim()) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,template,textarea,select,option,svg') || !visible(parent)) continue;
      // A legend is drawn on its fieldset's border by design: it is held to the corners, not to the padding.
      const legend = parent.closest('legend');
      if (legend && legend.parentElement === element && !options.withLegends) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const raw of range.getClientRects()) {
        let rect = { left: raw.left, top: raw.top, right: raw.right, bottom: raw.bottom };
        for (let up = parent; up && rect; up = up.parentElement) {
          if (clipsOverflow(getComputedStyle(up))) {
            const box = up.getBoundingClientRect();
            const inner = { left: box.left + up.clientLeft, top: box.top + up.clientTop, right: box.left + up.clientLeft + up.clientWidth, bottom: box.top + up.clientTop + up.clientHeight };
            rect = { left: Math.max(rect.left, inner.left), top: Math.max(rect.top, inner.top), right: Math.min(rect.right, inner.right), bottom: Math.min(rect.bottom, inner.bottom) };
            if (rect.right - rect.left < 0.5 || rect.bottom - rect.top < 0.5) rect = null;
          }
          if (up === element) break;
        }
        if (rect && rect.right - rect.left > 0.5) out.push({ ...rect, text: node.nodeValue.trim().slice(0, 24) });
      }
    }
    return out;
  }
  const rounded = [];
  for (const element of document.querySelectorAll('body *')) {
    if (element.closest('svg') && element.tagName.toLowerCase() !== 'svg') continue;
    const style = getComputedStyle(element);
    if (!['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].some(prop => px(style[prop]) > 0)) continue;
    if (!visible(element)) continue;
    const rect = element.getBoundingClientRect();
    const r = radii(element, rect, style);
    const max = Math.max(...Object.values(r).map(v => Math.max(...v)));
    // A circle (50%) or a capsule (--r-pill); a large radius clamped to half the height is still a squircle.
    const round = /%/.test(style.borderTopLeftRadius) || px(style.borderTopLeftRadius) >= 500;
    rounded.push({ element, style, rect, r, max, round, n: shapeOf(style) });
  }
  for (const item of rounded) {
    const { element, style, rect, r, n } = item;
    const name = label(element);
    // corner + padding
    const inBox = t => t.right > rect.left && t.left < rect.right && t.bottom > rect.top && t.top < rect.bottom;
    const cornerTexts = textRects(element, { withLegends: true }).filter(inBox);
    const texts = textRects(element).filter(t => t.right > rect.left && t.left < rect.right && t.bottom > rect.top && t.top < rect.bottom);
    for (const t of cornerTexts) {
      const hit = [{ x: t.left, y: t.top }, { x: t.right, y: t.top }, { x: t.right, y: t.bottom }, { x: t.left, y: t.bottom }].map(p => inside(p, rect, r, n)).find(Boolean);
      if (hit) violations.push({ rule: 'corner', element: name, detail: `text "${t.text}" enters the ${hit} corner (radius ${Math.round(r[hit][0])}px)` });
    }
    if (texts.length && !item.round) {
      const base = item.max / k;
      const gap = side => Math.min(...texts.map(t => (side === 'left' ? t.left - rect.left : side === 'right' ? rect.right - t.right : side === 'top' ? t.top - rect.top : rect.bottom - t.bottom)));
      const control = rect.height <= 48;
      const need = control ? 0.8 * base : Math.max(12, 0.6 * base);
      for (const side of control ? ['left', 'right'] : ['left', 'right', 'top', 'bottom']) {
        const value = gap(side);
        if (value < need - 0.5) violations.push({ rule: 'padding', element: name, detail: `${side} ${value.toFixed(1)}px < ${need.toFixed(1)}px (${control ? 'control' : 'box'}, radius ${base.toFixed(1)}px)` });
      }
    } else if (texts.length && item.round && rect.height <= 48 && Math.abs(rect.width - rect.height) > 1) {
      // A capsule: the text keeps 0.8 × its end radius from either end.
      const need = 0.8 * (rect.height / 2);
      const left = Math.min(...texts.map(t => t.left - rect.left));
      const right = Math.min(...texts.map(t => rect.right - t.right));
      if (Math.min(left, right) < need - 0.5) violations.push({ rule: 'padding', element: name, detail: `capsule ${Math.min(left, right).toFixed(1)}px < ${need.toFixed(1)}px` });
    }
    // scroll: a rounded box never scrolls itself
    if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) violations.push({ rule: 'scroll', element: name, detail: `rounded box has overflow ${style.overflowX}/${style.overflowY}` });
    // clip: nothing cut off sideways
    if (/(hidden|clip)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1) violations.push({ rule: 'clip', element: name, detail: `content ${element.scrollWidth}px wide in ${element.clientWidth}px` });
    // round: circles and capsules keep a round corner shape
    if (squircleSupported && item.round && item.n !== 2) violations.push({ rule: 'round', element: name, detail: `circle or capsule drawn with corner-shape ${style.cornerShape}` });
  }
  // nested: concentric corners
  for (const item of rounded) {
    if (item.round) continue;
    let outer = null;
    for (let up = item.element.parentElement; up && !outer; up = up.parentElement) {
      const found = rounded.find(candidate => candidate.element === up);
      if (found && item.rect.left >= found.rect.left - 0.5 && item.rect.right <= found.rect.right + 0.5 && item.rect.top >= found.rect.top - 0.5 && item.rect.bottom <= found.rect.bottom + 0.5) outer = found;
    }
    if (!outer) continue;
    const a = outer.rect;
    const e = item.rect;
    const borderOf = (style, side) => px(style[`border${side}Width`]);
    const corners = {
      tl: [e.left - a.left, e.top - a.top, Math.max(borderOf(outer.style, 'Left'), borderOf(outer.style, 'Top'))],
      tr: [a.right - e.right, e.top - a.top, Math.max(borderOf(outer.style, 'Right'), borderOf(outer.style, 'Top'))],
      br: [a.right - e.right, a.bottom - e.bottom, Math.max(borderOf(outer.style, 'Right'), borderOf(outer.style, 'Bottom'))],
      bl: [e.left - a.left, a.bottom - e.bottom, Math.max(borderOf(outer.style, 'Left'), borderOf(outer.style, 'Bottom'))],
    };
    for (const [corner, [dx, dy, border]] of Object.entries(corners)) {
      const outerRadius = outer.r[corner][0];
      if (outerRadius <= 0 || dx > outerRadius || dy > outerRadius) continue;
      // A box too small for the concentric radius is drawn with half its height (or width) instead.
      const expected = Math.min(Math.max(outerRadius - (Math.max(dx, dy) - border), xs), Math.min(e.width, e.height) / 2);
      const actual = item.r[corner][0];
      if (Math.abs(actual - expected) > 1) violations.push({ rule: 'nested', element: label(item.element), detail: `${corner} radius ${actual.toFixed(1)}px, expected ${expected.toFixed(1)}px (outer ${label(outer.element)} ${outerRadius.toFixed(1)}px, gap ${Math.max(dx, dy).toFixed(1)}px)` });
    }
  }
  // scroll: a scrolling box inside a rounded box keeps its corners inside the rounded shape
  for (const scroller of document.querySelectorAll('body *')) {
    const style = getComputedStyle(scroller);
    if (!/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`) || !visible(scroller)) continue;
    if (scroller.scrollHeight <= scroller.clientHeight + 1 && scroller.scrollWidth <= scroller.clientWidth + 1) continue;
    const box = scroller.getBoundingClientRect();
    for (let up = scroller.parentElement; up; up = up.parentElement) {
      const outer = rounded.find(candidate => candidate.element === up);
      if (!outer) continue;
      const hit = [{ x: box.left, y: box.top }, { x: box.right, y: box.top }, { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom }].map(p => inside(p, outer.rect, outer.r, outer.n, 0)).find(Boolean);
      if (hit) violations.push({ rule: 'scroll', element: label(scroller), detail: `scrolling box reaches the ${hit} corner of ${label(outer.element)}` });
      break;
    }
  }
  return { checked: rounded.length, violations };
}

// The states each page is checked in: as loaded, plus the popovers, the open JD and the drawer on the report.
async function states(page, entry, base, firstJobId) {
  const list = [['default', async () => {}]];
  if (entry.name === 'report' || entry.name === 'desktop') {
    list.push(['jd-open', async () => { await page.evaluate(() => document.querySelectorAll('details.jd').forEach(d => { d.open = true; })); await page.waitForTimeout(300); }]);
    list.push(['filters-open', async () => { await page.evaluate(() => { const menu = document.querySelector('#filters-menu, details.menu:not(.overflow)'); if (menu) menu.open = true; }); }]);
  }
  if (entry.name === 'report') {
    list.push(['picker-open', async () => { await page.evaluate(() => document.querySelectorAll('details.menu').forEach(d => { d.open = false; })); await page.click('#date-button'); await page.waitForSelector('#calendar:not([hidden])'); }]);
    list.push(['more-open', async () => { await page.keyboard.press('Escape'); await page.evaluate(() => { const menu = document.getElementById('more-menu'); if (menu) menu.open = true; }); }]);
    list.push(['drawer-open', async () => {
      await page.evaluate(() => document.querySelectorAll('details.menu').forEach(d => { d.open = false; }));
      await page.click(`[data-reach][data-job="${firstJobId}"]`);
      await page.waitForSelector('#reach-people:not([data-loading])');
      await page.waitForTimeout(200);
    }]);
  }
  return list;
}

export async function runShapeCheck({ shots = null, widths = WIDTHS, schemes = SCHEMES, modes = MODES } = {}) {
  const { chromium } = await import('playwright-core');
  const ui = await buildUiPages();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  const requests = [];
  try {
    if (shots) for (const mode of modes) await fs.mkdir(path.join(shots, mode), { recursive: true });
    const pages = ui.pages.filter(entry => !entry.fragment);
    for (const mode of modes) for (const width of widths) for (const scheme of schemes) for (const entry of pages) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
      page.on('request', request => requests.push(request.url()));
      await page.goto(entry.url);
      if (mode === 'plain') await page.addStyleTag({ content: PLAIN_CORNERS });
      await page.evaluate(() => document.fonts && document.fonts.ready);
      for (const [state, apply] of await states(page, entry, ui.base, ui.firstJobId)) {
        await apply();
        const audit = await page.evaluate(auditShapes);
        results.push({ page: entry.name, mode, width, scheme, state, ...audit });
        const shotName = state === 'default' ? entry.name : state === 'drawer-open' ? 'message-to-recruiters' : null;
        if (shots && shotName) await page.screenshot({ path: path.join(shots, mode, `${shotName}-${width}-${scheme}.png`) });
        if (shots && entry.name === 'report' && state === 'picker-open') await page.screenshot({ path: path.join(shots, mode, `report-picker-${width}-${scheme}.png`) });
      }
      await page.close();
    }
  } finally {
    await browser.close();
    await ui.close();
  }
  const outside = requests.filter(url => !/^(http:\/\/127\.0\.0\.1:\d+\/|file:|data:|about:)/.test(url));
  return { results, outside };
}

export function summarize(results) {
  const seen = new Map();
  for (const result of results) for (const v of result.violations) {
    const key = `${result.page} ${v.rule} ${v.element} ${v.detail}`;
    if (!seen.has(key)) seen.set(key, { ...v, page: result.page, where: [] });
    seen.get(key).where.push(`${result.mode}/${result.width}/${result.scheme}/${result.state}`);
  }
  return [...seen.values()];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const at = process.argv.indexOf('--shots');
  const { results, outside } = await runShapeCheck({ shots: at > 0 ? path.resolve(process.argv[at + 1]) : null });
  const failures = summarize(results);
  for (const result of results) console.log(`${result.mode} ${result.page} ${result.width} ${result.scheme} ${result.state}: ${result.checked} rounded, ${result.violations.length} failing`);
  for (const failure of failures) console.log(`FAIL ${failure.page} [${failure.rule}] ${failure.element}: ${failure.detail} (${failure.where.length}× e.g. ${failure.where[0]})`);
  if (outside.length) console.log(`Requests off this machine: ${outside.join(', ')}`);
  console.log(`${failures.length} failing element(s)`);
  process.exitCode = failures.length || outside.length ? 1 : 0;
}

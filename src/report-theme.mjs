// Visual system for the daily HTML report: design tokens, the stylesheet, and the small client script
// behind the toolbar. Everything is inlined into the page so it opens as a plain local file with no
// network access. The tokens are the contract a later local hub can reuse: change them here and every
// component in report-components.mjs follows.
import { cardPasses, filtersActive, readFilters, writeFilters } from './report-filters.mjs';
import { descriptionPlainText } from './jd-html.mjs';

// Corner radii (2026-11-19). --corner-k is 1 for plain rounded corners; where the browser draws continuous
// (squircle) corners it is CORNER_K, so a squircle cuts about as much off a corner as the plain radius would.
// The tokens are the only place a radius has a length; every border-radius in the code names one of them, a
// calc() of them, 50% for a circle, or 0.
export const CORNER_K = 1.6;
export const RADIUS_TOKENS = `--corner-k: 1;
  --r-xs: calc(6px * var(--corner-k));
  --r-sm: calc(10px * var(--corner-k));
  --r-md: calc(14px * var(--corner-k));
  --r-lg: calc(20px * var(--corner-k));
  --r-xl: calc(28px * var(--corner-k));
  --r-pill: 999px;`;

// Continuous corners: every rounded box gets corner-shape: squircle where the browser supports it, with the
// radii scaled by --corner-k; circles (50%) and capsules (--r-pill) stay round. Browsers without corner-shape keep
// plain border-radius (no mask or clip-path: those would cut off shadows, borders and focus rings).
export const SQUIRCLE_STYLES = `@supports (corner-shape: squircle){
  :root{--corner-k:${CORNER_K}}
  *,::before,::after{corner-shape:squircle}
  .ring,.ring::before,.facts li::before,.tag,.round{corner-shape:round}
}`;

export const REPORT_TOKENS = `
  color-scheme: light dark;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  /* Type scale, three levels: titles (page and card headings), body, and supporting text. */
  --fs-title: 18px;
  --fs-body: 14px;
  --fs-meta: 12px;
  --fs-page: var(--fs-title);
  --lh: 1.5;
  /* One accent, one neutral ramp. */
  --accent: #0f766e;
  --accent-ink: #ffffff;
  --accent-soft: rgba(15, 118, 110, 0.10);
  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-glass: rgba(255, 255, 255, 0.82);
  --ink: #1c2430;
  --ink-2: #4b5563;
  --ink-3: #5b6472;
  --line: #e3e7ec;
  --line-2: #cfd5dd;
  --ring-track: #e5e9ee;
  /* Semantic badge tones. */
  --note-bg: #fbf3d5;
  --note-ink: #6b5300;
  --warn-bg: #fdebd3;
  --warn-ink: #8a4b00;
  --bad-bg: #fbe3e3;
  --bad-ink: #8b1d1d;
  /* Shape and rhythm: every gap, margin and padding is one of the six spacing steps. Corner radii come in five
     steps (RADIUS_TOKENS); a box inside another rounded box takes its radius from --in-r, which every rounded
     container sets to its own radius minus its padding (never below --r-xs), so nested corners are concentric. */
  ${RADIUS_TOKENS}
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 40px;
  /* Shadows: soft and wide, so they read as depth under the large corners. */
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 4px 16px rgba(16, 24, 40, 0.04);
  --shadow-pop: 0 12px 40px rgba(16, 24, 40, 0.10), 0 2px 6px rgba(16, 24, 40, 0.04);
  --shadow-drawer: -16px 0 48px rgba(16, 24, 40, 0.10);
  --control-height: 32px;
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%235b6472' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
`;

export const REPORT_TOKENS_DARK = `
  --accent: #2dd4bf;
  --accent-ink: #04211e;
  --accent-soft: rgba(45, 212, 191, 0.14);
  --bg: #0f1318;
  --surface: #171c23;
  --surface-glass: rgba(23, 28, 35, 0.82);
  --ink: #e6e9ee;
  --ink-2: #b4bcc8;
  --ink-3: #9aa3b1;
  --line: #252c36;
  --line-2: #333c48;
  --ring-track: #2a323d;
  --note-bg: #3a3412;
  --note-ink: #e8d57a;
  --warn-bg: #3a2a12;
  --warn-ink: #f2c184;
  --bad-bg: #3d1a1a;
  --bad-ink: #f3a9a9;
  --shadow: none;
  --shadow-pop: 0 12px 40px rgba(0, 0, 0, 0.45);
  --shadow-drawer: -16px 0 48px rgba(0, 0, 0, 0.45);
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%239aa3b1' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
`;

export const REPORT_STYLES = `
:root{${REPORT_TOKENS}}
@media (prefers-color-scheme: dark){:root{${REPORT_TOKENS_DARK}}}
${SQUIRCLE_STYLES}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:var(--fs-body)/var(--lh) var(--font)}
a{color:inherit}
.page{--gutter:var(--space-4);max-width:920px;margin:0 auto;padding:var(--space-5) var(--gutter) var(--space-6)}

/* Buttons: one primary style (filled) and one secondary style (outlined), one size everywhere. "small" is
   kept as a class for older markup and no longer changes the size. */
.btn,.apply{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-1);min-height:var(--control-height);padding:0 var(--space-3);border:1px solid var(--accent);border-radius:var(--in-r, var(--r-sm));background:var(--accent);color:var(--accent-ink);font:inherit;font-size:var(--fs-body);font-weight:600;line-height:1.2;text-decoration:none;white-space:nowrap;cursor:pointer}
.btn:hover,.apply:hover{filter:brightness(1.06)}
.btn.secondary{background:var(--surface);color:var(--ink);border-color:var(--line-2)}
.btn.secondary:hover{filter:none;border-color:var(--ink-3)}
.btn.small{min-height:var(--control-height);padding:0 var(--space-3);font-size:var(--fs-body)}
.btn.danger{background:var(--bad-bg);color:var(--bad-ink);border-color:transparent}
.btn[disabled]{opacity:.55;cursor:not-allowed;filter:none}
.btn:focus-visible,.apply:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}

.banner{margin:0 0 var(--space-4);padding:var(--space-3) var(--space-4);border-radius:var(--r-md);background:var(--warn-bg);color:var(--warn-ink);font-size:var(--fs-body)}
.quota-note{margin:0 0 var(--space-3);font-size:var(--fs-body);color:var(--warn-ink);font-weight:600}
/* The one top row: the date ("November 15, 2026"; ‹ date › in the hub) and the count, then the search, sort, Track and Role Type controls, the Filters
   popover and the hub's "⋯" menu. It stays at the top while the list scrolls (a rule and a blur once it is
   stuck); at 1100px and wider it never wraps. */
.bar-sentinel{height:0}
/* The bar's background and bottom rule reach across the page's side gutters; the controls stay in the column. */
.toolbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);margin:0 calc(-1 * var(--gutter, 0px)) var(--space-4);padding:var(--space-2) var(--gutter, 0px);background:var(--bg);border-bottom:1px solid transparent}
.toolbar.stuck{background:var(--surface-glass);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-bottom-color:var(--line)}
.bar-title{display:inline-flex;align-items:baseline;gap:var(--space-2);flex:0 0 auto;margin-right:auto;font-size:var(--fs-title);font-weight:700;letter-spacing:-0.01em;line-height:1.3;white-space:nowrap}
.bar-title .sep{color:var(--ink-3);font-weight:400}
.bar-title .count{font-size:var(--fs-body);font-weight:400;color:var(--ink-2);font-variant-numeric:tabular-nums}
/* One control style for every text input and select, in the report toolbar and in the hub forms. */
.control-input,.toolbar input:not([type=checkbox]),.toolbar select{font:inherit;font-size:var(--fs-body);line-height:1.3;color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--in-r, var(--r-sm));padding:var(--space-1) var(--space-2);min-height:var(--control-height);box-sizing:border-box}
select.control-input,.toolbar select{appearance:none;-webkit-appearance:none;background-image:var(--chevron);background-repeat:no-repeat;background-position:right var(--space-2) center;padding-right:28px;cursor:pointer}
select.control-input:focus,.control-input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.toolbar input[type=search]{flex:1 1 120px;min-width:56px;max-width:320px}
.toolbar select{flex:0 0 auto;max-width:100%}
.toolbar .control{display:inline-flex;align-items:center;gap:var(--space-2);font-size:var(--fs-meta);color:var(--ink-2);white-space:nowrap}
.toolbar .score-range input{width:64px;text-align:center;font-variant-numeric:tabular-nums}
.toolbar .check{display:inline-flex;align-items:center;gap:var(--space-1);font-size:var(--fs-body);color:var(--ink-2);white-space:nowrap;cursor:pointer}
.toolbar input:focus,.toolbar select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
/* Popovers: a details element whose summary is a secondary button; the list drops under it, right-aligned. */
.menu{position:relative;flex:0 0 auto}
.menu>summary{list-style:none}
.menu>summary::-webkit-details-marker{display:none}
.menu>summary.active{border-color:var(--accent);color:var(--accent)}
.menu .menu-list{position:absolute;right:0;top:calc(100% + var(--space-1));z-index:6;display:flex;flex-direction:column;align-items:stretch;gap:var(--space-2);min-width:240px;padding:var(--space-3);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-pop);--in-r:max(var(--r-xs), calc(var(--r-lg) - var(--space-3)))}
.menu .menu-list .control{justify-content:space-between}
.menu .menu-list .control>span:first-child{flex:0 0 auto}
.menu .menu-list .inline,.menu .menu-list form{display:block;width:100%}
.menu .menu-list .btn{display:flex;width:100%}
.menu.overflow>summary{min-width:var(--control-height);padding:0 var(--space-2);font-size:var(--fs-title);line-height:1}
@media (min-width:1100px){.toolbar{flex-wrap:nowrap}}
@media (min-width:1100px) and (max-width:1279px){.toolbar{gap:6px}.bar-title{gap:6px}}

.jobs{display:flex;flex-direction:column;gap:var(--space-3);margin:0;padding:0;list-style:none}
.job{padding:var(--space-4);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);--in-r:max(var(--r-xs), calc(var(--r-lg) - var(--space-4)))}
.job[hidden]{display:none}
.group-title{margin:var(--space-5) 0 var(--space-3);font-size:var(--fs-title);font-weight:650}
.group-count{color:var(--ink-2);font-weight:400}
.group-note{margin:0 0 var(--space-3);font-size:var(--fs-body);color:var(--ink-2)}
.job-body{min-width:0}
/* Card head: company · title and the posting line on the left; the track scores and the ring on the right. */
.job-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-4);align-items:start}
.job-title{margin:0;font-size:var(--fs-title);font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.job-title .company{color:var(--ink)}
.job-title .dot{color:var(--ink-3);font-weight:400}
.job-title a{text-decoration:none}
.job-title a:hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
.job-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);margin:var(--space-1) 0 0;font-size:var(--fs-body);color:var(--ink-2);overflow-wrap:anywhere}
.job-meta .sep{color:var(--ink-3)}
.job-meta .job-check{margin-left:auto;text-decoration:none}
.job-meta .job-check:hover{text-decoration:underline}
.job-score{display:flex;align-items:center;gap:var(--space-3)}
.ring{--score:0;position:relative;flex:0 0 auto;width:60px;height:60px;border-radius:50%;background:conic-gradient(var(--accent) calc(var(--score) * 1%),var(--ring-track) 0);display:grid;place-items:center}
.ring::before{content:"";position:absolute;inset:6px;border-radius:50%;background:var(--surface)}
.ring b{position:relative;font-size:var(--fs-title);font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
/* One line per track, right-aligned, numbers in a fixed-width column; the top score (every one when tied)
   in the text colour and semibold, the rest in the secondary colour. */
.scores{display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:var(--fs-meta);line-height:1.4;color:var(--ink-2);font-variant-numeric:tabular-nums}
.scores .track{display:inline-flex;align-items:baseline;gap:var(--space-1);white-space:nowrap}
.scores .track b{display:inline-block;min-width:2.2ch;text-align:right;font-weight:inherit}
.scores .track.top{color:var(--ink);font-weight:600}
.badges{display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-2);margin-top:var(--space-2)}
.badge{display:inline-block;font-size:var(--fs-meta);font-weight:600;line-height:1.5;border-radius:var(--in-r, var(--r-xs));padding:0 var(--space-2);background:var(--note-bg);color:var(--note-ink);white-space:nowrap;max-width:100%}
.badge-warn{background:var(--warn-bg);color:var(--warn-ink)}
.badge-bad{background:var(--bad-bg);color:var(--bad-ink)}

/* The action row under the Job Description, always in the same order: Open Posting, Download CoverLetter,
   Open CoverLetter, Message to Recruiters. */
.job .actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);margin-top:var(--space-3)}
.facts-label{margin:var(--space-3) 0 var(--space-1);font-size:var(--fs-meta);font-weight:650;color:var(--ink-2)}
.facts{margin:0;padding:0;list-style:none}
.facts li{position:relative;padding-left:var(--space-4);line-height:1.5;overflow-wrap:anywhere}
.facts li::before{content:"";position:absolute;left:var(--space-1);top:.62em;width:5px;height:5px;border-radius:50%;background:var(--accent)}
.facts.gaps li::before{background:transparent;border:1px solid var(--ink-3);width:5px;height:5px}
details.more{margin-top:2px}
details.more>summary{list-style:none;cursor:pointer;font-size:var(--fs-meta);color:var(--accent);padding-left:var(--space-4)}
details.more>summary::-webkit-details-marker{display:none}
details.more[open]>summary{display:none}
details.jd{margin-top:var(--space-3);border-top:1px solid var(--line);padding-top:var(--space-2)}
details.jd>summary{display:flex;align-items:center;gap:var(--space-2);cursor:pointer;font-size:var(--fs-meta);font-weight:650;color:var(--ink-2)}
details.jd>summary::before{content:"";width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);margin:0 2px 0 1px;transition:transform .12s}
details.jd[open]>summary::before{transform:rotate(45deg);margin-top:-2px}
details.jd>summary::-webkit-details-marker{display:none}
.jd-copy{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:var(--in-r, var(--r-xs));background:transparent;color:var(--ink-3);cursor:pointer}
.jd-copy:hover{color:var(--accent);border-color:var(--line-2);background:var(--surface)}
.jd-copy:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.jd-copy.done{color:var(--accent)}
/* The JD box: the frame carries the corners and clips; the body inside it scrolls, inset from the corners so
   neither the text nor the scrollbar reaches them (the frame holds the top and bottom space, so text scrolled
   to the edge of the body still stops 12px short of the frame's edge). */
details.jd .jd-frame{margin:var(--space-2) 0 0;padding:var(--space-3) var(--space-1);background:var(--bg);border-radius:var(--in-r, var(--r-md));overflow:hidden}
details.jd .jd-body{padding:0 var(--space-2);max-height:396px;overflow:auto;font-size:var(--fs-body);line-height:1.55;color:var(--ink-2);overflow-wrap:anywhere}
.jd-body p{margin:0 0 var(--space-2)}
.jd-body h1,.jd-body h2,.jd-body h3,.jd-body h4{margin:var(--space-3) 0 var(--space-1);font-size:var(--fs-body);font-weight:650;color:var(--ink)}
.jd-body ul,.jd-body ol{margin:0 0 var(--space-2);padding-left:var(--space-5)}
.jd-body li{margin:0 0 2px}
.jd-body strong,.jd-body b{color:var(--ink);font-weight:650}
.jd-body a{color:var(--accent)}
.jd-missing{margin:var(--space-3) 0 0;padding-top:var(--space-2);border-top:1px solid var(--line);font-size:var(--fs-meta);color:var(--ink-2)}
.jd-missing a{color:var(--accent)}
.jd-body>:first-child{margin-top:0}
.jd-body>:last-child{margin-bottom:0}
.job-foot{margin:var(--space-2) 0 0;font-size:var(--fs-meta);color:var(--ink-2);overflow-wrap:anywhere}
.job-foot a{color:var(--ink-2)}
.alternates{margin:var(--space-2) 0 0;font-size:var(--fs-meta);color:var(--ink-2);overflow-wrap:anywhere}

.empty{padding:var(--space-6) var(--space-4);text-align:center;background:var(--surface);border:1px dashed var(--line-2);border-radius:var(--r-lg);color:var(--ink-2)}
.empty[hidden]{display:none}

details.run{margin-top:var(--space-6);padding-top:var(--space-3);border-top:1px solid var(--line);font-size:var(--fs-meta);color:var(--ink-2)}
details.run>summary{cursor:pointer;font-weight:600;color:var(--ink-2)}
.run dl{display:grid;grid-template-columns:max-content 1fr;gap:var(--space-1) var(--space-4);margin:var(--space-3) 0 0}
.run dt{color:var(--ink-2)}
.run dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.run dd ul{margin:2px 0 0;padding-left:var(--space-4)}
details.run-list[open]>summary{display:block}
details.run-list ul{max-height:320px;overflow:auto}
.run dd li{margin:0}
.foot{margin-top:var(--space-5);font-size:var(--fs-meta);color:var(--ink-2)}

@media (max-width:640px){
  .page{--gutter:var(--space-3);padding:var(--space-4) var(--gutter) var(--space-5)}
  .job{padding:var(--space-3);--in-r:max(var(--r-xs), calc(var(--r-lg) - var(--space-3)))}
  .job-head{grid-template-columns:1fr;gap:var(--space-2)}
  .job-score{flex-direction:row-reverse;justify-content:flex-end}
  .ring{width:48px;height:48px}.ring::before{inset:5px}.ring b{font-size:var(--fs-body)}
  .scores{align-items:flex-start}
  .job .actions{display:grid;grid-template-columns:1fr 1fr}
  .job .actions .btn,.job .actions .apply{width:100%;white-space:normal;text-align:center;padding:var(--space-1) var(--space-2)}
  /* The bar wraps: the title on its own line, then two controls per row. */
  .toolbar{position:static;display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);padding:var(--space-2) var(--gutter, 0px)}
  .bar-title,.toolbar input[type=search]{grid-column:1/-1;min-width:0;max-width:none}
  .toolbar select{width:100%;min-width:0}
  .menu .menu-list{left:0;right:auto;min-width:min(280px,calc(100vw - 2 * var(--space-3)))}
  .badge{white-space:normal}
  .run dl{grid-template-columns:1fr;gap:0}
  .run dt{margin-top:var(--space-2)}
}
@media print{
  body{background:#fff}
  .toolbar,.foot{display:none}
  .job{break-inside:avoid;box-shadow:none}
}
`;

// Sort, filter, and search over the rendered cards. Cards carry their sort and filter keys as data attributes,
// so the script never re-parses text and needs no library. The filter state is kept in the URL query
// (src/report-filters.mjs, injected below), so a refresh or a shared link opens the same view. The same
// script marks the bar once it is stuck, closes the popovers, and copies a Job Description.
export const REPORT_SCRIPT = `
(function () {
  ${readFilters.toString()}
  ${writeFilters.toString()}
  ${cardPasses.toString()}
  ${filtersActive.toString()}
  ${descriptionPlainText.toString()}
  var COPY_DONE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var toolbar = document.getElementById('toolbar');
  // The bar is stuck once the sentinel above it has scrolled out: a rule and a blur then set it off the list.
  var sentinel = document.getElementById('bar-sentinel');
  if (toolbar && sentinel && typeof IntersectionObserver === 'function') {
    new IntersectionObserver(function (entries) { toolbar.classList.toggle('stuck', entries.some(function (entry) { return !entry.isIntersecting; })); }, { threshold: [0, 1] }).observe(sentinel);
  }
  // A popover closes on a click elsewhere or Escape.
  document.addEventListener('click', function (event) {
    document.querySelectorAll('details.menu[open]').forEach(function (menu) { if (!menu.contains(event.target)) menu.open = false; });
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') document.querySelectorAll('details.menu[open]').forEach(function (menu) { menu.open = false; }); });
  // Copy Job Description: the whole JD as markup (text/html) and as plain text (bullets, blank lines between
  // blocks); a long JD the hub has not loaded yet is fetched first. The click never toggles the fold.
  function writeClipboard(html, text) {
    if (navigator.clipboard && window.ClipboardItem && navigator.clipboard.write) {
      try {
        return navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      } catch (e) {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select();
      try { if (document.execCommand('copy')) resolve(); else reject(new Error('copy refused')); } catch (e) { reject(e); }
      document.body.removeChild(area);
    });
  }
  function descriptionMarkup(details) {
    var body = details.querySelector('.jd-body');
    var src = details.getAttribute('data-jd-src');
    if (!src) return Promise.resolve(body ? body.innerHTML : '');
    return fetch(src, { headers: { accept: 'text/html' } }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then(function (html) {
      if (body) body.innerHTML = html;
      details.removeAttribute('data-jd-src');
      return html;
    });
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('.jd-copy');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    var details = button.closest('details.jd');
    if (!details || button.disabled) return;
    button.disabled = true;
    var icon = button.innerHTML;
    descriptionMarkup(details).then(function (html) { return writeClipboard(html, descriptionPlainText(html)); }).then(function () {
      button.innerHTML = COPY_DONE; button.classList.add('done');
      setTimeout(function () { button.innerHTML = icon; button.classList.remove('done'); button.disabled = false; }, 1500);
    }).catch(function () { button.disabled = false; button.title = 'Could not copy; open the description and copy it by hand'; });
  }, true);
  // The main list and the other groups sort and filter separately; the count covers all of them.
  var lists = Array.prototype.slice.call(document.querySelectorAll('section.jobs'));
  if (!toolbar) return;
  var cards = [];
  lists.forEach(function (list) { cards = cards.concat(Array.prototype.slice.call(list.querySelectorAll('.job'))); });
  var controls = {
    q: document.getElementById('q'), sort: document.getElementById('sort'), resume: document.getElementById('track'),
    role: document.getElementById('role'), freshness: document.getElementById('fresh'), min: document.getElementById('score-min'),
    max: document.getElementById('score-max'), hideContacted: document.getElementById('hide-contacted')
  };
  var count = document.getElementById('count');
  var none = document.getElementById('no-results');
  var clear = document.getElementById('clear-filters');
  var filtersButton = document.getElementById('filters-button');
  function num(card, key) { var value = parseFloat(card.dataset[key]); return isNaN(value) ? -Infinity : value; }
  function byScore(a, b) { return num(b, 'score') - num(a, 'score'); }
  var sorters = {
    score: byScore,
    company: function (a, b) { return (a.dataset.company || '').localeCompare(b.dataset.company || '') || byScore(a, b); },
    posted: function (a, b) { return num(b, 'posted') - num(a, 'posted') || byScore(a, b); }
  };
  function state() {
    var value = function (control) { return control ? String(control.value || '') : ''; };
    return {
      q: value(controls.q), sort: value(controls.sort) || 'score', resume: value(controls.resume), role: value(controls.role),
      freshness: value(controls.freshness), min: value(controls.min).trim(), max: value(controls.max).trim(),
      hideContacted: Boolean(controls.hideContacted && controls.hideContacted.checked)
    };
  }
  function restore(saved) {
    Object.keys(controls).forEach(function (key) {
      var control = controls[key];
      if (!control) return;
      if (control.type === 'checkbox') { control.checked = Boolean(saved[key]); return; }
      // A value this date does not offer (another day's role type or track) stays selected, so the filter
      // survives a date change; the list then says no posting matches.
      if (control.tagName === 'SELECT' && saved[key] && !Array.prototype.some.call(control.options, function (option) { return option.value === saved[key]; })) {
        var extra = document.createElement('option');
        extra.value = saved[key];
        extra.textContent = String(saved[key]).replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, function (letter) { return letter.toUpperCase(); });
        extra.setAttribute('data-absent', '1');
        control.appendChild(extra);
      }
      control.value = saved[key] == null ? '' : saved[key];
    });
  }
  function remember(current) {
    try {
      var query = writeFilters(current, location.search);
      if (query !== location.search) history.replaceState(history.state, '', location.pathname + query + location.hash);
    } catch (e) {}
  }
  function label(shown) { return shown === cards.length ? cards.length + (cards.length === 1 ? ' Job' : ' Jobs') : shown + ' of ' + cards.length + ' Jobs'; }
  function apply() {
    var current = state();
    var shown = 0;
    cards.slice().sort(sorters[current.sort] || byScore).forEach(function (card) {
      var ok = cardPasses(card.dataset, current);
      card.hidden = !ok;
      if (ok) shown += 1;
      card.parentNode.appendChild(card);
    });
    if (count) count.textContent = label(shown);
    if (none) none.hidden = shown > 0;
    var active = filtersActive(current);
    if (clear) clear.hidden = !active;
    markFilters(current);
    remember(current);
    document.dispatchEvent(new CustomEvent('report-filters', { detail: { query: writeFilters(current, '') } }));
  }
  // The Filters button shows when one of its own controls is set (search and sort stay in the row; Track and
  // Role Type count only while they are folded into it).
  function markFilters(current) {
    if (!filtersButton) return;
    var folded = ' ' + (toolbar.getAttribute('data-folded') || '') + ' ';
    filtersButton.classList.toggle('active', Boolean(current.freshness || current.min !== '' || current.max !== '' || current.hideContacted
      || (folded.indexOf(' resume ') >= 0 && current.resume) || (folded.indexOf(' role ') >= 0 && current.role)));
  }
  // At 1100px and wider the row never wraps: when it does not fit, Role Type and then Track move to the top of
  // the Filters popover (the date is never cut), and back into the row once there is room again.
  var filtersMenu = document.getElementById('filters-menu');
  var filtersList = filtersMenu && filtersMenu.querySelector('.menu-list');
  var folds = [['resume', 'Track'], ['role', 'Role Type']].map(function (pair) {
    var wrap = document.createElement('label');
    wrap.className = 'control folded';
    wrap.hidden = true;
    var name = document.createElement('span');
    name.textContent = pair[1];
    wrap.appendChild(name);
    return { key: pair[0], control: controls[pair[0]], wrap: wrap };
  }).filter(function (fold) { return fold.control; });
  if (filtersList) folds.slice().reverse().forEach(function (fold) { filtersList.insertBefore(fold.wrap, filtersList.firstChild); });
  function fit() {
    if (!filtersMenu || !filtersList || !folds.length) return;
    folds.forEach(function (fold) { toolbar.insertBefore(fold.control, filtersMenu); fold.wrap.hidden = true; });
    toolbar.removeAttribute('data-folded');
    var folded = [];
    if (getComputedStyle(toolbar).flexWrap === 'nowrap') {
      for (var i = folds.length - 1; i >= 0 && toolbar.scrollWidth > toolbar.clientWidth + 1; i -= 1) {
        folds[i].wrap.appendChild(folds[i].control);
        folds[i].wrap.hidden = false;
        folded.push(folds[i].key);
      }
    }
    if (folded.length) toolbar.setAttribute('data-folded', folded.join(' '));
    markFilters(state());
  }
  var fitQueued = false;
  window.addEventListener('resize', function () {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(function () { fitQueued = false; fit(); });
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  fit();
  restore(readFilters(location.search));
  Object.keys(controls).forEach(function (key) {
    var control = controls[key];
    if (!control) return;
    control.addEventListener('input', apply);
    control.addEventListener('change', apply);
  });
  if (clear) clear.addEventListener('click', function () { restore(readFilters('')); apply(); });
  // A card's contacted mark changed in place (the hub's Message to Recruiters drawer).
  document.addEventListener('report-cards-changed', apply);
  toolbar.addEventListener('submit', function (event) { event.preventDefault(); });
  apply();
})();
`;

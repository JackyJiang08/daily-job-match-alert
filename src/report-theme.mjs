// Visual system for the daily HTML report: design tokens, the stylesheet, and the small client script
// behind the toolbar. Everything is inlined into the page so it opens as a plain local file with no
// network access. The tokens are the contract a later local hub can reuse: change them here and every
// component in report-components.mjs follows.
import { cardPasses, filtersActive, readFilters, writeFilters } from './report-filters.mjs';

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
  /* Shape and rhythm: every gap, margin and padding is one of the six spacing steps. */
  --radius: 10px;
  --radius-sm: 6px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 40px;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
  --control-height: 32px;
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%235b6472' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
`;

export const REPORT_TOKENS_DARK = `
  --accent: #2dd4bf;
  --accent-ink: #04211e;
  --accent-soft: rgba(45, 212, 191, 0.14);
  --bg: #0f1318;
  --surface: #171c23;
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
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%239aa3b1' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
`;

export const REPORT_STYLES = `
:root{${REPORT_TOKENS}}
@media (prefers-color-scheme: dark){:root{${REPORT_TOKENS_DARK}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:var(--fs-body)/var(--lh) var(--font)}
a{color:inherit}
.page{max-width:920px;margin:0 auto;padding:var(--space-5) var(--space-4) var(--space-6)}

/* Buttons: one primary style (filled) and one secondary style (outlined), one size everywhere. "small" is
   kept as a class for older markup and no longer changes the size. */
.btn,.apply{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-1);min-height:var(--control-height);padding:0 var(--space-3);border:1px solid var(--accent);border-radius:var(--radius-sm);background:var(--accent);color:var(--accent-ink);font:inherit;font-size:var(--fs-body);font-weight:600;line-height:1.2;text-decoration:none;white-space:nowrap;cursor:pointer}
.btn:hover,.apply:hover{filter:brightness(1.06)}
.btn.secondary{background:var(--surface);color:var(--ink);border-color:var(--line-2)}
.btn.secondary:hover{filter:none;border-color:var(--ink-3)}
.btn.small{min-height:var(--control-height);padding:0 var(--space-3);font-size:var(--fs-body)}
.btn.danger{background:var(--bad-bg);color:var(--bad-ink);border-color:transparent}
.btn[disabled]{opacity:.55;cursor:not-allowed;filter:none}
.btn:focus-visible,.apply:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}

.masthead{border-bottom:1px solid var(--line);padding-bottom:var(--space-3);margin-bottom:var(--space-4)}
.masthead h1{margin:0;font-size:var(--fs-title);font-weight:700;letter-spacing:-0.01em;line-height:1.3}
.masthead .sub{margin:var(--space-1) 0 0;font-size:var(--fs-body);color:var(--ink-2)}
.masthead .quota-note{color:var(--warn-ink);font-weight:600}

.banner{margin:0 0 var(--space-4);padding:var(--space-3) var(--space-4);border-radius:var(--radius);background:var(--warn-bg);color:var(--warn-ink);font-size:var(--fs-body)}
/* The filter bar: one compact row of controls (wrapping when narrow) that stays at the top while scrolling. */
.toolbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-3);margin:0 0 var(--space-4);padding:var(--space-2) var(--space-3);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
/* One control style for every text input and select, in the report toolbar and in the hub forms. */
.control-input,.toolbar input:not([type=checkbox]),.toolbar select{font:inherit;font-size:var(--fs-body);line-height:1.3;color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--radius-sm);padding:var(--space-1) var(--space-2);min-height:var(--control-height);box-sizing:border-box}
select.control-input,.toolbar select{appearance:none;-webkit-appearance:none;background-image:var(--chevron);background-repeat:no-repeat;background-position:right var(--space-2) center;padding-right:28px;cursor:pointer}
select.control-input:focus,.control-input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.toolbar input[type=search]{flex:1 1 220px;min-width:160px}
.toolbar select{flex:0 0 auto;max-width:100%}
.toolbar .control{display:inline-flex;align-items:center;gap:var(--space-2);font-size:var(--fs-meta);color:var(--ink-2);white-space:nowrap}
.toolbar .score-range input{width:64px;text-align:center;font-variant-numeric:tabular-nums}
.toolbar .check{display:inline-flex;align-items:center;gap:var(--space-1);font-size:var(--fs-meta);color:var(--ink-2);white-space:nowrap;cursor:pointer}
.toolbar input:focus,.toolbar select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.toolbar .count{margin-left:auto;font-size:var(--fs-meta);color:var(--ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.toolbar.quiet{position:static;gap:var(--space-2);margin-bottom:var(--space-3);padding:0;background:transparent;border:0;box-shadow:none}
.toolbar.quiet .count{display:none}

.jobs{display:flex;flex-direction:column;gap:var(--space-3);margin:0;padding:0;list-style:none}
.job{padding:var(--space-4);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.job[hidden]{display:none}
.group-title{margin:var(--space-5) 0 var(--space-1);font-size:var(--fs-title);font-weight:650}
.group-count{color:var(--ink-2);font-weight:400}
.group-note{margin:0 0 var(--space-3);font-size:var(--fs-body);color:var(--ink-2)}
.job-body{min-width:0}
/* Card head: company · title and the posting line on the left; the score and the recommended resume on the right. */
.job-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-4);align-items:start}
.job-title{margin:0;font-size:var(--fs-title);font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.job-title .company{color:var(--ink)}
.job-title .dot{color:var(--ink-3);font-weight:400}
.job-title a{text-decoration:none}
.job-title a:hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
.job-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);margin:var(--space-1) 0 0;font-size:var(--fs-body);color:var(--ink-2);overflow-wrap:anywhere}
.job-meta .sep{color:var(--ink-3)}
.badge.fresh{background:var(--accent-soft);color:var(--accent)}
.job-score{display:flex;align-items:center;gap:var(--space-3)}
.score-text{display:flex;flex-direction:column;align-items:flex-end;gap:2px;text-align:right}
.ring{--score:0;position:relative;flex:0 0 auto;width:48px;height:48px;border-radius:50%;background:conic-gradient(var(--accent) calc(var(--score) * 1%),var(--ring-track) 0);display:grid;place-items:center}
.ring::before{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--surface)}
.ring b{position:relative;font-size:var(--fs-body);font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
.scores{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:var(--space-1) var(--space-2);font-size:var(--fs-meta);color:var(--ink-2);font-variant-numeric:tabular-nums}
.scores .track b{color:var(--ink);font-weight:650}
.scores .track.best b{color:var(--accent)}
.scores .sep{color:var(--ink-3)}
.recommend{display:inline-block;color:var(--accent);font-size:var(--fs-meta);font-weight:650;white-space:nowrap}
.badges{display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-2);margin-top:var(--space-2)}
.badge{display:inline-block;font-size:var(--fs-meta);font-weight:600;line-height:1.5;border-radius:var(--radius-sm);padding:0 var(--space-2);background:var(--note-bg);color:var(--note-ink);white-space:nowrap;max-width:100%}
.badge-warn{background:var(--warn-bg);color:var(--warn-ink)}
.badge-bad{background:var(--bad-bg);color:var(--bad-ink)}

/* The action row, always in the same place and order: Open Posting, Download Letter, Open Letter, Reach Out. */
.job .actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);margin-top:var(--space-3)}
.job .actions .mark-applied{margin-left:auto}
.facts-label{margin:var(--space-4) 0 var(--space-1);font-size:var(--fs-meta);font-weight:650;color:var(--ink-2)}
.facts{margin:0;padding:0;list-style:none}
.facts li{position:relative;padding-left:var(--space-4);line-height:1.5;overflow-wrap:anywhere}
.facts li::before{content:"";position:absolute;left:var(--space-1);top:.62em;width:5px;height:5px;border-radius:50%;background:var(--accent)}
.facts.gaps li::before{background:transparent;border:1px solid var(--ink-3);width:5px;height:5px}
details.more{margin-top:2px}
details.more>summary{list-style:none;cursor:pointer;font-size:var(--fs-meta);color:var(--accent);padding-left:var(--space-4)}
details.more>summary::-webkit-details-marker{display:none}
details.more[open]>summary{display:none}
details.jd{margin-top:var(--space-3);border-top:1px solid var(--line);padding-top:var(--space-2)}
details.jd>summary{cursor:pointer;font-size:var(--fs-meta);font-weight:650;color:var(--ink-2)}
details.jd .jd-body{margin:var(--space-2) 0 0;padding:var(--space-3);max-height:420px;overflow:auto;font-size:var(--fs-body);line-height:1.55;color:var(--ink-2);background:var(--bg);border-radius:var(--radius-sm);overflow-wrap:anywhere}
.jd-body p{margin:0 0 var(--space-2)}
.jd-body h1,.jd-body h2,.jd-body h3,.jd-body h4{margin:var(--space-3) 0 var(--space-1);font-size:var(--fs-body);font-weight:650;color:var(--ink)}
.jd-body ul,.jd-body ol{margin:0 0 var(--space-2);padding-left:var(--space-5)}
.jd-body li{margin:0 0 2px}
.jd-body strong,.jd-body b{color:var(--ink);font-weight:650}
.jd-body a{color:var(--accent)}
.jd-body>:first-child{margin-top:0}
.jd-body>:last-child{margin-bottom:0}
.job-foot{margin:var(--space-2) 0 0;font-size:var(--fs-meta);color:var(--ink-2);overflow-wrap:anywhere}
.job-foot a{color:var(--ink-2)}
.alternates{margin:var(--space-2) 0 0;font-size:var(--fs-meta);color:var(--ink-2);overflow-wrap:anywhere}

.empty{padding:var(--space-6) var(--space-4);text-align:center;background:var(--surface);border:1px dashed var(--line-2);border-radius:var(--radius);color:var(--ink-2)}
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
  .page{padding:var(--space-4) var(--space-3) var(--space-5)}
  .job{padding:var(--space-3)}
  .job-head{grid-template-columns:1fr;gap:var(--space-2)}
  .job-score{flex-direction:row-reverse;justify-content:flex-end}
  .ring{width:40px;height:40px}.ring::before{inset:4px}
  .score-text{align-items:flex-start;text-align:left}
  .scores{justify-content:flex-start}
  .job .actions{display:grid;grid-template-columns:1fr 1fr}
  .job .actions .btn,.job .actions .apply{width:100%;white-space:normal;text-align:center;padding:var(--space-1) var(--space-2)}
  .job .actions .mark-applied{grid-column:1/-1;margin-left:0}
  /* Two controls per row; a select's first option names it ("All Resumes", "Any Freshness"), so the small
     labels are kept for screen readers only. */
  .toolbar{position:static;display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);padding:var(--space-2)}
  .toolbar input[type=search]{grid-column:1/-1;min-width:0}
  .toolbar .control{min-width:0}
  .toolbar .control:not(.score-range)>span:first-child{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .toolbar .control select{width:100%;min-width:0}
  .toolbar .score-range{grid-column:1/-1}
  .toolbar .score-range input{flex:1 1 0;width:auto;min-width:0}
  .toolbar .count{margin-left:0;grid-column:1/-1}
  .toolbar #clear-filters{grid-column:1/-1}
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
// (src/report-filters.mjs, injected below), so a refresh or a shared link opens the same view.
export const REPORT_SCRIPT = `
(function () {
  ${readFilters.toString()}
  ${writeFilters.toString()}
  ${cardPasses.toString()}
  ${filtersActive.toString()}
  // The main list and the other groups sort and filter separately; the count covers all of them.
  var lists = Array.prototype.slice.call(document.querySelectorAll('section.jobs'));
  var toolbar = document.getElementById('toolbar');
  if (!lists.length || !toolbar) return;
  var cards = [];
  lists.forEach(function (list) { cards = cards.concat(Array.prototype.slice.call(list.querySelectorAll('.job'))); });
  var controls = {
    q: document.getElementById('q'), sort: document.getElementById('sort'), resume: document.getElementById('track'),
    role: document.getElementById('role'), freshness: document.getElementById('fresh'), min: document.getElementById('score-min'),
    max: document.getElementById('score-max'), hideContacted: document.getElementById('hide-contacted'), hideApplied: document.getElementById('hide-applied')
  };
  var count = document.getElementById('count');
  var none = document.getElementById('no-results');
  var clear = document.getElementById('clear-filters');
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
      hideContacted: Boolean(controls.hideContacted && controls.hideContacted.checked), hideApplied: Boolean(controls.hideApplied && controls.hideApplied.checked)
    };
  }
  function restore(saved) {
    Object.keys(controls).forEach(function (key) {
      var control = controls[key];
      if (!control) return;
      if (control.type === 'checkbox') { control.checked = Boolean(saved[key]); return; }
      if (control.tagName === 'SELECT' && saved[key] && !Array.prototype.some.call(control.options, function (option) { return option.value === saved[key]; })) return;
      control.value = saved[key] == null ? '' : saved[key];
    });
  }
  function remember(current) {
    try {
      var query = writeFilters(current, location.search);
      if (query !== location.search) history.replaceState(history.state, '', location.pathname + query + location.hash);
    } catch (e) {}
  }
  function apply() {
    var current = state();
    var shown = 0;
    cards.slice().sort(sorters[current.sort] || byScore).forEach(function (card) {
      var ok = cardPasses(card.dataset, current);
      card.hidden = !ok;
      if (ok) shown += 1;
      card.parentNode.appendChild(card);
    });
    if (count) count.textContent = shown === cards.length ? cards.length + ' shown' : shown + ' of ' + cards.length + ' shown';
    if (none) none.hidden = shown > 0;
    if (clear) clear.hidden = !filtersActive(current);
    remember(current);
    document.dispatchEvent(new CustomEvent('report-filters', { detail: { query: writeFilters(current, '') } }));
  }
  restore(readFilters(location.search));
  Object.keys(controls).forEach(function (key) {
    var control = controls[key];
    if (!control) return;
    control.addEventListener('input', apply);
    control.addEventListener('change', apply);
  });
  if (clear) clear.addEventListener('click', function () { restore(readFilters('')); apply(); });
  // A card's contacted or applied mark changed in place (the hub's Reach Out drawer, Mark as Applied).
  document.addEventListener('report-cards-changed', apply);
  toolbar.addEventListener('submit', function (event) { event.preventDefault(); });
  apply();
})();
`;

// Visual system for the daily HTML report: design tokens, the stylesheet, and the small client script
// behind the toolbar. Everything is inlined into the page so it opens as a plain local file with no
// network access. The tokens are the contract a later local hub can reuse: change them here and every
// component in report-components.mjs follows.

export const REPORT_TOKENS = `
  color-scheme: light dark;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  /* Type scale: page heading, card title, body, meta. */
  --fs-page: 22px;
  --fs-title: 17px;
  --fs-body: 14px;
  --fs-meta: 12px;
  --lh: 1.5;
  /* One accent, one neutral ramp. */
  --accent: #0f766e;
  --accent-ink: #ffffff;
  --accent-soft: rgba(15, 118, 110, 0.10);
  --bg: #f6f7f9;
  --surface: #ffffff;
  --ink: #1c2430;
  --ink-2: #4b5563;
  --ink-3: #6b7280;
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
  /* Shape and rhythm. */
  --radius: 10px;
  --radius-sm: 6px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 40px;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%236b7280' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
`;

export const REPORT_TOKENS_DARK = `
  --accent: #2dd4bf;
  --accent-ink: #04211e;
  --accent-soft: rgba(45, 212, 191, 0.14);
  --bg: #0f1318;
  --surface: #171c23;
  --ink: #e6e9ee;
  --ink-2: #b4bcc8;
  --ink-3: #8a94a3;
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
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%238a94a3' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
`;

export const REPORT_STYLES = `
:root{${REPORT_TOKENS}}
@media (prefers-color-scheme: dark){:root{${REPORT_TOKENS_DARK}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:var(--fs-body)/var(--lh) var(--font)}
a{color:inherit}
.page{max-width:920px;margin:0 auto;padding:var(--space-5) var(--space-4) var(--space-6)}

.masthead{border-bottom:1px solid var(--line);padding-bottom:var(--space-3);margin-bottom:var(--space-4)}
.masthead h1{margin:0;font-size:var(--fs-page);font-weight:650;letter-spacing:-0.01em;line-height:1.25}
.masthead .sub{margin:var(--space-1) 0 0;font-size:var(--fs-body);color:var(--ink-2)}

.banner{margin:0 0 var(--space-4);padding:var(--space-3) var(--space-4);border-radius:var(--radius);background:var(--warn-bg);color:var(--warn-ink);font-size:var(--fs-body)}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);margin:0 0 var(--space-4)}
/* One control style for every text input and select, in the report toolbar and in the hub forms. */
.control-input,.toolbar input,.toolbar select{font:inherit;font-size:var(--fs-body);line-height:1.3;color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--radius-sm);padding:6px 9px;min-height:32px;box-sizing:border-box}
select.control-input,.toolbar select{appearance:none;-webkit-appearance:none;background-image:var(--chevron);background-repeat:no-repeat;background-position:right 9px center;padding-right:28px;cursor:pointer}
select.control-input:focus,.control-input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.toolbar input[type=search]{flex:1 1 200px;min-width:160px}
.toolbar select{flex:0 0 auto}
.toolbar .control{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-meta);color:var(--ink-3)}
.toolbar .control select{font-size:var(--fs-body)}
.toolbar input:focus,.toolbar select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.toolbar .count{margin-left:auto;font-size:var(--fs-meta);color:var(--ink-3);font-variant-numeric:tabular-nums}
.toolbar.quiet{gap:var(--space-1) var(--space-2);margin-bottom:var(--space-3);opacity:.9}
.toolbar.quiet .control select,.toolbar.quiet input,.toolbar.quiet select{font-size:var(--fs-meta);min-height:28px;padding:4px 7px;background:transparent}
.toolbar.quiet input[type=search]{flex-basis:160px}
.toolbar.quiet .count{display:none}

.jobs{display:flex;flex-direction:column;gap:var(--space-3);margin:0;padding:0;list-style:none}
.job{display:grid;grid-template-columns:52px 1fr;gap:var(--space-4);align-items:start;padding:var(--space-4);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.job[hidden]{display:none}
.ring{--score:0;position:relative;width:52px;height:52px;border-radius:50%;background:conic-gradient(var(--accent) calc(var(--score) * 1%),var(--ring-track) 0);display:grid;place-items:center}
.ring::before{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--surface)}
.ring b{position:relative;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
.job-body{min-width:0}
.job-title{margin:0;font-size:var(--fs-title);font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.job-title a{text-decoration:none}
.job-title a:hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
.job-meta{margin:2px 0 var(--space-2);font-size:var(--fs-body);color:var(--ink-2);overflow-wrap:anywhere}
.scores{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-3);font-size:var(--fs-meta);color:var(--ink-2);font-variant-numeric:tabular-nums}
.scores .track b{color:var(--ink);font-weight:650}
.scores .track.best b{color:var(--accent)}
.scores .sep{color:var(--line-2);margin:0 -4px}
.recommend{display:inline-block;background:var(--accent);color:var(--accent-ink);border-radius:999px;padding:3px 10px;font-size:var(--fs-meta);font-weight:650;letter-spacing:.01em;white-space:nowrap}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:var(--space-2)}
.badge{display:inline-block;font-size:11px;font-weight:600;line-height:1.5;border-radius:var(--radius-sm);padding:1px 7px;background:var(--note-bg);color:var(--note-ink);white-space:nowrap}
.badge-warn{background:var(--warn-bg);color:var(--warn-ink)}
.badge-bad{background:var(--bad-bg);color:var(--bad-ink)}

.facts-label{margin:var(--space-3) 0 var(--space-1);font-size:var(--fs-meta);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
.facts{margin:0;padding:0;list-style:none}
.facts li{position:relative;padding-left:14px;line-height:1.45;overflow-wrap:anywhere}
.facts li::before{content:"";position:absolute;left:0;top:.62em;width:5px;height:5px;border-radius:50%;background:var(--accent)}
.facts.gaps li::before{background:transparent;border:1px solid var(--ink-3);width:4px;height:4px}
details.more{margin-top:2px}
details.more>summary{list-style:none;cursor:pointer;font-size:var(--fs-meta);color:var(--accent);padding-left:14px}
details.more>summary::-webkit-details-marker{display:none}
details.more[open]>summary{display:none}
details.jd{margin-top:var(--space-3)}
details.jd>summary{cursor:pointer;font-size:var(--fs-meta);color:var(--ink-3)}
details.jd p{margin:var(--space-2) 0 0;padding:var(--space-3);max-height:360px;overflow:auto;white-space:pre-wrap;font-size:var(--fs-meta);line-height:1.5;color:var(--ink-2);background:var(--bg);border-radius:var(--radius-sm)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3);margin-top:var(--space-3)}
.apply{display:inline-block;background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:650;font-size:var(--fs-body);padding:7px 13px;border-radius:var(--radius-sm)}
.apply:hover{filter:brightness(1.06)}
.actions .meta{font-size:var(--fs-meta);color:var(--ink-3)}

.empty{padding:var(--space-6) var(--space-4);text-align:center;background:var(--surface);border:1px dashed var(--line-2);border-radius:var(--radius);color:var(--ink-3)}
.empty[hidden]{display:none}

details.run{margin-top:var(--space-6);padding-top:var(--space-3);border-top:1px solid var(--line);font-size:var(--fs-meta);color:var(--ink-2)}
details.run>summary{cursor:pointer;font-weight:600;color:var(--ink-2)}
.run dl{display:grid;grid-template-columns:max-content 1fr;gap:var(--space-1) var(--space-4);margin:var(--space-3) 0 0}
.run dt{color:var(--ink-3)}
.run dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.run dd ul{margin:2px 0 0;padding-left:16px}
.run dd li{margin:0}
.foot{margin-top:var(--space-5);font-size:var(--fs-meta);color:var(--ink-3)}

@media (max-width:640px){
  .page{padding:var(--space-4) var(--space-3) var(--space-5)}
  .job{grid-template-columns:44px 1fr;gap:var(--space-3);padding:var(--space-3)}
  .ring{width:44px;height:44px}.ring::before{inset:4px}.ring b{font-size:13px}
  .toolbar .count{margin-left:0;flex-basis:100%}
  .run dl{grid-template-columns:1fr;gap:0}
  .run dt{margin-top:var(--space-2)}
}
@media print{
  body{background:#fff}
  .toolbar,.foot{display:none}
  .job{break-inside:avoid;box-shadow:none}
}
`;

// Sort, filter, and search over the rendered cards. Cards carry their sort keys as data attributes,
// so the script never re-parses text and needs no library.
export const REPORT_SCRIPT = `
(function () {
  var list = document.getElementById('jobs');
  var toolbar = document.getElementById('toolbar');
  if (!list || !toolbar) return;
  var cards = Array.prototype.slice.call(list.querySelectorAll('.job'));
  var q = document.getElementById('q');
  var sort = document.getElementById('sort');
  var role = document.getElementById('role');
  var track = document.getElementById('track');
  var count = document.getElementById('count');
  var none = document.getElementById('no-results');
  function num(card, key) { var value = parseFloat(card.dataset[key]); return isNaN(value) ? -Infinity : value; }
  function byScore(a, b) { return num(b, 'score') - num(a, 'score'); }
  var sorters = {
    score: byScore,
    company: function (a, b) { return (a.dataset.company || '').localeCompare(b.dataset.company || '') || byScore(a, b); },
    posted: function (a, b) { return num(b, 'posted') - num(a, 'posted') || byScore(a, b); }
  };
  function apply() {
    var term = (q.value || '').trim().toLowerCase();
    var wantRole = role.value;
    var wantTrack = track.value;
    var shown = 0;
    cards.slice().sort(sorters[sort.value] || byScore).forEach(function (card) {
      var ok = (!wantRole || card.dataset.role === wantRole)
        && (!wantTrack || card.dataset.track === wantTrack)
        && (!term || (card.dataset.search || '').indexOf(term) >= 0);
      card.hidden = !ok;
      if (ok) shown += 1;
      list.appendChild(card);
    });
    if (count) count.textContent = shown === cards.length ? cards.length + ' shown' : shown + ' of ' + cards.length + ' shown';
    if (none) none.hidden = shown > 0;
  }
  [q, sort, role, track].forEach(function (control) {
    if (!control) return;
    control.addEventListener('input', apply);
    control.addEventListener('change', apply);
  });
  toolbar.addEventListener('submit', function (event) { event.preventDefault(); });
})();
`;

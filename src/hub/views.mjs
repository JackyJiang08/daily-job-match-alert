// Hub pages. The shell adds a sticky left navigation around content built from the same components and
// tokens as the Desktop report (report-components.mjs / report-theme.mjs), so both look alike in light
// and dark mode. Every timestamp is shown in config.timeZone; resume text is never rendered here.
import { REPORT_SCRIPT, REPORT_STYLES } from '../report-theme.mjs';
import { formatCount, formatDateLabel, formatLocalDateTime, formatLocalDay, formatLocalShort, formatRelativeTime } from '../time-format.mjs';
import { htmlEscape } from '../utils.mjs';
import { LETTER_STYLES, coverLetterSettingsSection } from './letter-views.mjs';

export const HUB_TITLE = 'Daily Job Match Alert Hub';
export const HUB_BRAND = 'Job Match Hub';
const NAV = [
  { id: 'reports', href: '/reports', label: 'Reports' },
  { id: 'resumes', href: '/resumes', label: 'Resumes' },
  { id: 'letters', href: '/letters', label: 'Letters' },
  { id: 'status', href: '/status', label: 'Status' },
  { id: 'settings', href: '/settings', label: 'Settings' },
];

export const HUB_STYLES = `
.hub{display:grid;grid-template-columns:200px minmax(0,1fr);min-height:100vh}
.hub-nav{position:sticky;top:0;height:100vh;overflow:auto;display:flex;flex-direction:column;border-right:1px solid var(--line);padding:var(--space-5) var(--space-3) var(--space-4);background:var(--surface)}
.hub-nav .brand{font-size:var(--fs-body);font-weight:650;margin:0 0 var(--space-4) var(--space-3);line-height:1.5;white-space:nowrap}
.hub-nav a{display:block;padding:6px var(--space-2) 6px 9px;margin:0 0 2px;border-left:3px solid transparent;border-radius:0 var(--radius-sm) var(--radius-sm) 0;text-decoration:none;color:var(--ink-2);font-size:var(--fs-body);line-height:1.5}
.hub-nav a.active{background:var(--accent-soft);color:var(--accent);font-weight:650;border-left-color:var(--accent)}
.hub-nav a:hover{color:var(--ink)}
.hub-nav .mini{margin:auto 0 0 var(--space-3);padding-top:var(--space-4);border-top:1px solid var(--line);font-size:11px;line-height:1.5;color:var(--ink-3)}
.hub-nav .mini b{display:block;font-weight:600;color:var(--ink-2)}
.hub-nav .mini .ok{color:var(--accent)}.hub-nav .mini .bad{color:var(--bad-ink)}.hub-nav .mini .warn{color:var(--warn-ink)}
.hub-nav .mini .rel{white-space:nowrap}.hub-nav .mini .rel.overdue{color:var(--bad-ink);font-weight:600}
.hub-main{padding:var(--space-5) var(--space-5) var(--space-6);min-width:0}
.hub-content{max-width:1280px;margin:0}
.hub-main .page{padding:0;margin:0;max-width:none}
.hub-title{margin:0 0 var(--space-4);font-size:var(--fs-page);font-weight:650;letter-spacing:-0.01em}
.hub-sub{margin:calc(-1 * var(--space-3)) 0 var(--space-4);font-size:var(--fs-body);color:var(--ink-2)}
.flash{margin:0 0 var(--space-4);padding:var(--space-3) var(--space-4);border-radius:var(--radius);font-size:var(--fs-body)}
.flash.notice{background:var(--accent-soft);color:var(--accent)}
.flash.error{background:var(--bad-bg);color:var(--bad-ink)}
.split{display:grid;grid-template-columns:232px minmax(0,1fr);gap:var(--space-4);align-items:start}
.split aside{position:sticky;top:var(--space-4);max-height:calc(100vh - 2 * var(--space-4));overflow:auto;display:flex;flex-direction:column}
.datetools{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1) var(--space-2);padding:0 var(--space-2) var(--space-2);font-size:var(--fs-meta);color:var(--ink-3)}
.datetools .today-link{text-decoration:none;color:var(--accent);font-weight:650}
.datetools label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
.datelist{margin:0;padding:0;list-style:none;font-size:var(--fs-body)}
.datelist .month{position:sticky;top:0;z-index:1;margin:0;padding:var(--space-2) var(--space-2) var(--space-1);background:var(--bg);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2)}
.datelist .month-toggle{display:flex;align-items:center;gap:6px;width:100%;margin:0;padding:0;border:0;background:none;font:inherit;color:inherit;letter-spacing:inherit;text-transform:inherit;cursor:pointer;text-align:left}
.datelist .month-toggle::before{content:"";width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);margin:-2px 2px 0 0;transition:transform .12s}
.datelist .month[data-collapsed="1"] .month-toggle::before{transform:rotate(-45deg);margin:0 2px 0 0}
.datelist li[hidden]{display:none}
.datelist a{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:baseline;gap:2px 6px;padding:6px var(--space-2);border-radius:var(--radius-sm);text-decoration:none;color:var(--ink-2)}
.datelist a>span:first-child{margin-right:auto;white-space:nowrap}
.datelist a .n{color:var(--ink-3);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:var(--fs-meta);text-align:right}
.datelist a.active{background:var(--accent-soft);color:var(--accent);font-weight:650}
.datelist a.active .n{color:var(--accent)}
.datelist a.today:not(.active){color:var(--ink);font-weight:650}
.datelist a.quiet{color:var(--ink-3)}
.datelist .tag{font-size:10px;font-weight:600;line-height:1.4;border-radius:var(--radius-sm);padding:0 5px;background:var(--line);color:var(--ink-3);white-space:nowrap}
.datelist a.active .tag{background:var(--accent-soft);color:var(--accent)}
.report-head{display:flex;justify-content:flex-end;gap:var(--space-2);margin:0 0 var(--space-2)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-4);margin:0 0 var(--space-3);box-shadow:var(--shadow)}
.card h2{margin:0 0 var(--space-1);font-size:var(--fs-title);font-weight:650}
.card h3{margin:var(--space-3) 0 var(--space-1);font-size:var(--fs-meta);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--space-1) var(--space-4);margin:var(--space-2) 0 0;font-size:var(--fs-body)}
.kv dt{color:var(--ink-3)}
.kv dd{margin:0;overflow-wrap:anywhere}
.kv code,.mono{font-family:var(--font-mono);font-size:var(--fs-meta)}
.row{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;margin-top:var(--space-3)}
.btn{display:inline-block;background:var(--accent);color:var(--accent-ink);border:0;border-radius:var(--radius-sm);padding:7px 13px;font:inherit;font-size:var(--fs-body);font-weight:650;cursor:pointer;text-decoration:none;line-height:1.3}
.btn.secondary{background:transparent;color:var(--ink-2);border:1px solid var(--line-2)}
.btn.small{padding:4px 10px;font-size:var(--fs-meta)}
.btn.danger{background:var(--bad-bg);color:var(--bad-ink)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.badge-good{background:var(--accent-soft);color:var(--accent)}
.badge-muted{background:var(--line);color:var(--ink-3)}
.file{display:inline-flex;align-items:center;gap:var(--space-2)}
.file input[type=file]{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.file .file-name{font-size:var(--fs-meta);color:var(--ink-3);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.radio-row{display:flex;flex-wrap:wrap;gap:var(--space-3)}
.radio-row label{display:inline-flex;align-items:center;gap:6px}
.conn{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--space-2) var(--space-4);font-size:var(--fs-body)}
.conn dt{color:var(--ink-3)}.conn dd{margin:0}
.conn .badge{vertical-align:middle}
fieldset.group{min-inline-size:0;border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3) var(--space-4) var(--space-2);margin:0 0 var(--space-3)}
fieldset.group legend{font-size:var(--fs-meta);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:0 6px}
.field{display:block;margin:0 0 var(--space-3);font-size:var(--fs-body)}
.field>span{display:block;font-size:var(--fs-meta);color:var(--ink-3);margin-bottom:4px}
.field input[type=text],.field input[type=number],.field input[type=email],.field select{font:inherit;font-size:var(--fs-body);line-height:1.3;color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--radius-sm);padding:6px 9px;min-height:32px;min-width:240px;max-width:100%;box-sizing:border-box}
.field select{appearance:none;-webkit-appearance:none;background-image:var(--chevron);background-repeat:no-repeat;background-position:right 9px center;padding-right:28px;cursor:pointer}
.field input:focus,.field select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.radio-row .badge{margin-left:4px}
.engine-warning{margin:var(--space-1) 0 0;font-size:var(--fs-meta);color:var(--warn-ink)}
.field label.check{display:inline-flex;align-items:center;gap:6px;margin-right:var(--space-3)}
.inline{display:inline}
.form-foot{font-size:var(--fs-meta);color:var(--ink-3);margin:var(--space-2) 0 0}
table.plain{border-collapse:collapse;width:100%;font-size:var(--fs-body)}
table.plain th,table.plain td{text-align:left;padding:6px var(--space-2);border-bottom:1px solid var(--line);vertical-align:top}
table.plain th{font-size:var(--fs-meta);color:var(--ink-3);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
pre.log{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius-sm);padding:var(--space-3);max-height:360px;overflow:auto;font-family:var(--font-mono);font-size:var(--fs-meta);white-space:pre-wrap;overflow-wrap:anywhere;margin:var(--space-2) 0 0}
details.day{margin:var(--space-2) 0}
details.day>summary{cursor:pointer;font-size:var(--fs-body)}
.count-zero{color:var(--ink-3)}
.count-some{color:var(--warn-ink);font-weight:650}
.muted{color:var(--ink-3)}
[hidden]{display:none!important}
@media (max-width:760px){.hub{grid-template-columns:1fr}.hub-nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);flex-direction:row;flex-wrap:wrap;gap:4px;padding:var(--space-3)}.hub-nav .brand,.hub-nav .mini{flex-basis:100%;margin:0}.hub-nav .mini{border-top:0;padding-top:var(--space-2)}.split{grid-template-columns:1fr}.split aside{position:static;max-height:none}.hub-main{padding:var(--space-4) var(--space-3)}}
`;

export const HUB_SCRIPT = `
(function () {
  document.querySelectorAll('.file input[type=file]').forEach(function (input) {
    var label = input.closest('.file');
    var name = label && label.querySelector('.file-name');
    input.addEventListener('change', function () {
      if (name) name.textContent = input.files && input.files[0] ? input.files[0].name : 'No file chosen';
    });
  });
  // Sidebar "Next run" countdown, refreshed every minute; mirrors formatRelativeTime in time-format.mjs.
  var next = document.getElementById('next-run');
  var rel = next && next.querySelector('.rel');
  if (next && rel && next.dataset.at) {
    var at = new Date(next.dataset.at).getTime();
    function relative() {
      var diff = at - Date.now();
      if (diff <= -1800000) return 'overdue';
      if (diff <= 0) return 'due now';
      var minutes = Math.ceil(diff / 60000);
      if (minutes < 60) return 'in ' + minutes + 'm';
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return 'in ' + hours + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '');
      var days = Math.floor(hours / 24);
      return 'in ' + days + 'd' + (hours % 24 ? ' ' + (hours % 24) + 'h' : '');
    }
    function tick() { var text = relative(); rel.textContent = text; rel.classList.toggle('overdue', text === 'overdue'); }
    tick();
    setInterval(tick, 60000);
  }
})();
`;

function resultIcon(result) {
  if (result === 'success') return '<span class="ok">✓</span>';
  if (result === 'incomplete') return '<span class="warn">⚠</span>';
  if (result === 'error') return '<span class="bad">✗</span>';
  return '<span>–</span>';
}

// Sidebar summary. "Next run" carries the instant so the page script can keep the relative part
// ("in 3h 20m", then "due now" / "overdue") current without a reload.
function renderMiniStatus(sidebar, timeZone, now) {
  if (!sidebar) return '';
  const last = sidebar.lastRunAt ? `${resultIcon(sidebar.lastResult)} ${htmlEscape(formatLocalShort(sidebar.lastRunAt, timeZone))}` : '– No run yet';
  const relative = sidebar.nextRunAt ? formatRelativeTime(sidebar.nextRunAt, now) : '';
  const next = sidebar.nextRunAt
    ? `<span id="next-run" data-at="${htmlEscape(sidebar.nextRunAt)}">${htmlEscape(formatLocalShort(sidebar.nextRunAt, timeZone))} · <span class="rel${relative === 'overdue' ? ' overdue' : ''}">${htmlEscape(relative)}</span></span>`
    : '—';
  const auth = sidebar.claudeAuth?.expired ? '<b>Claude</b><span class="bad" data-auth="expired">Session expired</span>' : '';
  return `<div class="mini"><b>Last run</b>${last}<b>Next run</b>${next}${auth}</div>`;
}

export function renderHubPage({ active, title, content, notice = '', error = '', port, script = '', sidebar = null, timeZone, now = null }) {
  const nav = NAV.map(item => `<a href="${item.href}"${item.id === active ? ' class="active"' : ''}>${htmlEscape(item.label)}</a>`).join('');
  const flash = [
    notice ? `<div class="flash notice">${htmlEscape(notice)}</div>` : '',
    error ? `<div class="flash error">${htmlEscape(error)}</div>` : '',
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)} — ${htmlEscape(HUB_TITLE)}</title>
<style>${REPORT_STYLES}${HUB_STYLES}${LETTER_STYLES}</style></head>
<body><div class="hub"><nav class="hub-nav"><p class="brand">${htmlEscape(HUB_BRAND)}</p>${nav}${renderMiniStatus(sidebar, timeZone, now)}</nav>
<main class="hub-main"><div class="hub-content">${flash}${content}</div></main></div>
<script>${REPORT_SCRIPT}${HUB_SCRIPT}${script}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------- reports

function monthLabel(date) {
  const match = /^(\d{4})-(\d{2})/.exec(String(date || ''));
  if (!match) return String(date || '');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Dates newest first, grouped by month with sticky month headings; empty days carry data-empty so the
// "Only days with matches" toggle can hide them (and any month left without visible days). The current
// month (of `today` in config.timeZone) is always open; earlier months start collapsed unless they hold
// the selected date (a later month, which only the tomorrow report creates, starts open), and the page
// script restores what the owner opened or closed before.
export function renderDateList({ dates, selected, today }) {
  if (!dates.length) return '<p class="muted">No reports yet.</p>';
  const items = [];
  const currentMonth = String(today || '').slice(0, 7);
  const selectedMonth = String(selected || '').slice(0, 7);
  let month = null;
  let collapsed = false;
  for (const item of dates) {
    const label = monthLabel(item.date);
    const key = item.date.slice(0, 7);
    if (label !== month) {
      month = label;
      const current = key === currentMonth;
      collapsed = !current && key < currentMonth && key !== selectedMonth;
      items.push(current
        ? `<li class="month" data-month="${htmlEscape(key)}" data-current="1">${htmlEscape(label)}</li>`
        : `<li class="month" data-month="${htmlEscape(key)}"${collapsed ? ' data-collapsed="1"' : ''}><button type="button" class="month-toggle" aria-expanded="${collapsed ? 'false' : 'true'}">${htmlEscape(label)}</button></li>`);
    }
    const isToday = item.date === today;
    const isFuture = Boolean(today) && item.date > today;
    const classes = [item.date === selected ? 'active' : '', isToday ? 'today' : '', item.matchCount === 0 ? 'quiet' : ''].filter(Boolean).join(' ');
    const count = item.matchCount == null ? '' : `<span class="n">${item.matchCount} match${item.matchCount === 1 ? '' : 'es'}</span>`;
    // Calendar tags: "Today" for the current date in config.timeZone, "Tomorrow" for anything later (the
    // evening run writes the next application date, so that is usually the newest report).
    const tag = isToday ? '<span class="tag" data-tag="today">Today</span>' : isFuture ? '<span class="tag" data-tag="tomorrow">Tomorrow</span>' : '';
    items.push(`<li data-month="${htmlEscape(key)}"${item.matchCount === 0 ? ' data-empty="1"' : ''}${collapsed ? ' hidden' : ''}><a href="/reports/${item.date}"${classes ? ` class="${classes}"` : ''} title="${item.date}${isToday ? ' (today)' : isFuture ? ' (after today)' : ''}"><span>${htmlEscape(formatDateLabel(item.date))}</span>${count}${tag}</a></li>`);
  }
  const jump = todayTarget(dates, today);
  return `<div class="datetools"><a class="today-link" href="/reports/${jump.date}" id="today-link" title="${jump.isToday ? `Today's report (${jump.date})` : `No report for today; newest report (${jump.date})`}">${jump.isToday ? 'Today' : 'Latest'}</a><label><input type="checkbox" id="only-matches"> Only days with matches</label></div><ul class="datelist" id="datelist">${items.join('')}</ul>`;
}

// The date the "Today" shortcut and the default selection point at: today's report when it exists,
// otherwise the newest one.
export function todayTarget(dates, today) {
  const list = dates.map(item => (typeof item === 'string' ? item : item.date));
  if (today && list.includes(today)) return { date: today, isToday: true };
  return { date: list[0] || null, isToday: false };
}

export function reportsPage({ dates, selected, reportBody, desktopPath, today }) {
  const list = renderDateList({ dates, selected, today });
  const body = reportBody
    ? `<div class="report-head"><a class="btn secondary small" href="/desktop/${selected}" target="_blank" rel="noopener noreferrer" title="${htmlEscape(desktopPath)}">Open Desktop Copy</a><a class="btn secondary small" href="/desktop/${selected}/xlsx" title="Download the Desktop workbook">Download XLSX</a></div><div class="page">${reportBody}</div>`
    : `<p class="muted">${dates.length ? 'Pick a date on the left.' : 'Run the pipeline once and its report will appear here.'}</p>`;
  return `<div class="split"><aside id="date-column">${list}</aside><section>${body}</section></div>`;
}

export const REPORTS_SCRIPT = `
(function () {
  var list = document.getElementById('datelist');
  var toggle = document.getElementById('only-matches');
  var today = document.getElementById('today-link');
  var column = document.getElementById('date-column');
  if (!list || !toggle) return;
  var key = 'hub.reports.onlyMatches';
  var monthsKey = 'hub.reports.months';
  var active = list.querySelector('a.active');
  var activeMonth = active ? active.closest('li').dataset.month : null;
  // Open/closed state per month; the current month is always open and the month holding the selected
  // date opens for this page view without being remembered.
  var months = {};
  try { months = JSON.parse(localStorage.getItem(monthsKey) || '{}') || {}; } catch (e) { months = {}; }
  var collapsed = {};
  list.querySelectorAll('li.month').forEach(function (heading) {
    var month = heading.dataset.month;
    if (heading.dataset.current === '1') { collapsed[month] = false; return; }
    collapsed[month] = months[month] === 'open' ? false : months[month] === 'closed' ? true : heading.dataset.collapsed === '1';
    if (month === activeMonth) collapsed[month] = false;
  });
  function apply() {
    var only = toggle.checked;
    try { localStorage.setItem(key, only ? '1' : '0'); } catch (e) {}
    var monthsWithDays = {};
    list.querySelectorAll('li:not(.month)').forEach(function (item) {
      var shown = !(only && item.dataset.empty === '1');
      if (shown) monthsWithDays[item.dataset.month] = true;
      item.hidden = !shown || collapsed[item.dataset.month] === true;
    });
    list.querySelectorAll('li.month').forEach(function (heading) {
      var month = heading.dataset.month;
      heading.hidden = !monthsWithDays[month];
      if (collapsed[month]) heading.dataset.collapsed = '1'; else delete heading.dataset.collapsed;
      var button = heading.querySelector('.month-toggle');
      if (button) button.setAttribute('aria-expanded', collapsed[month] ? 'false' : 'true');
    });
  }
  list.addEventListener('click', function (event) {
    var button = event.target.closest('.month-toggle');
    if (!button) return;
    var month = button.closest('li').dataset.month;
    collapsed[month] = !collapsed[month];
    months[month] = collapsed[month] ? 'closed' : 'open';
    try { localStorage.setItem(monthsKey, JSON.stringify(months)); } catch (e) {}
    apply();
  });
  try { toggle.checked = localStorage.getItem(key) === '1'; } catch (e) {}
  toggle.addEventListener('change', apply);
  apply();
  if (today && column) today.addEventListener('click', function () { column.scrollTop = 0; });
  if (active && column && active.offsetTop > column.clientHeight - 40) column.scrollTop = active.offsetTop - 80;
})();
`;

// ---------------------------------------------------------------------------------------------- resumes

function locationBadge(track) {
  const title = track.pdf ? ` title="${htmlEscape(track.pdf)}"` : '';
  if (track.managed) return `<span class="badge" data-badge="hub"${title}>Hub</span>`;
  if (track.onDesktop) return `<span class="badge" data-badge="desktop"${title}>On Desktop</span>`;
  if (track.pdf) return `<span class="badge badge-warn" data-badge="external"${title}>External file</span>`;
  return '<span class="badge badge-bad" data-badge="no-pdf">No PDF configured</span>';
}

function trackCard(track, timeZone) {
  const enabled = track.enabled
    ? '<span class="badge badge-good" data-badge="enabled">Enabled</span>'
    : '<span class="badge badge-muted" data-badge="disabled">Disabled</span>';
  const rows = [];
  rows.push(`<dt>PDF</dt><dd>${track.pdf ? `<span class="mono" title="${htmlEscape(track.pdf)}">${htmlEscape(track.pdfName)}</span>${track.pdfExists ? '' : ' <span class="badge badge-bad" data-badge="missing">File not found</span>'}` : '—'}</dd>`);
  if (track.uploadedAt) rows.push(`<dt>Last upload</dt><dd>${htmlEscape(formatLocalDateTime(track.uploadedAt, timeZone))}</dd>`);
  if (track.extraction) {
    rows.push(`<dt>Text extraction</dt><dd>${track.extraction.ok ? `${formatCount(track.extraction.characters)} characters (checked ${htmlEscape(formatLocalDateTime(track.extraction.checkedAt, timeZone))})` : `Failed: ${htmlEscape(track.extraction.error)}`}</dd>`);
  }
  rows.push(`<dt>Profile</dt><dd>${track.profile.exists
    ? `<span title="${htmlEscape(track.profile.path)}">Profile synced${track.lastSync ? ` ${htmlEscape(formatLocalDay(track.lastSync, timeZone))}` : ''} · ${formatCount(track.profile.characters)} characters</span>`
    : `<span class="muted" title="${htmlEscape(track.profile.path)}">Profile not extracted yet; the next nightly run creates it</span>`}</dd>`);
  const versions = track.versions.length
    ? `<h3>Kept Versions</h3><table class="plain"><tr><th>File</th><th>Uploaded</th><th>Size</th><th></th></tr>${track.versions.map(version => `<tr><td><span class="mono" title="${htmlEscape(version.path)}">${htmlEscape(version.name)}</span>${version.path === track.pdf ? ' <span class="badge badge-good" data-badge="current">Current</span>' : ''}</td><td>${htmlEscape(formatLocalDateTime(version.modifiedAt, timeZone))}</td><td>${Math.round(version.size / 1024)} KB</td><td>${version.path === track.pdf ? '' : `<form class="inline" method="post" action="/resumes/select"><input type="hidden" name="trackId" value="${htmlEscape(track.id)}"><input type="hidden" name="file" value="${htmlEscape(version.name)}"><button class="btn secondary small" type="submit">Use This Version</button></form>`}</td></tr>`).join('')}</table>`
    : '';
  return `<article class="card" data-track="${htmlEscape(track.id)}">
    <h2>${htmlEscape(track.label)} <span class="muted">(${htmlEscape(track.id)})</span></h2>
    <div class="badges">${enabled}${locationBadge(track)}</div>
    <dl class="kv">${rows.join('')}</dl>
    ${versions}
    <form method="post" action="/resumes/upload" enctype="multipart/form-data" class="row">
      <input type="hidden" name="trackId" value="${htmlEscape(track.id)}">
      <label class="file"><input type="file" name="file" accept=".pdf,application/pdf" required><span class="btn secondary">Choose PDF…</span><span class="file-name">No file chosen</span></label>
      <button class="btn" type="submit">Upload Replacement PDF</button>
      <span style="flex-basis:100%"></span>
    </form>
    <form method="post" action="/resumes/toggle" class="row">
      <input type="hidden" name="trackId" value="${htmlEscape(track.id)}">
      <input type="hidden" name="enabled" value="${track.enabled ? 'false' : 'true'}">
      <button class="btn ${track.enabled ? 'danger' : 'secondary'}" type="submit">${track.enabled ? 'Disable Track' : 'Enable Track'}</button>
    </form>
  </article>`;
}

export function resumesPage({ tracksView, timeZone }) {
  const intro = tracksView.legacy
    ? '<div class="flash error">The configuration still uses the older two-resume layout. Switch it to resume tracks (the example configuration shows how) to manage resumes from the hub.</div>'
    : (tracksView.error ? `<div class="flash error">${htmlEscape(tracksView.error)}</div>` : '');
  const cards = tracksView.tracks.map(track => trackCard(track, timeZone)).join('\n');
  const add = tracksView.legacy ? '' : `<article class="card"><h2>Add Track</h2>
    <form method="post" action="/resumes/add" enctype="multipart/form-data">
      <label class="field"><span>ID (letters, digits, _ or -)</span><input type="text" name="trackId" class="control-input" pattern="[A-Za-z][A-Za-z0-9_-]{0,31}" required></label>
      <label class="field"><span>Label shown in reports</span><input type="text" name="label" class="control-input" required></label>
      <div class="field"><span>PDF</span><label class="file"><input type="file" name="file" accept=".pdf,application/pdf" required><span class="btn secondary">Choose PDF…</span><span class="file-name">No file chosen</span></label></div>
      <button class="btn" type="submit">Add Track</button>
    </form></article>`;
  return `<h1 class="hub-title">Resumes</h1>
  <p class="hub-sub">One PDF per resume track; upload a new version here and tonight's run scores against it. Files stay on this Mac.</p>
  ${intro}${cards}${add}`;
}

// ---------------------------------------------------------------------------------------------- status

function dayRow(day) {
  const body = day.warningsText
    ? `<pre class="log">${htmlEscape(day.warningsText)}</pre>`
    : `<p class="muted">No warnings.txt for this date${day.count ? ' (the folder may have been moved)' : ''}.</p>`;
  const count = `<span class="${day.count ? 'count-some' : 'count-zero'}">${day.count} warning${day.count === 1 ? '' : 's'}</span>`;
  return `<details class="day"><summary>${htmlEscape(formatDateLabel(day.date))} · ${count}${day.matchCount != null ? ` <span class="muted">· ${day.matchCount} match${day.matchCount === 1 ? '' : 'es'}</span>` : ''}</summary>${body}</details>`;
}

// Every source the nightly run can draw on: enabled state, last success, postings added by the last
// run, and a Dormant badge with a Resume Polling button for boards that failed seven nights running.
function sourceRow(row, timeZone) {
  const enabled = row.enabled
    ? '<span class="badge badge-good" data-badge="enabled">Enabled</span>'
    : '<span class="badge badge-muted" data-badge="disabled">Disabled</span>';
  const kind = row.kind === 'builtin' ? '' : ` <span class="muted">${htmlEscape(row.kind)}</span>`;
  const last = row.lastSuccessAt ? htmlEscape(formatLocalDateTime(row.lastSuccessAt, timeZone)) : '<span class="muted">Never</span>';
  const fresh = row.newCount == null ? '<span class="muted">—</span>' : `${row.newCount}${row.jobCount != null ? ` <span class="muted">of ${row.jobCount} listed</span>` : ''}`;
  const notes = [];
  if (row.quiet && !row.dormant) notes.push('<span class="badge badge-muted" data-badge="quiet" title="No new posting for 30 days; polled weekly">Quiet</span>');
  if (row.dormant) notes.push(`<span class="badge badge-bad" data-badge="dormant" title="${htmlEscape(row.error || '')}">Dormant</span> <form class="inline" method="post" action="/status/sources/resume"><input type="hidden" name="board" value="${htmlEscape(row.key)}"><button class="btn secondary small" type="submit">Resume Polling</button></form>`);
  else if (row.error) notes.push(`<span class="badge badge-warn" data-badge="failing">Failing${row.consecutiveFailures > 1 ? ` (${row.consecutiveFailures} in a row)` : ''}</span> <span class="muted">${htmlEscape(row.error)}</span>`);
  else if (row.skipped) notes.push(`<span class="muted">Not polled (${htmlEscape(row.skipped)})</span>`);
  else if (row.baselineCount != null && row.newCount == null) notes.push(`<span class="muted">Baseline of ${row.baselineCount} recorded</span>`);
  else if (row.enabled && row.lastSuccessAt) notes.push('<span class="muted">OK</span>');
  return `<tr data-source="${htmlEscape(row.key)}"><td>${htmlEscape(row.label)}${kind}</td><td>${enabled}</td><td>${last}</td><td>${fresh}</td><td>${notes.join(' ')}</td></tr>`;
}

// The Quota card: last limit event, the model or engine in effect, and the deferral queue.
function quotaCard(quota, timeZone) {
  if (!quota) return '';
  const event = quota.lastEvent
    ? `${htmlEscape(quota.lastEvent.description)} · ${htmlEscape(formatLocalDateTime(quota.lastEvent.at, timeZone))} · <span class="badge badge-warn" data-badge="quota-action">${htmlEscape(quota.lastEvent.action || 'refused')}</span>${quota.lastEvent.detail ? ` <span class="muted">${htmlEscape(quota.lastEvent.detail)}</span>` : ''}${quota.lastEvent.source ? ` <span class="muted">(${htmlEscape(quota.lastEvent.source)})</span>` : ''}`
    : '<span class="muted">No limit reached so far</span>';
  const effective = quota.effectiveEngine === 'codex'
    ? 'codex (fallback engine)'
    : `${htmlEscape(quota.effectiveEngine)} · ${htmlEscape(quota.effectiveModel || 'default')}${quota.effectiveModel && quota.configuredModel && quota.effectiveModel !== quota.configuredModel ? ` <span class="badge badge-warn" data-badge="downgraded">downgraded from ${htmlEscape(quota.configuredModel)}</span>` : ''}`;
  return `<article class="card" id="quota-card"><h2>Quota</h2><dl class="kv">
    <dt>Last limit event</dt><dd id="quota-last">${event}</dd>
    <dt>Model in effect</dt><dd id="quota-model">${effective}</dd>
    <dt>Deferred postings</dt><dd id="quota-deferred">${Number(quota.deferredCount || 0)} waiting for the next run${quota.deferredByQuota ? ` · ${Number(quota.deferredByQuota)} of them because of a limit` : ''}</dd>
    <dt>Policy</dt><dd>Ladder ${htmlEscape((quota.modelLadder || []).join(' → '))} · ${quota.fallbackEngine ? `Codex fallback on` : 'no engine fallback'}</dd>
    ${quota.budgetHistory?.length ? `<dt>Candidates vs budget</dt><dd id="quota-history">${quota.budgetAlert ? `<span class="badge badge-warn" data-badge="budget-alert">Over budget ${Number(quota.budgetAlert.nights)} nights running</span> <span class="muted">Raise Max Reviewed Per Run or tighten the prefilter.</span><br>` : ''}<span class="mono">${quota.budgetHistory.map(entry => `${htmlEscape(entry.date)} ${Number(entry.inWindow)}/${Number(entry.limit) || '∞'}`).join(' · ')}</span> <span class="muted">(in-window candidates / budget, last ${quota.budgetHistory.length} nights${quota.expiredBacklogCount ? `; ${Number(quota.expiredBacklogCount)} backlog postings expired last run` : ''})</span></dd>` : ''}
  </dl></article>`;
}

function sourcesCard(rows, timeZone) {
  const body = rows.length
    ? `<table class="plain" id="sources-table"><tr><th>Source</th><th>Enabled</th><th>Last Success</th><th>New This Run</th><th>Status</th></tr>${rows.map(row => sourceRow(row, timeZone)).join('')}</table>`
    : '<p class="muted">No sources configured.</p>';
  const boards = rows.filter(row => row.kind !== 'builtin');
  const summary = boards.length
    ? `<p class="muted" id="sources-summary">${boards.length} ATS board${boards.length === 1 ? '' : 's'} · ${boards.filter(row => row.quiet && !row.dormant).length} quiet (polled weekly) · ${boards.filter(row => row.dormant).length} dormant · ${boards.filter(row => !row.enabled).length} disabled</p>`
    : '';
  return `<article class="card" id="sources-card"><h2>Sources</h2><p class="muted">Built-in lists and every public ATS board discovered from posting URLs. A board with no new posting for 30 days is polled weekly; one that fails seven nights in a row goes dormant until you resume it.</p>${summary}${body}</article>`;
}

export function statusPage({ status, timeZone }) {
  const { lastRun, nextRun, lock, runNow, run } = status;
  const at = value => htmlEscape(formatLocalDateTime(value, timeZone));
  const lockLine = lock.locked
    ? `<span title="${htmlEscape(lock.path)}">Held by PID ${lock.pid}</span>`
    : (lock.stale ? `Stale lock from PID ${lock.pid ?? '?'}; the next run clears it` : 'Free');
  const errors = status.errors.length
    ? `<table class="plain"><tr><th>File</th><th>Written</th></tr>${status.errors.map(item => `<tr><td><a href="/status/error/${htmlEscape(item.name)}" title="${htmlEscape(item.path)}">${htmlEscape(item.name)}</a></td><td>${at(item.modifiedAt)}</td></tr>`).join('')}</table>`
    : '<p class="muted">No ERROR-*.html files in the output directory.</p>';
  const runState = run.running ? 'running' : (run.startedAt ? 'finished' : 'idle');
  const lastRunLine = lastRun.at
    ? `${at(lastRun.at)}${lastRun.trigger ? ` · ${htmlEscape(lastRun.trigger)}` : ''} · ${htmlEscape(lastRun.result)}${lastRun.matchCount != null ? ` · ${lastRun.matchCount} match${lastRun.matchCount === 1 ? '' : 'es'}` : ''}${lastRun.date ? ` · <a href="/reports/${lastRun.date}">report</a>` : ''}`
    : 'No run yet';
  const nextRunLine = nextRun.at
    ? `${at(nextRun.at)}${nextRun.installed ? '' : ' <span class="badge badge-warn" data-badge="not-installed">LaunchAgent not installed; showing the 20:00 default</span>'}`
    : '—';
  const authBanner = status.claudeAuth?.expired
    ? `<div class="flash error" data-banner="auth-expired">Claude session expired. Run <code>claude auth login --claudeai</code> in Terminal, then try again.${status.claudeAuth.at ? ` <span class="muted">Seen ${at(status.claudeAuth.at)}${status.claudeAuth.source ? ` (${htmlEscape(status.claudeAuth.source)})` : ''}.</span>` : ''} <form class="inline" method="post" action="/settings/connections/refresh"><input type="hidden" name="back" value="status"><button class="btn secondary small" type="submit">Refresh</button></form></div>`
    : '';
  return `<h1 class="hub-title">Status</h1>
  ${authBanner}
  <article class="card"><h2>Runs</h2><dl class="kv">
    <dt>Last run</dt><dd>${lastRunLine}</dd>
    <dt>Engine</dt><dd>${lastRun.engine ? `${htmlEscape(lastRun.engine)}${lastRun.scoringModel ? ` · ${htmlEscape(lastRun.scoringModel)}` : ''}` : (lastRun.scoringModel ? htmlEscape(lastRun.scoringModel) : '—')}</dd>
    ${lastRun.candidateCount != null ? `<dt>Review budget</dt><dd>${Number(lastRun.candidateCount)} candidates · ${Number(lastRun.reviewedThisRun || 0)} reviewed · ${Number(lastRun.deferredCount || 0)} deferred${Number(lastRun.maxReviewedPerRun) > 0 ? ` · limit ${Number(lastRun.maxReviewedPerRun)} per run` : ' · no limit'}</dd>` : ''}
    <dt>Next run</dt><dd>${nextRunLine}</dd>
    <dt>Lock</dt><dd id="lock-line">${lockLine}</dd>
  </dl></article>
  <article class="card" id="run-card" data-state="${runState}"><h2>Run Now</h2>
    <p class="muted">Runs the full pipeline now using your Claude subscription. Results merge into today's report.</p>
    <div class="row">
      <button class="btn" id="run-button" type="button"${runNow.available ? '' : ' disabled'}>Run Now</button>
      <span class="muted" id="run-reason">${runNow.available ? '' : htmlEscape(runNow.reason || '')}</span>
    </div>
    <div id="run-progress"${run.startedAt ? '' : ' hidden'}>
    <dl class="kv" id="run-meta">
      <dt>State</dt><dd id="run-state">${runState}</dd>
      <dt>Started</dt><dd id="run-started">${run.startedAt ? at(run.startedAt) : '—'}</dd>
      <dt>Finished</dt><dd id="run-finished">${run.finishedAt ? at(run.finishedAt) : '—'}${run.exitCode != null ? ` · exit ${run.exitCode}` : ''}${run.matchCount != null ? ` · ${run.matchCount} matches` : ''}</dd>
      <dt>Log</dt><dd id="run-log" class="mono">${run.logPath ? htmlEscape(run.logPath) : '—'}</dd>
    </dl>
    <pre class="log" id="run-tail">${htmlEscape(run.tail.join('\n'))}</pre>
    </div>
  </article>
  ${quotaCard(status.quota, timeZone)}
  ${sourcesCard(status.sources || [], timeZone)}
  <article class="card"><h2>Warnings</h2><p class="muted">Last 7 report dates.</p>${status.days.length ? status.days.map(dayRow).join('') : '<p class="muted">No reports yet.</p>'}</article>
  <article class="card"><h2>Error Reports</h2>${errors}</article>`;
}

export const STATUS_SCRIPT = `
(function () {
  var button = document.getElementById('run-button');
  var card = document.getElementById('run-card');
  if (!button || !card) return;
  var zone = card.dataset.timeZone || 'America/Chicago';
  function text(id, value) { var el = document.getElementById(id); if (el) el.textContent = value; }
  function stamp(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('en-US', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; }
  }
  function render(status) {
    var run = status.run || {};
    var state = run.running ? 'running' : (run.startedAt ? 'finished' : 'idle');
    card.dataset.state = state;
    var progress = document.getElementById('run-progress');
    if (progress && run.startedAt) progress.hidden = false;
    text('run-state', state);
    text('run-started', stamp(run.startedAt));
    text('run-finished', stamp(run.finishedAt) + (run.exitCode != null ? ' · exit ' + run.exitCode : '') + (run.matchCount != null ? ' · ' + run.matchCount + ' matches' : ''));
    text('run-log', run.logPath || '—');
    text('run-tail', (run.tail || []).join('\\n'));
    button.disabled = !(status.runNow && status.runNow.available);
    text('run-reason', status.runNow && !status.runNow.available ? (status.runNow.reason || '') : '');
    if (status.lock) text('lock-line', status.lock.locked ? 'Held by PID ' + status.lock.pid : 'Free');
    return run.running;
  }
  function poll() {
    fetch('/status/run.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (status) {
      if (render(status)) setTimeout(poll, 2000);
    }).catch(function () { setTimeout(poll, 5000); });
  }
  button.addEventListener('click', function () {
    if (!window.confirm('将立即执行完整管道并消耗 Claude 订阅额度，结果合并进当日报告。继续？')) return;
    button.disabled = true;
    fetch('/run', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' })
      .then(function (r) { return r.json(); })
      .then(function (status) { if (status.error) { text('run-reason', status.error); button.disabled = false; } else { render(status); poll(); } })
      .catch(function (error) { text('run-reason', String(error)); button.disabled = false; });
  });
  if (card.dataset.state === 'running') poll();
})();
`;

// ---------------------------------------------------------------------------------------------- settings

function connectionRow(name, engine, item) {
  if (!item) return `<dt>${htmlEscape(name)}</dt><dd><span class="muted">Not checked</span></dd>`;
  const stale = item.configuredMissing && item.configured ? ` <span class="badge badge-warn" data-conn="stale-config" title="config points at ${htmlEscape(item.configured)}, which does not exist">config path missing</span>` : '';
  const where = item.path ? `<br><span class="muted mono" title="${htmlEscape((item.searched || []).join('\n'))}">${htmlEscape(item.path)}${item.source === 'config' ? ' (from config)' : ''}</span>${stale}` : '';
  const savePath = item.path && item.source !== 'config'
    ? `<form class="inline" method="post" action="/settings/cli-path"><input type="hidden" name="engine" value="${engine}"><input type="hidden" name="path" value="${htmlEscape(item.path)}"><button class="btn secondary small" type="submit">Save This Path to Config</button></form>`
    : '';
  if (!item.installed) {
    return `<dt>${htmlEscape(name)}</dt><dd><span class="badge badge-muted" data-conn="missing">Not found on this Mac</span> <span class="muted">Install with <code>${htmlEscape(item.hint)}</code>${item.configured ? `; config points at <code>${htmlEscape(item.configured)}</code>` : ''}</span><br><span class="muted" title="${htmlEscape((item.searched || []).join('\n'))}">Searched PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin, and nvm.</span></dd>`;
  }
  if (item.sessionExpired) return `<dt>${htmlEscape(name)}</dt><dd><span class="badge badge-bad" data-conn="expired">Session expired</span> <span class="muted">Run <code>claude auth login --claudeai</code> in Terminal, then Refresh.</span>${item.reason ? `<br><span class="muted">${htmlEscape(item.reason)}</span>` : ''}${where}</dd>`;
  if (item.connected) return `<dt>${htmlEscape(name)}</dt><dd><span class="badge badge-good" data-conn="connected">Connected</span> ${htmlEscape(item.detail)}${where}${savePath ? ` ${savePath}` : ''}</dd>`;
  return `<dt>${htmlEscape(name)}</dt><dd><span class="badge badge-warn" data-conn="disconnected">Not connected</span> <span class="muted">Sign in from a terminal: <code>${htmlEscape(item.hint)}</code></span>${item.reason ? `<br><span class="muted">${htmlEscape(item.reason)}</span>` : ''}${where}${savePath ? ` ${savePath}` : ''}</dd>`;
}

function engineBadge(item) {
  if (!item) return '';
  if (item.sessionExpired) return '<span class="badge badge-bad" data-engine-state="expired">Session expired</span>';
  if (item.connected) return '<span class="badge badge-good" data-engine-state="connected">Connected</span>';
  if (!item.installed) return '<span class="badge badge-muted" data-engine-state="missing">Not found</span>';
  return '<span class="badge badge-warn" data-engine-state="disconnected">Not connected</span>';
}

function modelSelect(engine, settings) {
  const choices = settings.modelChoices[engine] || [];
  const current = settings.models[engine] || '';
  const listed = choices.some(choice => choice.value === current);
  const options = choices.map(choice => `<option value="${htmlEscape(choice.value)}"${choice.value === current ? ' selected' : ''}>${htmlEscape(choice.label)}</option>`).join('');
  return `<div class="model-group" data-engine="${engine}"${engine === settings.engine ? '' : ' hidden'}>
      <label class="field"><span>Scoring Model</span><select name="model_${engine}" class="model-select control-input">${options}<option value="__custom__"${listed ? '' : ' selected'}>Custom…</option></select></label>
      <label class="field model-custom"${listed ? ' hidden' : ''}><span>Custom model name</span><input type="text" name="modelCustom_${engine}" class="control-input" value="${listed ? '' : htmlEscape(current)}" placeholder="${engine === 'codex' ? 'gpt-5.6-sol' : 'claude-fable-5'}"></label>
    </div>`;
}

export function settingsPage({ settings, connections = null, timeZone, coverLetter = null }) {
  const levels = ['high', 'medium', 'low'].map(level => `<label class="check"><input type="checkbox" name="acceptedMatchLevels" value="${level}"${settings.acceptedMatchLevels.includes(level) ? ' checked' : ''}> ${level.charAt(0).toUpperCase()}${level.slice(1)}</label>`).join('');
  const engines = settings.engines.map(engine => `<label><input type="radio" name="engine" value="${engine.id}"${engine.id === settings.engine ? ' checked' : ''} data-connected="${connections?.[engine.id]?.connected ? 'yes' : 'no'}"> ${htmlEscape(engine.label)} ${engineBadge(connections?.[engine.id])}</label>`).join('');
  const refresh = '<form class="inline" method="post" action="/settings/connections/refresh"><button class="btn secondary small" type="submit">Refresh</button></form>';
  const checked = connections?.checkedAt ? `<p class="form-foot">Checked ${htmlEscape(formatLocalDateTime(connections.checkedAt, timeZone))}; refreshed every minute. The hub never signs in for you. ${refresh}</p>` : `<p class="form-foot">The hub never signs in for you. ${refresh}</p>`;
  return `<h1 class="hub-title">Settings</h1>
  <article class="card"><h2>Connections</h2><dl class="conn">${connectionRow('Claude', 'claude', connections?.claude)}${connectionRow('Codex', 'codex', connections?.codex)}</dl>${checked}</article>
  <article class="card"><form method="post" action="/settings" id="settings-form">
    <fieldset class="group"><legend>Matching</legend>
      <label class="field"><span>Minimum Match Score (0–100)</span><input type="number" name="minimumMatchScore" class="control-input" min="0" max="100" step="1" value="${Number(settings.minimumMatchScore)}" required></label>
      <div class="field"><span>Accepted Match Levels</span>${levels}</div>
      <label class="field"><span>Max Reviewed Per Run (0 = no limit)</span><input type="number" name="maxReviewedPerRun" class="control-input" min="0" max="5000" step="1" value="${Number(settings.maxReviewedPerRun ?? 120)}" required></label>
      <label class="field"><span>Model Ladder (tried in order when a model hits its weekly limit)</span><input type="text" name="modelLadder" class="control-input" value="${htmlEscape(settings.modelLadder || 'fable, opus')}" placeholder="fable, opus"></label>
      <input type="hidden" name="quotaPresent" value="1">
      <div class="field"><label class="check"><input type="checkbox" name="fallbackEngine" value="codex"${settings.fallbackEngine === 'codex' ? ' checked' : ''}> Fall Back to Codex on a Weekly Account Limit (only when Codex is signed in)</label></div>
      <div class="field"><span>Engine</span><div class="radio-row">${engines}</div><p class="engine-warning" id="engine-warning" hidden>This engine is not connected on this Mac; the nightly run will keep local scores (unreviewed) until it is signed in. You can still save.</p></div>
      ${settings.engines.map(engine => modelSelect(engine.id, settings)).join('')}
    </fieldset>
    <fieldset class="group"><legend>Reports</legend>
      <div class="field"><label class="check"><input type="checkbox" name="xlsxRequired"${settings.xlsxRequired ? ' checked' : ''}> Require XLSX Workbook (fail the run when it cannot be written)</label></div>
    </fieldset>
    <fieldset class="group"><legend>Cover Letters</legend>
      <input type="hidden" name="editorReviewPresent" value="1">
      <div class="field"><label class="check"><input type="checkbox" name="editorReview"${settings.editorReview ? ' checked' : ''}> Editor review pass (a second call to the same engine checks structure, evidence numbers, and tone before you see the draft)</label></div>
    </fieldset>
    <fieldset class="group"><legend>Hub</legend>
      <label class="field"><span>Port (takes effect after the hub restarts)</span><input type="number" name="hubPort" class="control-input" min="1024" max="65535" step="1" value="${Number(settings.hubPort)}" required></label>
    </fieldset>
    <button class="btn" type="submit">Save</button>
    <p class="form-foot">Changes apply to the next run.</p>
  </form></article>
  ${coverLetter ? coverLetterSettingsSection({ ...coverLetter, timeZone }) : ''}`;
}

export const SETTINGS_SCRIPT = `
(function () {
  var form = document.getElementById('settings-form');
  if (!form) return;
  var warning = document.getElementById('engine-warning');
  function sync() {
    var checked = form.querySelector('input[name=engine]:checked') || {};
    var engine = checked.value;
    form.querySelectorAll('.model-group').forEach(function (group) { group.hidden = group.dataset.engine !== engine; });
    if (warning) warning.hidden = !(checked.dataset && checked.dataset.connected === 'no');
  }
  form.querySelectorAll('input[name=engine]').forEach(function (radio) { radio.addEventListener('change', sync); });
  form.querySelectorAll('.model-select').forEach(function (select) {
    var custom = select.closest('.model-group').querySelector('.model-custom');
    var update = function () { custom.hidden = select.value !== '__custom__'; };
    select.addEventListener('change', update);
    update();
  });
  sync();
})();
`;

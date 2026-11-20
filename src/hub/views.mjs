// Hub pages. The shell adds a left navigation (it scrolls with the page; the report's top row is what stays
// put) around content built from the same components and tokens as the Desktop report (report-components.mjs / report-theme.mjs), so both look alike in light
// and dark mode. Every timestamp is shown in config.timeZone; resume text is never rendered here.
import { assetPath } from './assets.mjs';
import { percent } from '../cover-letter/recent.mjs';
import { formatBytes, phasesText } from './report-timing.mjs';
import { REPORT_SCRIPT, REPORT_STYLES } from '../report-theme.mjs';
import { DATE_SLOT, MENU_SLOT } from '../report-components.mjs';
import { formatCount, formatDateLabel, formatElapsed, formatLongDate, formatMonthLabel, formatLocalDateTime, formatLocalDay, formatLocalShort, formatRelativeTime } from '../time-format.mjs';
import { planLabel } from '../engines/quota.mjs';
import { modelShortName } from '../engines/assignments.mjs';
import { USAGE_PURPOSES, describeTotals, formatTokens } from '../engines/usage.mjs';
import { htmlEscape } from '../utils.mjs';
import { DEFAULT_SCHEDULE, scheduleClock } from '../schedule.mjs';
import { describePrescreen, funnelText, recallText } from '../prescreen-text.mjs';
import { LETTER_STYLES, autoLettersSettingsCard, coverLetterSettingsSection, letterRulesSettingsCard } from './letter-views.mjs';
import { OUTREACH_STYLES, outreachSettingsCard } from './outreach-views.mjs';
import { MODEL_SETTINGS_STYLES, assignmentsForm, settingsTabs, subscriptionsAndModels } from './model-settings-views.mjs';

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
.hub-nav a{display:block;padding:6px var(--space-3);margin:0 0 2px;border-radius:var(--r-md);text-decoration:none;color:var(--ink-2);font-size:var(--fs-body);line-height:1.5}
.hub-nav a.active{background:var(--accent-soft);color:var(--accent);font-weight:650}
.hub-nav a:hover{color:var(--ink)}
.hub-nav .mini{margin:auto 0 0 var(--space-3);padding-top:var(--space-4);border-top:1px solid var(--line);font-size:var(--fs-meta);line-height:1.5;color:var(--ink-2)}
.hub-nav .mini b{display:block;font-weight:600;color:var(--ink-2)}
.hub-nav .mini .ok{color:var(--accent)}.hub-nav .mini .bad{color:var(--bad-ink)}.hub-nav .mini .warn{color:var(--warn-ink)}
.hub-nav .mini .rel{white-space:nowrap}.hub-nav .mini .rel.overdue{color:var(--bad-ink);font-weight:600}
.hub-nav .mini .model{display:block;padding-left:var(--space-2);text-indent:calc(-1 * var(--space-2));overflow-wrap:anywhere}
.hub-nav .mini .model.fallback{color:var(--warn-ink)}
.hub-main{padding:var(--space-5) var(--space-5) var(--space-6);min-width:0}
.hub-main .page{--gutter:var(--space-5)}
.hub-content{max-width:1280px;margin:0}
.hub-main .page{padding:0;margin:0;max-width:none}
.hub-title{margin:0 0 var(--space-4);font-size:var(--fs-title);font-weight:700;letter-spacing:-0.01em;line-height:1.3}
.hub-sub{margin:calc(-1 * var(--space-3)) 0 var(--space-4);font-size:var(--fs-body);color:var(--ink-2)}
.flash{margin:0 0 var(--space-4);padding:var(--space-3) var(--space-4);border-radius:var(--r-md);font-size:var(--fs-body)}
.flash.notice{background:var(--accent-soft);color:var(--accent)}
.flash.error{background:var(--bad-bg);color:var(--bad-ink)}
/* The report takes the whole width beside the navigation. */
.hub-content:has(.report-view){max-width:none}
/* The top row's date controls: ‹ date ›, then " · N Jobs". The date never shrinks or wraps. */
.date-nav{display:inline-flex;align-items:center;gap:var(--space-1);flex:0 0 auto;align-self:center}
.date-step{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--line-2);border-radius:var(--r-xs);background:var(--surface);color:var(--ink);font:inherit;font-size:var(--fs-title);font-weight:400;line-height:1;text-decoration:none;cursor:pointer}
.date-step:hover{border-color:var(--ink-3)}
.date-step:disabled{color:var(--ink-3);opacity:.45;cursor:default}
.date-pick{position:relative;display:inline-flex}
.date-button{font:inherit;font-weight:700;color:var(--ink);background:none;border:0;border-radius:var(--r-xs);padding:0 var(--space-2);white-space:nowrap;cursor:pointer}
.date-button:hover,.date-button[aria-expanded=true]{background:var(--accent-soft);color:var(--accent)}
.date-step:focus-visible,.date-button:focus-visible,.cal a:focus-visible,.cal button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
/* The month picker: a popover under the date (a bottom sheet at 760px and narrower). */
.cal{position:absolute;left:0;top:calc(100% + var(--space-2));z-index:7;width:300px;padding:var(--space-3);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-pop);--in-r:max(var(--r-xs), calc(var(--r-lg) - var(--space-3)));font-size:var(--fs-body);font-weight:400;letter-spacing:0;color:var(--ink)}
.cal-backdrop{display:none}
.cal-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);margin:0 0 var(--space-2)}
.cal-title{font-weight:650}
.cal-step{width:28px;height:28px;padding:0;border:1px solid var(--line-2);border-radius:var(--in-r, var(--r-xs));background:var(--surface);color:var(--ink);font:inherit;font-size:var(--fs-title);line-height:1;cursor:pointer}
.cal-step:disabled{color:var(--ink-3);opacity:.45;cursor:default}
.cal-week,.cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px}
.cal-week span{text-align:center;font-size:var(--fs-meta);color:var(--ink-3);padding:0 0 var(--space-1)}
.cal-day{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;min-height:40px;border:1px solid transparent;border-radius:var(--in-r, var(--r-sm));text-decoration:none;color:var(--ink);line-height:1.2}
.cal-day .cal-d{font-size:var(--fs-body)}
.cal-day .cal-n{min-height:1.2em;font-size:var(--fs-meta);font-variant-numeric:tabular-nums;color:var(--ink-2)}
a.cal-day:hover{background:var(--accent-soft)}
.cal-day.off{color:var(--ink-3);opacity:.45;cursor:default}
.cal-day.zero .cal-n{color:var(--ink-3);opacity:.7}
.cal-day.today{border-color:var(--ink-3)}
.cal-day.current,.cal-day.current:hover{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.cal-day.current .cal-n{color:var(--accent-ink);opacity:1}
.cal-foot{display:flex;justify-content:flex-end;margin:var(--space-2) 0 0}
/* A card clips to its corners; a wide table scrolls in its own .table-wrap inside the card, away from them. */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--space-4);margin:0 0 var(--space-3);box-shadow:var(--shadow);min-width:0;overflow:hidden;--in-r:max(var(--r-xs), calc(var(--r-lg) - var(--space-4)))}
.pair-grid>*{min-width:0}
.card h2{margin:0 0 var(--space-1);font-size:var(--fs-title);font-weight:650}
.card h3{margin:var(--space-3) 0 var(--space-1);font-size:var(--fs-meta);font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--space-1) var(--space-4);margin:var(--space-2) 0 0;font-size:var(--fs-body)}
.kv dt{color:var(--ink-2)}
.kv dd{margin:0;overflow-wrap:anywhere}
.kv .plain-list{margin:2px 0;padding-left:16px;font-size:var(--fs-meta)}
.notice-list li{margin:0 0 4px}
.notice-list q{font-size:var(--fs-meta);color:var(--ink-2)}
.kv code,.mono{font-family:var(--font-mono);font-size:var(--fs-meta)}
/* A text area in a frame: the frame carries the border, the corners and the focus ring and clips; the text area
   inside scrolls (and resizes), inset from the corners. */
.text-frame{display:block;padding:var(--space-3) var(--space-1);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--in-r, var(--r-sm));overflow:hidden}
.text-frame:focus-within{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.text-frame>textarea{display:block;width:100%;min-width:0;max-width:100%;margin:0;padding:0 var(--space-2);border:0;border-radius:0;background:transparent;color:var(--ink)}
.text-frame>textarea:focus{outline:none}
/* The first-run steps on an empty Reports page. */
.onboard{max-width:760px}
.onboard-steps{list-style:none;margin:var(--space-3) 0 0;padding:0;display:flex;flex-direction:column;gap:var(--space-3)}
.onboard-step{display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:var(--space-3);align-items:center}
.onboard-num{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:700}
.onboard-step[data-done] .onboard-num{background:var(--accent);color:var(--accent-ink)}
.onboard-text h3{margin:0;font-size:var(--fs-body);font-weight:650;letter-spacing:0;text-transform:none;color:var(--ink)}
.onboard-text p{margin:2px 0 0}
@media (max-width:640px){.onboard-step{grid-template-columns:32px minmax(0,1fr)}.onboard-step .btn{grid-column:2}}
.row{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;margin-top:var(--space-3)}
.badge-good{background:var(--accent-soft);color:var(--accent)}
.badge-muted{background:var(--line);color:var(--ink-3)}
.file{position:relative;display:inline-flex;align-items:center;gap:var(--space-2)}
.file input[type=file]{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.file .file-name{font-size:var(--fs-meta);color:var(--ink-3);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.radio-row{display:flex;flex-wrap:wrap;gap:var(--space-3)}
.radio-row label{display:inline-flex;align-items:center;gap:6px}
.conn{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--space-2) var(--space-4);font-size:var(--fs-body)}
.conn dt{color:var(--ink-2)}.conn dd{margin:0}
.conn .badge{vertical-align:middle}
/* A settings group inside a card: the card's inner radius, and its own padding taken off for the fields in it. */
fieldset.group{min-inline-size:0;border:1px solid var(--line);border-radius:max(var(--r-xs), calc(var(--r-lg) - var(--space-4)));padding:var(--space-3) var(--space-4);margin:0 0 var(--space-3);--in-r:max(var(--r-xs), calc(max(var(--r-xs), calc(var(--r-lg) - var(--space-4))) - var(--space-4)))}
fieldset.group legend{font-size:var(--fs-meta);font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2);padding:0 var(--space-2)}
.field{display:block;margin:0 0 var(--space-3);font-size:var(--fs-body)}
.field>span{display:block;font-size:var(--fs-meta);color:var(--ink-2);margin-bottom:var(--space-1)}
.field input[type=text],.field input[type=number],.field input[type=email],.field select{font:inherit;font-size:var(--fs-body);line-height:1.3;color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--in-r, var(--r-sm));padding:var(--space-1) var(--space-2);min-height:var(--control-height);min-width:240px;max-width:100%;box-sizing:border-box}
.field select{appearance:none;-webkit-appearance:none;background-image:var(--chevron);background-repeat:no-repeat;background-position:right 9px center;padding-right:28px;cursor:pointer}
.field input:focus,.field select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.radio-row .badge{margin-left:4px}
.engine-warning{margin:var(--space-1) 0 0;font-size:var(--fs-meta);color:var(--warn-ink)}
.field label.check{display:inline-flex;align-items:center;gap:6px;margin-right:var(--space-3)}
.inline{display:inline}
.form-foot{font-size:var(--fs-meta);color:var(--ink-2);margin:var(--space-2) 0 0}
.tag-list{display:flex;flex-wrap:wrap;gap:4px;list-style:none;margin:var(--space-1) 0;padding:0}
.tag-add{max-width:22em}
table.plain{border-collapse:collapse;width:100%;font-size:var(--fs-body)}
table.plain th,table.plain td{text-align:left;padding:var(--space-2);border-bottom:1px solid var(--line);vertical-align:top}
table.plain th{font-size:var(--fs-meta);color:var(--ink-2);font-weight:650;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.table-scroll,.table-wrap{overflow-x:auto;max-width:100%}
table.letters-table td.nowrap,table.letters-table .nowrap{white-space:nowrap}
table.letters-table .mono{overflow-wrap:anywhere}
table.letters-table td.file{min-width:14em}
table.letters-table td.actions{white-space:nowrap}
table.letters-table td.actions .btn+.btn{margin-left:var(--space-1)}
/* A log: the frame carries the corners and clips; the log inside it scrolls, inset from the corners. */
.log-frame{background:var(--bg);border:1px solid var(--line);border-radius:var(--in-r, var(--r-md));padding:var(--space-3) var(--space-1);overflow:hidden;margin:var(--space-2) 0 0}
pre.log{padding:0 var(--space-2);max-height:336px;overflow:auto;font-family:var(--font-mono);font-size:var(--fs-meta);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
details.day{margin:var(--space-2) 0}
details.day>summary{cursor:pointer;font-size:var(--fs-body)}
.count-zero{color:var(--ink-3)}
.count-some{color:var(--warn-ink);font-weight:650}
.muted{color:var(--ink-2)}
[hidden]{display:none!important}
/* Between 761 and 1279px the navigation narrows to give the report's one-row bar its room. */
@media (min-width:761px) and (max-width:1279px){
  .hub{grid-template-columns:152px minmax(0,1fr)}
  .hub-main{padding:var(--space-4) var(--space-4) var(--space-6)}
  .hub-main .page{--gutter:var(--space-4)}
}
@media (max-width:760px){
  .hub{grid-template-columns:1fr}
  .hub-nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);flex-direction:row;flex-wrap:nowrap;align-items:center;gap:var(--space-1);padding:var(--space-2) var(--space-3);overflow-x:auto}
  .hub-nav .brand{display:none}
  .hub-nav a{flex:0 0 auto;margin:0;padding:var(--space-1) var(--space-2);border-bottom:2px solid transparent;border-radius:0}
  .hub-nav a.active{border-bottom-color:var(--accent);background:transparent}
  .hub-nav .mini{display:none}
  /* The month picker becomes a bottom sheet over a dimmed page (no blur on the bar: a filter would make the
     bar, not the viewport, the sheet's frame). */
  .toolbar.stuck{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--bg)}
  .cal{position:fixed;left:0;right:0;bottom:0;top:auto;width:auto;overflow:hidden;border-radius:var(--r-xl) var(--r-xl) 0 0;padding:var(--space-3) var(--space-2) 0;z-index:31;--in-r:max(var(--r-xs), calc(var(--r-xl) - var(--space-3) - var(--space-2)))}
  .cal-body{max-height:calc(85vh - var(--space-3));overflow:auto;padding:var(--space-2) var(--space-2) var(--space-5)}
  .cal-backdrop:not([hidden]){display:block;position:fixed;inset:0;z-index:30;background:rgba(16,24,40,.4)}
  .cal-day{min-height:48px}
  .hub-main{padding:var(--space-3) var(--space-3) var(--space-5)}
  .hub-main .page{--gutter:var(--space-3)}
  .kv{grid-template-columns:1fr;gap:0}
  .kv dt{margin-top:var(--space-2)}
  .conn{grid-template-columns:1fr;gap:0}
  .conn dt{margin-top:var(--space-2)}
  .badge{white-space:normal}
}
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
    var suffix = next.dataset.overdueSuffix || '';
    function tick() { var text = relative(); rel.textContent = text === 'overdue' ? text + suffix : text; rel.classList.toggle('overdue', text === 'overdue'); }
    tick();
    setInterval(tick, 60000);
  }
  // A run in progress: keep the elapsed time ticking too.
  var running = document.getElementById('running-elapsed');
  var since = next && next.dataset.since ? new Date(next.dataset.since).getTime() : null;
  if (running && since) {
    function elapsed() { var m = Math.max(0, Math.floor((Date.now() - since) / 60000)); if (m < 60) return m + 'm'; var h = Math.floor(m / 60); return h < 24 ? h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : Math.floor(h / 24) + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : ''); }
    setInterval(function () { running.textContent = elapsed(); }, 60000);
  }
})();
`;

function modelLabel(id) {
  return id ? modelShortName(id) : 'the assigned model';
}

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
  const suffix = sidebar.waitingOnQuota ? ' (waiting on quota)' : '';
  const relative = sidebar.nextRunAt ? formatRelativeTime(sidebar.nextRunAt, now) : '';
  const next = sidebar.running
    ? `<span id="next-run" data-running="1"${sidebar.runningSince ? ` data-since="${htmlEscape(sidebar.runningSince)}"` : ''}><span class="ok">Running</span>${sidebar.runningSince ? ` since ${htmlEscape(formatLocalShort(sidebar.runningSince, timeZone))} · <span class="rel" id="running-elapsed">${htmlEscape(formatElapsed(sidebar.runningSince, now))}</span>` : ''}</span>`
    : sidebar.nextRunAt
      ? `<span id="next-run" data-at="${htmlEscape(sidebar.nextRunAt)}" data-overdue-suffix="${htmlEscape(suffix)}">${htmlEscape(formatLocalShort(sidebar.nextRunAt, timeZone))} · <span class="rel${relative === 'overdue' ? ' overdue' : ''}">${htmlEscape(relative === 'overdue' ? `overdue${suffix}` : relative)}</span></span>`
      : '—';
  // Plan: one line per subscription ("Claude Max → Pro Oct 26", "ChatGPT Plus"); an expired Claude login
  // replaces the Claude line.
  const lines = sidebar.planLines || {};
  const claudeLine = sidebar.claudeAuth?.expired ? null : lines.claude && lines.claude.plan ? `<span data-plan="claude">${htmlEscape(lines.claude.sidebar)}</span>` : null;
  const chatgptLine = lines.chatgpt && lines.chatgpt.plan ? `<span data-plan="chatgpt">${htmlEscape(lines.chatgpt.sidebar)}</span>` : null;
  const planBlock = claudeLine || chatgptLine ? `<b>Plan</b>${[claudeLine, chatgptLine].filter(Boolean).join('<br>')}` : '';
  const auth = `${sidebar.claudeAuth?.expired ? '<b>Login</b><span class="bad" data-auth="expired">Claude signed out</span>' : ''}${planBlock}`;
  // One line per task (Review, Prescreen, CoverLetter): the model it would use now; a fallback is marked and
  // its hover names the model it stands in for and why.
  const models = (sidebar.models || []).slice(0, 3).map(item => {
    const title = item.fellBack ? `${item.label}: ${item.short} in place of ${modelLabel(item.from)} (${item.reason})` : item.reason ? `${item.label}: ${modelLabel(item.from)} (${item.reason})` : `${item.label}: ${item.model || item.short}`;
    return `<span class="model${item.fellBack || item.short === 'Unavailable' ? ' fallback' : ''}" data-model="${htmlEscape(item.key)}" title="${htmlEscape(title)}">${htmlEscape(item.label)} · ${htmlEscape(item.short)}</span>`;
  }).join('');
  const modelBlock = models ? `<b>Models</b>${models}` : '';
  return `<div class="mini"><b>Last Run</b>${last}<b>Next Run</b>${next}${auth}${modelBlock}</div>`;
}

export function renderHubPage({ active, title, content, notice = '', error = '', port, script = '', sidebar = null, timeZone, now = null }) {
  const nav = NAV.map(item => `<a href="${item.href}"${item.id === active ? ' class="active"' : ''}>${htmlEscape(item.label)}</a>`).join('');
  const flash = [
    notice ? `<div class="flash notice">${htmlEscape(notice)}</div>` : '',
    error ? `<div class="flash error">${htmlEscape(error)}</div>` : '',
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)} — ${htmlEscape(HUB_TITLE)}</title>
<link rel="stylesheet" href="${assetPath(`${REPORT_STYLES}${HUB_STYLES}${LETTER_STYLES}${MODEL_SETTINGS_STYLES}${OUTREACH_STYLES}`, 'css')}"></head>
<body><div class="hub"><nav class="hub-nav"><p class="brand">${htmlEscape(HUB_BRAND)}</p>${nav}${renderMiniStatus(sidebar, timeZone, now)}</nav>
<main class="hub-main"><div class="hub-content">${flash}${content}</div></main></div>
<script src="${assetPath(`${REPORT_SCRIPT}${HUB_SCRIPT}${script}`, 'js')}"></script>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------- reports

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function jobsLabel(count) {
  return `${count} ${count === 1 ? 'Job' : 'Jobs'}`;
}

// The days ‹ and › step through: a report with matches (an unknown count counts as matches).
export function datesWithMatches(dates) {
  return dates.filter(item => item.matchCount !== 0).map(item => item.date).sort();
}

// The previous and next report dates with matches around `selected` (null at either end).
export function neighborDates(dates, selected) {
  const days = datesWithMatches(dates);
  return { prev: days.filter(date => date < selected).at(-1) || null, next: days.find(date => date > selected) || null };
}

// One month of the date picker: a Sunday-first grid; a day with a report is a link with its match count under
// it (0 in light grey), a day without one is grey and not a link; today has a ring, the date on view is filled.
// data-prev / data-next name the nearest earlier and later months that have reports (empty at either end).
export function calendarMonth({ month, byDate, selected, today, timeZone, prev = '', next = '' }) {
  const [year, monthIndex] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const lead = new Date(Date.UTC(year, monthIndex - 1, 1)).getUTCDay();
  const cells = Array.from({ length: lead }, () => '<span class="cal-blank" aria-hidden="true"></span>');
  for (let day = 1; day <= days; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const item = byDate.get(date);
    const marks = [date === today ? 'today' : '', date === selected ? 'current' : ''];
    if (!item) {
      cells.push(`<span class="${['cal-day', 'off', ...marks].filter(Boolean).join(' ')}" aria-disabled="true" title="No Report"><span class="cal-d">${day}</span><span class="cal-n"></span></span>`);
      continue;
    }
    const count = item.matchCount;
    const classes = ['cal-day', count === 0 ? 'zero' : '', ...marks].filter(Boolean).join(' ');
    const label = `${formatLongDate(date, timeZone)}${count == null ? '' : ` · ${jobsLabel(count)}`}`;
    cells.push(`<a class="${classes}" href="/reports/${date}" data-keep-query data-date="${date}" aria-label="${htmlEscape(label)}"${date === selected ? ' aria-current="date"' : ''}><span class="cal-d">${day}</span><span class="cal-n">${count == null ? '' : Number(count)}</span></a>`);
  }
  return `<div class="cal-grid" data-month="${month}" data-label="${htmlEscape(formatMonthLabel(month, timeZone))}" data-prev="${prev}" data-next="${next}"${month === String(selected).slice(0, 7) ? '' : ' hidden'}>${cells.join('')}</div>`;
}

// The left end of the report's top row (2026-11-18, replacing the date column): ‹, the date (a button that opens
// the month picker), ›. ‹ and › go to the nearest report date with matches and are disabled at either end; the
// links keep the filter query (data-keep-query, REPORTS_SCRIPT). The picker lists only months with reports.
export function renderDateNav({ dates, selected, today, timeZone }) {
  const { prev, next } = neighborDates(dates, selected);
  const step = (date, id, label, glyph) => (date
    ? `<a class="date-step" id="${id}" href="/reports/${date}" data-keep-query aria-label="${label}" title="${label}: ${htmlEscape(formatLongDate(date, timeZone))}">${glyph}</a>`
    : `<button type="button" class="date-step" id="${id}" aria-label="${label}" title="${label}" disabled>${glyph}</button>`);
  const byDate = new Map(dates.map(item => [item.date, item]));
  const months = [...new Set(dates.map(item => item.date.slice(0, 7)))].sort();
  const current = String(selected).slice(0, 7);
  const grids = months.map((month, index) => calendarMonth({ month, byDate, selected, today, timeZone, prev: months[index - 1] || '', next: months[index + 1] || '' })).join('');
  const shown = months.indexOf(current);
  const jump = todayTarget([...dates].sort((a, b) => b.date.localeCompare(a.date)), today);
  const todayTitle = jump.isToday ? `Today's Report: ${formatLongDate(jump.date, timeZone)}` : `No Report for Today; Opens the Newest Report (${formatLongDate(jump.date, timeZone)})`;
  const calendar = `<div class="cal" id="calendar" role="dialog" aria-label="Choose Date" data-current="${current}" hidden><div class="cal-body">
<div class="cal-head"><button type="button" class="cal-step" id="cal-prev" aria-label="Previous Month"${shown > 0 ? '' : ' disabled'}>‹</button><span class="cal-title" id="cal-title">${htmlEscape(formatMonthLabel(current, timeZone))}</span><button type="button" class="cal-step" id="cal-next" aria-label="Next Month"${shown >= 0 && shown < months.length - 1 ? '' : ' disabled'}>›</button></div>
<div class="cal-week" aria-hidden="true">${WEEKDAYS.map(day => `<span>${day}</span>`).join('')}</div>${grids}
<div class="cal-foot"><a class="btn secondary cal-today" id="cal-today" href="/reports/${jump.date}" data-keep-query title="${htmlEscape(todayTitle)}">Today</a></div></div></div><div class="cal-backdrop" id="cal-backdrop" hidden></div>`;
  return `<span class="date-nav" id="date-nav">${step(prev, 'date-prev', 'Previous Day With Matches', '‹')}<span class="date-pick"><button type="button" class="bar-date date-button" id="date-button" aria-haspopup="dialog" aria-expanded="false" aria-controls="calendar">${htmlEscape(formatLongDate(selected, timeZone))}</button>${calendar}</span>${step(next, 'date-next', 'Next Day With Matches', '›')}</span>`;
}

// The date the "Today" shortcut and the default selection point at: today's report when it exists,
// otherwise the newest one.
export function todayTarget(dates, today) {
  const list = dates.map(item => (typeof item === 'string' ? item : item.date));
  if (today && list.includes(today)) return { date: today, isToday: true };
  return { date: list[0] || null, isToday: false };
}

// "Generate Missing Letters": every high match of the date without a letter and with a trusted company,
// written in the background under the letters lock; hidden when there is nothing to write.
// "Update Salutations" sits beside it whenever the date has saved letters: the salutation line and the file
// name move to the company's short name and the PDF is rendered again, with no engine call.
function updateSalutationsControl(selected, missing) {
  if (!missing?.letters || missing.running) return '';
  return `<form class="inline" method="post" action="/letters/update-salutations" id="update-salutations-form"><input type="hidden" name="date" value="${htmlEscape(selected)}"><button class="btn secondary small" type="submit" id="update-salutations" title="Use the company's short name in the salutation and the file name of every letter on this date and render the PDFs again. The letter bodies are not rewritten and no subscription quota is used.">Update Salutations (${Number(missing.letters)})</button></form>`;
}

function missingLettersControl(selected, missing) {
  if (!missing || (!missing.count && !missing.running)) return updateSalutationsControl(selected, missing);
  if (missing.running) return `<button class="btn small" type="button" id="missing-letters" disabled title="Cover letters are being written; the cards update as they finish">Writing Letters… ${Number(missing.done || 0)} of ${Number(missing.planned || 0)}</button>`;
  return `<form class="inline" method="post" action="/letters/missing" id="missing-letters-form"><input type="hidden" name="date" value="${htmlEscape(selected)}"><button class="btn small" type="submit" id="missing-letters" title="Write a letter for every high match on this date that has none and a trusted company name">Generate Missing Letters (${Number(missing.count)})</button></form>${updateSalutationsControl(selected, missing)}`;
}

// The secondary actions of a report date, in the top row's "⋯" menu: the letter passes, the Desktop copy and
// the workbook. The report body is cached per render key, so the menu (whose letter counts change between
// requests) is put into the body's slot here.
export function reportMenu({ selected, desktopPath, missingLetters }) {
  const items = [
    missingLettersControl(selected, missingLetters),
    `<a class="btn secondary small" href="/desktop/${selected}" target="_blank" rel="noopener noreferrer" title="${htmlEscape(desktopPath || '')}">Open Desktop Copy</a>`,
    `<a class="btn secondary small" href="/desktop/${selected}/xlsx" title="Download the Desktop workbook">Download XLSX</a>`,
  ].filter(Boolean);
  return `<details class="menu overflow" id="more-menu"><summary class="btn secondary" aria-label="More Actions" title="More Actions">⋯</summary><div class="menu-list">${items.join('')}</div></details>`;
}

// A hub with no report yet (a fresh clone): three steps, each with a button to where it is done. A step
// that is already done is marked; a hub with any report never shows this.
export function onboardingSteps({ resumesReady = false, rolesChosen = false } = {}) {
  const steps = [
    { id: 'resumes', title: 'Upload Resumes', text: 'Add one PDF per resume track; the text is extracted on this Mac.', href: '/resumes', done: resumesReady },
    { id: 'roles', title: 'Choose Roles', text: 'Pick the role families and title words to look for, and the words to leave out.', href: '/settings?tab=pipeline#role-scope', done: rolesChosen },
    { id: 'run', title: 'Run Now', text: 'Run the pipeline once; its report appears here, and the schedule takes over from then on.', href: '/status#run-card', done: false },
  ];
  const items = steps.map((step, index) => `<li class="onboard-step" data-step="${step.id}"${step.done ? ' data-done="1"' : ''}><span class="onboard-num" aria-hidden="true">${step.done ? '✓' : index + 1}</span><div class="onboard-text"><h3>${step.title}</h3><p class="muted">${step.text}</p></div><a class="btn${step.done ? ' secondary' : ''}" href="${step.href}">${step.title}</a></li>`).join('');
  return `<article class="card onboard" id="onboarding"><h2>Get Started</h2><p class="muted">No report yet. Three steps make this hub yours:</p><ol class="onboard-steps">${items}</ol></article>`;
}

// The report fills the width beside the navigation; its top row's date slot gets ‹ date › and the picker, and
// the "⋯" slot the secondary actions (both request-specific, so they are not in the cached body).
export function reportsPage({ dates, selected, reportBody, desktopPath, today, missingLetters = null, timeZone, onboarding = null }) {
  const body = reportBody
    ? `<div class="page">${reportBody.replace(DATE_SLOT, renderDateNav({ dates, selected, today, timeZone })).replace(MENU_SLOT, reportMenu({ selected, desktopPath, missingLetters }))}</div>`
    : !dates.length && onboarding ? onboardingSteps(onboarding)
    : `<p class="muted">${dates.length ? 'No report for this date.' : 'Run the pipeline once and its report will appear here.'}</p>`;
  // The Message to Recruiters drawer (src/hub/outreach-views.mjs), filled when a card's button is pressed.
  const drawer = reportBody ? '<aside class="reach-drawer" id="reach-drawer" hidden aria-label="Message to Recruiters"></aside>' : '';
  return `<section class="report-view">${body}</section>${drawer}`;
}

// The on-demand JD loader (see report.mjs lazyDescription); the rest of REPORTS_SCRIPT is unchanged.
export const JD_LOADER_SCRIPT = `
(function () {
  // A long Job Description arrives as its first 300 characters; opening it loads the full JD once
  // (GET /reports/<date>/jd/<card id>: markup the server already cleaned, src/jd-html.mjs).
  document.addEventListener('toggle', function (event) {
    var details = event.target;
    if (!details || !details.open || !details.matches || !details.matches('details.jd[data-jd-src]')) return;
    var src = details.getAttribute('data-jd-src');
    if (details.getAttribute('data-jd-loading')) return;
    details.setAttribute('data-jd-loading', '1');
    fetch(src, { headers: { accept: 'text/html' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (html) {
      details.querySelector('.jd-body').innerHTML = html;
      details.removeAttribute('data-jd-src');
      details.removeAttribute('data-jd-loading');
    }).catch(function () { details.removeAttribute('data-jd-loading'); });
  }, true);
})();
`;

// The top row's date controls (and a card's Check badge turning grey): ‹ / › and the picker's days keep the filter query when followed (the page
// script keeps the filters in the URL); ← and → step like ‹ and › unless a field has focus or the picker is
// open; the picker opens on the month on view, pages through months with reports, and closes on a click
// outside or Escape. The old date column's localStorage keys are removed once.
export const REPORTS_SCRIPT = JD_LOADER_SCRIPT + `
(function () {
  try { localStorage.removeItem('hub.reports.history'); localStorage.removeItem('hub.reports.onlyMatches'); } catch (e) {}
  function withQuery(link) { return link.pathname + location.search; }
  function keepQuery(event) {
    var link = event.target.closest && event.target.closest('a[data-keep-query]');
    if (link) link.setAttribute('href', withQuery(link));
  }
  document.addEventListener('click', keepQuery, true);
  document.addEventListener('auxclick', keepQuery, true);
  // Opening a letter page (the Check link or Open CoverLetter) greys that card's "Check N Details" at once; the
  // server records it too, so the next render agrees.
  function letterOpened(event) {
    var link = event.target.closest && event.target.closest('.job a[href^="/letters/"]');
    var card = link && link.closest('.job');
    var check = card && card.querySelector('.job-check');
    if (!check || link.pathname !== check.pathname) return;
    check.classList.remove('badge-warn');
    check.classList.add('badge-muted');
    check.setAttribute('data-seen', '1');
  }
  document.addEventListener('click', letterOpened);
  document.addEventListener('auxclick', letterOpened);
  var button = document.getElementById('date-button');
  var calendar = document.getElementById('calendar');
  var backdrop = document.getElementById('cal-backdrop');
  var title = document.getElementById('cal-title');
  var prevMonth = document.getElementById('cal-prev');
  var nextMonth = document.getElementById('cal-next');
  function isOpen() { return Boolean(calendar && !calendar.hidden); }
  function shownGrid() { return calendar.querySelector('.cal-grid:not([hidden])'); }
  function showMonth(month) {
    var target = month && calendar.querySelector('.cal-grid[data-month="' + month + '"]');
    if (!target) return;
    calendar.querySelectorAll('.cal-grid').forEach(function (grid) { grid.hidden = grid !== target; });
    title.textContent = target.getAttribute('data-label');
    prevMonth.disabled = !target.getAttribute('data-prev');
    nextMonth.disabled = !target.getAttribute('data-next');
  }
  function openCalendar() {
    showMonth(calendar.getAttribute('data-current'));
    calendar.hidden = false;
    if (backdrop) backdrop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    var focus = calendar.querySelector('.cal-grid:not([hidden]) [aria-current]') || calendar.querySelector('.cal-grid:not([hidden]) a');
    if (focus) focus.focus();
  }
  function closeCalendar(refocus) {
    if (!isOpen()) return;
    calendar.hidden = true;
    if (backdrop) backdrop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  }
  if (button && calendar) {
    button.addEventListener('click', function () { if (isOpen()) closeCalendar(false); else openCalendar(); });
    prevMonth.addEventListener('click', function () { var grid = shownGrid(); if (grid) showMonth(grid.getAttribute('data-prev')); });
    nextMonth.addEventListener('click', function () { var grid = shownGrid(); if (grid) showMonth(grid.getAttribute('data-next')); });
    document.addEventListener('click', function (event) {
      if (isOpen() && !calendar.contains(event.target) && !button.contains(event.target)) closeCalendar(false);
    });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen()) { closeCalendar(true); return; }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isOpen()) return;
    var target = event.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    var link = document.getElementById(event.key === 'ArrowLeft' ? 'date-prev' : 'date-next');
    if (!link || link.tagName !== 'A') return;
    event.preventDefault();
    location.href = withQuery(link);
  });
})();
`;

// ---------------------------------------------------------------------------------------------- resumes

function locationBadge(track) {
  const title = track.pdf ? ` title="${htmlEscape(track.pdf)}"` : '';
  if (track.managed) return `<span class="badge" data-badge="hub"${title}>Hub</span>`;
  if (track.onDesktop) return `<span class="badge" data-badge="desktop"${title}>On Desktop</span>`;
  if (track.pdf) return `<span class="badge badge-warn" data-badge="external"${title}>External File</span>`;
  return '<span class="badge badge-bad" data-badge="no-pdf">No PDF Configured</span>';
}

function trackCard(track, timeZone) {
  const enabled = track.enabled
    ? '<span class="badge badge-good" data-badge="enabled">Enabled</span>'
    : '<span class="badge badge-muted" data-badge="disabled">Disabled</span>';
  const rows = [];
  rows.push(`<dt>PDF</dt><dd>${track.pdf ? `<span class="mono" title="${htmlEscape(track.pdf)}">${htmlEscape(track.pdfName)}</span>${track.pdfExists ? '' : ' <span class="badge badge-bad" data-badge="missing">File Not Found</span>'}` : '—'}</dd>`);
  if (track.uploadedAt) rows.push(`<dt>Last Upload</dt><dd>${htmlEscape(formatLocalDateTime(track.uploadedAt, timeZone))}</dd>`);
  if (track.extraction) {
    rows.push(`<dt>Text Extraction</dt><dd>${track.extraction.ok ? `${formatCount(track.extraction.characters)} characters (checked ${htmlEscape(formatLocalDateTime(track.extraction.checkedAt, timeZone))})` : `Failed: ${htmlEscape(track.extraction.error)}`}</dd>`);
  }
  rows.push(`<dt>Profile</dt><dd>${track.profile.exists
    ? `<span title="${htmlEscape(track.profile.path)}">Profile synced${track.lastSync ? ` ${htmlEscape(formatLocalDay(track.lastSync, timeZone))}` : ''} · ${formatCount(track.profile.characters)} characters</span>`
    : `<span class="muted" title="${htmlEscape(track.profile.path)}">Profile not extracted yet; the next nightly run creates it</span>`}</dd>`);
  const versions = track.versions.length
    ? `<h3>Kept Versions</h3><div class="table-wrap"><table class="plain"><tr><th>File</th><th>Uploaded</th><th>Size</th><th></th></tr>${track.versions.map(version => `<tr><td><span class="mono" title="${htmlEscape(version.path)}">${htmlEscape(version.name)}</span>${version.path === track.pdf ? ' <span class="badge badge-good" data-badge="current">Current</span>' : ''}</td><td>${htmlEscape(formatLocalDateTime(version.modifiedAt, timeZone))}</td><td>${Math.round(version.size / 1024)} KB</td><td>${version.path === track.pdf ? '' : `<form class="inline" method="post" action="/resumes/select"><input type="hidden" name="trackId" value="${htmlEscape(track.id)}"><input type="hidden" name="file" value="${htmlEscape(version.name)}"><button class="btn secondary small" type="submit">Use This Version</button></form>`}</td></tr>`).join('')}</table></div>`
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
      <label class="field"><span>Label Shown in Reports</span><input type="text" name="label" class="control-input" required></label>
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
    ? `<div class="log-frame"><pre class="log">${htmlEscape(day.warningsText)}</pre></div>`
    : `<p class="muted">No warnings.txt for this date${day.count ? ' (the folder may have been moved)' : ''}.</p>`;
  const count = `<span class="${day.count ? 'count-some' : 'count-zero'}">${day.count} Warning${day.count === 1 ? '' : 's'}</span>`;
  return `<details class="day"><summary>${htmlEscape(formatDateLabel(day.date))} · ${count}${day.matchCount != null ? ` <span class="muted">· ${day.matchCount} Match${day.matchCount === 1 ? '' : 'es'}</span>` : ''}</summary>${body}</details>`;
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
  if (row.dormant) notes.push(`<span class="badge badge-bad" data-badge="dormant" title="${htmlEscape(row.error || '')}">Dormant</span> <form class="inline" method="post" action="/status/sources/resume"><input type="hidden" name="board" value="${htmlEscape(row.key)}"><button class="btn secondary small" type="submit">Resume Polling</button></form>${row.nextProbeAt ? ` <span class="muted" data-next-probe="${htmlEscape(row.nextProbeAt)}">Next probe ${htmlEscape(formatLocalDateTime(row.nextProbeAt, timeZone))}${row.lastProbeAt ? ` · last probe ${htmlEscape(formatLocalDay(row.lastProbeAt, timeZone))}: ${htmlEscape(row.lastProbeResult || 'failed')}` : ''}</span>` : ''}`);
  else if (row.outage) notes.push(`<span class="badge badge-muted" data-badge="outage" title="This Mac's network was down during the run; not counted as a failure">Network Outage</span> <span class="muted">${htmlEscape(row.outage)}</span>`);
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
    : `${htmlEscape(quota.effectiveEngine)} · ${htmlEscape(quota.effectiveModel || 'default')}${quota.effectiveModel && quota.configuredModel && quota.effectiveModel !== quota.configuredModel ? ` <span class="badge badge-warn" data-badge="downgraded">Downgraded From ${htmlEscape(quota.configuredModel)}</span>` : ''}`;
  return `<article class="card" id="quota-card"><h2>Quota</h2><dl class="kv">
    <dt>Last Limit Event</dt><dd id="quota-last">${event}</dd>
    <dt>Plan</dt><dd id="quota-plan">${quota.plans?.claude ? `Claude · ${htmlEscape(planLabel(quota.plans.claude))}` : '<span class="muted">Claude plan unknown</span>'}${quota.plans?.codex ? ` · Codex · ${htmlEscape(planLabel(quota.plans.codex))}` : ''}${quota.modelAvailability?.unavailable?.length ? ` · <span class="badge badge-warn" data-badge="unavailable-models">Unavailable: ${htmlEscape(quota.modelAvailability.unavailable.join(', '))}</span>` : ''}</dd>
    <dt>Model in Effect</dt><dd id="quota-model">${effective}</dd>
    <dt>Deferred Postings</dt><dd id="quota-deferred">${Number(quota.deferredCount || 0)} waiting for the next run${quota.deferredByQuota ? ` · ${Number(quota.deferredByQuota)} of them because of a limit` : ''}</dd>
    <dt>Policy</dt><dd>Ladder ${htmlEscape((quota.modelLadder || []).join(' → '))} · ${quota.fallbackEngine ? `Codex fallback on` : 'no engine fallback'}</dd>
    ${usageRows(quota.usage)}
    ${noticeRows(quota.notices, timeZone)}
    ${quota.budgetHistory?.length ? `<dt>Candidates vs Budget</dt><dd id="quota-history">${quota.budgetAlert ? `<span class="badge badge-warn" data-badge="budget-alert">Over Budget ${Number(quota.budgetAlert.nights)} Nights Running</span> <span class="muted">Raise Max Reviewed Per Run or tighten the prefilter.</span><br>` : ''}<span class="mono">${quota.budgetHistory.map(entry => `${htmlEscape(entry.date)} ${Number(entry.inWindow)}/${Number(entry.limit) || '∞'}`).join(' · ')}</span> <span class="muted">(in-window candidates / budget, last ${quota.budgetHistory.length} nights${quota.expiredBacklogCount ? `; ${Number(quota.expiredBacklogCount)} backlog postings expired last run` : ''})</span></dd>` : ''}
  </dl></article>`;
}

// The CLI's own words for the latest limit events (sanitized, 300 characters), newest first, so the
// classification can be checked against what the CLI actually said.
function noticeRows(notices, timeZone) {
  if (!notices?.length) return '';
  const items = notices.map(notice => `<li data-notice-kind="${htmlEscape(notice.kind || '')}"><span class="muted">${htmlEscape(formatLocalDateTime(notice.at, timeZone))} · ${htmlEscape(notice.source)} · ${htmlEscape(notice.kind || 'unclassified')}${notice.model ? ` · ${htmlEscape(notice.model)}` : ''}${notice.action ? ` · ${htmlEscape(notice.action)}` : ''}</span><br><q>${htmlEscape(notice.text)}</q></li>`).join('');
  return `<dt>CLI Notices</dt><dd id="quota-notices"><ul class="plain-list notice-list">${items}</ul></dd>`;
}

// Subscription usage over the last seven nights: totals by full model id and by purpose, and one figure
// per night (input + output tokens, cache reads shown separately in the totals).
function usageRows(usage) {
  if (!usage) return '';
  if (!usage.total?.calls) return `<dt>Usage (7 days)</dt><dd id="quota-usage"><span class="muted">No subscription calls recorded in the last ${Number(usage.days || 7)} days.</span></dd>`;
  const models = Object.entries(usage.byModel || {}).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))
    .map(([model, totals]) => `<li data-usage-model="${htmlEscape(model)}"><span class="mono">${htmlEscape(model)}</span>${totals.effort ? ` <span class="muted">(${htmlEscape(totals.effort)} effort)</span>` : ''}: ${htmlEscape(describeTotals(totals))}</li>`).join('');
  const purposes = USAGE_PURPOSES.filter(purpose => usage.byPurpose?.[purpose])
    .map(purpose => `<li data-usage-purpose="${purpose}">${purpose}: ${htmlEscape(describeTotals(usage.byPurpose[purpose]))}</li>`).join('');
  const nights = (usage.nights || []).map(night => `${htmlEscape(night.date.slice(5))} ${htmlEscape(formatTokens(night.input + night.output))}`).join(' · ');
  return `<dt>Usage (7 days)</dt><dd id="quota-usage">${htmlEscape(describeTotals(usage.total))}<ul class="plain-list">${models}</ul><ul class="plain-list">${purposes}</ul><span class="mono" id="quota-usage-nights">${nights}</span> <span class="muted">(input + output tokens per night)</span></dd>`;
}

// The automatic cover-letter pass after the latest run: running or finished, counts, engines, and usage.
// The last 7 days' repetition: the most shared opening and closing, and "I am writing to" against its limit.
function letterVarietyCard(variety) {
  if (!variety) return '';
  const quote = entry => (entry ? ` · "${htmlEscape(entry.text)}"` : '');
  const rows = variety.total
    ? `<dt>Letters</dt><dd>${variety.total} in the last ${variety.days} days (rules ${htmlEscape(variety.rulesVersion)})</dd>
      <dt>Opening Repetition</dt><dd id="opening-repetition">${percent(variety.topOpening?.share)}${quote(variety.topOpening)}</dd>
      <dt>Closing Repetition</dt><dd id="closing-repetition">${percent(variety.topClosing?.share)}${quote(variety.topClosing)}</dd>
      <dt>"I Am Writing To" Openings</dt><dd>${percent(variety.writingToShare)} (${variety.openingStyle === 'ban-writing-to' ? 'banned' : 'limit 30%'})</dd>`
    : '<dt>Letters</dt><dd>None in the last 7 days</dd>';
  return `<article class="card" id="letter-variety"><h2>Letter Variety</h2><dl class="kv">${rows}</dl><p class="form-foot">Openings and closing sentences used by more than 15 percent of these letters are passed to the next letter to avoid (v2 rules).</p></article>`;
}

function autoLettersCard(auto, timeZone) {
  if (!auto) return '';
  const settings = auto.settings || {};
  const config = `${settings.enabled === false ? 'Off' : Number(settings.maxPerRun || 0) > 0 ? `On · up to ${Number(settings.maxPerRun)} per run` : 'On · every new high match'} <a href="/settings?tab=letters#auto-letters">Settings</a>`;
  if (!auto.date) return `<article class="card" id="auto-letters-card"><h2>Automatic Cover Letters</h2><dl class="kv"><dt>Setting</dt><dd>${config}</dd><dt>Last Pass</dt><dd><span class="muted">None yet</span></dd></dl></article>`;
  const state = auto.running ? `<span class="badge badge-good" data-badge="letters-running">Running</span> ${Number(auto.done)} of ${Number(auto.planned)} done` : auto.state === 'stopped' ? '<span class="badge badge-warn" data-badge="letters-stopped">Stopped</span>' : auto.state === 'interrupted' ? '<span class="badge badge-warn" data-badge="letters-interrupted">Interrupted</span>' : '<span class="badge badge-muted" data-badge="letters-done">Done</span>';
  const skipped = auto.skipped ? [auto.skipped.existing ? `${auto.skipped.existing} already had a letter` : '', auto.skipped.uncertain ? `${auto.skipped.uncertain} with an uncertain company` : '', auto.skipped.overLimit ? `${auto.skipped.overLimit} over the per-run limit` : '', auto.skipped.termConflict ? `${auto.skipped.termConflict} with a term conflict` : ''].filter(Boolean).join(' · ') : '';
  const usage = auto.usage?.calls ? describeTotals(auto.usage) : '—';
  return `<article class="card" id="auto-letters-card"><h2>Automatic Cover Letters</h2><dl class="kv">
    <dt>Setting</dt><dd>${config}</dd>
    <dt>Last Pass</dt><dd>${state} · ${htmlEscape(auto.date)} · ${htmlEscape(formatLocalDateTime(auto.finishedAt || auto.startedAt, timeZone))}</dd>
    <dt>Letters</dt><dd id="auto-letters-counts">${Number(auto.generated)} generated · ${Number(auto.failed)} failed${auto.carriedOver ? ` · ${Number(auto.carriedOver)} from the queue` : ''}${skipped ? ` <span class="muted">(skipped: ${htmlEscape(skipped)})</span>` : ''}${auto.queued ? `<br><span class="muted">${Number(auto.queued)} queued for the next run or Run Now</span>` : ''}</dd>
    <dt>Engines</dt><dd>${auto.engines?.length ? htmlEscape(auto.engines.join('; ')) : '<span class="muted">—</span>'}</dd>
    <dt>Usage</dt><dd>${htmlEscape(usage)}</dd>
    ${auto.stopReason ? `<dt>Stopped</dt><dd>${htmlEscape(auto.stopReason)}</dd>` : ''}
  </dl></article>`;
}

function sourcesCard(rows, timeZone) {
  const body = rows.length
    ? `<div class="table-wrap"><table class="plain" id="sources-table"><tr><th>Source</th><th>Enabled</th><th>Last Success</th><th>New This Run</th><th>Status</th></tr>${rows.map(row => sourceRow(row, timeZone)).join('')}</table></div>`
    : '<p class="muted">No sources configured.</p>';
  const boards = rows.filter(row => row.kind !== 'builtin');
  const summary = boards.length
    ? `<p class="muted" id="sources-summary">${boards.length} ATS board${boards.length === 1 ? '' : 's'} · ${boards.filter(row => row.quiet && !row.dormant).length} quiet (polled weekly) · ${boards.filter(row => row.dormant).length} dormant · ${boards.filter(row => !row.enabled).length} disabled</p>`
    : '';
  return `<article class="card" id="sources-card"><h2>Sources</h2><p class="muted">Built-in lists and every public ATS board discovered from posting URLs. A board with no new posting for 30 days is polled weekly; one that fails seven nights in a row goes dormant and is probed every 30 days, resuming on its own once it answers (or when you resume it).</p>${summary}${body}</article>`;
}

// The Runs card's Catch-up line: an incomplete run (cut short by the network) and what the hub's
// 10-minute check is doing about it.
function catchUpLine(view, at) {
  if (!view) return '—';
  const parts = [];
  const record = view.record;
  if (record) parts.push(`<span class="badge badge-warn" data-badge="incomplete">Incomplete</span> The run of ${htmlEscape(record.date)} was cut short at ${at(record.at)}: ${htmlEscape(record.detail || record.reason || 'network outage')}`);
  if (!view.enabled) {
    parts.push(`<span class="muted">Auto catch-up after network outage is off (<a href="/settings?tab=pipeline">Settings → Pipeline</a>).</span>`);
    return parts.join('<br>');
  }
  if (record) parts.push(`<span class="muted">Auto catch-up: ${Number(view.attempts || 0)} of ${Number(view.maximumAttempts || 2)} used${view.nextCheckAt ? ` · next check ${at(view.nextCheckAt)}` : ''}${view.lastCheck?.reason ? ` · last check: ${htmlEscape(view.lastCheck.reason)}` : ''}</span>`);
  else {
    parts.push(`Nothing to catch up${view.nextCheckAt ? ` <span class="muted">· next check ${at(view.nextCheckAt)}</span>` : ''}`);
    if (view.resolved?.resolvedAt) parts.push(`<span class="muted">The ${htmlEscape(view.resolved.date)} outage was made up at ${at(view.resolved.resolvedAt)}${view.resolved.resolvedBy ? ` (${htmlEscape(view.resolved.resolvedBy)})` : ''}.</span>`);
  }
  return parts.join('<br>');
}

// The Runs card's Backup line: the newest zip (src/backup.mjs) and where they go.
function backupLine(view, at) {
  if (!view) return '—';
  const where = `<span class="muted" title="${htmlEscape(view.directory)}">${Number(view.count)} kept · nightly after the scheduled run · <code>npm run backup</code></span>`;
  if (!view.latest) return `No backup yet <span class="muted" title="${htmlEscape(view.directory)}">· nightly after the scheduled run · <code>npm run backup</code></span>`;
  return `${at(view.latest.modifiedAt)} · ${htmlEscape(formatBytes(view.latest.bytes))} <span class="muted">·</span> ${where}`;
}

// The integrity banner (src/state-integrity.mjs): seen state lost most of its entries, state.json read from
// a backup, or a state file that does not parse.
function integrityBanner(view, at) {
  if (!view) return '';
  const lines = [];
  if (view.message) lines.push(htmlEscape(view.message));
  if (view.stateRestored) lines.push(view.stateRestored.none
    ? 'state/state.json does not parse and no backup could be read; the next run starts from an empty state.'
    : `state/state.json does not parse; showing its backup ${htmlEscape(view.stateRestored.from ? view.stateRestored.from.split('/').at(-1) : '')}${view.stateRestored.at ? ` (${at(view.stateRestored.at)})` : ''}. The next run restores it.`);
  for (const file of view.corrupt || []) lines.push(`state/${htmlEscape(file.name)} does not parse (${htmlEscape(file.error || 'invalid JSON')}).`);
  return lines.length ? `<div class="flash error" data-banner="integrity">${lines.join('<br>')}</div>` : '';
}

export function statusPage({ status, timeZone }) {
  const { lastRun, nextRun, lock, runNow, run } = status;
  const at = value => htmlEscape(formatLocalDateTime(value, timeZone));
  const lockLine = lock.locked
    ? `<span title="${htmlEscape(lock.path)}">Held by PID ${lock.pid}</span>`
    : (lock.stale ? `Stale lock from PID ${lock.pid ?? '?'}; the next run clears it` : 'Free');
  const errors = status.errors.length
    ? `<div class="table-wrap"><table class="plain"><tr><th>File</th><th>Written</th></tr>${status.errors.map(item => `<tr><td><a href="/status/error/${htmlEscape(item.name)}" title="${htmlEscape(item.path)}">${htmlEscape(item.name)}</a></td><td>${at(item.modifiedAt)}</td></tr>`).join('')}</table></div>`
    : '<p class="muted">No ERROR-*.html files in the output directory.</p>';
  const runState = run.running ? 'running' : (run.startedAt ? 'finished' : 'idle');
  const lastRunLine = lastRun.at
    ? `${at(lastRun.at)}${lastRun.trigger ? ` · ${htmlEscape(lastRun.trigger)}` : ''} · ${htmlEscape(lastRun.result)}${lastRun.matchCount != null ? ` · ${lastRun.matchCount} match${lastRun.matchCount === 1 ? '' : 'es'}` : ''}${lastRun.date ? ` · <a href="/reports/${lastRun.date}">report</a>` : ''}`
    : 'No run yet';
  const running = status.running || { running: false };
  const nextRunLine = running.running
    ? `<span class="badge badge-good" data-badge="running">Running</span>${running.since ? ` since ${at(running.since)} · ${htmlEscape(formatElapsed(running.since, status.now))} so far` : ''}${running.pid ? ` <span class="muted">(PID ${running.pid})</span>` : ''}${nextRun.at ? `<br><span class="muted">Next scheduled ${at(nextRun.at)}</span>` : ''}`
    : nextRun.at
      ? `${at(nextRun.at)}${status.overdue ? ` <span class="badge badge-bad" data-badge="overdue">Overdue${status.waitingOnQuota ? ' (Waiting on Quota)' : ''}</span>` : status.dueNow ? ' <span class="badge badge-warn" data-badge="due-now">Due Now</span>' : ''}${nextRun.installed ? '' : ` <span class="badge badge-warn" data-badge="not-installed">LaunchAgent Not Installed</span> <span class="muted">showing the ${scheduleClock(DEFAULT_SCHEDULE)} default</span>`}`
      : '—';
  const authBanner = status.claudeAuth?.expired
    ? `<div class="flash error" data-banner="auth-expired">Claude signed out. Run <code>claude auth login --claudeai</code> in Terminal, then Refresh. Until then the nightly review goes to Codex when a ChatGPT model ends Scoring's fallback chain and Codex is signed in; otherwise the postings wait for the next run.${status.claudeAuth.at ? ` <span class="muted">Seen ${at(status.claudeAuth.at)}${status.claudeAuth.source ? ` (${htmlEscape(status.claudeAuth.source)})` : ''}.</span>` : ''} <form class="inline" method="post" action="/settings/connections/refresh"><input type="hidden" name="back" value="status"><button class="btn secondary small" type="submit">Refresh</button></form></div>`
    : '';
  const planBanner = status.planChange
    ? `<div class="flash notice" data-banner="plan-change">${htmlEscape(status.planChange.message)} <a href="/settings">Review Settings</a>${status.claudeAuth?.expired ? ' <span class="muted">If the plan did not actually change, run <code>claude auth login --claudeai</code> to refresh the login.</span>' : ''}</div>`
    : '';
  return `<h1 class="hub-title">Status</h1>
  ${integrityBanner(status.integrity, at)}${planBanner}
  ${authBanner}
  <article class="card"><h2>Runs</h2><dl class="kv">
    <dt>Last Run</dt><dd>${lastRunLine}</dd>
    <dt>Engine</dt><dd>${lastRun.engine ? `${htmlEscape(lastRun.engine)}${lastRun.scoringModel ? ` · ${htmlEscape(lastRun.scoringModel)}` : ''}` : (lastRun.scoringModel ? htmlEscape(lastRun.scoringModel) : '—')}</dd>
    ${lastRun.funnel ? `<dt>Funnel</dt><dd id="status-funnel">${htmlEscape(funnelText(lastRun.funnel))}${lastRun.stageUsage ? `<br><span class="muted">${htmlEscape(lastRun.stageUsage)}</span>` : ''}</dd>` : ''}
    ${lastRun.prescreen ? `<dt>Prescreen</dt><dd id="status-prescreen">${htmlEscape(describePrescreen(lastRun.prescreen))}${lastRun.prescreenOverview?.mode === 'shadow' ? `<br><span class="muted">Shadow period: ${Number(lastRun.prescreenOverview.shadowRunsDone)} of ${Number(lastRun.prescreenOverview.shadowRuns)} nights · ${htmlEscape(recallText(lastRun.prescreenOverview.finalMatches, lastRun.prescreenOverview.lost))} · <a href="/settings?tab=pipeline#prescreen">Settings</a></span>` : ''}</dd>` : ''}
    ${lastRun.candidateCount != null ? `<dt>Review Budget</dt><dd>${Number(lastRun.candidateCount)} candidates · ${Number(lastRun.reviewedThisRun || 0)} reviewed · ${Number(lastRun.deferredCount || 0)} deferred${Number(lastRun.maxReviewedPerRun) > 0 ? ` · limit ${Number(lastRun.maxReviewedPerRun)} per run` : ' · no limit'}</dd>` : ''}
    <dt>Next Run</dt><dd>${nextRunLine}</dd>
    <dt>Catch-up</dt><dd id="catch-up-line">${catchUpLine(status.autoCatchUp, at)}</dd>
    <dt>Lock</dt><dd id="lock-line">${lockLine}</dd>
    <dt>Backup</dt><dd id="backup-line">${backupLine(status.backup, at)}</dd>
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
    <div class="log-frame"><pre class="log" id="run-tail">${htmlEscape(run.tail.join('\n'))}</pre></div>
    </div>
  </article>
  ${quotaCard(status.quota, timeZone)}
  ${autoLettersCard(status.autoLetters, timeZone)}
  ${letterVarietyCard(status.letterVariety)}
  ${sourcesCard(status.sources || [], timeZone)}
  <article class="card"><h2>Warnings</h2><p class="muted">Last 7 report dates.</p>${status.days.length ? status.days.map(dayRow).join('') : '<p class="muted">No reports yet.</p>'}</article>
  <article class="card"><h2>Error Reports</h2>${errors}</article>
  ${hubCard(status.hub, timeZone)}`;
}

// Hub card: the last Reports page requests with their stage timings, sizes, and render-cache result.
function hubCard(hub, timeZone) {
  if (!hub) return '';
  const rows = (hub.timings || []).map(record => `<tr><td>${htmlEscape(formatLocalDateTime(record.at, timeZone))}</td><td class="mono">${htmlEscape(record.path)}</td><td>${record.notModified ? '304' : Number(record.status)}</td><td>${Number(record.totalMs)} ms</td><td>${htmlEscape(phasesText(record.phases) || '—')}</td><td>${record.notModified ? '—' : `${htmlEscape(formatBytes(record.bytes))}${record.encodedBytes != null ? ` <span class="muted">(gzip ${htmlEscape(formatBytes(record.encodedBytes))})</span>` : ''}`}</td><td>${htmlEscape(record.cache || '—')}</td></tr>`).join('');
  const cache = hub.cache || {};
  const last = cache.invalidations?.[0];
  const cacheLine = `${Number(cache.renderHits || 0)} hit(s), ${Number(cache.renderMisses || 0)} miss(es) · ${Number(cache.renders || 0)} render(s) and ${Number(cache.days || 0)} day(s) held${last ? ` · last cleared ${htmlEscape(formatLocalDateTime(last.at, timeZone))} (${htmlEscape(last.reason)})` : ''}`;
  return `<article class="card" id="hub-card"><h2>Hub</h2>
  <p class="muted">Reports and Status page requests since the hub started (newest first; also in the hub log). Stages: reports index, payload read, eligibility and location re-check, letter status scan, Status summary and the rest of the Status data, HTML render, sidebar.</p>
  <dl class="kv"><dt>Render Cache</dt><dd id="hub-cache">${cacheLine}</dd></dl>
  ${rows ? `<div class="table-wrap"><table class="plain" id="hub-timings"><tr><th>When</th><th>Page</th><th>Status</th><th>Total</th><th>Stages</th><th>Size</th><th>Cache</th></tr>${rows}</table></div>` : '<p class="muted" id="hub-timings">No Reports or Status requests yet.</p>'}
</article>`;
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

export function connectionRow(name, engine, item) {
  if (!item) return `<dt>${htmlEscape(name)}</dt><dd><span class="muted">Not checked</span></dd>`;
  const stale = item.configuredMissing && item.configured ? ` <span class="badge badge-warn" data-conn="stale-config" title="config points at ${htmlEscape(item.configured)}, which does not exist">Config Path Missing</span>` : '';
  const where = item.path ? `<br><span class="muted mono" title="${htmlEscape((item.searched || []).join('\n'))}">${htmlEscape(item.path)}${item.source === 'config' ? ' (from config)' : ''}</span>${stale}` : '';
  const savePath = item.path && item.source !== 'config'
    ? `<form class="inline" method="post" action="/settings/cli-path"><input type="hidden" name="engine" value="${engine}"><input type="hidden" name="path" value="${htmlEscape(item.path)}"><button class="btn secondary small" type="submit">Save This Path to Config</button></form>`
    : '';
  if (!item.installed) {
    return `<dt>${htmlEscape(name)}</dt><dd><span class="badge badge-muted" data-conn="missing">Not Found on This Mac</span> <span class="muted">Install with <code>${htmlEscape(item.hint)}</code>${item.configured ? `; config points at <code>${htmlEscape(item.configured)}</code>` : ''}</span><br><span class="muted" title="${htmlEscape((item.searched || []).join('\n'))}">Searched PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin, and nvm.</span></dd>`;
  }
  if (item.sessionExpired || item.signedOut) return `<dt>${htmlEscape(name)}</dt><dd><span class="badge badge-bad" data-conn="expired">Signed out</span> <span class="muted">Run <code>claude auth login --claudeai</code> in Terminal, then Refresh.</span>${item.reason ? `<br><span class="muted">${htmlEscape(item.reason)}</span>` : ''}${where}</dd>`;
  if (item.connected) return `<dt>${htmlEscape(name)}</dt><dd><span class="badge badge-good" data-conn="connected">Connected</span> ${htmlEscape(item.detail)}${where}${savePath ? ` ${savePath}` : ''}</dd>`;
  return `<dt>${htmlEscape(name)}</dt><dd><span class="badge badge-warn" data-conn="disconnected">Not Connected</span> <span class="muted">Sign in from a terminal: <code>${htmlEscape(item.hint)}</code></span>${item.reason ? `<br><span class="muted">${htmlEscape(item.reason)}</span>` : ''}${where}${savePath ? ` ${savePath}` : ''}</dd>`;
}

function engineBadge(item) {
  if (!item) return '';
  if (item.sessionExpired || item.signedOut) return '<span class="badge badge-bad" data-engine-state="expired">Signed out</span>';
  if (item.connected) return '<span class="badge badge-good" data-engine-state="connected">Connected</span>';
  if (!item.installed) return '<span class="badge badge-muted" data-engine-state="missing">Not Found</span>';
  return '<span class="badge badge-warn" data-engine-state="disconnected">Not Connected</span>';
}

// Settings in three tabs: Subscriptions & Models (subscription cards, model tables, task assignments),
// Pipeline (matching, reports, hub), and Cover Letters (contact block, playbook, sample letters).
// The prescreen: on/off, threshold, and the shadow period. Enforcing needs the owner's confirmation here
// after the shadow nights; until then the checkbox is disabled and nothing is ever dropped.
function prescreenSettingsCard(prescreen) {
  if (!prescreen) return '';
  const done = Number(prescreen.shadowRunsDone || 0);
  const mode = prescreen.mode === 'enforced' ? '<span class="badge badge-good" data-badge="prescreen-enforced">Enforced</span>' : prescreen.mode === 'off' ? '<span class="badge badge-muted" data-badge="prescreen-off">Off</span>' : `<span class="badge badge-warn" data-badge="prescreen-shadow">Shadow</span> ${Math.min(done, prescreen.shadowRuns)} of ${Number(prescreen.shadowRuns)} nights`;
  const recall = prescreen.finalMatches ? `${Math.round(prescreen.recall * 100)}% (${prescreen.lost} of ${prescreen.finalMatches} final matches would have been dropped)` : 'no final matches recorded yet';
  const enforceNote = prescreen.canEnforce ? 'The shadow period is complete; check the recall above before enforcing.' : `Available after ${Number(prescreen.shadowRuns)} shadow nights (${done} done).`;
  return `<article class="card" id="prescreen"><h2>Prescreen</h2>
  <p class="muted">A light model scores every candidate against short resume digests before the final review. The final review's model, rubric, and thresholds do not change.</p>
  <dl class="kv"><dt>Mode</dt><dd id="prescreen-mode">${mode}</dd><dt>Shadow Recall</dt><dd id="prescreen-recall">${htmlEscape(recall)}</dd></dl>
  <form method="post" action="/settings/prescreen" id="prescreen-form">
    <div class="field"><label class="check"><input type="checkbox" name="enabled"${prescreen.enabled ? ' checked' : ''}> Run the Prescreen</label></div>
    <label class="field"><span>Prescreen Threshold (0–100)</span><input type="number" name="threshold" class="control-input" min="0" max="100" step="1" value="${Number(prescreen.threshold)}" required></label>
    <div class="field"><label class="check"><input type="checkbox" name="enforce"${prescreen.enforce ? ' checked' : ''}${prescreen.canEnforce || prescreen.enforce ? '' : ' disabled'}> Enforce: skip postings below the threshold (marked seen, listed in Run Details)</label><span class="muted">${htmlEscape(enforceNote)}</span></div>
    <button class="btn" type="submit">Save Prescreen</button>
  </form></article>`;
}

// An editable tag list: one hidden field per tag (× removes it) and an add box (Enter or a comma adds a
// tag; text left in the box is still saved, split on commas, so the form works without the script).
function tagEditor(name, tags, { label, hint, placeholder }) {
  const items = tags.map(tag => `<li class="tag" data-tag="${htmlEscape(tag)}"><span>${htmlEscape(tag)}</span><input type="hidden" name="${name}" value="${htmlEscape(tag)}"><button type="button" class="tag-x" aria-label="Remove ${htmlEscape(tag)}">×</button></li>`).join('');
  return `<div class="field tag-edit" data-name="${name}" id="${name}-editor"><span>${htmlEscape(label)}</span>
      <ul class="tag-list">${items}</ul>
      <input type="text" name="${name}Add" class="control-input tag-add" placeholder="${htmlEscape(placeholder)}" aria-label="Add to ${htmlEscape(label)}" autocomplete="off">
      <span class="muted">${htmlEscape(hint)}</span></div>`;
}

export function settingsPage({ settings, connections = null, timeZone, coverLetter = null, modelView = null, tab = 'models' }) {
  const active = ['models', 'pipeline', 'letters'].includes(tab) ? tab : 'models';
  const head = `<h1 class="hub-title">Settings</h1>${settingsTabs(active)}`;
  if (active === 'letters') return `${head}${letterRulesSettingsCard(settings.letterRules)}${autoLettersSettingsCard(settings.autoLetters)}${outreachSettingsCard(settings.outreach)}${coverLetter ? coverLetterSettingsSection({ ...coverLetter, timeZone }) : '<p class="muted">Cover-letter material is not available.</p>'}`;
  if (active === 'pipeline') {
    const levels = ['high', 'medium', 'low'].map(level => `<label class="check"><input type="checkbox" name="acceptedMatchLevels" value="${level}"${settings.acceptedMatchLevels.includes(level) ? ' checked' : ''}> ${level.charAt(0).toUpperCase()}${level.slice(1)}</label>`).join('');
    return `${head}
  <article class="card"><form method="post" action="/settings" id="settings-form">
    <input type="hidden" name="pipelinePresent" value="1">
    <fieldset class="group"><legend>Matching</legend>
      <label class="field"><span>Minimum Match Score (0–100)</span><input type="number" name="minimumMatchScore" class="control-input" min="0" max="100" step="1" value="${Number(settings.minimumMatchScore)}" required></label>
      <div class="field"><span>Accepted Match Levels</span>${levels}</div>
      <label class="field"><span>Max Reviewed Per Run (0 = no limit)</span><input type="number" name="maxReviewedPerRun" class="control-input" min="0" max="5000" step="1" value="${Number(settings.maxReviewedPerRun ?? 60)}" required></label>
      <label class="field"><span>Catch-up Budget (0 = no limit)</span><input type="number" name="catchUpBudget" class="control-input" min="0" max="5000" step="1" value="${Number(settings.catchUpBudget ?? 40)}" required><span class="muted">Postings held while the engine was unavailable (Claude signed out, a usage limit) are reviewed after each run's new postings, at most this many per run, while their posting date is within 48 hours.</span></label>
      <div class="field"><label class="check"><input type="checkbox" name="includeCarriedOver"${settings.includeCarriedOver !== false ? ' checked' : ''}> Include Carried-Over Postings</label><span class="muted">Postings over the review limit wait for the next run and appear under "From Yesterday". Off: they are left unreviewed and not carried.</span></div>
      <div class="field"><label class="check"><input type="checkbox" name="autoCatchUp"${settings.autoCatchUp !== false ? ' checked' : ''}> Auto Catch-Up After Network Outage</label><span class="muted">When the nightly run is cut short by this Mac's network, the hub checks every 10 minutes and reruns it once the network is back (at most twice a day, until the next nightly run).</span></div>
    </fieldset>
    <fieldset class="group" id="role-scope"><legend>Role Scope</legend>
      <input type="hidden" name="roleScopePresent" value="1">
      ${tagEditor('titleFamilies', settings.titleFamilies || [], { label: 'Title Families', placeholder: 'Add a family, then Enter', hint: 'Postings from ATS boards, Hacker News, RemoteOK, and search discovery must name one of these in the title (whole words; the last word also takes common endings). "Associate" passes only beside a family word.' })}
      <input type="hidden" name="excludeTermsPresent" value="1">
      ${tagEditor('targetRoleFamilies', settings.targetRoleFamilies || [], { label: 'Target Role Families', placeholder: 'Add a role family, then Enter', hint: 'Given to the prescreen and the review: postings in these families are judged on what the role asks for, and a product or consulting role is not marked down for not being a data role. The score bands stay the same.' })}
      ${tagEditor('excludeTitleTerms', settings.excludeTitleTerms || [], { label: 'Excluded Title Words', placeholder: 'Add a word, then Enter', hint: 'A posting whose title has one of these words is left out (senior, staff, manager, ...); new grad, early career and the other override phrases lift the manager and level exclusions.' })}
    </fieldset>
    <fieldset class="group"><legend>Reports</legend>
      <div class="field"><label class="check"><input type="checkbox" name="xlsxRequired"${settings.xlsxRequired ? ' checked' : ''}> Require XLSX Workbook (fail the run when it cannot be written)</label></div>
      <label class="field" id="payload-retention"><span>Keep Full Day Payloads for (Days)</span><input type="number" name="payloadRetentionDays" class="control-input" min="31" max="3650" step="1" value="${Number(settings.payloadRetentionDays ?? 90)}" required><span class="muted">Older days keep only their matches and the Run Summary. Payloads over 30 days old are stored gzipped; the Reports pages read both.</span></label>
    </fieldset>
    <fieldset class="group"><legend>Hub</legend>
      <label class="field"><span>Port (takes effect after the hub restarts)</span><input type="number" name="hubPort" class="control-input" min="1024" max="65535" step="1" value="${Number(settings.hubPort)}" required></label>
    </fieldset>
    <button class="btn" type="submit">Save</button>
    <p class="form-foot">Changes apply to the next run.</p>
  </form></article>
  ${prescreenSettingsCard(settings.prescreen)}`;
  }
  const refresh = '<form class="inline" method="post" action="/settings/connections/refresh"><button class="btn secondary small" type="submit">Refresh</button></form>';
  const checked = connections?.checkedAt ? `<p class="form-foot">Checked ${htmlEscape(formatLocalDateTime(connections.checkedAt, timeZone))}; refreshed every minute. The hub never signs in for you.</p>` : '<p class="form-foot">The hub never signs in for you.</p>';
  return `${head}
  ${modelView ? subscriptionsAndModels(modelView, { timeZone, connectionRow, refresh, checked }) : ''}
  ${modelView ? assignmentsForm(modelView, settings) : ''}`;
}

export const SETTINGS_SCRIPT = `
(function () {
  document.querySelectorAll('.tag-edit').forEach(function (box) {
    var name = box.getAttribute('data-name');
    var list = box.querySelector('.tag-list');
    var input = box.querySelector('.tag-add');
    box.addEventListener('click', function (event) {
      var x = event.target.closest('.tag-x');
      if (x) x.closest('.tag').remove();
    });
    function add(text) {
      var tag = String(text || '').replace(/\\s+/g, ' ').trim();
      if (!tag) return;
      var exists = Array.prototype.some.call(list.querySelectorAll('.tag'), function (li) { return li.getAttribute('data-tag').toLowerCase() === tag.toLowerCase(); });
      if (exists) return;
      var li = document.createElement('li');
      li.className = 'tag';
      li.setAttribute('data-tag', tag);
      li.innerHTML = '<span></span><input type="hidden"><button type="button" class="tag-x">×</button>';
      li.querySelector('span').textContent = tag;
      li.querySelector('input').name = name;
      li.querySelector('input').value = tag;
      li.querySelector('.tag-x').setAttribute('aria-label', 'Remove ' + tag);
      list.appendChild(li);
    }
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ',') return;
      event.preventDefault();
      input.value.split(',').forEach(add);
      input.value = '';
    });
  });
})();
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

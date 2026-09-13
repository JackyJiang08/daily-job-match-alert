// Hub pages. The shell adds a sticky left navigation around content built from the same components and
// tokens as the Desktop report (report-components.mjs / report-theme.mjs), so both look alike in light
// and dark mode. Every timestamp is shown in config.timeZone; resume text is never rendered here.
import { REPORT_SCRIPT, REPORT_STYLES } from '../report-theme.mjs';
import { formatCount, formatDateLabel, formatLocalDateTime, formatLocalDay } from '../time-format.mjs';
import { htmlEscape } from '../utils.mjs';

export const HUB_TITLE = 'Daily Job Match Alert Hub';
export const HUB_BRAND = 'Job Match Hub';
const NAV = [
  { id: 'reports', href: '/reports', label: 'Reports' },
  { id: 'resumes', href: '/resumes', label: 'Resumes' },
  { id: 'status', href: '/status', label: 'Status' },
  { id: 'settings', href: '/settings', label: 'Settings' },
];

export const HUB_STYLES = `
.hub{display:grid;grid-template-columns:200px minmax(0,1fr);min-height:100vh}
.hub-nav{position:sticky;top:0;height:100vh;overflow:auto;display:flex;flex-direction:column;border-right:1px solid var(--line);padding:var(--space-5) var(--space-3);background:var(--surface)}
.hub-nav .brand{font-size:var(--fs-body);font-weight:650;margin:0 var(--space-2) var(--space-4);line-height:1.3;white-space:nowrap}
.hub-nav a{display:block;padding:7px var(--space-2);border-radius:var(--radius-sm);text-decoration:none;color:var(--ink-2);font-size:var(--fs-body)}
.hub-nav a.active{background:var(--accent-soft);color:var(--accent);font-weight:650}
.hub-nav a:hover{color:var(--ink)}
.hub-nav .mini{margin:auto var(--space-2) 0;padding-top:var(--space-4);border-top:1px solid var(--line);font-size:11px;line-height:1.5;color:var(--ink-3)}
.hub-nav .mini b{display:block;font-weight:600;color:var(--ink-2)}
.hub-nav .mini .ok{color:var(--accent)}.hub-nav .mini .bad{color:var(--bad-ink)}.hub-nav .mini .warn{color:var(--warn-ink)}
.hub-main{padding:var(--space-5) var(--space-5) var(--space-6);min-width:0}
.hub-content{max-width:1100px;margin:0 auto}
.hub-main .page{padding:0;margin:0;max-width:none}
.hub-title{margin:0 0 var(--space-4);font-size:var(--fs-page);font-weight:650;letter-spacing:-0.01em}
.hub-sub{margin:calc(-1 * var(--space-3)) 0 var(--space-4);font-size:var(--fs-body);color:var(--ink-2)}
.flash{margin:0 0 var(--space-4);padding:var(--space-3) var(--space-4);border-radius:var(--radius);font-size:var(--fs-body)}
.flash.notice{background:var(--accent-soft);color:var(--accent)}
.flash.error{background:var(--bad-bg);color:var(--bad-ink)}
.split{display:grid;grid-template-columns:220px minmax(0,1fr);gap:var(--space-5);align-items:start}
.split aside{position:sticky;top:var(--space-4);max-height:calc(100vh - 2 * var(--space-4));overflow:auto}
.datelist{margin:0;padding:0;list-style:none;font-size:var(--fs-body)}
.datelist a{display:flex;justify-content:space-between;gap:var(--space-2);padding:6px var(--space-2);border-radius:var(--radius-sm);text-decoration:none;color:var(--ink-2)}
.datelist a .n{color:var(--ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.datelist a.active{background:var(--accent-soft);color:var(--accent);font-weight:650}
.datelist a.active .n{color:var(--accent)}
.datelist a.today:not(.active){color:var(--ink);font-weight:650}
.datelist a.quiet{color:var(--ink-3)}
.report-head{display:flex;justify-content:flex-end;margin:0 0 var(--space-2)}
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
fieldset.group{border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3) var(--space-4) var(--space-2);margin:0 0 var(--space-3)}
fieldset.group legend{font-size:var(--fs-meta);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding:0 6px}
.field{display:block;margin:0 0 var(--space-3);font-size:var(--fs-body)}
.field>span{display:block;font-size:var(--fs-meta);color:var(--ink-3);margin-bottom:4px}
.field input[type=text],.field input[type=number]{font:inherit;font-size:var(--fs-body);color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--radius-sm);padding:6px 9px;min-width:240px;max-width:100%}
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
})();
`;

function resultIcon(result) {
  if (result === 'success') return '<span class="ok">✓</span>';
  if (result === 'incomplete') return '<span class="warn">⚠</span>';
  if (result === 'error') return '<span class="bad">✗</span>';
  return '<span>–</span>';
}

function renderMiniStatus(sidebar, timeZone) {
  if (!sidebar) return '';
  const last = sidebar.lastRunAt ? `${resultIcon(sidebar.lastResult)} ${htmlEscape(formatLocalDateTime(sidebar.lastRunAt, timeZone))}` : '– No run yet';
  const next = sidebar.nextRunAt ? htmlEscape(formatLocalDateTime(sidebar.nextRunAt, timeZone)) : '—';
  return `<div class="mini"><b>Last run</b>${last}<b>Next run</b>${next}</div>`;
}

export function renderHubPage({ active, title, content, notice = '', error = '', port, script = '', sidebar = null, timeZone }) {
  const nav = NAV.map(item => `<a href="${item.href}"${item.id === active ? ' class="active"' : ''}>${htmlEscape(item.label)}</a>`).join('');
  const flash = [
    notice ? `<div class="flash notice">${htmlEscape(notice)}</div>` : '',
    error ? `<div class="flash error">${htmlEscape(error)}</div>` : '',
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)} — ${htmlEscape(HUB_TITLE)}</title>
<style>${REPORT_STYLES}${HUB_STYLES}</style></head>
<body><div class="hub"><nav class="hub-nav"><p class="brand">${htmlEscape(HUB_BRAND)}</p>${nav}${renderMiniStatus(sidebar, timeZone)}</nav>
<main class="hub-main"><div class="hub-content">${flash}${content}</div></main></div>
<script>${REPORT_SCRIPT}${HUB_SCRIPT}${script}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------- reports

function fileUrl(filePath) {
  return `file://${encodeURI(String(filePath)).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

export function reportsPage({ dates, selected, reportBody, desktopPath, today }) {
  const list = dates.length
    ? `<ul class="datelist">${dates.map(item => {
      const classes = [item.date === selected ? 'active' : '', item.date === today ? 'today' : '', item.matchCount === 0 ? 'quiet' : ''].filter(Boolean).join(' ');
      const count = item.matchCount == null ? '' : `<span class="n">${item.matchCount} match${item.matchCount === 1 ? '' : 'es'}</span>`;
      return `<li><a href="/reports/${item.date}"${classes ? ` class="${classes}"` : ''} title="${item.date}${item.date === today ? ' (today)' : ''}"><span>${htmlEscape(formatDateLabel(item.date))}</span>${count}</a></li>`;
    }).join('')}</ul>`
    : '<p class="muted">No report payloads under state/ yet.</p>';
  const body = reportBody
    ? `<div class="report-head"><a class="btn secondary small" href="${htmlEscape(fileUrl(desktopPath))}" target="_blank" rel="noopener noreferrer" title="${htmlEscape(desktopPath)}">Open Desktop Copy</a></div><div class="page">${reportBody}</div>`
    : `<p class="muted">${dates.length ? 'Pick a date on the left.' : 'Run the pipeline once and its report will appear here.'}</p>`;
  return `<div class="split"><aside>${list}</aside><section>${body}</section></div>`;
}

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
    ? '<div class="flash error">config.json still uses the legacy resumes layout. Move to resumes.tracks (see config.example.json) to manage resumes from the hub.</div>'
    : (tracksView.error ? `<div class="flash error">${htmlEscape(tracksView.error)}</div>` : '');
  const cards = tracksView.tracks.map(track => trackCard(track, timeZone)).join('\n');
  const add = tracksView.legacy ? '' : `<article class="card"><h2>Add Track</h2>
    <form method="post" action="/resumes/add" enctype="multipart/form-data">
      <label class="field"><span>ID (letters, digits, _ or -)</span><input type="text" name="trackId" pattern="[A-Za-z][A-Za-z0-9_-]{0,31}" required></label>
      <label class="field"><span>Label shown in reports</span><input type="text" name="label" required></label>
      <div class="field"><span>PDF</span><label class="file"><input type="file" name="file" accept=".pdf,application/pdf" required><span class="btn secondary">Choose PDF…</span><span class="file-name">No file chosen</span></label></div>
      <button class="btn" type="submit">Add Track</button>
    </form></article>`;
  return `<h1 class="hub-title">Resumes</h1>
  <p class="hub-sub">One PDF per resume track; upload a new version here and tonight's run scores against it.</p>
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

export function statusPage({ status, timeZone }) {
  const { lastRun, nextRun, lock, runNow, run } = status;
  const at = value => htmlEscape(formatLocalDateTime(value, timeZone));
  const lockLine = lock.locked
    ? `Held by PID ${lock.pid} <span class="muted mono">${htmlEscape(lock.path)}</span>`
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
  return `<h1 class="hub-title">Status</h1>
  <article class="card"><h2>Runs</h2><dl class="kv">
    <dt>Last run</dt><dd>${lastRunLine}</dd>
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

export function settingsPage({ settings }) {
  const levels = ['high', 'medium', 'low'].map(level => `<label class="check"><input type="checkbox" name="acceptedMatchLevels" value="${level}"${settings.acceptedMatchLevels.includes(level) ? ' checked' : ''}> ${level.charAt(0).toUpperCase()}${level.slice(1)}</label>`).join('');
  return `<h1 class="hub-title">Settings</h1>
  <p class="hub-sub">Only these values are written to config.json; everything else in the file stays as it is.</p>
  <article class="card"><form method="post" action="/settings">
    <fieldset class="group"><legend>Matching</legend>
      <label class="field"><span>Minimum Match Score (0–100)</span><input type="number" name="minimumMatchScore" min="0" max="100" step="1" value="${Number(settings.minimumMatchScore)}" required></label>
      <div class="field"><span>Accepted Match Levels</span>${levels}</div>
      <label class="field"><span>Scoring Model</span><input type="text" name="model" value="${htmlEscape(settings.model)}" placeholder="fable" required></label>
    </fieldset>
    <fieldset class="group"><legend>Reports</legend>
      <div class="field"><label class="check"><input type="checkbox" name="xlsxRequired"${settings.xlsxRequired ? ' checked' : ''}> Require XLSX Workbook (fail the run when it cannot be written)</label></div>
    </fieldset>
    <fieldset class="group"><legend>Hub</legend>
      <label class="field"><span>Port (takes effect after <code>npm run hub:restart</code>)</span><input type="number" name="hubPort" min="1024" max="65535" step="1" value="${Number(settings.hubPort)}" required></label>
    </fieldset>
    <button class="btn" type="submit">Save</button>
    <p class="form-foot">Changes apply to the next run.</p>
  </form></article>`;
}

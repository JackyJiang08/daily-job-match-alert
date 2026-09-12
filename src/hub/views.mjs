// Hub pages. The shell adds a left navigation around content built from the same components and tokens
// as the Desktop report (report-components.mjs / report-theme.mjs), so both look alike in light and
// dark mode. Resume text is never rendered here: cards show file metadata only.
import { REPORT_SCRIPT, REPORT_STYLES } from '../report-theme.mjs';
import { htmlEscape } from '../utils.mjs';

export const HUB_TITLE = 'Daily Job Match Alert Hub';
const NAV = [
  { id: 'reports', href: '/reports', label: 'Reports' },
  { id: 'resumes', href: '/resumes', label: 'Resumes' },
  { id: 'status', href: '/status', label: 'Status' },
  { id: 'settings', href: '/settings', label: 'Settings' },
];

export const HUB_STYLES = `
.hub{display:grid;grid-template-columns:200px minmax(0,1fr);min-height:100vh}
.hub-nav{border-right:1px solid var(--line);padding:var(--space-5) var(--space-3);background:var(--surface)}
.hub-nav .brand{font-size:var(--fs-body);font-weight:650;margin:0 var(--space-2) var(--space-4);line-height:1.3}
.hub-nav a{display:block;padding:7px var(--space-2);border-radius:var(--radius-sm);text-decoration:none;color:var(--ink-2);font-size:var(--fs-body)}
.hub-nav a.active{background:var(--accent-soft);color:var(--accent);font-weight:650}
.hub-nav a:hover{color:var(--ink)}
.hub-nav .foot{margin:var(--space-5) var(--space-2) 0;font-size:11px;color:var(--ink-3)}
.hub-main{padding:var(--space-5) var(--space-5) var(--space-6);min-width:0}
.hub-main .page{padding:0;margin:0;max-width:920px}
.hub-title{margin:0 0 var(--space-4);font-size:var(--fs-page);font-weight:650;letter-spacing:-0.01em}
.hub-sub{margin:calc(-1 * var(--space-3)) 0 var(--space-4);font-size:var(--fs-meta);color:var(--ink-3);overflow-wrap:anywhere}
.flash{margin:0 0 var(--space-4);padding:var(--space-3) var(--space-4);border-radius:var(--radius);font-size:var(--fs-body)}
.flash.notice{background:var(--accent-soft);color:var(--accent)}
.flash.error{background:var(--bad-bg);color:var(--bad-ink)}
.split{display:grid;grid-template-columns:200px minmax(0,1fr);gap:var(--space-5)}
.datelist{margin:0;padding:0;list-style:none;font-size:var(--fs-body)}
.datelist a{display:block;padding:5px var(--space-2);border-radius:var(--radius-sm);text-decoration:none;color:var(--ink-2)}
.datelist a.active{background:var(--accent-soft);color:var(--accent);font-weight:650}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-4);margin:0 0 var(--space-3);box-shadow:var(--shadow)}
.card h2{margin:0 0 var(--space-1);font-size:var(--fs-title);font-weight:650}
.card h3{margin:var(--space-3) 0 var(--space-1);font-size:var(--fs-meta);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--space-1) var(--space-4);margin:var(--space-2) 0 0;font-size:var(--fs-body)}
.kv dt{color:var(--ink-3)}
.kv dd{margin:0;overflow-wrap:anywhere}
.kv code{font-family:var(--font-mono);font-size:var(--fs-meta)}
.row{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;margin-top:var(--space-3)}
.btn{display:inline-block;background:var(--accent);color:var(--accent-ink);border:0;border-radius:var(--radius-sm);padding:7px 13px;font:inherit;font-size:var(--fs-body);font-weight:650;cursor:pointer;text-decoration:none}
.btn.secondary{background:transparent;color:var(--ink-2);border:1px solid var(--line-2)}
.btn.danger{background:var(--bad-bg);color:var(--bad-ink)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.field{display:block;margin:0 0 var(--space-3);font-size:var(--fs-body)}
.field>span{display:block;font-size:var(--fs-meta);color:var(--ink-3);margin-bottom:4px}
.field input[type=text],.field input[type=number],.field input[type=file]{font:inherit;font-size:var(--fs-body);color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--radius-sm);padding:6px 9px;min-width:240px;max-width:100%}
.field label.check{display:inline-flex;align-items:center;gap:6px;margin-right:var(--space-3)}
.inline{display:inline}
table.plain{border-collapse:collapse;width:100%;font-size:var(--fs-body)}
table.plain th,table.plain td{text-align:left;padding:6px var(--space-2);border-bottom:1px solid var(--line);vertical-align:top}
table.plain th{font-size:var(--fs-meta);color:var(--ink-3);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
pre.log{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius-sm);padding:var(--space-3);max-height:360px;overflow:auto;font-family:var(--font-mono);font-size:var(--fs-meta);white-space:pre-wrap;overflow-wrap:anywhere;margin:var(--space-2) 0 0}
details.day{margin:var(--space-2) 0}
details.day>summary{cursor:pointer;font-size:var(--fs-body)}
.muted{color:var(--ink-3)}
@media (max-width:760px){.hub{grid-template-columns:1fr}.hub-nav{border-right:0;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:4px;padding:var(--space-3)}.hub-nav .brand,.hub-nav .foot{flex-basis:100%}.split{grid-template-columns:1fr}.hub-main{padding:var(--space-4) var(--space-3)}}
`;

export function renderHubPage({ active, title, content, notice = '', error = '', port, script = '' }) {
  const nav = NAV.map(item => `<a href="${item.href}"${item.id === active ? ' class="active"' : ''}>${htmlEscape(item.label)}</a>`).join('');
  const flash = [
    notice ? `<div class="flash notice">${htmlEscape(notice)}</div>` : '',
    error ? `<div class="flash error">${htmlEscape(error)}</div>` : '',
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)} — ${htmlEscape(HUB_TITLE)}</title>
<style>${REPORT_STYLES}${HUB_STYLES}</style></head>
<body><div class="hub"><nav class="hub-nav"><p class="brand">${htmlEscape(HUB_TITLE)}</p>${nav}<p class="foot">127.0.0.1:${Number(port)} · local only</p></nav>
<main class="hub-main">${flash}${content}</main></div>
<script>${REPORT_SCRIPT}${script}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------- reports

export function reportsPage({ dates, selected, reportBody, desktopPath }) {
  const list = dates.length
    ? `<ul class="datelist">${dates.map(date => `<li><a href="/reports/${date}"${date === selected ? ' class="active"' : ''}>${date}</a></li>`).join('')}</ul>`
    : '<p class="muted">No report payloads under state/ yet.</p>';
  const body = reportBody
    ? `<p class="hub-sub">Desktop copy: <code>${htmlEscape(desktopPath)}</code> (authoritative; the hub only reads it)</p><div class="page">${reportBody}</div>`
    : `<p class="muted">${dates.length ? 'Pick a date on the left.' : 'Run the pipeline once and its report will appear here.'}</p>`;
  return `<h1 class="hub-title">Reports</h1><div class="split"><aside>${list}</aside><section>${body}</section></div>`;
}

// ---------------------------------------------------------------------------------------------- resumes

function readable(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function trackCard(track) {
  const kind = track.managed
    ? '<span class="badge" data-badge="managed">Managed by hub</span>'
    : (track.pdf ? '<span class="badge badge-warn" data-badge="external">External file</span>' : '<span class="badge badge-bad" data-badge="no-pdf">No PDF configured</span>');
  const enabled = track.enabled ? '<span class="badge" data-badge="enabled">Enabled</span>' : '<span class="badge badge-warn" data-badge="disabled">Disabled</span>';
  const extraction = track.extraction
    ? (track.extraction.ok ? `${track.extraction.characters} characters extracted by the hub check (${readable(track.extraction.checkedAt)})` : `Extraction failed: ${track.extraction.error}`)
    : 'Not checked by the hub yet';
  const profile = track.profile.exists ? `${track.profile.characters} characters in <code>${htmlEscape(track.profile.path)}</code>${track.lastSync ? ` (last nightly sync ${readable(track.lastSync)})` : ''}` : `Not extracted yet (<code>${htmlEscape(track.profile.path)}</code> missing; the nightly run creates it)`;
  const versions = track.versions.length
    ? `<h3>Kept versions</h3><table class="plain"><tr><th>File</th><th>Uploaded</th><th>Size</th><th></th></tr>${track.versions.map(version => `<tr><td><code>${htmlEscape(version.name)}</code>${version.path === track.pdf ? ' <span class="badge" data-badge="current">Current</span>' : ''}</td><td>${readable(version.modifiedAt)}</td><td>${Math.round(version.size / 1024)} KB</td><td>${version.path === track.pdf ? '' : `<form class="inline" method="post" action="/resumes/select"><input type="hidden" name="trackId" value="${htmlEscape(track.id)}"><input type="hidden" name="file" value="${htmlEscape(version.name)}"><button class="btn secondary" type="submit">Use this version</button></form>`}</td></tr>`).join('')}</table>`
    : '';
  return `<article class="card" data-track="${htmlEscape(track.id)}">
    <h2>${htmlEscape(track.label)} <span class="muted">(${htmlEscape(track.id)})</span></h2>
    <div class="badges">${enabled}${kind}</div>
    <dl class="kv">
      <dt>PDF</dt><dd>${track.pdf ? `<code>${htmlEscape(track.pdfName)}</code><br><span class="muted">${htmlEscape(track.pdf)}${track.pdfExists ? '' : ' (file not found)'}</span>` : '—'}</dd>
      <dt>Last upload</dt><dd>${track.uploadedAt ? readable(track.uploadedAt) : (track.managed ? '—' : 'Not uploaded through the hub')}</dd>
      <dt>Text extraction</dt><dd>${extraction}</dd>
      <dt>Profile</dt><dd>${profile}</dd>
    </dl>
    ${versions}
    <h3>Actions</h3>
    <form method="post" action="/resumes/upload" enctype="multipart/form-data" class="row">
      <input type="hidden" name="trackId" value="${htmlEscape(track.id)}">
      <input type="file" name="file" accept=".pdf,application/pdf" required>
      <button class="btn" type="submit">Upload replacement PDF</button>
    </form>
    <form method="post" action="/resumes/toggle" class="row">
      <input type="hidden" name="trackId" value="${htmlEscape(track.id)}">
      <input type="hidden" name="enabled" value="${track.enabled ? 'false' : 'true'}">
      <button class="btn ${track.enabled ? 'danger' : 'secondary'}" type="submit">${track.enabled ? 'Disable track' : 'Enable track'}</button>
    </form>
  </article>`;
}

export function resumesPage({ tracksView }) {
  const intro = tracksView.legacy
    ? '<div class="flash error">config.json still uses the legacy resumes layout. Move to resumes.tracks (see config.example.json) to manage resumes from the hub.</div>'
    : (tracksView.error ? `<div class="flash error">${htmlEscape(tracksView.error)}</div>` : '');
  const cards = tracksView.tracks.map(trackCard).join('\n');
  const add = tracksView.legacy ? '' : `<article class="card"><h2>Add a track</h2>
    <form method="post" action="/resumes/add" enctype="multipart/form-data">
      <label class="field"><span>Id (letters, digits, _ or -)</span><input type="text" name="trackId" pattern="[A-Za-z][A-Za-z0-9_-]{0,31}" required></label>
      <label class="field"><span>Label shown in reports</span><input type="text" name="label" required></label>
      <label class="field"><span>PDF</span><input type="file" name="file" accept=".pdf,application/pdf" required></label>
      <button class="btn" type="submit">Add track</button>
    </form></article>`;
  return `<h1 class="hub-title">Resumes</h1>
  <p class="hub-sub">Uploads are stored under <code>private/resumes/&lt;id&gt;/</code> (gitignored, newest five kept) and the track's <code>pdf</code> path in config.json is switched to the new file. Tracks that still point at an external file, such as the Desktop, keep working unchanged. The nightly run extracts the text; only file metadata is shown here.</p>
  ${intro}${cards}${add}`;
}

// ---------------------------------------------------------------------------------------------- status

function dayRow(day) {
  const body = day.warningsText
    ? `<pre class="log">${htmlEscape(day.warningsText)}</pre>`
    : `<p class="muted">No warnings.txt for this date${day.count ? ' (the folder may have been moved)' : ''}.</p>`;
  return `<details class="day"><summary>${day.date} · ${day.count} warning${day.count === 1 ? '' : 's'}${day.matchCount != null ? ` · ${day.matchCount} match${day.matchCount === 1 ? '' : 'es'}` : ''}</summary>${body}</details>`;
}

export function statusPage({ status }) {
  const { lastRun, nextRun, lock, runNow, run } = status;
  const lockLine = lock.locked
    ? `Held by PID ${lock.pid} (<code>${htmlEscape(lock.path)}</code>)`
    : (lock.stale ? `Stale lock from PID ${lock.pid ?? '?'}; the next run clears it` : 'Free');
  const errors = status.errors.length
    ? `<table class="plain"><tr><th>File</th><th>Written</th></tr>${status.errors.map(item => `<tr><td><a href="/status/error/${htmlEscape(item.name)}">${htmlEscape(item.name)}</a><br><span class="muted">${htmlEscape(item.path)}</span></td><td>${readable(item.modifiedAt)}</td></tr>`).join('')}</table>`
    : '<p class="muted">No ERROR-*.html files in the output directory.</p>';
  const runState = run.running ? 'running' : (run.startedAt ? 'finished' : 'idle');
  return `<h1 class="hub-title">Status</h1>
  <article class="card"><h2>Last run</h2><dl class="kv">
    <dt>Report date</dt><dd>${lastRun.date ? `<a href="/reports/${lastRun.date}">${lastRun.date}</a>` : '—'}</dd>
    <dt>Updated</dt><dd>${readable(lastRun.at)}${lastRun.runsToday ? ` (update #${lastRun.runsToday})` : ''}</dd>
    <dt>Trigger</dt><dd>${htmlEscape(lastRun.trigger || 'unknown')}</dd>
    <dt>Result</dt><dd>${htmlEscape(lastRun.result)}</dd>
    <dt>Matches</dt><dd>${lastRun.matchCount ?? '—'}</dd>
    <dt>Last successful run</dt><dd>${readable(lastRun.lastSuccessfulRun)}</dd>
  </dl></article>
  <article class="card"><h2>Schedule</h2><dl class="kv">
    <dt>Next scheduled run</dt><dd>${nextRun.at ? `${readable(nextRun.at)} (${String(nextRun.hour).padStart(2, '0')}:${String(nextRun.minute).padStart(2, '0')} ${htmlEscape(status.timeZone)})` : '—'}${nextRun.installed ? '' : ' <span class="badge badge-warn" data-badge="not-installed">LaunchAgent not installed; showing the 20:00 default</span>'}</dd>
    <dt>Lock</dt><dd id="lock-line">${lockLine}</dd>
  </dl></article>
  <article class="card" id="run-card" data-state="${runState}"><h2>Run now</h2>
    <p class="muted">Runs <code>node src/index.mjs --config config.json</code> with the manual trigger. It uses your Claude subscription quota and merges into today's report.</p>
    <div class="row">
      <button class="btn" id="run-button" type="button"${runNow.available ? '' : ' disabled'}>Run Now</button>
      <span class="muted" id="run-reason">${runNow.available ? '' : htmlEscape(runNow.reason || '')}</span>
    </div>
    <dl class="kv" id="run-meta">
      <dt>State</dt><dd id="run-state">${runState}</dd>
      <dt>Started</dt><dd id="run-started">${readable(run.startedAt)}</dd>
      <dt>Finished</dt><dd id="run-finished">${readable(run.finishedAt)}${run.exitCode != null ? ` · exit ${run.exitCode}` : ''}${run.matchCount != null ? ` · ${run.matchCount} matches` : ''}</dd>
      <dt>Log</dt><dd id="run-log">${run.logPath ? `<code>${htmlEscape(run.logPath)}</code>` : '—'}</dd>
    </dl>
    <pre class="log" id="run-tail">${htmlEscape(run.tail.join('\n'))}</pre>
  </article>
  <article class="card"><h2>Warnings, last 7 report dates</h2>${status.days.length ? status.days.map(dayRow).join('') : '<p class="muted">No reports yet.</p>'}</article>
  <article class="card"><h2>Fatal error reports</h2>${errors}</article>`;
}

export const STATUS_SCRIPT = `
(function () {
  var button = document.getElementById('run-button');
  var card = document.getElementById('run-card');
  if (!button || !card) return;
  function text(id, value) { var el = document.getElementById(id); if (el) el.textContent = value; }
  function stamp(iso) { return iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '—'; }
  function render(status) {
    var run = status.run || {};
    var state = run.running ? 'running' : (run.startedAt ? 'finished' : 'idle');
    card.dataset.state = state;
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
  const levels = ['high', 'medium', 'low'].map(level => `<label class="check"><input type="checkbox" name="acceptedMatchLevels" value="${level}"${settings.acceptedMatchLevels.includes(level) ? ' checked' : ''}> ${level}</label>`).join('');
  return `<h1 class="hub-title">Settings</h1>
  <p class="hub-sub">Only these keys are written; everything else in config.json, including key order, is left as it is. Writes wait for the pipeline lock.</p>
  <article class="card"><form method="post" action="/settings">
    <label class="field"><span>Minimum match score (0–100)</span><input type="number" name="minimumMatchScore" min="0" max="100" step="1" value="${Number(settings.minimumMatchScore)}" required></label>
    <div class="field"><span>Accepted match levels</span>${levels}</div>
    <label class="field"><span>semanticMatching.model</span><input type="text" name="model" value="${htmlEscape(settings.model)}" placeholder="fable" required></label>
    <div class="field"><label class="check"><input type="checkbox" name="xlsxRequired"${settings.xlsxRequired ? ' checked' : ''}> reports.xlsx.required (fail the run when the workbook cannot be written)</label></div>
    <label class="field"><span>hub.port (takes effect after the hub restarts)</span><input type="number" name="hubPort" min="1024" max="65535" step="1" value="${Number(settings.hubPort)}" required></label>
    <button class="btn" type="submit">Save</button>
  </form></article>`;
}

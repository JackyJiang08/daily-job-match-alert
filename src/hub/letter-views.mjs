// Cover-letter pages for the hub: the Settings material section, the Letters history, and the panel
// that generates, edits, and downloads one letter. Only file metadata is shown for the material; the
// copy never names directories, file-name templates, or configuration keys (tooltips may).
import { formatLocalDateTime } from '../time-format.mjs';
import { roleLabel } from '../report.mjs';
import { htmlEscape } from '../utils.mjs';
import { isValidCompanyName } from '../posting-fields.mjs';

export const TRACK_LABELS = { data: 'Data', llm: 'LLM', agent: 'AI Agent' };
export const MAX_SAMPLE_COUNT = 10;

export function trackLabelOf(track) {
  return TRACK_LABELS[String(track || '').toLowerCase()] || String(track || '');
}

export const LETTER_STYLES = `
.letter-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-4);align-items:start}
.letter-head .kv{margin:0}
.letter-controls{min-width:280px}
.para-row{display:grid;grid-template-columns:28px minmax(0,1fr);gap:var(--space-2);align-items:start;margin:0 0 var(--space-2)}
.para-row .num{font-size:var(--fs-meta);color:var(--ink-3);padding-top:9px;text-align:right;font-variant-numeric:tabular-nums}
.para{width:100%;min-height:96px;font:inherit;font-size:var(--fs-body);line-height:var(--lh);color:var(--ink);background:var(--surface);border:1px solid var(--line-2);border-radius:var(--radius-sm);padding:var(--space-2) var(--space-3);resize:vertical;box-sizing:border-box;margin:0}
.para:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.issues{margin:var(--space-2) 0 0;padding:0;list-style:none;font-size:var(--fs-meta)}
.issues li{padding:2px 0;color:var(--warn-ink)}
.letter-counts{font-size:var(--fs-meta);color:var(--ink-2);margin:0 0 var(--space-3)}
.letter-foot{font-size:var(--fs-meta);color:var(--ink-3);margin:var(--space-3) 0 0}
.letter-status{font-size:var(--fs-body);color:var(--ink-2);margin:var(--space-2) 0 0}
.letter-status.error{color:var(--bad-ink)}
details.notes{margin:var(--space-2) 0 0;font-size:var(--fs-meta)}
details.notes>summary{cursor:pointer;color:var(--ink-2);font-weight:600}
.two-col{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 var(--space-4)}
.two-col .field input{min-width:0;width:100%}
.table-scroll{overflow-x:auto;margin:0 0 var(--space-3)}
table.material{border-collapse:collapse;width:100%;min-width:800px;table-layout:fixed;font-size:var(--fs-body)}
table.material td{padding:6px var(--space-2) 6px 0;border-bottom:1px solid var(--line);vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;height:46px}
table.material td.meta{font-size:var(--fs-meta);color:var(--ink-3)}
table.material td.actions{text-align:right;padding-right:0}
table.material .c-track{width:160px}table.material .c-chars{width:120px}table.material .c-time{width:170px}table.material .c-actions{width:190px}
table.material select{min-width:0;width:100%;max-width:150px}
table.material .file{vertical-align:middle}
table.material .file .file-name{max-width:100px}
.upload-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-4)}
.upload-row .track-for{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-meta);color:var(--ink-3)}
.upload-row .track-for select{min-width:140px}
.sample-limit{font-size:var(--fs-meta);color:var(--warn-ink);margin:0 0 var(--space-2)}
@media (max-width:760px){.two-col{grid-template-columns:1fr}.letter-head{grid-template-columns:1fr}.letter-controls{min-width:0}}
`;

function readable(value, timeZone) {
  return value ? htmlEscape(formatLocalDateTime(value, timeZone)) : '—';
}

function trackBadge(track) {
  const label = trackLabelOf(track);
  return label ? `<span class="badge" data-track-badge="${htmlEscape(String(track).toLowerCase())}">${htmlEscape(label)}</span>` : '';
}

function trackOptions(current) {
  return [['', 'Not tagged'], ...Object.entries(TRACK_LABELS)].map(([value, label]) => `<option value="${value}"${(current || '') === value ? ' selected' : ''}>${htmlEscape(label)}</option>`).join('');
}

// ---------------------------------------------------------------------------------------------- settings

const MATERIAL_COLUMNS = '<colgroup><col class="c-name"><col class="c-track"><col class="c-chars"><col class="c-time"><col class="c-actions"></colgroup>';

function fileChooser(name, accept, label, { multiple = false, disabled = false, empty = '' } = {}) {
  return `<label class="file"><input type="file" name="${name}" accept="${accept}"${multiple ? ' multiple' : ''}${disabled ? ' disabled' : ''}><span class="btn secondary${multiple ? '' : ' small'}">${label}</span><span class="file-name">${empty}</span></label>`;
}

// The playbook and every sample share one row layout: name · track · characters · uploaded · actions.
// Remove buttons post to their own route through formaction, so the section stays one form.
function playbookRow(profile, timeZone) {
  const playbook = profile.playbook;
  if (!playbook?.file) {
    return `<div class="table-scroll"><table class="material" id="playbook-row">${MATERIAL_COLUMNS}<tr data-playbook="none">
      <td colspan="4"><span class="muted">No playbook yet. Upload your writing rules and evidence library as a .md or .txt file.</span></td>
      <td class="actions">${fileChooser('playbook', '.md,.txt,text/markdown,text/plain', 'Choose Playbook…')}</td>
    </tr></table></div>`;
  }
  return `<div class="table-scroll"><table class="material" id="playbook-row">${MATERIAL_COLUMNS}<tr data-playbook="${htmlEscape(playbook.file)}">
      <td><span class="mono">${htmlEscape(playbook.originalName || playbook.file)}</span></td>
      <td class="meta"></td>
      <td class="meta">${Number(playbook.characters || 0).toLocaleString('en-US')} characters</td>
      <td class="meta">${readable(playbook.uploadedAt, timeZone)}</td>
      <td class="actions">${fileChooser('playbook', '.md,.txt,text/markdown,text/plain', 'Replace')} <button class="btn secondary small" type="submit" formaction="/settings/cover-letter/remove-playbook" formnovalidate>Remove</button></td>
    </tr></table></div>`;
}

function sampleRows(samples, timeZone) {
  if (!samples.length) return '<p class="muted">No sample letters yet (optional). The three closest to the chosen track go into each letter.</p>';
  return `<div class="table-scroll"><table class="material" id="sample-rows">${MATERIAL_COLUMNS}${samples.map(sample => `<tr data-sample="${htmlEscape(sample.file)}">
      <td><span class="mono">${htmlEscape(sample.originalName || sample.file)}</span></td>
      <td><select name="track" class="control-input sample-track" data-file="${htmlEscape(sample.file)}" aria-label="Track for ${htmlEscape(sample.originalName || sample.file)}">${trackOptions(sample.track)}</select></td>
      <td class="meta">${Number(sample.characters || 0).toLocaleString('en-US')} characters</td>
      <td class="meta">${readable(sample.uploadedAt, timeZone)}</td>
      <td class="actions"><button class="btn secondary small" type="submit" name="file" value="${htmlEscape(sample.file)}" formaction="/settings/cover-letter/remove-sample" formnovalidate>Remove</button></td>
    </tr>`).join('')}</table></div>`;
}

export function coverLetterSettingsSection({ profile, readiness, timeZone }) {
  const samples = profile.samples || [];
  const atLimit = samples.length >= MAX_SAMPLE_COUNT;
  const state = readiness.ready
    ? '<span class="badge badge-good" data-letter-ready="yes">Ready to generate</span>'
    : `<span class="badge badge-warn" data-letter-ready="no">Missing: ${htmlEscape(readiness.missing.join(', '))}</span>`;
  return `<article class="card" id="cover-letters"><h2>Cover Letters</h2>
  <p class="muted">Stored privately on this Mac and never shared. ${state}</p>
  <form method="post" action="/settings/cover-letter" enctype="multipart/form-data">
    <fieldset class="group"><legend>Contact Block</legend>
      <div class="two-col">
        <label class="field"><span>Name</span><input type="text" name="name" class="control-input" value="${htmlEscape(profile.name || '')}" placeholder="Jane Doe" required></label>
        <label class="field"><span>Phone</span><input type="text" name="phone" class="control-input" value="${htmlEscape(profile.phone || '')}" placeholder="555-0100"></label>
        <label class="field"><span>Email</span><input type="text" name="email" class="control-input" value="${htmlEscape(profile.email || '')}" placeholder="jane@example.com"></label>
        <label class="field"><span>Signature Name</span><input type="text" name="signatureName" class="control-input" value="${htmlEscape(profile.signatureName || '')}" placeholder="Jane Doe"></label>
        <label class="field"><span>File Name Prefix (letters are saved as Prefix_Cover_Letter_Company.pdf)</span><input type="text" name="fileNamePrefix" class="control-input" value="${htmlEscape(profile.fileNamePrefix || '')}" placeholder="JaneDoe" pattern="[A-Za-z0-9]{1,60}" title="Letters and digits only"></label>
      </div>
    </fieldset>
    <fieldset class="group"><legend>Playbook</legend>
      <p class="muted" style="margin:0 0 var(--space-2)">Your writing rules and evidence library; Replace swaps the whole file.</p>
      ${playbookRow(profile, timeZone)}
    </fieldset>
    <fieldset class="group"><legend>Sample Letters</legend>
      <p class="muted" style="margin:0 0 var(--space-2)">Style references only; up to ${MAX_SAMPLE_COUNT}. Change a sample's track here and it saves at once. Uploading a file with the same name replaces the old version.</p>
      ${sampleRows(samples, timeZone)}
      ${atLimit ? `<p class="sample-limit" data-sample-limit="reached">Sample limit reached (${MAX_SAMPLE_COUNT}). Remove one to add another.</p>` : ''}
      <div class="upload-row">
        ${fileChooser('sample', '.pdf,.txt,application/pdf,text/plain', 'Choose Samples…', { multiple: true, disabled: atLimit, empty: 'No files chosen' })}
        <label class="track-for"><span>Track for these files</span><select name="sampleTrack" class="control-input" aria-label="Track for these files">${trackOptions('')}</select></label>
      </div>
    </fieldset>
    <button class="btn" type="submit">Save Cover Letter Material</button>
  </form></article>`;
}

export const SAMPLE_TRACK_SCRIPT = `
(function () {
  document.querySelectorAll('select.sample-track').forEach(function (select) {
    select.addEventListener('change', function () {
      var row = select.closest('tr');
      var body = new URLSearchParams({ file: select.dataset.file, track: select.value }).toString();
      select.disabled = true;
      fetch('/settings/cover-letter/sample-track', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body })
        .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status)); return data; }); })
        .then(function () { if (row) { row.classList.add('saved'); setTimeout(function () { row.classList.remove('saved'); }, 800); } })
        .catch(function (error) { window.alert('Could not save the track: ' + error.message); })
        .then(function () { select.disabled = false; });
    });
  });
  document.querySelectorAll('.file input[type=file][multiple]').forEach(function (input) {
    input.addEventListener('change', function () {
      var name = input.closest('.file').querySelector('.file-name');
      if (name) name.textContent = input.files && input.files.length ? (input.files.length === 1 ? input.files[0].name : input.files.length + ' files chosen') : 'No files chosen';
    });
  });
})();
`;

// ---------------------------------------------------------------------------------------------- letters list

export function lettersPage({ letters, timeZone = 'America/Chicago' }) {
  const sorted = [...letters].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  const rows = sorted.length
    ? `<table class="plain"><tr><th>Date</th><th>Company</th><th>Role</th><th>Track</th><th>Engine</th><th>Pages</th><th>Generated</th><th>Notes</th><th>File</th><th>Actions</th></tr>${sorted.map(letter => `<tr>
      <td>${htmlEscape(letter.date)}</td>
      <td><a href="/letters/${letter.date}/${letter.slug}">${htmlEscape(letter.company)}</a>${isValidCompanyName(letter.company) ? '' : ' <span class="badge badge-warn" data-badge="company-suspect" title="The salutation may not name the employer; open the letter and use Rename Company">Check company name</span>'}</td>
      <td>${htmlEscape(letter.jobTitle || '')}</td>
      <td>${trackBadge(letter.track) || htmlEscape(letter.trackLabel || '')}</td>
      <td>${htmlEscape(letter.engine || '')}${letter.model ? ` · ${htmlEscape(letter.model)}` : ''}</td>
      <td>${letter.pdf ? `${letter.pdf.pages}${letter.pdf.layout && letter.pdf.layout !== 'letter-1in' ? ' <span class="badge badge-warn" data-badge="layout">reduced layout</span>' : ''}` : '—'}</td>
      <td>${readable(letter.createdAt || letter.savedAt, timeZone)}</td>
      <td>${Array.isArray(letter.editorNotes) ? letter.editorNotes.length : 0}</td>
      <td><span class="mono">${htmlEscape(letter.pdfFileName || '')}</span></td>
      <td><a class="btn secondary small" href="/letters/${letter.date}/${letter.slug}">Open</a> ${letter.pdfFileName && letter.pdf ? `<a class="btn secondary small" href="/letters/${letter.date}/${letter.slug}/${encodeURIComponent(letter.pdfFileName)}">Download PDF</a>` : ''}</td>
    </tr>`).join('')}</table>`
    : '<p class="muted">No cover letters yet. Open a report and use Generate Cover Letter on a job card.</p>';
  return `<h1 class="hub-title">Letters</h1><p class="hub-sub">Letters you generate are kept on this Mac. Reopen one to edit or download it again.</p><article class="card">${rows}</article>`;
}

// ---------------------------------------------------------------------------------------------- panel

function paragraphEditor(paragraphs) {
  return paragraphs.map((paragraph, index) => `<div class="para-row"><span class="num">${index + 1}</span><textarea class="para" name="paragraph" data-index="${index}">${htmlEscape(paragraph)}</textarea></div>`).join('');
}

function countsLine(record) {
  if (!record) return '';
  const words = Number(record.wordCount || 0);
  const pages = record.pdf ? ` · ${record.pdf.pages} page${record.pdf.pages === 1 ? '' : 's'}` : '';
  return `${words} words · ${(record.paragraphs || []).length} paragraphs${pages}`;
}

function footLine(record, engineLabel) {
  if (!record) return `Engine: ${engineLabel}`;
  const samples = (record.samplesUsed || []).map(sample => `${sample.name}${sample.track ? ` (${trackLabelOf(sample.track)})` : ''}`).join(', ');
  return `${samples ? `Samples used: ${samples} · ` : 'No samples used · '}Engine: ${record.engine}${record.model ? ` · ${record.model}` : ''}${record.pdf ? ` · PDF via ${record.pdf.renderer}` : ''}`;
}

export function letterPanel({ date, jobId, job, tracks, selectedTrack, company, readiness, existing, engineLabel, confirmCompany = false, companyUncertain = false }) {
  const trackOptions = tracks.map(track => `<option value="${htmlEscape(track.id)}"${track.id === selectedTrack ? ' selected' : ''}>${htmlEscape(track.label)}${track.id === job.recommendedTrack ? ' (recommended)' : ''}</option>`).join('');
  const notReady = readiness.ready ? '' : `<div class="flash error">Add your contact block and a playbook under <a href="/settings#cover-letters">Settings → Cover Letters</a> first (missing: ${htmlEscape(readiness.missing.join(', '))}).</div>`;
  const record = existing?.record || null;
  const paragraphs = record?.paragraphs || [];
  const issues = (record?.issues || []).map(issue => `<li data-kind="${htmlEscape(issue.kind)}">${htmlEscape(issue.message)}</li>`).join('');
  const notes = (record?.editorNotes || []).map(note => `<li>${htmlEscape(note)}</li>`).join('');
  const download = record?.pdfFileName && record.pdf
    ? `<a class="btn" id="download-link" href="/letters/${date}/${existing.slug}/${encodeURIComponent(record.pdfFileName)}">Download PDF</a>`
    : '<a class="btn" id="download-link" hidden href="#">Download PDF</a>';
  const companyHint = companyUncertain || confirmCompany
    ? `<p class="letter-status" id="company-hint" data-company-uncertain="${companyUncertain ? 'yes' : 'no'}">${companyUncertain ? 'No source gave a usable employer name; type the company as it should appear in the salutation, then Regenerate.' : 'Confirm the company name before generating.'}</p>`
    : '';
  return `<h1 class="hub-title">Cover Letter</h1>
  ${notReady}
  <article class="card letter-head" id="letter-panel" data-date="${htmlEscape(date)}" data-job="${htmlEscape(jobId)}" data-ready="${readiness.ready ? 'yes' : 'no'}" data-slug="${htmlEscape(existing?.slug || '')}" data-company-uncertain="${companyUncertain ? 'yes' : 'no'}">
    <dl class="kv">
      <dt>Role</dt><dd>${htmlEscape(job.title || '')}</dd>
      <dt>Company</dt><dd>${htmlEscape(job.company || 'Company not resolved')}</dd>
      <dt>Location</dt><dd>${htmlEscape(job.location || 'Location not stated')} · ${htmlEscape(roleLabel(job.roleType))}</dd>
      <dt>Report</dt><dd><a href="/reports/${htmlEscape(date)}">${htmlEscape(date)}</a></dd>
    </dl>
    <div class="letter-controls">
      <label class="field"><span>Resume Track</span><select id="letter-track" class="control-input">${trackOptions}</select></label>
      <label class="field"><span>Company Name</span><input type="text" id="letter-company" class="control-input" value="${htmlEscape(company)}" required></label>
      ${companyHint}
      <div class="row">
        <button class="btn" id="generate-button" type="button"${readiness.ready ? '' : ' disabled'}>Regenerate</button>
        <button class="btn secondary" id="save-button" type="button"${paragraphs.length ? '' : ' hidden'}>Save &amp; Render PDF</button>
        <button class="btn secondary" id="rename-button" type="button"${existing?.slug ? '' : ' hidden'} title="Replace the salutation and the file name and render the PDF again; the model is not called">Rename Company &amp; Re-render</button>
        <button class="btn secondary" id="codex-button" type="button" hidden>Generate with Codex</button>
        ${download}
      </div>
      <p class="letter-status" id="letter-status"></p>
    </div>
  </article>
  <article class="card" id="letter-editor" data-state="${paragraphs.length ? 'editing' : 'empty'}">
    <h2>Body</h2>
    <p class="muted">The header, date, greeting, and sign-off are added for you; edit the paragraphs here, switch the track and Regenerate, or render the PDF again.</p>
    <p class="letter-counts" id="letter-counts">${htmlEscape(countsLine(record))}</p>
    <p class="muted" id="letter-empty"${paragraphs.length ? ' hidden' : ''}>No draft yet. Regenerate writes one with the selected track and company name.</p>
    <div id="paragraphs">${paragraphEditor(paragraphs)}</div>
    <ul class="issues" id="letter-issues">${issues}</ul>
    <details class="notes" id="editor-notes"${notes ? '' : ' hidden'}><summary>Editor Notes</summary><ul class="issues" id="editor-notes-list">${notes}</ul></details>
    <p class="letter-foot" id="letter-foot">${htmlEscape(footLine(record, engineLabel))}</p>
  </article>`;
}

export const LETTER_SCRIPT = `
(function () {
  var panel = document.getElementById('letter-panel');
  if (!panel) return;
  var TRACKS = { data: 'Data', llm: 'LLM', agent: 'AI Agent' };
  var generate = document.getElementById('generate-button');
  var save = document.getElementById('save-button');
  var download = document.getElementById('download-link');
  var status = document.getElementById('letter-status');
  var editor = document.getElementById('letter-editor');
  var box = document.getElementById('paragraphs');
  var issues = document.getElementById('letter-issues');
  var counts = document.getElementById('letter-counts');
  var foot = document.getElementById('letter-foot');
  var notesBox = document.getElementById('editor-notes');
  var emptyHint = document.getElementById('letter-empty');
  var notesList = document.getElementById('editor-notes-list');
  var state = { engine: null, model: null, issues: [], editorNotes: [], samplesUsed: [], pages: null };
  function say(text, error) { status.textContent = text || ''; status.className = 'letter-status' + (error ? ' error' : ''); }
  function form(fields) { var params = new URLSearchParams(); Object.keys(fields).forEach(function (key) { [].concat(fields[key]).forEach(function (value) { params.append(key, value); }); }); return params.toString(); }
  function post(url, fields) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(fields) }).then(function (r) { return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status)); return data; }); });
  }
  function paragraphs() { return Array.prototype.map.call(box.querySelectorAll('textarea'), function (area) { return area.value; }).filter(function (text) { return text.trim(); }); }
  function fill(list) {
    box.innerHTML = '';
    list.forEach(function (text, index) {
      var row = document.createElement('div'); row.className = 'para-row';
      var num = document.createElement('span'); num.className = 'num'; num.textContent = String(index + 1);
      var area = document.createElement('textarea'); area.className = 'para'; area.name = 'paragraph'; area.dataset.index = String(index); area.value = text;
      row.appendChild(num); row.appendChild(area); box.appendChild(row);
    });
  }
  function words(list) { return list.join(' ').split(/\\s+/).filter(Boolean).length; }
  function showCounts(list, pages) { counts.textContent = words(list) + ' words · ' + list.length + ' paragraphs' + (pages != null ? ' · ' + pages + ' page' + (pages === 1 ? '' : 's') : ''); }
  function showFoot(result) {
    var samples = (result.samplesUsed || []).map(function (s) { return s.name + (s.track ? ' (' + (TRACKS[s.track] || s.track) + ')' : ''); }).join(', ');
    foot.textContent = (samples ? 'Samples used: ' + samples + ' · ' : 'No samples used · ') + 'Engine: ' + (result.engineLabel || result.engine) + (result.model ? ' · ' + result.model : '') + (result.downgradeNote ? ' · ' + result.downgradeNote : '') + (result.reviewed ? (result.revisionAdopted ? ' · editor revision applied' : ' · editor pass: no changes') : '');
  }
  function render(result) {
    fill(result.paragraphs);
    issues.innerHTML = '';
    (result.issues || []).forEach(function (issue) { var item = document.createElement('li'); item.dataset.kind = issue.kind; item.textContent = issue.message; issues.appendChild(item); });
    if (notesList) { notesList.innerHTML = ''; (result.editorNotes || []).forEach(function (note) { var item = document.createElement('li'); item.textContent = note; notesList.appendChild(item); }); }
    if (notesBox) notesBox.hidden = !(result.editorNotes && result.editorNotes.length);
    state.engine = result.engine; state.model = result.model; state.issues = result.issues || []; state.editorNotes = result.editorNotes || []; state.samplesUsed = result.samplesUsed || []; state.pages = null;
    showCounts(result.paragraphs, null);
    showFoot(result);
    editor.dataset.state = 'editing'; if (emptyHint) emptyHint.hidden = true; save.hidden = false; download.hidden = true; generate.textContent = 'Regenerate';
  }
  box.addEventListener('input', function () { showCounts(paragraphs(), state.pages); });
  var codexButton = document.getElementById('codex-button');
  function postGenerate(engine) {
    var fields = { date: panel.dataset.date, job: panel.dataset.job, track: document.getElementById('letter-track').value, company: document.getElementById('letter-company').value };
    if (engine) fields.engine = engine;
    return fetch('/letters/generate', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(fields) }).then(function (r) { return r.json().then(function (data) { data.httpStatus = r.status; return data; }); });
  }
  function runGenerate(engine) {
    generate.disabled = true; if (codexButton) codexButton.hidden = true; say('Generating…');
    postGenerate(engine)
      .then(function (data) {
        if (data.httpStatus !== 200) {
          var quota = data.quota || null;
          say(quota ? quota.message + (quota.resetsAt ? '' : '') + (!quota.codexAvailable ? '. Try again after the reset, or sign in to Codex to generate with ChatGPT.' : '') : data.error, true);
          if (quota && quota.codexAvailable && codexButton) codexButton.hidden = false;
          return;
        }
        render(data);
        say(data.downgradeNote ? 'Draft ready (' + data.downgradeNote + '). Edit the paragraphs, then save and render the PDF.' : 'Draft ready. Edit the paragraphs, then save and render the PDF.');
      })
      .catch(function (error) { say(error.message, true); })
      .then(function () { generate.disabled = false; });
  }
  generate.addEventListener('click', function () { runGenerate(null); });
  var rename = document.getElementById('rename-button');
  if (rename) rename.addEventListener('click', function () {
    if (!panel.dataset.slug) return;
    rename.disabled = true; say('Renaming and rendering…');
    post('/letters/rename', { date: panel.dataset.date, slug: panel.dataset.slug, company: document.getElementById('letter-company').value })
      .then(function (result) {
        panel.dataset.slug = result.slug;
        download.href = result.downloadUrl; download.hidden = false;
        if (window.history && window.history.replaceState) window.history.replaceState(null, '', result.openUrl);
        say('Renamed. The salutation and the file name now use ' + result.record.company + ' (' + result.pdfFileName + ').');
      })
      .catch(function (error) { say(error.message, true); })
      .then(function () { rename.disabled = false; });
  });
  if (codexButton) codexButton.addEventListener('click', function () { runGenerate('codex'); });
  save.addEventListener('click', function () {
    save.disabled = true; say('Rendering PDF…');
    post('/letters/save', { date: panel.dataset.date, job: panel.dataset.job, track: document.getElementById('letter-track').value, company: document.getElementById('letter-company').value, paragraph: paragraphs(), engine: state.engine || '', model: state.model || '', issues: JSON.stringify(state.issues), editorNotes: JSON.stringify(state.editorNotes), samplesUsed: JSON.stringify(state.samplesUsed) })
      .then(function (result) {
        download.href = result.downloadUrl; download.hidden = false;
        panel.dataset.slug = result.slug; var renameButton = document.getElementById('rename-button'); if (renameButton) renameButton.hidden = false;
        if (result.pdf.condensed && result.paragraphs) fill(result.paragraphs);
        state.pages = result.pdf.pages;
        showCounts(result.paragraphs || paragraphs(), result.pdf.pages);
        var note = result.pdf.note ? ' ' + result.pdf.note + '.' : '';
        say('Saved. ' + result.pdf.pages + ' page' + (result.pdf.pages === 1 ? '' : 's') + '.' + note, result.pdf.pages > 1);
      })
      .catch(function (error) { say(error.message, true); })
      .then(function () { save.disabled = false; });
  });
})();
`;

// Drives the one-click buttons on job cards: start a background generation, poll its state, download
// the PDF when it is ready, and swap the button for Open Letter and Download PDF. One letter at a time:
// every other button is disabled while one is generating, on this page or another.
export const ONECLICK_SCRIPT = `
(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button[data-oneclick]'));
  if (!buttons.length) return;
  var BUSY_TITLE = 'Another cover letter is generating; wait for it to finish';
  var active = null;
  function post(url, fields) {
    var params = new URLSearchParams(); Object.keys(fields).forEach(function (key) { params.append(key, fields[key]); });
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() }).then(function (r) { return r.json().then(function (data) { data.httpStatus = r.status; return data; }); });
  }
  function cardOf(button) { return button.closest('.job'); }
  function noteOn(button, text) {
    var actions = button.closest('.actions');
    var note = actions && actions.querySelector('.letter-note');
    if (!note && actions) { note = document.createElement('span'); note.className = 'meta letter-note'; note.setAttribute('data-letter-note', ''); actions.appendChild(note); }
    if (note) { note.textContent = text || ''; note.hidden = !text; }
  }
  function setBusy(busy, job) {
    buttons.forEach(function (button) {
      if (button.dataset.state === 'generating' || button.dataset.state === 'ready') return;
      button.disabled = busy;
      button.title = busy ? BUSY_TITLE : '';
    });
  }
  function matching(job) {
    return buttons.find(function (button) { return job && button.dataset.date === job.date && button.dataset.job === job.jobId; }) || null;
  }
  function markGenerating(button) {
    button.dataset.state = 'generating'; button.disabled = true; button.textContent = 'Generating…'; button.title = '';
    noteOn(button, '');
  }
  function markReady(button, result) {
    button.dataset.state = 'ready';
    var open = document.createElement('a'); open.className = 'btn secondary small'; open.href = result.openUrl; open.textContent = 'Open Letter';
    var download = document.createElement('a'); download.className = 'btn secondary small'; download.href = result.downloadUrl; download.textContent = 'Download PDF';
    button.replaceWith(open, download);
    buttons = buttons.filter(function (item) { return item !== button; });
    var card = open.closest('.job');
    var badges = card && card.querySelector('.badges');
    if (card && !badges) { badges = document.createElement('div'); badges.className = 'badges'; card.querySelector('.scores').insertAdjacentElement('afterend', badges); }
    if (badges && !badges.querySelector('[data-badge="letter-ready"]')) { var badge = document.createElement('span'); badge.className = 'badge badge-good'; badge.setAttribute('data-badge', 'letter-ready'); badge.textContent = 'Letter ready'; badges.appendChild(badge); }
    var anchor = document.createElement('a'); anchor.href = result.downloadUrl; anchor.download = ''; anchor.hidden = true; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  }
  function markFailed(button, message, quota) {
    button.dataset.state = ''; button.disabled = false; button.textContent = 'Generate Cover Letter'; button.title = '';
    noteOn(button, (quota && quota.message ? quota.message : 'Could not generate: ' + (message || 'unknown error')) + (quota && !quota.codexAvailable && quota.kind ? '. Try again after the reset, or sign in to Codex to generate with ChatGPT.' : ''));
    var actions = button.closest('.actions');
    var old = actions && actions.querySelector('[data-codex]');
    if (old) old.remove();
    if (quota && quota.codexAvailable && actions) {
      var codex = document.createElement('button'); codex.type = 'button'; codex.className = 'btn secondary small'; codex.setAttribute('data-codex', '1'); codex.textContent = 'Generate with Codex';
      codex.addEventListener('click', function () { codex.remove(); start(button, 'codex'); });
      button.insertAdjacentElement('afterend', codex);
    }
  }
  function poll() {
    fetch('/letters/oneclick.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (job) {
      var button = matching(job);
      if (job.state === 'generating') {
        if (button && button.dataset.state !== 'generating') markGenerating(button);
        setBusy(true, job);
        setTimeout(poll, 1500);
        return;
      }
      if (button && button.dataset.state === 'generating') {
        if (job.state === 'ready' && job.result) markReady(button, job.result);
        else markFailed(button, job.error, job.quota ? { kind: job.quota.kind, message: job.error, codexAvailable: job.codexAvailable === true } : null);
      }
      active = null;
      setBusy(false, null);
    }).catch(function () { setTimeout(poll, 3000); });
  }
  function start(button, engine) {
    if (button.disabled) return;
    markGenerating(button);
    setBusy(true, null);
    var fields = { date: button.dataset.date, job: button.dataset.job };
    if (engine) fields.engine = engine;
    post('/letters/oneclick', fields).then(function (data) {
      if (data.state === 'confirm' && data.panelUrl) { window.location.href = data.panelUrl; return; }
      if (data.httpStatus !== 202) { markFailed(button, data.error, data.quota || null); if (data.httpStatus === 409) { setBusy(true, data.job); setTimeout(poll, 1500); } else { setBusy(false, null); } return; }
      active = data.id;
      setTimeout(poll, 1000);
    }).catch(function (error) { markFailed(button, error.message); setBusy(false, null); });
  }
  buttons.forEach(function (button) { button.addEventListener('click', function () { start(button, null); }); });
  poll();
})();
`;

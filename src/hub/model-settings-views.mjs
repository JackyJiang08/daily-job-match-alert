// Markup for Settings → Subscriptions & Models (data from model-settings.mjs) and the tab bar. Full model
// ids everywhere; aliases are a grey secondary label.
import { formatLocalDateTime, formatLocalShort } from '../time-format.mjs';
import { formatTokens } from '../engines/usage.mjs';
import { htmlEscape } from '../utils.mjs';
import { STATUS_TONES } from './model-settings.mjs';

export const SETTINGS_TABS = [
  { id: 'models', label: 'Subscriptions & Models' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'letters', label: 'Cover Letters' },
];

export function settingsTabs(active) {
  return `<nav class="tabs" aria-label="Settings sections">${SETTINGS_TABS.map(tab => `<a href="/settings?tab=${tab.id}"${tab.id === active ? ' aria-current="page" class="active"' : ''}>${htmlEscape(tab.label)}</a>`).join('')}</nav>`;
}

function aliasTag(alias) {
  return alias ? ` <span class="alias">${htmlEscape(alias)}</span>` : '';
}

export function statusBadge(status, text) {
  return `<span class="badge badge-${STATUS_TONES[status.state] || 'muted'}" data-model-state="${htmlEscape(status.state)}">${htmlEscape(text)}</span>`;
}

function tokens(totals) {
  return `${formatTokens(totals.input + totals.cacheRead + totals.cacheCreation)} in · ${formatTokens(totals.output)} out`;
}

function subscriptionCard(card, { timeZone, connectionRow, refresh }) {
  const plan = card.plan;
  const providerKey = card.provider === 'anthropic' ? 'claude' : 'chatgpt';
  const engineName = card.provider === 'anthropic' ? 'Claude' : 'Codex';
  const source = plan.source === 'auto'
    ? `Detected automatically${plan.detectedSource ? ` from ${htmlEscape(plan.detectedSource)}` : ''}${card.checkedAt ? ` · checked ${htmlEscape(formatLocalDateTime(card.checkedAt, timeZone))}` : ''}`
    : plan.source === 'manual' ? 'Set manually' : 'Not detected';
  const pending = plan.pending ? `<p class="plan-change" data-plan-pending="${htmlEscape(plan.pending.effectiveDate)}">Switches to ${htmlEscape(plan.pending.plan.charAt(0).toUpperCase() + plan.pending.plan.slice(1))} on ${htmlEscape(plan.pending.dateLabel)}</p>` : '';
  const usage = card.usage
    ? `<ul class="plain-list sub-usage">${card.usage.tokensByModel.map(item => `<li><span class="mono">${htmlEscape(item.model)}</span> ${htmlEscape(tokens(item.totals))}</li>`).join('')}</ul>`
    : '<span class="muted">—</span>';
  const limit = card.lastLimit
    ? `${htmlEscape(card.lastLimit.text)} <span class="muted">· ${htmlEscape(formatLocalDateTime(card.lastLimit.at, timeZone))}${card.lastLimit.action ? ` · ${htmlEscape(card.lastLimit.action)}` : ''}</span>${card.lastLimit.resetsAt ? `<br><span class="muted">Expected to reset ${htmlEscape(formatLocalDateTime(card.lastLimit.resetsAt, timeZone))}</span>` : ''}`
    : '<span class="muted">None recorded</span>';
  const manualForm = plan.source === 'auto' ? '' : `<form class="inline plan-manual" method="post" action="/settings/plans"><input type="hidden" name="provider" value="${providerKey}"><label><span class="muted">Set plan</span> <input type="text" name="plan" class="control-input small-input" value="${htmlEscape(plan.manual || '')}" placeholder="${providerKey === 'claude' ? 'max' : 'plus'}" pattern="[A-Za-z][A-Za-z0-9_-]{0,31}"></label> <button class="btn secondary small" type="submit">Save</button></form>`;
  return `<article class="card sub-card" data-provider="${card.provider}">
    <div class="sub-plan">
      <div class="sub-head"><h3>${htmlEscape(card.name)}</h3>${refresh}</div>
      <p class="plan-name" data-plan-name="${providerKey}">${htmlEscape(plan.label)} <span class="badge badge-muted" data-plan-source="${htmlEscape(plan.source || 'unknown')}">${htmlEscape(plan.source || 'unknown')}</span></p>
      <p class="plan-meta">${source}</p>
      ${pending}
      ${manualForm}
    </div>
    <div class="sub-details">
      <dl class="conn">${connectionRow(engineName, card.engine, card.connection)}</dl>
      <dl class="kv sub-kv">
        ${card.connection?.version ? `<dt>CLI</dt><dd>${engineName} CLI ${htmlEscape(card.connection.version)}</dd>` : ''}
        <dt>Last 7 days</dt><dd data-plan-usage="${card.engine}">${usage}</dd>
        <dt>Last limit</dt><dd data-last-limit="${card.engine}">${limit}</dd>
      </dl>
    </div>
  </article>`;
}

function modelRow(model, { timeZone }) {
  const version = model.newVersion
    ? `<span class="mono">${htmlEscape(model.newVersion)}</span><br><span class="new-version" data-new-version="${htmlEscape(model.newVersion)}">New version: ${htmlEscape(model.newVersion)}</span>`
    : model.version ? `<span class="mono">${htmlEscape(model.version)}</span>` : '<span class="muted">—</span>';
  const used = model.usedBy.length ? model.usedBy.map(item => `<span class="stage${item.primary ? ' primary' : ''}" title="${htmlEscape(item.stage)}${item.primary ? '' : ' (fallback)'}">${htmlEscape(SHORT_STAGE[item.stage] || item.stage)}</span>`).join(' ') : '<span class="muted">—</span>';
  const test = `<form class="inline test-form" method="post" action="/settings/models/test" data-test-model="${htmlEscape(model.id)}"><input type="hidden" name="model" value="${htmlEscape(model.id)}"><input type="hidden" name="confirm" value="1"><button class="link-button" type="submit" title="Send one short prompt to ${htmlEscape(model.id)}">Test</button></form>`;
  return `<tr data-model="${htmlEscape(model.id)}"><td><span class="mono">${htmlEscape(model.id)}</span><br>${model.alias ? `<span class="alias">${htmlEscape(model.alias)}</span> · ` : ''}${test}</td><td>${version}</td><td>${statusBadge(model.status, model.statusText)}</td><td class="nowrap" title="${model.status.lastUsedAt ? htmlEscape(formatLocalDateTime(model.status.lastUsedAt, timeZone)) : ''}">${model.status.lastUsedAt ? htmlEscape(formatLocalShort(model.status.lastUsedAt, timeZone)) : '<span class="muted">Never</span>'}</td><td>${used}</td></tr>`;
}

const MODEL_HEAD = '<tr><th>Model</th><th>Current version</th><th>On this plan</th><th>Last used</th><th>Used by</th></tr>';
// Stage names in the narrow "Used by" column; the full name is the tooltip.
const SHORT_STAGE = { 'Cover letter draft': 'Letter draft', 'Cover letter editor': 'Letter editor' };

function modelsTable(card, options) {
  const shown = card.models.filter(model => !model.folded);
  const folded = card.models.filter(model => model.folded);
  const more = folded.length
    ? `<details class="all-models"><summary>Show all models (${folded.length} more)</summary><div class="table-scroll"><table class="plain models-table">${MODEL_HEAD}${folded.map(model => modelRow(model, options)).join('')}</table></div></details>`
    : '';
  return `<article class="card model-card" data-provider="${card.provider}"><h3>${htmlEscape(card.name)} models</h3><div class="table-scroll"><table class="plain models-table">${MODEL_HEAD}${shown.map(model => modelRow(model, options)).join('')}</table></div>${more}</article>`;
}

// One select with every registry model, grouped by provider; the script keeps it to the chosen engine.
function modelOptions(catalog, selected) {
  const group = (provider, label) => `<optgroup label="${label}" data-provider="${provider}">${catalog.filter(entry => entry.provider === provider).map(entry => `<option value="${htmlEscape(entry.id)}" data-provider="${provider}" data-efforts="${htmlEscape((entry.efforts || []).join(' '))}"${entry.id === selected ? ' selected' : ''}>${htmlEscape(entry.id)}${entry.alias ? ` (${htmlEscape(entry.alias)})` : ''}</option>`).join('')}</optgroup>`;
  return group('anthropic', 'Claude') + group('openai', 'ChatGPT');
}

function effortOptions(catalog, model, selected) {
  const efforts = catalog.find(entry => entry.id === model)?.efforts || [];
  return [`<option value=""${selected ? '' : ' selected'}>CLI default</option>`, ...efforts.map(effort => `<option value="${htmlEscape(effort)}"${effort === selected ? ' selected' : ''}>${htmlEscape(effort)}</option>`)].join('');
}

function chainTags(row, catalog, editable) {
  const tags = row.chain.slice(1).map(step => `<li class="tag${step.blocked ? ' off' : ''}" data-id="${htmlEscape(step.model)}"><span class="mono">${htmlEscape(step.model)}</span>${step.blocked ? ` <span class="why">· ${htmlEscape(step.reason)}</span>` : ''}${editable ? `<input type="hidden" name="fallback_${row.stage}" value="${htmlEscape(step.model)}"><button type="button" class="tag-x" aria-label="Remove ${htmlEscape(step.model)}">×</button>` : ''}</li>`).join('');
  const add = editable ? `<select class="chain-add control-input" aria-label="Add a fallback model to ${htmlEscape(row.label)}"><option value="">+ Add</option>${catalog.map(entry => `<option value="${htmlEscape(entry.id)}">${htmlEscape(entry.id)}</option>`).join('')}</select>` : '';
  const head = row.chain[0] ? `<span class="tag head${row.chain[0].blocked ? ' off' : ''}"><span class="mono">${htmlEscape(row.chain[0].model)}</span>${row.chain[0].blocked ? ` <span class="why">· ${htmlEscape(row.chain[0].reason)}</span>` : ''}</span><span class="arrow" aria-hidden="true">→</span>` : '';
  return `<div class="chain-edit" data-stage="${row.stage}">${head}<ol class="chain-tags">${tags}</ol>${add}</div>`;
}

function engineSelect(row) {
  const options = [['claude', 'claude'], ['codex', 'codex'], ...(row.engine === 'local_only' ? [['local_only', 'local only (no model)']] : [])];
  return `<select name="${row.stage}_engine" class="control-input engine-select" aria-label="${htmlEscape(row.label)} engine">${options.map(([value, label]) => `<option value="${value}"${value === row.engine ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
}

// The Task assignments form: one row per stage with inline engine, model, and effort, and the fallback
// chain as editable tags. Scoring's chain is the model ladder (plus Codex on a weekly account limit);
// Supplemental follows Scoring; Prescreen is reserved.
export function assignmentsForm(view, settings) {
  const { catalog } = view;
  const rows = view.stages.map(row => {
    const editable = ['scoring', 'letterDraft', 'letterEditor'].includes(row.stage);
    if (row.reserved) return `<tr data-stage="prescreen"><th scope="row">${htmlEscape(row.label)}</th><td colspan="3"><span class="muted">Local title and location rules; no model</span></td><td><span class="muted">Reserved for a future model step</span></td></tr>`;
    if (row.linked) return `<tr data-stage="supplemental"><th scope="row">${htmlEscape(row.label)}</th><td colspan="3"><span class="muted">Follows Scoring (${htmlEscape(row.engine)} · <span class="mono">${htmlEscape(row.model || '—')}</span>)</span></td><td>${chainTags(row, catalog, false)}</td></tr>`;
    const editorSwitch = row.stage === 'letterEditor' ? `<label class="check small"><input type="checkbox" name="editorReview"${settings.editorReview ? ' checked' : ''}> Run the editor pass</label>` : '';
    if (row.engine === null) {
      return `<tr data-stage="${row.stage}"><th scope="row">${htmlEscape(row.label)}${editorSwitch ? `<br>${editorSwitch}` : ''}</th><td colspan="3"><span class="muted">Placeholder engine (Scoring is local only)</span> ${engineSelect({ ...row, engine: 'local_only' })}<input type="hidden" name="${row.stage}_placeholder" value="1"></td><td><span class="muted">—</span></td></tr>`;
    }
    const model = `<select name="${row.stage}_model" class="control-input model-select" aria-label="${htmlEscape(row.label)} model">${modelOptions(catalog, row.model)}</select>`;
    const effort = `<select name="${row.stage}_effort" class="control-input effort-select" aria-label="${htmlEscape(row.label)} effort"${row.engine === 'codex' ? '' : ' disabled'}>${effortOptions(catalog, row.model, row.effort)}</select>`;
    const editor = editorSwitch;
    return `<tr data-stage="${row.stage}"${row.off ? ' class="stage-off"' : ''}><th scope="row">${htmlEscape(row.label)}${editor ? `<br>${editor}` : ''}</th><td>${engineSelect(row)}</td><td>${model}</td><td>${effort}</td><td>${editable ? chainTags(row, catalog, true) : ''}</td></tr>`;
  }).join('');
  return `<form method="post" action="/settings/assignments" id="assignments-form" class="card assignments-card">
    <h2>Task assignments</h2>
    <input type="hidden" name="assignmentsPresent" value="1"><input type="hidden" name="editorReviewPresent" value="1">
    <div class="table-scroll"><table class="plain assignments"><tr><th>Stage</th><th>Engine</th><th>Model</th><th>Effort</th><th>Fallback chain</th></tr>${rows}</table></div>
    <p class="form-foot">Scoring's chain is the model ladder; a ChatGPT model at its end takes over on a weekly account limit when Codex is signed in. A Codex step that is not connected is skipped and noted in the letter's Editor notes.</p>
    <button class="btn" type="submit">Save Assignments</button>
  </form>`;
}

export function subscriptionsAndModels(view, { timeZone, connectionRow, refresh, checked = '' }) {
  return `<section id="subscriptions"><h2 class="section-title">Subscriptions <span class="section-note">${checked.replace(/<\/?p[^>]*>/g, '')}</span></h2><div class="pair-grid">${view.cards.map(card => subscriptionCard(card, { timeZone, connectionRow, refresh })).join('')}</div></section>
  <section id="models"><h2 class="section-title">Models <form method="post" action="/settings/models/recheck" class="inline"><button class="link-button" type="submit" title="Forget every unavailable and unknown-model mark; the next call tries those models again">Re-check Models</button></form></h2><div class="pair-grid">${view.cards.map(card => modelsTable(card, { timeZone })).join('')}</div></section>`;
}

export const MODEL_SETTINGS_STYLES = `
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:0 0 var(--space-4)}
.tabs a{padding:8px 14px;text-decoration:none;color:var(--ink-2);border-bottom:2px solid transparent;margin-bottom:-1px;font-weight:600}
.tabs a.active{color:var(--accent);border-bottom-color:var(--accent)}
.section-title{font-size:var(--fs-title);margin:var(--space-2) 0 var(--space-2);display:flex;align-items:baseline;gap:var(--space-3);flex-wrap:wrap}
.section-note{font-size:var(--fs-meta);font-weight:400;color:var(--ink-3)}
.pair-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);align-items:start}
.sub-card,.model-card{margin:0;padding:var(--space-3)}
.sub-card{display:grid;grid-template-columns:minmax(0,0.9fr) minmax(0,1.3fr);gap:var(--space-3)}
.sub-details .conn{margin:0;font-size:var(--fs-meta)}
.sub-details .kv{font-size:var(--fs-meta);gap:2px var(--space-3)}
.nowrap{white-space:nowrap}
.sub-head{display:flex;justify-content:space-between;align-items:center}
.sub-head h3,.model-card h3{margin:0}
.plan-name{margin:2px 0 0;font-size:26px;font-weight:700;line-height:1.2}
.plan-name .badge{vertical-align:middle;font-size:var(--fs-meta)}
.plan-meta{margin:0 0 var(--space-1);font-size:var(--fs-meta);color:var(--ink-3)}
.plan-change{margin:0 0 var(--space-1);font-weight:600;color:var(--warn-ink)}
.sub-kv{margin-top:var(--space-1)}
.sub-usage{margin:0;padding-left:0;list-style:none}
.small-input{width:7em;min-height:28px;padding:3px 7px}
.alias{color:var(--ink-3);font-size:var(--fs-meta);font-weight:400}
.models-table td,.models-table th,.assignments td,.assignments th{font-size:var(--fs-body);vertical-align:top;padding:4px 6px}
.models-table th{font-size:var(--fs-meta)}
.models-table .mono,.assignments .mono{white-space:nowrap}
.models-table .mono{font-size:var(--fs-meta)}
.models-table th{letter-spacing:.02em}
.row-action{text-align:right}
.link-button{background:none;border:0;padding:0;color:var(--accent);font:inherit;font-size:var(--fs-meta);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.new-version{display:inline-block;font-size:var(--fs-meta);font-weight:600;color:var(--warn-ink)}
.stage{display:inline-block;font-size:var(--fs-meta);border:1px solid var(--line-2);border-radius:var(--radius-sm);padding:0 6px;margin:1px 0;color:var(--ink-2)}
.models-table td:last-child{min-width:7.5em}
.stage.primary{border-color:var(--accent);color:var(--accent)}
.badge-muted{background:var(--line);color:var(--ink-2)}
.all-models summary{cursor:pointer;font-size:var(--fs-meta);color:var(--accent);margin-top:var(--space-1)}
.assignments-card{margin-top:var(--space-3);padding:var(--space-3)}
.assignments-card h2{margin:0 0 var(--space-2)}
.assignments select.control-input{min-height:30px;padding:3px 26px 3px 8px;font-size:var(--fs-body)}
.chain-edit{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.chain-tags{display:contents;list-style:none;margin:0;padding:0}
.tag{display:inline-flex;align-items:center;gap:4px;font-size:var(--fs-meta);background:var(--accent-soft);border-radius:var(--radius-sm);padding:2px 7px}
.tag.head{background:var(--line)}
.tag.off{background:var(--line);color:var(--ink-3)}
.tag.off .mono{text-decoration:line-through}
.tag-x{border:0;background:none;color:var(--ink-3);cursor:pointer;font-size:14px;line-height:1;padding:0 2px}
.chain-edit .arrow{color:var(--ink-3)}
.chain-add{width:6.5em;min-height:26px !important;font-size:var(--fs-meta) !important}
.check.small{font-size:var(--fs-meta);font-weight:400}
.stage-off{opacity:.65}
@media (max-width:1000px){.pair-grid{grid-template-columns:1fr}}
@media (max-width:640px){.sub-card{grid-template-columns:1fr}}
`;

export const MODEL_SETTINGS_SCRIPT = `
(function(){
  document.querySelectorAll('.chain-edit').forEach(function(box){
    var stage = box.getAttribute('data-stage');
    var list = box.querySelector('.chain-tags');
    box.addEventListener('click', function(event){
      var x = event.target.closest('.tag-x');
      if (x) x.closest('.tag').remove();
    });
    var add = box.querySelector('.chain-add');
    if (add) add.addEventListener('change', function(){
      var id = add.value;
      add.value = '';
      if (!id || list.querySelector('[data-id="' + id + '"]')) return;
      var li = document.createElement('li');
      li.className = 'tag';
      li.setAttribute('data-id', id);
      li.innerHTML = '<span class="mono"></span><input type="hidden" name="fallback_' + stage + '"><button type="button" class="tag-x">×</button>';
      li.querySelector('.mono').textContent = id;
      li.querySelector('input').value = id;
      li.querySelector('.tag-x').setAttribute('aria-label', 'Remove ' + id);
      list.appendChild(li);
    });
  });
  document.querySelectorAll('tr[data-stage]').forEach(function(row){
    var engine = row.querySelector('.engine-select');
    var model = row.querySelector('.model-select');
    var effort = row.querySelector('.effort-select');
    if (!engine || !model) return;
    var sync = function(){
      var provider = engine.value === 'codex' ? 'openai' : 'anthropic';
      var current = model.options[model.selectedIndex];
      model.querySelectorAll('option').forEach(function(option){ option.hidden = option.getAttribute('data-provider') !== provider; });
      if (!current || current.getAttribute('data-provider') !== provider) {
        var first = model.querySelector('option[data-provider="' + provider + '"]');
        if (first) first.selected = true;
      }
      if (effort) {
        var chosen = model.options[model.selectedIndex];
        var efforts = (chosen && chosen.getAttribute('data-efforts') || '').split(' ').filter(Boolean);
        var keep = effort.value;
        effort.innerHTML = '<option value="">CLI default</option>' + efforts.map(function(value){ return '<option value="' + value + '">' + value + '</option>'; }).join('');
        effort.value = efforts.indexOf(keep) >= 0 ? keep : '';
        effort.disabled = provider !== 'openai';
      }
    };
    engine.addEventListener('change', sync);
    model.addEventListener('change', sync);
    sync();
  });
  document.querySelectorAll('form[data-test-model]').forEach(function(form){
    form.addEventListener('submit', function(event){
      var model = form.getAttribute('data-test-model');
      if (!window.confirm('Send one short test prompt ("Reply with OK") to ' + model + '? It uses a little of your subscription.')) event.preventDefault();
    });
  });
})();
`;

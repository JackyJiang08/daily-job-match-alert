// HTML components for the daily report. Every function takes a plain view object (assembled in
// report.mjs) and returns a string; nothing here reads pipeline state, so the same components can be
// reused by a local hub that renders the same cards from stored payloads.
import { htmlEscape } from './utils.mjs';
import { REPORT_SCRIPT, REPORT_STYLES } from './report-theme.mjs';

// Every link out of the report opens a new tab so the shortlist itself is never navigated away.
export const EXTERNAL_LINK = 'target="_blank" rel="noopener noreferrer"';
// The one line a card shows in place of a Job Description the pipeline could not read in full (jd-extract.mjs).
export const INCOMPLETE_DESCRIPTION_LABEL = 'Full Description On The Posting Page';
// The card's copy control beside "Job Description" (an icon alone; the name is its label).
export const COPY_DESCRIPTION_LABEL = 'Copy Job Description';
// The hub's "⋯" menu is filled by the hub page (reportsPage replaces this marker), so the cached report body
// never carries request-specific controls.
export const MENU_SLOT = '<!--menu-->';
// The hub puts ‹ date › and the month picker here (reportsPage); the Desktop report shows the date as text.
export const DATE_SLOT = '<!--date-->';

const COPY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

// "1 Job", "3 Jobs": the top row's count and the tab title.
export function jobCountLabel(total) {
  return `${total} ${total === 1 ? 'Job' : 'Jobs'}`;
}

function option(value, label, selected = false) {
  return `<option value="${htmlEscape(value)}"${selected ? ' selected' : ''}>${htmlEscape(label)}</option>`;
}

// The one top row (2026-11-15), sticky while the list scrolls: the date ("November 15, 2026"; in the hub ‹ date ›
// with the month picker, 2026-11-18) and the count on the left; search,
// sort, Track and Role Type on the right; Freshness, the score range, Hide Contacted (hub) and Clear Filters
// in the "Filters" popover; the hub's secondary actions in a "⋯" menu that the hub page fills in. The page
// script keeps the filter state in the URL query (src/report-filters.mjs).
export function renderToolbar({ roleTypes, tracks, total, freshness = [], marks = null, title = '', menuSlot = false, dateSlot = false }) {
  const contacted = marks ? `<label class="check"><input type="checkbox" id="hide-contacted"> Hide Contacted</label>` : '';
  const count = jobCountLabel(total);
  const date = dateSlot ? DATE_SLOT : title ? `<span class="bar-date">${htmlEscape(title)}</span>` : '';
  return `<div class="bar-sentinel" id="bar-sentinel" aria-hidden="true"></div><form class="toolbar" id="toolbar" autocomplete="off">
    <div class="bar-title">${date ? `${date}<span class="sep">·</span>` : ''}<span class="count" id="count">${count}</span></div>
    <input type="search" id="q" placeholder="Search company or title" aria-label="Search company or title">
    <select id="sort" class="control" aria-label="Sort by">${option('score', 'Best Score', true)}${option('company', 'Company')}${option('posted', 'Posted Time')}</select>
    <select id="track" class="control" aria-label="Track">${option('', 'All Tracks')}${tracks.map(track => option(track.id, track.label)).join('')}</select>
    <select id="role" class="control" aria-label="Role type">${option('', 'All Role Types')}${roleTypes.map(item => option(item.value, item.label)).join('')}</select>
    <details class="menu" id="filters-menu"><summary class="btn secondary" id="filters-button">Filters</summary><div class="menu-list">
      <label class="control"><span>Freshness</span><select id="fresh">${option('', 'Any Freshness')}${freshness.map(item => option(item.value, item.label)).join('')}</select></label>
      <span class="control score-range"><span>Score</span><input type="number" id="score-min" min="0" max="100" step="1" inputmode="numeric" placeholder="0" aria-label="Minimum Score"><span aria-hidden="true">–</span><input type="number" id="score-max" min="0" max="100" step="1" inputmode="numeric" placeholder="100" aria-label="Maximum Score"></span>
      ${contacted}<button type="button" class="btn secondary" id="clear-filters" hidden>Clear Filters</button>
    </div></details>${menuSlot ? MENU_SLOT : ''}
  </form>`;
}

export function renderBadge(badge) {
  const tone = badge.tone && badge.tone !== 'note' ? ` badge-${htmlEscape(badge.tone)}` : '';
  const title = badge.title ? ` title="${htmlEscape(badge.title)}"` : '';
  return `<span class="badge${tone}" data-badge="${htmlEscape(badge.key)}"${title}>${htmlEscape(badge.label)}</span>`;
}

export function renderScoreRing(score) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  return `<div class="ring" style="--score:${value}" role="img" aria-label="Best score ${value}"><b>${value}</b></div>`;
}

// Every item is shown; nothing is folded behind "N More" (Gaps / Verify is open by default).
function renderFacts(label, items, className) {
  if (!items.length) return '';
  return `<div class="facts-label">${htmlEscape(label)}</div><ul class="facts ${className}">${items.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul>`;
}

// One line per track, "Data 82", right-aligned; the highest score (every one of them when tied) stands out.
export function renderScores(card) {
  const parts = card.scores.map(score => `<span class="track${score.top ? ' top' : ''}" data-track="${htmlEscape(score.id)}">${htmlEscape(score.label)} <b>${score.value}</b></span>`);
  return `<div class="scores">${parts.join('')}</div>`;
}

// The score block on the right of the card head: every track's score, then the ring.
function renderScoreBlock(card) {
  return `<div class="job-score">${renderScores(card)}${renderScoreRing(card.bestScore)}</div>`;
}

// Card actions are links, or buttons carrying data attributes for a page script to drive.
function renderAction(action) {
  const className = htmlEscape(action.className || 'btn secondary');
  if (action.button) {
    const data = Object.entries(action.data || {}).map(([key, value]) => ` data-${htmlEscape(key)}="${htmlEscape(value)}"`).join('');
    const pressed = action.pressed == null ? '' : ` aria-pressed="${action.pressed ? 'true' : 'false'}"`;
    const title = action.title ? ` title="${htmlEscape(action.title)}"` : '';
    return `<button type="button" class="${className}"${data}${pressed}${title}${action.disabled ? ' disabled' : ''}>${htmlEscape(action.label)}</button>`;
  }
  const download = action.download == null ? '' : action.download ? ` download="${htmlEscape(action.download)}"` : ' download';
  return `<a class="${className}" href="${htmlEscape(action.href)}"${download}${action.newTab ? ` ${EXTERNAL_LINK}` : ''}>${htmlEscape(action.label)}</a>`;
}

// "Check N Details" at the right end of the posting line: only when the letter's editor left something the
// owner must confirm; it opens the letter page. Grey (badge-muted, data-seen) once that page has been opened.
function renderCheck(check) {
  if (!check) return '';
  const title = check.title ? ` title="${htmlEscape(check.title)}"` : '';
  return `<a class="badge ${check.seen ? 'badge-muted' : 'badge-warn'} job-check" data-badge="letter-check"${check.seen ? ' data-seen="1"' : ''} href="${htmlEscape(check.href)}"${title}>${htmlEscape(check.label)}</a>`;
}

// The folded Job Description with its copy icon in the summary (the page script copies the whole JD as
// markup and plain text; the click never opens or closes the fold).
function renderDescription(card) {
  if (card.descriptionComplete === false) return `<p class="jd-missing">${INCOMPLETE_DESCRIPTION_LABEL} · <a ${EXTERNAL_LINK} href="${htmlEscape(card.url)}">Open Posting</a></p>`;
  if (!card.description) return '';
  const summary = `<summary><span>Job Description</span><button type="button" class="jd-copy" aria-label="${COPY_DESCRIPTION_LABEL}" title="${COPY_DESCRIPTION_LABEL}">${COPY_ICON}</button></summary>`;
  // The posting's own paragraphs, headings, lists and bold (cleaned markup from src/jd-html.mjs), or plain
  // text split at its line breaks. The hub embeds only the first characters of a long JD as text and loads the
  // markup when the section is opened (data-jd-src, REPORTS_SCRIPT); the Desktop file always carries the whole JD.
  return card.descriptionSrc
    ? `<details class="jd" data-jd-src="${htmlEscape(card.descriptionSrc)}">${summary}<div class="jd-body"><p>${htmlEscape(card.descriptionPreview)}</p></div></details>`
    : `<details class="jd">${summary}<div class="jd-body">${card.descriptionHtml ?? `<p>${htmlEscape(card.description)}</p>`}</div></details>`;
}

// Card layout, top to bottom (2026-11-15): company · title (left) with the scores and the ring (right);
// location · role type · posting time, with "Check N Details" at the right end; badges and Gaps / Verify when
// there are any; the Job Description (folded, copy icon); the action row (Open Posting, then the hub's letter
// and Message to Recruiters actions); the source line and other listings.
export function renderJobCard(card) {
  const attributes = [
    `data-score="${card.sort.score}"`,
    `data-company="${htmlEscape(card.sort.company)}"`,
    `data-posted="${card.sort.posted}"`,
    `data-role="${htmlEscape(card.roleType)}"`,
    `data-track="${htmlEscape(card.recommendedTrack)}"`,
    `data-search="${htmlEscape(card.sort.search)}"`,
    `data-freshness="${htmlEscape(card.freshnessKey || '')}"`,
    ...Object.entries(card.flags || {}).map(([key, value]) => `data-${htmlEscape(key)}="${htmlEscape(value)}"`),
  ].join(' ');
  const badges = card.badges.length ? `<div class="badges">${card.badges.map(renderBadge).join('')}</div>` : '';
  const posted = card.posted ? `<span class="sep">·</span><span class="meta"${card.footnoteTitle ? ` title="${htmlEscape(card.footnoteTitle)}"` : ''}>${htmlEscape(card.posted)}</span>` : '';
  const alternates = card.alternates?.length ? `<p class="alternates">Also listed at: ${card.alternates.map(item => `<a ${EXTERNAL_LINK} href="${htmlEscape(item.url)}" title="${htmlEscape(item.label)}">${htmlEscape(new URL(item.url).hostname.replace(/^www\./, ''))}${item.label ? ` (${htmlEscape(item.label)})` : ''}</a>`).join(', ')}</p>` : '';
  const source = card.source ? `<p class="job-foot">Source: ${htmlEscape(card.source)}</p>` : '';
  return `<article class="job" ${attributes}>
    <div class="job-body">
      <div class="job-head">
        <div class="job-main">
          <h2 class="job-title"><span class="company">${htmlEscape(card.company)}</span><span class="dot"> · </span><a ${EXTERNAL_LINK} href="${htmlEscape(card.url)}">${htmlEscape(card.title)}</a></h2>
          <p class="job-meta"><span>${htmlEscape(card.location)}</span><span class="sep">·</span><span>${htmlEscape(card.roleLabel)}</span>${posted}${renderCheck(card.check)}</p>
        </div>
        ${renderScoreBlock(card)}
      </div>
      ${badges}
      ${renderFacts('Gaps / Verify', card.gaps, 'gaps')}
      ${renderDescription(card)}
      <div class="actions"><a class="apply" ${EXTERNAL_LINK} href="${htmlEscape(card.url)}">Open Posting</a>${(card.actions || []).map(renderAction).join('')}</div>
      ${source}${alternates}
    </div>
  </article>`;
}

export function renderRunDetails({ rows }) {
  const items = rows.map(row => {
    const list = row.items?.length ? `<ul>${row.items.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul>` : '';
    // A long list the owner may want to audit (the postings a pre-screen dropped) stays folded.
    const folded = row.folded?.items?.length
      ? `<details class="more run-list"${row.folded.id ? ` id="${htmlEscape(row.folded.id)}"` : ''}><summary>${htmlEscape(row.folded.summary)}</summary><ul>${row.folded.items.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul></details>`
      : '';
    return `<dt>${htmlEscape(row.term)}</dt><dd>${htmlEscape(row.detail)}${list}${folded}</dd>`;
  }).join('');
  return `<details class="run" id="run-details"><summary>Run Details</summary><dl>${items}</dl></details>`;
}

export function renderEmptyState(message) {
  return `<div class="empty">${htmlEscape(message)}</div>`;
}

// Everything between <main> and </main>: the hub embeds this inside its own shell.
export function renderReportBody(view) {
  const carried = view.carried?.cards?.length ? view.carried : null;
  // A group with no postings is not shown at all, the main list included when other groups hold matches.
  const main = view.cards.length ? `<section class="jobs" id="jobs">${view.cards.map(renderJobCard).join('\n')}</section>` : '';
  // Postings the review budget carried from an earlier run: their own group under the main list.
  const carriedGroup = carried
    ? `<h2 class="group-title" id="carried-over">${htmlEscape(carried.title)} <span class="group-count">(${carried.cards.length})</span></h2><section class="jobs carried" id="jobs-carried">${carried.cards.map(renderJobCard).join('\n')}</section>`
    : '';
  const list = view.cards.length || carried
    ? `${main}${carriedGroup}<div class="empty" id="no-results" hidden>No matches for the current filters.</div>`
    : renderEmptyState(view.emptyMessage);
  // Postings no model reviewed: folded at the bottom, outside the match list (a div, not section.jobs, so the
  // page script's sort, filter, and count leave them out).
  const notReviewed = view.notReviewed?.cards?.length ? view.notReviewed : null;
  const notReviewedGroup = notReviewed
    ? `<details class="run" id="not-reviewed"><summary>${htmlEscape(notReviewed.title)} <span class="group-count">(${notReviewed.cards.length})</span></summary><p class="group-note">${htmlEscape(notReviewed.note)}</p><div class="jobs" id="jobs-not-reviewed">${notReviewed.cards.map(renderJobCard).join('\n')}</div></details>`
    : '';
  // The signed-out and not-reviewed lines stand out (the stylesheet is shared with older pages, so inline).
  const alert = 'style="background:var(--bad-bg);color:var(--bad-ink);font-weight:650"';
  // A quota limit that touched the run gets one line under the bar: how many postings it held back and which
  // engine or model took over.
  const quotaNote = view.quotaNote ? `<p class="quota-note" data-quota-note>${htmlEscape(view.quotaNote)}</p>` : '';
  return `${renderToolbar(view.toolbar)}
${quotaNote}${view.integrityBanner ? `<div class="banner" data-banner="integrity">${htmlEscape(view.integrityBanner)}</div>` : ''}${view.networkBanner ? `<div class="banner" data-banner="network">${htmlEscape(view.networkBanner)}</div>` : ''}${view.notReviewedBanner ? `<div class="banner" data-banner="not-reviewed" ${alert}>${htmlEscape(view.notReviewedBanner)}</div>` : ''}
${view.authBanner ? `<div class="banner" data-banner="auth" ${alert}>${htmlEscape(view.authBanner)}</div>` : ''}${view.banner ? `<div class="banner" data-banner="quota">${htmlEscape(view.banner)}</div>` : ''}
${list}${notReviewedGroup}
${renderRunDetails(view.runDetails)}
<footer class="foot">${htmlEscape(view.footer)}</footer>`;
}

export function renderReportPage(view) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(view.tabTitle || `${view.title} — ${view.dateLabel}`)}</title>
<style>${REPORT_STYLES}</style></head>
<body><main class="page">
${renderReportBody(view)}
</main>
<script>${REPORT_SCRIPT}</script>
</body></html>`;
}

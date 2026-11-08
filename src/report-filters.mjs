// The report filter bar's state and rules, shared by the page script (REPORT_SCRIPT injects these functions
// through toString) and the tests. The state lives in the URL query, so a refresh or a shared link opens the
// same view: ?q=&sort=&resume=&role=&freshness=&min=&max=&hideContacted=1&hideApplied=1. Defaults are left
// out of the URL, and any other parameter is kept as it was.

export const DEFAULT_FILTERS = { q: '', sort: 'score', resume: '', role: '', freshness: '', min: '', max: '', hideContacted: false, hideApplied: false };

// "date only" → "date-only": the value cards carry in data-freshness and the Freshness select uses.
export function freshnessKey(label) {
  return String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// The filter state from a query string ("?role=internship&min=80"); unknown or malformed values fall back to
// the defaults.
export function readFilters(search) {
  var params = new URLSearchParams(search || '');
  var score = function (value) {
    var text = String(value == null ? '' : value).trim();
    if (!/^\d{1,3}$/.test(text)) return '';
    return String(Math.min(100, Number(text)));
  };
  return {
    q: String(params.get('q') || '').slice(0, 200),
    sort: ['score', 'company', 'posted'].indexOf(params.get('sort')) >= 0 ? params.get('sort') : 'score',
    resume: String(params.get('resume') || ''),
    role: String(params.get('role') || ''),
    freshness: String(params.get('freshness') || ''),
    min: score(params.get('min')),
    max: score(params.get('max')),
    hideContacted: params.get('hideContacted') === '1',
    hideApplied: params.get('hideApplied') === '1',
  };
}

// The query string for a filter state, starting from the current one so other parameters survive; '' when
// nothing is left.
export function writeFilters(state, search) {
  var params = new URLSearchParams(search || '');
  ['q', 'sort', 'resume', 'role', 'freshness', 'min', 'max', 'hideContacted', 'hideApplied'].forEach(function (key) { params.delete(key); });
  if (state.q && String(state.q).trim()) params.set('q', String(state.q).trim());
  if (state.sort && state.sort !== 'score') params.set('sort', state.sort);
  if (state.resume) params.set('resume', state.resume);
  if (state.role) params.set('role', state.role);
  if (state.freshness) params.set('freshness', state.freshness);
  if (state.min !== '' && state.min != null) params.set('min', String(state.min));
  if (state.max !== '' && state.max != null) params.set('max', String(state.max));
  if (state.hideContacted) params.set('hideContacted', '1');
  if (state.hideApplied) params.set('hideApplied', '1');
  var text = params.toString();
  return text ? '?' + text : '';
}

// Whether a card (its data attributes: score, role, track, search, freshness, contacted, applied) passes.
export function cardPasses(card, state) {
  var term = String(state.q || '').trim().toLowerCase();
  var score = parseFloat(card.score);
  if (state.role && card.role !== state.role) return false;
  if (state.resume && card.track !== state.resume) return false;
  if (state.freshness && card.freshness !== state.freshness) return false;
  if (state.min !== '' && state.min != null && !(score >= Number(state.min))) return false;
  if (state.max !== '' && state.max != null && !(score <= Number(state.max))) return false;
  if (state.hideContacted && card.contacted === '1') return false;
  if (state.hideApplied && card.applied === '1') return false;
  if (term && String(card.search || '').indexOf(term) < 0) return false;
  return true;
}

export function filtersActive(state) {
  return Boolean(String(state.q || '').trim() || state.resume || state.role || state.freshness || state.min !== '' || state.max !== '' || state.hideContacted || state.hideApplied);
}

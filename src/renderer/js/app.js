/* =========================================================================
   Renderer. Plain ES2022, no framework, no bundler.

   Two rules that matter here:
   1. Business names and addresses are third-party strings from the Places API.
      Everything user-visible is built with createElement + textContent. There
      is no innerHTML in this file and there should never be one.
   2. This file makes no network calls. Every request goes through
      window.assay, which is the preload bridge, so it runs in main where
      it can be logged as evidence.
   ========================================================================= */

'use strict';

const api = window.assay;

const state = {
  view: 'scan',
  candidates: [],
  nextPageToken: null,
  lastQuery: null,
  lastLimit: null,
  busy: false,
  config: null,
  /** scan-<ISO date>-<random>. Generated once per scan, reused for every
   *  candidate checked within that scan (see runScan / runCandidateCheck). */
  scanId: null,
  /** Approval queue rows from approval:queue, newest read wins. */
  queue: [],
  /** Which queue row the counter is showing. One at a time, on purpose. */
  selectedItemId: null,
  /**
   * Prospects whose decided work the operator filed away, by slug. View state
   * only, held in localStorage: the ledger records decisions and this records
   * what the operator is done looking at, which are different facts. A slug
   * with anything waiting or needing attention is restored automatically, so
   * archiving can never hide work the gate wants eyes on.
   */
  archivedSlugs: null,
  /** Whether the archived section at the bottom of the rail is expanded. */
  showArchived: false,
  /**
   * Confirmations made in THIS session, newest first.
   *
   * Approving re-runs releasable() in main, which needs the confirmed findings
   * and the timestamp. They are held here rather than in the ledger because a
   * confirmation is deliberately perishable: it expires 72 hours after it was
   * made, and the house rule is a re-verify the morning of any send. Persisting
   * it would make a stale confirmation look live across a restart, which is
   * exactly what the expiry exists to prevent.
   */
  confirmations: [],
};

const $ = (sel) => document.querySelector(sel);

/** Status surface for the Settings view; the Scan view uses the default. */
const SETTINGS_STATUS = '#settings-status';

const el = (tag, opts = {}) => {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  return node;
};

/**
 * Mirrors shared/types.ts Severity: hook quality 0..4, never technical
 * severity. Kept in lockstep with FlawFinding.severity by hand, same as
 * KEY_FIELDS mirrors AppConfig['keys'] below, no bundler, so no shared import.
 */
const SEVERITY_WORDS = ['CLEAN', 'MINOR', 'NOTABLE', 'BAD', 'WORST'];

/**
 * Mirrors src/main/checks/registry.ts's FlawCheck.label per checkId, and
 * shared/types.ts's FlawId union. No bundler, so this is kept in step by hand,
 * the same way KEY_FIELDS mirrors AppConfig['keys'].
 */
const CHECK_LABELS = {
  website: 'Website exists and works',
  freshness: 'Content freshness and dating',
  'ai-readiness': 'AI readiness',
  'crawl-index': 'Crawl and index gate',
  'booking-path': 'Booking path',
  'nap-consistency': 'NAP consistency',
};

function checkLabel(checkId) {
  return CHECK_LABELS[checkId] || String(checkId).replace(/-/g, ' ');
}

/** scan-<ISO date>-<random>, generated once per scan and stored on state. */
function newScanId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `scan-${new Date().toISOString()}-${rand}`;
}

/** Defensive sanitizer for using a candidate's placeId inside a DOM id. */
function safeId(raw) {
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// --- Views -----------------------------------------------------------------

function showView(name) {
  state.view = name;
  $('#view-scan').hidden = name !== 'scan';
  $('#view-approvals').hidden = name !== 'approvals';
  $('#view-settings').hidden = name !== 'settings';
  $('#view-help').hidden = name !== 'help';
  for (const btn of document.querySelectorAll('.app-nav .btn')) {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  }
  // The ledger is written by the main process and can change under us, so the
  // queue is re-read on entry rather than trusted from the last visit.
  if (name === 'approvals') void loadApprovals();
  // Coming back to the scan view re-measures an open map, in case the window
  // was resized while the panel sat display:none.
  if (name === 'scan' && window.assayMap) window.assayMap.refresh();
}

// --- Status ----------------------------------------------------------------

function clearStatus(target = '#scan-status') {
  $(target).replaceChildren();
}

/**
 * Builds the same DOM setStatus renders into a target selector, but returns
 * the node instead of placing it. The confirmation panel needs this: the
 * release verdict and paste-notice boxes sit inline inside the findings
 * panel rather than in one of the named status targets, but they are visibly
 * the same kind of box as every other status message in the app.
 */
function statusBox(kind, title, body, detail, extraClass) {
  const className = `status status--${kind}${extraClass ? ` ${extraClass}` : ''}`;
  const box = el('div', { className });
  const row = el('div', { className: 'status__row' });
  if (kind === 'working') row.appendChild(el('span', { className: 'spinner' }));
  row.appendChild(el('div', { className: 'status__title', text: title }));
  box.appendChild(row);
  if (body) box.appendChild(el('p', { text: body }));
  if (detail) box.appendChild(el('div', { className: 'status__detail', text: detail }));
  return box;
}

function setStatus(kind, title, body, detail, target = '#scan-status') {
  $(target).replaceChildren(statusBox(kind, title, body, detail));
}

/**
 * Every IPC call site must route failures through here.
 *
 * The Save button originally did `if (res.ok) { ... }` with no else, so when
 * the whole IPC layer was returning bad_request on every call, the UI showed
 * absolutely nothing and the bug read as "saving does nothing". A typed error
 * that never reaches a human is the same as no error handling at all.
 *
 * Returns res.ok so call sites can `if (!ok(res)) return;`.
 */
function handled(res, whatFailed, target = '#scan-status') {
  if (res && res.ok) {
    clearStatus(target);
    return true;
  }
  const error = (res && res.error) || {
    kind: 'internal',
    message: 'The app got no response from its main process.',
  };
  const { title, body } = describeError(error);
  setStatus('error', `${whatFailed}, ${title}`, body, error.detail, target);
  return false;
}

/** Turns a typed Err from main into a message that says what to actually do. */
function describeError(error) {
  const nextStep = {
    config: 'Open Settings and add the key.',
    auth: 'Check the key is correct and not restricted to other APIs or referrers.',
    not_enabled: 'Enable "Places API (New)" on the Google Cloud project, then retry.',
    quota: 'You are rate limited or over quota. Wait, or check billing.',
    transport: 'Network problem. Check the connection and retry.',
    bad_request: 'The app sent something the API rejected. This is a bug worth reporting.',
    not_found: 'Nothing matched.',
    internal: 'Something failed inside the app.',
  }[error.kind];

  return { title: error.kind.replace(/_/g, ' ').toUpperCase(), body: `${error.message} ${nextStep || ''}`.trim() };
}

// --- Results ---------------------------------------------------------------

/**
 * `target` is optional. Existing call sites (the results table's website
 * column) omit it and keep the original fire-and-forget click exactly as
 * before. New call sites that pass a target get the failure routed through
 * handled(), per the no-swallowed-IPC-error rule.
 */
function externalButton(label, url, target) {
  const btn = el('button', { className: 'linkish', text: label, attrs: { type: 'button' } });
  btn.addEventListener('click', async () => {
    if (!target) {
      api.app.openExternal(url);
      return;
    }
    let res;
    try {
      res = await api.app.openExternal(url);
    } catch (e) {
      res = {
        ok: false,
        error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
      };
    }
    handled(res, 'Opening the link failed', target);
  });
  return btn;
}

function renderCandidateRow(c, index) {
  const tr = el('tr', { className: 'cand-row' });
  tr.dataset.placeId = c.placeId;

  tr.appendChild(el('td', { className: 'cell-idx', text: String(index + 1) }));

  const nameCell = el('td');
  nameCell.appendChild(el('div', { className: 'cell-name', text: c.name }));
  if (c.address) nameCell.appendChild(el('div', { className: 'cell-addr', text: c.address }));
  tr.appendChild(nameCell);

  const siteCell = el('td');
  if (c.website) {
    let host = c.website;
    try {
      host = new URL(c.website).hostname.replace(/^www\./, '');
    } catch {
      /* keep the raw string */
    }
    siteCell.appendChild(externalButton(host, c.website));
  } else {
    siteCell.className = 'bad';
    siteCell.appendChild(el('b', { text: 'NONE LISTED' }));
  }
  tr.appendChild(siteCell);

  const phoneCell = el('td');
  if (c.phone) {
    phoneCell.appendChild(el('span', { className: 'mono', text: c.phone }));
  } else {
    phoneCell.className = 'mid';
    phoneCell.appendChild(el('b', { text: 'NONE' }));
  }
  tr.appendChild(phoneCell);

  const revCell = el('td', { className: 'mono' });
  if (c.reviewCount != null) {
    const rating = c.rating != null ? c.rating.toFixed(1) : '?';
    revCell.textContent = `${rating} · ${c.reviewCount}`;
  } else {
    revCell.textContent = ',';
  }
  tr.appendChild(revCell);

  const statusCell = el('td', { className: 'mono' });
  const bs = c.businessStatus || 'UNKNOWN';
  statusCell.textContent = bs === 'OPERATIONAL' ? 'OPEN' : bs.replace(/_/g, ' ');
  if (bs !== 'OPERATIONAL') statusCell.classList.add('mid');
  tr.appendChild(statusCell);

  const checkCell = el('td', { className: 'cell-check' });
  const checkBtn = el('button', {
    className: 'btn btn--ghost',
    text: 'Check',
    attrs: { type: 'button', 'data-tip': 'Run the six flaw checks against the fetched page source. Findings start REMOTE.' },
  });
  const checkSpin = el('span', { className: 'spinner' });
  checkSpin.hidden = true;
  checkCell.appendChild(checkBtn);
  checkCell.appendChild(checkSpin);
  checkBtn.addEventListener('click', () => void runGatedCandidateCheck(c, tr, checkBtn, checkSpin));
  tr.appendChild(checkCell);

  return tr;
}

function renderResults(append) {
  const body = $('#results-body');
  if (!append) body.replaceChildren();

  // Counts only candidate rows, not the expandable .panel-row siblings a
  // Check click inserts after them, those would otherwise throw this count
  // off and corrupt the append math on the next "Load more".
  const start = append ? body.querySelectorAll('tr.cand-row').length : 0;
  const slice = state.candidates.slice(start);
  for (let i = 0; i < slice.length; i++) {
    body.appendChild(renderCandidateRow(slice[i], start + i));
  }

  $('#results-wrap').hidden = state.candidates.length === 0;
  $('#results-band').hidden = state.candidates.length === 0;
  $('#load-more').hidden = !state.nextPageToken;
  $('#results-title').textContent =
    `${state.candidates.length} CANDIDATE${state.candidates.length === 1 ? '' : 'S'}`;

  // The map mirrors this table. The toggle only offers itself when at least
  // one row has coordinates to show; render() is cheap while the panel is
  // closed (no Leaflet exists until the first open). When nothing has
  // coordinates the panel closes too, or hiding the toggle would strand it
  // open with no way to dismiss it.
  const hasPins = state.candidates.some((c) => c.location);
  $('#map-toggle').hidden = !hasPins;
  if (window.assayMap) {
    if (!hasPins) window.assayMap.hide();
    window.assayMap.render(state.candidates, selectCandidateRow);
  }
}

/**
 * A pin's SELECT lands here: highlight the row and bring it into view. The
 * row keeps sole ownership of launching a check.
 */
function selectCandidateRow(placeId) {
  for (const row of document.querySelectorAll('#results-body tr.cand-row')) {
    const hit = row.dataset.placeId === placeId;
    row.classList.toggle('is-map-selected', hit);
    if (hit) row.scrollIntoView({ block: 'center' });
  }
}

// --- Scan ------------------------------------------------------------------

async function runScan(append) {
  if (state.busy) return;

  // Places API (New) rejects a pageToken whose sibling params differ from the
  // request that produced it, so a "load more" must replay the original query
  // verbatim rather than re-reading the form the user may have edited since.
  const city = append && state.lastQuery ? state.lastQuery.city : $('#f-city').value.trim();
  const category = append && state.lastQuery ? state.lastQuery.category : $('#f-category').value.trim();
  const limit = append && state.lastLimit != null ? state.lastLimit : Number($('#f-limit').value);

  if (!city || !category) {
    setStatus('error', 'MISSING INPUT', 'Enter both a city and a business category.');
    return;
  }

  state.busy = true;
  $('#scan-go').disabled = true;
  $('#load-more').disabled = true;
  setStatus('working', append ? 'LOADING MORE…' : 'CALLING THE PLACES API…',
    `"${category} in ${city}"`);

  const req = { city, category, limit };
  if (append && state.nextPageToken) req.pageToken = state.nextPageToken;

  let res;
  try {
    res = await api.discover.search(req);
  } catch (e) {
    res = { ok: false, error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) } };
  }

  state.busy = false;
  $('#scan-go').disabled = false;
  $('#load-more').disabled = false;

  if (!res || !res.ok) {
    const error = (res && res.error) || { kind: 'internal', message: 'Unknown failure.' };
    const { title, body } = describeError(error);
    setStatus('error', title, body, error.detail);
    return;
  }

  const data = res.data;
  if (!append) {
    state.candidates = [];
    state.scanId = newScanId();
    // A fresh scan is a fresh area; the map re-frames its new pins.
    if (window.assayMap) window.assayMap.resetView();
  }
  state.candidates = state.candidates.concat(data.candidates);
  state.nextPageToken = data.nextPageToken;
  state.lastQuery = data.query;
  if (!append) state.lastLimit = limit;

  if (state.candidates.length === 0) {
    clearStatus();
    setStatus('empty', 'NO MATCHES',
      `The Places API returned nothing for "${data.query.textQuery}". Try a broader category or a nearby city.`);
    $('#results-wrap').hidden = true;
    $('#results-band').hidden = true;
    $('#map-toggle').hidden = true;
    if (window.assayMap) window.assayMap.hide();
    return;
  }

  clearStatus();
  $('#results-note').textContent = data.quotaNote;
  $('#quota-detail').textContent = data.quotaDetail || '';
  renderResults(append);
}

// --- Flaw checks -------------------------------------------------------------

/**
 * Finds (or lazily creates) the <tr class="panel-row"> that holds one
 * candidate's findings, always the row immediately after its <tr
 * class="cand-row">. Re-running a check reuses the same row rather than
 * stacking a duplicate under the candidate.
 */
function ensurePanelRow(tr, id) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('panel-row') && next.dataset.panelFor === id) {
    return next;
  }

  const panelRow = el('tr', { className: 'panel-row' });
  panelRow.dataset.panelFor = id;

  const td = el('td', { attrs: { colspan: '7' } });
  const panel = el('div', { className: 'block panel' });
  // Doubles as the working/error status slot (via setStatus/handled) and,
  // later, the target for any "opening this evidence link failed" error.
  panel.appendChild(el('div', { attrs: { id: `panel-status-${id}` } }));
  panel.appendChild(el('div', { className: 'panel-results' }));
  td.appendChild(panel);
  panelRow.appendChild(td);

  tr.after(panelRow);
  return panelRow;
}

/**
 * Policy gate in front of every check run. A candidate on the permanent
 * off-limits list never reaches runCandidateCheck at all, no bytes are
 * fetched, no evidence is written. A pacing warning is shown but does not
 * block: pacing is a judgement call the operator makes, not a hard stop.
 */
async function runGatedCandidateCheck(candidate, tr, btn, spin) {
  const id = safeId(candidate.placeId);
  const statusTarget = `#panel-status-${id}`;
  ensurePanelRow(tr, id);

  btn.disabled = true;
  spin.hidden = false;
  setStatus('working', 'CHECKING POLICY…', candidate.name, null, statusTarget);

  let res;
  try {
    res = await api.policy.check(candidate);
  } catch (e) {
    res = {
      ok: false,
      error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
    };
  }

  if (!handled(res, 'Checking policy failed', statusTarget)) {
    btn.disabled = false;
    spin.hidden = true;
    return;
  }

  const verdict = res.data;
  if (verdict.blocked) {
    tr.classList.add('row-disqualified');
    setStatus(
      'error',
      'BLOCKED',
      verdict.blockReason || 'This candidate is on the permanent off-limits list.',
      null,
      statusTarget
    );
    btn.disabled = false;
    spin.hidden = true;
    return;
  }

  if (verdict.pacingWarning) {
    setStatus('working', 'PACING WARNING', verdict.pacingWarning, null, statusTarget);
  }

  await runCandidateCheck(candidate, tr, btn, spin);
}

async function runCandidateCheck(candidate, tr, btn, spin) {
  const id = safeId(candidate.placeId);
  const statusTarget = `#panel-status-${id}`;
  const panelRow = ensurePanelRow(tr, id);
  const resultsEl = panelRow.querySelector('.panel-results');

  btn.disabled = true;
  spin.hidden = false;
  resultsEl.replaceChildren();
  setStatus('working', 'RUNNING CHECKS…', candidate.name, null, statusTarget);

  let res;
  try {
    res = await api.checks.run({ candidate, scanId: state.scanId });
  } catch (e) {
    res = {
      ok: false,
      error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
    };
  }

  btn.disabled = false;
  spin.hidden = true;

  if (!handled(res, 'Running checks failed', statusTarget)) return;

  tr.classList.toggle('row-disqualified', res.data.disqualified);
  renderFindingsPanel(resultsEl, res.data, statusTarget);
}

function confirmationBadge(finding) {
  if (finding.confirmation === 'operator-confirmed') {
    return el('span', { className: 'badge badge--sev0', text: 'CONFIRMED BY YOUR SOURCE' });
  }
  if (finding.confirmation === 'diverged') {
    return el('span', { className: 'chip red', text: 'DIVERGED: CLAIM VOID' });
  }
  // 'remote' is the default for every machine-produced finding, and the one
  // that matters most: this app's crawler is not the operator's browser.
  return el('span', { className: 'chip red', text: 'REMOTE: NOT YET CONFIRMED' });
}

function renderFix(fix) {
  const box = el('div', { className: 'fix-block' });

  const head = el('div', { className: 'fix-block__head' });
  head.appendChild(el('span', { className: 'chip', text: 'THE FIX' }));
  head.appendChild(el('span', { className: 'chip', text: fix.effort.toUpperCase() }));
  box.appendChild(head);

  box.appendChild(el('p', { className: 'fix-block__summary', text: fix.summary }));

  if (fix.snippet) {
    const pre = el('pre', { className: 'mono fix-block__snippet' });
    pre.textContent = fix.snippet;
    box.appendChild(pre);
  }

  return box;
}

function renderEvidenceRow(ev, statusTarget) {
  const row = el('div', { className: 'evidence-row' });

  const statusText = ev.httpStatus != null ? `HTTP ${ev.httpStatus}` : 'NO RESPONSE';
  const sha = ev.sha256 ? ev.sha256.slice(0, 12) : 'no hash';
  row.appendChild(el('span', {
    className: 'evidence-row__meta mono',
    text: `${statusText} · ${ev.byteLength} bytes · ${sha}`,
  }));

  // Never storedPath, that is a local filesystem path, not a link.
  row.appendChild(externalButton(ev.url, ev.url, statusTarget));

  if (ev.transportError) {
    row.appendChild(el('span', { className: 'evidence-row__error mono', text: ev.transportError }));
  }

  return row;
}

function renderEvidenceList(evidenceList, statusTarget) {
  const box = el('div', { className: 'evidence-list' });
  box.appendChild(el('div', { className: 'evidence-list__label mono', text: 'EVIDENCE' }));
  for (const ev of evidenceList) box.appendChild(renderEvidenceRow(ev, statusTarget));
  return box;
}

function renderFinding(finding, statusTarget, divergences) {
  const box = el('div', { className: 'finding' });

  const head = el('div', { className: 'finding__head' });
  // A disqualified result has no meaningful severity, the candidate is not
  // being ranked at all, so a CLEAN..WORST badge here would just be noise.
  if (finding.status !== 'disqualified') {
    head.appendChild(el('span', {
      className: `badge badge--sev${finding.severity}`,
      text: SEVERITY_WORDS[finding.severity] || String(finding.severity),
    }));
  }
  head.appendChild(confirmationBadge(finding));
  box.appendChild(head);

  box.appendChild(el('div', { className: 'finding__check', text: checkLabel(finding.checkId) }));
  box.appendChild(el('div', { className: 'finding__headline', text: finding.headline }));
  if (finding.detail) box.appendChild(el('p', { className: 'finding__detail', text: finding.detail }));

  if (finding.fix) box.appendChild(renderFix(finding.fix));

  if (finding.evidence && finding.evidence.length) {
    box.appendChild(renderEvidenceList(finding.evidence, statusTarget));
  }

  if (finding.unverifiedNote) {
    const note = el('div', { className: 'finding__unverified' });
    note.appendChild(el('span', { className: 'tag', text: 'UNVERIFIED' }));
    note.appendChild(el('span', { text: finding.unverifiedNote }));
    box.appendChild(note);
  }

  if (finding.confirmation === 'diverged' && finding.divergenceNote) {
    box.appendChild(el('p', { className: 'finding__divergence mono', text: finding.divergenceNote }));
  }

  if (finding.confirmation === 'diverged' && divergences) {
    const match = divergences.find((d) => d.checkId === finding.checkId);
    if (match) box.appendChild(renderDivergenceCompare(match));
  }

  return box;
}

/**
 * Side-by-side of what the crawler saw versus what the operator's own
 * browser saw: status and severity only, the two numbers that decide
 * whether a claim is safe to send. Pulled from ConfirmResponse.divergences,
 * matched to a finding by checkId.
 */
function renderDivergenceCompare(div) {
  const wrap = el('div', { className: 'divergence-compare' });

  const crawlerCol = el('div', { className: 'divergence-compare__col' });
  crawlerCol.appendChild(el('div', { className: 'divergence-compare__label mono', text: 'CRAWLER SAW' }));
  crawlerCol.appendChild(el('div', {
    className: 'divergence-compare__status',
    text: String(div.crawler.status).toUpperCase(),
  }));
  crawlerCol.appendChild(el('div', { className: 'divergence-compare__sev mono', text: `Severity ${div.crawler.severity}` }));
  wrap.appendChild(crawlerCol);

  const opCol = el('div', { className: 'divergence-compare__col' });
  opCol.appendChild(el('div', { className: 'divergence-compare__label mono', text: 'YOUR BROWSER SAW' }));
  opCol.appendChild(el('div', {
    className: 'divergence-compare__status',
    text: String(div.operator.status).toUpperCase(),
  }));
  opCol.appendChild(el('div', { className: 'divergence-compare__sev mono', text: `Severity ${div.operator.severity}` }));
  wrap.appendChild(opCol);

  return wrap;
}

/**
 * Said once for the whole panel rather than repeated per finding, which
 * already carries its own confirmation chip. Shared between the initial
 * (all-remote) render and applyConfirmResult, which recomputes whether it is
 * still needed once some findings have moved to operator-confirmed/diverged.
 */
const REMOTE_FOOTER_NOTE =
  "REMOTE: what this app's crawler received is not necessarily what the operator sees in view-source. " +
  'Nothing can be generated or sent from an unconfirmed finding.';

function renderFindingsPanel(container, data, statusTarget) {
  container.replaceChildren();

  if (data.disqualified) {
    container.appendChild(el('span', { className: 'chip red panel-disqualified', text: 'DISQUALIFIED: NOT A PROSPECT' }));
  }

  const list = el('div', { className: 'findings-list' });
  for (const finding of data.findings) list.appendChild(renderFinding(finding, statusTarget));
  container.appendChild(list);

  // The single most important thing on this panel: a REMOTE finding is what
  // this app's crawler received, not necessarily what the operator sees in
  // their own browser, and nothing here can be generated or sent until an
  // operator paste confirms it. Said once for the whole panel rather than
  // repeated per finding, which already carries its own chip.
  if (data.findings.some((f) => f.confirmation === 'remote')) {
    container.appendChild(el('p', { className: 'panel-footer-note mono', text: REMOTE_FOOTER_NOTE }));
  }

  // The CONFIRM control. Always present once a check run produced at least
  // one finding, disqualified candidates still get one (their 'website'
  // finding), and there is no reason to hide the door to confirmation just
  // because this run happened not to flag anything. Guarded on data.candidate
  // because RunCheckResponse always carries one; only a hand-built sample
  // (scripts/preview.js's placeholder finding) would not, and there is
  // nothing to confirm against without a candidate to derive URLs from.
  if (data.findings.length && data.candidate) {
    container.appendChild(renderConfirmSection(container, data));
  }
}

// --- Confirmation ------------------------------------------------------------

/** Origin (scheme + host) that a candidate's robots/llms/sitemap URLs are built from. */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

const PASTE_LABELS = { homepage: 'Homepage', robots: 'robots.txt', llms: 'llms.txt', sitemap: 'sitemap.xml' };

/**
 * One paste box: a labelled mono textarea plus a small "open" button, per
 * the rule that every confirmable document is named by its exact URL rather
 * than a vague description of it.
 */
function renderPasteBox(def, statusTarget) {
  const box = el('div', { className: 'paste-box' });

  const head = el('div', { className: 'paste-box__head' });
  head.appendChild(el('span', { className: 'chip', text: def.label }));
  head.appendChild(el('span', { className: 'tag', text: def.required ? 'REQUIRED' : 'OPTIONAL' }));
  box.appendChild(head);

  const urlRow = el('div', { className: 'paste-box__url' });
  if (def.url) {
    urlRow.appendChild(el('span', { className: 'mono paste-box__url-text', text: def.url }));
    urlRow.appendChild(externalButton('open', def.url, statusTarget));
  } else {
    urlRow.appendChild(el('span', {
      className: 'mono paste-box__url-text',
      text: 'No URL could be derived for this candidate.',
    }));
  }
  box.appendChild(urlRow);

  box.appendChild(el('p', {
    className: 'paste-box__instr',
    text: 'Open it, press Ctrl+U, select all, and paste the page source below.',
  }));

  if (!def.required) {
    box.appendChild(el('p', {
      className: 'paste-box__optional mono',
      text: 'OPTIONAL: recorded when supplied, UNVERIFIED if omitted.',
    }));
  }

  const textarea = el('textarea', {
    className: 'mono paste-box__input',
    attrs: {
      rows: '6',
      spellcheck: 'false',
      placeholder: def.required
        ? 'Required, paste the exact page source here.'
        : 'Optional, paste the exact page source here.',
    },
  });
  box.appendChild(textarea);

  return { box, textarea };
}

/** Missing required pastes, and pastes that look like an escaped view-source wrapper. */
function renderPasteNotices(missingPastes, suspectPastes) {
  const missing = missingPastes || [];
  const suspect = suspectPastes || [];
  if (!missing.length && !suspect.length) return null;

  const wrap = el('div', { className: 'confirm-notices' });
  if (missing.length) {
    wrap.appendChild(statusBox(
      'error',
      'REQUIRED DOCUMENTS NOT SUPPLIED',
      `${missing.map((k) => PASTE_LABELS[k] || k).join(', ')}, required to confirm this packet, and not pasted.`
    ));
  }
  if (suspect.length) {
    wrap.appendChild(statusBox(
      'error',
      'A PASTE LOOKS LIKE AN ESCAPED VIEW-SOURCE WRAPPER',
      `${suspect.map((k) => PASTE_LABELS[k] || k).join(', ')} looks like an escaped rendering (things like ` +
        '&lt;html&gt;) rather than the page source itself. Reopen the page, press Ctrl+U, select all, and paste that instead.'
    ));
  }
  return wrap;
}

/**
 * The CONFIRM control for one candidate's findings panel: a toggle that
 * reveals a paste box per document (homepage + robots required, llms +
 * sitemap optional, plus one for each extra page a site-wide score was read
 * from) and a submit button that stays disabled until both required
 * boxes are non-empty. Submitting calls confirm.run and hands the result to
 * applyConfirmResult, which updates the panel in place.
 */
function renderConfirmSection(container, data) {
  const candidate = data.candidate;
  const id = safeId(candidate.placeId);
  const statusTarget = `#panel-status-${id}`;

  const section = el('div', { className: 'confirm-section' });

  const toggleBtn = el('button', {
    className: 'btn btn--primary',
    text: 'Confirm',
    attrs: { type: 'button', 'data-tip': 'Reconcile these findings against your own view-source. Nothing generates or sends from this.' },
  });
  section.appendChild(toggleBtn);

  const form = el('div', { className: 'paste-form' });
  form.hidden = true;
  section.appendChild(form);

  toggleBtn.addEventListener('click', () => {
    form.hidden = !form.hidden;
  });

  if (!candidate.website) {
    form.appendChild(el('p', {
      text: 'This candidate has no website on file, so there is nothing to confirm against.',
    }));
    return section;
  }

  form.appendChild(el('p', {
    className: 'paste-form__intro',
    text:
      'Reconciles the findings above against your own browser. Nothing is generated or sent from this, ' +
      'it only decides whether a finding is safe to use.',
  }));

  const origin = originOf(candidate.website);
  const defs = [
    { kind: 'homepage', label: 'HOMEPAGE', url: candidate.website, required: true },
    { kind: 'robots', label: 'ROBOTS.TXT', url: origin ? `${origin}/robots.txt` : null, required: true },
    { kind: 'llms', label: 'LLMS.TXT', url: origin ? `${origin}/llms.txt` : null, required: false },
    { kind: 'sitemap', label: 'SITEMAP.XML', url: origin ? `${origin}/sitemap.xml` : null, required: false },
  ];

  // Additional same-origin pages the crawler read and scored, offered as paste
  // slots so a multi-page site's site-wide score can be reproduced from the
  // operator's own source. The list rides on the ai-readiness finding; a
  // single-page site has none, so no extra boxes appear.
  const aiFinding = data.findings.find((f) => f.checkId === 'ai-readiness');
  const pageDefs = (aiFinding && Array.isArray(aiFinding.extraPages) ? aiFinding.extraPages : []).map((u) => {
    let label = u;
    try {
      label = new URL(u).pathname || u;
    } catch {
      /* keep the raw url as the label */
    }
    return { kind: 'page', label, url: u, required: false };
  });

  const boxesWrap = el('div', { className: 'paste-boxes' });
  const entries = [];
  for (const def of defs) {
    const { box, textarea } = renderPasteBox(def, statusTarget);
    entries.push({ ...def, textarea });
    boxesWrap.appendChild(box);
  }
  if (pageDefs.length) {
    boxesWrap.appendChild(el('p', {
      className: 'paste-boxes__pages-note mono',
      text:
        'ADDITIONAL PAGES THE CRAWLER READ ACROSS THE SITE. Paste each to confirm the site-wide score; a ' +
        'page the score rests on that you leave blank keeps this finding unconfirmed rather than diverged.',
    }));
    for (const def of pageDefs) {
      const { box, textarea } = renderPasteBox(def, statusTarget);
      entries.push({ ...def, textarea });
      boxesWrap.appendChild(box);
    }
  }
  form.appendChild(boxesWrap);

  const submitRow = el('div', { className: 'paste-form__submit-row' });
  const submitBtn = el('button', {
    className: 'btn btn--primary',
    text: 'Submit for confirmation',
    attrs: {
      type: 'button',
      'data-tip': 'Re-run the checks against your pasted source, then mark each finding confirmed, diverged, or still remote.',
    },
  });
  const submitSpin = el('span', { className: 'spinner' });
  submitSpin.hidden = true;
  submitRow.appendChild(submitBtn);
  submitRow.appendChild(submitSpin);
  form.appendChild(submitRow);

  const refreshSubmitEnabled = () => {
    submitBtn.disabled = !entries.filter((e) => e.required).every((e) => e.textarea.value.trim() !== '');
  };
  for (const e of entries) e.textarea.addEventListener('input', refreshSubmitEnabled);
  refreshSubmitEnabled();

  submitBtn.addEventListener('click', async () => {
    const pastes = entries
      .filter((e) => e.textarea.value.trim() !== '')
      .map((e) => ({ kind: e.kind, url: e.url || '', content: e.textarea.value }));

    submitBtn.disabled = true;
    submitSpin.hidden = false;
    setStatus('working', 'CONFIRMING…', candidate.name, null, statusTarget);

    let res;
    try {
      res = await api.confirm.run({
        candidate,
        scanId: state.scanId,
        crawlerFindings: data.findings,
        pastes,
      });
    } catch (e) {
      res = {
        ok: false,
        error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
      };
    }

    submitSpin.hidden = true;
    refreshSubmitEnabled();

    if (!handled(res, 'Confirming failed', statusTarget)) return;

    applyConfirmResult(container, res.data, statusTarget, candidate);
    recordConfirmation(candidate, res.data);
  });

  return section;
}

/**
 * Applies a ConfirmResponse to an already-rendered findings panel in place:
 * the release verdict goes at the top, missing/suspect paste notices right
 * after it, and the findings list is replaced with the reconciled findings.
 * The confirm section itself (paste boxes and all) is left alone, so the
 * operator's pasted text survives and a second submission stays possible.
 */
function applyConfirmResult(container, data, statusTarget, candidate) {
  const verdict = statusBox(
    data.release.ok ? 'empty' : 'error',
    data.release.ok ? 'CONFIRMED AND RELEASABLE' : 'NOTHING CAN BE GENERATED OR SENT YET',
    data.release.ok
      ? `Confirmed at ${formatTimestamp(data.confirmedAt)}, expires 72 hours after this.`
      : (data.release.reason || 'This packet cannot be released.'),
    null,
    'release-verdict'
  );
  const existingVerdict = container.querySelector('.release-verdict');
  if (existingVerdict) existingVerdict.replaceWith(verdict);
  else container.prepend(verdict);

  const existingNotices = container.querySelector('.confirm-notices');
  if (existingNotices) existingNotices.remove();
  const notices = renderPasteNotices(data.missingPastes, data.suspectPastes);
  if (notices) verdict.after(notices);

  const list = container.querySelector('.findings-list');
  if (list) {
    list.replaceChildren();
    for (const finding of data.findings) list.appendChild(renderFinding(finding, statusTarget, data.divergences));
  }

  // Generation is offered ONLY once the gate says the packet is releasable,
  // and the button is rebuilt from that verdict every time rather than being
  // toggled, so a second confirmation that goes the other way removes it.
  const existingGen = container.querySelector('.generate-row');
  if (existingGen) existingGen.remove();
  if (data.release.ok && candidate) {
    container.appendChild(renderGenerateRow(candidate, data, statusTarget));
  }

  const existingFooter = container.querySelector('.panel-footer-note');
  const stillRemote = data.findings.some((f) => f.confirmation === 'remote');
  if (stillRemote && !existingFooter) {
    const note = el('p', { className: 'panel-footer-note mono', text: REMOTE_FOOTER_NOTE });
    const confirmSection = container.querySelector('.confirm-section');
    container.insertBefore(note, confirmSection || null);
  } else if (!stillRemote && existingFooter) {
    existingFooter.remove();
  }
}

/**
 * The generate control, shown only when the gate says the packet is releasable.
 *
 * It does not decide anything. `releasable()` has already run in main and will
 * run again inside generatePacket before a single file is written, so this is
 * an affordance rather than a gate, and it never re-implements the rule.
 * Whatever comes back has already been recorded in the approval queue as
 * PREPARED, which is why the success message points at Approvals rather than
 * claiming the work is done.
 */
function renderGenerateRow(candidate, data, statusTarget) {
  const row = el('div', { className: 'generate-row' });
  const btn = el('button', {
    className: 'btn btn--primary',
    text: 'Generate the packet',
    attrs: {
      type: 'button',
      'data-tip': 'Write the scorecard, schema kit and drafts, and record each as PREPARED in Approvals.',
    },
  });
  const note = el('p', {
    className: 'generate-row__note',
    text:
      'Writes the scan, scorecard, starter kit and delivery drafts, then records every one of them ' +
      'as prepared. Preparing is not approving: nothing can go anywhere until you clear it in Approvals.',
  });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    let res;
    try {
      res = await api.packet.generate({
        candidate,
        findings: data.findings,
        confirmedAt: data.confirmedAt,
      });
    } catch (e) {
      res = {
        ok: false,
        error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
      };
    }
    btn.disabled = false;
    // The refusal is main's. It knows whether the copy tripped a guardrail,
    // the confirmation expired, or the operator has not set their details.
    if (!handled(res, 'Generating the packet failed', statusTarget)) return;

    const n = res.data.artifacts.length;
    setStatus(
      'empty',
      `${n} ARTIFACT(S) PREPARED`,
      `Written to ${res.data.draftsDir}. They are in the approval queue as prepared, and nothing leaves until you approve them.`,
      null,
      statusTarget
    );
    // The nav count is the only thing that tells them work is waiting.
    void loadApprovals(false);
  });

  row.appendChild(btn);
  row.appendChild(note);
  return row;
}

// --- Settings --------------------------------------------------------------

// `unwired` fields have no consumer in this build. They used to accept a real
// API key and write it to disk where nothing would ever read it, under a label
// claiming they were a working fallback. A field that stores a secret nothing
// reads is a liability, and saying otherwise is a claim the app cannot back.
const KEY_FIELDS = [
  { id: 'googlePlaces', label: 'Google Places API key', phase: 'Phase 1 · discovery · needs Places API (New) + billing' },
  {
    id: 'anthropic', label: 'Anthropic API key',
    phase: 'Not wired up · the Agent SDK path is not built, so auto mode always uses the claude CLI',
    unwired: 'Run `claude login` instead. This key would never be read.',
  },
  {
    id: 'lob', label: 'Lob API key',
    phase: 'Not wired up · there is no sender in this build',
    unwired: 'Postcard sending is Phase 8. Nothing would read this key.',
  },
  {
    id: 'postgrid', label: 'PostGrid API key',
    phase: 'Not wired up · there is no sender in this build',
    unwired: 'Postcard sending is Phase 8. Nothing would read this key.',
  },
];

function renderKeys(cfg) {
  const list = $('#keys-list');
  list.replaceChildren();

  for (const f of KEY_FIELDS) {
    const st = cfg.keys[f.id];
    const row = el('div', { className: 'key-row' });

    const field = el('div', { className: 'field' });
    field.appendChild(el('label', { text: f.label, attrs: { for: `key-${f.id}` } }));
    const input = el('input', {
      attrs: {
        id: `key-${f.id}`,
        type: 'password',
        placeholder: st.present ? `•••• ${st.hint}` : 'not set',
        autocomplete: 'off',
        spellcheck: 'false',
      },
    });
    field.appendChild(input);
    row.appendChild(field);

    const meta = el('div', { className: 'key-row__meta' });
    const badge = el('span', {
      className: `badge badge--sev${st.present ? '0' : '3'}`,
      text: st.present ? `SET · ${st.source}` : 'NOT SET',
    });
    meta.appendChild(badge);
    row.appendChild(meta);

    if (f.unwired) {
      // No consumer exists, so the app refuses the secret rather than storing
      // it. The main process refuses it too; this is the visible half.
      input.disabled = true;
      input.setAttribute('placeholder', 'not accepted in this build');
    } else {
      const save = el('button', { className: 'btn btn--primary', text: 'Save', attrs: { type: 'button' } });
      save.addEventListener('click', async () => {
        if (input.value.trim() === '') {
          setStatus('empty', 'NOTHING TO SAVE', `Paste a value into ${f.label} first.`, null, SETTINGS_STATUS);
          return;
        }
        save.disabled = true;
        // A rejected invoke used to throw straight past this and leave the
        // button disabled for good, with the failure visible only in devtools.
        let res;
        try {
          res = await api.config.setKey(f.id, input.value);
        } catch (e) {
          res = { ok: false, error: { kind: 'internal', message: String(e && e.message ? e.message : e) } };
        }
        save.disabled = false;
        if (!handled(res, `Saving ${f.label} failed`, SETTINGS_STATUS)) return;
        input.value = '';
        applyConfig(res.data);
        setStatus('empty', 'SAVED', `${f.label} is stored on this machine.`, null, SETTINGS_STATUS);
      });
      row.appendChild(save);
    }

    if (st.source === 'config' && st.present) {
      const clear = el('button', { className: 'btn btn--ghost', text: 'Clear', attrs: { type: 'button' } });
      clear.addEventListener('click', async () => {
        let res;
        try {
          res = await api.config.setKey(f.id, '');
        } catch (e) {
          res = { ok: false, error: { kind: 'internal', message: String(e && e.message ? e.message : e) } };
        }
        if (!handled(res, `Clearing ${f.label} failed`, SETTINGS_STATUS)) return;
        applyConfig(res.data);
      });
      row.appendChild(clear);
    }

    row.appendChild(el('div', {
      className: 'key-row__phase',
      text: f.unwired ? `${f.phase}. ${f.unwired}` : f.phase,
    }));
    list.appendChild(row);
  }
}

function applyOperator(cfg) {
  const op = (cfg && cfg.operator) || { name: '', email: '', scannerUrl: '', brandVoice: '' };
  $('#f-op-name').value = op.name || '';
  $('#f-op-email').value = op.email || '';
  $('#f-op-scanner').value = op.scannerUrl || '';
  $('#f-op-voice').value = op.brandVoice || '';
  // Deliberately does NOT touch the brand fields. It used to, and saving your
  // details then re-rendered the accent box from stored config, silently
  // throwing away a colour you had typed but not yet saved. That is what
  // happened on the first real run of the brand feature.
}

/** The logo line only. Safe to call after any save; owns no text input. */
function applyLogoState(cfg) {
  const brand = (cfg && cfg.brand) || { accent: '', logo: '' };
  $('#brand-logo-state').textContent = brand.logo
    ? `Logo set (${String(brand.logo).toUpperCase()}), stored in your data folder`
    : 'No logo set';
}

/** Both, for the initial load and after an accent save. */
function applyBrand(cfg) {
  const brand = (cfg && cfg.brand) || { accent: '', logo: '' };
  $('#f-brand-accent').value = brand.accent || '';
  applyLogoState(cfg);
}

async function saveAccent() {
  const btn = $('#brand-save');
  btn.disabled = true;
  let res;
  try {
    res = await api.config.setAccent($('#f-brand-accent').value.trim());
  } catch (e) {
    res = { ok: false, error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) } };
  }
  btn.disabled = false;
  if (!handled(res, 'Saving the accent colour failed', SETTINGS_STATUS)) return;
  state.config = res.data;
  applyBrand(res.data);
  setStatus('empty', 'ACCENT SAVED', 'New documents use it. Ones already generated keep the colour they were made with.', undefined, SETTINGS_STATUS);
}

/** The picker opens in main; the renderer never handles a path. */
async function chooseLogo() {
  const btn = $('#brand-logo-choose');
  btn.disabled = true;
  let res;
  try {
    res = await api.config.chooseLogo();
  } catch (e) {
    res = { ok: false, error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) } };
  }
  btn.disabled = false;
  if (!handled(res, 'That logo was not accepted', SETTINGS_STATUS)) return;
  state.config = res.data;
  // Logo line only: choosing a logo must not wipe an accent being typed.
  applyLogoState(res.data);
}

async function clearLogo() {
  let res;
  try {
    res = await api.config.clearLogo();
  } catch (e) {
    res = { ok: false, error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) } };
  }
  if (!handled(res, 'Clearing the logo failed', SETTINGS_STATUS)) return;
  state.config = res.data;
  applyLogoState(res.data);
}

async function saveOperator() {
  const btn = $('#op-save');
  btn.disabled = true;
  let res;
  try {
    res = await api.config.setOperator({
      name: $('#f-op-name').value,
      email: $('#f-op-email').value,
      scannerUrl: $('#f-op-scanner').value,
      brandVoice: $('#f-op-voice').value,
    });
  } catch (e) {
    res = {
      ok: false,
      error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
    };
  }
  btn.disabled = false;
  if (!handled(res, 'Saving your details failed', SETTINGS_STATUS)) return;
  state.config = res.data;
  applyOperator(res.data);
  setStatus('empty', 'SAVED', 'Artifacts will be signed with these details.', null, SETTINGS_STATUS);
}

function applyConfig(cfg) {
  state.config = cfg;
  $('#cfg-path').textContent = cfg.configPath;
  $('#key-warning').hidden = cfg.keys.googlePlaces.present;
  $('#f-agent-mode').value = cfg.agent.mode;
  if (!$('#f-city').value && cfg.defaults.city) $('#f-city').value = cfg.defaults.city;
  if (!$('#f-category').value && cfg.defaults.category) $('#f-category').value = cfg.defaults.category;
  if (cfg.defaults.limit) $('#f-limit').value = String(cfg.defaults.limit);
  applyOperator(cfg);
  /**
   * Brand fields are populated HERE, on load, and nowhere else that runs at
   * startup. Hanging them off applyOperator was the first fix for the
   * clobber, and it moved the bug rather than closing it: the accent box came
   * up empty while a colour was still stored and still printing on every new
   * scorecard, and one Save on an empty box would have wiped it for real.
   * Found by the pre-merge review.
   */
  applyBrand(cfg);
  renderKeys(cfg);
}

function renderEnv(info) {
  const rows = [
    ['App version', info.appVersion],
    ['Electron', info.electron],
    ['Chromium', info.chrome],
    ['Node', info.node],
    ['User data', info.userDataPath],
    ['Evidence store', info.evidencePath],
  ];
  const tbody = $('#env-table').querySelector('tbody');
  tbody.replaceChildren();
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: k }));
    tr.appendChild(el('td', { text: v }));
    tbody.appendChild(tr);
  }
  $('#app-version').textContent = info.appVersion;
}

function renderAgentProbe(status) {
  const result = $('#agent-probe-result');
  result.replaceChildren();

  const row = el('div', { className: 'agent-probe__row' });
  row.appendChild(el('span', { className: 'agent-probe__label', text: status.label }));
  row.appendChild(el('span', {
    className: `badge badge--sev${status.available ? '0' : '3'}`,
    text: status.available ? 'AVAILABLE' : 'UNAVAILABLE',
  }));
  result.appendChild(row);

  if (status.detail) result.appendChild(el('p', { className: 'agent-probe__detail', text: status.detail }));
}

async function runAgentProbe() {
  const btn = $('#agent-probe-go');
  const spin = $('#agent-probe-spinner');

  btn.disabled = true;
  spin.hidden = false;
  $('#agent-probe-result').replaceChildren();

  let res;
  try {
    res = await api.agent.probe();
  } catch (e) {
    res = {
      ok: false,
      error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
    };
  }

  btn.disabled = false;
  spin.hidden = true;

  if (!handled(res, 'Testing the agent connection failed', SETTINGS_STATUS)) return;
  renderAgentProbe(res.data);
}

/* --- Approvals: the counter ------------------------------------------------

   Law 3's surface. One item in the pane at a time, because the failure this
   guards against is not a wrong click, it is a whole row cleared without being
   read. Every refusal shown here is the gate's own words: this file never
   re-implements a rule that lives in approval/gate.ts, because two copies of a
   rule is how they drift.
--------------------------------------------------------------------------- */

const APPROVALS_STATUS = '#approvals-status';

/** Kind slug -> what the operator calls it. */
const ARTIFACT_LABELS = {
  'AI-Readiness-Scan': 'AI readiness scan',
  Scorecard: 'Scorecard',
  'Schema-Starter': 'Schema starter kit',
  'Social-Post': 'Social post',
  'Postcard-Front': 'Postcard, front',
  'Postcard-Back': 'Postcard, back',
};

function artifactLabel(kind) {
  return ARTIFACT_LABELS[kind] || String(kind).replace(/-/g, ' ');
}

/**
 * Remembers a confirmation so the counter can offer it back to the gate.
 *
 * Keyed by candidate name rather than by slug: businessSlug() lives in main
 * and re-implementing it here would be a second copy of a naming rule, which
 * is the drift this codebase keeps paying for. The match below is a lookup
 * hint only. The gate re-checks everything and its refusal is what the
 * operator sees, so a miss costs a clear message, never a wrong approval.
 */
function recordConfirmation(candidate, data) {
  if (!candidate || !data || !Array.isArray(data.findings)) return;
  state.confirmations = [
    { candidateName: candidate.name, findings: data.findings, confirmedAt: data.confirmedAt },
    ...state.confirmations.filter((c) => c.candidateName !== candidate.name),
  ].slice(0, 20);
}

/**
 * The confirmation for THIS row, by exact candidate name, or null.
 *
 * This used to normalise the candidate name and test whether it was a
 * SUBSTRING of `row.slug`, because businessSlug() lives in main and copying it
 * here would drift. That was worse than drift. Any two prospects whose names
 * nest cross-matched, "Ace Fire" inside `Rockport-ME__Ace-Fire-Protection`
 * being the obvious one, and `releasable()` only checks that findings are
 * confirmed and unexpired, never that they belong to this artifact. So the
 * near-miss did not fail safe: approve() minted a real token for one
 * business's scorecard backed by another business's view-source.
 *
 * Both sides now carry the candidate name Places returned, so this is string
 * equality with nothing inferred. A row written before the ledger carried the
 * name matches nothing, which reads as "not confirmed" and is the safe way to
 * be wrong.
 *
 * NOTE for whoever adds the sender: the gate still cannot verify this linkage
 * itself, because a FlawFinding carries no candidate identity. Passing the
 * wrong findings to approve() is still accepted. Tying findings to a candidate
 * would close that properly.
 */
function confirmationFor(row) {
  const name = row && row.candidateName;
  if (!name) return null;
  return state.confirmations.find((c) => c.candidateName === name) || null;
}

/**
 * prepared | approved | rejected | superseded, plus the two only main sees.
 *
 * Delegates to archive-core so the rule the rail renders is the same rule the
 * suite tests. A superseded row is archived first: whether the file it points
 * at has since changed or been deleted is no longer a question anybody needs
 * answered.
 */
function rowState(row) {
  return window.assayArchiveCore.rowState(row);
}

const STATE_WORDS = {
  prepared: 'PREPARED',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  superseded: 'ARCHIVED, REPLACED BY A NEWER SCAN',
  changed: 'CHANGED SINCE APPROVED',
  missing: 'NOT ON DISK',
};

// --- Archived prospects (view state, not ledger state) ----------------------

const ARCHIVE_KEY = 'assay.approvals.archivedProspects';

/**
 * slug -> the itemIds that existed for it when the operator archived it.
 *
 * The list is what makes "new activity un-archives" mean NEW. Keying on
 * "any waiting row exists" instead looked right and was not: one packet is
 * six artifacts under one slug, so a prospect with five decided and one
 * still waiting, which is the ordinary half-reviewed state, archived and
 * then silently un-archived itself on the next read. Found by the pre-merge
 * correctness review, with a reproduction.
 */
function loadArchivedSlugs() {
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '{}');
    // An array is the first format, which recorded no itemIds. Read it as
    // "nothing known", so those entries behave the old way rather than
    // being dropped: the operator keeps their archive across the upgrade.
    if (Array.isArray(raw)) {
      return new Map(raw.filter((s) => typeof s === 'string').map((s) => [s, []]));
    }
    if (!raw || typeof raw !== 'object') return new Map();
    return new Map(
      Object.entries(raw)
        .filter(([k, v]) => typeof k === 'string' && Array.isArray(v))
        .map(([k, v]) => [k, v.filter((id) => typeof id === 'string')])
    );
  } catch {
    // Corrupt view state is discarded, never repaired: worst case every
    // prospect shows again, which errs on the side of showing work.
    return new Map();
  }
}

function saveArchivedSlugs(slugs) {
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(Object.fromEntries(slugs)));
  } catch {
    // View state only; failing to persist it must never block the queue.
  }
}

/**
 * Whether a row is filed away AND would be hidden from the rail's main
 * groups. Waiting and needs-attention rows are never archived, whatever the
 * slug set says; that exemption is the feature's one hard rule.
 */
function rowIsArchived(row) {
  return window.assayArchiveCore.isArchived(row, state.archivedSlugs);
}

function archiveProspect(slug) {
  // A row without a real slug has nowhere to be filed; refuse rather than
  // grow an entry the string filter would drop on the next load anyway.
  if (typeof slug !== 'string' || slug === '') return;
  // Record what exists for this prospect right now. Anything that shows up
  // later is new, and new activity is the only thing that un-archives.
  state.archivedSlugs.set(
    slug,
    state.queue.filter((r) => r.slug === slug).map((r) => r.itemId)
  );
  saveArchivedSlugs(state.archivedSlugs);
  // The detail pane must never show a row the rail hides. If the selection
  // was just filed away, move it to the first visible row.
  const sel = state.queue.find((r) => r.itemId === state.selectedItemId);
  if (sel && rowIsArchived(sel) && !state.showArchived) {
    state.selectedItemId = window.assayArchiveCore.pickSelection(
      state.queue, state.archivedSlugs, false
    );
  }
  renderApprovals();
}

function restoreProspect(slug) {
  state.archivedSlugs.delete(slug);
  saveArchivedSlugs(state.archivedSlugs);
  renderApprovals();
}

async function loadApprovals(keepSelection = true) {
  let res;
  try {
    res = await api.approval.queue();
  } catch (e) {
    res = {
      ok: false,
      error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
    };
  }
  if (!handled(res, 'Reading the approval queue failed', APPROVALS_STATUS)) {
    // A ledger that cannot be read must never render as an empty queue: that
    // silently re-offers a rejected item and loses why it was rejected.
    $('#counter').hidden = true;
    return;
  }

  state.queue = Array.isArray(res.data) ? res.data : [];

  // Fresh activity un-archives a prospect. Archiving files away finished
  // work; it must never swallow a new scan's waiting items, or make a just-
  // approved artifact vanish because its prospect was filed away last week.
  // Runs before the selection fallback so the fallback sees the final set.
  if (state.archivedSlugs === null) state.archivedSlugs = loadArchivedSlugs();
  const restore = window.assayArchiveCore.slugsToRestore(state.queue, state.archivedSlugs);
  for (const slug of restore) state.archivedSlugs.delete(slug);
  if (restore.length) saveArchivedSlugs(state.archivedSlugs);

  const selected = state.queue.find((r) => r.itemId === state.selectedItemId);
  // Re-picked when the selection is gone OR when it points at a row the rail
  // is hiding. The second half is the one that was missing: three paths can
  // break the "never show what the rail hides" invariant and only one of
  // them enforced it.
  if (!keepSelection || !selected || (rowIsArchived(selected) && !state.showArchived)) {
    state.selectedItemId = window.assayArchiveCore.pickSelection(
      state.queue,
      state.archivedSlugs,
      state.showArchived
    );
  }

  renderApprovals();
}

function renderApprovals() {
  const waiting = state.queue.filter((r) => r.state === 'prepared').length;

  const navCount = $('#nav-approvals-count');
  navCount.textContent = String(waiting);
  navCount.hidden = waiting === 0;

  $('#rail-waiting-chip').textContent = `${waiting} WAITING`;

  if (state.queue.length === 0) {
    $('#counter').hidden = true;
    $(APPROVALS_STATUS).replaceChildren(
      statusBox(
        'empty',
        'NOTHING IS WAITING',
        'Artifacts appear here the moment a packet is generated, already recorded as prepared. ' +
          'Generation is wired to this queue in the main process, so nothing can be produced without landing here first.'
      )
    );
    return;
  }

  clearStatus(APPROVALS_STATUS);
  $('#counter').hidden = false;
  renderRail();
  renderDetail();
}

function renderRail() {
  const rail = $('#queue-rail');
  rail.replaceChildren();

  // Waiting first. Decided work sits below it, because the only question this
  // view answers is what is still outstanding.
  //
  // An approved item whose bytes have since changed gets its own group rather
  // than sitting under "Cleared". It IS approved in the ledger, but any send
  // would be refused, and filing it with the genuinely cleared work is the
  // same "it looks done" mistake the whole gate exists to prevent.
  // Superseded rows are archived, not hidden. A re-scan replacing an artifact
  // that was already approved is exactly the kind of thing an operator wants
  // to be able to see afterwards, and the row still carries when it was
  // cleared and what replaced it.
  const needsAttention = (r) =>
    r.state !== 'superseded' && (rowState(r) === 'changed' || rowState(r) === 'missing');

  const activeGroups = [
    ['Waiting on you', state.queue.filter((r) => r.state === 'prepared' && !needsAttention(r))],
    ['Needs another look', state.queue.filter(needsAttention)],
  ];
  const decidedGroups = [
    ['Cleared', state.queue.filter((r) => r.state === 'approved' && !needsAttention(r) && !rowIsArchived(r))],
    ['Rejected', state.queue.filter((r) => r.state === 'rejected' && !needsAttention(r) && !rowIsArchived(r))],
    ['Archived, replaced by a newer scan', state.queue.filter((r) => r.state === 'superseded' && !rowIsArchived(r))],
  ];

  for (const [label, rows] of activeGroups) {
    if (rows.length === 0) continue;
    rail.appendChild(el('p', { className: 'rail-group', text: `${label} (${rows.length})` }));
    for (const row of rows) rail.appendChild(renderRailItem(row));
  }

  // Decided groups carry a subhead per prospect with an ARCHIVE action, so a
  // rail holding several scans can be cleared one prospect at a time.
  for (const [label, rows] of decidedGroups) {
    if (rows.length === 0) continue;
    rail.appendChild(el('p', { className: 'rail-group', text: `${label} (${rows.length})` }));
    for (const [slug, slugRows] of groupBySlug(rows)) {
      rail.appendChild(renderSlugHead(slug, 'archive'));
      for (const row of slugRows) rail.appendChild(renderRailItem(row));
    }
  }

  // Filed-away prospects, collapsed by default. The rows still exist in the
  // ledger and still render here on demand; nothing is deleted and there is
  // nothing to undo beyond RESTORE.
  const archivedRows = state.queue.filter(rowIsArchived);
  if (archivedRows.length > 0) {
    const toggle = el('button', {
      className: 'rail-archived-toggle',
      attrs: { type: 'button' },
      text: `ARCHIVED BY YOU (${archivedRows.length}) ${state.showArchived ? '[HIDE]' : '[SHOW]'}`,
    });
    toggle.addEventListener('click', () => {
      state.showArchived = !state.showArchived;
      // Collapsing the section must not leave the detail pane painting a row
      // that no longer appears anywhere in the rail.
      const sel = state.queue.find((r) => r.itemId === state.selectedItemId);
      if (!state.showArchived && sel && rowIsArchived(sel)) {
        state.selectedItemId = window.assayArchiveCore.pickSelection(
          state.queue, state.archivedSlugs, false
        );
      }
      renderApprovals();
    });
    rail.appendChild(toggle);
    if (state.showArchived) {
      for (const [slug, slugRows] of groupBySlug(archivedRows)) {
        rail.appendChild(renderSlugHead(slug, 'restore'));
        for (const row of slugRows) rail.appendChild(renderRailItem(row));
      }
    }
  }
}

function groupBySlug(rows) {
  const bySlug = new Map();
  for (const r of rows) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push(r);
  }
  return bySlug;
}

function renderSlugHead(slug, mode) {
  const head = el('div', { className: 'rail-subgroup' });
  head.appendChild(el('span', { className: 'rail-subgroup__slug', text: slug }));
  const btn = el('button', {
    className: 'rail-subgroup__btn',
    attrs: {
      type: 'button',
      title:
        mode === 'archive'
          ? 'File this prospect\'s decided items under ARCHIVED BY YOU. Nothing is deleted, and anything new for the prospect brings it back.'
          : 'Bring this prospect\'s items back into the list.',
    },
    text: mode === 'archive' ? 'ARCHIVE' : 'RESTORE',
  });
  btn.addEventListener('click', () =>
    mode === 'archive' ? archiveProspect(slug) : restoreProspect(slug)
  );
  head.appendChild(btn);
  return head;
}

function renderRailItem(row) {
  const s = rowState(row);
  const classes = ['rail-item'];
  if (row.itemId === state.selectedItemId) classes.push('is-selected');
  if (s === 'approved') classes.push('is-approved');
  if (s === 'rejected') classes.push('is-rejected');
  if (s === 'changed' || s === 'missing') classes.push('is-changed');

  const btn = el('button', { className: classes.join(' '), attrs: { type: 'button' } });
  btn.appendChild(el('span', { className: 'rail-item__kind', text: artifactLabel(row.kind) }));
  btn.appendChild(el('span', { className: 'rail-item__slug', text: row.slug }));
  btn.addEventListener('click', () => {
    state.selectedItemId = row.itemId;
    renderApprovals();
  });
  return btn;
}

function factRow(label, value) {
  const tr = el('tr');
  tr.appendChild(el('th', { text: label }));
  tr.appendChild(el('td', { text: value }));
  return tr;
}

function renderDetail() {
  const pane = $('#queue-detail');
  pane.replaceChildren();

  const row = state.queue.find((r) => r.itemId === state.selectedItemId);
  if (!row) {
    pane.appendChild(el('p', { className: 'counter__empty', text: 'Pick an item from the list.' }));
    return;
  }

  const s = rowState(row);

  const head = el('div', { className: 'item-head' });
  head.appendChild(el('span', { className: 'chip', text: STATE_WORDS[s] || String(s).toUpperCase() }));
  head.appendChild(el('h2', { text: artifactLabel(row.kind) }));
  head.appendChild(el('p', { className: 'item-head__slug', text: row.filename }));
  pane.appendChild(head);

  // The states only the main process can see, spelled out rather than left as
  // a colour. Both of these void a send, and both look fine in a folder.
  if (s === 'changed') {
    pane.appendChild(
      statusBox(
        'error',
        'THIS FILE CHANGED AFTER IT WAS APPROVED',
        'The operator approved bytes, not a filename, and these are no longer the bytes that were approved. ' +
          'Any send would be refused. Read it again, then approve it again.'
      )
    );
  } else if (s === 'missing') {
    pane.appendChild(
      statusBox('error', 'THE FILE IS NOT WHERE THE LEDGER SAYS', `Nothing is at ${row.absolutePath}.`)
    );
  }

  const facts = el('table', { className: 'item-facts' });
  const body = el('tbody');
  body.appendChild(factRow('Prospect', row.slug));
  body.appendChild(factRow('File', row.absolutePath));
  if (row.approvedAt) body.appendChild(factRow('Approved', formatTimestamp(row.approvedAt)));
  if (row.sha256) body.appendChild(factRow('Approved bytes', `sha256 ${row.sha256.slice(0, 16)}`));
  if (row.rejectedAt) body.appendChild(factRow('Rejected', formatTimestamp(row.rejectedAt)));
  if (row.reason) body.appendChild(factRow('Reason', row.reason));
  if (row.supersededAt) body.appendChild(factRow('Archived', formatTimestamp(row.supersededAt)));
  if (row.supersededBy) body.appendChild(factRow('Replaced by', row.supersededBy));
  facts.appendChild(body);
  pane.appendChild(facts);

  if (s === 'superseded') {
    pane.appendChild(
      statusBox(
        'empty',
        'A NEWER SCAN REPLACED THIS',
        'It is kept for the record, with when it was cleared and what replaced it, but it can no longer be ' +
          'approved or sent. Work from the newer artifact of the same kind.'
      )
    );
    return;
  }

  const conf = confirmationFor(row);
  if (row.state !== 'rejected') {
    pane.appendChild(
      conf
        ? statusBox(
            'empty',
            'APPROVING WILL RE-CHECK THIS CONFIRMATION',
            `Confirmed ${formatTimestamp(conf.confirmedAt)} from your own view-source. ` +
              'Approval re-runs the same release check that generation ran, so an expired confirmation is refused here even though it passed then.'
          )
        : statusBox(
            'error',
            'NO LIVE CONFIRMATION FOR THIS BUSINESS',
            'Confirmations are made in the Scan view against your own view-source and are not kept across restarts, on purpose: ' +
              'they expire 72 hours after they are made. Re-confirm this business before approving.'
          )
    );
  }

  pane.appendChild(renderItemActions(row, conf));
}

function renderItemActions(row, conf) {
  const actions = el('div', { className: 'item-actions' });

  /**
   * A rejected item gets one control: reopen it.
   *
   * Approving a rejection is refused by the gate, and until this existed the
   * refusal was a dead end: the operator was told the item was rejected and
   * given no way to reconsider it, so a rejected artifact could never be
   * approved even after being regenerated. Reopening is not an unapprove. It
   * returns the item to prepared, which is still short of being sendable.
   */
  if (row.state === 'rejected') {
    const wrap = el('div');
    const form = el('form', { className: 'reject-form' });
    const label = el('label', { text: 'Why are you reopening this?' });
    label.setAttribute('for', 'reopen-reason');
    form.appendChild(label);
    const area = el('textarea', {
      attrs: { id: 'reopen-reason', placeholder: 'Regenerated with the contact name fixed.' },
    });
    form.appendChild(area);
    form.appendChild(
      el('p', {
        className: 'reject-form__note',
        text:
          'This puts nothing in front of anybody. It returns the item to prepared, where it still has to be ' +
          'approved before it can go anywhere. The original rejection and its reason are kept.',
      })
    );
    const go = el('button', {
      className: 'btn btn--primary',
      text: 'Reopen this decision',
      attrs: { type: 'submit', id: 'reopen-go' },
    });
    form.appendChild(go);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void reopenItem(row, area.value, go);
    });
    wrap.appendChild(form);
    return wrap;
  }

  // No unapprove. Rejecting is the only way back, and it costs a reason.
  if (row.state !== 'approved') {
    const approveBtn = el('button', {
      className: 'btn btn--primary',
      text: 'Approve this item',
      attrs: {
        type: 'button',
        id: 'approve-go',
        'data-tip': 'Clear this one artifact. Re-checks the confirmation first, and there is no unapprove.',
      },
    });
    approveBtn.addEventListener('click', () => void approveItem(row, conf, approveBtn));
    actions.appendChild(approveBtn);
  }

  const rejectBtn = el('button', {
    className: 'btn btn--ghost',
    text: row.state === 'approved' ? 'Reject this item, revoking the approval' : 'Reject this item',
    attrs: {
      type: 'button',
      id: 'reject-open',
      'data-tip': 'Pass on this artifact. A reason is required; it is the record of why a prospect was passed over.',
    },
  });
  actions.appendChild(rejectBtn);

  const wrap = el('div');
  wrap.appendChild(actions);

  const form = el('form', { className: 'reject-form', attrs: { id: 'reject-form', hidden: 'hidden' } });
  const label = el('label', { text: 'Why is this being rejected?' });
  label.setAttribute('for', 'reject-reason');
  form.appendChild(label);
  const area = el('textarea', {
    attrs: {
      id: 'reject-reason',
      placeholder: 'Wrong contact named on the scorecard.',
    },
  });
  form.appendChild(area);
  form.appendChild(
    el('p', {
      className: 'reject-form__note',
      text:
        'A rejection needs a reason and the reason is the point: it is the only record of why a prospect ' +
        'was passed over, and it is worth more than the approvals.',
    })
  );
  const submit = el('button', {
    className: 'btn btn--primary',
    text: 'Record the rejection',
    attrs: { type: 'submit', id: 'reject-go' },
  });
  form.appendChild(submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void rejectItem(row, area.value, submit);
  });
  wrap.appendChild(form);

  rejectBtn.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) area.focus();
  });

  return wrap;
}

async function approveItem(row, conf, btn) {
  btn.disabled = true;
  let res;
  try {
    res = await api.approval.approve({
      itemId: row.itemId,
      findings: conf ? conf.findings : [],
      confirmedAt: conf ? conf.confirmedAt : null,
    });
  } catch (e) {
    res = {
      ok: false,
      error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
    };
  }
  btn.disabled = false;

  // The gate's refusal is the message. It knows why; this view does not.
  if (!handled(res, 'Approving failed', APPROVALS_STATUS)) return;
  await loadApprovals();
}

async function reopenItem(row, reason, btn) {
  btn.disabled = true;
  let res;
  try {
    res = await api.approval.reopen({ itemId: row.itemId, reason: String(reason || '') });
  } catch (e) {
    res = {
      ok: false,
      error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
    };
  }
  btn.disabled = false;
  if (!handled(res, 'Reopening failed', APPROVALS_STATUS)) return;
  await loadApprovals();
}

async function rejectItem(row, reason, btn) {
  btn.disabled = true;
  let res;
  try {
    res = await api.approval.reject({ itemId: row.itemId, reason: String(reason || '') });
  } catch (e) {
    res = {
      ok: false,
      error: { kind: 'internal', message: 'The app could not reach its own main process.', detail: String(e) },
    };
  }
  btn.disabled = false;

  if (!handled(res, 'Rejecting failed', APPROVALS_STATUS)) return;
  await loadApprovals();
}

// --- Boot ------------------------------------------------------------------

async function boot() {
  for (const btn of document.querySelectorAll('.app-nav .btn')) {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  }

  // The native Help menu switches views from the main process. Guarded because a
  // partially-attached bridge would leave api.menu undefined, and a missing Help
  // menu must not take the whole renderer down on boot.
  if (api && api.menu && typeof api.menu.onNavigate === 'function') {
    // The payload is 'view' or 'view#section'. A section lands the view
    // scrolled to the element id 'help-<section>'; a bare view scrolls to the
    // top, so the two Help entries open at visibly different places. The
    // scroll container is .app-main, not the window: the document itself
    // never overflows, so resetting the window would be a no-op.
    api.menu.onNavigate((view) => {
      if (typeof view !== 'string') return;
      const [name, section] = view.split('#');
      showView(name);
      const target = section ? document.getElementById(`help-${section}`) : null;
      if (target) {
        target.scrollIntoView({ block: 'start' });
      } else {
        const scroller = document.querySelector('.app-main');
        if (scroller) scroller.scrollTop = 0;
      }
    });
  }

  $('#scan-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void runScan(false);
  });

  $('#load-more').addEventListener('click', () => void runScan(true));
  $('#map-toggle').addEventListener('click', () => {
    if (window.assayMap) window.assayMap.toggle();
  });

  $('#f-agent-mode').addEventListener('change', async (e) => {
    let res;
    try {
      res = await api.config.setAgentMode(e.target.value);
    } catch (err) {
      res = { ok: false, error: { kind: 'internal', message: String(err && err.message ? err.message : err) } };
    }
    if (!handled(res, 'Changing agent mode failed', SETTINGS_STATUS)) return;
    state.config = res.data;
  });

  $('#agent-probe-go').addEventListener('click', () => void runAgentProbe());
  $('#op-save').addEventListener('click', () => void saveOperator());
  $('#brand-save').addEventListener('click', () => void saveAccent());
  $('#brand-logo-choose').addEventListener('click', () => void chooseLogo());
  $('#brand-logo-clear').addEventListener('click', () => void clearLogo());

  const [cfgRes, infoRes] = await Promise.all([api.config.get(), api.app.info()]);

  // A failure here means the bridge or a handler is broken, which is not
  // something the user can act on but absolutely must be visible rather than
  // leaving the app sitting there looking merely empty.
  if (handled(cfgRes, 'Loading settings failed', SETTINGS_STATUS)) {
    applyConfig(cfgRes.data);
  } else {
    setStatus(
      'error',
      'THE APP DID NOT FINISH STARTING',
      'Settings could not be read, so scanning is disabled. This is a bug in the app, not in your setup.',
      cfgRes && cfgRes.error ? cfgRes.error.detail : undefined
    );
    $('#scan-go').disabled = true;
  }

  if (handled(infoRes, 'Loading build info failed', SETTINGS_STATUS)) {
    renderEnv(infoRes.data);
  }

  // Read the queue at startup, not on first visit, so the count in the nav is
  // true before anyone thinks to look. An item waiting on a decision the
  // operator has forgotten about is the failure this whole view exists for.
  await loadApprovals(false);
}

/**
 * boot() used to be fired with no catch at all.
 *
 * If the preload bridge fails to attach, `api.config` is undefined and the
 * first call throws synchronously inside the promise. Nothing rendered, no
 * banner appeared, the version stayed at its placeholder and the NO API KEY
 * warning never showed, so the app looked merely unconfigured rather than
 * broken. That is the exact shape of the dead-bridge bug this project already
 * shipped once, and it was visible only in devtools, which a packaged user
 * does not have.
 */
document.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    const msg = String(e && e.message ? e.message : e);
    const banner = document.querySelector('#scan-status');
    if (banner) {
      banner.textContent = `The app failed to start: ${msg}. The main process bridge may not have loaded.`;
      banner.setAttribute('data-state', 'error');
    }
    // Last resort: if even the banner is missing, the document itself says so.
    if (!banner && document.body) {
      const p = document.createElement('p');
      p.textContent = `Assay failed to start: ${msg}`;
      document.body.prepend(p);
    }
  });
});

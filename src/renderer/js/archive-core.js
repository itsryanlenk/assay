/**
 * The approvals archive's decision rules, with no DOM and no storage.
 *
 * They live here because they shipped untested inside app.js and a stateful
 * branch got through: the un-archive rule could not tell a row that was
 * already waiting when the operator archived from one that arrived after, so
 * archiving a half-reviewed prospect silently undid itself on the next
 * render. Rules a test can reach do not fail that way twice.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.assayArchiveCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /** prepared | approved | rejected | superseded, plus the two only main sees. */
  function rowState(row) {
    if (row.state === 'superseded') return 'superseded';
    if (row.state === 'approved' && row.changedSinceApproved) return 'changed';
    if (!row.onDisk) return 'missing';
    return row.state;
  }

  /** A row the gate wants eyes on. These can never be hidden by archiving. */
  function needsEyes(row) {
    const s = rowState(row);
    return row.state === 'prepared' || s === 'changed' || s === 'missing';
  }

  /**
   * Whether a row is both filed away and hideable. The needsEyes exemption is
   * the feature's one hard rule, applied here rather than at each call site.
   */
  function isArchived(row, archived) {
    if (!archived || !archived.get(row.slug)) return false;
    return !needsEyes(row);
  }

  /**
   * Slugs to un-archive: those with a row needing eyes that was NOT present
   * when the operator archived. Returns a list rather than mutating, so the
   * rule is a function of its inputs and nothing else.
   */
  function slugsToRestore(queue, archived) {
    const out = [];
    for (const row of queue || []) {
      const known = archived && archived.get(row.slug);
      if (!known) continue;
      if (needsEyes(row) && !known.includes(row.itemId) && !out.includes(row.slug)) {
        out.push(row.slug);
      }
    }
    return out;
  }

  /**
   * Which row the detail pane should show: waiting work first, then anything
   * the rail actually renders. NULL when the rail renders nothing.
   *
   * The null is the point. A `rows[0]` fallback looked harmless and was the
   * bug: approve the last waiting artifact of an archived prospect and the
   * rail collapses to its [SHOW] toggle while the pane keeps painting a full
   * artifact, with actions, that appears nowhere. The pane and the rail have
   * to agree, and "nothing is showing" is a state the pane can render.
   */
  function pickSelection(queue, archived, showArchived) {
    const rows = queue || [];
    const visible = (r) => showArchived || !isArchived(r, archived);
    const firstWaiting = rows.find((r) => r.state === 'prepared' && visible(r));
    const firstVisible = rows.find(visible);
    return ((firstWaiting || firstVisible) || {}).itemId || null;
  }

  return { rowState, needsEyes, isArchived, slugsToRestore, pickSelection };
});

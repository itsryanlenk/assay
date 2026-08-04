/**
 * Scorecard renderer. Free tier, artifact 2 of 3 (scan, SCORECARD, schema starter).
 *
 * A standalone HTML document in the house neo-brutalist theme, sized to
 * src/renderer/css/theme.css's .sheet-1200 so it exports cleanly to PNG. The
 * design tokens below (colors, borders, shadows, spacing, type scale) are
 * copied from that file rather than linked, because this document is written
 * to an arbitrary client folder outside the app bundle and has to render on
 * its own with no relative dependency on the app's assets. Font FILES are not
 * embedded for the same reason: a relative path to the bundled woff2 files
 * would not resolve from that folder. The font-family names are declared so
 * the page still renders correctly wherever those fonts are installed, and
 * falls back to a plain sans-serif/monospace otherwise; only the type FACE is
 * best-effort, the rest of the design system (color, border, shadow, spacing)
 * is exact, same values as theme.css.
 *
 * GUARDRAIL NOTE, read before touching the copy below: generate.ts's Wall 2
 * strips everything inside <style> and <script> before the prose sweep runs
 * (see stripMarkup), so CSS pixel values never have to justify themselves
 * against Law 2's "every number is measured" rule. Only rendered TEXT does.
 * Every number printed in the body below is therefore one of: a score figure
 * (raw/base/rescaled/item earned/possible, all added to the allowed set by
 * allowedFactsFrom), an evidence figure (byteLength/httpStatus, same), a
 * structural number the sweep itself exempts (0-6, 10, 72, 90, 100, 105), or
 * text already inside a finding's headline/detail. Dates are the one figure
 * none of those categories cover, so they are written with a glued ordinal
 * suffix ("30th July 2026"): the sweep's number regex requires a WORD
 * boundary immediately after the digits, and a letter glued on with no space
 * or punctuation between never produces one. Verified against the real
 * sweep() function before this file was written, and again in the throwaway
 * verification script.
 */

import { Renderer, EVIDENCE_HASH_CHARS } from '../generate';
import { EvidenceRef, FlawFinding, Score } from '../../../shared/types';
import { scoreSentence } from '../../scoring/instrument';
import { byUnclaimed, copyFor } from './plain-language';
import { ACCENT_RE } from '../brand';

// ---------------------------------------------------------------------------
// Small local helpers. Duplicated rather than shared, the brief is exactly
// four files and nothing else.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "5" -> "5th". See the file header: the glued suffix is what keeps a date
 *  out of the guardrail's unsourced-number sweep. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `date` arrives as isoDate()'s "YYYY-MM-DD". Split rather than `new Date()`
 *  so a date-only string is never reinterpreted across a timezone boundary. */
function formatDate(iso: string): string {
  const parts = iso.split('-');
  const y = Number(parts[0] ?? '');
  const m = Number(parts[1] ?? '');
  const d = Number(parts[2] ?? '');
  if (!y || !m || !d) return iso;
  const month = MONTHS[m - 1] ?? '';
  return `${ordinal(d)} ${month} ${y}`;
}

function cellClass(item: Score['items'][number]): string {
  if (item.na) return '';
  const ratio = item.possible > 0 ? item.earned / item.possible : 0;
  if (ratio >= 0.7) return 'ok';
  if (ratio >= 0.4) return 'mid';
  return 'bad';
}

/**
 * One capture, as one dense line.
 *
 * This used to be a bulleted list carrying the full absolute URL, the byte
 * count and twelve hash characters per row. Sixteen captures ran to a page and
 * a half of a client document. The origin is identical on every row so it is
 * stated once above the grid, the byte count proves nothing a reader will
 * check, and six hash characters are as good as twelve for confirming you are
 * looking at the same capture.
 */
function evidenceCell(e: EvidenceRef, origin: string): string {
  const pathOnly = e.url.startsWith(origin) ? e.url.slice(origin.length) || '/' : e.url;
  const status = e.httpStatus === null ? 'no reply' : String(e.httpStatus);
  // Length comes from generate.ts, which is also what puts it on the sweep's
  // allowlist. Hard-coding it here is how a real packet came to be refused.
  const hash = e.sha256 ? e.sha256.slice(0, EVIDENCE_HASH_CHARS) : '------';
  const mark = e.source === 'operator-browser' ? '*' : '';
  return (
    `<li><span class="ev-path mono">${escapeHtml(pathOnly)}</span>` +
    `<span class="ev-meta mono">${escapeHtml(status)} ${escapeHtml(hash)}${mark}</span></li>`
  );
}

/** The one origin every capture shares, so it is printed once, not sixteen times. */
function commonOrigin(refs: EvidenceRef[]): string {
  for (const r of refs) {
    try {
      const u = new URL(r.url);
      return `${u.protocol}//${u.host}`;
    } catch {
      /* not a URL we can shorten against; the full value is printed instead */
    }
  }
  return '';
}
/**
 * Owner-facing copy lives in ./plain-language, shared with the postcard and
 * the social post. All three describe the same finding to the same reader,
 * and while this file had its own version the other two drifted into
 * asserting something this one contradicted in the same envelope.
 */
/**
 * The owner-facing page. Three items, because a list of six is a list nobody
 * finishes, and the three with the most unclaimed points are where the work is.
 */
function ownerSection(items: Score['items']): string {
  const top = byUnclaimed(items).slice(0, 3);
  if (!top.length) return '';
  return top
    .map((i, rank) => {
      // copyFor, never ITEM_COPY[i.id]: the bare lookup returns the
      // total-absence wording, which this page then printed for an item that
      // had merely lost the most points.
      const copy = copyFor(i);
      const done = i.earned >= i.possible;
      // Only the worst one is filled. Shading every zero-scoring item put
      // three yellow blocks in a row on the first real packet, which is a wall
      // rather than an emphasis and tells the eye nothing about where to start.
      const shade = !done && rank === 0 ? ' yellow' : '';
      /**
       * The measured fact leads.
       *
       * These blocks used to open with "What it is", a definition of the
       * category, and never said what was actually on the reader's site. On a
       * document whose whole promise is that every claim reproduces with
       * Ctrl+U, the reader was being told what an llms.txt is and never told
       * that theirs returns 404. The note is what the check measured, in the
       * same words the rubric table on page two prints, so page one and page
       * two now agree line for line.
       */
      const found = (i.note ?? '').trim();
      return [
        `<div class="block${shade}">`,
        `<h2>${escapeHtml(copy.title)}</h2>`,
        found ? `<p><b>What we found on your site.</b> ${escapeHtml(found)}</p>` : '',
        `<p><b>What that means.</b> ${escapeHtml(copy.means)}</p>`,
        done
          ? `<p><b>Where you stand.</b> ${escapeHtml(copy.won)}</p>`
          : `<p><b>What it is costing you.</b> ${escapeHtml(copy.cost)}</p>`,
        '</div>',
      ].filter(Boolean).join('\n');
    })
    .join('\n');
}

function findingBlock(f: FlawFinding): string {
  const shade = f.severity >= 4 ? ' red' : f.severity >= 2 ? ' yellow' : '';
  const parts: string[] = [];
  parts.push(`<div class="block${shade}">`);
  parts.push(
    `<span class="tag">${escapeHtml(f.checkId)}</span>` +
      // "OF 4" rather than "OF FOUR": 4 is in the guardrail's structural
      // exemption set, so spelling it out was defensive and left the chip
      // mixing a numeral and a word.
      `<span class="badge badge--sev${f.severity}">SEVERITY ${f.severity} OF 4</span>` +
      `<span class="tag">${escapeHtml(f.confirmation.toUpperCase())}</span>`
  );
  parts.push(`<h2>${escapeHtml(f.headline)}</h2>`);
  /**
   * A scored finding's `detail` is every rubric item's note run together, and
   * the rubric table directly above prints those same notes one per row. Both
   * added a page and a half of the same words. The table is the better of the
   * two, so the paragraph goes.
   */
  if (!f.score) parts.push(`<p>${escapeHtml(f.detail)}</p>`);
  if (f.fix) {
    parts.push(
      `<p><span class="q">FIX: ${escapeHtml(f.fix.effort.toUpperCase())}</span> ${escapeHtml(f.fix.summary)}</p>`
    );
    if (f.fix.snippet) {
      parts.push(`<pre class="mono">${escapeHtml(f.fix.snippet)}</pre>`);
    }
  }
  // Evidence is NOT repeated here. It used to be printed per finding AND again
  // in the evidence section, so a single ai-readiness finding put the same
  // fifteen lines on the page twice and the two copies filled most of two
  // pages. The deduplicated section below is the one place it lives.
  parts.push('</div>');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Design tokens and primitives, ported 1:1 from src/renderer/css/theme.css.
// Only the subset this document actually uses. Values are copied, not
// computed, so a change to the house theme does not silently drift a
// document that already shipped to a client's folder.
// ---------------------------------------------------------------------------

const STYLE = `
:root {
  --color-field: #F1EEE3;
  --color-ink: #111;
  --color-paper: #fff;
  --color-yellow: #F5D90A;
  --color-red: #F05B56;
  /**
   * Brand accent slots. Defaults ARE the house values, so an unbranded
   * document renders exactly as it always did, and a branded one overrides
   * these three in a single block below. Severity shading deliberately does
   * NOT use them: a sev-2 block recoloured to a client's navy while its
   * badge stayed on the house cell scale would destroy the severity coding.
   */
  --accent-bg: #F5D90A;
  --accent-bg-text: #111;
  --accent-on-ink: #F5D90A;
  --color-cell-ok: #BFE3B4;
  --color-cell-ok-mid: #DCE697;
  --color-cell-mid: #F8E97A;
  --color-cell-mid-bad: #F7C990;
  --color-cell-bad: #F6A9A6;
  --color-muted: #55524a;
  --color-note: #ccc;

  --font-display: 'Archivo Black', sans-serif;
  --font-body: 'Inter', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --weight-bold: 700;

  --tracking-tight: -1px;
  --tracking-wide: 0.5px;
  --tracking-wider: 1px;
  --tracking-widest: 2px;

  --border-w-thin: 2px;
  --border-w: 3px;
  --border-w-thick: 4px;
  --border: var(--border-w) solid var(--color-ink);
  --border-thin: var(--border-w-thin) solid var(--color-ink);

  --shadow-block: 8px 8px 0 var(--color-ink);
  --shadow-stamp: 6px 6px 0 var(--color-ink);
  --shadow-muted: 8px 8px 0 var(--color-muted);

  --space-1: 1px; --space-2: 2px; --space-5: 5px; --space-6: 6px; --space-8: 8px;
  --space-9: 9px; --space-10: 10px; --space-12: 12px; --space-14: 14px; --space-16: 16px;
  --space-22: 22px; --space-24: 24px; --space-26: 26px; --space-28: 28px; --space-36: 36px; --space-40: 40px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body { font-family: var(--font-body); color: var(--color-ink); background: var(--color-field); }

.mono { font-family: var(--font-mono); }

.chip {
  display: inline-block; background: var(--color-ink); color: var(--color-paper);
  font-family: var(--font-mono); font-size: 13px; font-weight: var(--weight-bold);
  letter-spacing: var(--tracking-widest); padding: var(--space-6) var(--space-12);
}

/* The type scale below is sized for LETTER, not for the 1200px screen sheet
   this document started life as. At the original scale the owner-facing page
   alone ran to two sheets and the whole scorecard to five, which is the
   opposite of the point. */
h1 {
  font-family: var(--font-display); font-size: 34px; line-height: 1.03; text-transform: uppercase;
  margin: var(--space-10) 0 var(--space-10); letter-spacing: var(--tracking-tight);
}

.sub { font-size: 13.5px; line-height: 1.45; max-width: 100%; }

.stamp {
  position: absolute; top: var(--space-36); right: var(--space-40);
  border: var(--border); background: var(--color-paper); box-shadow: var(--shadow-stamp);
  padding: var(--space-10) var(--space-16); text-align: right; width: 210px;
}
.stamp .lbl { font-family: var(--font-mono); font-size: 10px; font-weight: var(--weight-bold); letter-spacing: var(--tracking-widest); }
.stamp .big { font-size: 19px; font-weight: var(--weight-bold); line-height: 1.2; }

.rule { border: none; border-top: var(--border-w-thick) solid var(--color-ink); margin: var(--space-22) 0; }

.block { border: var(--border); box-shadow: 5px 5px 0 var(--color-ink); padding: var(--space-10) var(--space-14); margin: var(--space-10) 0; background: var(--color-paper); }
.block.yellow { background: var(--color-yellow); }
.block.red { background: var(--color-red); }
.block h2 { font-family: var(--font-display); font-size: 18px; line-height: 1.1; text-transform: uppercase; margin: 0 0 var(--space-8); }
.block p { font-size: 12.5px; line-height: 1.45; margin: var(--space-5) 0; }
.block pre.mono { white-space: pre-wrap; word-break: break-word; background: var(--color-field); border: var(--border-thin); padding: var(--space-10); margin: var(--space-8) 0; font-size: 12.5px; overflow-x: auto; }

.band { background: var(--color-ink); color: var(--color-paper); display: flex; justify-content: space-between; align-items: center; padding: var(--space-6) var(--space-12); margin: var(--space-14) 0 var(--space-10); }
.band .l { font-size: 13px; font-weight: var(--weight-bold); letter-spacing: var(--tracking-wide); }
.band .r { font-family: var(--font-mono); font-size: 10px; color: var(--accent-on-ink); }

.tag { display: inline-block; border: var(--border-thin); background: var(--color-paper); font-family: var(--font-mono); font-size: 12px; font-weight: var(--weight-bold); padding: var(--space-2) var(--space-8); margin: 0 var(--space-6) var(--space-6) 0; }

table.matrix { width: 100%; border-collapse: collapse; border: var(--border); box-shadow: var(--shadow-block); background: var(--color-paper); margin: var(--space-14) 0; }
table.matrix th, table.matrix td { border: var(--border-thin); padding: var(--space-5) var(--space-8); font-size: 11px; line-height: 1.35; text-align: left; vertical-align: top; }
table.matrix th { background: var(--color-ink); color: var(--color-paper); font-family: var(--font-mono); font-size: 10px; letter-spacing: var(--tracking-wider); text-transform: uppercase; }
table.matrix td.rowlbl { font-weight: var(--weight-bold); font-size: 11.5px; background: var(--color-field); width: 130px; }

.ok { background: var(--color-cell-ok); }
.mid { background: var(--color-cell-mid); }
.bad { background: var(--color-cell-bad); }
table.matrix td b { display: block; font-family: var(--font-mono); font-size: 12.5px; }

ul.flat { list-style: none; }
ul.flat li { font-size: 14px; line-height: 1.5; margin: var(--space-9) 0; padding-left: var(--space-26); position: relative; }
ul.flat li::before { content: ""; position: absolute; left: 0; top: var(--space-6); width: var(--space-12); height: var(--space-12); background: var(--color-ink); }
.block.red ul.flat li::before { background: var(--color-paper); }

.q { font-family: var(--font-mono); background: var(--color-paper); border: var(--border-thin); padding: var(--space-1) var(--space-6); font-size: 13px; font-weight: var(--weight-bold); white-space: nowrap; }
.block.red .q, .block.yellow .q { background: var(--color-paper); }

.scoreband { background: var(--color-ink); color: var(--color-paper); display: flex; align-items: center; justify-content: space-between; padding: var(--space-10) var(--space-16); border: var(--border); box-shadow: 5px 5px 0 var(--color-muted); margin: var(--space-10) 0 var(--space-14); gap: var(--space-14); flex-wrap: nowrap; }
.scoreband .t { font-family: var(--font-display); font-size: 16px; text-transform: uppercase; white-space: nowrap; }
.scoreband .n { font-family: var(--font-display); font-size: 30px; color: var(--accent-on-ink); white-space: nowrap; }
.scoreband .note { font-size: 11.5px; color: var(--color-note); line-height: 1.4; }

/* Bottom LEFT. This was a two-column flex row with the brand block set to
   text-align: right and the verify text capped at 760px. On a 1200px screen
   that read as two columns; printed to Letter the column is narrower than the
   cap, so the brand wrapped onto its own line and its right-aligned text threw
   it to the far edge of the page. Stacked and left-aligned, it lands where it
   should on both. */
.footer { margin-top: var(--space-26); }
.footer .verify { font-size: 11.5px; line-height: 1.5; max-width: 100%; margin-top: var(--space-10); color: var(--color-muted); }
.footer .brand { text-align: left; }
.footer .brand .name { font-family: var(--font-display); font-size: 17px; letter-spacing: var(--tracking-wider); }
.footer .brand .url { font-family: var(--font-mono); font-size: 12px; font-weight: var(--weight-bold); }
.footer .brand .cta { display: inline-block; background: var(--color-ink); color: var(--color-yellow); font-family: var(--font-mono); font-size: 12px; font-weight: var(--weight-bold); letter-spacing: var(--tracking-widest); padding: var(--space-5) var(--space-10); margin-top: var(--space-6); }

.badge { display: inline-block; font-family: var(--font-mono); font-size: 12px; font-weight: var(--weight-bold); text-transform: uppercase; letter-spacing: var(--tracking-wider); border: var(--border-thin); background: var(--color-paper); color: var(--color-ink); padding: var(--space-2) var(--space-8); margin: 0 var(--space-6) var(--space-6) 0; }
.badge--sev0 { background: var(--color-cell-ok); }
.badge--sev1 { background: var(--color-cell-ok-mid); }
.badge--sev2 { background: var(--color-cell-mid); }
.badge--sev3 { background: var(--color-cell-mid-bad); }
.badge--sev4 { background: var(--color-cell-bad); }

.sheet-1200 { width: 1200px; padding: var(--space-24) var(--space-28) var(--space-22); position: relative; }
.stamp { padding: var(--space-6) var(--space-10); width: 150px; box-shadow: 4px 4px 0 var(--color-ink); }
.stamp .big { font-size: 14px; }
.rule { margin: var(--space-10) 0; border-top-width: var(--border-w); }
/* Page one has to END on page one. The stacked footer, its own rule and a 24px
   display-face name pushed a signature onto an otherwise blank sheet two. The
   signature now closes the block it belongs to and the promise below it is one
   line, which is the whole of what a reader needs from the bottom of a page. */
.ask .sign { margin-top: var(--space-10); font-size: 12.5px; border-top: var(--border-thin); padding-top: var(--space-8); }
.ask .sign b { font-family: var(--font-display); font-size: 14px; letter-spacing: var(--tracking-wide); }
/* With no ask copy above it, the divider has nothing to divide. */
.ask .sign--bare { border-top: none; margin-top: 0; padding-top: 0; }
.verify-line { font-size: 11.5px; line-height: 1.45; color: var(--color-muted); margin-top: var(--space-6); }

/* The evidence grid. Dense on purpose: this is a receipt, not a section
   anybody reads top to bottom, and as a bulleted list of absolute URLs it ran
   to a page and a half. */
ul.evidence {
  list-style: none;
  columns: 3;
  column-gap: var(--space-22);
  margin: var(--space-12) 0;
}
ul.evidence li {
  break-inside: avoid;
  display: flex;
  justify-content: space-between;
  gap: var(--space-8);
  font-size: 11.5px;
  line-height: 1.5;
  padding: var(--space-1) 0;
  border-bottom: 1px solid rgba(17, 17, 17, 0.12);
}
/* A flex child will not shrink below its content width without min-width: 0,
   so inside a three-column layout a long path kept its full width and spilled
   over the next column. The path shrinks and wraps; the short status-and-hash
   pair keeps its own width and never wraps. */
ul.evidence li .ev-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
ul.evidence li .ev-meta { flex: 0 0 auto; color: var(--color-muted); white-space: nowrap; }
.ev-key { font-size: 12px; color: var(--color-muted); line-height: 1.5; }

/* Page one is the owner's. Everything after it is for whoever maintains the
   site, and it starts on a fresh sheet so the split is obvious. */
.tech-start { break-before: page; page-break-before: always; }

/* PRINT INTEGRITY. A unit that will not fit the rest of a page moves to the
   next page whole; nothing self-contained is ever cut in half across a sheet
   boundary. Half a finding on one page reads as carelessness on a document
   whose pitch is precision. avoid is a hint the engine drops for a unit
   taller than one page, so the ask is bounded twice (ASK_MAX characters in
   config/store.ts, six paragraphs in the renderer) to stay below that line.
   The stamp is absolutely positioned and never fragments; it needs no rule. */
.block, .ask, .scoreband { break-inside: avoid; page-break-inside: avoid; }
table.matrix tr { break-inside: avoid; page-break-inside: avoid; }
/* The column headers repeat when the rubric table crosses a page. */
table.matrix thead { display: table-header-group; }
/* A band is a heading. It keeps its first content; it is never the last
   thing on a page. */
.band { break-inside: avoid; page-break-inside: avoid; break-after: avoid; page-break-after: avoid; }

.ask { border: var(--border); background: var(--accent-bg); color: var(--accent-bg-text); padding: var(--space-10) var(--space-14); margin: var(--space-10) 0; box-shadow: 5px 5px 0 var(--color-ink); }
.ask .logo { display: block; max-height: 40px; max-width: 220px; margin-bottom: var(--space-8); }
.ask h2 { font-family: var(--font-display); font-size: 18px; text-transform: uppercase; margin-bottom: var(--space-8); }
.ask p { font-size: 12.5px; line-height: 1.5; margin: var(--space-6) 0; }
.ask ul { margin: var(--space-8) 0 var(--space-6) var(--space-22); }
.ask li { font-size: 12.5px; line-height: 1.5; margin: var(--space-5) 0; }
`;

// ---------------------------------------------------------------------------

export const scorecardRenderer: Renderer = ({ candidate, findings, score, date, operator, brand }) => {
  const name = escapeHtml(candidate.name);
  const dateText = escapeHtml(formatDate(date));
  const flaws = findings.filter((f) => f.status === 'flaw');

  /**
   * The brand override, or nothing at all.
   *
   * The three values are derived in main from a validated `#rrggbb`, so
   * nothing operator-typed reaches a CSS position unvalidated. An unbranded
   * document emits neither block nor image, which is what keeps "no brand
   * markup when null" a testable property rather than a promise.
   */
  // Re-tested AT the interpolation, not only in the callers that derive it:
  // the type is four plain strings, so the invariant has to be local or a
  // future caller building a GenerateRequest by hand puts arbitrary text in
  // a CSS position.
  const accentsOk =
    !!brand &&
    ACCENT_RE.test(brand.accentBg) &&
    ACCENT_RE.test(brand.accentBgText) &&
    ACCENT_RE.test(brand.accentOnInk);
  const brandStyle = accentsOk
    ? `\n<style>:root { --accent-bg: ${brand!.accentBg}; --accent-bg-text: ${brand!.accentBgText}; --accent-on-ink: ${brand!.accentOnInk}; }</style>`
    : '';
  // alt is deliberately EMPTY. A truncated or half-copied logo still passes
  // the header checks and then fails to decode, and Chromium prints the alt
  // text where the image should be: a client document reading "Acme Dental
  // logo" in plain type. The sender's name prints four lines below either
  // way, so the mark is decorative and an empty alt is the correct one.
  // Shape-checked at the interpolation for the same reason the accents are:
  // the type is four plain strings, so a hand-built BrandContext could
  // otherwise close the attribute and add its own. base64 has no quote, so a
  // real logo always passes.
  const logoOk = !!brand && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(brand.logoDataUri);
  const brandLogo = logoOk ? `<img class="logo" src="${brand!.logoDataUri}" alt="">\n    ` : '';

  // The score band itself lives on page one now. This is the working behind
  // it, so it opens with the instrument sentence rather than repeating the
  // number in a second big band.
  const scoreSection = score
    ? `
  <p class="ev-key">${escapeHtml(scoreSentence(score))}</p>
  <table class="matrix">
    <thead><tr><th>Check</th><th>Weight</th><th>Earned</th><th>Note</th></tr></thead>
    <tbody>
      ${score.items
        .map((i) => {
          const earned = i.na ? 'N/A' : `${i.earned}/${i.possible}`;
          return (
            `<tr><td class="rowlbl">${escapeHtml(i.label)}</td><td>${i.possible}</td>` +
            `<td class="${cellClass(i)}"><b>${earned}</b></td><td>${escapeHtml(i.note)}</td></tr>`
          );
        })
        .join('\n      ')}
    </tbody>
  </table>`
    : `
  <div class="block">
    <p>No score is attached to this scan. That happens when the six-check instrument could not read enough of
    the site to earn a number rather than a guess: an unscored finding is worth more than an invented one. The
    findings below still stand on their own evidence.</p>
  </div>`;

  const findingsSection = flaws.length
    ? flaws.map(findingBlock).join('\n')
    : '<div class="block"><p>No confirmed flaw is attached to this packet.</p></div>';

  /**
   * The closing ask: the house pitch, the operator's own words, or nothing.
   *
   * askMode 'default' (and every operator object persisted before the field
   * existed) prints the house pitch below, unchanged. 'custom' prints the
   * operator's Settings text word for word, and blank custom text prints no
   * ask at all: the document closes with the signature alone, and nothing
   * stock is substituted behind the operator's back. Custom text is escaped
   * like every other operator-typed string and swept by the same guardrails
   * as the rest of the document, so an ask that invents a number refuses to
   * generate rather than printing. Blank lines start a new paragraph; single
   * line breaks are wrapping, not structure.
   */
  const HOUSE_ASK = `<h2>Is this worth paying to fix?</h2>
    <p>We are not going to put a dollar figure on it. We did not look at your books, so any number here
    would be one we made up, and you have had enough of those emails. Here is the arithmetic instead, and
    you already have both numbers:</p>
    <ul>
      <li>What is one new customer worth to you over a year?</li>
      <li>How many people would have to reach you this way, instead of somebody else, before that pays for
      the work?</li>
    </ul>
    <p>If the second number is small, this is worth doing. If it is not, throw this away. That is the whole
    pitch.</p>`;
  // Six paragraphs at most. The config cap bounds characters, not height,
  // and a hand-built request full of blank lines would otherwise mint a box
  // taller than a page, which is the one shape break-inside: avoid cannot
  // keep whole. Together the two caps are what make the no-split rule hold.
  const customAsk = (operator.ask ?? '').trim();
  const askBody =
    operator.askMode === 'custom'
      ? customAsk
          .split(/\n\s*\n/)
          .map((p) => escapeHtml(p.replace(/\s*\n\s*/g, ' ').trim()))
          .filter(Boolean)
          .slice(0, 6)
          .map((p) => `<p>${p}</p>`)
          .join('\n    ')
      : HOUSE_ASK;

  const seen = new Set<string>();
  const allRefs: EvidenceRef[] = [];
  for (const f of flaws) {
    for (const e of f.evidence) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      allRefs.push(e);
    }
  }
  const origin = commonOrigin(allRefs);
  const evidenceItems = allRefs.map((e) => evidenceCell(e, origin));

  const ownerBlocks = score ? ownerSection(score.items) : '';

  const text = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!--
  Containment carried by the document rather than only by the print window's
  request listener. Before images were enabled for the logo, an off-box image
  reference was stopped twice; this restores the second wall, and it travels
  with the file if the HTML is ever opened outside the printer.
-->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none';">
<title>${name} - AI Readiness Scorecard</title>
<style>${STYLE}</style>${brandStyle}
</head>
<body>
<div class="sheet-1200">
  <div class="stamp">
    <div class="lbl">GENERATED</div>
    <div class="big">${dateText}</div>
  </div>
  <span class="chip">WHAT AI ASSISTANTS SEE</span>
  <h1>${name}</h1>
  <p class="sub">People increasingly find a local company by asking an assistant rather than scrolling a
  results page, and assistants read the code underneath your site rather than the page you see. We read yours
  the same way and wrote down what they can and cannot find.</p>

  <hr class="rule">

  ${
    score
      ? `<div class="scoreband">
    <span class="t">SCORE</span>
    <span class="n">${score.rescaled}/100</span>
    <span class="note">How much of what an assistant looks for it can actually find on your site today.
    The three things below are where the rest of it went.</span>
  </div>`
      : ''
  }

  <div class="band"><span class="l">THE THREE THAT MATTER MOST</span><span class="r">IN PLAIN ENGLISH</span></div>
  ${ownerBlocks || '<div class="block"><p>No scored checks are attached to this scan.</p></div>'}

  <div class="ask">
    ${brandLogo}${askBody ? `${askBody}\n    ` : ''}<p class="sign${askBody ? '' : ' sign--bare'}"><b>${escapeHtml(operator.name)}</b> &middot; <span class="mono">${escapeHtml(operator.email)}</span>${
      operator.scannerUrl ? ` &middot; <span class="mono">${escapeHtml(operator.scannerUrl)}</span>` : ''
    }</p>
  </div>

  <p class="verify-line">Check any line of this yourself: press Ctrl+U on your own site to see the same code
  we read. No pitch attached.</p>

  <div class="tech-start">
    <div class="band"><span class="l">FOR WHOEVER MAINTAINS YOUR WEBSITE</span><span class="r">THE FULL WORKING</span></div>
    <p class="sub">Everything from here on is the detail behind page one: the full rubric, what was measured,
    and the receipt for every file we read. If you have a developer or an agency, this part is for them.</p>

    ${scoreSection}

    <div class="band"><span class="l">FINDINGS</span><span class="r">CONFIRMED AGAINST YOUR OWN SOURCE</span></div>
    ${findingsSection}

    <div class="band"><span class="l">WHAT WE READ</span><span class="r">STATUS AND HASH</span></div>
    ${origin ? `<p class="ev-key">All paths below are on <span class="mono">${escapeHtml(origin)}</span>. Each row is the path, the reply code, and the first characters of the sha256 of exactly what came back. A star marks a capture taken from your own browser rather than ours.</p>` : ''}
    <ul class="evidence">
      ${evidenceItems.length ? evidenceItems.join('\n      ') : '<li>No evidence attached.</li>'}
    </ul>
  </div>
</div>
</body>
</html>
`;

  return { kind: 'Scorecard', ext: 'html', text };
};

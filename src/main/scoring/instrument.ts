/**
 * The six-check AI-readiness instrument. Encoded ONCE. No other file defines
 * weights, and no check computes its own score.
 *
 * PROVENANCE. The written spec this file inherited its pointer from is stale:
 * the document it named describes a different instrument, and no replacement
 * spec was ever filed.
 *
 * The authoritative source is therefore the delivered client scans, which
 * publish the full rubric so the client can recompute the number. Two are
 * encoded here, and this file reproduces all three published scores exactly.
 *
 * Client names are deliberately not recorded here. They were, and this repo is
 * public; a calibration comment is not a reason to publish who was scanned.
 * The operator holds the mapping from these labels to the real deliverables.
 *
 *   SCAN A, 2026-07-29 (the rubric is printed in the deliverable):
 *     AI crawlers allowed  25 | 12 retrieval open, model-corpus closed | 25 nothing blocked
 *     llms.txt             15 |  0 404                                 | 12 real, 33 URLs, money page missing
 *     Entity schema        20 |  0 no JSON-LD at all                   | 14 Org+WebSite+SearchAction, no founder
 *     FAQPage              15 |  0 no FAQ written                      |  6 on one guide page, absent on paid page
 *     Product + Review     15 |  0 free product, no Offer node         |  0 three priced tiers, no Offer node
 *     Plain-words test     15 | 13                                     | 14
 *                             = 25 of 105 = 23.8 -> 24/100             = 71 of 105 = 67.6 -> 68/100
 *
 *   SCAN B, 2026-07-26:
 *     raw 26, Product+Review marked N/A, base 90 -> 29/100
 *
 * THREE RULES THAT ARE EASY TO GET WRONG, all taken from those deliverables:
 *
 * 1. SCORING IS GRADUATED, NOT ALL-OR-NOTHING. Every item above shows partial
 *    credit. A check that returns only 0 or full weight is implemented wrong.
 *
 * 2. N/A IS MUCH NARROWER THAN "THE PRODUCT IS FREE". Scan A
 *    documents this reversal in the operator's own words: a first pass marked
 *    Product+Review N/A because the product was free, and the red team killed
 *    it, because a free product still takes a `price: 0` Offer node. N/A
 *    applies only when the business sells nothing at all, as with a corporate
 *    brand house whose stores are separate entities. Free is scored, not excused.
 *
 * 3. INSUFFICIENT CAPTURE MEANS NO NUMBER, NOT A LOW NUMBER. Two properties in
 *    that scan got per-check cells and no score, because only one page each was
 *    captured and the entity-schema check reads across a whole site: "I will not
 *    print a number my capture did not earn." scoreFrom() refuses to build a
 *    Score when coverage is inadequate; the caller reports 'unverified' instead.
 */

import { Score, ScoreItem } from '../../shared/types';

/**
 * Carried on every Score (Law 4) and therefore on anything that serialises one.
 * It used to name a real former client, which is not a thing to print on a
 * different prospect's document or publish in a repository.
 */
export const INSTRUMENT_VERSION = '2026-07-29-aeo-baseline-rubric';

export type InstrumentItemId =
  | 'crawler-access'
  | 'llms-txt'
  | 'entity-schema'
  | 'faq-page'
  | 'product-review'
  | 'plain-words';

/** Confirmed: sums to 105, and to 90 with product-review N/A. */
export const ITEM_WEIGHTS: Record<InstrumentItemId, number> = {
  'crawler-access': 25,
  'llms-txt': 15,
  'entity-schema': 20,
  'faq-page': 15,
  'product-review': 15,
  'plain-words': 15,
};

export const ITEM_LABELS: Record<InstrumentItemId, string> = {
  'crawler-access': 'AI crawlers allowed',
  'llms-txt': 'llms.txt',
  'entity-schema': 'Entity schema',
  'faq-page': 'FAQPage',
  'product-review': 'Product + Review',
  'plain-words': 'Plain-words test',
};

/**
 * Only this item may be marked N/A, and only when the business sells nothing
 * at all. See rule 2 in the file header: a FREE product does not qualify.
 */
export const NA_ELIGIBLE: InstrumentItemId[] = ['product-review'];

/**
 * Points INSIDE an item that may be marked out when the capture cannot reach
 * them, as distinct from the whole-item N/A above.
 *
 * Only one case exists and it is deliberately not general. plain-words spends 5
 * of its 15 points asking whether the business says its trade in the words a
 * customer would use; that comparison needs a category term from the listing,
 * and a listing filed under something like "general_contractor" supplies none.
 * The old code awarded all 5 in that case, reasoning that a gap in OUR data
 * should not cost the business points. True, and it should not earn them
 * either: the scorecard printed a green 15/15 beside the words "vocabulary was
 * not tested", on a document whose entire argument is that every number has a
 * source. Rule 3 already says an item nobody measured must not be averaged in
 * as though it had been measured; this applies it to part of an item.
 *
 * Out of the numerator and out of the denominator, so the business lands
 * exactly where it would if the sub-check did not exist.
 */
export const PARTIAL_NA_POINTS: Partial<Record<InstrumentItemId, number>> = {
  'plain-words': 5,
};

/** What `base` may legally come to: 105 full, less product-review, less the vocabulary 5, less both. */
const LEGAL_BASES = [105, 100, 90, 85];

/**
 * Anchors observed in delivered scans, for checks to calibrate against.
 * Values marked OBSERVED come from a published rubric. Anything else is an
 * interpolation between anchors and should be treated as provisional until a
 * real scan pins it.
 */
export const SCORING_ANCHORS: Record<InstrumentItemId, string[]> = {
  'crawler-access': [
    'OBSERVED 25/25, robots.txt open, no AI blocks (also: no robots.txt at all blocks nothing)',
    'OBSERVED 12/25, retrieval bots (OAI-SearchBot, Claude-SearchBot, PerplexityBot) open, training bots (GPTBot, ClaudeBot, CCBot, Google-Extended) blocked',
    'interpolated 0/25, search and retrieval bots blocked too',
    'NOTE: Google-Extended and meta-externalagent cost retrieval as well as training; the other training tokens do not.',
  ],
  'llms-txt': [
    'OBSERVED 12/15, real hand-written file, 33 URLs, sectioned, but the money page is missing from it',
    'OBSERVED 0/15 to 404',
    'interpolated low band, file exists but is an auto-generated platform template carrying zero brand facts',
  ],
  'entity-schema': [
    'OBSERVED 14/20, Organization + WebSite + SearchAction, consistent across pages, but no founder property and no human Person node',
    'OBSERVED 0/20, no JSON-LD at all',
    'NOTE: schema injected only by JavaScript scores as absent. A raw-HTML crawler sees nothing.',
  ],
  'faq-page': [
    'OBSERVED 6/15, FAQPage marked up on one guide page, absent on the page that matters where real questions already sit',
    'OBSERVED 0/15, no FAQ written anywhere',
    'NOTE: never credit markup for questions that are not visible page copy. Hidden FAQ schema is a penalty risk.',
  ],
  'product-review': [
    'OBSERVED 0/15, priced tiers on the page, no Offer node',
    'OBSERVED 0/15, free product, no Offer node. Free still needs a price: 0 Offer.',
    'NOTE: never award or recommend self-authored Review or AggregateRating. It is the schema type most likely to draw a manual action.',
  ],
  'plain-words': [
    'OBSERVED 14/15 and 13/15, title, meta description, og and twitter tags present, category said in the industry\'s own words',
    'no low-band example observed yet',
  ],
};

export type ItemResult = {
  id: InstrumentItemId;
  earned: number;
  na: boolean;
  /** How the number was reached, in the prospect's own terms. Never empty. */
  note: string;
  /**
   * The capture could not answer this item at all, as distinct from answering
   * it with a zero. Rule 3: an item nobody could measure must not be averaged
   * in as if it had been measured and failed. scoreFrom refuses the whole
   * number when any item carries this.
   */
  unknown?: boolean;
  /**
   * Points within this item that the capture could not reach, removed from
   * both the earned total and the base. Must match PARTIAL_NA_POINTS for the
   * item exactly; anything else is a bug and scoreFrom throws.
   */
  naPoints?: number;
  /**
   * Which shape of the finding this is, when one item has materially different
   * ones that score the same. Owner-facing copy is chosen by it: an FAQ that
   * was never written and an FAQ that was written but never marked up are both
   * zero, and telling the first business it has "already answered" its
   * customers is a false claim in its own scorecard.
   */
  variant?: string;
};

export class InsufficientCaptureError extends Error {}

/**
 * Builds the Score.
 *
 * Law 4 lives here: the returned Score has no optional fields, so an artifact
 * physically cannot render a number without also rendering its instrument and
 * its base.
 */
export function scoreFrom(results: ItemResult[], opts?: { captureSufficient?: boolean }): Score {
  if (opts?.captureSufficient === false) {
    // Rule 3. The caller must report per-check cells and no number.
    throw new InsufficientCaptureError(
      'Capture does not cover enough of the site to earn a score. Report cells, not a number.'
    );
  }

  /**
   * The same rule, enforced from the item side so it cannot be forgotten at
   * the call site. This is why Rule 3 was dead code for the whole project: the
   * only caller passed no opts at all, so the check above could never fire and
   * a confident number was always printed, including for a one-page capture of
   * a site whose FAQ markup lived on a page that was never fetched.
   */
  const unmeasured = results.filter((r) => r.unknown);
  if (unmeasured.length) {
    throw new InsufficientCaptureError(
      `${unmeasured.length} item(s) could not be measured from this capture: ` +
        unmeasured.map((r) => `${r.id} (${r.note})`).join('; ')
    );
  }

  const items: ScoreItem[] = [];
  const naItems: string[] = [];
  const markedOut: string[] = [];
  let raw = 0;
  let base = 0;

  for (const id of Object.keys(ITEM_WEIGHTS) as InstrumentItemId[]) {
    const full = ITEM_WEIGHTS[id];
    const r = results.find((x) => x.id === id);

    if (!r) {
      // Missing items score zero against a FULL base, never dropped. Dropping
      // would silently inflate the percentage of everything else.
      items.push({ id, label: ITEM_LABELS[id], earned: 0, possible: full, na: false, note: 'not evaluated' });
      base += full;
      continue;
    }

    const na = r.na && NA_ELIGIBLE.includes(id);
    if (na) {
      naItems.push(ITEM_LABELS[id]);
      items.push({ id, label: ITEM_LABELS[id], earned: 0, possible: full, na: true, note: r.note });
      continue; // excluded from BOTH raw and base
    }

    // A partial exclusion is only ever the one the instrument declares. An
    // arbitrary number here would let any check shrink its own denominator
    // until it could not lose, which is the failure this whole mechanism
    // exists to prevent.
    let out = 0;
    if (r.naPoints !== undefined && r.naPoints !== 0) {
      const allowed = PARTIAL_NA_POINTS[id];
      if (allowed === undefined || r.naPoints !== allowed) {
        throw new Error(
          `${id} marked ${r.naPoints} point(s) out; ` +
            (allowed === undefined
              ? 'this item may not mark points out at all.'
              : `only ${allowed} may be marked out.`)
        );
      }
      out = allowed;
      markedOut.push(`${ITEM_LABELS[id]} (${allowed} pts)`);
    }

    const possible = full - out;
    const earned = Math.max(0, Math.min(possible, Math.round(r.earned)));
    raw += earned;
    base += possible;
    items.push({ id, label: ITEM_LABELS[id], earned, possible, na: false, note: r.note, variant: r.variant });
  }

  if (!LEGAL_BASES.includes(base)) {
    throw new Error(
      `Instrument base computed as ${base}; only ${LEGAL_BASES.join(', ')} are valid. ` +
        'A base outside those means an item was dropped or double counted.'
    );
  }

  return {
    instrument: 'aeo-baseline-six-check',
    instrumentVersion: INSTRUMENT_VERSION,
    raw,
    base: base as Score['base'],
    rescaled: Math.round((raw / base) * 100),
    naItems,
    markedOut,
    items,
  };
}

/** The sentence every artifact prints beside the number. Never render a score without it. */
export function scoreSentence(score: Score): string {
  const clauses: string[] = [];
  if (score.naItems.length) {
    clauses.push(
      `${score.naItems.join(' and ')} ${score.naItems.length === 1 ? 'was' : 'were'} marked N/A`
    );
  }
  // Named rather than folded into the N/A clause: the reader is being told a
  // number they can recompute, and 5 points that silently left the base is the
  // one thing that would stop them arriving at it.
  // `?? []` because scores persisted in the approval ledger before partial
  // exclusion existed have no such field, and a queue that will not render an
  // older row is a worse failure than a sentence with one clause missing.
  if ((score.markedOut ?? []).length) {
    clauses.push(`${(score.markedOut ?? []).join(' and ')} could not be measured and was marked out`);
  }
  const naClause = clauses.length ? `, after ${clauses.join(', and ')}` : ', nothing marked out';
  return (
    `${score.rescaled}/100. ${score.raw} of ${score.base}${naClause}. ` +
    `Six-check instrument, sums to 105 at full measurement and rescaled to 100.`
  );
}

/** The rubric table the client uses to recompute the number themselves. */
export function rubricRows(score: Score): { check: string; weight: number; earned: string; note: string }[] {
  return score.items.map((i) => ({
    check: i.label,
    weight: i.possible,
    earned: i.na ? 'N/A' : String(i.earned),
    note: i.note,
  }));
}

/**
 * Social post renderer. Not free tier: this is the operator's own marketing,
 * not a deliverable, so 00-INDEX and paths.ts both mark it "n/a" rather than
 * a paid or free artifact.
 *
 * One short draft about the single worst CONFIRMED finding across the
 * packet, framed as a pattern observed rather than a callout, and written so
 * it cannot identify the business it came from:
 *
 *   - No business name, address, phone, website or quoted evidence text. The
 *     pattern below is a fixed, generic description of what the check
 *     CATEGORY looks like, chosen by which finding is worst, never a
 *     paraphrase of that finding's own headline or detail (which can carry
 *     specifics: a byte count, a URL fragment, a phrase from the page).
 *   - Zero digits anywhere in the post, on purpose. Every number this app is
 *     allowed to print has to trace back to score, evidence or finding text
 *     (Law 2, see ../guardrails.ts), and a paraphrase that is deliberately
 *     NOT quoting finding text has nothing to trace a number back to. Easiest
 *     correct answer: do not use one.
 *
 * All six findings always exist for a scanned candidate (one per check), so
 * "worst" means highest severity among status 'flaw'. Wall 1 in
 * ../generate.ts already refused to generate anything if any 'flaw' finding
 * were not operator-confirmed, so every candidate here already is.
 */

import { Renderer } from '../generate';
import { FlawFinding, FlawId } from '../../../shared/types';
import { shortestTruePhrase } from './plain-language';

/**
 * Last-resort fallbacks only; same rule and same history as postcard.ts's
 * PLAIN map. Shape-specific phrases live in plain-language.ts's VERDICT_COPY,
 * keyed on the variant the check stamped on the finding, so an entry here has
 * to be true of ANY flaw the check can raise.
 */
const PATTERN: Partial<Record<FlawId, string>> = {
  'ai-readiness':
    'a site missing several of the things an AI assistant looks for before it will mention a local business',
};

/**
 * Same rule as the postcard: describe what the check actually found, via the
 * scored item that lost the points or the verdict shape on the finding, and
 * only then fall back to a phrase true of any flaw.
 */
function patternFor(f: FlawFinding): string {
  return (
    shortestTruePhrase(f) ??
    PATTERN[f.checkId] ??
    'a technical gap that only shows up once you stop trusting how the page renders in a browser'
  );
}

function worstFlaw(findings: FlawFinding[]): FlawFinding | null {
  const flaws = findings.filter((f) => f.status === 'flaw');
  if (!flaws.length) return null;
  return flaws.reduce((a, b) => (b.severity > a.severity ? b : a));
}

export const socialPostRenderer: Renderer = ({ findings }) => {
  const worst = worstFlaw(findings);

  // The frame around the pattern used to read "The owner had no way to know:
  // nothing about the site looked wrong from inside a normal browser", one
  // fixed claim for every flaw. Several verdict shapes ARE visible in a normal
  // browser (a parked page, a site that does not load, a footer copyright
  // year running behind), so the frame was asserting something the pattern
  // beside it contradicted. Same bug class as the fixed hook sentences; the
  // frame now makes only the general claim, which is true regardless of which
  // shape was found.
  const post = worst
    ? `Ran another AI-readiness scan this week and found ${patternFor(worst)}. Most of what breaks ` +
      'machine visibility never looks wrong from inside a normal browser, which is why it survives. That gap ' +
      'between what an owner sees and what a machine sees is where most of this lives.'
    : 'Ran another AI-readiness scan this week. Every business I check gets a full pass on six technical checks ' +
      'before anything moves further. Most of what breaks visibility to AI assistants is invisible from inside a ' +
      'normal browser, which is exactly why it survives so long. Worth checking your own view-source if it has ' +
      'been a while.';

  const text =
    `${post}\n\n` + '---\n\n' + 'Draft only. Names nobody: no business name, address or identifying detail appears above.\n';

  return { kind: 'Social-Post', ext: 'md', text };
};

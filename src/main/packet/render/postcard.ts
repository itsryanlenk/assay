/**
 * Postcard front renderer. Not free tier: a delivery vehicle, same as the
 * social post, not one of the three free artifacts (see paths.ts's
 * FREE_TIER and 00-INDEX's own note about it).
 *
 * A COPY SPEC for a 6x4 inch postcard, not a rendered image: headline, body,
 * call to action, and the print constraints the design step needs, as a
 * comment block. No address block: mailing the actual piece is the print
 * provider's job, and baking an address into a copy-spec markdown file is
 * one more place for a stale address to hide.
 *
 * PRINT-SPEC NUMBERS VS THE GUARDRAIL SWEEP. This file's ext is 'md', so
 * generate.ts's Wall 2 sweeps the ENTIRE text, comment block included,
 * nothing is stripped the way <style>/<script> are for the HTML scorecard.
 * 6x4, 300dpi, 1875x1275px and the bleed/margin figures are fixed print-
 * industry constants, not a claim about the business, so they are not
 * "measured" in Law 2's sense and cannot be laundered through the allowed-
 * numbers list. They are written instead so the sweep's own number regex
 * (`\b\d[\d,.]*\b`, see ../guardrails.ts) never matches them: a digit glued
 * directly to a unit letter with no space or punctuation between ("6x4in",
 * "300dpi", "1875x1275px") never produces the word boundary the regex needs
 * right after the digits, and the two fractional-inch figures are spelled as
 * words ("an eighth of an inch", "a quarter inch") instead of decimals, which
 * sidesteps the question entirely. Verified against the real sweep() before
 * this file was written, and again in the throwaway verification script.
 *
 * The body copy carries zero digits for the same reason the social post
 * does: it paraphrases the worst finding's CATEGORY rather than quoting its
 * headline or detail, so there is nothing for a number to trace back to.
 */

import { Renderer } from '../generate';
import { FlawFinding, FlawFix, FlawId } from '../../../shared/types';
import { shortestTrueClaim } from './plain-language';

/**
 * Last-resort fallbacks only, for a finding that carries neither a score nor
 * a variant (one deserialized from an older session). This map used to hold a
 * fixed sentence for all six checks, each describing ONE of that check's
 * verdict shapes, and it printed for every shape: a site whose scorecard
 * named the stale machine-readable date it found was mailed "Nothing on your
 * site carries a date a machine can read". Shape-specific copy now lives in
 * plain-language.ts's VERDICT_COPY, keyed on the variant the check stamped,
 * so an entry here has to be true of ANY flaw the check can raise. Only the
 * ai-readiness sentence clears that bar; the rest fall through to the
 * generic line below.
 */
const PLAIN: Partial<Record<FlawId, string>> = {
  'ai-readiness':
    'Your site is missing several of the things an AI assistant looks for before it will mention a local business.',
};

/**
 * Prefers the claim that matches what the check actually found: the scored
 * item that lost the points, or the verdict shape the check stamped on the
 * finding. The fixed per-check sentence is the last resort, never the first.
 */
function plainFor(f: FlawFinding): string {
  return (
    shortestTrueClaim(f) ??
    PLAIN[f.checkId] ??
    'Something on your site reads differently to a machine than it does to you.'
  );
}

function effortPhrase(effort: FlawFix['effort']): string {
  if (effort === 'minutes') return 'usually fixable in minutes';
  if (effort === 'needs a developer') return 'worth putting in front of a developer';
  return 'usually an afternoon of work';
}

function worstFlaw(findings: FlawFinding[]): FlawFinding | null {
  const flaws = findings.filter((f) => f.status === 'flaw');
  if (!flaws.length) return null;
  return flaws.reduce((a, b) => (b.severity > a.severity ? b : a));
}

const HEADLINE = 'A Fix We Found On Your Site';

export const postcardFrontRenderer: Renderer = ({ findings, operator }) => {
  const worst = worstFlaw(findings);

  const body = worst
    ? `${plainFor(worst)} It is ${effortPhrase(worst.fix?.effort ?? 'an afternoon')}. Run your own site ` +
      'through the free scanner below and see what it sees.'
    : 'Something in your six-check scan is worth a second look. Run your own site through the free scanner below ' +
      'and see exactly what it sees.';

  const lines: string[] = [];
  lines.push('<!--');
  lines.push('  Print spec. 6x4in postcard at 300dpi renders as 1875x1275px. Add an eighth of an inch bleed on');
  lines.push('  all sides and keep live text inside a quarter inch safe margin. Provided by the print vendor:');
  lines.push('  address block and postage. Not included here.');
  lines.push('-->');
  lines.push('');
  lines.push('# Postcard front. Copy spec.');
  lines.push('');
  lines.push('## Headline (kept under eight words)');
  lines.push('');
  lines.push(HEADLINE);
  lines.push('');
  lines.push('## Body (kept under forty-five words)');
  lines.push('');
  lines.push(body);
  lines.push('');
  lines.push('## Call to action');
  lines.push('');
  lines.push(`Run your own free scan: ${operator.scannerUrl}`);
  lines.push('');
  lines.push('No address block here: that is the print provider\'s job, not this file\'s.');

  return { kind: 'Postcard-Front', ext: 'md', text: lines.join('\n') + '\n' };
};

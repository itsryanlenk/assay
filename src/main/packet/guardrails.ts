/**
 * Law 2, as a function: never fabricate a review, testimonial, or result.
 *
 * Every string that will reach a prospect passes through here before it is
 * written to disk. This is a post-generation sweep rather than only a prompt
 * instruction, because a prompt is a request and a sweep is a check, and the
 * two failures this catches are exactly the ones a model makes while following
 * its instructions perfectly:
 *
 *   - an invented number, which is a fabricated result
 *   - house-voice violations, which read as generic AI output and undercut the
 *     one thing the whole approach sells, that a real person looked at this
 *
 * The sweep REFUSES rather than repairs. Rewriting model output on the fly
 * would hide the fact that it went wrong, and a generator that launders its
 * own mistakes is worse than one that stops.
 */

export type GuardrailViolation = {
  rule: string;
  found: string;
  why: string;
};

/**
 * Words that mark AI-generated filler. Straight from the house prose law's
 * HARD DON'TS. Matched on word boundaries so "delve" fires and "leverages" in
 * a quoted client sentence does not get caught by accident inside a longer word.
 */
const BANNED_WORDS = [
  'delve', 'crucial', 'pivotal', 'testament', 'tapestry', 'underscore',
  'showcase', 'vibrant', 'seamless', 'robust', 'elevate', 'unlock',
  'foster', 'garner', 'leverage', 'leveraging',
];

/** Constructions the house law names explicitly. */
const BANNED_PHRASES: { re: RegExp; label: string }[] = [
  { re: /\bit'?s not just\b[^.]*\bit'?s\b/i, label: '"not just X, it\'s Y" construction' },
  { re: /\blet'?s (dive|dig) in\b/i, label: 'signposting opener' },
  { re: /\bin today'?s (fast-paced|digital|modern)\b/i, label: 'generic scene-setting opener' },
  { re: /\bresearch shows\b|\bstudies (show|indicate)\b/i, label: 'uncited institutional voice' },
  { re: /\boften\b/i, label: 'vague-frequency dodge ("often" is banned; name the condition)' },
  { re: /\b(best|worst) (in|of) (class|breed)\b/i, label: 'ranking lapse with no criteria' },
];

/** Claims about reviews or results that the app has no basis to make. */
const FABRICATION_PATTERNS: { re: RegExp; label: string }[] = [
  {
    re: /\b\d+(\.\d+)?\s*(%|percent)\s+(more|increase|boost|growth|lift|improvement)/i,
    label: 'a percentage result claim',
  },
  {
    re: /\b(customers?|clients?|users?)\s+(say|said|report|rave|love)\b/i,
    label: 'an attributed testimonial',
  },
  { re: /\b\d+x\s+(more|better|faster|traffic|leads|revenue)/i, label: 'a multiplier result claim' },
  { re: /\bguarantee[ds]?\b/i, label: 'a guarantee' },
  { re: /\bwill (rank|increase|double|triple|grow)\b/i, label: 'a predicted outcome stated as fact' },
];

/** Typographic rules from the same law. */
const TYPOGRAPHY: { test: (s: string) => boolean; label: string }[] = [
  {
    test: (s) => [0x2013, 0x2014, 0x2015].some((c) => s.includes(String.fromCharCode(c))),
    label: 'an em or en dash (use a period, comma, colon or parentheses)',
  },
  {
    test: (s) => /[‘’“”]/.test(s),
    label: 'a curly quote (straight quotes only)',
  },
  {
    test: (s) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s),
    label: 'an emoji',
  },
];

/**
 * Numbers the copy is allowed to contain: the ones this app actually measured.
 * Anything else numeric in generated prose is treated as unsourced until the
 * caller declares it.
 */
export type AllowedFacts = {
  /** Figures the app computed, as strings exactly as they will appear. */
  numbers: string[];
};

export function sweep(text: string, allowed: AllowedFacts = { numbers: [] }): GuardrailViolation[] {
  const out: GuardrailViolation[] = [];

  for (const w of BANNED_WORDS) {
    const re = new RegExp(`\\b${w}\\b`, 'i');
    const m = re.exec(text);
    if (m) {
      out.push({
        rule: 'banned AI-vocabulary word',
        found: m[0],
        why: 'The house prose law names this word as a marker of generic AI output.',
      });
    }
  }

  for (const { re, label } of BANNED_PHRASES) {
    const m = re.exec(text);
    if (m) out.push({ rule: label, found: m[0], why: 'Named in the house prose law as a hard do-not.' });
  }

  for (const { re, label } of FABRICATION_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      out.push({
        rule: 'possible fabrication',
        found: m[0],
        why: `Reads as ${label}. This app measures page source; it cannot know outcomes, and Law 2 forbids inventing them.`,
      });
    }
  }

  for (const { test, label } of TYPOGRAPHY) {
    if (test(text)) out.push({ rule: 'typography', found: label, why: 'House prose law.' });
  }

  // Any number in generated prose must be one the app computed. Years, the
  // instrument's own denominators and small ordinals are exempt because they
  // are structural rather than claims.
  const STRUCTURAL = new Set(['0', '1', '2', '3', '4', '5', '6', '10', '90', '100', '105', '72', '24']);
  for (const m of text.matchAll(/\b\d[\d,.]*\b/g)) {
    const n = m[0];
    if (STRUCTURAL.has(n)) continue;
    if (/^(19|20)\d{2}$/.test(n)) continue; // a year
    if (allowed.numbers.includes(n)) continue;
    out.push({
      rule: 'unsourced number',
      found: n,
      why: 'Every figure in a deliverable must be one this app measured, so the prospect can reproduce it.',
    });
  }

  return out;
}

/**
 * The stricter wall the operator's closing ask passes, on top of the document
 * sweep the rendered page still goes through.
 *
 * The ask is verbatim operator prose landing on a client document, and the
 * general sweep above is calibrated for house- and check-written copy: its
 * digit rule needs word boundaries and exempts structural figures, so "worth
 * about 40k", "$12k a year" and "3x the calls" all walked through it, and a
 * zero-width character glued inside a number split it into exempt single
 * digits while the page still showed the number whole. Both shapes were
 * reproduced end to end by the release-day adversary pass.
 *
 * Two rules, absolute for this one channel:
 *   - No digits. A measured figure belongs to a finding, where the reader
 *     can reproduce it; a figure in the ask is a claim with nothing behind
 *     it. Spell numbers out.
 *   - No invisible or direction-control characters. In pasted prose they
 *     exist for one reason: to make the page show something a scanner never
 *     saw.
 */
export function sweepAsk(text: string): GuardrailViolation[] {
  const out: GuardrailViolation[] = [];
  const digit = /[0-9]/.exec(text);
  if (digit) {
    out.push({
      rule: 'digit in the ask',
      found: digit[0],
      why: 'The closing ask takes no digits. A figure belongs to a finding the reader can reproduce; spell numbers out here.',
    });
  }
  // Escapes, not literal characters: a rule that bans the invisible must not
  // itself carry anything a reader cannot see.
  const invisible =
    /[\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/.exec(text);
  if (invisible) {
    out.push({
      rule: 'invisible character in the ask',
      found: `U+${(invisible[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`,
      why: 'Invisible and direction-control characters can make the page show a claim the sweep never saw.',
    });
  }
  return out;
}

export class GuardrailError extends Error {
  constructor(
    readonly artifact: string,
    readonly violations: GuardrailViolation[]
  ) {
    super(
      `${artifact} failed the copy guardrails with ${violations.length} violation(s): ` +
        violations.map((v) => `${v.rule} (${v.found})`).join('; ')
    );
    this.name = 'GuardrailError';
  }
}

/** Throws rather than repairing. See the file header for why. */
export function assertClean(artifact: string, text: string, allowed?: AllowedFacts): void {
  const violations = sweep(text, allowed);
  if (violations.length) throw new GuardrailError(artifact, violations);
}

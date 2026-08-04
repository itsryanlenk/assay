/**
 * The validator on model-written headlines.
 *
 * WHY THIS FILE EXISTS. Every check computes its verdict deterministically and
 * then asks the model to reword that one verdict into a sentence an owner
 * would understand. That sentence is printed on a document handed to a small
 * business. The page source that fed the prompt is controlled by the business
 * being scanned, so the prompt has attacker-controlled input in it and the
 * output had no check on it at all.
 *
 * Two bugs this replaces, both found in the pre-publication audit:
 *
 * 1. The dash cleanup was written as the character class [,-], which is a
 *    comma and a HYPHEN, not an em dash and an en dash. It therefore did the
 *    opposite of its comment twice over: em dashes passed through untouched,
 *    and every legitimate hyphen was rewritten to a comma, so
 *    "state-of-the-art" reached the client document as "state,of,the,art".
 *    The dashes are spelled by code point below for the same reason the suite
 *    guard spells them that way: a file that bans a character cannot contain it.
 *
 * 2. Nothing else was checked. Whatever the model returned became the headline.
 *    A URL, an accusation, a leaked assistant voice or an injected instruction
 *    would all have been printed, because the copy guardrail sweep looks for
 *    invented numbers and banned vocabulary and knows nothing about any of that.
 *
 * REJECT, DO NOT REPAIR, and fall back to the deterministic sentence. Every
 * caller already has one and it is always correct, just blunter. Silently
 * rewriting model output would hide that it went wrong, which is the same
 * reasoning packet/guardrails.ts is built on.
 *
 * Dashes are the one exception and are normalised rather than rejected: the
 * post-generation sweep rejects the WHOLE packet over a single em dash, so
 * turning it into a comma here is what the original code was trying to do and
 * keeps one stray character from costing the operator an entire run.
 */

/** Em dash, en dash, horizontal bar. Code points, never literals: see the header. */
const DASH_CODES = [0x2013, 0x2014, 0x2015];
const DASH_CHARS = DASH_CODES.map((c) => String.fromCharCode(c));

/** Longest sentence we will print. The prompt asks for under 25 words. */
const MAX_CHARS = 320;
const MAX_WORDS = 45;

/**
 * Longest run of non-space characters. MAX_WORDS splits on whitespace, so one
 * unbroken 320 character token counted as a single word and passed both caps.
 */
const MAX_TOKEN = 45;

/**
 * The characters a headline about a small business may contain: printable
 * ASCII, plus accented Latin letters for names like Muñoz and café.
 *
 * This one rule closes an entire class at once. Every REJECT entry below names
 * either a WORD or a CHARACTER SET, so a zero-width space inside "sc[ZWSP]am"
 * defeated the accusation rule, and a Cyrillic o inside "acme.c[CYR]m"
 * defeated the domain rule, both while rendering identically to a reader. NFKC
 * does not help: it folds compatibility forms, not cross-script lookalikes.
 * Chasing a confusables table would be a losing game, so anything outside this
 * set is refused before the rules run and the rules only ever see characters
 * that mean what they look like.
 *
 * Written as code points rather than a character class for the same reason the
 * dashes above are: a file that decides which characters are allowed should
 * not depend on which characters survived being typed into it.
 */
const ASCII_MIN = 0x20;
const ASCII_MAX = 0x7e;
const LATIN_MIN = 0x00c0; // capital A with grave
const LATIN_MAX = 0x024f; // end of Latin Extended-B

function hasDisallowedCharacter(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const allowed = (c >= ASCII_MIN && c <= ASCII_MAX) || (c >= LATIN_MIN && c <= LATIN_MAX);
    if (!allowed) return true;
  }
  return false;
}

/**
 * Shapes that must never reach a client document. Each one is a thing a model
 * produces while going wrong, not a thing a correct headline ever contains.
 */
const REJECT: { re: RegExp; why: string }[] = [
  { re: /https?:\/\//i, why: 'contains a URL' },
  { re: /\bwww\./i, why: 'contains a URL' },
  {
    /**
     * Any label.tld, not a list of 13 suffixes out of well over a thousand.
     * The old list let acme.ru and acme.cc through untouched. Requiring two or
     * more letters after the dot keeps "e.g." and "i.e." out of it, and a
     * sentence-ending period is followed by a space or nothing, so it does not
     * match either.
     *
     * THE EXEMPTION IS NOT OPTIONAL. Without it this rule matches the
     * documents this entire app is about. `robots.txt` is a label and a
     * three-letter suffix, so every headline naming one was refused as "a
     * domain name" and silently replaced by the deterministic sentence, which
     * turned the model-written headline off for the crawl-index, llms and
     * sitemap findings. That is most of them, and the rewritten headline is
     * the product.
     *
     * Residual risk, accepted knowingly: `.md` is also Moldova's TLD, so a
     * bare `evil.md` now passes this rule. A bare label with no scheme and no
     * `www.` is a weak vector, the URL and `www.` rules above still catch a
     * real link, and the cost of the alternative is breaking the app's main
     * output on every scan.
     */
    re: /\b[a-z0-9][a-z0-9-]*\.(?!(?:txt|xml|md|html?|json|jsx?|tsx?|css|csv|ya?ml|png|jpe?g|gif|svg|pdf|webp|ico)\b)[a-z]{2,24}\b/i,
    why: 'contains a domain name',
  },
  { re: /\S+@\S+\.\S+/, why: 'contains an email address' },
  {
    re: /\b(as an ai|as a language model|language model|i cannot|i can not|i am unable|i do not have)\b/i,
    why: 'speaks as an assistant rather than about the business',
  },
  {
    re: /\b(ignore|disregard|forget) (all |any |the )?(previous|prior|above|earlier)\b/i,
    why: 'carries an injected instruction',
  },
  { re: /^\s*(system|assistant|user|human)\s*:/im, why: 'carries a chat role marker' },
  { re: /\b(system|developer) prompt\b/i, why: 'refers to the prompt' },
  { re: /<[a-z/!][^>]*>/i, why: 'contains markup' },
  { re: /```|~~~/, why: 'contains a code fence' },
  {
    re: /\b(scam|fraud|fraudulent|criminal|illegal|lawsuit|sue|negligent|incompetent)\b/i,
    why: 'makes an accusation this app has no evidence for',
  },
];

export type HeadlineResult = {
  headline: string;
  usedAgent: boolean;
  /** Why the model's sentence was refused. Absent when it was used. */
  rejectedBecause?: string;
};

/**
 * Normalises and validates one model-written sentence.
 *
 * @param raw       exactly what the agent returned
 * @param fallback  the deterministic sentence, used whenever raw is refused
 */
export function cleanHeadline(raw: string, fallback: string): HeadlineResult {
  let s = (raw ?? '').trim();
  if (s === '') return { headline: fallback, usedAgent: false, rejectedBecause: 'empty' };

  /**
   * Fold compatibility forms FIRST, so that by the time any rule looks at a
   * word, the fullwidth spelling of that word IS that word. NFKC also turns a
   * non-breaking space into a plain space, an ellipsis into three periods and
   * a ligature into its letters. It deliberately carries none of the load for
   * lookalikes across scripts: see hasDisallowedCharacter.
   */
  s = s.normalize('NFKC');

  // Strip a wrapping quote pair the model added around the whole sentence.
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();

  // Em and en dashes become commas, which is what the broken [,-] class was
  // reaching for. Surrounding whitespace is absorbed so "fine <dash> but"
  // does not become "fine , but".
  for (const d of DASH_CHARS) {
    s = s.split(new RegExp(`\\s*${d}\\s*`, 'g')).join(', ');
  }

  // Curly quotes would fail the packet sweep later. Straight quotes only.
  s = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();

  if (s === '') return { headline: fallback, usedAgent: false, rejectedBecause: 'empty after cleanup' };

  // One sentence means one line. A multi-line answer is the model doing
  // something other than what it was asked.
  if (/[\r\n]/.test(s)) {
    return { headline: fallback, usedAgent: false, rejectedBecause: 'spans more than one line' };
  }
  /**
   * Every rule below is a regex over this string, so this check has to come
   * before them: it is what guarantees they are reading characters that mean
   * what they look like. An invisible character inside a banned word, or a
   * lookalike letter from another script, defeated every one of them.
   */
  if (hasDisallowedCharacter(s)) {
    return {
      headline: fallback,
      usedAgent: false,
      rejectedBecause: 'contains an invisible or non-Latin character',
    };
  }

  if (s.length > MAX_CHARS) {
    return { headline: fallback, usedAgent: false, rejectedBecause: `longer than ${MAX_CHARS} characters` };
  }
  const words = s.split(/\s+/);
  if (words.length > MAX_WORDS) {
    return { headline: fallback, usedAgent: false, rejectedBecause: `longer than ${MAX_WORDS} words` };
  }
  // A word cap counted by whitespace says nothing about one unbroken run of
  // 320 characters, which is one word and reached the document as one word.
  if (words.some((w) => w.length > MAX_TOKEN)) {
    return {
      headline: fallback,
      usedAgent: false,
      rejectedBecause: `contains a run of more than ${MAX_TOKEN} characters without a space`,
    };
  }

  for (const { re, why } of REJECT) {
    if (re.test(s)) return { headline: fallback, usedAgent: false, rejectedBecause: why };
  }

  return { headline: s, usedAgent: true };
}

/** Exported for scripts/test-parsers.js. */
export const __test = { cleanHeadline, MAX_CHARS, MAX_WORDS, MAX_TOKEN };

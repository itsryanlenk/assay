/**
 * The leak patterns, in ONE place.
 *
 * There were two copies: `preflight.js` scanning the git publish set, and the
 * scrub guard in `test-parsers.js` walking src/, scripts/ and docs/. Different
 * file sets, deliberately, because "what git would publish" and "what is on
 * disk" are different questions and both are worth asking. But the PATTERNS
 * were duplicated, and on 2026-07-31 they drifted the way duplicated rules
 * always do: a false positive was fixed in one copy, the suite failed on the
 * other, and the fix had to be made twice in the same hour.
 *
 * The walkers stay separate. The rules live here.
 *
 * Built from character codes where a pattern names a character it bans, so
 * this file never contains what it is looking for and cannot flag itself.
 */

const fs = require('node:fs');
const path = require('node:path');

const BS = String.fromCharCode(92);

/**
 * A drive letter, then a Users or Documents directory, then a name.
 *
 * Spelled through BS rather than written out, and NOT illustrated with an
 * example either: the first draft of this file put a literal one in this
 * comment and the guard immediately flagged its own source, which is the
 * failure the code-point construction exists to prevent. A file that decides
 * what may not appear must not contain it.
 */
const winUserPath = new RegExp(`[A-Za-z]:${BS}${BS}{1,2}(Users|Documents)${BS}${BS}`, 'i');

/** A POSIX home directory: a home or Users root, then a user name. */
const nixHomePath = /(^|[\s"'(=])\/(home|Users)\/[A-Za-z0-9._-]+\//;

/**
 * An address, where the final label is alphabetic or punycode.
 *
 * It used to end `(\.[A-Za-z0-9-]+)+`, which accepts a digit-only last label,
 * so npm version syntax read as an address: `electron@43.2.0` was reported as
 * "email domain 43.2.0" and failed the publish gate on a documentation edit.
 * Every real TLD is alphabetic, and `xn--` covers the internationalised ones,
 * so requiring that loses no address a real leak would use.
 *
 * Global. Use with `String.prototype.match`, which ignores lastIndex; do NOT
 * call `.test()` on it, which is stateful when the g flag is set.
 */
const emailLike =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(xn--[A-Za-z0-9-]+|[A-Za-z]{2,})\b/g;

/** Reserved for documentation, so not a leak. RFC 2606 and RFC 6761. */
const safeEmailDomain = /(^|\.)(example\.(com|org|net)|test|invalid|localhost|example)$/i;

/** Shapes that are secrets no matter what surrounds them. */
const keyShaped =
  /(sk-ant-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/;

/**
 * The operator's private term list, or [] when it is absent.
 *
 * Untracked on purpose: an earlier guard inlined these strings, so publishing
 * the repo published the very list it existed to protect. A fresh clone still
 * gets every generic pattern above, just not the personal names.
 */
const SCRUB_TERMS_FILE = '.scrub-terms';

function scrubTerms(root) {
  return scrubTermsState(root).terms;
}

/**
 * The list, and whether the file was there at all.
 *
 * The distinction is the whole point. `scrubTerms` returning `[]` meant two
 * completely different things: "the operator declared no terms" and "this
 * machine has no list, so the guard that exists to keep client names out of
 * source checked nothing." Preflight printed PASS for both. On any clone but
 * one, the strongest check in the suite was reporting success while doing
 * nothing, which is worse than not having it.
 */
function scrubTermsState(root) {
  const f = path.join(root, SCRUB_TERMS_FILE);
  if (!fs.existsSync(f)) return { present: false, terms: [] };
  const terms = fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  return { present: true, terms };
}

/**
 * A North American phone number in a form a business publishes.
 *
 * STRUCTURAL, because the term list cannot be. Twice now a real business's
 * details reached a tracked file, and both times the guard was silent: it
 * only knew names already written down, and the business had been scanned an
 * hour earlier. A pattern does not need to be told who was scanned.
 *
 * Fictional ranges are exempt so fixtures stay writable: area code 555, and
 * the reserved 555-01XX block. Everything else is a real number and the
 * build stops.
 */
const phoneLike =
  /(?<!\d)(?:\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4})(?!\d)/g;

function isFictionalPhone(raw) {
  const d = raw.replace(/\D+/g, '').slice(-10);
  // 555 anywhere in the exchange or area position is the reserved space.
  return d.startsWith('555') || d.slice(3, 6) === '555';
}

/** A US street address: a number, a name, and a street-type suffix. */
const streetLike =
  /\b\d{1,6}\s+(?:[A-Z][A-Za-z.'-]*\s+){0,3}(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Circle|Cir|Place|Pl|Parkway|Pkwy|Highway|Hwy|Terrace|Ter|Trail|Trl)\b\.?/g;

/** A US city/state/ZIP tail, which is what makes an address identifying. */
const cityStateZip = /\b[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g;

/** ZIPs used by fixtures. 00000 is not assignable; 12345 is a known dummy. */
const FICTIONAL_ZIPS = new Set(['00000', '12345', '99999']);

/** Every leak in one text, as human-readable reasons. */
function leaksIn(text, terms) {
  const found = [];
  if (winUserPath.test(text)) found.push('an absolute Windows user path');
  if (nixHomePath.test(text)) found.push('an absolute home directory path');
  if (keyShaped.test(text)) found.push('a key-shaped string');

  for (const m of text.match(phoneLike) ?? []) {
    if (!isFictionalPhone(m)) found.push(`a real-looking phone number ${m}`);
  }
  const realPlaces = (text.match(cityStateZip) ?? []).filter(
    (m) => !FICTIONAL_ZIPS.has((m.match(/\d{5}/) ?? [''])[0])
  );
  for (const m of realPlaces) found.push(`a city, state and ZIP (${m.trim()})`);
  // A street line alone is weak evidence: "100 Example Rd" is a fixture. It
  // becomes an address when a REAL city and ZIP sit beside it, which is the
  // combination that identifies a business.
  if (realPlaces.length) {
    for (const m of text.match(streetLike) ?? []) {
      found.push(`a street address (${m.trim()})`);
    }
  }
  for (const m of text.match(emailLike) ?? []) {
    const domain = m.slice(m.indexOf('@') + 1);
    if (!safeEmailDomain.test(domain)) found.push(`email domain ${domain}`);
  }
  for (const term of terms) {
    if (text.toLowerCase().includes(term.toLowerCase())) found.push(`operator term "${term}"`);
  }
  return found;
}

module.exports = {
  winUserPath,
  nixHomePath,
  emailLike,
  safeEmailDomain,
  keyShaped,
  phoneLike,
  streetLike,
  cityStateZip,
  isFictionalPhone,
  SCRUB_TERMS_FILE,
  scrubTerms,
  scrubTermsState,
  leaksIn,
};

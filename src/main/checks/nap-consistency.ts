/**
 * Check 6 of 6, do Name, Address and Phone agree between the Google listing
 * and the business's own site?
 *
 * Exactly two sources, both already available before this check runs: the
 * Google Places listing on the candidate (name, address, phone) and the
 * business's own homepage, read two ways: Organization/LocalBusiness JSON-LD
 * first, plain visible text as a fallback. Detection is entirely
 * deterministic; nothing here asks a model whether two strings mean the same
 * business. The model is called exactly once, at the end, to turn the worst
 * computed signal into a sentence, and only when severity > 0.
 *
 * Every finding here is CONFIRMATION 'remote', for the same reason as every
 * other check in this file: what this app's crawler receives is routinely not
 * what the operator sees in Ctrl+U.
 *
 * NORMALISATION IS THE WHOLE GAME. A false "mismatch" is the worst possible
 * output of this check, worse than missing a real one, because it hands the
 * operator a claim that falls apart the moment the business reads it:
 *   - Phone: trailing extension stripped, then digits only, compared on the
 *     LAST 10 when one side carries a country code and the other does not.
 *   - Name: lowercased, punctuation stripped, trailing legal suffix stripped
 *     (inc, llc, ltd, co, corporation, company, pte).
 *   - Address: the street number and the postal code are compared
 *     INDEPENDENTLY. A full-string address comparison breaks on formatting
 *     differences alone and is not used here.
 * When a field cannot be found on the business's own site at all, that is NOT
 * a mismatch. It is recorded as a gap (surfaced via unverifiedNote), never as
 * a 'flaw' about that specific field. Accusing a business of a wrong phone
 * number because this check simply failed to find theirs on their own page is
 * exactly the failure this codebase exists to prevent.
 *
 * SEVERITY IS HOOK QUALITY, NOT TECHNICAL SEVERITY.
 *
 *   4  the phone on their own site differs from the phone on their Google
 *      listing. Customers reading one of the two reach nobody, and the owner
 *      sees only one of them
 *   3  the postal code or street number on their site differs from the
 *      listing
 *   2  no phone or address appears anywhere in their own page source, so
 *      nothing can be cross-checked against the listing. This is a real flaw
 *      about their own site's discoverability, independent of any match
 *      question, and is provable with one Ctrl+F
 *   1  NAP is present as visible text but not in JSON-LD, so a machine has to
 *      guess it
 *   0  the two sources agree
 *
 * Name is compared and reported for context (the check's own question names
 * all three of N, A and P), but a name difference alone never sets the
 * severity: the spec's ladder only assigns a severity to a proven phone or
 * address mismatch, and business names legitimately vary between a short
 * Google listing name and a formal on-site name far more often than phone or
 * address do. Treating that variance as a flaw would itself risk the false
 * accusation this check exists to avoid.
 */

import { Candidate, FlawFinding, FlawFix, Severity } from '../../shared/types';
import { CheckContext, FlawCheck } from './types';
import { cleanHeadline } from './headline';

/** Strips scripts, styles and tags to get what a reader would actually see. */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D+/g, '');
}

/** If one side carries a country code and the other does not, the last 10 digits still line up. */
function last10(digits: string): string {
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Drops a trailing extension ("x12", "ext. 12", "#12", a tel: href's
 * ";ext=12") before digits are compared. Without this, a listing phone
 * carrying an extension has more than ten digits, last10 keeps the extension
 * and drops area-code digits instead, and the comparison names the business's
 * own correct number as wrong, at this check's top severity.
 */
function stripExtension(phone: string): string {
  return phone.replace(/[\s,;]*(?:x|ext\.?|extension|#)[\s.:=]*\d{1,6}\s*$/i, '');
}

/** The digits a phone is actually compared on: extension gone, country code trimmed by last10. */
function phoneKey(phone: string): string {
  return last10(digitsOnly(stripExtension(phone)));
}

function phonesMatch(a: string, b: string): boolean {
  const da = phoneKey(a);
  const db = phoneKey(b);
  return da.length >= 7 && db.length >= 7 && da === db;
}

const LEGAL_SUFFIXES = ['inc', 'llc', 'ltd', 'co', 'corporation', 'company', 'pte'];

/** Lowercase, punctuation stripped to spaces, collapsed whitespace. A safe search haystack. */
function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** normalizeForSearch, plus a trailing legal-entity suffix dropped. Never empties a real name. */
function normalizeName(name: string): string {
  const words = normalizeForSearch(name).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.includes(words[words.length - 1] ?? '')) {
    words.pop();
  }
  return words.join(' ');
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na.length > 0 && na === nb;
}

/** The leading street number of a formatted address, e.g. "123 Main St" -> "123", "123A Main St" -> "123a". */
function leadingStreetNumber(streetAddress: string): string | null {
  const m = /^\s*(\d+[a-z]?)\b/i.exec(streetAddress);
  return m?.[1]?.toLowerCase() ?? null;
}

/** First 5-digit US ZIP found anywhere in a string; ZIP+4 is truncated to the base 5. */
function extractPostalCode(address: string): string | null {
  const m = /\b(\d{5})(?:-\d{4})?\b/.exec(address);
  return m?.[1] ?? null;
}

/** True when `token` (digits, optionally one trailing letter) appears as a standalone token in `text`. */
function hasStandaloneToken(text: string, token: string): boolean {
  const re = new RegExp(`(?<![a-z0-9])${token}(?![a-z0-9])`, 'i');
  return re.test(text);
}

// ---------------------------------------------------------------------------
// JSON-LD. A local, self-contained copy of the same shape ai-readiness.ts
// uses: only real <script type="application/ld+json"> tags count, @graph is
// flattened, and malformed JSON counts as absent, which is what a downstream
// parser sees.
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

function extractJsonLdNodes(html: string): Node[] {
  const out: Node[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const body = (m[1] ?? '').trim();
    if (!body) continue;
    try {
      const parsed: unknown = JSON.parse(body);
      const push = (v: unknown): void => {
        if (!v || typeof v !== 'object') return;
        const n = v as Node;
        if (Array.isArray(n['@graph'])) for (const g of n['@graph'] as unknown[]) push(g);
        else out.push(n);
      };
      if (Array.isArray(parsed)) for (const p of parsed) push(p);
      else push(parsed);
    } catch {
      /* malformed JSON-LD counts as absent, which is what a parser sees */
    }
  }
  return out;
}

function typesOf(n: Node): string[] {
  const t = n['@type'];
  const arr = Array.isArray(t) ? t : [t];
  return arr.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
}

function stringField(n: Node, key: string): string | null {
  const v = n[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function hasStructuredAddress(n: Node): boolean {
  const addr = n['address'];
  return Boolean(addr && typeof addr === 'object' && !Array.isArray(addr));
}

/**
 * Picks the node most likely to be "the business", scored rather than matched
 * on @type alone. schema.org has dozens of LocalBusiness subtypes (Store,
 * Restaurant, ProfessionalService, HairSalon, ...) and a site is free to use
 * any of them; matching only 'organization', 'localbusiness' or a name ending
 * in "business" misses most of the list; a real page in this app's own
 * field-testing used @type "Store", which is exactly that miss. Scoring on
 * the fields this check actually needs (telephone, a structured address)
 * finds the right node regardless of which subtype string the site chose,
 * and falls back to the @type heuristic only when nothing carries either.
 */
function findBusinessNode(nodes: Node[]): Node | null {
  let best: Node | null = null;
  let bestScore = 0;
  for (const n of nodes) {
    let score = 0;
    if (stringField(n, 'telephone')) score += 2;
    if (hasStructuredAddress(n)) score += 2;
    if (typesOf(n).some((t) => t === 'organization' || t === 'localbusiness' || t.endsWith('business'))) score += 1;
    if (stringField(n, 'name')) score += 1;
    if (score > bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function addressFields(n: Node): { streetAddress: string | null; postalCode: string | null } {
  const addr = n['address'];
  if (addr && typeof addr === 'object' && !Array.isArray(addr)) {
    const a = addr as Node;
    return { streetAddress: stringField(a, 'streetAddress'), postalCode: stringField(a, 'postalCode') };
  }
  // A plain-string address cannot be split into components reliably, so the
  // structured comparison treats it as absent; the text fallback still sees it.
  return { streetAddress: null, postalCode: null };
}

// ---------------------------------------------------------------------------
// Per-aspect comparison. Each of name/phone/street/postal produces exactly
// one of these, and 'not-found' is never allowed to become 'mismatch'.
// ---------------------------------------------------------------------------

/**
 * 'not-found' and 'no-reference' are NOT the same thing and collapsing them
 * ships a false claim.
 *
 *   not-found     we had a value from the Google listing, looked for it in the
 *                 site's own source, and it is not there. A fact about them.
 *   no-reference  the Google listing gave us nothing to look for. A fact about
 *                 OUR data, and it says nothing whatsoever about their site.
 *
 * Places omits absent fields, so mapPlace() legitimately produces phone: null
 * and address: ''. Treating that as 'not-found' made the check tell a business
 * that publishes its phone and address on its homepage that its source states
 * neither, and hand them a fix telling them to publish what was already there.
 * Only 'not-found' may drive severity.
 */
type AspectResult =
  | { state: 'match' }
  | { state: 'mismatch'; detail: string }
  | { state: 'text-only'; detail: string }
  | { state: 'not-found'; detail: string }
  | { state: 'no-reference'; detail: string };

/**
 * US-shaped phone numbers in text, bounded on both ends so a longer digit run
 * cannot be sliced into one. Same shape booking-path uses; kept local for the
 * same reason the JSON-LD reader is local.
 */
/**
 * A phone number needs a phone AFFORDANCE, not three adjacent numbers.
 *
 * The first version reused booking-path's pattern, whose separators are
 * optional and include whitespace. visibleText() flattens the document to one
 * space-separated string, so "Service packages 150 250 1200" matched and a
 * client document would have named a price list as the business's phone
 * number, at this check's top severity, with a fix telling them to correct
 * it. Found by the pre-merge review with that exact fixture.
 *
 * Accepted: a parenthesised area code, or explicit - / . separators. Rejected:
 * bare space-separated triples and bare ten-digit runs, neither of which a
 * business publishes as a number to call.
 */
const PHONE_TEXT_RE =
  /(?<!\d)(?:\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\d{3}[-.]\d{3}[-.]\d{4})(?!\d)/g;

/** Digits in a tel: href, which survive no matter how the link is labelled. */
const TEL_HREF_RE = /href\s*=\s*["']tel:([^"']+)["']/gi;

/** Labels that mean a number is not the line a customer calls. */
const NON_VOICE_NEAR = /\b(fax|facsimile|sms|text\s+only|tty|tdd)\b/i;

/**
 * Every distinct number the page offers as a phone, in source order.
 *
 * Reads the markup as well as the visible text: an icon-only tel: link has no
 * digits a reader can see, and missing those was the original bug in another
 * costume. Deduped on the last ten digits, so one number written three ways
 * is reported once rather than as three numbers.
 */
function phonesOnPage(visible: string, html: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string): void => {
    const key = phoneKey(raw);
    if (key.length < 10 || seen.has(key)) return;
    seen.add(key);
    found.push(raw.trim());
  };

  for (const m of visible.matchAll(PHONE_TEXT_RE)) {
    // A fax or SMS line is not the number a customer calls, and naming one as
    // the business's phone on a client document is its own false claim.
    const before = visible.slice(Math.max(0, m.index - 24), m.index);
    if (NON_VOICE_NEAR.test(before)) continue;
    add(m[0]);
  }
  for (const m of html.matchAll(TEL_HREF_RE)) add(m[1] ?? '');

  return found;
}

function comparePhone(
  sitePhoneJsonLd: string | null,
  siteHtmlDigits: string,
  placesPhone: string | null,
  visibleForPhones: string,
  htmlForPhones: string
): AspectResult {
  if (!placesPhone || phoneKey(placesPhone).length < 7) {
    return {
      state: 'no-reference',
      detail: 'Phone: the Google listing has no usable phone number on file, so phone could not be cross-checked.',
    };
  }
  const placesD = phoneKey(placesPhone);

  if (sitePhoneJsonLd) {
    if (phonesMatch(sitePhoneJsonLd, placesPhone)) return { state: 'match' };
    return {
      state: 'mismatch',
      detail: `Phone: Google lists ${placesPhone}, the site's own structured data lists ${sitePhoneJsonLd}.`,
    };
  }

  if (siteHtmlDigits.includes(placesD)) {
    return {
      state: 'text-only',
      detail: "Phone: the number on the Google listing appears on the page, but only as plain text or a tel: link, not inside structured data (JSON-LD).",
    };
  }

  /**
   * The listing's number is not here. That is NOT the same as "no phone
   * number is here", and the two were conflated: a site publishing a
   * different number was told on a client document that it published none,
   * while the same packet's booking-path finding listed the tel: links it
   * had just read. Reported by the operator against a live business.
   *
   * A different number is also the better finding. Two numbers in the wild
   * for one business is the severity-4 hook this check exists to produce;
   * an absence is a two.
   */
  const onPage = phonesOnPage(visibleForPhones, htmlForPhones).filter((p) => phoneKey(p) !== placesD);
  if (onPage.length > 0) {
    return {
      state: 'mismatch',
      detail:
        `Phone: Google lists ${placesPhone}, and the homepage shows ` +
        `${onPage.slice(0, 3).join(', ')}. The listing's number appears nowhere on the page.`,
    };
  }

  return {
    state: 'not-found',
    detail: `Phone: no phone number matching the Google listing (${placesPhone}) appears anywhere in the homepage source.`,
  };
}

function compareStreetNumber(
  siteStreetJsonLd: string | null,
  visibleTextValue: string,
  placesStreetNumber: string | null
): AspectResult {
  if (!placesStreetNumber) {
    return {
      state: 'no-reference',
      detail: "Street number: the Google listing's address has no parseable leading street number, so it could not be cross-checked.",
    };
  }
  if (siteStreetJsonLd) {
    if (siteStreetJsonLd === placesStreetNumber) return { state: 'match' };
    return {
      state: 'mismatch',
      detail: `Street number: Google lists ${placesStreetNumber}, the site's own structured data lists ${siteStreetJsonLd}.`,
    };
  }
  if (hasStandaloneToken(visibleTextValue, placesStreetNumber)) {
    return {
      state: 'text-only',
      detail: 'Street number: matches the Google listing as plain text on the page, but the address is not in structured data (JSON-LD).',
    };
  }
  return {
    state: 'not-found',
    detail: `Street number: no street address matching the Google listing (number ${placesStreetNumber}) appears anywhere in the homepage source.`,
  };
}

function comparePostalCode(
  siteJsonLdPostal: string | null,
  visibleTextValue: string,
  placesPostalCode: string | null
): AspectResult {
  if (!placesPostalCode) {
    return {
      state: 'no-reference',
      detail: "Postal code: the Google listing's address has no parseable postal code, so it could not be cross-checked.",
    };
  }
  if (siteJsonLdPostal) {
    const siteFive = /\d{5}/.exec(siteJsonLdPostal)?.[0] ?? null;
    if (siteFive === placesPostalCode) return { state: 'match' };
    return {
      state: 'mismatch',
      detail: `Postal code: Google lists ${placesPostalCode}, the site's own structured data lists ${siteJsonLdPostal}.`,
    };
  }
  if (hasStandaloneToken(visibleTextValue, placesPostalCode)) {
    return {
      state: 'text-only',
      detail: 'Postal code: matches the Google listing as plain text on the page, but the address is not in structured data (JSON-LD).',
    };
  }
  return {
    state: 'not-found',
    detail: `Postal code: no postal code matching the Google listing (${placesPostalCode}) appears anywhere in the homepage source.`,
  };
}

function compareName(siteNameJsonLd: string | null, normalizedVisibleText: string, placesName: string): AspectResult {
  const placesNorm = normalizeName(placesName);
  if (siteNameJsonLd) {
    if (namesMatch(siteNameJsonLd, placesName)) return { state: 'match' };
    return {
      state: 'mismatch',
      detail: `Name: Google lists "${placesName}", the site's own structured data lists "${siteNameJsonLd}".`,
    };
  }
  if (placesNorm.length > 0 && normalizedVisibleText.includes(placesNorm)) {
    return {
      state: 'text-only',
      detail: 'Name: the business name on the Google listing appears on the page as plain text, but not in structured data (JSON-LD).',
    };
  }
  return {
    state: 'not-found',
    detail: "Name: the business name on the Google listing does not appear in the homepage source, structured or plain text.",
  };
}

type Aspects = { phone: AspectResult; street: AspectResult; postal: AspectResult; name: AspectResult };

/** `variant` names the verdict shape so the hook copy can be keyed on it; see FlawFinding.variant. */
type Verdict = { severity: Severity; status: FlawFinding['status']; detail: string; fix?: FlawFix; variant?: string };

/**
 * Collects every applicable verdict; the caller takes the highest severity.
 * A proven phone mismatch and a proven postal mismatch can both be true at
 * once, and the worse one should lead while the other still shows up in
 * "Also found".
 */
function verdicts(a: Aspects, candidate: Candidate, placesPostalCode: string | null): Verdict[] {
  const out: Verdict[] = [];

  if (a.phone.state === 'mismatch') {
    out.push({
      severity: 4,
      status: 'flaw',
      variant: 'phone-mismatch',
      detail: a.phone.detail,
      fix: {
        summary:
          "Make the phone number match on both sides: update the site's structured data (and the printed number) to the correct one, or correct the Google Business Profile if the site is the one that is right.",
        effort: 'minutes',
      },
    });
  }

  if (a.street.state === 'mismatch') {
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'street-mismatch',
      detail: a.street.detail,
      fix: {
        summary: "Update the street address in the site's structured data to match the Google Business Profile, or correct the listing if the site is right.",
        effort: 'minutes',
      },
    });
  }

  if (a.postal.state === 'mismatch') {
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'postal-mismatch',
      detail: a.postal.detail,
      fix: {
        summary: "Update the postal code in the site's structured data to match the Google Business Profile, or correct the listing if the site is right.",
        effort: 'minutes',
      },
    });
  }

  const phoneAbsent = a.phone.state === 'not-found';
  const addressAbsent = a.street.state === 'not-found' && a.postal.state === 'not-found';
  if (phoneAbsent || addressAbsent) {
    const missing: string[] = [];
    if (phoneAbsent) missing.push('a phone number');
    if (addressAbsent) missing.push('an address');
    const addrSnippet = placesPostalCode
      ? `{ "@type": "PostalAddress", "postalCode": "${placesPostalCode}" }`
      : undefined;
    const fix: FlawFix = {
      summary: `Publish ${missing.join(' and ')} on the page as visible text, and ideally inside Organization or LocalBusiness JSON-LD, so it can be found and cross-checked at all.`,
      effort: 'minutes',
    };
    if (addressAbsent && addrSnippet) fix.snippet = addrSnippet;
    out.push({
      severity: 2,
      status: 'flaw',
      // Three shapes, because the hook sentence names what is unfindable and
      // may not name more than was proven absent.
      variant: phoneAbsent && addressAbsent ? 'nap-unfindable' : phoneAbsent ? 'phone-unfindable' : 'address-unfindable',
      detail: `The homepage source does not state ${missing.join(' or ')}, so it cannot be cross-checked against the Google listing at all.`,
      fix,
    });
  }

  const textOnly = [a.phone, a.street, a.postal, a.name].filter(
    (x): x is { state: 'text-only'; detail: string } => x.state === 'text-only'
  );
  if (textOnly.length > 0) {
    out.push({
      severity: 1,
      status: 'flaw',
      variant: 'nap-text-only',
      detail: textOnly.map((x) => x.detail).join(' '),
      fix: {
        summary: 'Add Organization or LocalBusiness JSON-LD carrying name, telephone and address.',
        effort: 'an afternoon',
        snippet:
          '<script type="application/ld+json">\n' +
          JSON.stringify(
            {
              '@context': 'https://schema.org',
              '@type': 'LocalBusiness',
              name: candidate.name,
              ...(candidate.phone ? { telephone: candidate.phone } : {}),
              ...(placesPostalCode ? { address: { '@type': 'PostalAddress', postalCode: placesPostalCode } } : {}),
            },
            null,
            2
          ) +
          '\n</script>',
      },
    });
  }

  if (out.length === 0) {
    out.push({
      severity: 0,
      status: 'ok',
      detail: "Name, address and phone found on the business's own site agree with the Google Business listing.",
    });
  }

  return out;
}

function worst(list: Verdict[]): Verdict {
  return list.reduce((a, b) => (b.severity > a.severity ? b : a));
}

/**
 * Builds the aspect set from raw HTML and a candidate. This is the one path:
 * run() calls it, and scripts/test-parsers.js exercises it directly (same
 * rationale as crawl-index.ts's __test export). The phone false-positive was
 * a wiring bug between the comparison and its inputs, and a test that calls
 * comparePhone directly would have passed while the shipped path stayed
 * broken. A test seam that is a copy of the shipped wiring cannot catch a
 * wiring bug either, so run() and the tests share this function.
 */
function aspectsFor(html: string, candidate: Candidate): Aspects {
  const nodes = extractJsonLdNodes(html);
  const business = findBusinessNode(nodes);
  const { streetAddress: rawStreet, postalCode: sitePostalJsonLd } = business
    ? addressFields(business)
    : { streetAddress: null, postalCode: null };
  const visible = visibleText(html);
  return {
    phone: comparePhone(
      business ? stringField(business, 'telephone') : null,
      digitsOnly(html),
      candidate.phone,
      visible,
      html
    ),
    street: compareStreetNumber(
      rawStreet ? leadingStreetNumber(rawStreet) : null,
      visible,
      leadingStreetNumber(candidate.address)
    ),
    postal: comparePostalCode(sitePostalJsonLd, visible, extractPostalCode(candidate.address)),
    name: compareName(
      business ? stringField(business, 'name') : null,
      normalizeForSearch(visible),
      candidate.name
    ),
  };
}

const HEADLINE_SYSTEM_PROMPT = [
  'You rephrase ONE already-diagnosed website problem into a sentence a small-business owner would understand.',
  'You are not an auditor. The diagnosis is done. Your only job is wording.',
  'Rules, all mandatory:',
  '- Restate ONLY the problem given under "The problem". Do not mention or look for any other issue.',
  '- If something in the facts looks wrong to you but is not the stated problem, ignore it.',
  '- Output exactly one sentence, under 25 words, and nothing else. No preamble, no quotes, no markdown.',
  '- Address the owner as "your". You may name what the finding mechanically prevents, such as software being unable to read something. Never assert an outcome the scan did not measure: no lost customers, no missed calls, no unanswered numbers, no rankings.',
  '- Use ONLY the facts given. Invent nothing: no traffic numbers, no rankings, no revenue.',
  '- No em dashes or en dashes. No emoji. Straight quotes only.',
  '- Do not use: leverage, crucial, pivotal, robust, seamless, unlock, elevate, delve, showcase.',
  '- Plain and specific beats dramatic. Do not exaggerate beyond the facts.',
].join('\n');

export const napConsistencyCheck: FlawCheck = {
  id: 'nap-consistency',
  label: 'NAP consistency',

  async run(ctx: CheckContext): Promise<FlawFinding> {
    const listed = ctx.candidate.website;
    if (!listed) {
      return {
        checkId: 'nap-consistency',
        status: 'disqualified',
        severity: 0,
        headline: `${ctx.candidate.name} has no website listed, so there is nothing to cross-check against the Google listing.`,
        detail: 'Google Places returned no website for this business.',
        evidence: [],
        confirmation: 'remote',
        unverifiedNote: 'No website field was returned by the Places API for this place.',
      };
    }

    const capture = await ctx.fetch(listed);
    const html = capture.body;

    // A truncated capture is a prefix; a phone or address below the cut was
    // never read, so no "nothing states this" claim can be made from it.
    if (
      capture.ref.httpStatus !== 200 ||
      capture.ref.storeError ||
      html.trim() === '' ||
      capture.ref.truncated
    ) {
      return {
        checkId: 'nap-consistency',
        status: 'unverified',
        severity: 0,
        headline: `Could not read ${ctx.candidate.name}'s homepage, so name, address and phone could not be cross-checked.`,
        detail: `The homepage returned ${capture.ref.httpStatus ?? 'no response'}${capture.ref.transportError ? ` (${capture.ref.transportError})` : ''}${capture.ref.storeError ? `, and the capture could not be saved (${capture.ref.storeError}), so there is no file to cite` : ''}.`,
        evidence: [capture.ref].filter((r) => r.httpStatus !== null),
        confirmation: 'remote',
        unverifiedNote: 'Homepage capture failed; NAP signals need it.',
      };
    }

    const aspects = aspectsFor(html, ctx.candidate);
    const placesPostalCode = extractPostalCode(ctx.candidate.address);

    const all = verdicts(aspects, ctx.candidate, placesPostalCode);
    const verdict = worst(all);

    let detail =
      all.length > 1
        ? `${verdict.detail} Also found: ${all.filter((v) => v !== verdict).map((v) => v.detail).join(' ')}`
        : verdict.detail;

    // Name differences never move severity (see file header), but the check's
    // own question names all three of N, A and P, so a proven mismatch is
    // still worth a sentence.
    if (aspects.name.state === 'mismatch') {
      detail += ` ${aspects.name.detail} This does not change the severity above.`;
    }

    // Gaps are not mismatches and must never read as one. Collected regardless
    // of which verdict won, so a field this check could not verify is always
    // visible even when it did not decide the severity.
    // Both kinds of gap are disclosed: one we looked for and did not find, and
    // one we never had a value to look for. Neither may drive severity, and
    // both have to be visible so the finding never reads as more complete than
    // it is.
    const gaps = [aspects.phone, aspects.street, aspects.postal, aspects.name]
      .filter(
        (x): x is { state: 'not-found' | 'no-reference'; detail: string } =>
          x.state === 'not-found' || x.state === 'no-reference'
      )
      .map((x) => x.detail);
    const unverifiedNote = gaps.length > 0 ? gaps.join(' ') : undefined;

    let headline = `${ctx.candidate.name}: ${verdict.detail}`;
    if (verdict.severity > 0) {
      const res = await ctx.agent.run({
        systemPrompt: HEADLINE_SYSTEM_PROMPT,
        prompt:
          `Facts:\nBusiness name: ${ctx.candidate.name}\nWebsite: ${listed}\n` +
          `The problem: ${verdict.detail}\n\nWrite the one sentence now.`,
        model: 'sonnet',
        timeoutMs: 60_000,
      });
      if (res.ok && res.text.trim() !== '') {
        headline = cleanHeadline(res.text, headline).headline;
      }
    } else {
      headline = verdict.detail;
    }

    const finding: FlawFinding = {
      checkId: 'nap-consistency',
      status: verdict.status,
      severity: verdict.severity,
      headline,
      detail,
      evidence: [capture.ref].filter((r) => r.httpStatus !== null),
      confirmation: 'remote',
      fix: verdict.fix,
      variant: verdict.variant,
    };
    if (unverifiedNote) finding.unverifiedNote = unverifiedNote;
    return finding;
  },
};

/** Exported for scripts/test-parsers.js only, same rationale as crawl-index.ts's __test export. */
export const __test = {
  aspectsFor,
  phonesOnPage,
  digitsOnly,
  last10,
  phonesMatch,
  normalizeForSearch,
  normalizeName,
  namesMatch,
  leadingStreetNumber,
  extractPostalCode,
  hasStandaloneToken,
  extractJsonLdNodes,
  findBusinessNode,
  comparePhone,
  compareStreetNumber,
  comparePostalCode,
  compareName,
  verdicts,
};

/**
 * Check 5 of 6, can a customer actually reach this business from the page,
 * and can a machine see how?
 *
 * Detection is entirely deterministic, over bytes fetch-raw already captured,
 * hashed and wrote to disk. Nothing here asks a model whether the page has a
 * phone number. The model is called exactly once, at the end, to turn the
 * worst computed signal into a sentence, and only when severity > 0: a clean
 * page has no hook to phrase, and asking for one anyway is how a model
 * invents a problem that detection never found.
 *
 * Every finding here is CONFIRMATION 'remote'. What this app's crawler
 * receives is routinely not what the operator sees in Ctrl+U, so nothing
 * leaves the app until an operator paste confirms it.
 *
 * SEVERITY IS HOOK QUALITY, NOT TECHNICAL SEVERITY. A phone number that only
 * exists inside a script tag is the best hook available to this check: the
 * page renders fine for the owner, who has no reason to ever doubt it, and a
 * crawler reading the raw source finds nothing at all.
 *
 *   4  the only phone or contact path exists solely inside JavaScript, so it
 *      renders for the owner and is invisible in the source
 *   3  no tel: link, no mailto:, no contact form and no booking link anywhere.
 *      There is no machine-readable way to reach them
 *   2  a phone number is visible as text but is not a tel: link, so it is not
 *      tappable on a phone
 *   1  only ONE kind of reachable channel exists. Either a contact form, a
 *      contact-page link, a mailto: or a booking link with no phone anywhere
 *      on the page, or a tel: link with nothing else at all. The spec names
 *      the first direction ("contact form only, no phone"); a bare tel: link
 *      with no other path is treated the same way by symmetry, because it is
 *      the same failure in the other direction: one channel, and anyone who
 *      cannot use it is stuck
 *   0  at least one tel: link plus one other reachable path
 *
 * Also computed, reported as a note rather than its own severity: whether the
 * phone number Google Places has on file for this business appears anywhere
 * at all in the homepage source, compared on digits only.
 *
 * PAGES READ. The homepage, plus the same-origin contact page it links to,
 * when it links one and that page answers. The check already detects the
 * contact link, and a check that names the road sign follows it: a live scan
 * wrote "the only way to reach this business is a link to a contact page"
 * beside its own capture of that page carrying a tel: link. Every sentence
 * scopes itself to the pages actually read.
 */

import { Candidate, FlawFinding, FlawFix, Severity } from '../../shared/types';
import { CheckContext, FlawCheck } from './types';
import { cleanHeadline } from './headline';

/** Pulls an attribute value, handling double, single and unquoted forms. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v === undefined ? null : v.trim();
}

/** Strips scripts, styles and tags to count what a reader would actually see. */
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

/** Removes every <script> block, body included. Used to test what survives without JS. */
function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
}

function digitsOnly(s: string): string {
  return s.replace(/\D+/g, '');
}

/** If a number carries a country code and the other side does not, the last 10 digits still line up. */
function last10(digits: string): string {
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every <a> tag's href and its own visible text, in source order. */
function extractAnchors(html: string): { href: string | null; text: string }[] {
  const out: { href: string | null; text: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const openTag = `<a${m[1] ?? ''}>`;
    out.push({ href: attr(openTag, 'href'), text: stripTags(m[2] ?? '') });
  }
  return out;
}

function extractForms(html: string): string[] {
  return html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
}

/** EXACT match on type, same discipline as crawl-index.ts's attribute matching. A prefix is not a value. */
function formHasContactInput(formHtml: string): boolean {
  for (const tag of formHtml.match(/<input\b[^>]*>/gi) ?? []) {
    const type = attr(tag, 'type')?.toLowerCase();
    if (type === 'email' || type === 'tel') return true;
  }
  return false;
}

function looksLikeContactLink(href: string | null, text: string): boolean {
  const t = text.toLowerCase();
  if (/\bcontact(\s+us)?\b/.test(t) || /\bget in touch\b/.test(t)) return true;
  if (href) {
    try {
      const path = new URL(href, 'https://placeholder.invalid').pathname.toLowerCase();
      if (/\bcontact\b/.test(path)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

const BOOKING_HOSTS = [
  'calendly.com',
  'squareup.com',
  'square.site',
  'opentable.com',
  'resy.com',
  'acuityscheduling.com',
  'booksy.com',
  'vagaro.com',
  'setmore.com',
  'schedulicity.com',
  'housecallpro.com',
  'getjobber.com',
  'jobber.com',
  'servicetitan.com',
];

function bookingHostOf(href: string): string | null {
  let host: string;
  try {
    host = new URL(href).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
  return BOOKING_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? null;
}

/** A US-shaped phone number in plain text. Bounded on both ends so it does not eat part of a longer digit run. */
const PHONE_TEXT_RE = /(?<!\d)\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g;

/**
 * The same shape with the separators REQUIRED, for scanning raw source where
 * bare ten-digit runs are usually IDs rather than phones. See Signals.sourcePhones.
 */
const PHONE_FORMATTED_RE = /(?<!\d)\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g;

/**
 * `telephone` property values from JSON-LD script bodies, by shape rather than
 * by parsing: the check needs the values, not the graph, and a regex cannot be
 * broken by one malformed sibling block the way JSON.parse can.
 */
function schemaTelephones(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/"telephone"\s*:\s*"([^"]{7,24})"/g)) {
    const v = (m[1] ?? '').trim();
    if (digitsOnly(v).length >= 7) out.push(v);
  }
  return out;
}

type ContactSignals = {
  telNumbers: string[];
  mailtoAddresses: string[];
  hasContactForm: boolean;
  hasContactPageLink: boolean;
  bookingHosts: string[];
  textPhones: string[];
};

function computeContactSignals(html: string): ContactSignals {
  const anchors = extractAnchors(html);

  const telNumbers = [
    ...new Set(
      anchors
        .map((a) => a.href)
        .filter((h): h is string => !!h && /^tel:/i.test(h.trim()))
        .map((h) => h.trim().slice(4).trim())
        .filter((h) => h !== '')
    ),
  ];

  const mailtoAddresses = [
    ...new Set(
      anchors
        .map((a) => a.href)
        .filter((h): h is string => !!h && /^mailto:/i.test(h.trim()))
        .map((h) => (h.trim().slice(7).split('?')[0] ?? '').trim())
        .filter((h) => h !== '')
    ),
  ];

  const hasContactForm = extractForms(html).some(formHasContactInput);
  const hasContactPageLink = anchors.some((a) => looksLikeContactLink(a.href, a.text));

  const bookingHosts = [
    ...new Set(
      anchors
        .map((a) => a.href)
        .filter((h): h is string => !!h)
        .map(bookingHostOf)
        .filter((h): h is string => !!h)
    ),
  ];

  const textPhones = [...new Set(visibleText(html).match(PHONE_TEXT_RE) ?? [])];

  return { telNumbers, mailtoAddresses, hasContactForm, hasContactPageLink, bookingHosts, textPhones };
}

function anyContactSignal(s: ContactSignals): boolean {
  return (
    s.telNumbers.length > 0 ||
    s.mailtoAddresses.length > 0 ||
    s.hasContactForm ||
    s.hasContactPageLink ||
    s.bookingHosts.length > 0 ||
    s.textPhones.length > 0
  );
}

/** The union of two pages' signals: an extra page can only add channels. */
function mergeSignals(a: ContactSignals, b: ContactSignals): ContactSignals {
  return {
    telNumbers: [...new Set([...a.telNumbers, ...b.telNumbers])],
    mailtoAddresses: [...new Set([...a.mailtoAddresses, ...b.mailtoAddresses])],
    hasContactForm: a.hasContactForm || b.hasContactForm,
    hasContactPageLink: a.hasContactPageLink || b.hasContactPageLink,
    bookingHosts: [...new Set([...a.bookingHosts, ...b.bookingHosts])],
    textPhones: [...new Set([...a.textPhones, ...b.textPhones])],
  };
}

/**
 * The first same-origin contact page the homepage links to, absolute.
 *
 * The check already detects this link and used to write "the only way to
 * reach this business is a link to a contact page" while the contact page
 * itself, captured in the same scan, carried a tel: link. A check that names
 * the road sign follows it. Same-origin only, www-insensitive, because a
 * lookalike domain must never be fetched as the business's own site, and one
 * hop only: this is the page contact information lives on, not a crawl.
 */
function contactPageUrl(html: string, base: string): string | null {
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    return null;
  }
  const originHost = origin.hostname.replace(/^www\./i, '').toLowerCase();
  for (const a of extractAnchors(html)) {
    if (!a.href || !looksLikeContactLink(a.href, a.text)) continue;
    const href = a.href.trim();
    if (/^(mailto|tel|javascript|#)/i.test(href)) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, origin.origin);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') continue;
    if (resolved.hostname.replace(/^www\./i, '').toLowerCase() !== originHost) continue;
    // The homepage itself, or an anchor on it, is not a second page.
    if (resolved.pathname.replace(/\/+$/, '') === '') continue;
    resolved.hash = '';
    return resolved.toString();
  }
  return null;
}

type Signals = ContactSignals & {
  /** True only when every signal above disappears once <script> blocks are removed. */
  jsOnlyContactPath: boolean;
  placesPhone: string | null;
  placesPhoneMissingFromSource: boolean;
  /**
   * The pathname of the contact page whose bytes are IN these signals, null
   * when the verdict rests on the homepage alone. Every sentence that speaks
   * about where something is absent scopes itself with this: a claim may
   * never be wider than the pages that were actually read.
   */
  contactPagePath: string | null;
  /**
   * Phone numbers in the RAW homepage source, scripts and JSON-LD included.
   * `textPhones` sees only visible text, so "no phone number appears
   * anywhere in the page source" shipped on a live scan whose own cited
   * capture carried a telephone field in its structured data. A claim about
   * the source has to read all of the source.
   *
   * Conservative on purpose: raw source is mostly script, where any bare
   * ten-digit ID matches a loose phone shape, and the first version of this
   * signal harvested asset IDs and timestamps that would have printed on a
   * client document as phone numbers. Only two shapes count: a telephone
   * property inside JSON-LD, and a separator-formatted number anywhere.
   */
  sourcePhones: string[];
};

/** `variant` names the verdict shape so the hook copy can be keyed on it; see FlawFinding.variant. */
type Verdict = { severity: Severity; status: FlawFinding['status']; detail: string; fix?: FlawFix; variant?: string };

function describeOtherPaths(s: Signals): string {
  const parts: string[] = [];
  if (s.mailtoAddresses.length > 0) parts.push(`a mailto: link (${s.mailtoAddresses.join(', ')})`);
  if (s.hasContactForm) parts.push('a contact form asking for an email or phone number');
  if (s.hasContactPageLink) parts.push('a link to a contact page');
  if (s.bookingHosts.length > 0) parts.push(`a third-party booking link (${s.bookingHosts.join(', ')})`);
  return parts.join(', ');
}

/**
 * Collects every applicable verdict; the caller takes the highest severity.
 * Conditions are evaluated independently rather than as an if/else chain, so
 * a page that is both JS-only AND has no static fallback correctly surfaces
 * both, and the worse one leads.
 */
function verdicts(s: Signals, candidate: Candidate): Verdict[] {
  const out: Verdict[] = [];

  const hasTel = s.telNumbers.length > 0;
  const hasOtherPath = s.mailtoAddresses.length > 0 || s.hasContactForm || s.hasContactPageLink || s.bookingHosts.length > 0;
  const hasTextPhone = s.textPhones.length > 0;
  // Where these signals were read, said in every absence claim. Older test
  // fixtures omit the field, which reads as homepage-only, the old meaning.
  const scope = s.contactPagePath
    ? `the homepage or its contact page (${s.contactPagePath})`
    : 'the homepage';

  const telSnippet = candidate.phone
    ? `<a href="tel:+1${digitsOnly(candidate.phone)}">${candidate.phone}</a>`
    : '<a href="tel:+15551234567">(555) 123-4567</a>';

  if (s.jsOnlyContactPath) {
    out.push({
      severity: 4,
      status: 'flaw',
      variant: 'js-only-contact',
      detail:
        'The only contact path on this page sits inside a <script> block, so a crawler ' +
        'reading the raw HTML finds no way to reach this business at all.',
      fix: {
        summary: 'Put a real tel: link, mailto: link or contact link directly in the page markup, not only inside a script.',
        effort: 'needs a developer',
        snippet: telSnippet,
      },
    });
  }

  if (!hasTel && !hasOtherPath) {
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'no-contact-path',
      detail:
        `No tel: link, no mailto: link, no contact form and no booking link appear anywhere on ${scope}. There is ` +
        'no machine-readable way to reach this business from it.',
      fix: {
        summary: 'Add a tel: link for the phone number and at least one more way to reach you, such as a mailto: link or a short contact form.',
        effort: 'minutes',
        snippet: telSnippet,
      },
    });
  }

  if (!hasTel && hasTextPhone) {
    out.push({
      severity: 2,
      status: 'flaw',
      variant: 'phone-not-tappable',
      detail:
        `A phone number (${s.textPhones.join(', ')}) is printed on the page as plain text, ` +
        'and no tel: link wraps it.',
      fix: {
        summary: 'Wrap the printed phone number in a tel: link.',
        effort: 'minutes',
        snippet: `<a href="tel:+1${digitsOnly(s.textPhones[0] ?? candidate.phone ?? '')}">${s.textPhones[0] ?? ''}</a>`,
      },
    });
  }

  if (!hasTel && !hasTextPhone && hasOtherPath) {
    const sourcePhones = s.sourcePhones ?? [];
    if (s.placesPhone && !s.placesPhoneMissingFromSource) {
      out.push({
        severity: 1,
        status: 'flaw',
        variant: 'no-phone',
        detail:
          `The only way to reach this business is ${describeOtherPaths(s)}.` +
          ` The number Google lists (${s.placesPhone}) does appear in the page source, but no tel: link on the page makes it tappable.`,
        fix: {
          summary: 'Add a phone number as a tel: link, so visitors who would rather call than fill out a form or email can.',
          effort: 'minutes',
          snippet: telSnippet,
        },
      });
    } else if (sourcePhones.length > 0) {
      // A phone IS in the source, only in markup a visitor never sees. The
      // old sentence here ("no phone number appears anywhere in the page
      // source") was contradicted by the very capture it cited.
      out.push({
        severity: 1,
        status: 'flaw',
        variant: 'phone-in-markup-only',
        detail:
          `The only way to reach this business is ${describeOtherPaths(s)}. ` +
          `A phone number (${sourcePhones.slice(0, 3).join(', ')}) sits in the markup of ${scope}. ` +
          'Nothing there prints it as text or makes it tappable.',
        fix: {
          summary: 'Print the phone number on the page and wrap it in a tel: link, so visitors who would rather call can.',
          effort: 'minutes',
          snippet: `<a href="tel:+1${digitsOnly(sourcePhones[0] ?? '')}">${sourcePhones[0] ?? ''}</a>`,
        },
      });
    } else {
      out.push({
        severity: 1,
        status: 'flaw',
        variant: 'no-phone',
        detail:
          `The only way to reach this business is ${describeOtherPaths(s)}.` +
          (s.contactPagePath
            ? ` No phone number appears in the homepage source or on its contact page (${s.contactPagePath}).`
            : ' No phone number appears anywhere in the homepage source.'),
        fix: {
          summary: 'Add a phone number as a tel: link, so visitors who would rather call than fill out a form or email can.',
          effort: 'minutes',
          snippet: telSnippet,
        },
      });
    }
  }

  if (hasTel && !hasOtherPath) {
    out.push({
      severity: 1,
      status: 'flaw',
      variant: 'phone-only',
      detail:
        `The only reachable contact path is a phone number (${s.telNumbers.join(', ')}). There is no mailto: link, ` +
        `contact form, contact page link or booking link anywhere on ${scope}.`,
      fix: {
        summary: 'Add a mailto: link or a short contact form alongside the phone number.',
        effort: 'minutes',
      },
    });
  }

  if (hasTel && hasOtherPath) {
    out.push({
      severity: 0,
      status: 'ok',
      detail:
        `At least one tel: link (${s.telNumbers.join(', ')}) is present on ${scope}, ` +
        `along with ${describeOtherPaths(s)}.`,
    });
  }

  if (out.length === 0) {
    out.push({ severity: 0, status: 'ok', detail: 'A reachable contact path is present on the page.' });
  }

  return out;
}

function worst(list: Verdict[]): Verdict {
  return list.reduce((a, b) => (b.severity > a.severity ? b : a));
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

export const bookingPathCheck: FlawCheck = {
  id: 'booking-path',
  label: 'Booking and contact path',

  async run(ctx: CheckContext): Promise<FlawFinding> {
    const listed = ctx.candidate.website;
    if (!listed) {
      return {
        checkId: 'booking-path',
        status: 'disqualified',
        severity: 0,
        headline: `${ctx.candidate.name} has no website listed, so there is no contact path to check.`,
        detail: 'Google Places returned no website for this business.',
        evidence: [],
        confirmation: 'remote',
        unverifiedNote: 'No website field was returned by the Places API for this place.',
      };
    }

    const capture = await ctx.fetch(listed);
    const html = capture.body;

    // A page that never loaded has no readable contact signals, and reporting
    // "no contact path" for a fetch failure would be a false claim about the
    // page rather than a true claim about the fetch. website.ts already scores
    // the load failure itself.
    // A truncated capture is a prefix. "No tel: link appears anywhere on the
    // page" cannot be said about bytes that were never read.
    if (
      capture.ref.httpStatus !== 200 ||
      capture.ref.storeError ||
      html.trim() === '' ||
      capture.ref.truncated
    ) {
      return {
        checkId: 'booking-path',
        status: 'unverified',
        severity: 0,
        headline: `Could not read ${ctx.candidate.name}'s homepage, so the contact path could not be checked.`,
        detail: `The homepage returned ${capture.ref.httpStatus ?? 'no response'}${capture.ref.transportError ? ` (${capture.ref.transportError})` : ''}${capture.ref.storeError ? `, and the capture could not be saved (${capture.ref.storeError}), so there is no file to cite` : ''}.`,
        evidence: [capture.ref].filter((r) => r.httpStatus !== null),
        confirmation: 'remote',
        unverifiedNote: 'Homepage capture failed; contact-path signals need it.',
      };
    }

    const rawSignals = computeContactSignals(html);
    const strippedSignals = computeContactSignals(stripScripts(html));

    /**
     * Follow the road sign. When the homepage links a same-origin contact
     * page, that page is where contact information lives, and it is one
     * ctx.fetch away (memoised: ai-readiness usually read it already in the
     * same scan). A live scan wrote "the only way to reach this business is
     * a link to a contact page" while the packet's own capture of that page
     * carried a tel: link.
     */
    const contactUrl = contactPageUrl(html, listed);
    const contact = contactUrl ? await ctx.fetch(contactUrl) : null;
    const contactReadable =
      contact !== null &&
      contact.ref.httpStatus === 200 &&
      !contact.ref.storeError &&
      contact.body.trim() !== '' &&
      !contact.ref.truncated;
    const contactPagePath = (() => {
      if (!contactReadable || !contactUrl) return null;
      try {
        return new URL(contactUrl).pathname;
      } catch {
        return null;
      }
    })();

    const effStripped = contactReadable
      ? mergeSignals(strippedSignals, computeContactSignals(stripScripts(contact.body)))
      : strippedSignals;
    const effRaw = contactReadable ? mergeSignals(rawSignals, computeContactSignals(contact.body)) : rawSignals;
    // The ladder is built on what survives without JavaScript, because that is
    // what a crawler that does not execute scripts actually sees. jsOnlyContactPath
    // catches the case where raw has something the stripped version does not.
    const jsOnlyContactPath = anyContactSignal(effRaw) && !anyContactSignal(effStripped);

    const rawSources = contactReadable ? [html, contact.body] : [html];

    const placesPhone = ctx.candidate.phone;
    const placesLast10 = placesPhone ? last10(digitsOnly(placesPhone)) : '';
    const readDigits = digitsOnly(rawSources.join(' '));
    const placesPhoneMissingFromSource = placesLast10.length === 10 && !readDigits.includes(placesLast10);

    // The RAW source of every page read, scripts included: this feeds the
    // sentences that speak about the source, so it has to read all of it, and
    // only the shapes that are really phones. Deduped on the last ten digits
    // so "+1-555-010-2000" and "555-010-2000" read as one number.
    const seenPhones = new Set<string>();
    const sourcePhones: string[] = [];
    for (const p of rawSources.flatMap((src) => [...schemaTelephones(src), ...(src.match(PHONE_FORMATTED_RE) ?? [])])) {
      const dedupeKey = last10(digitsOnly(p));
      if (dedupeKey.length < 7 || seenPhones.has(dedupeKey)) continue;
      seenPhones.add(dedupeKey);
      sourcePhones.push(p.trim());
    }

    const s: Signals = {
      ...effStripped,
      jsOnlyContactPath,
      placesPhone,
      placesPhoneMissingFromSource,
      contactPagePath,
      sourcePhones,
    };

    const all = verdicts(s, ctx.candidate);
    const verdict = worst(all);

    /**
     * The reconciling pass never recomputes this verdict from fewer pages
     * than the crawler read. A linked contact page the operator did not
     * paste arrives as an unanswered capture; scoring the homepage alone
     * would manufacture a contrary verdict from missing bytes and the gate
     * would read it as the site answering crawlers differently. The check
     * abstains and names the paste that settles it, except when the homepage
     * alone already reaches severity 0: an extra page only ever ADDS
     * channels, so nothing it holds could change that verdict.
     */
    const contactUnanswered =
      contact !== null && (contact.ref.httpStatus === null || Boolean(contact.ref.transportError));
    if (ctx.reconciling && contactUrl && contactUnanswered && verdict.severity > 0) {
      let pastePath = contactUrl;
      try {
        pastePath = new URL(contactUrl).pathname || contactUrl;
      } catch {
        /* keep the full url */
      }
      return {
        checkId: 'booking-path',
        status: 'unverified',
        severity: 0,
        headline: `The homepage links a contact page (${pastePath}) that was not pasted, so the contact path could not be re-checked.`,
        detail:
          `The homepage links a contact page (${pastePath}) whose source was not pasted. The reachable ` +
          'contact set includes that page, so no verdict is re-computed without it.',
        evidence: [capture.ref].filter((r) => r.httpStatus !== null),
        confirmation: 'remote',
        unverifiedNote: `Paste the source of the contact page (${pastePath}) to settle the contact-path finding.`,
      };
    }

    let detail =
      all.length > 1
        ? `${verdict.detail} Also found: ${all.filter((v) => v !== verdict).map((v) => v.detail).join(' ')}`
        : verdict.detail;

    if (s.placesPhoneMissingFromSource && s.placesPhone) {
      detail += ` Google Places lists a phone number for this business (${s.placesPhone}) that does not appear anywhere in the ${
        contactPagePath ? 'source of the homepage or its contact page' : 'homepage source'
      }, on its own digits.`;
    }

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

    return {
      checkId: 'booking-path',
      status: verdict.status,
      severity: verdict.severity,
      headline,
      detail,
      // Both pages the verdict rests on are cited; a claim is never wider
      // than the captures under it.
      evidence: [capture.ref, ...(contactReadable ? [contact.ref] : [])].filter((r) => r.httpStatus !== null),
      confirmation: 'remote',
      fix: verdict.fix,
      variant: verdict.variant,
      // The confirm UI offers a paste slot per extra page, and the
      // reconciling pass above refuses to re-judge without it.
      extraPages: contactReadable && contactUrl ? [contactUrl] : undefined,
    };
  },
};

/** Exported for scripts/test-parsers.js only, same rationale as crawl-index.ts's __test export. */
export const __test = {
  attr,
  visibleText,
  stripScripts,
  digitsOnly,
  last10,
  extractAnchors,
  formHasContactInput,
  looksLikeContactLink,
  bookingHostOf,
  computeContactSignals,
  anyContactSignal,
  verdicts,
};

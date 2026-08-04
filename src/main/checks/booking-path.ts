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

type Signals = ContactSignals & {
  /** True only when every signal above disappears once <script> blocks are removed. */
  jsOnlyContactPath: boolean;
  placesPhone: string | null;
  placesPhoneMissingFromSource: boolean;
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
        'No tel: link, no mailto: link, no contact form and no booking link appear anywhere on the page. There is ' +
        'no machine-readable way to reach this business.',
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
    out.push({
      severity: 1,
      status: 'flaw',
      variant: 'no-phone',
      detail:
        `The only way to reach this business is ${describeOtherPaths(s)}.` +
        (s.placesPhone && !s.placesPhoneMissingFromSource
          ? ` The number Google lists (${s.placesPhone}) does appear in the page source, but no tel: link on the page makes it tappable.`
          : ' No phone number appears anywhere in the page source.'),
      fix: {
        summary: 'Add a phone number as a tel: link, so visitors who would rather call than fill out a form or email can.',
        effort: 'minutes',
        snippet: telSnippet,
      },
    });
  }

  if (hasTel && !hasOtherPath) {
    out.push({
      severity: 1,
      status: 'flaw',
      variant: 'phone-only',
      detail:
        `The only reachable contact path is a phone number (${s.telNumbers.join(', ')}). There is no mailto: link, ` +
        'contact form, contact page link or booking link anywhere on the page.',
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
      detail: `At least one tel: link (${s.telNumbers.join(', ')}) is present, along with ${describeOtherPaths(s)}.`,
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
    // The ladder is built on what survives without JavaScript, because that is
    // what a crawler that does not execute scripts actually sees. jsOnlyContactPath
    // catches the case where raw has something the stripped version does not.
    const jsOnlyContactPath = anyContactSignal(rawSignals) && !anyContactSignal(strippedSignals);

    const placesPhone = ctx.candidate.phone;
    const placesLast10 = placesPhone ? last10(digitsOnly(placesPhone)) : '';
    const homepageDigits = digitsOnly(html);
    const placesPhoneMissingFromSource = placesLast10.length === 10 && !homepageDigits.includes(placesLast10);

    const s: Signals = {
      ...strippedSignals,
      jsOnlyContactPath,
      placesPhone,
      placesPhoneMissingFromSource,
    };

    const all = verdicts(s, ctx.candidate);
    const verdict = worst(all);

    let detail =
      all.length > 1
        ? `${verdict.detail} Also found: ${all.filter((v) => v !== verdict).map((v) => v.detail).join(' ')}`
        : verdict.detail;

    if (s.placesPhoneMissingFromSource && s.placesPhone) {
      detail += ` Google Places lists a phone number for this business (${s.placesPhone}) that does not appear anywhere in the homepage source, on its own digits.`;
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
      evidence: [capture.ref].filter((r) => r.httpStatus !== null),
      confirmation: 'remote',
      fix: verdict.fix,
      variant: verdict.variant,
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

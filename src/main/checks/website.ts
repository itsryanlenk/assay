/**
 * Check 1 of 6, does the business have a website that actually works?
 *
 * Every signal below is computed from bytes that fetch-raw already captured,
 * hashed and wrote to disk. Nothing here asks a model what a page says. The
 * model is called exactly once, at the end, to turn the computed signals into
 * a sentence about THIS business, because "the worst flaw becomes the hook, in
 * the business's own words" is the outreach rule and a severity integer is not
 * a sentence a human responds to.
 *
 * SEVERITY IS HOOK QUALITY, NOT TECHNICAL SEVERITY. This ladder decides who
 * gets contacted, so it ranks by how good a finding is to open a conversation
 * with: invisible to the owner, provable by them in one keystroke, and
 * consequential. A site that is visibly down ranks LOW, because the owner
 * already knows. The two prospects this practice actually converted were both
 * invisible technical findings on sites that looked fine to their owners.
 *
 *   4  loads fine in a browser, near-empty to a crawler (JS-only render)
 *   3  no <title>, or a parked/placeholder page, or genuinely empty
 *   2  errors out or will not load
 *   1  the "website" is a social profile they chose on purpose
 *   0  works
 *   --  no website listed: DISQUALIFIED, never ranked
 *
 * Disqualification is not "this business is bad", it is "we have no fix to
 * hand them". No site means no scan, no PDF and no schema starter, so there is
 * no free tier to deliver and the only pitch left would be "buy a website from
 * me". That is a different business.
 *
 * Every finding here is CONFIRMATION 'remote'. What this app's crawler
 * receives is routinely not what the operator sees in Ctrl+U, and the whole
 * pitch depends on the prospect reproducing the claim. Nothing leaves the app
 * until an operator paste confirms it.
 */

import { Candidate, FlawFinding, FlawFix, Severity } from '../../shared/types';
import { CheckContext, FlawCheck } from './types';
import { cleanHeadline } from './headline';

/** Markers that a page is a placeholder rather than a business site. Matched case-insensitively. */
const PARKED_MARKERS = [
  'this domain is for sale',
  'domain is for sale',
  'buy this domain',
  'coming soon',
  'under construction',
  'future home of',
  'default web page',
  'apache2 ubuntu default page',
  'welcome to nginx',
  'iis windows server',
  'site not published',
  'godaddy.com',
  'sedoparking',
  'parked domain',
  'account suspended',
];

const SOCIAL_HOSTS = [
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'yelp.com',
  'linktr.ee',
];

/** Strips scripts, styles and tags to count what a reader would actually see. */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decodes the entities that actually show up in titles. Without this the
 * title reads as "Marsh &amp; Co", and a model shown that string will
 * helpfully report a bug that does not exist.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
      const named: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
        ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'",
        rdquo: '"', ldquo: '"', trade: '(TM)', reg: '(R)', copy: '(C)',
      };
      if (code.startsWith('#x') || code.startsWith('#X')) {
        return String.fromCodePoint(parseInt(code.slice(2), 16));
      }
      if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return named[code.toLowerCase()] ?? whole;
    });
}

function extractTitle(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m || m[1] === undefined) return null;
  const t = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** The computed facts. Every one is reproducible from the stored capture. */
type Signals = {
  listedWebsite: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  transportError: string | null;
  byteLength: number;
  visibleChars: number;
  /** Bytes of markup per character a reader can see. High means JS-rendered. */
  scriptCount: number;
  title: string | null;
  parkedMarkers: string[];
  socialHost: string | null;
  redirectHops: number;
  httpsUpgraded: boolean;
};

/** `variant` names the verdict shape so the hook copy can be keyed on it; see FlawFinding.variant. */
type Verdict = { severity: Severity; status: FlawFinding['status']; detail: string; fix?: FlawFix; variant?: string };

/** Best guess at the town from a Places formatted address, for building a real title tag. */
function townFrom(address: string): string | null {
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? `${parts[parts.length - 3]}` : null;
}

/**
 * Collects every applicable verdict, then the caller takes the highest
 * severity. Collecting rather than returning the first match matters: a site
 * can be both JS-only and missing a title, and the prospect should be led with
 * the better hook, not with whichever branch happened to be written first.
 */
function verdicts(s: Signals, candidate: Candidate): Verdict[] {
  const out: Verdict[] = [];

  // If it did not load, nothing about its content is knowable. Ranked low on
  // purpose: a site that is visibly down is something the owner already knows,
  // so it is a weak way to open a conversation.
  if (s.transportError || (s.httpStatus !== null && s.httpStatus >= 400)) {
    out.push({
      severity: 2,
      status: 'flaw',
      variant: 'unreachable',
      detail: s.transportError
        ? `The listed website did not load: ${s.transportError}.`
        : `The listed website returned HTTP ${s.httpStatus}.`,
      fix: {
        summary:
          'Get the site responding again, then re-check that the address listed on Google points at the working version.',
        effort: 'needs a developer',
      },
    });
    return out;
  }

  // THE MONEY HOOK. Lots of markup, plenty of script, almost nothing a reader
  // or a crawler can see. The page looks perfect in the owner's browser and
  // arrives empty to everything that does not run JavaScript, which is most of
  // what decides whether they appear in an AI answer. Invisible to them,
  // provable by them in one keystroke, and directly consequential.
  const jsOnly = s.visibleChars < 200 && s.byteLength > 50_000 && s.scriptCount >= 3;

  if (jsOnly) {
    out.push({
      severity: 4,
      status: 'flaw',
      variant: 'js-only',
      detail:
        `The page is ${(s.byteLength / 1024).toFixed(0)}KB of markup with ${s.scriptCount} scripts but only ` +
        `${s.visibleChars} characters of readable text in the source. Everything else arrives ` +
        `empty to anything that does not run JavaScript.`,
      fix: {
        summary:
          'Serve the main page text in the HTML itself instead of building it with JavaScript.',
        effort: 'needs a developer',
      },
    });
  } else if (s.visibleChars < 200) {
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'thin-content',
      detail: `The page loads but contains only ${s.visibleChars} characters of readable text, so there is effectively nothing on it.`,
      fix: {
        summary:
          'Publish real content on the homepage: what you sell, where you are, and how to get in touch, as text rather than as an image.',
        effort: 'an afternoon',
      },
    });
  }

  if (s.parkedMarkers.length > 0) {
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'parked',
      detail: `The page is a placeholder rather than a business site. Matched: ${s.parkedMarkers.join(', ')}.`,
      fix: {
        summary: 'Point the domain at your real site, or publish one, so the address on your Google listing resolves to actual content.',
        effort: 'an afternoon',
      },
    });
  }

  if (!s.title) {
    const town = townFrom(candidate.address);
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'no-title',
      detail:
        'The page has no <title> element.',
      fix: {
        summary: 'Add a title tag naming the business and what it does, inside the <head> of the page.',
        effort: 'minutes',
        // Built from their own listing, per the schema-starter rule.
        snippet: `<title>${candidate.name}${town ? ` | ${town}` : ''}</title>`,
      },
    });
  }

  if (s.socialHost) {
    out.push({
      severity: 1,
      status: 'flaw',
      variant: 'social-profile',
      detail: `The website on the Google listing redirects to ${s.socialHost} rather than to a domain the business controls.`,
      fix: {
        summary: `Publish a site on your own domain, and point the Google listing's website field at it.`,
        effort: 'an afternoon',
      },
    });
  }

  if (out.length === 0) {
    out.push({
      severity: 0,
      status: 'ok',
      detail: `The site loads (HTTP ${s.httpStatus}) with a title and ${s.visibleChars} characters of readable text.`,
    });
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
  '- Restate ONLY the problem given under "The problem". Do not mention, hint at, or look for any other issue.',
  '- If something in the facts looks wrong to you but is not the stated problem, ignore it. It is not yours to report.',
  '- Output exactly one sentence, under 25 words, and nothing else. No preamble, no quotes, no markdown.',
  '- Address the owner as "your". You may name what the finding mechanically prevents, such as software being unable to read something. Never assert an outcome the scan did not measure: no lost customers, no missed calls, no unanswered numbers, no rankings.',
  '- Use ONLY the facts given. Invent nothing: no traffic numbers, no revenue, no rankings, no reviews.',
  '- No em dashes or en dashes. No emoji. Straight quotes only.',
  '- Do not use: leverage, crucial, pivotal, robust, seamless, unlock, elevate, delve, showcase.',
  '- Do not say "it is not just X, it is Y". Do not open with "Let\'s".',
  '- Plain and specific beats dramatic. Do not exaggerate beyond the facts.',
].join('\n');

async function writeHeadline(
  ctx: CheckContext,
  s: Signals,
  fallback: string,
  detail: string,
  severity: Severity
): Promise<{ headline: string; usedAgent: boolean }> {
  // A clean check has no hook to write, so there is nothing to phrase and no
  // reason to spend a call. This also removes the failure mode that produced
  // it: asked to describe "a problem" on a site with no problem, the model
  // went looking for one and reported a bug the detection layer never found.
  // The model phrases findings. It does not generate them.
  if (severity === 0) return { headline: detail, usedAgent: false };

  const facts = [
    `Business name: ${ctx.candidate.name}`,
    `Website listed on Google: ${s.listedWebsite ?? 'none'}`,
    s.finalUrl && s.finalUrl !== s.listedWebsite ? `Final URL after redirects: ${s.finalUrl}` : null,
    s.httpStatus !== null ? `HTTP status: ${s.httpStatus}` : null,
    s.transportError ? `Load error: ${s.transportError}` : null,
    `Readable text on the page: ${s.visibleChars} characters`,
    `Page title: ${s.title ?? 'none'}`,
    s.parkedMarkers.length ? `Placeholder markers found: ${s.parkedMarkers.join(', ')}` : null,
    s.socialHost ? `Redirects to social platform: ${s.socialHost}` : null,
    `The problem: ${detail}`,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await ctx.agent.run({
    systemPrompt: HEADLINE_SYSTEM_PROMPT,
    prompt: `Facts:\n${facts}\n\nWrite the one sentence now.`,
    model: 'sonnet',
    timeoutMs: 60_000,
  });

  if (!res.ok || res.text.trim() === '') {
    // A dead agent must not stop a check. The deterministic sentence is
    // always correct, just blunter.
    return { headline: fallback, usedAgent: false };
  }

  // Validated, not trusted. The page source that fed this prompt belongs to
  // the business being scanned, and the sentence lands on their document.
  // See checks/headline.ts for what is refused and why.
  return cleanHeadline(res.text, fallback);
}

/** Exported for scripts/test-parsers.js only, same rationale as crawl-index.ts's __test export. */
export const __test = { verdicts };

export const websiteCheck: FlawCheck = {
  id: 'website',
  label: 'Website exists and works',

  async run(ctx: CheckContext): Promise<FlawFinding> {
    const listed = ctx.candidate.website;

    // DISQUALIFIED, not ranked worst.
    //
    // No site means no scan, no PDF and no schema starter, so there is no free
    // tier to hand over and nothing to prove. The only pitch left would be
    // "buy a website from me", which is a different business. It also fails
    // the receipts test outright: there is no source for them to open and
    // check, so the finding is an observation about something they already
    // know rather than something they did not.
    if (!listed) {
      return {
        checkId: 'website',
        status: 'disqualified',
        severity: 0,
        headline: `${ctx.candidate.name} has no website listed on Google, so there is nothing here to scan or fix.`,
        detail:
          'Google Places returned no website for this business. Without a site there is no source to read, no score to compute and no fix to hand over.',
        // The absence is the finding, and its source is the Places response
        // already recorded against this candidate. There is no page to cite,
        // and guessing at a domain would be speculation.
        evidence: [],
        confirmation: 'remote',
        unverifiedNote: 'No website field was returned by the Places API for this place.',
      };
    }

    const capture = await ctx.fetch(listed);

    // The page arrived and we failed to keep it. That is our failure, not
    // theirs, and it used to be reported to the owner as "the listed website
    // did not load" because the store error was written into transportError,
    // which this check reads as a load failure. Same conflation, same false
    // claim, as the truncation bug directly below. Nothing may be said about
    // the page either: a verdict has to be reproducible from a stored capture.
    if (capture.ref.storeError) {
      return {
        checkId: 'website',
        status: 'unverified',
        severity: 0,
        headline: `${ctx.candidate.name}'s homepage could not be saved for evidence, so it was not judged.`,
        detail:
          `The homepage returned HTTP ${capture.ref.httpStatus} and was read in full, but writing the capture to ` +
          `disk failed: ${capture.ref.storeError}. This is a fault on this machine, not on their site, and no ` +
          'verdict is recorded because there would be no file behind it.',
        evidence: [capture.ref],
        confirmation: 'remote',
        unverifiedNote: 'Homepage capture could not be stored; a finding may not outlive its receipt.',
      };
    }

    // A truncated capture is a PREFIX of the page, so every verdict below is
    // unsound: "only N characters of readable text" and "no <title>" are both
    // absence claims, and the bytes we did not read can only add. Say we could
    // not read it rather than characterise a page we only partly have.
    if (capture.ref.truncated) {
      return {
        checkId: 'website',
        status: 'unverified',
        severity: 0,
        headline: `${ctx.candidate.name}'s homepage is larger than this tool reads in one pass, so it was not judged.`,
        detail:
          `The homepage returned HTTP ${capture.ref.httpStatus} but exceeded the ${capture.ref.byteLength} byte capture ` +
          'cap, so only the beginning of it was read. Nothing can be said about what the rest of the page does or does not contain.',
        evidence: [capture.ref],
        confirmation: 'remote',
        unverifiedNote: 'Homepage capture was truncated; no claim about page content can be reproduced from a partial read.',
      };
    }

    const html = capture.body;
    const text = visibleText(html);
    const finalHost = hostOf(capture.ref.url);

    const s: Signals = {
      listedWebsite: listed,
      finalUrl: capture.ref.url,
      httpStatus: capture.ref.httpStatus,
      transportError: capture.ref.transportError ?? null,
      byteLength: capture.ref.byteLength,
      visibleChars: text.length,
      scriptCount: (html.match(/<script\b/gi) ?? []).length,
      title: extractTitle(html),
      parkedMarkers: PARKED_MARKERS.filter((m) => text.toLowerCase().includes(m)),
      socialHost: finalHost && SOCIAL_HOSTS.some((h) => finalHost === h || finalHost.endsWith(`.${h}`)) ? finalHost : null,
      redirectHops: capture.ref.redirectChain?.length ?? 0,
      httpsUpgraded: listed.startsWith('http://') && capture.ref.url.startsWith('https://'),
    };

    const all = verdicts(s, ctx.candidate);
    const verdict = worst(all);
    const fallback = `${ctx.candidate.name}: ${verdict.detail}`;
    const { headline } = await writeHeadline(ctx, s, fallback, verdict.detail, verdict.severity);

    return {
      checkId: 'website',
      status: verdict.status,
      severity: verdict.severity,
      headline,
      detail:
        all.length > 1
          ? `${verdict.detail} Also found: ${all.filter((v) => v !== verdict).map((v) => v.detail).join(' ')}`
          : verdict.detail,
      evidence: [capture.ref],
      confirmation: 'remote',
      fix: verdict.fix,
      variant: verdict.variant,
    };
  },
};

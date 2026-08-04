/**
 * Check 3 of 6, the 105-point AI-readiness instrument.
 *
 * Detection is entirely deterministic. No model is asked what a page says,
 * what it sells, or how well it reads. Every point below is derived from bytes
 * fetch-raw already captured, hashed and wrote to disk, because the client is
 * invited to recompute the number themselves and a figure a model produced is
 * not reproducible.
 *
 * Weights and bands live in scoring/instrument.ts, which is anchored to the
 * published rubrics in two delivered client scans. The sub-band splits below
 * are calibrated so that BOTH worked examples reproduce exactly; the published
 * item values and totals are pinned by scripts/test-instrument.js. Where a
 * split is interpolated rather than observed, it says so.
 */

import { FlawFinding, FlawFix, Severity } from '../../shared/types';
import {
  InsufficientCaptureError,
  ItemResult,
  scoreFrom,
  scoreSentence,
} from '../scoring/instrument';
import { CheckContext, FlawCheck } from './types';
import { DocumentStatus, documentStatus, servedAsRequested } from '../evidence/fetch-raw';

/**
 * Cap on extra pages pulled per candidate for the site-wide items. Small on
 * purpose: this is a stranger's small-business server, and a scan that hammers
 * it is both rude and more likely to trip a bot challenge.
 */
const MAX_EXTRA_PAGES = 6;

/** Child sitemaps to follow when /sitemap.xml is an index. Capped for politeness. */
const MAX_CHILD_SITEMAPS = 4;

// ---------------------------------------------------------------------------
// Crawler taxonomy. The split is the whole point of this item: a site can be
// wide open to retrieval and shut to training, and those are different states
// with different consequences.
// ---------------------------------------------------------------------------

/** Bots that put you in an answer. Blocking these costs you visibility today. */
export const RETRIEVAL_BOTS = [
  'oai-searchbot',
  'chatgpt-user',
  'claude-searchbot',
  'claude-user',
  'perplexitybot',
  'perplexity-user',
  'googlebot',
  'bingbot',
];

/**
 * Bots that take you into a model's memory. Blocking these is a legitimate
 * choice, not automatically a flaw, so the finding says so.
 *
 * Two carry retrieval consequences as well, per Google's and Meta's own docs:
 * Google-Extended takes Gemini grounding with it, and meta-externalagent
 * indexes as well as trains. Noted for the copy, not double counted.
 */
export const TRAINING_BOTS = [
  'gptbot',
  'claudebot',
  'ccbot',
  'google-extended',
  'applebot-extended',
  'bytespider',
  'amazonbot',
  'meta-externalagent',
];

export const RETRIEVAL_ALSO_COST = ['google-extended', 'meta-externalagent'];

/** Parses robots.txt into per-agent disallow state. Lowercased agent names. */
export function parseAgentBlocks(text: string): Map<string, boolean> {
  const disallowRoot = new Set<string>();
  const allowRoot = new Set<string>();
  let group: string[] = [];
  let sawRule = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (sawRule) {
        group = [];
        sawRule = false;
      }
      group.push(value.toLowerCase());
      continue;
    }
    if (field === 'disallow') {
      sawRule = true;
      if (value === '/') for (const a of group) disallowRoot.add(a);
      continue;
    }
    if (field === 'allow') {
      sawRule = true;
      if (value === '/') for (const a of group) allowRoot.add(a);
    }
  }

  // On EQUAL specificity, `Allow: /` beats `Disallow: /`, which is how Google,
  // Bing and the rest break the tie. The old code let a root Disallow win
  // regardless of a matching root Allow, so it reported a bot as blocked on a
  // site whose owner could point at the very Allow line that unblocks it, the
  // reproducibility failure this app exists to avoid. A root Disallow blocks
  // only when there is no root Allow for the same agent.
  const blocked = new Map<string, boolean>();
  for (const a of new Set([...disallowRoot, ...allowRoot])) {
    blocked.set(a, disallowRoot.has(a) && !allowRoot.has(a));
  }
  return blocked;
}

/** A named group wins over the wildcard, which is how every major crawler resolves it. */
function isBlocked(blocks: Map<string, boolean>, agent: string): boolean {
  if (blocks.has(agent)) return blocks.get(agent)!;
  return blocks.get('*') ?? false;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

/**
 * Extracts every JSON-LD node, flattening @graph. Only real script tags count:
 * schema injected by JavaScript is invisible to a raw-HTML crawler, so it
 * scores as absent, which is how a delivered scan graded a site whose schema
 * was injected client-side.
 */
export function extractJsonLd(html: string): Node[] {
  const out: Node[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const body = (m[1] ?? '').trim();
    if (!body) continue;
    try {
      const parsed: unknown = JSON.parse(body);
      const push = (v: unknown) => {
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

const hasType = (nodes: Node[], ...want: string[]) =>
  nodes.some((n) => typesOf(n).some((t) => want.includes(t)));

function attrText(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m?.[1]?.trim() || null;
}

const metaContent = (html: string, name: string): string | null => {
  const re = new RegExp(
    `<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    'i'
  );
  const alt = new RegExp(
    `<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["']`,
    'i'
  );
  return attrText(html, re) ?? attrText(html, alt);
};

/**
 * Places umbrella types, which say nothing a customer would ever type.
 *
 * Places typed a heating and cooling company as `general_contractor`, so this
 * item docked them for not having "general" and "contractor" in their title
 * and the client document advised them to put "general contractor" there.
 * That is wrong advice about their own business, printed with a straight face.
 * These buckets are a taxonomy convenience, not a description of the work, and
 * a recommendation must never be built out of one.
 */
const GENERIC_PLACES_TYPES = new Set([
  'general_contractor',
  'establishment',
  'point_of_interest',
  'store',
  'food',
  'health',
  'finance',
  'local_business',
  'professional_service',
  'business',
  'service',
]);

/**
 * Category stem terms from the Places primaryType, e.g. clothing_store ->
 * clothing, store. Returns [] for an umbrella bucket, which the caller reads
 * as "no category words to check" rather than as a failure.
 */
export function stemTerms(primaryType: string | null, name: string): string[] {
  const type = (primaryType ?? '').toLowerCase().trim();
  if (GENERIC_PLACES_TYPES.has(type)) return [];
  const stems = type
    .split(/[_\s]+/)
    .map((s) => s.toLowerCase().trim())
    .filter((s) => s.length > 2 && s !== 'and' && s !== 'the');
  // The business's own name is not a category word and must not count as one.
  const nameWords = new Set(name.toLowerCase().split(/\W+/));
  return [...new Set(stems)].filter((s) => !nameWords.has(s));
}

// ---------------------------------------------------------------------------
// The six items
// ---------------------------------------------------------------------------

/**
 * 25 points, split 12 retrieval / 13 training.
 *
 * OBSERVED anchors this reproduces exactly:
 *   nothing blocked                        -> 25
 *   retrieval open, training fully blocked -> 12
 */
export function scoreCrawlerAccess(robotsBody: string, robots: DocumentStatus): ItemResult {
  // "We could not read it" is not "it is not there". This used to take a
  // boolean, so a robots.txt that timed out scored a perfect 25 of 25 with
  // "nothing is blocked", which is the exact opposite of the truth on a site
  // whose robots.txt says Disallow: /.
  if (robots === 'unknown') {
    return {
      id: 'crawler-access',
      earned: 0,
      na: false,
      unknown: true,
      note: 'robots.txt could not be read, so crawler access could not be judged.',
    };
  }

  if (robots === 'absent') {
    return {
      id: 'crawler-access',
      earned: 25,
      na: false,
      note: 'No robots.txt was served, so nothing is blocked by robots.txt.',
    };
  }

  const blocks = parseAgentBlocks(robotsBody);
  const retrievalBlocked = RETRIEVAL_BOTS.filter((b) => isBlocked(blocks, b));
  const trainingBlocked = TRAINING_BOTS.filter((b) => isBlocked(blocks, b));

  const retrievalPts = Math.round(12 * (1 - retrievalBlocked.length / RETRIEVAL_BOTS.length));
  const trainingPts = Math.round(13 * (1 - trainingBlocked.length / TRAINING_BOTS.length));

  const parts: string[] = [];
  if (!retrievalBlocked.length && !trainingBlocked.length) parts.push('nothing blocked');
  else {
    if (trainingBlocked.length) parts.push(`${trainingBlocked.length} training crawler(s) blocked: ${trainingBlocked.join(', ')}`);
    if (retrievalBlocked.length) parts.push(`${retrievalBlocked.length} retrieval crawler(s) blocked: ${retrievalBlocked.join(', ')}`);
    else parts.push('retrieval left open');
    const alsoCost = trainingBlocked.filter((b) => RETRIEVAL_ALSO_COST.includes(b));
    if (alsoCost.length) {
      parts.push(`${alsoCost.join(' and ')} are scored here as costing retrieval as well as training`);
    }
  }

  return { id: 'crawler-access', earned: retrievalPts + trainingPts, na: false, note: parts.join('; ') };
}

/**
 * Archive and taxonomy paths a WordPress or Shopify sitemap lists but that do
 * NOT belong in an llms.txt, so they must never count as a "missing" page in
 * the coverage band. Category, tag and author archives, dated post archives
 * (/2024/, /2024/07/), pagination (/page/2/) and feeds are machine index URLs,
 * not the brand pages an llms.txt enumerates. Docking a business for leaving
 * /category/uncategorized/ out of its llms.txt is noise in a client document,
 * not a finding, and it advised at least one real site to list archives no
 * llms.txt should carry.
 */
export function isTaxonomyArchivePath(pathname: string): boolean {
  return (
    /\/(categor(?:y|ies)|tags?|author|topics?)\/[^/]+/i.test(pathname) ||
    /\/\d{4}\/(\d{2}\/?)?$/.test(pathname) ||
    /\/page\/\d+\/?$/i.test(pathname) ||
    /\/feed\/?$/i.test(pathname)
  );
}

/**
 * 15 points. Base 12 for a real file; the last 3 require it to actually cover
 * the pages the sitemap says exist, which is the "money page missing" band
 * observed at 12/15.
 */
export function scoreLlmsTxt(
  llms: { status: DocumentStatus; body: string },
  agents: { status: DocumentStatus },
  sitemapPaths: string[]
): ItemResult {
  // THE BUG THIS SIGNATURE EXISTS TO PREVENT.
  //
  // `exists` was `httpStatus === 200 && body !== ''`. A site with no llms.txt
  // whose CMS answers missing files with the homepage at HTTP 200 passed that
  // test, so 108KB of homepage HTML was parsed as an llms.txt, its hyperlinks
  // were counted as listed URLs, and the scorecard printed "Real file, 240
  // URLs" and awarded 10 of 15 points the site had not earned.
  if (llms.status === 'unknown' && agents.status === 'unknown') {
    return {
      id: 'llms-txt',
      earned: 0,
      na: false,
      unknown: true,
      note: 'Neither llms.txt nor agents.md could be read, so neither could be judged.',
    };
  }

  if (llms.status !== 'present' && agents.status !== 'present') {
    return { id: 'llms-txt', earned: 0, na: false, note: 'No llms.txt and no agents.md.' };
  }

  // agents.md present but llms.txt not: there is a file, but we did not fetch
  // its body, so score the base and say so rather than parse the wrong bytes.
  if (llms.status !== 'present') {
    return { id: 'llms-txt', earned: 8, na: false, note: 'agents.md is present; no llms.txt.' };
  }

  const body = llms.body;
  const urls = [...body.matchAll(/https?:\/\/[^\s)>\]]+/gi)].map((m) => m[0]);
  const hasSections = /^\s*#{1,3}\s+\S/m.test(body);
  const looksTemplated = urls.length <= 2 && body.length < 400;

  if (looksTemplated) {
    return {
      id: 'llms-txt',
      earned: 4,
      na: false,
      note: `File exists but is thin: ${urls.length} URL(s) in ${body.length} bytes, which this rubric scores as a template rather than a hand-written file.`,
    };
  }

  let earned = 8;
  if (urls.length >= 10) earned += 2;
  if (hasSections) earned += 2;

  // Coverage: does it list what the sitemap says exists?
  const listed = new Set(
    urls.map((u) => {
      try {
        return new URL(u).pathname.replace(/\/+$/, '');
      } catch {
        return u;
      }
    })
  );
  const missing = sitemapPaths.filter((p) => !listed.has(p.replace(/\/+$/, '')));
  const coverageOk = sitemapPaths.length > 0 && missing.length === 0;
  if (coverageOk) earned += 3;

  const note =
    `Real file, ${urls.length} URLs${hasSections ? ', sectioned' : ', no sections'}` +
    (sitemapPaths.length === 0
      ? '. Coverage against the sitemap could not be checked because no sitemap was readable.'
      : coverageOk
        ? '. Covers every path in the sitemap.'
        : `. ${missing.length} path(s) in the sitemap are missing from it, including ${missing.slice(0, 2).join(' and ')}.`);

  return { id: 'llms-txt', earned: Math.min(15, earned), na: false, note };
}

/**
 * 20 points. Splits: Organization/LocalBusiness 8, WebSite 3, sameAs 3,
 * founder or a real human Person 4, stable @id 2.
 *
 * OBSERVED anchor: Org + WebSite + SearchAction with sameAs but no founder and
 * no human Person scored 14. 8 + 3 + 3 = 14.
 */
export function scoreEntitySchema(nodes: Node[], businessName: string): ItemResult {
  if (nodes.length === 0) {
    return { id: 'entity-schema', earned: 0, na: false, note: 'No JSON-LD at all in the served HTML.' };
  }

  // schema.org has dozens of LocalBusiness subtypes and a matcher of
  // organization|localbusiness|*business misses nearly all of them. A real
  // shop scored zero on this component while carrying @type "Store". Match the
  // common subtypes by name, then fall back to the heuristic: a node
  // carrying a telephone or a structured address IS the business node.
  const BUSINESS_TYPES = new Set([
    'organization', 'localbusiness', 'store', 'restaurant', 'bakery', 'cafeorcoffeeshop',
    'barorpub', 'clothingstore', 'furniturestore', 'hardwarestore', 'groceryStore'.toLowerCase(),
    'florist', 'hairsalon', 'beautysalon', 'nailsalon', 'dayspa', 'healthclub', 'exercisegym',
    'plumber', 'electrician', 'roofingcontractor', 'generalcontractor', 'hvacbusiness',
    'housepainter', 'locksmith', 'movingcompany', 'autorepair', 'autodealer', 'autowash',
    'dentist', 'physician', 'veterinarycare', 'attorney', 'realestateagent', 'insuranceagency',
    'professionalservice', 'medicalbusiness', 'lodgingbusiness', 'foodestablishment',
    'entertainmentbusiness', 'financialservice', 'childcare', 'shoppingcenter', 'travelagency',
    'drycleaningorlaundry', 'selfstorage', 'emergencyservice', 'sportsactivitylocation',
  ]);
  const org = nodes.find((n) => {
    const ts = typesOf(n);
    if (ts.some((t) => BUSINESS_TYPES.has(t) || t.endsWith('business') || t.endsWith('store'))) return true;
    return typeof n['telephone'] === 'string' || typeof n['address'] === 'object';
  });
  const website = hasType(nodes, 'website');
  const sameAs = org && Array.isArray(org['sameAs']) && (org['sameAs'] as unknown[]).length > 0;
  const hasId = Boolean(org && typeof org['@id'] === 'string');

  // A Person node whose name is the SITE name is not a human. The delivered
  // scan caught exactly this: two Person nodes both named after the site.
  const people = nodes.filter((n) => typesOf(n).includes('person'));
  const realPerson = people.some((p) => {
    const nm = typeof p['name'] === 'string' ? p['name'].trim() : '';
    return nm.length > 0 && nm.toLowerCase() !== businessName.toLowerCase() && /\s/.test(nm);
  });
  const founder = Boolean(org && org['founder']);

  let earned = 0;
  const have: string[] = [];
  const missing: string[] = [];
  if (org) { earned += 8; have.push('Organization'); } else missing.push('no Organization node');
  if (website) { earned += 3; have.push('WebSite'); } else missing.push('no WebSite node');
  if (sameAs) { earned += 3; have.push('sameAs'); } else missing.push('no sameAs');
  if (founder && realPerson) { earned += 4; have.push('founder Person'); }
  else missing.push(realPerson ? 'no founder property' : 'no human Person node');
  if (hasId) { earned += 2; have.push('@id'); } else missing.push('no stable @id');

  return {
    id: 'entity-schema',
    earned,
    na: false,
    note: `${have.length ? have.join(' + ') : 'nothing usable'}${missing.length ? '; ' + missing.join(', ') : ''}.`,
  };
}

/**
 * 15 points. Present anywhere 6, questions also visible as page copy 5,
 * present on the page that matters 4.
 *
 * OBSERVED anchor: marked up on one guide page, absent on the paid page = 6.
 *
 * `faqOnPrimaryPage` is the third band, and it used to be dead weight: the code
 * could only ever award 6 or 11, so the top 4 points sat unreachable in the
 * denominator and every business with a perfect FAQ was docked them by construction.
 * The check now knows which page each FAQPage node sits on, so the band is
 * awarded when the markup is on a primary landing or service page, which is
 * exactly the delivered anchor's distinction: SCAN A's FAQ was on a guide page,
 * absent on the page that mattered, so it does NOT earn this and still scores 6.
 */
export function scoreFaqPage(
  nodes: Node[],
  visibleText: string,
  faqOnPrimaryPage = false
): ItemResult {
  const faq = nodes.filter((n) => typesOf(n).includes('faqpage'));
  if (faq.length === 0) {
    const looksLikeFaq = /\bfrequently asked|\bFAQ\b/i.test(visibleText);
    return {
      id: 'faq-page',
      earned: 0,
      na: false,
      // Both score zero and they are not the same finding. The owner-facing
      // copy reads this: one business needs markup around answers it already
      // published, the other has nothing to mark up yet.
      variant: looksLikeFaq ? 'unmarked' : 'none',
      note: looksLikeFaq
        ? 'No FAQPage markup, and the page text mentions an FAQ that could carry it.'
        : 'No FAQ written and no FAQPage markup.',
    };
  }

  const questions: string[] = [];
  for (const f of faq) {
    const main = f['mainEntity'];
    if (Array.isArray(main)) {
      for (const q of main as Node[]) if (typeof q['name'] === 'string') questions.push(q['name']);
    }
  }

  // Never credit markup for questions that are not on the page. Hidden FAQ
  // schema is a penalty risk, not a shortcut.
  const lower = visibleText.toLowerCase();
  const visibleCount = questions.filter((q) => lower.includes(q.toLowerCase().slice(0, 30))).length;
  const allVisible = questions.length > 0 && visibleCount === questions.length;

  let earned = 6;
  if (allVisible) earned += 5;
  if (faqOnPrimaryPage) earned += 4;

  return {
    id: 'faq-page',
    earned,
    na: false,
    note:
      `FAQPage present with ${questions.length} question(s), ${visibleCount} of them also found in the page text` +
      (allVisible ? '.' : ". Google's structured-data guidelines require marked-up questions to be visible on the page.") +
      (faqOnPrimaryPage
        ? ' It sits on a primary landing or service page, the placement this rubric awards.'
        : ' It was not found on a primary landing or service page, the placement this rubric awards.'),
  };
}

/**
 * 15 points. Product or Service node 7, Offer with a price 8.
 *
 * Review contributes ZERO by design and always will. Self-authored Review or
 * AggregateRating is the schema type most likely to draw a manual action, and
 * the practice actively tells clients to remove it. An instrument that awarded
 * points for it would be recommending the thing the deliverable warns against.
 *
 * N/A only when the business sells nothing at all. A FREE product still takes
 * a price: 0 Offer and therefore still scores.
 */
export function scoreProductReview(nodes: Node[], sellsNothing: boolean): ItemResult {
  if (sellsNothing) {
    return {
      id: 'product-review',
      earned: 0,
      na: true,
      note: 'Marked N/A: this business sells nothing directly.',
    };
  }

  const product = hasType(nodes, 'product', 'service');
  const offerNode = nodes.find((n) => typesOf(n).includes('offer'));
  // A bare `offers` KEY is not an Offer. `{"@type":"Product","offers":null}`
  // and `"offers":[]` used to earn the full 8 points for a priced offer, which
  // inflates the shipped number above what the prospect can reproduce from
  // their own source, the more dangerous direction for this tool. Require an
  // actual object or a non-empty array.
  const isRealOffer = (o: unknown): boolean =>
    Array.isArray(o)
      ? o.some((x) => x !== null && typeof x === 'object')
      : typeof o === 'object' && o !== null && Object.keys(o as object).length > 0;
  const nested = nodes.some((n) => isRealOffer(n['offers']));
  const hasOffer = Boolean(offerNode) || nested;

  const selfReview = nodes.some((n) => typesOf(n).some((t) => t === 'aggregaterating' || t === 'review'));

  let earned = 0;
  if (product) earned += 7;
  if (hasOffer) earned += 8;

  const bits: string[] = [];
  bits.push(product ? 'Product or Service node present' : 'no Product or Service node');
  bits.push(hasOffer ? 'Offer with a price present' : 'no Offer node');
  if (selfReview) {
    bits.push(
      "Review or AggregateRating markup found on the business's own pages. This rubric awards it nothing, and Google's guidelines bar self-serving review markup, so have it checked before relying on it"
    );
  }

  return { id: 'product-review', earned, na: false, note: bits.join('; ') + '.' };
}

/**
 * 15 points. The house weighting is title x3 > description x2 > body x1, and
 * the stem-vocabulary rule: the page must carry the category's classic terms
 * as the discoverability layer.
 *
 * Splits: title 4, meta description 4, og/twitter pair 2, category stem in the
 * title 3, category stem in description or body 2.
 */
export function scorePlainWords(html: string, visible: string, stems: string[]): ItemResult {
  const title = attrText(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const desc = metaContent(html, 'description');
  const ogTitle = metaContent(html, 'og:title');
  const ogDesc = metaContent(html, 'og:description');

  const t = (title ?? '').toLowerCase();
  const d = `${desc ?? ''} ${visible}`.toLowerCase();
  const stemInTitle = stems.some((s) => t.includes(s));
  const stemInBody = stems.some((s) => d.includes(s));

  let earned = 0;
  const notes: string[] = [];
  if (title && title.length >= 10) earned += 4;
  else notes.push(title ? 'title is too short to say anything' : 'no title tag');

  if (desc && desc.length >= 50 && desc.length <= 200) earned += 4;
  else notes.push(desc ? `meta description is ${desc.length} characters` : 'no meta description');

  if (ogTitle && ogDesc) earned += 2;
  else notes.push('og:title and og:description not both present');

  // No category term on the listing means there is nothing to compare the
  // page's vocabulary against. Awarding the 5 points anyway printed a green
  // 15/15 next to the words "vocabulary was not tested" on a client scorecard.
  // Marking them out costs the business nothing and claims nothing.
  let naPoints: number | undefined;
  if (stems.length === 0) {
    naPoints = 5;
    notes.push(
      'no category term available from the listing, so the 5 vocabulary points were marked out rather than scored'
    );
  } else {
    if (stemInTitle) earned += 3;
    else notes.push(`the category words (${stems.join(', ')}) do not appear in the title`);
    if (stemInBody) earned += 2;
    else notes.push('the category words do not appear in the description or body copy');
  }

  return {
    id: 'plain-words',
    earned: Math.min(15 - (naPoints ?? 0), earned),
    na: false,
    naPoints,
    note: notes.length ? notes.join('; ') + '.' : 'Title, description, social tags and category vocabulary all present.',
  };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function visibleTextOf(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function severityFor(rescaled: number): Severity {
  if (rescaled < 25) return 4;
  if (rescaled < 45) return 3;
  if (rescaled < 65) return 2;
  if (rescaled < 85) return 1;
  return 0;
}

export const aiReadinessCheck: FlawCheck = {
  id: 'ai-readiness',
  label: 'AI readiness (105-point instrument)',

  async run(ctx: CheckContext): Promise<FlawFinding> {
    const listed = ctx.candidate.website;
    if (!listed) {
      return {
        checkId: 'ai-readiness',
        status: 'disqualified',
        severity: 0,
        headline: `${ctx.candidate.name} has no website listed, so there is nothing to score.`,
        detail: 'Google Places returned no website for this business.',
        evidence: [],
        confirmation: 'remote',
        unverifiedNote: 'No website field was returned by the Places API for this place.',
      };
    }

    let origin: string;
    try {
      origin = new URL(listed).origin;
    } catch {
      return {
        checkId: 'ai-readiness',
        status: 'error',
        severity: 0,
        headline: `Could not parse the website address for ${ctx.candidate.name}.`,
        detail: `Places returned "${listed}", which is not a usable URL.`,
        evidence: [],
        confirmation: 'remote',
      };
    }

    const [home, robots, llms, agents] = await Promise.all([
      ctx.fetch(listed),
      ctx.fetch(`${origin}/robots.txt`),
      ctx.fetch(`${origin}/llms.txt`),
      ctx.fetch(`${origin}/agents.md`),
    ]);

    /**
     * ASK ROBOTS.TXT WHERE THE SITEMAP IS, instead of assuming /sitemap.xml.
     *
     * Found in a real scan: robots.txt said
     * `Sitemap: https://<host>/sitemap_index.xml`, which is the WordPress and
     * Yoast default, so it is most of the small-business web. The check
     * fetched /sitemap.xml regardless, got a soft 404, discovered no pages at
     * all, and then scored site-wide items from the homepage alone while
     * telling the operator "a sitemap lists 0 URLs".
     *
     * robots.txt has to be in hand before the sitemap can be requested, so
     * this is deliberately a second round trip rather than one Promise.all.
     */
    const declaredSitemaps = documentStatus(robots.ref) === 'present'
      ? [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => (m[1] ?? '').trim()).filter(Boolean)
      : [];

    let sitemap = await ctx.fetch(declaredSitemaps[0] ?? `${origin}/sitemap.xml`);
    // A declared sitemap that does not resolve still leaves the conventional
    // location worth one try, and vice versa.
    if (documentStatus(sitemap.ref) !== 'present' && declaredSitemaps[0]) {
      sitemap = await ctx.fetch(`${origin}/sitemap.xml`);
    }
    const sitemapUsable =
      documentStatus(sitemap.ref) === 'present' && /<(urlset|sitemapindex)\b/i.test(sitemap.body);

    /**
     * SITE-WIDE ITEMS NEED MORE THAN THE HOMEPAGE.
     *
     * Shipped bug, found 2026-07-29 by the operator: the FAQPage item was
     * scored 0/15 with the claim "no FAQPage markup" for a site whose
     * /pages/faq carries a full FAQPage node with 34 acceptedAnswer entries.
     * The markup was never absent; the capture was. That is a false claim in a
     * client deliverable, which is the worst failure this codebase has.
     *
     * Entity schema and FAQ read across a site, so the capture has to. Pull a
     * small, capped set of the pages most likely to carry them, chosen from
     * the site's own sitemap so we are not guessing at URLs.
     */
    const locsIn = (xml: string): string[] =>
      [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
        .map((m) => (m[1] ?? '').trim())
        .filter((u) => u.startsWith(origin));

    /**
     * Follow ONE level of sitemap index.
     *
     * Shopify, WordPress and most platforms serve /sitemap.xml as a
     * <sitemapindex> whose <loc> entries are child sitemap FILES, not pages.
     * Reading them as pages is how the first version of this fix still found
     * only the homepage: it was pattern-matching "/faq" against
     * "sitemap_products_1.xml".
     */
    let sitemapUrls = sitemapUsable ? locsIn(sitemap.body) : [];
    if (sitemapUsable && /<sitemapindex\b/i.test(sitemap.body)) {
      const children = sitemapUrls.filter((u) => /\.xml(\?|$)/i.test(u)).slice(0, MAX_CHILD_SITEMAPS);
      const childBodies = await Promise.all(children.map((u) => ctx.fetch(u)));
      sitemapUrls = childBodies.flatMap((c) => locsIn(c.body));
    }

    /**
     * What the sitemap says EXISTS, as page paths, for the llms.txt coverage
     * item. Taken from the EXPANDED list, and never from the index itself.
     *
     * This used to read the top-level document's <loc> entries directly. On
     * any WordPress or Shopify site that document is a <sitemapindex> whose
     * entries are child sitemap FILES, so a real business was docked coverage
     * points and its scorecard advised it to add /post-sitemap.xml and
     * /page-sitemap.xml to its llms.txt. No llms.txt should ever list a
     * sitemap file. The .xml guard below is belt and braces for a site that
     * mixes pages and child sitemaps in one document.
     *
     * Computed here rather than beside `sitemapUsable` because this is the
     * first point at which the index has been resolved into actual pages, and
     * before the homepage-link fallback below, which finds pages the sitemap
     * never claimed and so cannot be held against the llms.txt.
     */
    const sitemapPaths = [
      ...new Set(
        sitemapUrls
          .map((u) => {
            try {
              return new URL(u).pathname;
            } catch {
              return '';
            }
          })
          .filter((p) => p !== '' && !/\.xml(\.gz)?$/i.test(p) && !isTaxonomyArchivePath(p))
      ),
    ];

    /**
     * THE SITEMAP WAS THE ONLY WAY THIS CHECK EVER FOUND A PAGE.
     *
     * When it is missing or soft-404s, sitemapUrls is empty, no extra page is
     * fetched, and the site-wide items get scored off the homepage alone while
     * reading as verdicts about the whole site. Observed on a real scan: the
     * FAQPage markup was on a page linked directly from the homepage, and the
     * check reported "No FAQPage markup" having never looked at it.
     *
     * So fall back to the site's own homepage links. Same origin only, no
     * assets, and it feeds the same capped priority picker below, so this
     * widens discovery without widening the request budget.
     */
    let discoveredBy: 'sitemap' | 'homepage links' | 'nothing' = sitemapUrls.length
      ? 'sitemap'
      : 'nothing';
    if (!sitemapUrls.length) {
      const hrefs = [...home.body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)]
        .map((m) => {
          try {
            const u = new URL((m[1] ?? '').trim(), origin);
            /**
             * Drop the fragment and the query.
             *
             * `href="#faq"` resolves to `origin + "/#faq"`, which is the
             * homepage. Four anchor links on a single-page site filled every
             * discovery slot with the same page, each one a separate GET, and
             * the fragment survived the dedupe key, so the note read
             * "Scored from 6 page(s): /, /, /, /, /, ...". That is the exact
             * bug this session already fixed once, reintroduced by the link
             * fallback that was meant to help.
             */
            u.hash = '';
            u.search = '';
            // Exact origin, not a string prefix. `startsWith(origin)` is true
            // for `https://example.com.attacker.test/`, so a lookalike domain
            // linked from the page was fetched and its markup folded into the
            // score as the business's own evidence.
            return u.origin === origin ? u.toString() : '';
          } catch {
            return '';
          }
        })
        .filter(
          (u) =>
            u !== '' &&
            !/\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|pdf|zip|mp4)(\?|$)/i.test(u) &&
            !/\/wp-(content|includes|json|admin)\//i.test(u) &&
            !/\/(feed|comments)\/?$/i.test(u)
        );
      sitemapUrls = [...new Set(hrefs)];
      if (sitemapUrls.length) discoveredBy = 'homepage links';
    }

    /**
     * Pick pages by PRIORITY, not by sitemap order.
     *
     * Second bug in the same fix: a store's sitemap listed 1,148 product URLs,
     * all of which matched an "interesting" pattern, so they filled every slot
     * and /pages/faq was never fetched. FAQPage stayed at 0/15 with the same
     * false claim. A commerce sitemap is almost entirely products, so products
     * have to be capped hard or they crowd out the pages that carry the
     * markup this instrument is actually looking for.
     */
    const PRIORITY: { re: RegExp; rank: number; cap: number }[] = [
      { re: /\/(faqs?|frequently-asked|help|support)\b/i, rank: 0, cap: 2 },
      { re: /\/(about|our-story|team)\b/i, rank: 1, cap: 1 },
      { re: /\/(contact|locations?|hours)\b/i, rank: 2, cap: 1 },
      { re: /\/(services?|pricing|plans)\b/i, rank: 3, cap: 1 },
      // Review and testimonial pages routinely carry FAQPage and Review nodes.
      // Found the hard way: a scan reported "No FAQPage markup" on a site whose
      // FAQPage node was on its reviews page, which matched nothing here.
      { re: /\/(reviews?|testimonials?)\b/i, rank: 4, cap: 1 },
      // Products last, and at most one: enough to see an Offer node, not
      // enough to bury everything else.
      { re: /\/(products?|shop|collections?|item)\b/i, rank: 4, cap: 1 },
    ];

    const taken = new Map<number, number>();
    const extraUrls: string[] = [];
    for (const { re, rank, cap } of PRIORITY) {
      for (const u of sitemapUrls) {
        if (extraUrls.length >= MAX_EXTRA_PAGES) break;
        if (!re.test(u) || extraUrls.includes(u)) continue;
        const used = taken.get(rank) ?? 0;
        if (used >= cap) break;
        taken.set(rank, used + 1);
        extraUrls.push(u);
      }
    }

    /**
     * Spend any leftover budget on pages that matched no pattern.
     *
     * The picker only ever took URLs matching the vocabulary above, so a site
     * whose schema lives at a slug nobody predicted was invisible no matter how
     * many pages it had. A keyword list cannot be the only way in: it encodes a
     * guess about someone else's URL scheme, and the item being scored is
     * "does this markup exist on the site", not "does it exist where I expect".
     */
    for (const u of sitemapUrls) {
      if (extraUrls.length >= MAX_EXTRA_PAGES) break;
      if (extraUrls.includes(u) || u.replace(/\/+$/, '') === origin) continue;
      extraUrls.push(u);
    }

    const extras = await Promise.all(extraUrls.map((u) => ctx.fetch(u)));

    /**
     * Count PAGES, not responses.
     *
     * On a site that soft-404s, most of those extra requests come back as the
     * homepage again. Without the dedupe below, a scan of one such site
     * reported "Read across 7 page(s): /, /, /, /, /, /reviews/, /", which is
     * one page counted six times, and the same markup counted six times toward
     * every site-wide item. A capture-coverage claim that inflates itself is
     * the same class of error as everything else this check has shipped.
     *
     * servedAsRequested drops the soft 404s; the Map keys on the final URL so
     * two different requests that landed on one page collapse to one page.
     */
    // The key ignores fragment and query, or two links to the same page count
    // as two pages. Falls back to the raw URL only if it will not parse.
    const pageKey = (u: string): string => {
      try {
        const p = new URL(u);
        p.hash = '';
        p.search = '';
        return p.toString().replace(/\/+$/, '') || p.origin;
      } catch {
        return u.replace(/\/+$/, '') || u;
      }
    };

    const byFinalUrl = new Map<string, (typeof home)>();
    byFinalUrl.set(pageKey(home.ref.url), home);
    for (const c of extras) {
      if (!servedAsRequested(c.ref) || c.body.trim() === '') continue;
      const key = pageKey(c.ref.url);
      if (!byFinalUrl.has(key)) byFinalUrl.set(key, c);
    }
    const readable = [...byFinalUrl.values()].filter((c) => c.ref.httpStatus === 200 && c.body.trim() !== '');

    // Every captured page contributes to the site-wide items.
    const nodes = readable.flatMap((c) => extractJsonLd(c.body));
    const visible = readable.map((c) => visibleTextOf(c.body)).join(' ');
    const pagesRead = readable.map((c) => {
      try {
        return new URL(c.ref.url).pathname || '/';
      } catch {
        return c.ref.url;
      }
    });

    // Presence, not "we got 200 back". See documentStatus. A 200 carrying an
    // empty body is not a document either: parsing it as an llms.txt scored it
    // 4 points as "an auto-generated platform template".
    const statusOf = (c: { ref: typeof home.ref; body: string }): DocumentStatus => {
      const s = documentStatus(c.ref);
      return s === 'present' && c.body.trim() === '' ? 'absent' : s;
    };
    const robotsStatus = statusOf(robots);
    const llmsStatus = statusOf(llms);
    const agentsStatus = statusOf(agents);

    /**
     * SITE-WIDE ITEMS CANNOT BE SCORED FROM ONE PAGE OF A MULTI-PAGE SITE.
     *
     * Entity schema and FAQPage are verdicts about a whole site. If the only
     * page we read is the homepage AND we could not enumerate the site, then
     * "no FAQPage markup" means "not on the one page I looked at", which is a
     * different sentence and a much smaller claim. Rule 3 says print cells and
     * no number rather than a number the capture did not earn.
     */
    /**
     * "We enumerated the site" has to mean we got pages, not that a sitemap
     * parsed. `sitemapUsable` is decided from the TOP-LEVEL sitemap before its
     * child sitemaps are fetched, and fetchRaw never throws, so if every child
     * request fails `sitemapUrls` collapses to empty while `sitemapUsable`
     * stays true. That combination then satisfied `sitemapUrls.length <= 1`
     * and manufactured a confirmed-small-site signal out of total enumeration
     * failure, which is how a one-page capture earns a site-wide score.
     */
    const siteEnumerated = discoveredBy !== 'nothing';
    const siteWideEarned = readable.length > 1 || (siteEnumerated && sitemapUrls.length <= 1);

    // No reliable signal that a local business sells nothing at all, and the
    // rule is narrow, so never auto-mark N/A. There is deliberately no operator
    // input wired to set it either, so `sellsNothing` is always false today and
    // the whole-item N/A path (base 90) is not currently reachable in the app;
    // wiring that input is the only way to reach it. Free is scored, not excused.
    const siteWideNote = ` Read across ${pagesRead.length} page(s): ${pagesRead.join(', ')}.`;
    const scopeSiteWide = (r: ItemResult): ItemResult => ({
      ...r,
      note: r.note + siteWideNote,
      ...(siteWideEarned ? {} : { unknown: true }),
    });

    // The FAQPage top band: is the markup on a page that MATTERS, meaning the
    // homepage or a primary service/booking/contact page, rather than only a
    // guide or blog post? This is the distinction the delivered anchor drew and
    // the third band was never able to award. Computed from the same per-page
    // captures the site-wide items already read.
    const isPrimaryFaqPath = (p: string): boolean =>
      p === '' || p === '/' || /\/(services?|pricing|plans|book|booking|contact|locations?)(\/|$)/i.test(p);
    const faqOnPrimaryPage = readable.some((c) => {
      let pathname = '/';
      try {
        pathname = new URL(c.ref.url).pathname;
      } catch {
        /* unparseable URL falls back to the homepage default */
      }
      const primary = c.ref.url === home.ref.url || isPrimaryFaqPath(pathname);
      return primary && extractJsonLd(c.body).some((n) => typesOf(n).includes('faqpage'));
    });

    const results: ItemResult[] = [
      scoreCrawlerAccess(robots.body, robotsStatus),
      scoreLlmsTxt({ status: llmsStatus, body: llms.body }, { status: agentsStatus }, sitemapPaths),
      scopeSiteWide(scoreEntitySchema(nodes, ctx.candidate.name)),
      scopeSiteWide(scoreFaqPage(nodes, visible, faqOnPrimaryPage)),
      scopeSiteWide(scoreProductReview(nodes, false)),
      // Homepage only, deliberately: this item is about the front door.
      scorePlainWords(home.body, visibleTextOf(home.body), stemTerms(ctx.candidate.primaryType, ctx.candidate.name)),
    ].map((r) =>
      /**
       * The confirmation pass never refuses the number.
       *
       * It sees only what the operator pasted, and only four documents can be
       * pasted, so agents.md is unreadable there by construction and a
       * multi-page site always looks like a one-page capture. Refusing there
       * would make the finding permanently unconfirmable and the packet
       * permanently unreleasable, for a reason the operator cannot act on.
       * Rule 3 governs the number this app SHIPS, which comes from the crawler
       * pass; this pass only has to compare signals against it.
       */
      ctx.reconciling && r.unknown ? { ...r, unknown: false } : r
    );

    // One page is thin for a site-wide instrument. Say so rather than pretend.
    const evidence = [...readable.map((c) => c.ref), robots.ref, llms.ref, agents.ref, sitemap.ref]
      .filter((r) => r.httpStatus !== null);

    // A truncated capture is a prefix; absence of markup in it proves nothing.
    if (
      home.ref.httpStatus !== 200 ||
      home.ref.storeError ||
      home.body.trim() === '' ||
      home.ref.truncated
    ) {
      return {
        checkId: 'ai-readiness',
        status: 'unverified',
        severity: 0,
        headline: `Could not read ${ctx.candidate.name}'s homepage, so no score was computed.`,
        detail: `The homepage returned ${home.ref.httpStatus ?? 'no response'}${home.ref.storeError ? `, and the capture could not be saved (${home.ref.storeError}), so there is no file to cite` : ''}. A number this capture did not earn is not printed.`,
        evidence,
        confirmation: 'remote',
        unverifiedNote: 'Homepage capture failed; the instrument needs it.',
      };
    }

    let score;
    try {
      score = scoreFrom(results);
    } catch (e) {
      if (e instanceof InsufficientCaptureError) {
        return {
          checkId: 'ai-readiness',
          status: 'unverified',
          severity: 0,
          headline: `${ctx.candidate.name}: per-check cells only, no score.`,
          detail: 'The capture does not cover enough of the site to earn a number.',
          evidence,
          confirmation: 'remote',
          unverifiedNote: 'Insufficient capture for a site-wide instrument.',
        };
      }
      throw e;
    }

    const severity = severityFor(score.rescaled);
    const worstItem = [...score.items]
      .filter((i) => !i.na)
      .sort((a, b) => b.possible - b.earned - (a.possible - a.earned))[0];

    const fix: FlawFix | undefined = worstItem
      ? {
          summary: `Biggest single gain is ${worstItem.label}: ${worstItem.possible - worstItem.earned} of ${worstItem.possible} points are unclaimed. ${worstItem.note}`,
          effort: worstItem.id === 'crawler-access' ? 'minutes' : 'an afternoon',
        }
      : undefined;

    // Same-origin pages beyond the homepage that were read and scored. The
    // confirmation UI offers a paste slot for each, so a multi-page site's
    // site-wide score can be reproduced from the operator's own source.
    // Requested URL, not the post-redirect one, because that is the address the
    // operator opens and the reconciling pass re-requests.
    const extraPages = [
      ...new Set(
        readable
          .filter((c) => c.ref.url !== home.ref.url)
          .map((c) => c.ref.requestedUrl || c.ref.url)
      ),
    ];

    return {
      checkId: 'ai-readiness',
      status: severity === 0 ? 'ok' : 'flaw',
      severity,
      headline: `${ctx.candidate.name} scores ${scoreSentence(score)}`,
      detail: score.items
        .map((i) => `${i.label} ${i.na ? 'N/A' : `${i.earned}/${i.possible}`}: ${i.note}`)
        .join(' '),
      evidence,
      confirmation: 'remote',
      score,
      fix,
      extraPages,
      // Say where the page list came from. Calling homepage links "the
      // sitemap" produced a note claiming a sitemap listed 15 URLs on a site
      // whose sitemap the crawl-index check had just reported unreadable, in
      // the same scan.
      unverifiedNote:
        `Scored from ${pagesRead.length} page(s) (${pagesRead.join(', ')}), found via ${discoveredBy}, ` +
        'plus robots.txt, llms.txt, agents.md and the sitemap.' +
        (sitemapUrls.length > pagesRead.length
          ? ` ${sitemapUrls.length} page(s) were discovered in total; those beyond the ${pagesRead.length} read were not checked.`
          : ''),
    };
  },
};

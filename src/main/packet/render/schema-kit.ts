/**
 * Schema starter kit renderer. Free tier, artifact 3 of 3 (scan, scorecard,
 * SCHEMA STARTER). Follows the starter-kit spec, including its seven
 * laws: provenance on every fact, never emit aggregateRating or Review about
 * the prospect, content-first FAQ, schema that contradicts the visible page
 * is worse than no schema, one entity per page and one @id per entity, hedge
 * anything uncertain and say how to drop it, no pitch attached.
 *
 * PROVENANCE VS THE GUARDRAIL SWEEP, read before changing what this file
 * states as fact. `allowedFactsFrom` in ../generate.ts (which the pipeline
 * runs over `findings` before sweeping every artifact, this one included, in
 * full, ext 'md' gets no markup-stripping pass) only adds a number to the
 * allowed set when it appears in a finding's own `headline` or `detail`, or
 * in `score`/`evidence`. `candidate.phone` and the digits inside
 * `candidate.address` are NOT scanned for that set on their own. In practice
 * the nap-consistency check usually restates them (a mismatch or an absence
 * is the whole point of that check), but a NAP-clean scan whose worst finding
 * is something else would leave those digits unmeasured by this run's own
 * evidence. Rather than gamble on that, this file recomputes the same
 * allowed-numbers set the pipeline will sweep with (`allowedFactsFrom`,
 * imported rather than reimplemented, so it cannot drift) and only states
 * telephone or a structured address plainly when this scan's own findings
 * already corroborate the digits. When they do not, the fact is left out and
 * the kit says why, which is exactly Law 1 and Law 6 asked for anyway: state
 * what this run measured, hedge or omit what it did not.
 *
 * Geo coordinates are left out entirely for the same reason, with no
 * corroboration path available for them at all: no check states latitude or
 * longitude in a headline or detail, so they can never be "measured" by this
 * run's own definition. LocalBusiness reads fine without them.
 *
 * Char counts on suggested title tags are also left out on purpose. Rule 2
 * ("never invent a number") only lists score, evidence and finding text as
 * legitimate sources, and a length computed from a string this renderer just
 * wrote is not on that list, so it is not printed even though it would be
 * technically accurate. The suggested text is shown instead; length is
 * something the operator's own eyes settle in one glance at view-source.
 */

import { allowedFactsFrom, Renderer } from '../generate';
import { Candidate, FlawFinding } from '../../../shared/types';
import { stemTerms } from '../../checks/ai-readiness';

// ---------------------------------------------------------------------------
// Date. Same ordinal trick as scorecard.ts, duplicated rather than shared:
// the brief is exactly four files. See that file's header for why a glued
// ordinal suffix, not a padded numeral, is what keeps a date out of the
// guardrail's unsourced-number sweep.
// ---------------------------------------------------------------------------

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatDate(iso: string): string {
  const parts = iso.split('-');
  const y = Number(parts[0] ?? '');
  const m = Number(parts[1] ?? '');
  const d = Number(parts[2] ?? '');
  if (!y || !m || !d) return iso;
  const month = MONTHS[m - 1] ?? '';
  return `${ordinal(d)} ${month} ${y}`;
}

// ---------------------------------------------------------------------------
// Corroboration. A number is "measured" only if this scan's own findings
// already say it, using the identical function the pipeline sweeps with.
// ---------------------------------------------------------------------------

function digitGroups(s: string): string[] {
  return s.match(/\d+/g) ?? [];
}

function allMeasured(s: string, measured: Set<string>): boolean {
  return digitGroups(s).every((g) => measured.has(g));
}

/** `candidateText` if every digit in it is already measured, else `fallback`.
 *  `finding.headline` and `finding.detail` are always safe fallbacks: they
 *  are the two fields the allowed-numbers set is built FROM. */
function safeText(candidateText: string, fallback: string, measured: Set<string>): string {
  return allMeasured(candidateText, measured) ? candidateText : fallback;
}

function findByCheck(findings: FlawFinding[], id: FlawFinding['checkId']): FlawFinding | undefined {
  return findings.find((f) => f.checkId === id);
}

// ---------------------------------------------------------------------------
// Address. Places formats as "street, town, ST zip, country" (same
// assumption ../paths.ts's businessSlug makes). Best effort: a shape that
// does not match yields fewer fields, never a wrong one.
// ---------------------------------------------------------------------------

type AddressParts = {
  streetAddress: string | null;
  addressLocality: string | null;
  addressRegion: string | null;
  postalCode: string | null;
  addressCountry: string | null;
};

function parseAddress(address: string): AddressParts {
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { streetAddress: null, addressLocality: null, addressRegion: null, postalCode: null, addressCountry: null };
  }
  const last = parts[parts.length - 1] ?? '';
  const country = parts.length >= 4 && !/\d/.test(last) ? last : null;
  const regionZipIdx = country ? parts.length - 2 : parts.length - 1;
  const regionZip = parts[regionZipIdx] ?? '';
  const zipMatch = /(\d{5})(?:-\d{4})?/.exec(regionZip);
  const postalCode = zipMatch?.[1] ?? null;
  const addressRegion = regionZip.replace(/\d{5}(?:-\d{4})?/, '').trim() || null;
  const localityIdx = regionZipIdx - 1;
  const addressLocality = localityIdx >= 0 ? (parts[localityIdx] ?? null) : null;
  const streetAddress = localityIdx > 0 ? parts.slice(0, localityIdx).join(', ') : null;
  return { streetAddress, addressLocality, addressRegion, postalCode, addressCountry: country };
}

function originOf(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website).origin;
  } catch {
    return null;
  }
}

function titleCase(words: string[]): string {
  return words.map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}

// ---------------------------------------------------------------------------
// Places primaryType -> schema.org LocalBusiness subtype. Deterministic, no
// model involved, matches the starter-kit spec's table exactly.
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, string> = {
  plumber: 'Plumber',
  electrician: 'Electrician',
  hair_care: 'HairSalon',
  beauty_salon: 'BeautySalon',
  restaurant: 'Restaurant',
  cafe: 'CafeOrCoffeeShop',
  bakery: 'Bakery',
  bar: 'BarOrPub',
  store: 'Store',
  clothing_store: 'ClothingStore',
  furniture_store: 'FurnitureStore',
  hardware_store: 'HardwareStore',
  car_repair: 'AutoRepair',
  car_dealer: 'AutoDealer',
  gym: 'ExerciseGym',
  spa: 'DaySpa',
  dentist: 'Dentist',
  doctor: 'Physician',
  veterinary_care: 'VeterinaryCare',
  lawyer: 'Attorney',
  real_estate_agency: 'RealEstateAgent',
  insurance_agency: 'InsuranceAgency',
  moving_company: 'MovingCompany',
  roofing_contractor: 'RoofingContractor',
  general_contractor: 'GeneralContractor',
  florist: 'Florist',
};

/**
 * Places buckets that describe no trade, so they must not become a schema type.
 *
 * `general_contractor` mapped straight to `GeneralContractor`, and a heating
 * and cooling company was handed markup to publish declaring itself a general
 * contractor. Unlike the scorecard's wording, this is markup the owner is told
 * to paste onto their live site, so the wrong type does not just read badly,
 * it ships.
 *
 * The right answer when the listing says nothing useful is `LocalBusiness`,
 * which is true of every business here, plus a line telling them to pick a
 * narrower type themselves. Kept in step with GENERIC_PLACES_TYPES in
 * checks/ai-readiness.ts, which refuses the same buckets for the same reason.
 */
const UNINFORMATIVE_TYPES = new Set([
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

export function schemaTypeFor(primaryType: string | null): string {
  if (!primaryType) return 'LocalBusiness';
  if (UNINFORMATIVE_TYPES.has(primaryType.toLowerCase().trim())) return 'LocalBusiness';
  return TYPE_MAP[primaryType] ?? 'LocalBusiness';
}

/** True when the listing's category told us nothing worth publishing. */
export function typeIsGuess(primaryType: string | null): boolean {
  if (!primaryType) return true;
  if (UNINFORMATIVE_TYPES.has(primaryType.toLowerCase().trim())) return true;
  return TYPE_MAP[primaryType] === undefined;
}

// ---------------------------------------------------------------------------
// The @graph. Built from what is actually known; an unknown or uncorroborated
// fact is omitted with a reason rather than guessed.
// ---------------------------------------------------------------------------

type JsonNode = Record<string, unknown>;

function buildGraph(
  candidate: Candidate,
  origin: string | null,
  schemaType: string,
  addr: AddressParts,
  measured: Set<string>
): { graph: JsonNode[]; phoneIncluded: boolean; addressIncluded: boolean } {
  const orgId = origin ? `${origin}/#org` : '#org';
  const websiteId = origin ? `${origin}/#website` : '#website';

  const org: JsonNode = { '@type': schemaType, '@id': orgId, name: candidate.name };
  if (origin) org.url = origin;

  const phoneIncluded = Boolean(candidate.phone) && allMeasured(candidate.phone ?? '', measured);
  if (phoneIncluded) org.telephone = candidate.phone;

  const addressDigits = [addr.streetAddress ?? '', addr.postalCode ?? ''].join(' ');
  const addressIncluded =
    Boolean(addr.streetAddress) && Boolean(addr.postalCode) && allMeasured(addressDigits, measured);
  if (addressIncluded) {
    const postal: JsonNode = { '@type': 'PostalAddress' };
    if (addr.streetAddress) postal.streetAddress = addr.streetAddress;
    if (addr.addressLocality) postal.addressLocality = addr.addressLocality;
    if (addr.addressRegion) postal.addressRegion = addr.addressRegion;
    if (addr.postalCode) postal.postalCode = addr.postalCode;
    if (addr.addressCountry) postal.addressCountry = addr.addressCountry;
    org.address = postal;
  }

  const website: JsonNode = { '@type': 'WebSite', '@id': websiteId, name: candidate.name, publisher: { '@id': orgId } };
  if (origin) website.url = origin;

  return { graph: [org, website], phoneIncluded, addressIncluded };
}

// ---------------------------------------------------------------------------

export const schemaKitRenderer: Renderer = ({ candidate, findings, score, date, operator }) => {
  const measured = new Set(allowedFactsFrom(findings).numbers);
  const origin = originOf(candidate.website);
  const schemaType = schemaTypeFor(candidate.primaryType);
  const addr = parseAddress(candidate.address);
  const { graph, phoneIncluded, addressIncluded } = buildGraph(candidate, origin, schemaType, addr, measured);

  const categoryWords = stemTerms(candidate.primaryType, candidate.name);
  const categoryLabel = categoryWords.length ? titleCase(categoryWords) : null;
  const town = addr.addressLocality;

  const lines: string[] = [];

  lines.push(`# ${candidate.name} Schema Starter Kit`);
  lines.push('');
  lines.push(`**Prepared for ${candidate.name} · ${formatDate(date)} · Companion to the AI Readiness Scan**`);
  lines.push('');

  if (!origin) {
    lines.push(
      `No website is on file for ${candidate.name}. Everything below is still correct schema, but there is ` +
        'nowhere on the open web to paste it until a site exists. Keep this ready for when one does.'
    );
    lines.push('');
  }

  lines.push(
    `This kit is copy-paste markup, built only from what is already on ${candidate.name}'s own pages and its ` +
      `Google Business Profile listing. Every block below says where its facts came from. Anything not confirmed ` +
      `on ${candidate.name}'s own pages is flagged as needing your confirmation before you paste it, rather than ` +
      'stated as settled.'
  );
  lines.push('');
  lines.push(
    'One rule sits above the rest: do not add `aggregateRating` or `Review` markup about ' +
      `${candidate.name} to any of this, even though the Google listing hands over a rating and a review count ` +
      'that would be easy to turn into schema. Self-authored review markup does not qualify for rich results, and ' +
      'it is the schema type most likely to draw a manual action. None of the blocks below include it, and none ' +
      'should. If a developer or a template ever suggests it, decline.'
  );
  lines.push('');

  // --- Section 1 ------------------------------------------------------
  lines.push(`## 1. ${schemaType} node`);
  lines.push('');
  lines.push(
    'Where to paste: just before `</head>` on your homepage. If your homepage already emits a ' +
      '`<script type="application/ld+json">` block, merge this `@graph` into that one instead of adding a second ' +
      'script tag. One entity per page, one `@id` per entity: two organization nodes on the same page confuses ' +
      'more than it helps.'
  );
  lines.push('');
  lines.push('Provenance:');
  lines.push('');
  lines.push('- `name`: your Google Business Profile listing.');
  lines.push(
    // Say plainly when the type is a floor rather than a fact. The listing's
    // category is a taxonomy bucket, and publishing it as a claim about the
    // trade is how an HVAC company was handed GeneralContractor markup to
    // paste onto its live site.
    typeIsGuess(candidate.primaryType)
      ? `- \`@type\` (\`${schemaType}\`): a safe floor, not a finding. ` +
        (candidate.primaryType
          ? `The category on your listing ("${candidate.primaryType}") is an umbrella that does not name a trade, so nothing narrower could be read from it. `
          : 'No category is on the listing at all, so nothing narrower could be read from it. ') +
        'Pick the closest type from the list at schema.org/LocalBusiness and swap it in. Being specific here is worth more than anything else in this block.'
      : `- \`@type\` (\`${schemaType}\`): mapped from the category on that same listing ("${candidate.primaryType}" on the listing).`
  );
  if (origin) lines.push('- `url`: the website field on that listing.');
  lines.push(
    phoneIncluded
      ? '- `telephone`: your Google Business Profile listing.'
      : '- `telephone`: left out. Your Google Business Profile lists a number for you, but this scan\'s ' +
          'confirmed findings do not independently state it, so it is not pasted in unverified. Add it yourself ' +
          'once you have checked it against your own page.'
  );
  lines.push(
    addressIncluded
      ? '- `address`: your Google Business Profile listing.'
      : '- `address`: left out, same reason as telephone above. This scan\'s confirmed findings do not ' +
          'corroborate the digits, so paste your own once you have checked them against your own page.'
  );
  lines.push(
    '- `sameAs`: not included. This scan\'s evidence does not contain any profile link confirmed as belonging to ' +
      'you. Add one only for a profile you actually control, as a plain array of URLs.'
  );
  lines.push('- `founder`: see section 2.');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2));
  lines.push('```');
  lines.push('');

  // --- Section 2 ------------------------------------------------------
  lines.push('## 2. Owner or founder Person node');
  lines.push('');
  lines.push(
    `Not included. Nothing in this scan's evidence names an owner or founder anywhere on ${candidate.name}'s own ` +
      'pages, and a fact needs an origin before it gets published here (Law 1 of this kit). If you want a founder ' +
      'property on the organization node, add a Person node once you have a name confirmed on your own About or ' +
      'Team page, give it a stable `@id`, and point to it like this:'
  );
  lines.push('');
  lines.push('```json');
  lines.push(`"founder": { "@id": "${origin ? origin + '/#owner' : '#owner'}" }`);
  lines.push('```');
  lines.push('');
  lines.push(
    'Then add a `Person` node elsewhere in the same `@graph` carrying that `@id`, the name, and a `knowsAbout` ' +
      'array naming what they are actually known for. `knowsAbout` on the Person node is the plain-language ' +
      'topic-authority signal AI assistants read; worth the extra few minutes once a real name exists to attach it to.'
  );
  lines.push('');

  // --- Section 3 ------------------------------------------------------
  // A visible placeholder rather than a silent omission: the sentence above
  // promises a category, so the example has to show where it belongs.
  const categoryPart = categoryLabel ? ` | ${categoryLabel}` : ' | [what you do, in a customer\'s words]';
  const townPart = town ? ` | ${town}` : '';
  const categoryDescPart = categoryLabel ? `, ${categoryLabel.toLowerCase()}` : '';
  const townServingPart = town ? `, serving ${town}` : '';

  lines.push('## 3. Title tag and meta description');
  lines.push('');
  lines.push(
    'This scan\'s evidence does not include the literal text of your current title tag or meta description, so ' +
      'nothing here claims to know what you have now. Open your own view-source (Ctrl+U) and compare it to the ' +
      'pattern below before replacing anything.'
  );
  lines.push('');
  /**
   * The rule has to describe the example underneath it.
   *
   * It used to say a good title names the business, the category and the town,
   * and then print `<title>Business | Town</title>` whenever the Places listing
   * gave no usable category, which is exactly the case this kit is most often
   * generated in. A reader who follows the sentence cannot produce the example,
   * and a reader who copies the example has not followed the sentence. The
   * missing category is named as a gap instead, so they can fill it in.
   */
  if (categoryLabel) {
    lines.push(
      'A title that works for a search engine and an AI assistant alike names the business, the category and the ' +
        'town, in that order, and nothing else:'
    );
  } else {
    lines.push(
      'A title that works for a search engine and an AI assistant alike names the business, the category and the ' +
        'town, in that order, and nothing else. This scan could not read a category for you: the listing files you ' +
        'under an umbrella that does not name a trade. The example below therefore has a gap where the category ' +
        'goes, and filling it in with the word a customer would use is the single most valuable edit in this ' +
        'section:'
    );
  }
  lines.push('');
  lines.push('```html');
  // These two snippets are copy-paste HTML. A name carrying a quote or angle
  // bracket ("Bob's <Best> Diner") would break the tag the recipient pastes, so
  // escape it for the markup context even though this kit goes to the business
  // about its own site.
  const nameForHtml = candidate.name
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  lines.push(`<title>${nameForHtml}${categoryPart}${townPart}</title>`);
  lines.push('```');
  lines.push('');
  lines.push('Meta description, same discipline, with the promise finished in your own words rather than a guess of ours:');
  lines.push('');
  lines.push('```html');
  lines.push(
    `<meta name="description" content="${nameForHtml}${categoryDescPart}${townServingPart}. ` +
      `[finish this in your own words, with whatever actually makes ${nameForHtml} the right call]">`
  );
  lines.push('```');
  lines.push('');
  lines.push(
    'Keep both short enough that a search result does not cut them off mid-sentence; your own view-source will ' +
      'show you exactly where the current ones break.'
  );
  lines.push('');

  // --- Section 4 --------------------------------------------------------
  lines.push('## 4. FAQPage template');
  lines.push('');
  lines.push(
    'Content first, markup second: only mark up a question whose answer already exists as visible text on the ' +
      `page. Hidden FAQ schema for a question nobody can read is a penalty risk, not a shortcut, so resist the urge ` +
      `to seed this with questions ${candidate.name} has not actually published.`
  );
  lines.push('');
  lines.push(
    'This scan\'s evidence does not include the literal text of any FAQ you may already have, so there are no ' +
      'seed questions below. Copy the shape, then fill it in only with question-and-answer pairs that are already ' +
      'visible on the page, word for word:'
  );
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: '[a question visitors actually ask, copied from your own visible page copy]',
            acceptedAnswer: { '@type': 'Answer', text: '[the answer, exactly as it already reads on the page]' },
          },
        ],
      },
      null,
      2
    )
  );
  lines.push('```');
  lines.push('');

  // --- Section 5 --------------------------------------------------------
  const crawlFinding = findByCheck(findings, 'crawl-index');
  const aiFinding = findByCheck(findings, 'ai-readiness');
  /**
   * Two short lines about the two files this section is actually about.
   *
   * It used to print `aiFinding.detail`, which is every rubric note run
   * together: six items, each ending "Read across 7 page(s): /, /contact-us/,
   * /blog/, ..." with the whole page list repeated four times. On a real
   * packet that was a wall of machine output in the middle of a document whose
   * whole job is to be pasteable by somebody who does not read code, and most
   * of it was about FAQ markup and schema types, which this section is not
   * about.
   *
   * The score items are used rather than the finding's detail, so each line is
   * about one file and stops there. The crawl line uses the headline, which is
   * one sentence, rather than the detail, which is several.
   */
  const sawLines: string[] = [];
  if (crawlFinding) sawLines.push(`Crawl and index gate: ${crawlFinding.headline}`);
  const itemNote = (id: string): string | null => {
    const item = score?.items.find((i) => i.id === id);
    return item ? item.note : null;
  };
  const crawlerAccess = itemNote('crawler-access');
  const llmsNote = itemNote('llms-txt');
  if (crawlerAccess) sawLines.push(`AI crawler access: ${crawlerAccess}`);
  if (llmsNote) sawLines.push(`llms.txt: ${llmsNote}`);
  if (!crawlerAccess && !llmsNote && aiFinding) {
    sawLines.push(`AI readiness: ${aiFinding.headline}`);
  }

  lines.push('## 5. robots.txt and llms.txt');
  lines.push('');
  lines.push('What this scan saw:');
  lines.push('');
  if (sawLines.length) {
    for (const l of sawLines) lines.push(`- ${l}`);
  } else {
    lines.push('- Not captured in this scan.');
  }
  lines.push('');

  /**
   * A STARTER FILE IS ONLY EVER OFFERED FOR A FILE THAT IS NOT THERE.
   *
   * REGRESSION from a real packet. Both blocks below printed unconditionally.
   * That business scored 25/25 for crawler access and 12/15 for a genuine,
   * sectioned llms.txt listing 77 URLs, and the kit told it to publish a
   * one-line llms.txt naming only the homepage. The scan and its companion
   * document recommended undoing each other, and the recommendation is the
   * half a busy owner acts on. "Minimum viable" reads as an instruction when
   * the reader has nothing; it reads as a replacement when they have something.
   */
  const itemEarned = (id: string): { earned: number; possible: number } | null => {
    const item = score?.items.find((i) => i.id === id);
    return item ? { earned: item.earned, possible: item.possible } : null;
  };
  const crawlerItem = itemEarned('crawler-access');
  const llmsItem = itemEarned('llms-txt');
  // Unknown is treated as absent: offering a starter file to somebody who
  // already has one is the failure being fixed, so bias the other way only
  // when the scan positively saw something.
  const robotsPasses = crawlerItem !== null && crawlerItem.earned >= crawlerItem.possible;
  const llmsPresent = llmsItem !== null && llmsItem.earned > 0;

  /**
   * The sitemap the scan actually fetched, not the conventional path.
   *
   * Hardcoding `/sitemap.xml` told a business whose sitemap lives at
   * `/sitemap_index.xml` to declare a path that may 404. The crawl-index
   * capture already holds the URL that was really read, so use that and say
   * nothing when there is none.
   */
  const sitemapUrl =
    crawlFinding?.evidence?.map((e) => e.url).find((u) => /sitemap[^/]*\.xml(\?|$)/i.test(u)) ?? null;

  if (robotsPasses) {
    lines.push(
      'Your robots.txt already lets in every crawler this instrument checks, so there is nothing to change and ' +
        'nothing here to paste. Leave it alone. If you ever replace it, the one rule to keep is that none of the ' +
        'AI retrieval bots are disallowed.'
    );
    if (sitemapUrl) {
      lines.push('');
      lines.push(
        `One optional addition: a \`Sitemap:\` line pointing at the sitemap this scan read, \`${sitemapUrl}\`, ` +
          'if your robots.txt does not already carry one.'
      );
    }
  } else {
    lines.push(
      'Minimum viable robots.txt, open to every search crawler and every AI retrieval bot named in the ' +
        'AI-readiness instrument:'
    );
    lines.push('');
    lines.push('```');
    lines.push('User-agent: *');
    lines.push('Allow: /');
    if (sitemapUrl) {
      lines.push('');
      lines.push(`Sitemap: ${sitemapUrl}`);
    }
    lines.push('```');
    if (!sitemapUrl) {
      lines.push('');
      lines.push(
        'No `Sitemap:` line above: this scan did not read a sitemap on your site, and pointing at a path that ' +
          'is not there is worse than leaving it out. Add the line yourself once you know the address.'
      );
    }
  }
  lines.push('');

  if (llmsPresent) {
    lines.push(
      'You already have an llms.txt and it is doing its job, so there is no starter file here. **Do not replace ' +
        'it with a shorter one.** Grow the file you have: the line above says what this scan found missing from ' +
        'it, and adding those entries is the whole of the work.'
    );
  } else {
    lines.push(
      'Minimum viable llms.txt, a short hand-written summary an AI assistant can read directly instead of guessing ' +
        'from the rest of the site:'
    );
    lines.push('');
    lines.push('```');
    lines.push(`# ${candidate.name}`);
    lines.push('');
    lines.push(`${categoryLabel ? categoryLabel : 'Local business'}${town ? `, ${town}` : ''}.`);
    lines.push('');
    lines.push('## Pages');
    lines.push(`- [Home](${origin ? origin + '/' : '[your homepage address]'})`);
    lines.push('```');
    lines.push('');
    lines.push(
      'Safe to publish even when far from complete: a short accurate file beats no file, and it can grow later.'
    );
  }
  lines.push('');

  // --- Section 6 --------------------------------------------------------
  const quickWins = findings.filter((f) => f.status === 'flaw' && f.fix?.effort === 'minutes');

  lines.push('## 6. Small catches, five minutes each');
  lines.push('');
  if (quickWins.length === 0) {
    lines.push(
      'Nothing in this scan\'s confirmed findings is scoped as a five-minute fix; what is on file needs more than ' +
        'a quick edit. See your scorecard for the full list.'
    );
  } else {
    quickWins.forEach((f, i) => {
      const summary = f.fix ? safeText(f.fix.summary, f.headline, measured) : f.headline;
      lines.push(`${i + 1}. ${summary}`);
    });
  }
  lines.push('');

  // --- Footer -------------------------------------------------------------
  lines.push('## Verify before you publish');
  lines.push('');
  lines.push(
    'Paste each block, then run the page through two free checkers: validator.schema.org and Google\'s Rich ' +
      'Results Test. Fix anything either one flags before it goes live. Neither needs you to sign in or share the ' +
      'page anywhere beyond the tool itself.'
  );
  lines.push('');
  lines.push(`No pitch attached. ${operator.name} · free scan at ${operator.scannerUrl}`);

  return { kind: 'Schema-Starter', ext: 'md', text: lines.join('\n') + '\n' };
};

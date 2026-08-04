/**
 * How each rubric item is said to the person paying for the work.
 *
 * WHY IT IS SHARED. Three artifacts describe the same finding to the same
 * non-technical reader: the scorecard's owner page, the postcard and the
 * social post. They had three separate ideas of what an ai-readiness flaw
 * means, and two of them were wrong in the same way.
 *
 * THE BUG THIS FIXES. The postcard and the social post keyed one fixed
 * sentence off the checkId, so every ai-readiness flaw read "your homepage
 * carries no structured data telling AI assistants who you are or what you
 * do". ai-readiness is SIX items. On the first real packet the entity schema
 * item scored 13 of 20, with Organization and WebSite nodes both present and
 * named in the same document, and the worst item was the FAQ one. The
 * postcard would have gone to that business asserting they had no structured
 * data, contradicted by the scorecard in the same envelope.
 *
 * WHAT THESE SENTENCES MAY CLAIM. A mechanism, never a forecast, and never a
 * figure: what the missing thing is used for and what cannot happen without
 * it. No money, no traffic, no ranking. See generate.ts's guardrail sweep,
 * which refuses a number the app did not measure.
 */

import { FlawFinding, Score } from '../../../shared/types';

export type PlainCopy = {
  /** Owner-facing name for the item. */
  title: string;
  /**
   * What the scan found on THEIR site, in the owner's words. The measured
   * fact behind it is the rubric note, which still prints verbatim in the
   * scorecard's maintainer-page table; this is the same fact said the way
   * the rest of the owner page speaks. Like every string here it must be
   * true of the whole band the key covers, never more specific than that.
   */
  found: string;
  /** What the thing is, for somebody who does not read code. */
  means: string;
  /** What not having it prevents. A mechanism, not a prediction. */
  cost: string;
  /** Said instead of `cost` when the item is fully earned. */
  won: string;
  /** One sentence addressed to the owner. For the postcard. */
  short: string;
  /**
   * A noun phrase, for the social post, which reads "found ${phrase}".
   *
   * Kept as its own field rather than derived from `short` by rewriting the
   * opening words: that produced "found customers ask questions you have
   * already answered", which is not a sentence. It also has to name nobody,
   * because the social post is about an anonymous scan.
   */
  phrase: string;
};

/**
 * Keyed `<item-id>` for a total absence, `<item-id>:partial` for an item that
 * earned some of its points, and `<item-id>:<variant>` where the check reports
 * two findings that score the same and read differently.
 *
 * THE SECOND BUG, found reading a real packet. Every entry below used to be a
 * single block asserting the item was wholly missing, and `worstCopy` selects
 * whichever item merely lost the MOST points. A site with a real, sectioned
 * llms.txt scoring 12 of 15 would have been sent a postcard saying it had
 * none, contradicted by its own rubric table two pages later. The faq-page
 * entry did exactly that on the first real packet, on three surfaces at once:
 * it asserted the business had "already answered" its customers "in writing"
 * while the finding on the facing page read "No FAQ written and no FAQPage
 * markup." Copy that can only be true at zero must only be printed at zero.
 */
export const ITEM_COPY: Record<string, PlainCopy> = {
  'crawler-access': {
    title: 'Whether AI tools are allowed to read your site',
    found: "Your site's permission file turns the AI tools away.",
    means:
      'Assistants that answer questions about local businesses have to be allowed to read your pages before they can mention you. One small file on your site says yes or no to each of them.',
    cost:
      'Yours turns them away. An assistant that is refused cannot describe you at all, no matter how good the rest of the site is.',
    won: 'Yours lets all of them in. Nothing to do here.',
    short: 'Your site is turning away the AI tools people use to find a local company.',
    phrase: 'a site turning away the AI tools people use to find a local company',
  },
  'crawler-access:partial': {
    title: 'Whether AI tools are allowed to read your site',
    found: "Your site's permission file lets some AI tools in and turns others away.",
    means:
      'Assistants that answer questions about local businesses have to be allowed to read your pages before they can mention you. One small file on your site says yes or no to each of them.',
    cost:
      'Yours lets some in and turns others away. An assistant that is refused cannot describe you at all, no matter how good the rest of the site is.',
    won: 'Yours lets all of them in. Nothing to do here.',
    short: 'Your site is turning away some of the AI tools people use to find a local company.',
    phrase: 'a site turning away some of the AI tools people use to find a local company',
  },
  'llms-txt': {
    title: 'The file that tells AI what your site is for',
    found: 'There is no summary file for AI anywhere on your site.',
    means:
      'A short file that lists your pages and says what each one is for, so an assistant reading your site knows what you do and where to look without guessing.',
    cost:
      'Without it an assistant works the rest out from your page code. It gets less of it right, and what it gets wrong is what it repeats to the person asking.',
    won: 'You have one, and it is doing its job.',
    short:
      'Your site has no short summary written for AI, so assistants guess at what you do from the page code.',
    phrase: 'a site with no short summary written for AI, leaving assistants to guess at what the business does',
  },
  'llms-txt:partial': {
    title: 'The file that tells AI what your site is for',
    found: 'The summary file is there, and it covers only part of your site.',
    means:
      'A short file that lists your pages and says what each one is for, so an assistant reading your site knows what you do and where to look without guessing.',
    cost:
      'Yours exists and does not cover everything. For whatever it leaves out, an assistant is back to working it out from the page code, and what it gets wrong is what it repeats to the person asking.',
    won: 'You have one, and it is doing its job.',
    short:
      'Your summary for AI leaves out part of the site, so assistants still guess at those pages.',
    phrase: 'a summary written for AI that left out part of the site',
  },
  'entity-schema': {
    // Kept to one line at print width. The longer version wrapped, and the
    // line it cost orphaned the closing promise onto a sheet of its own.
    title: 'What your site tells AI about who you are',
    found: 'Nothing in the hidden format tells AI who you are.',
    means:
      'Your pages tell a person your name, where you are and what you do. AI needs the same facts written again in a separate hidden format.',
    cost:
      'Yours does not carry them, so an assistant has nothing to tie the business to a real named person or to your listings elsewhere. That is what it uses to decide you are a real company rather than a page it found.',
    won: 'The facts a machine needs are there and they agree with each other.',
    short:
      'Your homepage does not say who you are in the hidden format AI assistants read, so they have to guess.',
    phrase: 'a homepage that never says who the business is in the hidden format AI assistants read',
  },
  'entity-schema:partial': {
    title: 'What your site tells AI about who you are',
    found: 'The hidden format carries some facts about you, and the ones that tie you to a real company are missing.',
    means:
      'Your pages tell a person your name, where you are and what you do. AI needs the same facts written again in a separate hidden format. Yours has some of them.',
    cost:
      'The missing parts are the ones that tie the business to a real named person and to your listings elsewhere. That is what an assistant uses to decide you are a real company rather than a page it found.',
    won: 'The facts a machine needs are there and they agree with each other.',
    short:
      'Your homepage tells AI some of who you are, and leaves out the parts that prove you are a real company.',
    phrase: 'a homepage carrying some of the facts AI needs and none of the ones that prove a real company',
  },
  'faq-page': {
    // The unsuffixed entry is the safe one: true whether or not the answers
    // exist as page copy, because it claims nothing about what was written.
    title: 'The questions your customers actually ask',
    found: 'Nothing on your site is written as a question with its answer beside it.',
    means:
      'When someone asks an assistant a real question, it looks for businesses that have already answered that question in writing, in a format it can quote directly.',
    cost:
      'Nothing on your site is marked up as a question and its answer, so an assistant cannot quote you, and it quotes somebody who did mark it up instead.',
    won: 'Your answers are written where an assistant can quote them.',
    short:
      'Nothing on your site is written as a question and its answer, so an assistant quotes somebody else instead.',
    phrase: 'a site with nothing written as a question and its answer for an assistant to quote',
  },
  'faq-page:none': {
    title: 'The questions your customers actually ask',
    found: 'The questions customers ask are not answered anywhere on your site.',
    means:
      'When someone asks an assistant a real question, it looks for businesses that have already answered that question in writing, in a format it can quote directly.',
    cost:
      'Those answers are not written down anywhere on the site yet, so there is nothing for an assistant to quote and it quotes whoever did write theirs down. This is the one on the list that needs writing before it needs a developer.',
    won: 'Your answers are written where an assistant can quote them.',
    short:
      'The questions your customers ask are not answered anywhere on your site, so an assistant quotes somebody else.',
    phrase: 'a business whose customers questions were not answered anywhere on its own site',
  },
  'faq-page:unmarked': {
    title: 'The questions your customers actually ask',
    found: 'Your answers are on the site, and none of them are in a form AI can quote.',
    means:
      'When someone asks an assistant a real question, it looks for businesses that have already answered that question in writing, in a format it can quote directly.',
    cost:
      'You have written about these topics. None of it is marked up as a question and its answer, so an assistant cannot quote you, and it quotes somebody who did mark it up instead.',
    won: 'Your answers are written where an assistant can quote them.',
    short:
      'Customers ask questions you have already answered, but not in a form an assistant can quote back to them.',
    phrase: 'a business that had answered its customers questions in writing, none of it in a form an assistant can quote',
  },
  'faq-page:partial': {
    title: 'The questions your customers actually ask',
    found: 'AI can quote some of your answers, and the rest are written only for people.',
    means:
      'When someone asks an assistant a real question, it looks for businesses that have already answered that question in writing, in a format it can quote directly.',
    cost:
      'Some of your answers are marked up and the rest are not. An assistant can quote the ones that are, and for everything else it quotes somebody who marked theirs up.',
    won: 'Your answers are written where an assistant can quote them.',
    short:
      'Only some of the questions you have answered are in a form an assistant can quote back to them.',
    phrase: 'a business with only some of its answers in a form an assistant can quote',
  },
  'product-review': {
    title: 'A written list of what you sell',
    found: 'Nothing on your pages lists what you sell in a form AI can read.',
    means:
      'Somewhere on the site there should be a machine-readable list of the services you offer, in the words a customer would use for them.',
    cost:
      'A person reading your pages knows what you do. AI does not, so you are not a candidate when somebody asks for that service by name near your town.',
    won: 'What you sell is written down where AI can read it.',
    short:
      'Nothing on your site lists what you sell in a way AI can read, so you are not a candidate when somebody asks for it by name.',
    phrase: 'a site that never lists what the business sells in a way AI can read',
  },
  'product-review:partial': {
    title: 'A written list of what you sell',
    found: 'Part of what you sell is listed for AI, and the rest is not.',
    means:
      'Somewhere on the site there should be a machine-readable list of the services you offer, in the words a customer would use for them.',
    cost:
      'Part of what you sell is written down for AI and part of it is not. For the rest, you are not a candidate when somebody asks for that service by name near your town.',
    won: 'What you sell is written down where AI can read it.',
    short:
      'Only part of what you sell is listed in a way AI can read, so you are missed when somebody asks for the rest by name.',
    phrase: 'a site listing only part of what the business sells in a way AI can read',
  },
  'plain-words': {
    title: 'Whether you say what you do in plain words',
    found: 'Your page titles do not use the words a customer would type.',
    means:
      'The words a customer would actually type should appear in the title of your pages, which is the first thing both people and AI read.',
    cost:
      'Your titles are not doing that work. It is the cheapest thing on this list to change.',
    won: 'Your titles say what you do in the words a customer would use.',
    short: 'Your page titles do not say what you do in the words a customer would type.',
    phrase: 'page titles that never say what the business does in the words a customer would type',
  },
  'plain-words:partial': {
    title: 'Whether you say what you do in plain words',
    found: 'Your page titles use some of the words a customer would type, and leave out others.',
    means:
      'The words a customer would actually type should appear in the title of your pages, which is the first thing both people and AI read.',
    cost:
      'The title is doing less work than it could. It is the cheapest thing on this list to change.',
    won: 'Your titles say what you do in the words a customer would use.',
    short: 'Your page titles could say what you do in plainer words than they use now.',
    phrase: 'page titles saying what the business does in less plain words than a customer would type',
  },
};

/**
 * Hook copy for a finding that carries no score, keyed `<checkId>:<variant>`
 * where the variant is the verdict shape the check itself chose.
 *
 * THE THIRD BUG, same family as the two above. Five of the six checks never
 * carry a score, so worstCopy() returned null for them and the postcard and
 * social post fell through to one fixed sentence per checkId. Each of those
 * sentences describes a single verdict shape, and it printed for all of them:
 * a site whose scorecard NAMED the machine-readable date it found (the date
 * was merely stale) was mailed "Nothing on your site carries a date a machine
 * can read", and a site missing only a sitemap was told it was asking not to
 * be indexed. Copy that is only true of one verdict shape must only print for
 * that shape, so every entry here is keyed on the shape, and a finding
 * without a variant falls back to a sentence true of any flaw.
 *
 * WHAT THESE SENTENCES MAY CLAIM, same law as ITEM_COPY: a mechanism, never a
 * forecast, and never a figure, and nothing the recipient cannot verify
 * against their own page source. `short` is one sentence addressed to the
 * owner, for the postcard; `phrase` is an anonymous noun phrase for the
 * social post's "found ${phrase}". No digits anywhere: these strings pass the
 * same guardrail sweep the artifacts do, and a paraphrase that quotes no
 * finding text has nothing to trace a number back to.
 */
export type VerdictCopy = {
  /** One sentence addressed to the owner. For the postcard. */
  short: string;
  /** A noun phrase for the social post, which reads "found ${phrase}". */
  phrase: string;
};

export const VERDICT_COPY: Record<string, VerdictCopy> = {
  // -- website ------------------------------------------------------------
  'website:unreachable': {
    short: 'The website address on your listing does not answer with a working page.',
    phrase: 'a listed website that no longer answers with a working page',
  },
  'website:js-only': {
    short: 'Your page is mostly scripts, and shows almost nothing to anything that cannot run them.',
    phrase: 'a page that hands back almost no readable text once its scripts are stripped away',
  },
  'website:thin-content': {
    short: 'Your homepage carries almost no readable text, so AI reading it learns almost nothing about your business.',
    phrase: 'a homepage carrying almost no readable text for AI to learn the business from',
  },
  'website:parked': {
    short: 'The address on your listing opens a placeholder page rather than your business.',
    phrase: 'a listed web address opening a placeholder page rather than a business site',
  },
  'website:no-title': {
    short: 'Your homepage has no title line in its markup.',
    phrase: 'a homepage with no title line in its markup',
  },
  'website:social-profile': {
    short: 'The website on your listing is a social profile, so your presence lives on a platform someone else controls.',
    phrase: 'a business whose only listed website is a social profile on a platform someone else controls',
  },
  // -- freshness ----------------------------------------------------------
  'freshness:article-undated': {
    short: 'Your article markup carries no date a machine can read, so machines cannot tell how current your writing is.',
    phrase: 'an article page with no date a machine can read anywhere in its markup',
  },
  'freshness:homepage-undated': {
    short: 'Your site publishes a blog, yet your homepage carries no date a machine can read.',
    phrase: 'a site with a blog whose homepage carries no date a machine can read',
  },
  'freshness:stale': {
    short: 'The newest date a machine can read on your site is more than two years old.',
    phrase: 'a site whose newest machine-readable date is more than two years old',
  },
  'freshness:copyright-stale': {
    short: "Your footer's copyright year is years behind the current date.",
    phrase: 'a footer copyright year running years behind',
  },
  'freshness:aging': {
    short: 'The newest date a machine can read on your site is over a year old.',
    phrase: 'a site whose newest machine-readable date is over a year old',
  },
  'freshness:dates-unstructured': {
    short: 'Dates appear in your page copy and never in your structured data.',
    phrase: 'a site showing dates to readers while its structured data carries none',
  },
  // -- crawl-index ---------------------------------------------------------
  'crawl-index:noindex': {
    short: 'Your site is telling search engines not to index it.',
    phrase: 'a page telling search engines not to index it, in a directive the rendered page never shows',
  },
  'crawl-index:robots-blocked': {
    short: 'Your robots file asks any crawler without rules of its own there to read nothing on your site.',
    phrase: 'a robots file whose wildcard rule asks crawlers to read nothing at all',
  },
  'crawl-index:canonical-elsewhere': {
    short: 'Your homepage tells search engines the real version of the page lives on a different domain.',
    phrase: 'a homepage telling search engines its real version lives on a different domain',
  },
  'crawl-index:no-sitemap': {
    short: 'Your site has no sitemap, so no file lists your pages for a crawler.',
    phrase: 'a site where no sitemap lists its pages for a crawler',
  },
  'crawl-index:canonical-insecure': {
    short: 'Your homepage points search engines at the insecure version of its own address.',
    phrase: 'a homepage pointing search engines at the insecure version of its own address',
  },
  'crawl-index:sitemap-undeclared': {
    short: 'Your robots file never mentions your sitemap, so nothing on your site points a crawler at it.',
    phrase: "a sitemap the site's own robots file never mentions",
  },
  'crawl-index:sitemap-insecure-urls': {
    short: 'Your sitemap lists insecure http:// addresses for your own pages.',
    phrase: 'a sitemap listing insecure addresses for the site\'s own pages',
  },
  'crawl-index:sitemap-stale': {
    short: 'The newest date in your sitemap is over a year old.',
    phrase: 'a sitemap whose newest date is over a year old',
  },
  // -- booking-path ---------------------------------------------------------
  'booking-path:js-only-contact': {
    short: 'The only way to contact you lives inside a script, invisible to anything that does not render the page.',
    phrase: 'a contact link that only exists inside a script, so it disappears the moment anything reads the raw page instead of rendering it',
  },
  'booking-path:no-contact-path': {
    short: 'Your homepage offers no phone link, no email link and no contact form for AI to find.',
    phrase: 'a homepage offering no phone link, email link or contact form for AI to find',
  },
  'booking-path:phone-not-tappable': {
    short: 'Your phone number is plain text on the page, with no tap-to-call link in the markup.',
    phrase: 'a phone number printed as plain text with no tap-to-call link in the markup',
  },
  'booking-path:no-phone': {
    short: 'A visitor who would rather call finds no phone number anywhere on your page.',
    phrase: 'a page where a visitor who would rather call finds no phone number at all',
  },
  'booking-path:phone-only': {
    short: 'Calling is the only way your page offers to reach you, and anyone who would rather write is stuck.',
    phrase: 'a page offering a phone call as the only way to reach the business',
  },
  // -- nap-consistency ------------------------------------------------------
  'nap-consistency:phone-mismatch': {
    short: 'The phone number on your site does not match the one on your map listing.',
    phrase: "a phone number on the website that does not match the one on the business's own map listing",
  },
  'nap-consistency:street-mismatch': {
    short: 'The street number on your site does not match the one on your map listing.',
    phrase: "a street address on the website that does not match the one on the business's own map listing",
  },
  'nap-consistency:postal-mismatch': {
    short: 'The postal code on your site does not match the one on your map listing.',
    phrase: "a postal code on the website that does not match the one on the business's own map listing",
  },
  'nap-consistency:phone-unfindable': {
    short: 'The phone number on your map listing appears nowhere in your homepage source.',
    phrase: 'a business whose listed phone number appears nowhere in its own homepage source',
  },
  'nap-consistency:address-unfindable': {
    short: 'The address on your map listing appears nowhere in your homepage source.',
    phrase: 'a business whose listed address appears nowhere in its own homepage source',
  },
  'nap-consistency:nap-unfindable': {
    short: 'The phone number and address on your map listing appear nowhere in your homepage source.',
    phrase: 'a business whose listed phone number and address appear nowhere in its own homepage source',
  },
  'nap-consistency:nap-text-only': {
    short: 'Some of your business details sit on the page as plain text only, outside your structured data.',
    phrase: 'business details sitting on the page as plain text only, outside the structured data',
  },
};

/**
 * The copy for a scored item, chosen by what the check actually found.
 *
 * Most specific first: the check's own variant, then the partial-credit band,
 * then the total-absence default. The default is last on purpose. It is the
 * strongest claim of the three, and reaching it by accident is how a business
 * gets told it has none of something it has most of.
 */
export function copyFor(item: {
  id: string;
  earned: number;
  possible: number;
  variant?: string;
}): PlainCopy {
  const specific = item.variant ? ITEM_COPY[`${item.id}:${item.variant}`] : undefined;
  if (specific) return specific;
  if (item.earned > 0 && item.earned < item.possible) {
    const partial = ITEM_COPY[`${item.id}:partial`];
    if (partial) return partial;
  }
  return ITEM_COPY[item.id] as PlainCopy;
}

/** Worst first, by the points a check left on the table. */
export function byUnclaimed(items: Score['items']): Score['items'] {
  return [...items]
    .filter((i) => !i.na && ITEM_COPY[i.id])
    .sort((a, b) => b.possible - b.earned - (a.possible - a.earned));
}

/**
 * The one clause a short artifact should lead with.
 *
 * For a scored finding, driven by which item actually lost the most points,
 * so the sentence is about what is wrong with THIS site. For the five checks
 * that carry no score, driven by the verdict shape the check stamped on the
 * finding. Returns null only when neither is available (a finding
 * deserialized from an older session), and the caller falls back to
 * something true of any readiness flaw rather than asserting a specific one.
 */
export function shortestTrueClaim(f: FlawFinding): string | null {
  return worstCopy(f)?.short ?? verdictCopyFor(f)?.short ?? null;
}

/** The same claim as a noun phrase, for "found ${phrase}". */
export function shortestTruePhrase(f: FlawFinding): string | null {
  return worstCopy(f)?.phrase ?? verdictCopyFor(f)?.phrase ?? null;
}

function worstCopy(f: FlawFinding): PlainCopy | null {
  if (!f.score) return null;
  const worst = byUnclaimed(f.score.items)[0];
  if (!worst || worst.earned >= worst.possible) return null;
  return copyFor(worst) ?? null;
}

function verdictCopyFor(f: FlawFinding): VerdictCopy | null {
  if (!f.variant) return null;
  return VERDICT_COPY[`${f.checkId}:${f.variant}`] ?? null;
}

/**
 * Check 4 of 6, can a crawler enumerate and read this site at all?
 *
 * REPLACES the original "review-response pattern" check, cut 2026-07-29.
 * Google's Places API returns review text but has never exposed the owner's
 * REPLY, in the new API or the legacy one, and scraping Maps for it is barred
 * by both their terms and Law 5. Beyond the data problem, reply rate is a
 * local-SEO and reputation signal rather than an AI-visibility one, and the
 * part of it that does affect AI citation (Review schema on the prospect's own
 * site) is already scored inside the 105-point instrument.
 *
 * BOUNDARY WITH THE AI-READINESS INSTRUMENT. The instrument's "AI crawler
 * access /25" item scores whether the NAMED AI crawlers (GPTBot, ClaudeBot,
 * PerplexityBot and friends) are permitted. This check asks the prior
 * question: can ANY crawler enumerate and index these pages. They must not
 * double-count, so nothing here scores agent-specific rules.
 *
 * All four documents come from the operator's own step-4 paste set, so this
 * check adds no confirmation burden.
 *
 * SEVERITY IS HOOK QUALITY. A leftover noindex is the best hook in the whole
 * instrument: completely invisible to the owner, provable in one keystroke,
 * and it explains why everything else they have tried did nothing.
 *
 *   4  noindex, in the HTML or in the X-Robots-Tag header
 *   4  robots.txt disallows everything
 *   3  canonical points at a different domain, or loops
 *   3  no sitemap at all, and none declared in robots.txt
 *   2  sitemap exists but robots.txt never mentions it, or it lists http URLs
 *   1  sitemap has not been touched in over a year
 *   0  a crawler can get in and enumerate
 */

import { EvidenceRef, FlawFinding, FlawFix, Severity } from '../../shared/types';
import { CheckContext, FlawCheck } from './types';
import { documentStatus, type RawCapture } from '../evidence/fetch-raw';

/** Child sitemaps to follow when the sitemap is an index. Capped for politeness. */
const MAX_CHILD_SITEMAPS = 4;
import { cleanHeadline } from './headline';

/** `variant` names the verdict shape so the hook copy can be keyed on it; see FlawFinding.variant. */
type Verdict = { severity: Severity; status: FlawFinding['status']; detail: string; fix?: FlawFix; variant?: string };

type Signals = {
  origin: string;
  metaRobots: string | null;
  xRobotsTag: string | null;
  noindexSource: 'meta tag' | 'X-Robots-Tag header' | null;
  canonical: string | null;
  canonicalIssue: 'missing' | 'other-domain' | 'insecure' | null;
  robotsExists: boolean;
  robotsDisallowsAll: boolean;
  robotsSitemapUrls: string[];
  sitemapExists: boolean;
  /**
   * Whether the sitemap document is a <sitemapindex>, and how many child
   * sitemaps it names versus how many were actually read. The confirm pass can
   * read none of them, so a count taken from the index itself is a count of
   * FILES and must not be reported as pages. See sitemapSentence.
   */
  sitemapIsIndex: boolean;
  sitemapChildCount: number;
  sitemapChildrenRead: number;
  sitemapUrlCount: number;
  sitemapHttpUrls: number;
  sitemapForeignHostUrls: number;
  sitemapNewestLastmod: string | null;
  sitemapMonthsStale: number | null;
};

/** True when a robots directive string asks for no indexing. */
function saysNoindex(value: string | null): boolean {
  if (!value) return false;
  return /\b(noindex|none)\b/i.test(value);
}

/** Pulls an attribute value, handling double, single and unquoted forms. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v === undefined ? null : v.trim();
}

/**
 * Indexing directives from meta tags, matched on an EXACT name.
 *
 * The exact match is the whole point. An earlier version matched
 * `name=["']?(robots|googlebot|google)["']?`, and because the closing quote was
 * optional, `name="google` matched the prefix of `name="google-site-verification"`.
 * Field-testing a page with a known noindex printed the site's verification
 * token straight into the finding detail, which would have gone onto a
 * scorecard handed to the business. A loose prefix match on an attribute name
 * is a data-leak bug, not a style problem.
 *
 * `name="google"` is dropped entirely: it carries `notranslate`, never an
 * indexing directive.
 */
function extractMetaRobots(html: string): string | null {
  const found: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attr(tag, 'name')?.toLowerCase();
    if (name !== 'robots' && name !== 'googlebot') continue;
    const content = attr(tag, 'content');
    if (content) found.push(content);
  }
  return found.length ? found.join('; ') : null;
}

/** Same exact-match discipline as extractMetaRobots, for the same reason. */
function extractCanonical(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (attr(tag, 'rel')?.toLowerCase() !== 'canonical') continue;
    return attr(tag, 'href') || null;
  }
  return null;
}

/**
 * Minimal robots.txt parser: does the wildcard group disallow everything, and
 * what sitemaps are declared. Deliberately narrow, agent-specific rules are
 * the instrument's job, not this check's.
 */
function parseRobots(text: string): { disallowsAll: boolean; sitemaps: string[] } {
  const sitemaps: string[] = [];
  let inWildcardGroup = false;
  let disallowsAll = false;
  let sawGroupLine = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const [rawField, ...rest] = line.split(':');
    if (!rawField || rest.length === 0) continue;
    const field = rawField.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      // Consecutive user-agent lines form one group.
      if (!sawGroupLine) inWildcardGroup = value === '*' || inWildcardGroup;
      else inWildcardGroup = value === '*';
      sawGroupLine = false;
      continue;
    }
    if (field === 'disallow') {
      sawGroupLine = true;
      if (inWildcardGroup && value === '/') disallowsAll = true;
      continue;
    }
    if (field === 'allow') sawGroupLine = true;
  }

  return { disallowsAll, sitemaps };
}

/**
 * What the evidence supports saying about the sitemap's size.
 *
 * "The sitemap lists 3 URLs" went onto a client document for a site with a
 * good few dozen pages. Their sitemap is an INDEX, its three entries are child
 * sitemap files, and while the crawler pass now follows those, the
 * OPERATOR-CONFIRMED pass cannot: it can only read the four documents the
 * operator is able to paste, and a child sitemap is not one of them. So the
 * children came back empty, the code fell back to counting the index's own
 * entries, and the shipped finding, which is the confirmed one, called three
 * files three URLs.
 *
 * Following them is not the fix, because in that pass there is nothing to
 * follow. The fix is to stop claiming a page count that was not measured and
 * say what was actually seen instead.
 */
function sitemapSentence(s: Signals): string {
  if (s.sitemapIsIndex && s.sitemapChildrenRead === 0) {
    const n = s.sitemapChildCount;
    return (
      `The sitemap is an index pointing at ${n} child sitemap${n === 1 ? '' : 's'}, ` +
      'which were not read here, so the pages they list were not counted.'
    );
  }
  if (s.sitemapUrlCount > 0) {
    return `The sitemap lists ${s.sitemapUrlCount} URL${s.sitemapUrlCount === 1 ? '' : 's'}.`;
  }
  return 'No sitemap was readable, so the pages it would list were not checked.';
}

function parseSitemap(xml: string, origin: string): {
  urlCount: number;
  httpUrls: number;
  foreignHostUrls: number;
  newestLastmod: string | null;
} {
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1] ?? '');
  const lastmods = [...xml.matchAll(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/gi)].map((m) => m[1] ?? '');

  let httpUrls = 0;
  let foreignHostUrls = 0;
  const originHost = (() => {
    try {
      return new URL(origin).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return '';
    }
  })();

  for (const loc of locs) {
    if (/^http:\/\//i.test(loc)) httpUrls++;
    try {
      const host = new URL(loc).hostname.replace(/^www\./i, '').toLowerCase();
      if (originHost && host !== originHost) foreignHostUrls++;
    } catch {
      /* a malformed loc is counted only in urlCount */
    }
  }

  const parsed = lastmods
    .map((d) => Date.parse(d))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);

  return {
    urlCount: locs.length,
    httpUrls,
    foreignHostUrls,
    newestLastmod: parsed.length ? new Date(parsed[0]!).toISOString().slice(0, 10) : null,
  };
}

function verdicts(s: Signals): Verdict[] {
  const out: Verdict[] = [];

  // The best hook available anywhere in this instrument. Usually a staging
  // setting that shipped to production and was never noticed, because nothing
  // about the page looks wrong.
  if (s.noindexSource) {
    out.push({
      severity: 4,
      status: 'flaw',
      variant: 'noindex',
      detail:
        `The page tells search engines not to index it, via the ${s.noindexSource} ` +
        `(${s.noindexSource === 'meta tag' ? s.metaRobots : s.xRobotsTag}). ` +
        'The directive is invisible to a visitor, and it asks for the page to be left out of results.',
      fix: {
        summary:
          'Remove the noindex directive. If it came from a staging or "hide this site" setting in the CMS, turn that off, then request re-indexing in Google Search Console.',
        effort: 'minutes',
      },
    });
  }

  if (s.robotsDisallowsAll) {
    out.push({
      severity: 4,
      status: 'flaw',
      variant: 'robots-blocked',
      detail:
        'robots.txt contains "Disallow: /" in its wildcard group, which asks any crawler without rules of its own there to read nothing at all.',
      fix: {
        summary:
          'Replace the blanket disallow with rules that only block what genuinely should be private, such as cart and account pages.',
        effort: 'minutes',
        snippet: `User-agent: *\nAllow: /\n\nSitemap: ${s.origin}/sitemap.xml`,
      },
    });
  }

  if (s.canonicalIssue === 'other-domain') {
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'canonical-elsewhere',
      detail:
        `The canonical tag points at ${s.canonical}, a different domain. The tag names that ` +
        'other address as the original version of this page.',
      fix: {
        summary: 'Point the canonical at this page\'s own address, unless the content genuinely is a copy of the other domain.',
        effort: 'minutes',
        snippet: `<link rel="canonical" href="${s.origin}/">`,
      },
    });
  } else if (s.canonicalIssue === 'insecure') {
    out.push({
      severity: 2,
      status: 'flaw',
      variant: 'canonical-insecure',
      detail: `The canonical tag points at an http:// address (${s.canonical}) while the site serves over https.`,
      fix: {
        summary: 'Update the canonical to the https address the site actually serves.',
        effort: 'minutes',
        snippet: `<link rel="canonical" href="${s.origin}/">`,
      },
    });
  }

  if (!s.sitemapExists && s.robotsSitemapUrls.length === 0) {
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'no-sitemap',
      detail:
        'There is no sitemap.xml and robots.txt declares none, so no sitemap lists this site\'s pages for a crawler.',
      fix: {
        summary:
          'Publish a sitemap listing every page worth finding, then declare it in robots.txt.',
        effort: 'an afternoon',
        snippet: `Sitemap: ${s.origin}/sitemap.xml`,
      },
    });
  } else if (s.sitemapExists && s.robotsSitemapUrls.length === 0) {
    out.push({
      severity: 2,
      status: 'flaw',
      variant: 'sitemap-undeclared',
      // Same restraint as sitemapSentence: an unread index has no page count.
      detail:
        (s.sitemapIsIndex && s.sitemapChildrenRead === 0
          ? 'A sitemap exists'
          : `A sitemap exists with ${s.sitemapUrlCount} URLs`) +
        ', but robots.txt never mentions it, so nothing on the site itself points a crawler at it.',
      fix: {
        summary: 'Add one line to robots.txt declaring the sitemap.',
        effort: 'minutes',
        snippet: `Sitemap: ${s.origin}/sitemap.xml`,
      },
    });
  }

  if (s.sitemapHttpUrls > 0) {
    out.push({
      severity: 2,
      status: 'flaw',
      variant: 'sitemap-insecure-urls',
      // When the index was not read, the http entries counted are the child
      // sitemap FILES, not pages, and saying "of N sitemap URLs" would put the
      // file count in front of a business as a page count.
      detail:
        s.sitemapIsIndex && s.sitemapChildrenRead === 0
          ? `${s.sitemapHttpUrls} of the sitemap index's own entries use http:// addresses.`
          : `${s.sitemapHttpUrls} of ${s.sitemapUrlCount} sitemap URLs use http:// addresses.`,
      fix: {
        summary: 'Regenerate the sitemap so every URL uses https and matches the address the site actually serves.',
        effort: 'minutes',
      },
    });
  }

  /**
   * Not raised off an index whose children were not read.
   *
   * The lastmod on a child sitemap entry is when that FILE was regenerated,
   * which is not when the content changed. Telling a business their site has
   * gone a year without an update, on the strength of a timestamp that says no
   * such thing, is the exact shape of claim this app exists to not make.
   */
  const staleIsMeasurable = !(s.sitemapIsIndex && s.sitemapChildrenRead === 0);
  if (staleIsMeasurable && s.sitemapMonthsStale !== null && s.sitemapMonthsStale >= 12) {
    out.push({
      severity: 1,
      status: 'flaw',
      variant: 'sitemap-stale',
      detail:
        `The newest date in the sitemap is ${s.sitemapNewestLastmod}, about ${s.sitemapMonthsStale} months ago.`,
      fix: {
        summary: 'Regenerate the sitemap so lastmod reflects real edits.',
        effort: 'minutes',
      },
    });
  }

  if (out.length === 0) {
    // "a sitemap lists 0 URLs" was printed on a real scan for a site that HAS
    // a sitemap, at the address its own robots.txt declares. Zero is not a
    // count here, it is the absence of one, and the sentence has to say which.
    // See sitemapSentence for the second version of the same mistake.
    out.push({
      severity: 0,
      status: 'ok',
      detail:
        'A crawler can get in: no noindex and robots.txt permits crawling. ' +
        sitemapSentence(s),
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
  '- Restate ONLY the problem given under "The problem". Do not mention or look for any other issue.',
  '- If something in the facts looks wrong to you but is not the stated problem, ignore it.',
  '- Output exactly one sentence, under 25 words, and nothing else. No preamble, no quotes, no markdown.',
  '- Address the owner as "your". You may name what the finding mechanically prevents, such as software being unable to read something. Never assert an outcome the scan did not measure: no lost customers, no missed calls, no unanswered numbers, no rankings.',
  '- Use ONLY the facts given. Invent nothing: no traffic numbers, no rankings, no revenue.',
  '- No em dashes or en dashes. No emoji. Straight quotes only.',
  '- Do not use: leverage, crucial, pivotal, robust, seamless, unlock, elevate, delve, showcase.',
  '- Plain and specific beats dramatic. Do not exaggerate beyond the facts.',
].join('\n');

export const crawlIndexCheck: FlawCheck = {
  id: 'crawl-index',
  label: 'Crawl and index gate',

  async run(ctx: CheckContext): Promise<FlawFinding> {
    const listed = ctx.candidate.website;
    if (!listed) {
      return {
        checkId: 'crawl-index',
        status: 'disqualified',
        severity: 0,
        headline: `${ctx.candidate.name} has no website listed, so there is nothing to crawl.`,
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
        checkId: 'crawl-index',
        status: 'error',
        severity: 0,
        headline: `Could not parse the website address for ${ctx.candidate.name}.`,
        detail: `Places returned "${listed}", which is not a usable URL.`,
        evidence: [],
        confirmation: 'remote',
      };
    }

    // Three documents, all from the operator's step-4 paste set. The homepage
    // comes from the per-scan cache, so this costs one extra request beyond
    // what the website check already made.
    const [home, robots] = await Promise.all([
      ctx.fetch(listed),
      ctx.fetch(`${origin}/robots.txt`),
    ]);

    // robots.txt names the sitemap. Assuming /sitemap.xml made this check
    // report "a sitemap lists 0 URLs" on a real site whose robots.txt pointed
    // at /sitemap_index.xml, the WordPress and Yoast default. The directive was
    // already being parsed into robotsSitemapUrls and simply never followed.
    const declaredSitemaps = documentStatus(robots.ref) === 'present'
      ? [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => (m[1] ?? '').trim()).filter(Boolean)
      : [];
    let sitemap = await ctx.fetch(declaredSitemaps[0] ?? `${origin}/sitemap.xml`);
    if (documentStatus(sitemap.ref) !== 'present' && declaredSitemaps[0]) {
      sitemap = await ctx.fetch(`${origin}/sitemap.xml`);
    }

    // The homepage has to be readable before anything can be said about what
    // it does or does not contain. Without this gate a failed fetch became
    // html = '', which reads as "no noindex" and "no canonical problem", and
    // the check went on to report "a crawler can get in" about a page it never
    // saw. Worse, the website check reads the SAME cached capture and correctly
    // reported "the listed website did not load", so one scan shipped two
    // contradictory verdicts off one failure. Every other check gates here;
    // this one did not.
    if (
      home.ref.httpStatus !== 200 ||
      home.ref.storeError ||
      home.body.trim() === '' ||
      home.ref.truncated
    ) {
      return {
        checkId: 'crawl-index',
        status: 'unverified',
        severity: 0,
        headline: `Could not read ${ctx.candidate.name}'s homepage, so crawl and index access could not be judged.`,
        detail: `The homepage returned ${home.ref.httpStatus ?? 'no response'}${
          home.ref.transportError ? ` (${home.ref.transportError})` : ''
        }${
          home.ref.storeError
            ? `, and the capture could not be saved (${home.ref.storeError}), so there is no file to cite`
            : ''
        }. Nothing about noindex, canonical or crawlability can be concluded from a page that was not read.`,
        evidence: [home.ref, robots.ref, sitemap.ref].filter((r) => r.httpStatus !== null),
        confirmation: 'remote',
        unverifiedNote: 'Homepage capture failed; the crawl and index signals all need it.',
      };
    }

    const html = home.body;
    const metaRobots = extractMetaRobots(html);
    const xRobotsTag = home.ref.headers?.['x-robots-tag'] ?? null;

    const canonical = extractCanonical(html);
    let canonicalIssue: Signals['canonicalIssue'] = null;
    if (!canonical) {
      canonicalIssue = 'missing';
    } else {
      try {
        const c = new URL(canonical, origin);
        const originHost = new URL(origin).hostname.replace(/^www\./i, '').toLowerCase();
        const canonHost = c.hostname.replace(/^www\./i, '').toLowerCase();
        if (canonHost !== originHost) canonicalIssue = 'other-domain';
        else if (c.protocol === 'http:' && new URL(origin).protocol === 'https:') canonicalIssue = 'insecure';
      } catch {
        canonicalIssue = null;
      }
    }

    // A soft 404 answers a missing robots.txt or sitemap with the homepage at
    // HTTP 200. Parsing that HTML as robots.txt or as XML produces confident
    // nonsense, so presence is decided by documentStatus, not by the status
    // code alone.
    const robotsOk = documentStatus(robots.ref) === 'present' && robots.body.trim() !== '';
    const parsedRobots = robotsOk ? parseRobots(robots.body) : { disallowsAll: false, sitemaps: [] };

    const sitemapOk =
      documentStatus(sitemap.ref) === 'present' && /<(urlset|sitemapindex)\b/i.test(sitemap.body);

    /**
     * Resolve one level of <sitemapindex> before counting anything.
     *
     * WordPress, Shopify and most platforms serve a <sitemapindex> whose <loc>
     * entries are child sitemap FILES. Counting those made the check report
     * "The sitemap lists 2 URLs" on a client document for a site with five
     * pages, and it was not only the count: the http-URL, foreign-host and
     * lastmod verdicts were all measuring the child FILES rather than the
     * pages, so every sitemap sentence in this check was about the wrong
     * thing.
     *
     * The fetches are nearly free. ctx.fetch is memoised per run and the
     * ai-readiness check resolves the same index in the same scan, so these
     * come back from cache rather than off the network.
     */
    const sitemapIsIndex = sitemapOk && /<sitemapindex\b/i.test(sitemap.body);
    const childSitemaps: RawCapture[] = [];
    let childCount = 0;
    if (sitemapIsIndex) {
      const children = [...sitemap.body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
        .map((m) => (m[1] ?? '').trim())
        .filter((u) => /\.xml(\.gz)?(\?|$)/i.test(u));
      childCount = children.length;
      for (const c of await Promise.all(
        children.slice(0, MAX_CHILD_SITEMAPS).map((u) => ctx.fetch(u))
      )) {
        if (documentStatus(c.ref) === 'present') childSitemaps.push(c);
      }
    }

    // The index itself contributes no pages, so when it resolved into children
    // they are what gets parsed. Joined because every figure parseSitemap
    // produces is a count or a max across all <loc> and <lastmod> entries.
    const sitemapXml = childSitemaps.length
      ? childSitemaps.map((c) => c.body).join('\n')
      : sitemap.body;
    const parsedSitemap = sitemapOk
      ? parseSitemap(sitemapXml, origin)
      : { urlCount: 0, httpUrls: 0, foreignHostUrls: 0, newestLastmod: null };

    const monthsStale = parsedSitemap.newestLastmod
      ? Math.floor((Date.now() - Date.parse(parsedSitemap.newestLastmod)) / (1000 * 60 * 60 * 24 * 30.44))
      : null;

    const s: Signals = {
      origin,
      metaRobots,
      xRobotsTag,
      noindexSource: saysNoindex(metaRobots)
        ? 'meta tag'
        : saysNoindex(xRobotsTag)
          ? 'X-Robots-Tag header'
          : null,
      canonical,
      canonicalIssue,
      robotsExists: robotsOk,
      robotsDisallowsAll: parsedRobots.disallowsAll,
      robotsSitemapUrls: parsedRobots.sitemaps,
      sitemapExists: sitemapOk,
      sitemapIsIndex,
      sitemapChildCount: childCount,
      sitemapChildrenRead: childSitemaps.length,
      sitemapUrlCount: parsedSitemap.urlCount,
      sitemapHttpUrls: parsedSitemap.httpUrls,
      sitemapForeignHostUrls: parsedSitemap.foreignHostUrls,
      sitemapNewestLastmod: parsedSitemap.newestLastmod,
      sitemapMonthsStale: monthsStale,
    };

    const all = verdicts(s);
    const verdict = worst(all);

    // Only cite captures that actually produced bytes. A 404 on sitemap.xml is
    // still evidence of absence and is cited; a transport failure is not.
    // Child sitemaps are cited too: when the index resolved, they are where
    // every sitemap figure in this verdict actually came from.
    const evidence: EvidenceRef[] = [
      home.ref,
      robots.ref,
      sitemap.ref,
      ...childSitemaps.map((c) => c.ref),
    ].filter((r) => r.httpStatus !== null);

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
      checkId: 'crawl-index',
      status: verdict.status,
      severity: verdict.severity,
      headline,
      detail:
        all.length > 1
          ? `${verdict.detail} Also found: ${all.filter((v) => v !== verdict).map((v) => v.detail).join(' ')}`
          : verdict.detail,
      evidence,
      confirmation: 'remote',
      fix: verdict.fix,
      variant: verdict.variant,
    };
  },
};

/**
 * Exported for scripts/test-parsers.js only. These are the deterministic
 * functions that turn raw bytes into claims a prospect will be invited to
 * verify, so they are pinned by tests rather than trusted.
 */
export const __test = {
  saysNoindex,
  extractMetaRobots,
  extractCanonical,
  parseRobots,
  parseSitemap,
  verdicts,
};

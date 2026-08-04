/**
 * Check 6 of 6, how old does this site look to a machine?
 *
 * REPLACES "local-pack presence", cut 2026-07-29, for the same reason
 * review-response was cut. Local-pack presence cannot be measured from a
 * sanctioned source: the Places text-search ranking is a different surface
 * with a different algorithm, and the candidates in this app arrive FROM that
 * query, so asking whether they appear in it is circular. Its actionable half
 * (LocalBusiness schema, geo, NAP on the owned surface) already lives in the
 * entity-schema item and the NAP check.
 *
 * Freshness is a documented standing check in the house aeo-baseline with a
 * cited mechanism: content older than 24 months takes a 10 to 12 point
 * citation penalty in the Brave-to-Claude pipeline. A delivered scan already
 * leads with it, in the operator's own words: "173 undated posts is a
 * freshness score of zero by construction."
 *
 * SEVERITY IS HOOK QUALITY. The best finding here is a site that publishes
 * regularly and dates nothing. The owner knows the content is current because
 * they wrote it last week; a crawler has no way to tell, and cannot rank
 * recency it cannot read. Invisible, provable in one keystroke, consequential.
 *
 *   4  content is being published with NO machine-readable dates anywhere
 *   3  the newest date a machine can read is over 24 months old
 *   2  copyright year is two or more years behind, or sitemap dates are 12 to 24 months stale
 *   1  dates exist but only in visible text, never in structured data
 *   0  recent, machine-readable dates
 */

import { EvidenceRef, FlawFinding, FlawFix, Severity } from '../../shared/types';
import { extractJsonLd } from './ai-readiness';
import { CheckContext, FlawCheck } from './types';
import { cleanHeadline } from './headline';
import { documentStatus } from '../evidence/fetch-raw';

/** `variant` names the verdict shape so the hook copy can be keyed on it; see FlawFinding.variant. */
type Verdict = { severity: Severity; status: FlawFinding['status']; detail: string; fix?: FlawFix; variant?: string };

type Signals = {
  /** Newest date found in JSON-LD dateModified/datePublished. */
  newestSchemaDate: string | null;
  schemaDateCount: number;
  /** An Article-shaped node exists on THIS page. Proven from the bytes in hand. */
  pageIsArticle: boolean;
  /** The page links to a blog or news section. Says nothing about the posts. */
  linksToBlog: boolean;
  /** Dates visible in the copy but absent from structured data. */
  visibleDateCount: number;
  copyrightYear: number | null;
  lastModifiedHeader: string | null;
  newestSitemapLastmod: string | null;
  /**
   * The date `monthsSinceNewest` was actually measured from.
   *
   * Kept alongside `newestSchemaDate` because they are not the same thing and
   * printing one next to the other's age is a false claim. On the first real
   * scan the packet said "Newest machine-readable date is 2025-12-12, about 4
   * months ago" on a day when that date was seven and a half months back: the
   * date came from the page's JSON-LD, the age from newestOverall, which also
   * considers sitemap lastmod and was fresher. Both halves were true and the
   * sentence was not.
   */
  newestOverallDate: string | null;
  monthsSinceNewest: number | null;
};

const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

function monthsAgo(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / MONTH_MS);
}

/** Pulls every parseable date out of the JSON-LD graph. */
export function schemaDates(nodes: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    for (const key of ['dateModified', 'datePublished', 'uploadDate', 'dateCreated']) {
      const v = n[key];
      if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out.push(v);
    }
  }
  return out;
}

/** Counts dates a reader can see. Conservative: only unambiguous formats. */
export function visibleDates(text: string): number {
  const patterns = [
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/gi,
    /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+20\d{2}\b/gi,
    /\b20\d{2}-\d{2}-\d{2}\b/g,
  ];
  let n = 0;
  for (const p of patterns) n += [...text.matchAll(p)].length;
  return n;
}

export function copyrightYear(text: string): number | null {
  const years: number[] = [];
  // The separator class is written with escapes on purpose. Literal en and em
  // dash characters here were mangled by the repo-wide dash sweep into
  // `[--,]`, an invalid range that failed the build. A regex that must match
  // a character the source is banned from containing has to spell it in hex.
  const SEP = '[-\\u2010-\\u2015]';
  const re = new RegExp(`(?:©|&copy;|copyright)\\s*(?:20\\d{2}\\s*${SEP}\\s*)?(20\\d{2})`, 'gi');
  for (const m of text.matchAll(re)) {
    const y = Number(m[1]);
    if (Number.isFinite(y)) years.push(y);
  }
  return years.length ? Math.max(...years) : null;
}

export function verdicts(s: Signals, nowYear: number): Verdict[] {
  const out: Verdict[] = [];

  // THE HOOK, but only at full strength when THIS page is the article.
  //
  // These two states look identical to a careless check and are not the same
  // claim. An Article node on the captured page with no dates is proven from
  // the bytes in hand. A homepage that merely LINKS to a blog tells us nothing
  // about whether the posts themselves are dated, because we never fetched
  // one. Reporting the second as though it were the first is a claim wider
  // than the evidence, and a prospect who opens one post and finds a date
  // discards the whole scan.
  const dateFix: FlawFix = {
    summary:
      'Add datePublished and dateModified to the structured data on posts and pages.',
    effort: 'an afternoon',
    snippet: '"datePublished": "2026-07-29",\n"dateModified": "2026-07-29"',
  };

  if (s.pageIsArticle && s.schemaDateCount === 0) {
    out.push({
      severity: 4,
      status: 'flaw',
      variant: 'article-undated',
      detail:
        'This page is marked up as an article and carries zero machine-readable dates: no datePublished, no dateModified, ' +
        `anywhere in its structured data. ${s.visibleDateCount > 0 ? `${s.visibleDateCount} date(s) appear in the visible copy, so a reader can tell how current it is and a crawler cannot.` : 'Nothing dates it at all.'}`,
      fix: dateFix,
    });
  } else if (s.linksToBlog && s.schemaDateCount === 0) {
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'homepage-undated',
      detail:
        'The site publishes a blog, and the captured homepage carries no machine-readable dates at all: no datePublished, ' +
        'no dateModified. The posts themselves were not captured, so this is about the homepage rather than about every post.',
      fix: dateFix,
    });
  }

  if (s.monthsSinceNewest !== null && s.monthsSinceNewest >= 24) {
    out.push({
      severity: 3,
      status: 'flaw',
      variant: 'stale',
      detail:
        `The newest date a machine can read anywhere on this site is ${s.newestSchemaDate ?? s.newestSitemapLastmod}, about ` +
        `${s.monthsSinceNewest} months ago. This scan flags anything past 24 months.`,
      fix: {
        summary:
          'Refresh and re-date the pages that matter, then make sure dateModified actually updates when you edit.',
        effort: 'an afternoon',
      },
    });
  }

  if (s.copyrightYear !== null && nowYear - s.copyrightYear >= 2) {
    out.push({
      severity: 2,
      status: 'flaw',
      variant: 'copyright-stale',
      detail: `The footer copyright reads ${s.copyrightYear}, which is ${nowYear - s.copyrightYear} years behind the current date.`,
      fix: {
        summary: 'Make the copyright year render from the current date rather than a hardcoded number.',
        effort: 'minutes',
      },
    });
  } else if (
    s.monthsSinceNewest !== null &&
    s.monthsSinceNewest >= 12 &&
    s.monthsSinceNewest < 24
  ) {
    out.push({
      severity: 2,
      status: 'flaw',
      variant: 'aging',
      detail: `The newest machine-readable date is about ${s.monthsSinceNewest} months old.`,
      fix: {
        summary: 'Publish or meaningfully update something, and confirm the date propagates into the structured data and the sitemap.',
        effort: 'an afternoon',
      },
    });
  }

  if (s.schemaDateCount === 0 && s.visibleDateCount > 0 && !s.pageIsArticle && !s.linksToBlog) {
    out.push({
      severity: 1,
      status: 'flaw',
      variant: 'dates-unstructured',
      detail: `${s.visibleDateCount} date(s) appear in the copy and none in the structured data.`,
      fix: {
        summary: 'Mirror the dates you already show into the page structured data.',
        effort: 'minutes',
      },
    });
  }

  if (out.length === 0) {
    out.push({
      severity: 0,
      status: 'ok',
      // The date and the age must come from the same measurement. See
      // Signals.newestOverallDate for the false sentence this replaces.
      detail:
        s.newestOverallDate ?? s.newestSchemaDate
          ? `Newest machine-readable date is ${s.newestOverallDate ?? s.newestSchemaDate}, about ${s.monthsSinceNewest ?? 0} months ago.`
          : 'No staleness signals found.',
    });
  }

  return out;
}

const HEADLINE_SYSTEM_PROMPT = [
  'You rephrase ONE already-diagnosed website problem into a sentence a small-business owner would understand.',
  'You are not an auditor. The diagnosis is done. Your only job is wording.',
  'Rules, all mandatory:',
  '- Restate ONLY the problem given under "The problem". Do not mention or look for any other issue.',
  '- Output exactly one sentence, under 25 words, and nothing else. No preamble, no quotes, no markdown.',
  '- Address the owner as "your". You may name what the finding mechanically prevents, such as software being unable to read something. Never assert an outcome the scan did not measure: no lost customers, no missed calls, no unanswered numbers, no rankings.',
  '- Use ONLY the facts given. Invent nothing: no traffic numbers, no rankings, no revenue.',
  '- No em dashes or en dashes. No emoji. Straight quotes only.',
  '- Do not use: leverage, crucial, pivotal, robust, seamless, unlock, elevate, delve, showcase.',
  '- Plain and specific beats dramatic. Do not exaggerate beyond the facts.',
].join('\n');

function visibleTextOf(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const freshnessCheck: FlawCheck = {
  id: 'freshness',
  label: 'Content freshness and dating',

  async run(ctx: CheckContext): Promise<FlawFinding> {
    const listed = ctx.candidate.website;
    if (!listed) {
      return {
        checkId: 'freshness',
        status: 'disqualified',
        severity: 0,
        headline: `${ctx.candidate.name} has no website listed, so there is nothing to date.`,
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
        checkId: 'freshness',
        status: 'error',
        severity: 0,
        headline: `Could not parse the website address for ${ctx.candidate.name}.`,
        detail: `Places returned "${listed}", which is not a usable URL.`,
        evidence: [],
        confirmation: 'remote',
      };
    }

    // Same sitemap discovery as the other two checks: ask robots.txt where it
    // is rather than assuming /sitemap.xml, and require the document we asked
    // for rather than whatever a soft 404 hands back. The per-candidate fetch
    // cache makes the robots.txt request free; the other checks already made it.
    const [home, robots] = await Promise.all([ctx.fetch(listed), ctx.fetch(`${origin}/robots.txt`)]);
    const declaredSitemaps = documentStatus(robots.ref) === 'present'
      ? [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => (m[1] ?? '').trim()).filter(Boolean)
      : [];
    let sitemap = await ctx.fetch(declaredSitemaps[0] ?? `${origin}/sitemap.xml`);
    if (documentStatus(sitemap.ref) !== 'present' && declaredSitemaps[0]) {
      sitemap = await ctx.fetch(`${origin}/sitemap.xml`);
    }
    const sitemapUsable =
      documentStatus(sitemap.ref) === 'present' && /<(urlset|sitemapindex)\b/i.test(sitemap.body);

    // A truncated capture is a prefix; a date further down was never read.
    if (
      home.ref.httpStatus !== 200 ||
      home.ref.storeError ||
      home.body.trim() === '' ||
      home.ref.truncated
    ) {
      return {
        checkId: 'freshness',
        status: 'unverified',
        severity: 0,
        headline: `Could not read ${ctx.candidate.name}'s homepage, so freshness was not assessed.`,
        detail: `The homepage returned ${home.ref.httpStatus ?? 'no response'}${home.ref.storeError ? `, and the capture could not be saved (${home.ref.storeError}), so there is no file to cite` : ''}.`,
        evidence: [home.ref].filter((r) => r.httpStatus !== null),
        confirmation: 'remote',
        unverifiedNote: 'Homepage capture failed.',
      };
    }

    const html = home.body;
    const visible = visibleTextOf(html);
    const nodes = extractJsonLd(html);
    const dates = schemaDates(nodes);

    const sitemapDates = [...(sitemapUsable ? sitemap.body : '').matchAll(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/gi)]
      .map((m) => Date.parse((m[1] ?? '').trim()))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);

    const now = Date.now();
    const newestSchema = dates
      .map((d) => Date.parse(d))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a)[0];

    const newestOverall = [newestSchema, sitemapDates[0]]
      .filter((n): n is number => typeof n === 'number')
      .sort((a, b) => b - a)[0];

    const s: Signals = {
      newestSchemaDate: newestSchema ? new Date(newestSchema).toISOString().slice(0, 10) : null,
      schemaDateCount: dates.length,
      // Kept separate on purpose; see the comment in verdicts(). A brochure
      // site with five static pages is not stale for having no post dates.
      pageIsArticle: nodes.some((n) => {
        const t = n['@type'];
        const arr = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
        return arr.some((x) => /article|blogposting|newsarticle/i.test(x));
      }),
      linksToBlog: /href\s*=\s*["'][^"']*\/(blogs?|news|posts?)/i.test(html),
      visibleDateCount: visibleDates(visible),
      copyrightYear: copyrightYear(visible),
      lastModifiedHeader: home.ref.headers?.['last-modified'] ?? null,
      newestSitemapLastmod: sitemapDates[0] ? new Date(sitemapDates[0]).toISOString().slice(0, 10) : null,
      newestOverallDate: newestOverall ? new Date(newestOverall).toISOString().slice(0, 10) : null,
      monthsSinceNewest: newestOverall ? monthsAgo(new Date(newestOverall).toISOString(), now) : null,
    };

    const all = verdicts(s, new Date(now).getUTCFullYear());
    const verdict = all.reduce((a, b) => (b.severity > a.severity ? b : a));

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

    const evidence: EvidenceRef[] = [home.ref, sitemap.ref].filter((r) => r.httpStatus !== null);

    return {
      checkId: 'freshness',
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
      ...(s.linksToBlog && !s.pageIsArticle
        ? {
            unverifiedNote:
              'Only the homepage was captured. Whether individual blog posts carry their own dates is unverified, so this finding is scoped to the homepage.',
          }
        : {}),
    };
  },
};

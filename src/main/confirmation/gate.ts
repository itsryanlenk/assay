/**
 * The confirmation gate. Nothing leaves this app on crawler evidence alone.
 *
 * WHY THIS EXISTS. What this app's crawler receives is routinely not what the
 * operator sees in Ctrl+U: bot challenges, user-agent sniffing, consent walls,
 * CDN and geo variance. The entire pitch rests on the prospect reproducing
 * every claim in their own browser, so a claim only the crawler saw is worse
 * than no claim at all. The house law states it directly: mark remote findings
 * REMOTE until the operator's own browser confirms them.
 *
 * HOW IT RECONCILES. It does not re-implement the checks. Every check draws
 * its bytes from an injected `ctx.fetch`, so reconciliation swaps that one
 * function for a reader that serves the operator's pasted source, then runs
 * the identical six checks. A second implementation would drift from the first
 * and the drift would show up as a false "diverged".
 *
 * The three outcomes are all useful:
 *   confirmed  the operator's own source reproduces the finding. Safe to send.
 *   diverged   it does not. The claim is void, AND the divergence is itself a
 *              real finding: a site answering crawlers differently than
 *              browsers is worth more than whatever was originally flagged.
 *   unverified nothing was pasted for the document the finding rests on.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Candidate,
  EvidenceRef,
  FlawFinding,
  PasteKind,
  RunCheckResponse,
} from '../../shared/types';
import { AgentProvider } from '../agent/provider';
import { RawCapture, captureFilename, documentStatus } from '../evidence/fetch-raw';
import { runChecks } from '../checks/registry';

/**
 * Documents the operator can paste. Homepage and robots are required to confirm.
 *
 * Re-exported from shared/types rather than declared here. An earlier version
 * declared its own identical union, which compiled fine by structural typing
 * and was exactly the drift risk that once left the whole IPC bridge dead: two
 * definitions that agree today and silently disagree after one edit.
 */
export type { PasteKind };

export const REQUIRED_PASTES: PasteKind[] = ['homepage', 'robots'];

export type OperatorPaste = {
  kind: PasteKind;
  /** The exact URL this source came from, so it can be matched to a fetch. */
  url: string;
  /** Raw view-source, exactly as copied. Never trimmed or normalised. */
  content: string;
};

export type Divergence = {
  checkId: FlawFinding['checkId'];
  crawler: { status: string; severity: number; headline: string };
  operator: { status: string; severity: number; headline: string };
};

export type ConfirmationResult = {
  candidate: Candidate;
  scanId: string;
  /** Findings re-derived from the operator's own bytes, with confirmation set. */
  findings: FlawFinding[];
  divergences: Divergence[];
  /** ISO. Confirmations expire; see isExpired. */
  confirmedAt: string;
  missingPastes: PasteKind[];
  pastedPaths: string[];
};

/**
 * Confirmations go stale. The house rule is a morning-of re-verify before any
 * send, so a confirmation from Tuesday cannot back a postcard approved on
 * Friday. 72 hours is the window; past it the operator re-pastes.
 */
export const CONFIRMATION_TTL_HOURS = 72;

export function isExpired(confirmedAt: string, now = Date.now()): boolean {
  const t = Date.parse(confirmedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > CONFIRMATION_TTL_HOURS * 60 * 60 * 1000;
}

/**
 * Chrome's view-source and some editors wrap the source in a page. If what was
 * pasted is clearly an escaped rendering rather than the source itself, say so
 * rather than silently scoring the wrapper.
 */
export function looksLikeEscapedViewSource(content: string): boolean {
  const escaped = (content.match(/&lt;(script|html|head|meta|div)\b/gi) ?? []).length;
  const real = (content.match(/<(script|html|head|meta|div)\b/gi) ?? []).length;
  return escaped > 3 && escaped > real;
}

/** Stores an operator paste as a first-class capture, hashed and on disk. */
export function storePaste(
  paste: OperatorPaste,
  opts: { scanId: string; evidenceRoot: string }
): RawCapture {
  const bytes = Buffer.from(paste.content, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ext =
    paste.kind === 'homepage' || paste.kind === 'page' ? 'html' : paste.kind === 'sitemap' ? 'xml' : 'txt';

  const dir = path.join(opts.evidenceRoot, opts.scanId);
  const file = path.join(dir, captureFilename(paste.url, 'operator-browser', sha256, ext));

  const ref: EvidenceRef = {
    id: randomUUID(),
    url: paste.url,
    // The operator pasted this from the address they were standing on, so the
    // requested and final URL are the same by construction. No redirect
    // happened that we did not see, which is the whole point of the paste.
    requestedUrl: paste.url,
    source: 'operator-browser',
    method: 'GET',
    /**
     * 200, and the reason is worth stating because the first version used null.
     *
     * We made no HTTP request, so null felt like the scrupulous answer. It is
     * not: every check filters its evidence with `httpStatus !== null` and
     * several refuse to score a homepage that is not 200, so a null status
     * caused the operator's own source to be discarded as unreadable and every
     * finding to fall through to "nothing was pasted". The gate silently
     * confirmed nothing, ever.
     *
     * The operator's browser did receive a response and did render a body,
     * which is what they copied. Provenance is not carried by this field at
     * all: `source: 'operator-browser'` is what records that these bytes came
     * from a human's browser rather than our crawler, and that is the
     * distinction the whole gate turns on.
     */
    httpStatus: 200,
    contentType:
      paste.kind === 'homepage' || paste.kind === 'page'
        ? 'text/html'
        : paste.kind === 'sitemap'
          ? 'text/xml'
          : 'text/plain',
    fetchedAt: new Date().toISOString(),
    sha256,
    byteLength: bytes.length,
    storedPath: '',
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, bytes);
    ref.storedPath = file;
  } catch (e) {
    // storeError, not transportError: see EvidenceRef.storeError. There was no
    // transport here at all, and the checks reading this capture must refuse
    // it rather than diverge on it.
    ref.storeError = `could not store paste: ${(e as Error).message}`;
  }

  return { ref, body: paste.content, captured: ref.storedPath !== '' };
}

/** Normalises a URL for matching a paste to a fetch. */
function key(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/**
 * Re-runs the six checks against the operator's bytes and compares.
 *
 * A URL the operator did not paste resolves to an empty capture rather than a
 * live fetch. That is deliberate: silently reaching for the network here would
 * reintroduce crawler evidence into the very step meant to remove it, and the
 * finding would claim confirmation it never received.
 */
export async function confirm(
  candidate: Candidate,
  crawlerRun: RunCheckResponse,
  pastes: OperatorPaste[],
  deps: { agent: AgentProvider; evidenceRoot: string; scanId: string }
): Promise<ConfirmationResult> {
  const stored = new Map<string, RawCapture>();
  const pastedPaths: string[] = [];

  for (const p of pastes) {
    const cap = storePaste(p, { scanId: deps.scanId, evidenceRoot: deps.evidenceRoot });
    stored.set(key(p.url), cap);
    pastedPaths.push(cap.ref.storedPath || p.url);
  }

  const missingPastes = REQUIRED_PASTES.filter(
    (k) => !pastes.some((p) => p.kind === k && p.content.trim() !== '')
  );

  const emptyCapture = (url: string): RawCapture => ({
    ref: {
      id: randomUUID(),
      url,
      requestedUrl: url,
      source: 'operator-browser',
      method: 'GET',
      httpStatus: null,
      contentType: null,
      fetchedAt: new Date().toISOString(),
      sha256: '',
      byteLength: 0,
      storedPath: '',
      transportError: 'not pasted by the operator',
    },
    body: '',
    captured: false,
  });

  const operatorRun = await runChecks(
    { candidate, scanId: `${deps.scanId}-confirm` },
    {
      agent: deps.agent,
      evidenceRoot: deps.evidenceRoot,
      // The swap. Same checks, different bytes, no second implementation.
      fetchOverride: async (url: string) => stored.get(key(url)) ?? emptyCapture(url),
      reconciling: true,
    }
  );

  const divergences: Divergence[] = [];
  const findings: FlawFinding[] = [];

  // Which paste-able documents the operator actually supplied.
  const pastedKinds = new Set(
    pastes.filter((p) => typeof p.content === 'string' && p.content.trim() !== '').map((p) => p.kind)
  );
  // Extra pages the operator supplied, by normalised URL, so a page the crawler
  // scored can be checked off against what was actually pasted.
  const pastedPageUrls = new Set(
    pastes
      .filter((p) => p.kind === 'page' && typeof p.content === 'string' && p.content.trim() !== '')
      .map((p) => key(p.url))
  );

  /**
   * Documents and pages the CRAWLER scored that the operator did NOT reproduce.
   *
   * A finding scoring over something the reconciling pass has no bytes for scores
   * it absent, which drags the number down and looks like a divergence. It is
   * not one: the operator can close it by pasting the missing source, so the
   * verdict the evidence supports is "not yet reconciled", never "this site answers crawlers
   * differently than browsers". You cannot accuse a site of cloaking on evidence
   * you have not fully reproduced.
   *
   * Only ai-readiness hits this: it is the one check that scores over the
   * optional documents (llms.txt, sitemap) AND across pages beyond the homepage.
   * Every other check rests on the homepage, which is required; that case is the
   * readAnyPaste gate above.
   */
  const unreconciledDocs = (crawlerFinding: FlawFinding): string[] => {
    if (crawlerFinding.checkId !== 'ai-readiness') return [];
    const crawlerReadPresent = (match: (pathname: string) => boolean): boolean =>
      crawlerFinding.evidence.some((e) => {
        let pathname: string;
        try {
          pathname = new URL(e.requestedUrl || e.url).pathname;
        } catch {
          return false;
        }
        return match(pathname) && documentStatus(e) === 'present';
      });
    const out: string[] = [];
    if (!pastedKinds.has('llms') && crawlerReadPresent((p) => /\/llms\.txt$/i.test(p))) {
      out.push('llms.txt');
    }
    if (!pastedKinds.has('sitemap') && crawlerReadPresent((p) => /sitemap[^/]*\.xml$/i.test(p))) {
      out.push('sitemap.xml');
    }
    // Every same-origin page the crawler read and scored has to be reproduced
    // too, or a multi-page site's site-wide score cannot be reconciled. Skipping
    // a page that carried no signal is harmless: if the number already agrees it
    // was confirmed before this branch ran, so this only fires on a real
    // disagreement, where any unpasted page is a plausible cause.
    for (const pageUrl of crawlerFinding.extraPages ?? []) {
      if (!pastedPageUrls.has(key(pageUrl))) {
        let label = pageUrl;
        try {
          label = new URL(pageUrl).pathname || pageUrl;
        } catch {
          /* keep the raw url */
        }
        out.push(label);
      }
    }
    return out;
  };

  for (const crawlerFinding of crawlerRun.findings) {
    const opFinding = operatorRun.findings.find((f) => f.checkId === crawlerFinding.checkId);

    // Nothing pasted that this check could read: it stays unconfirmed rather
    // than being promoted or failed by default. Tested by an empty-paste
    // case, because "confirmed by default" is the one failure mode here that
    // would be invisible and catastrophic.
    /**
     * `storedPath` and not just `sha256`. storePaste hashes the bytes BEFORE
     * it attempts the write, so a paste that failed to reach disk still
     * carries a hash and used to satisfy this test. The finding was then
     * confirmed, or diverged, against a document nobody can produce.
     *
     * Diverged would have been the worse outcome of the two: the checks now
     * refuse an unstored capture, so the operator pass would come back
     * 'unverified', disagree with the crawler pass, and print "a site that
     * answers crawlers differently than browsers" over a busy disk. Catching
     * it here keeps it where it belongs, as simply not confirmed.
     */
    const readAnyPaste = opFinding?.evidence.some(
      (e) => e.source === 'operator-browser' && e.sha256 !== '' && e.storedPath !== ''
    );
    if (!opFinding || !readAnyPaste) {
      findings.push({
        ...crawlerFinding,
        confirmation: 'remote',
        unverifiedNote:
          (crawlerFinding.unverifiedNote ? crawlerFinding.unverifiedNote + ' ' : '') +
          'No operator paste covered the document this finding rests on, so it is still unconfirmed.',
      });
      continue;
    }

    const agrees =
      opFinding.status === crawlerFinding.status && opFinding.severity === crawlerFinding.severity;

    if (agrees) {
      /**
       * Which pass's words ship, once they agree.
       *
       * `agrees` compares status and severity only, and severityFor() bands
       * run up to twenty-five points wide, so two DIFFERENT scores agree
       * inside one. The
       * reconciling pass reads only what the operator pasted, which for a
       * site-wide item is routinely thinner than what the crawl read: a
       * Service node one page in is worth 7 points that cannot be pasted at
       * any price. Spreading `opFinding` therefore shipped the homepage-only
       * number labelled operator-confirmed and discarded the better-supported
       * one. 54 went out where the evidence said 61.
       *
       * checks/types.ts and ai-readiness.ts both already state the rule this
       * restores: the crawler pass produces the number this app SHIPS, and
       * the reconciling pass exists to compare signals against it.
       *
       * The scored statement moves as one piece. generate.ts prints the
       * headline AND the scorecard, and allowedFactsFrom() draws its number
       * allowlist from both, so a headline quoting 54 beside a scorecard
       * quoting 61 passes the sweep and contradicts itself on a document
       * handed to a business. Taking the score without its own sentences
       * would be a worse bug than the one being fixed.
       *
       * Evidence is the union, because the number rests on captures the
       * operator never pasted and a claim may never be wider than what is
       * cited under it. The operator's paste stays cited too: it is the
       * receipt for the word "confirmed".
       */
      if (crawlerFinding.score !== undefined) {
        findings.push({
          ...crawlerFinding,
          confirmation: 'operator-confirmed',
          evidence: [...crawlerFinding.evidence, ...opFinding.evidence],
        });
      } else {
        // No number came out of the crawler pass, so none ships. When
        // enumeration fails entirely that pass refuses a score on purpose;
        // promoting the reconciling pass's homepage-only number here would
        // walk straight around that refusal.
        findings.push({ ...opFinding, confirmation: 'operator-confirmed', score: undefined });
      }
      continue;
    }

    // Before calling this a divergence: is it explained by a document the
    // operator skipped? If the crawler read a real llms.txt or sitemap the
    // operator did not paste, the reconciling pass scored it absent and the
    // disagreement is a paste gap, not cloaking. Hold the finding at 'remote'
    // with a note naming the gap. 'remote' blocks release exactly as 'diverged' does,
    // so nothing shippable changes; only the reason the operator sees is
    // corrected from a fabricated diagnosis to an actionable one.
    const skipped = unreconciledDocs(crawlerFinding);
    if (skipped.length) {
      findings.push({
        ...crawlerFinding,
        confirmation: 'remote',
        unverifiedNote:
          (crawlerFinding.unverifiedNote ? crawlerFinding.unverifiedNote + ' ' : '') +
          `The crawler read ${skipped.join(', ')}, which you did not paste, so this score could not be ` +
          'fully reconciled against your own source. Paste the missing document(s) or page(s) and confirm ' +
          'again to settle whether it holds.',
      });
      continue;
    }

    divergences.push({
      checkId: crawlerFinding.checkId,
      crawler: {
        status: crawlerFinding.status,
        severity: crawlerFinding.severity,
        headline: crawlerFinding.headline,
      },
      operator: {
        status: opFinding.status,
        severity: opFinding.severity,
        headline: opFinding.headline,
      },
    });

    findings.push({
      ...opFinding,
      confirmation: 'diverged',
      divergenceNote:
        `The crawler saw "${crawlerFinding.status}" at severity ${crawlerFinding.severity}; ` +
        `your own source shows "${opFinding.status}" at severity ${opFinding.severity}. ` +
        'The original claim is void. A site that answers crawlers differently than browsers is itself worth raising.',
    });
  }

  return {
    candidate,
    scanId: deps.scanId,
    findings,
    divergences,
    confirmedAt: new Date().toISOString(),
    missingPastes,
    pastedPaths,
  };
}

/**
 * The wall. Phase 6's approval gate calls this and refuses anything it rejects.
 * Kept here rather than in the queue so the rule lives with the mechanism that
 * establishes it.
 */
export function releasable(
  findings: FlawFinding[],
  confirmedAt: string | null,
  now = Date.now()
): { ok: true } | { ok: false; reason: string } {
  if (!confirmedAt) {
    return { ok: false, reason: 'This packet has never been confirmed against your own view-source.' };
  }
  if (isExpired(confirmedAt, now)) {
    return {
      ok: false,
      reason: `The confirmation is older than ${CONFIRMATION_TTL_HOURS} hours. Re-paste the source before sending.`,
    };
  }
  /**
   * What counts as "cited".
   *
   * This used to be `status === 'flaw'` alone, which let a whole class of claim
   * out unconfirmed. The AI-readiness score is attached to a finding that is
   * frequently status 'ok', and generate.ts picks the score off ANY finding
   * that carries one and prints it on the scorecard with its full rubric. So a
   * confirmed-but-empty packet could ship "68/100" and a six-row instrument
   * table computed entirely from crawler bytes, with every finding still
   * 'remote', and this function returned ok.
   *
   * A printed number is a citation. Anything whose content reaches an artifact
   * has to have been reproduced in the operator's own browser first, which is
   * the entire promise. Gate on the score as well as the flaw.
   */
  /**
   * An empty findings array used to sail straight through: nothing to filter,
   * nothing unconfirmed, ok. So `approve(root, itemId, [], freshTimestamp)`
   * minted a real token for a real artifact with no confirmation having
   * happened at all, which is the whole wall walked around by passing it
   * nothing. A packet with no findings has nothing a prospect could reproduce,
   * so it is never releasable.
   */
  if (findings.length === 0) {
    return { ok: false, reason: 'This packet cites no findings, so there is nothing to reproduce.' };
  }

  const cited = findings.filter((f) => f.status === 'flaw' || f.score !== undefined);
  const unconfirmed = cited.filter((f) => f.confirmation !== 'operator-confirmed');
  if (unconfirmed.length) {
    return {
      ok: false,
      reason:
        `${unconfirmed.length} finding(s) in this packet are not operator-confirmed: ` +
        unconfirmed.map((f) => `${f.checkId} (${f.confirmation})`).join(', ') + '.',
    };
  }
  return { ok: true };
}

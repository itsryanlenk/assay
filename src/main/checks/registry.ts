/**
 * The check registry and the per-candidate runner.
 *
 * Checks run in parallel because they are independent and each one is mostly
 * waiting on a socket. Ranking takes the MAX severity across findings, never a
 * sum: the spec is worst-single-flaw, because outreach leads with one finding
 * too good to sit on, and an average would bury it under five mediocre ones.
 */

import {
  FlawFinding,
  FlawId,
  RunCheckRequest,
  RunCheckResponse,
  Severity,
} from '../../shared/types';
import { AgentProvider } from '../agent/provider';
import { RawCapture, fetchRaw } from '../evidence/fetch-raw';
import { CheckContext, FlawCheck } from './types';
import { aiReadinessCheck } from './ai-readiness';
import { crawlIndexCheck } from './crawl-index';
import { bookingPathCheck } from './booking-path';
import { freshnessCheck } from './freshness';
import { napConsistencyCheck } from './nap-consistency';
import { websiteCheck } from './website';

/** Every check the app knows about. Phase 3 fills in the remaining four. */
export const CHECKS: FlawCheck[] = [
  websiteCheck,
  crawlIndexCheck,
  aiReadinessCheck,
  freshnessCheck,
  bookingPathCheck,
  napConsistencyCheck,
];

export function checkById(id: FlawId): FlawCheck | undefined {
  return CHECKS.find((c) => c.id === id);
}

/**
 * A check that throws must not take the whole candidate down with it. The
 * failure is recorded as an 'error' finding so it is visible in the UI rather
 * than silently reducing the candidate's apparent severity.
 */
async function runOne(check: FlawCheck, ctx: CheckContext): Promise<FlawFinding> {
  try {
    const finding = await check.run(ctx);

    // A finding that claims a real result must carry a receipt. Catching this
    // here rather than trusting each check keeps Law 1 enforceable as the
    // check count grows.
    if ((finding.status === 'ok' || finding.status === 'flaw') && finding.evidence.length === 0) {
      // The one legitimate exception is a finding about an absence recorded in
      // the Places response itself, which carries an unverifiedNote instead.
      if (!finding.unverifiedNote) {
        return {
          checkId: check.id,
          status: 'error',
          severity: 0,
          headline: `${check.label} produced a finding with no evidence.`,
          detail:
            'A check reported a result without citing a capture. That is a programming error, not a finding about this business.',
          evidence: [],
          confirmation: 'remote',
        };
      }
    }

    return finding;
  } catch (e) {
    return {
      checkId: check.id,
      status: 'error',
      severity: 0,
      headline: `${check.label} failed to run.`,
      detail: `${(e as Error).name}: ${(e as Error).message}`,
      evidence: [],
      confirmation: 'remote',
    };
  }
}

export async function runChecks(
  req: RunCheckRequest,
  deps: {
    agent: AgentProvider;
    evidenceRoot: string;
    /**
     * Replaces the network entirely. The confirmation gate passes a reader
     * that serves the operator's own pasted view-source, so the identical six
     * checks re-run against the operator's bytes rather than the crawler's.
     * A second implementation of the checks would drift and the drift would
     * surface as a false divergence, so there is only ever one.
     */
    fetchOverride?: (url: string) => Promise<RawCapture>;
    /** See CheckContext.reconciling. Set by the confirmation gate only. */
    reconciling?: boolean;
  }
): Promise<RunCheckResponse> {
  const started = Date.now();

  const selected = req.only?.length
    ? CHECKS.filter((c) => req.only!.includes(c.id))
    : CHECKS;

  // One capture per URL per candidate, shared across all six checks.
  const cache = new Map<string, Promise<RawCapture>>();
  const memoFetch = (url: string): Promise<RawCapture> => {
    let hit = cache.get(url);
    if (!hit) {
      hit = deps.fetchOverride
        ? deps.fetchOverride(url)
        : fetchRaw(url, { scanId: req.scanId, evidenceRoot: deps.evidenceRoot });
      cache.set(url, hit);
    }
    return hit;
  };

  const ctx: CheckContext = {
    candidate: req.candidate,
    scanId: req.scanId,
    evidenceRoot: deps.evidenceRoot,
    agent: deps.agent,
    fetch: memoFetch,
    reconciling: deps.reconciling ?? false,
  };

  // Stamp every finding with the candidate it is about, in one place, so no
  // check has to remember to and none can disagree. The confirmation gate runs
  // the same six checks against the operator's bytes through this function, so
  // both passes carry the stamp and it survives reconciliation. The approval
  // gate refuses a finding whose stamp names another business; see FlawFinding.
  const findings = (await Promise.all(selected.map((c) => runOne(c, ctx)))).map((f) => ({
    ...f,
    candidateName: req.candidate.name,
  }));

  const disqualified = findings.some((f) => f.status === 'disqualified');

  // Disqualified and errored findings never contribute severity. A business we
  // cannot help must not out-rank one we can just because something failed.
  const worstSeverity = findings
    .filter((f) => f.status === 'flaw')
    .reduce<Severity>((max, f) => (f.severity > max ? f.severity : max), 0);

  return {
    candidate: req.candidate,
    scanId: req.scanId,
    findings,
    worstSeverity: disqualified ? 0 : worstSeverity,
    disqualified,
    durationMs: Date.now() - started,
  };
}

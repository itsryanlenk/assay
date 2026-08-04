/**
 * What a flaw check is.
 *
 * The division of labour is fixed and is not a style preference:
 *
 *   Detection, counts, presence, scoring  ->  plain TypeScript over raw bytes
 *   The plain-language headline           ->  the agent, given those findings
 *
 * The evidence law requires counting programmatically and reporting the
 * method, because a prospect has to be able to reproduce every cell with
 * Ctrl+U. A number a model produced is not reproducible, so a model never
 * produces a number here. It only writes the sentence a human reads.
 */

import { Candidate, FlawFinding } from '../../shared/types';
import { AgentProvider } from '../agent/provider';
import { RawCapture } from '../evidence/fetch-raw';

export type CheckContext = {
  candidate: Candidate;
  /** Groups this scan's captures on disk. */
  scanId: string;
  evidenceRoot: string;
  /** Used only to phrase findings, never to discover or verify them. */
  agent: AgentProvider;
  /**
   * Fetch a URL through the evidence chokepoint, memoised for this candidate.
   *
   * Six checks all want the homepage. Without this they would pull it six
   * times, which is rude to a small business's server, six times as likely to
   * trip a bot challenge, and six identical files on disk. Same EvidenceRef
   * comes back each time, so every finding cites one capture with one hash.
   */
  fetch: (url: string) => Promise<RawCapture>;
  /**
   * True on the confirmation pass, where `fetch` serves the operator's pasted
   * documents and nothing else.
   *
   * A check must not treat "the operator did not paste this" as "we tried and
   * could not read it". Only four documents can be pasted, so on that pass a
   * multi-page site will always look like a one-page capture, and a check that
   * refuses to score on thin coverage would refuse forever, leaving the finding
   * permanently unconfirmable and the packet permanently unreleasable.
   *
   * The confirmation pass compares signals against the crawler pass. It is not
   * the pass that produces the shippable number.
   */
  reconciling?: boolean;
};

export interface FlawCheck {
  readonly id: FlawFinding['checkId'];
  readonly label: string;
  run(ctx: CheckContext): Promise<FlawFinding>;
}

/** Convenience for checks that bail before any capture exists. */
export function noEvidence(
  checkId: FlawFinding['checkId'],
  note: string
): Pick<FlawFinding, 'checkId' | 'status' | 'severity' | 'evidence' | 'unverifiedNote'> {
  return { checkId, status: 'unverified', severity: 0, evidence: [], unverifiedNote: note };
}

export type { Candidate };

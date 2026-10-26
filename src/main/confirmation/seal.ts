/**
 * Proof that main produced a confirmation, not the renderer.
 *
 * The confirmation gate's whole promise is that nothing ships unless the
 * operator reproduced it in their own browser. But `releasable()` reads
 * `confirmation` and `confirmedAt` off findings, and generation and approval
 * receive those findings from the renderer. Re-checking data the caller
 * supplied is not a check: a compromised renderer could write
 * `operator-confirmed` and a fresh timestamp on anything and walk the wall.
 *
 * So confirm:run seals what it returns, with an HMAC under a key that exists
 * only in this process, and packet:generate and approval:approve refuse a
 * payload whose findings or timestamp are not byte-for-byte what was sealed.
 * The renderer holds confirmations only in memory, so a key that dies with
 * the process loses nothing a restart had not already lost.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { FlawFinding } from '../../shared/types';

const KEY = randomBytes(32);

/**
 * What is sealed is the JSON the renderer would send back. IPC's structured
 * clone keeps property order, so the same objects serialise to the same text
 * on both sides of the bridge.
 */
function mac(findings: FlawFinding[], confirmedAt: string | null): Buffer {
  return createHmac('sha256', KEY).update(JSON.stringify({ findings, confirmedAt })).digest();
}

export function sealFor(findings: FlawFinding[], confirmedAt: string | null): string {
  return mac(findings, confirmedAt).toString('base64url');
}

export function sealHolds(findings: unknown, confirmedAt: unknown, seal: unknown): boolean {
  if (!Array.isArray(findings) || typeof seal !== 'string') return false;
  if (confirmedAt !== null && typeof confirmedAt !== 'string') return false;
  const expected = mac(findings as FlawFinding[], confirmedAt);
  const given = Buffer.from(seal, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const UNSEALED_REASON =
  'These findings were not confirmed in this app, or were changed after they were. Run the confirmation again.';

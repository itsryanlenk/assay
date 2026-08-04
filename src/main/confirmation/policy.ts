/**
 * Standing laws the app enforces rather than documents.
 *
 * Each of these was a rule the operator held in their head. A rule held in a
 * head fails at 1am on a Friday, which is exactly when it matters, so each one
 * is code that gates selection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// The permanent off-limits list
// ---------------------------------------------------------------------------

export type BlockEntry = {
  /** Matched against the candidate's domain and its business name. */
  pattern: string;
  reason: string;
  addedAt: string;
};

/**
 * EMPTY ON PURPOSE, AND IT SHOULD STAY EMPTY.
 *
 * This shipped with a real company's name compiled into it. An off-limits list
 * is one operator's business relationships; it is data, not source code, and
 * publishing this repository would have published who that operator will not
 * approach and why.
 *
 * The permanence guarantee does NOT come from this array. It comes from two
 * things that are still true:
 *   - the app offers no way to remove an entry, only to add one
 *   - an unreadable or corrupt list is a hard failure that blocks selection,
 *     rather than an empty list that silently permits everything
 *
 * Entries live in `<userData>/blocklist.json`, added through the `policy:block`
 * channel. An earlier version of this comment said "added through the app"
 * while no channel existed and `addToBlocklist` had no callers, so the only
 * way to bar anyone was hand-editing JSON. That was a false claim of the exact
 * kind this project exists to avoid, sitting in the file that enforces the
 * project's one permanent rule.
 */
export const SEED_BLOCKLIST: BlockEntry[] = [];

/**
 * The list exists but could not be trusted. Callers must treat this as "every
 * candidate is blocked until this is fixed", never as "nothing is blocked".
 */
export class BlocklistUnreadableError extends Error {
  constructor(readonly detail: string) {
    super(`The off-limits list could not be read: ${detail}`);
    this.name = 'BlocklistUnreadableError';
  }
}

function blocklistPath(root: string): string {
  return path.join(root, 'blocklist.json');
}

/**
 * Throws BlocklistUnreadableError when a list exists but cannot be parsed.
 *
 * It used to swallow that and fall back to the seed array, which was only
 * safe while the seed array was non-empty. With seeds where they belong, in
 * operator data, the old behaviour would turn a corrupt file into "nothing is
 * blocked", which is the precise failure the comment claimed to prevent. A
 * blocklist that cannot be read has to stop the pipeline, not wave it through.
 *
 * A file that does not exist is a different thing: a new operator has no list
 * yet, and that is not an error.
 */
export function loadBlocklist(root: string): BlockEntry[] {
  const file = blocklistPath(root);

  /**
   * Read first and classify the error, rather than asking existsSync.
   *
   * `fs.existsSync` returns false for a permission error exactly as it does
   * for a missing file, so a blocklist the process cannot read took the
   * fail-OPEN branch: no entries, no error, nobody blocked. That is the one
   * failure this function exists to prevent. Only ENOENT means "no list yet".
   */
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [...SEED_BLOCKLIST];
    throw new BlocklistUnreadableError(`${code ?? 'read failed'}: ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BlocklistUnreadableError((e as Error).message);
  }
  if (!Array.isArray(parsed)) {
    throw new BlocklistUnreadableError('the file does not contain a list');
  }

  const entries = parsed.filter(
    (e): e is BlockEntry =>
      !!e && typeof (e as BlockEntry).pattern === 'string' && (e as BlockEntry).pattern.trim() !== ''
  );
  // Seeds are merged in every load, so deleting the file cannot silently
  // un-block anything that shipped as permanent.
  const seen = new Set(entries.map((e) => e.pattern.toLowerCase()));
  return [...entries, ...SEED_BLOCKLIST.filter((s) => !seen.has(s.pattern.toLowerCase()))];
}

export function addToBlocklist(root: string, entry: Omit<BlockEntry, 'addedAt'>): BlockEntry[] {
  // An empty or whitespace pattern used to be accepted, persisted, and handed
  // back so the UI would confirm it, then silently dropped by the filter in
  // loadBlocklist. The operator would have believed a business was barred.
  const pattern = (entry.pattern ?? '').trim();
  if (pattern === '') throw new BlocklistUnreadableError('a blocklist entry needs a pattern');
  const reason = (entry.reason ?? '').trim() || 'Standing off limits.';

  const list = loadBlocklist(root);
  if (!list.some((e) => e.pattern.toLowerCase() === pattern.toLowerCase())) {
    list.push({ pattern, reason, addedAt: new Date().toISOString().slice(0, 10) });
  }
  fs.mkdirSync(root, { recursive: true });
  // Write-then-rename, like config and the approval ledger. This is the one
  // file whose loss un-blocks people, and it was the only one writing in place.
  const tmp = `${blocklistPath(root)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, blocklistPath(root));
  return list;
}

/** Returns the matching entry when a candidate is off limits, else null. */
export function blockedBy(
  list: BlockEntry[],
  candidate: { name: string; website: string | null }
): BlockEntry | null {
  const name = candidate.name.toLowerCase();
  let host = '';
  try {
    host = candidate.website ? new URL(candidate.website).hostname.toLowerCase() : '';
  } catch {
    host = '';
  }
  return (
    list.find((e) => {
      const p = e.pattern.toLowerCase().trim();
      return p !== '' && (name.includes(p) || (host !== '' && host.includes(p)));
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

/**
 * One prospect at a time, spread across days. Mass-scanning a network in one
 * sitting reads as spray and kills the craftsman positioning that makes the
 * whole approach work.
 *
 * This warns rather than blocks. The operator may have a real reason, and a
 * hard stop on a judgement call trains people to route around the tool. What
 * it will not do is let the rule be forgotten.
 */
export const PACING_WINDOW_HOURS = 24;

export type PacketStart = { candidateName: string; startedAt: string };

export function pacingWarning(
  recent: PacketStart[],
  now = Date.now()
): { warn: false } | { warn: true; message: string } {
  const cutoff = now - PACING_WINDOW_HOURS * 60 * 60 * 1000;
  const inWindow = recent.filter((p) => {
    const t = Date.parse(p.startedAt);
    return Number.isFinite(t) && t >= cutoff;
  });

  if (inWindow.length === 0) return { warn: false };

  const names = inWindow.map((p) => p.candidateName).join(', ');
  return {
    warn: true,
    message:
      `You started ${inWindow.length} packet(s) in the last ${PACING_WINDOW_HOURS} hours (${names}). ` +
      'The pacing rule is one prospect at a time, spread across days, because a batch reads as spray. ' +
      'Continue only if you have a reason.',
  };
}

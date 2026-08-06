/**
 * Law 3, as a type: nothing auto-sends, auto-posts or auto-prints. Approval is
 * per item.
 *
 * This file has been named as Law 3's enforcement point since the first design
 * draft. For most of the project's life it did not exist. Until now the law rested on the fact that no sender
 * had been written yet, which is an accident of scheduling rather than an
 * enforcement point: the first person to add a `sendPostcard` would have had
 * nothing stopping them from calling it with a raw filename.
 *
 * THE MINT, AND EXACTLY HOW FAR IT GOES.
 *
 * `ApprovedItem` carries a unique symbol that this module does not export, so
 * an object literal, a hand-declared constant or a filename cannot be passed
 * where one is required. Those are compile errors, verified against the real
 * compiler in scripts/test-approval.js.
 *
 * What the brand does NOT stop, and an earlier version of this comment claimed
 * it did: `JSON.parse(s) as ApprovedItem` compiles fine. `any` casts through
 * any brand, in this codebase and in every other TypeScript codebase. Writing
 * that a cast is impossible would have been the same kind of false claim this
 * whole app exists to avoid, so instead there is a second, real defence:
 *
 * MINTED is a module-private WeakSet holding every token this module actually
 * issued. `assertMinted` is the runtime half, and every sender must call it.
 * A forged object is not in the set no matter how it was cast, and the set
 * cannot be reached from outside this file. Tokens do not survive a restart by
 * design; `tokenFor` re-issues them and re-runs every refusal when it does.
 *
 * WHAT APPROVAL IS NOT. Approving one item grants nothing to any other, and
 * approval is not a property of the packet. "Prepared" and "approved" are
 * different states and are stored separately, because a finished branded PDF
 * sitting in a client folder looks done, and the only thing between it and a
 * prospect is memory.
 *
 * REJECTION IS DATA. A rejection requires a non-empty reason and is recorded
 * rather than discarded, because the reasons are the only record of why a
 * prospect was passed over, and that is worth more than the approvals.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FlawFinding } from '../../shared/types';
import { releasable } from '../confirmation/gate';
import { ArtifactKind } from '../packet/paths';

declare const APPROVED: unique symbol;

/**
 * Proof that a specific artifact was approved by the operator, at a time, for
 * a reason the gate checked. Only mintApproval can produce one.
 */
export type ApprovedItem = {
  readonly [APPROVED]: true;
  readonly itemId: string;
  readonly kind: ArtifactKind;
  readonly slug: string;
  readonly filename: string;
  readonly approvedAt: string;
};

export type RejectedItem = {
  readonly itemId: string;
  readonly kind: ArtifactKind;
  readonly slug: string;
  readonly filename: string;
  readonly rejectedAt: string;
  readonly reason: string;
};

/**
 * `superseded` is what a re-scan does to the artifact it replaces.
 *
 * Running a scan again is a statement that the old packet is out of date, and
 * the artifact it produced should stop being sendable the moment a newer one
 * of the same kind exists. Before this, regenerating left the previous file
 * sitting in the ledger still marked approved: the HTML scorecard and the PDF
 * that replaced it have different filenames and therefore different ids, so
 * the old one was never touched and `assertMinted` would still have cleared
 * it for sending.
 *
 * It is archived rather than deleted, and it keeps its approval timestamp,
 * because when an artifact was cleared and what replaced it is exactly the
 * history this ledger exists to hold.
 */
export type ApprovalState = 'prepared' | 'approved' | 'rejected' | 'superseded';

export type QueueItem = {
  itemId: string;
  kind: ArtifactKind;
  slug: string;
  /**
   * The candidate's name exactly as Places returned it.
   *
   * Recorded so a caller can tie this row to a confirmation WITHOUT guessing.
   * The renderer previously matched by normalising the candidate name and
   * testing whether it was a substring of `slug`, which cross-matched any two
   * prospects whose names nest ("Ace Fire" inside "Ace Fire Protection").
   * `releasable()` only checks that findings are confirmed and unexpired, not
   * that they belong to this artifact, so that near-miss minted a real token
   * against another business's evidence.
   *
   * Optional because rows written before this field existed do not have it.
   * A missing name matches nothing, which reads as "not confirmed" and is the
   * safe direction.
   */
  candidateName?: string;
  /**
   * Which prospect this row belongs to, independent of what it is called.
   *
   * `slug` cannot answer that. It is built from the business name, the town
   * and the contact name, all of which the operator can change between runs,
   * and the supersede sweep scoped itself by slug. Fill in a town, fix a typo
   * or add a contact, and every earlier row fell outside the sweep: an
   * approved artifact stayed approved and stayed sendable while a newer scan
   * of the same business existed.
   *
   * Optional because rows written before this field existed do not have it;
   * the sweep falls back to slug for those, which is what it always did.
   */
  placeId?: string;
  filename: string;
  absolutePath: string;
  state: ApprovalState;
  approvedAt?: string;
  /** sha256 of the artifact AT THE MOMENT IT WAS APPROVED. */
  sha256?: string;
  rejectedAt?: string;
  reason?: string;
  /** When a rejection was reopened, and the reason given for reopening it. */
  reopenedAt?: string;
  reopenReason?: string;
  /** When a newer artifact of the same kind replaced this one. */
  supersededAt?: string;
  /** The itemId that replaced it, so the trail is followable. */
  supersededBy?: string;
};

/**
 * Every token this module has issued in this process. Module-private, so it
 * cannot be added to from anywhere else, and weak so tokens do not leak.
 */
const MINTED = new WeakSet<object>();

/**
 * Which ledger each token came from. Private, so `assertMinted` can go back to
 * the ledger without the caller telling it where to look, and without the root
 * being a field on the token that a caller could rewrite.
 */
const TOKEN_ROOT = new WeakMap<object, string>();

/** True only for a token this module actually issued. Casts do not help. */
export function isMinted(item: ApprovedItem): boolean {
  return MINTED.has(item as unknown as object);
}

/**
 * The runtime half of Law 3. Every sender calls this first.
 *
 * THREE THINGS, because set membership alone was not enough.
 *
 * 1. Was this object issued here? Stops a cast, which the type system cannot.
 *
 * 2. Does the ledger still say approved? Set membership is forever, so
 *    approve, then reject, then send used to succeed against a ledger that
 *    said rejected. Rejection has to actually revoke.
 *
 * 3. Do the token's fields still match the row it was minted from? The token
 *    is frozen now, but `readonly` is erased at runtime and freezing is silent
 *    in sloppy mode, so this is the check that does not depend on either.
 *    Without it, approving the cheapest artifact and rewriting `kind`, `slug`
 *    and `filename` on the token redirected a send to any other artifact, for
 *    any other prospect, and per-item approval meant nothing.
 */
export function assertMinted(item: ApprovedItem): void {
  if (!isMinted(item)) {
    throw new ApprovalRefused(
      'that approval was not issued by the approval gate. Approve the item, or call tokenFor to re-issue it.'
    );
  }
  const root = TOKEN_ROOT.get(item as unknown as object);
  if (!root) throw new ApprovalRefused('that approval has no ledger behind it');

  const row = loadQueue(root).find((i) => i.itemId === item.itemId);
  if (!row) throw new ApprovalRefused(`${item.filename} is no longer in the approval ledger`);
  if (row.state !== 'approved') {
    throw new ApprovalRefused(
      `${row.filename} is ${row.state}${row.reason ? ` (${row.reason})` : ''}, so this approval is void`
    );
  }
  if (row.kind !== item.kind || row.slug !== item.slug || row.filename !== item.filename) {
    throw new ApprovalRefused('that approval does not match the item it was issued for');
  }
  if (!fs.existsSync(row.absolutePath)) {
    throw new ApprovalRefused(`${row.filename} is no longer on disk`);
  }
  /**
   * The operator approved BYTES, not a filename.
   *
   * artifactFilename is deterministic per (business, kind, date) and
   * generatePacket writes to that exact path unconditionally, while prepare
   * deliberately preserves an approved state across regeneration. So without
   * this, regenerating a packet, or simply editing the HTML, replaced the
   * artifact under a token that stayed valid. Approve, edit, send.
   */
  if (row.sha256 && sha256Of(row.absolutePath) !== row.sha256) {
    throw new ApprovalRefused(
      `${row.filename} has changed since it was approved. Re-read it and approve again.`
    );
  }
}

function sha256Of(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Freezes and registers a token. The only place either happens. */
function mint(root: string, row: QueueItem, approvedAt: string): ApprovedItem {
  const token = Object.freeze({
    itemId: row.itemId,
    kind: row.kind,
    slug: row.slug,
    filename: row.filename,
    approvedAt,
  }) as ApprovedItem;
  MINTED.add(token as unknown as object);
  TOKEN_ROOT.set(token as unknown as object, root);
  return token;
}

export class ApprovalRefused extends Error {
  constructor(readonly reason: string) {
    super(`Refusing to approve: ${reason}`);
    this.name = 'ApprovalRefused';
  }
}

/**
 * Do these findings belong to this artifact's candidate?
 *
 * `releasable()` proves the findings are confirmed and unexpired; it does not
 * prove they are the RIGHT findings. The queue row records the candidate it was
 * prepared for, and each finding now carries the candidate it is about, so the
 * two can be tied together. Without this, one prospect's confirmed findings
 * mint a real token against another prospect's artifact: releasable() passes,
 * the bytes are on disk, and the gate has no idea it is looking at the wrong
 * business's evidence.
 *
 * A PRESENT, MISMATCHED stamp is the refusal. A row with no candidateName (a
 * ledger written before the field existed) cannot anchor the check, and a
 * finding with no candidateName (deserialized from an older session) cannot be
 * proven foreign; either way the check abstains rather than break an approval
 * it cannot actually fault. In the running app both are always present, because
 * generation records the candidate on the row and runChecks stamps every
 * finding, so the check has teeth exactly when it can.
 */
export function findingsBelong(row: QueueItem, findings: FlawFinding[]): boolean {
  if (!row.candidateName) return true;
  return !findings.some(
    (f) => typeof f.candidateName === 'string' && f.candidateName !== row.candidateName
  );
}

/** One stable id per artifact per prospect per day. */
export function itemIdFor(slug: string, date: string, filename: string): string {
  return `${slug}::${date}::${filename}`;
}

function ledgerPath(root: string): string {
  return path.join(root, 'approvals.json');
}

export function loadQueue(root: string): QueueItem[] {
  const file = ledgerPath(root);
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // Same reasoning as the blocklist: a ledger that cannot be read must not
    // read as "nothing has been approved or rejected", because that silently
    // re-offers a rejected item and loses the reason it was rejected for.
    throw new Error(`The approval ledger could not be read: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('The approval ledger is not a list.');
  return parsed.filter(
    (x): x is QueueItem => !!x && typeof (x as QueueItem).itemId === 'string'
  );
}

/**
 * A queue row plus the two facts only this process can establish.
 *
 * Both are derived at read time and never stored. Persisting them would create
 * a second copy of the truth that goes stale the moment anything touches the
 * file, which is the whole failure this is here to surface.
 */
export type QueueRowView = QueueItem & {
  /** The artifact is still where the ledger says it is. */
  onDisk: boolean;
  /**
   * Approved, and the bytes have changed since. `assertMinted` refuses to send
   * these, but it only runs at send time, and by then the operator believes
   * the item is cleared. The queue has to be able to say so up front, because
   * "approved" and "approved, then edited" look identical in a folder.
   */
  changedSinceApproved: boolean;
};

/** Read-only. The queue as the operator needs to see it, never as stored. */
export function queueView(root: string): QueueRowView[] {
  return loadQueue(root).map((row) => {
    const onDisk = fs.existsSync(row.absolutePath);
    return {
      ...row,
      onDisk,
      changedSinceApproved:
        row.state === 'approved' &&
        !!row.sha256 &&
        onDisk &&
        sha256Of(row.absolutePath) !== row.sha256,
    };
  });
}

function saveQueue(root: string, items: QueueItem[]): void {
  fs.mkdirSync(root, { recursive: true });
  const tmp = `${ledgerPath(root)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tmp, ledgerPath(root));
}

/** Records generated artifacts as PREPARED. Prepared is not approved. */
export function prepare(
  root: string,
  slug: string,
  date: string,
  artifacts: { kind: ArtifactKind; filename: string; absolutePath: string }[],
  candidateName?: string,
  placeId?: string
): QueueItem[] {
  const existing = loadQueue(root);
  const byId = new Map(existing.map((i) => [i.itemId, i]));

  for (const a of artifacts) {
    const itemId = itemIdFor(slug, date, a.filename);
    const prior = byId.get(itemId);
    // Regenerating must never downgrade a decision back to prepared.
    // If the operator already ruled on this exact artifact, the ruling stands
    // until it is explicitly reset.
    if (prior && prior.state !== 'prepared') continue;
    byId.set(itemId, {
      itemId,
      kind: a.kind,
      slug,
      ...(candidateName ? { candidateName } : {}),
      ...(placeId ? { placeId } : {}),
      filename: a.filename,
      absolutePath: a.absolutePath,
      state: 'prepared',
    });
  }

  /**
   * A newer artifact of the same kind archives the one it replaces.
   *
   * Scanning again says the old packet is out of date. Because the date is in
   * the filename, and because the scorecard changed extension when it became a
   * PDF, a re-scan produces a DIFFERENT itemId, so the loop above never sees
   * the old row and it sat there still marked approved and still sendable.
   *
   * This does not weaken the rule directly above it. That rule protects a
   * ruling on THIS artifact, and it still holds: regenerate the identical file
   * and its approval survives untouched, because the id matches and the branch
   * below skips it. What changes is only the fate of a DIFFERENT, older
   * artifact that this one replaces.
   *
   * Rejected rows are left alone. A rejection carries the operator's reason,
   * which is worth more than tidiness, and it is already unsendable.
   */
  const supersededAt = new Date().toISOString();
  const replacementFor = new Map<ArtifactKind, string>();
  for (const a of artifacts) replacementFor.set(a.kind, itemIdFor(slug, date, a.filename));

  /**
   * The same prospect, whatever it is currently called. Matching on placeId
   * when both rows carry one catches a re-slug; the slug comparison stays for
   * rows written before placeId existed, so this only ever widens the sweep.
   */
  const samePros = (row: QueueItem): boolean =>
    (!!placeId && !!row.placeId && row.placeId === placeId) || row.slug === slug;

  for (const row of byId.values()) {
    if (!samePros(row)) continue;
    if (row.state === 'rejected' || row.state === 'superseded') continue;
    const replacement = replacementFor.get(row.kind);
    if (!replacement || replacement === row.itemId) continue;
    row.state = 'superseded';
    row.supersededAt = supersededAt;
    row.supersededBy = replacement;
    // approvedAt and sha256 are kept on purpose: when this was cleared, and
    // for which bytes, is the history the ledger exists to hold.
  }

  const next = [...byId.values()];
  saveQueue(root, next);
  return next;
}

/**
 * The mint.
 *
 * Refuses, in this order:
 *   - an item that was never prepared, so there is nothing on disk to approve
 *   - an item already rejected, which needs an explicit reset, not a re-approve
 *   - a packet whose findings are not operator-confirmed, or whose confirmation
 *     has expired, checked with the SAME releasable() that generation calls so
 *     the two cannot disagree
 *   - an artifact whose file is no longer on disk
 */
export function approve(
  root: string,
  itemId: string,
  findings: FlawFinding[],
  confirmedAt: string | null,
  now: number = Date.now()
): { item: ApprovedItem; queue: QueueItem[] } {
  const queue = loadQueue(root);
  const found = queue.find((i) => i.itemId === itemId);
  if (!found) throw new ApprovalRefused(`no prepared item with id ${itemId}`);
  if (found.state === 'rejected') {
    // Name the way out. This used to say only that the item was rejected,
    // which left the operator staring at an artifact they could never approve
    // and no indication that reopening it was a thing that existed.
    throw new ApprovalRefused(
      `${found.filename} was rejected (${found.reason ?? 'no reason recorded'}). ` +
        'Reopen it first if you want to reconsider it.'
    );
  }
  // Approving an archived artifact would undo the re-scan that replaced it and
  // put a stale document back in play, which is the whole thing superseding
  // exists to prevent.
  if (found.state === 'superseded') {
    throw new ApprovalRefused(
      `${found.filename} was replaced by a newer scan, so it cannot be approved. Work from the artifact that replaced it.`
    );
  }

  // The findings have to be this business's findings. releasable() checks they
  // are confirmed and fresh, not that they belong here.
  if (!findingsBelong(found, findings)) {
    const foreign = findings.find(
      (f) => typeof f.candidateName === 'string' && f.candidateName !== found.candidateName
    );
    throw new ApprovalRefused(
      `these findings are for "${foreign?.candidateName}", but this artifact is ${found.candidateName}'s. ` +
        'Approval will not sign one business’s evidence onto another’s packet.'
    );
  }

  const verdict = releasable(findings, confirmedAt, now);
  if (!verdict.ok) throw new ApprovalRefused(verdict.reason);

  if (!fs.existsSync(found.absolutePath)) {
    throw new ApprovalRefused(`${found.filename} is not on disk at ${found.absolutePath}`);
  }

  const approvedAt = new Date(now).toISOString();
  found.state = 'approved';
  found.approvedAt = approvedAt;
  found.sha256 = sha256Of(found.absolutePath);
  delete found.rejectedAt;
  delete found.reason;
  saveQueue(root, queue);

  return { item: mint(root, found, approvedAt), queue };
}

/** Rejection requires a reason. An empty one is refused, not defaulted. */
export function reject(
  root: string,
  itemId: string,
  reason: string,
  now: number = Date.now()
): { item: RejectedItem; queue: QueueItem[] } {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ApprovalRefused('a rejection needs a reason, and the reason is the point');
  }
  const queue = loadQueue(root);
  const found = queue.find((i) => i.itemId === itemId);
  if (!found) throw new ApprovalRefused(`no prepared item with id ${itemId}`);

  const rejectedAt = new Date(now).toISOString();
  found.state = 'rejected';
  found.rejectedAt = rejectedAt;
  found.reason = reason.trim();
  delete found.approvedAt;
  saveQueue(root, queue);

  return {
    item: {
      itemId: found.itemId,
      kind: found.kind,
      slug: found.slug,
      filename: found.filename,
      rejectedAt,
      reason: reason.trim(),
    },
    queue,
  };
}

/**
 * Reopen a rejected item, with a reason.
 *
 * approve() has always refused a rejected item and told the caller it "needs
 * an explicit reset, not a re-approve". The reset was never built, so a
 * rejection was permanent: reject an artifact, fix whatever was wrong,
 * regenerate, and the new file lands under the SAME id, which prepare()
 * deliberately does not touch. The artifact was then unapprovable forever and
 * the only way out was hand-editing the ledger.
 *
 * THIS IS NOT AN UNAPPROVE, and the difference is the whole reason it is
 * allowed to exist. Unapproving would withdraw permission for
 * something that may already have gone out. Reopening a rejection puts
 * nothing in front of a prospect: it returns the item to `prepared`, which is
 * the state where it still has to be approved before it can go anywhere.
 *
 * It costs a reason, like the rejection did, and the original rejection is
 * kept rather than erased. Why an artifact was turned down and then
 * reconsidered is exactly the record this ledger is for.
 */
export function reopen(
  root: string,
  itemId: string,
  reason: string,
  now: number = Date.now()
): { queue: QueueItem[] } {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ApprovalRefused('reopening a rejection needs a reason, the same as the rejection did');
  }
  const queue = loadQueue(root);
  const found = queue.find((i) => i.itemId === itemId);
  if (!found) throw new ApprovalRefused(`no item with id ${itemId}`);
  if (found.state === 'superseded') {
    throw new ApprovalRefused(
      `${found.filename} was replaced by a newer scan. Work from the artifact that replaced it.`
    );
  }
  if (found.state !== 'rejected') {
    throw new ApprovalRefused(
      `${found.filename} is ${found.state}, and only a rejection can be reopened. There is no unapprove.`
    );
  }

  found.state = 'prepared';
  found.reopenedAt = new Date(now).toISOString();
  found.reopenReason = reason.trim();
  // rejectedAt and reason stay put. They are the record of what was turned
  // down and why, which is the more useful half of this row's history.
  saveQueue(root, queue);
  return { queue };
}

/**
 * The only way to turn a stored approval back into a token, for a later
 * session. Re-runs every refusal, so an approval that has since expired or
 * whose file has been deleted does not survive a restart.
 */
export function tokenFor(
  root: string,
  itemId: string,
  findings: FlawFinding[],
  confirmedAt: string | null,
  now: number = Date.now()
): ApprovedItem | null {
  const found = loadQueue(root).find((i) => i.itemId === itemId);
  if (!found || found.state !== 'approved' || !found.approvedAt) return null;
  // Re-mint refuses foreign findings the same way approve() does, so a stored
  // approval cannot be re-issued against another business's evidence.
  if (!findingsBelong(found, findings)) return null;
  if (!releasable(findings, confirmedAt, now).ok) return null;
  if (!fs.existsSync(found.absolutePath)) return null;
  return mint(root, found, found.approvedAt);
}

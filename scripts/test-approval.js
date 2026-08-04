/**
 * Phase 6, the approval queue. Run: npm run test:approve
 *
 * The design named `approval/gate.ts` as Law 3's enforcement point from the
 * first draft and the file did not exist. Until it did, the law rested on nobody
 * having written a sender yet, which is scheduling rather than enforcement.
 *
 * The last test in this file is the one that matters most: it proves that
 * forging an approval is a COMPILE error, not a runtime check somebody can
 * skip. It runs the real compiler against a file that tries every forgery
 * route and asserts the build fails.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const A = require(path.join(ROOT, 'dist/main/main/approval/gate.js'));

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass++;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}

const ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-'));
const DRAFTS = path.join(ROOT_DIR, 'drafts');
fs.mkdirSync(DRAFTS, { recursive: true });

const SLUG = 'Rockport-ME__Example-Boutique';
const DATE = '2026-07-30';
const file = (name) => {
  const p = path.join(DRAFTS, name);
  fs.writeFileSync(p, 'artifact', 'utf8');
  return p;
};

const SCORECARD = 'Example-Boutique__Scorecard__2026-07-30.html';
const SCHEMA = 'Example-Boutique__Schema-Starter__2026-07-30.md';

const artifacts = [
  { kind: 'Scorecard', filename: SCORECARD, absolutePath: file(SCORECARD) },
  { kind: 'Schema-Starter', filename: SCHEMA, absolutePath: file(SCHEMA) },
];

const evidence = [{
  id: 'e', url: 'https://example.test/', requestedUrl: 'https://example.test/', source: 'operator-browser',
  method: 'GET', httpStatus: 200, contentType: 'text/html', fetchedAt: new Date().toISOString(),
  sha256: 'a'.repeat(64), byteLength: 10, storedPath: 'x',
}];
const confirmed = [{
  checkId: 'website', status: 'flaw', severity: 3, headline: 'h', detail: 'd',
  evidence, confirmation: 'operator-confirmed',
}];
const remote = [{ ...confirmed[0], confirmation: 'remote' }];
const fresh = new Date().toISOString();
const stale = new Date(Date.now() - 73 * 3600 * 1000).toISOString();

const idScorecard = A.itemIdFor(SLUG, DATE, SCORECARD);
const idSchema = A.itemIdFor(SLUG, DATE, SCHEMA);

// --- prepared is not approved ----------------------------------------------
const queue = A.prepare(ROOT_DIR, SLUG, DATE, artifacts);
ok('generated artifacts land as prepared', queue.length === 2 && queue.every((i) => i.state === 'prepared'),
  JSON.stringify(queue.map((i) => i.state)));

// --- every refusal ----------------------------------------------------------
const refuses = (fn) => { try { fn(); return null; } catch (e) { return e; } };

ok('an unknown item cannot be approved',
  refuses(() => A.approve(ROOT_DIR, 'nope', confirmed, fresh)) instanceof A.ApprovalRefused);

ok('an unconfirmed finding cannot be approved',
  refuses(() => A.approve(ROOT_DIR, idScorecard, remote, fresh)) instanceof A.ApprovalRefused);

ok('a never-confirmed packet cannot be approved',
  refuses(() => A.approve(ROOT_DIR, idScorecard, confirmed, null)) instanceof A.ApprovalRefused);

ok('an expired confirmation cannot be approved',
  refuses(() => A.approve(ROOT_DIR, idScorecard, confirmed, stale)) instanceof A.ApprovalRefused);

// --- the mint ---------------------------------------------------------------
const { item } = A.approve(ROOT_DIR, idScorecard, confirmed, fresh);
ok('approval mints a token for the right artifact',
  item.itemId === idScorecard && item.kind === 'Scorecard' && typeof item.approvedAt === 'string',
  JSON.stringify(item));

// The whole reason approval is per item.
const after = A.loadQueue(ROOT_DIR);
ok('approving the scorecard approves nothing else',
  after.find((i) => i.itemId === idSchema).state === 'prepared',
  JSON.stringify(after.map((i) => `${i.filename}:${i.state}`)));

ok('an approved item survives a reload as a token',
  A.tokenFor(ROOT_DIR, idScorecard, confirmed, fresh) !== null);
ok('but not once its confirmation has expired',
  A.tokenFor(ROOT_DIR, idScorecard, confirmed, stale) === null);
ok('and not if the artifact has left the disk',
  (() => {
    fs.renameSync(path.join(DRAFTS, SCORECARD), path.join(DRAFTS, `${SCORECARD}.moved`));
    const t = A.tokenFor(ROOT_DIR, idScorecard, confirmed, fresh);
    fs.renameSync(path.join(DRAFTS, `${SCORECARD}.moved`), path.join(DRAFTS, SCORECARD));
    return t === null;
  })());

// --- REGRESSIONS from the adversarial review of this file's own code --------
// All four were confirmed by running before being fixed.

// 1. An empty findings array walked straight through releasable(): nothing to
//    filter, nothing unconfirmed, ok. So approve(root, id, [], fresh) minted a
//    real token for a real artifact with no confirmation having happened.
ok('an empty findings array cannot mint a token',
  refuses(() => A.approve(ROOT_DIR, idSchema, [], fresh)) instanceof A.ApprovalRefused);

// 2. The token was a plain mutable object. readonly is erased at runtime, so
//    approving the cheapest artifact once and rewriting kind/slug/filename
//    redirected a send to any other artifact, for any other prospect.
ok('a minted token is frozen', Object.isFrozen(item));
ok('rewriting a token does not change it',
  (() => { try { item.kind = 'Postcard-Front'; } catch { /* strict mode throws */ } return item.kind === 'Scorecard'; })());

// 3. assertMinted checked set membership only, and set membership is forever.
//    Approve, reject, then send used to succeed against a ledger saying
//    rejected.
{
  const live = A.approve(ROOT_DIR, idScorecard, confirmed, fresh).item;
  ok('a live token is accepted while approved', refuses(() => A.assertMinted(live)) === null);
  A.reject(ROOT_DIR, idScorecard, 'Reconsidered.');
  ok('rejecting revokes a token already handed out',
    refuses(() => A.assertMinted(live)) instanceof A.ApprovalRefused);
  // Put it back for the tests below.
  A.prepare(ROOT_DIR, SLUG, DATE, artifacts);
}

// 4. The token approved a FILENAME. artifactFilename is deterministic and
//    generatePacket overwrites unconditionally, so regenerating or hand
//    editing the HTML replaced the bytes under a still-valid approval.
{
  fs.rmSync(path.join(ROOT_DIR, 'approvals.json'));
  A.prepare(ROOT_DIR, SLUG, DATE, artifacts);
  const t = A.approve(ROOT_DIR, idScorecard, confirmed, fresh).item;
  ok('an approved artifact is accepted while its bytes are unchanged',
    refuses(() => A.assertMinted(t)) === null);
  fs.writeFileSync(path.join(DRAFTS, SCORECARD), 'rewritten after approval', 'utf8');
  ok('changing the bytes under an approved token revokes it',
    refuses(() => A.assertMinted(t)) instanceof A.ApprovalRefused);
  fs.writeFileSync(path.join(DRAFTS, SCORECARD), 'artifact', 'utf8');
  fs.rmSync(path.join(ROOT_DIR, 'approvals.json'));
  A.prepare(ROOT_DIR, SLUG, DATE, artifacts);
  A.approve(ROOT_DIR, idScorecard, confirmed, fresh);
}

// --- rejection is data ------------------------------------------------------
ok('a rejection with no reason is refused',
  refuses(() => A.reject(ROOT_DIR, idSchema, '   ')) instanceof A.ApprovalRefused);

const rejected = A.reject(ROOT_DIR, idSchema, 'Their FAQ moved, the claim needs re-checking.');
ok('a rejection records the reason', rejected.item.reason.startsWith('Their FAQ moved'));
ok('a rejected item cannot then be approved',
  refuses(() => A.approve(ROOT_DIR, idSchema, confirmed, fresh)) instanceof A.ApprovalRefused);

// --- regeneration must not reset a decision behind the operator --------------
A.prepare(ROOT_DIR, SLUG, DATE, artifacts);
const afterRegen = A.loadQueue(ROOT_DIR);
ok('regenerating does not downgrade an approval',
  afterRegen.find((i) => i.itemId === idScorecard).state === 'approved');
ok('regenerating does not erase a rejection',
  afterRegen.find((i) => i.itemId === idSchema).state === 'rejected',
  JSON.stringify(afterRegen.map((i) => `${i.filename}:${i.state}`)));

// --- a ledger that cannot be read must not read as empty --------------------
fs.writeFileSync(path.join(ROOT_DIR, 'approvals.json'), 'not json', 'utf8');
ok('a corrupt approval ledger throws rather than losing every decision',
  refuses(() => A.loadQueue(ROOT_DIR)) !== null);

// Put a good ledger back, or every assertion after this one is testing the
// corrupt-ledger path by accident rather than what it claims to test.
fs.rmSync(path.join(ROOT_DIR, 'approvals.json'));
A.prepare(ROOT_DIR, SLUG, DATE, artifacts);
A.approve(ROOT_DIR, idScorecard, confirmed, fresh);
ok('the ledger is usable again after being restored',
  A.loadQueue(ROOT_DIR).find((i) => i.itemId === idScorecard).state === 'approved');

// --- THE ONE THAT MATTERS: forging an approval must not compile -------------
// Runtime checks can be skipped by the next person to add a sender. A branded
// symbol that only the mint can produce cannot be.
{
  // Absolute, forward-slashed import so the probe compiles from anywhere and
  // a MODULE RESOLUTION failure can never masquerade as a rejected forgery.
  // The first draft of this test invoked npx and "passed" because the command
  // itself failed with no compiler output at all, which is the exact class of
  // green-but-meaningless test this project keeps getting bitten by.
  const gate = path.join(ROOT, 'src/main/approval/gate').split(path.sep).join('/');
  const send = path.join(ROOT, 'src/main/send/provider').split(path.sep).join('/');
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');

  const compile = (lines) => {
    const probe = path.join(ROOT_DIR, `probe-${Math.abs(lines.join('').length)}.ts`);
    fs.writeFileSync(probe, lines.join('\n'), 'utf8');
    try {
      execFileSync(
        process.execPath,
        [tsc, '--noEmit', '--strict', '--target', 'ES2022', '--module', 'commonjs',
          '--moduleResolution', 'node', probe],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return { compiled: true, out: '' };
    } catch (e) {
      return { compiled: false, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  };

  // Control: the probe scaffolding itself MUST compile. Without this, every
  // assertion below could be passing on a typo.
  const control = compile([
    `import { ApprovedItem } from '${gate}';`,
    `import { PostcardProvider, PostcardAddress } from '${send}';`,
    'declare const provider: PostcardProvider;',
    'declare const addr: PostcardAddress;',
    'declare const real: ApprovedItem;',
    'void provider.send(real, addr, addr);',
  ]);
  ok('control: a genuine token compiles', control.compiled === true, control.out.slice(0, 300));

  const handMade = compile([
    `import { ApprovedItem } from '${gate}';`,
    "const h: ApprovedItem = { itemId: 'x', kind: 'Scorecard', slug: 's', filename: 'f', approvedAt: 'n' };",
    'void h;',
  ]);
  ok('a hand-declared approval does not compile', handMade.compiled === false);
  ok('and it is refused on the brand, not on a missing ordinary field',
    /TS2741|TS2739|TS2322/.test(handMade.out) && /APPROVED/.test(handMade.out),
    handMade.out.slice(0, 400));

  /**
   * THE LIMIT OF THE BRAND, PINNED SO NOBODY OVERSTATES IT AGAIN.
   *
   * `JSON.parse(s) as ApprovedItem` compiles. It compiles in every TypeScript
   * codebase, because `any` casts through any brand. The file header used to
   * claim otherwise, which would have been exactly the kind of confident false
   * claim this app exists to prevent. This test asserts the cast DOES compile,
   * so the day it stops the comment gets revisited rather than becoming
   * true by accident.
   */
  const parsed = compile([
    `import { ApprovedItem } from '${gate}';`,
    `import { PostcardProvider, PostcardAddress } from '${send}';`,
    'declare const provider: PostcardProvider;',
    'declare const addr: PostcardAddress;',
    "void provider.send(JSON.parse('{}') as ApprovedItem, addr, addr);",
    '',
  ]);
  ok('a cast through any is NOT stopped by the type system, as documented',
    parsed.compiled === true, parsed.out.slice(0, 300));

  // Which is why there is a runtime half. This is the defence that actually
  // holds against a cast.
  const forged = JSON.parse(JSON.stringify({
    itemId: idScorecard, kind: 'Scorecard', slug: SLUG, filename: SCORECARD, approvedAt: fresh,
  }));
  ok('but the runtime mint refuses a forged token',
    refuses(() => A.assertMinted(forged)) instanceof A.ApprovalRefused);
  ok('and accepts a genuinely minted one',
    refuses(() => A.assertMinted(A.tokenFor(ROOT_DIR, idScorecard, confirmed, fresh))) === null);
  ok('a token round-tripped through JSON is no longer valid',
    refuses(() => A.assertMinted(
      JSON.parse(JSON.stringify(A.tokenFor(ROOT_DIR, idScorecard, confirmed, fresh)))
    )) instanceof A.ApprovalRefused);

  const bare = compile([
    `import { PostcardProvider, PostcardAddress } from '${send}';`,
    'declare const provider: PostcardProvider;',
    'declare const addr: PostcardAddress;',
    "void provider.send({ itemId: 'x' } as never, addr, addr);",
    "void provider.send('some-file.pdf', addr, addr);",
  ]);
  ok('sending a filename instead of a token does not compile', bare.compiled === false, bare.out.slice(0, 300));
}

// --- A rejection can be reopened, and nothing else can ----------------------
// approve() has always refused a rejected item and said it "needs an explicit
// reset". The reset was never built, so a rejection was permanent: reject an
// artifact, fix what was wrong, regenerate, and the new file lands under the
// SAME id, which prepare() deliberately does not touch. The artifact was then
// unapprovable forever with no way out but hand-editing the ledger. Reported
// from real use within minutes of the queue existing.
{
  const R3 = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-'));
  const D3 = path.join(R3, 'drafts');
  fs.mkdirSync(D3, { recursive: true });
  const NAME = 'Example-Boutique__Scorecard__2026-07-30.md';
  const p3 = path.join(D3, NAME);
  fs.writeFileSync(p3, 'artifact', 'utf8');
  A.prepare(R3, SLUG, DATE, [{ kind: 'Scorecard', filename: NAME, absolutePath: p3 }], 'Example Boutique');
  const id3 = A.itemIdFor(SLUG, DATE, NAME);

  A.reject(R3, id3, 'Wrong contact named.');
  ok('SETUP: a rejected item cannot be approved',
    refuses(() => A.approve(R3, id3, confirmed, fresh)) instanceof A.ApprovalRefused);
  ok('and the refusal now names the way out',
    /reopen/i.test(String(refuses(() => A.approve(R3, id3, confirmed, fresh)))),
    String(refuses(() => A.approve(R3, id3, confirmed, fresh))));

  ok('reopening without a reason is refused',
    refuses(() => A.reopen(R3, id3, '   ')) instanceof A.ApprovalRefused);

  A.reopen(R3, id3, 'Regenerated with the contact fixed.');
  const row3 = A.loadQueue(R3).find((r) => r.itemId === id3);
  ok('reopening returns the item to prepared, not to approved',
    row3 && row3.state === 'prepared', row3 && row3.state);
  ok('the original rejection and its reason are kept',
    row3 && row3.reason === 'Wrong contact named.' && typeof row3.rejectedAt === 'string',
    row3 && `${row3.rejectedAt}: ${row3.reason}`);
  ok('and why it was reopened is recorded too',
    row3 && row3.reopenReason === 'Regenerated with the contact fixed.', row3 && row3.reopenReason);

  // Prepared is short of sendable: it still has to be approved.
  ok('a reopened item is not sendable until it is approved again',
    A.tokenFor(R3, id3, confirmed, fresh) === null);
  A.approve(R3, id3, confirmed, fresh);
  ok('a reopened item can then be approved normally',
    A.tokenFor(R3, id3, confirmed, fresh) !== null);

  // THE LINE THIS MUST NOT CROSS. Reopening a rejection puts nothing in front
  // of anybody. Reopening an APPROVAL would withdraw permission for
  // something that may already have gone out, which is the unapprove this
  // gate refuses to have.
  ok('an approved item cannot be reopened, because that would be an unapprove',
    refuses(() => A.reopen(R3, id3, 'changed my mind')) instanceof A.ApprovalRefused);
  ok('the refusal says so in as many words',
    /no unapprove/i.test(String(refuses(() => A.reopen(R3, id3, 'changed my mind')))),
    String(refuses(() => A.reopen(R3, id3, 'changed my mind'))));

  try { fs.rmSync(R3, { recursive: true, force: true }); } catch { /* best effort */ }
}

// --- A re-scan archives what it replaces -----------------------------------
// Scanning again says the old packet is out of date. The date is in the
// filename and the scorecard changed extension when it became a PDF, so a
// re-scan produces a DIFFERENT itemId and the old row was never touched: it
// sat in the ledger still marked approved, still on disk, still hashing to
// what was approved, and therefore still sendable.
{
  const R2 = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-'));
  const D2 = path.join(R2, 'drafts');
  fs.mkdirSync(D2, { recursive: true });
  const mk2 = (name) => {
    const p = path.join(D2, name);
    fs.writeFileSync(p, `bytes of ${name}`, 'utf8');
    return p;
  };

  const OLD_CARD = 'Example-Boutique__Scorecard__2026-07-30.html';
  const OLD_KIT = 'Example-Boutique__Schema-Starter__2026-07-30.md';
  A.prepare(R2, SLUG, DATE, [
    { kind: 'Scorecard', filename: OLD_CARD, absolutePath: mk2(OLD_CARD) },
    { kind: 'Schema-Starter', filename: OLD_KIT, absolutePath: mk2(OLD_KIT) },
  ], 'Example Boutique');

  const oldCardId = A.itemIdFor(SLUG, DATE, OLD_CARD);
  A.approve(R2, oldCardId, confirmed, fresh);
  ok('SETUP: the earlier scorecard is approved and sendable',
    A.tokenFor(R2, oldCardId, confirmed, fresh) !== null);

  // The re-scan: a later date, and the scorecard is now a PDF.
  const NEW_DATE = '2026-07-31';
  const NEW_CARD = 'Example-Boutique__Scorecard__2026-07-31.pdf';
  const after = A.prepare(R2, SLUG, NEW_DATE, [
    { kind: 'Scorecard', filename: NEW_CARD, absolutePath: mk2(NEW_CARD) },
  ], 'Example Boutique');

  const oldRow = after.find((r) => r.itemId === oldCardId);
  ok('the replaced scorecard is archived rather than left approved',
    oldRow && oldRow.state === 'superseded', oldRow && oldRow.state);
  ok('the archive records what replaced it',
    oldRow && oldRow.supersededBy === A.itemIdFor(SLUG, NEW_DATE, NEW_CARD),
    oldRow && oldRow.supersededBy);
  ok('it keeps when it was approved, because that is the history',
    oldRow && typeof oldRow.approvedAt === 'string', oldRow && oldRow.approvedAt);

  // The point of the whole thing: it must stop being sendable.
  ok('an archived artifact can no longer be turned into a send token',
    A.tokenFor(R2, oldCardId, confirmed, fresh) === null);
  ok('and approving it again is refused',
    refuses(() => A.approve(R2, oldCardId, confirmed, fresh)) instanceof A.ApprovalRefused);

  // A different KIND is untouched: the re-scan did not produce one.
  const kitRow = after.find((r) => r.itemId === A.itemIdFor(SLUG, DATE, OLD_KIT));
  ok('an artifact kind the re-scan did not produce is left alone',
    kitRow && kitRow.state === 'prepared', kitRow && kitRow.state);

  // The rule this sits next to still holds: regenerating the IDENTICAL
  // artifact preserves the operator's ruling on it.
  const newCardId = A.itemIdFor(SLUG, NEW_DATE, NEW_CARD);
  A.approve(R2, newCardId, confirmed, fresh);
  const again = A.prepare(R2, SLUG, NEW_DATE, [
    { kind: 'Scorecard', filename: NEW_CARD, absolutePath: path.join(D2, NEW_CARD) },
  ], 'Example Boutique');
  const sameRow = again.find((r) => r.itemId === newCardId);
  ok('regenerating the identical artifact still preserves its approval',
    sameRow && sameRow.state === 'approved', sameRow && sameRow.state);

  // A rejection is not overwritten: the reason is worth more than tidiness.
  const REJ = 'Example-Boutique__Social-Post__2026-07-30.md';
  A.prepare(R2, SLUG, DATE, [{ kind: 'Social-Post', filename: REJ, absolutePath: mk2(REJ) }], 'Example Boutique');
  A.reject(R2, A.itemIdFor(SLUG, DATE, REJ), 'Wrong tone for this prospect.');
  const afterRej = A.prepare(R2, SLUG, NEW_DATE, [
    { kind: 'Social-Post', filename: 'Example-Boutique__Social-Post__2026-07-31.md', absolutePath: mk2('Example-Boutique__Social-Post__2026-07-31.md') },
  ], 'Example Boutique');
  const rejRow = afterRej.find((r) => r.itemId === A.itemIdFor(SLUG, DATE, REJ));
  ok('a rejection survives a re-scan, with its reason',
    rejRow && rejRow.state === 'rejected' && rejRow.reason === 'Wrong tone for this prospect.',
    rejRow && `${rejRow.state}: ${rejRow.reason}`);

  try { fs.rmSync(R2, { recursive: true, force: true }); } catch { /* best effort */ }
}

// --- findings must belong to the artifact's candidate ----------------------
// approve() re-runs releasable() on the findings it is handed, but releasable
// only proves they are confirmed and unexpired, not that they belong to THIS
// artifact. The queue row records the candidate; a finding now carries the same;
// the gate refuses evidence stamped for another business. Without it, one
// prospect's confirmed findings mint a real token against another's artifact.
{
  const R4 = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));
  const D4 = path.join(R4, 'drafts');
  fs.mkdirSync(D4, { recursive: true });
  const NAME = 'Alpha-Bakery__Scorecard__2026-07-30.md';
  const p4 = path.join(D4, NAME);
  fs.writeFileSync(p4, 'artifact', 'utf8');
  const SLUG4 = 'Rockport-ME__Alpha-Bakery';
  A.prepare(R4, SLUG4, DATE, [{ kind: 'Scorecard', filename: NAME, absolutePath: p4 }], 'Alpha Bakery');
  const id4 = A.itemIdFor(SLUG4, DATE, NAME);

  const mine = [{ ...confirmed[0], candidateName: 'Alpha Bakery' }];
  const foreign = [{ ...confirmed[0], candidateName: 'Beta Plumbing' }];

  ok('findings stamped for another business cannot approve this artifact',
    refuses(() => A.approve(R4, id4, foreign, fresh)) instanceof A.ApprovalRefused);
  ok('the refusal names the business the evidence actually belongs to',
    /Beta Plumbing/.test(String(refuses(() => A.approve(R4, id4, foreign, fresh)))),
    String(refuses(() => A.approve(R4, id4, foreign, fresh))));
  // tokenFor is the cross-session re-mint and must refuse the same way.
  ok('a foreign-stamped token is refused on re-mint',
    A.tokenFor(R4, id4, foreign, fresh) === null);

  ok('findings stamped for this business approve normally',
    (() => { try { A.approve(R4, id4, mine, fresh); return true; } catch { return false; } })());
  ok('the matching token re-mints after approval',
    A.tokenFor(R4, id4, mine, fresh) !== null);

  // A legacy row with no candidateName cannot anchor the check, so it abstains
  // rather than refusing an approval it cannot actually fault.
  fs.rmSync(path.join(R4, 'approvals.json'));
  A.prepare(R4, SLUG4, DATE, [{ kind: 'Scorecard', filename: NAME, absolutePath: p4 }]);
  ok('a row with no recorded candidate still approves (nothing to contradict)',
    (() => { try { A.approve(R4, id4, foreign, fresh); return true; } catch { return false; } })());

  try { fs.rmSync(R4, { recursive: true, force: true }); } catch { /* best effort */ }
}

// --- rebranding an already-approved artifact --------------------------------
// The first feature that routinely regenerates bytes the operator already
// ruled on: change the accent or the logo, regenerate the same day, and the
// filename (and therefore the itemId) is identical. The gate must notice the
// bytes moved rather than let a stale approval carry a document that now
// looks different. Required by the design review of the brand feature.
{
  const R5 = fs.mkdtempSync(path.join(os.tmpdir(), 'rebrand-'));
  const D5 = path.join(R5, 'drafts');
  fs.mkdirSync(D5, { recursive: true });
  const NAME5 = 'Example-Boutique__Scorecard__2026-07-30.html';
  const p5 = path.join(D5, NAME5);
  fs.writeFileSync(p5, '<html>unbranded scorecard</html>', 'utf8');

  const id5 = A.itemIdFor(SLUG, DATE, NAME5);
  A.prepare(R5, SLUG, DATE, [{ kind: 'Scorecard', filename: NAME5, absolutePath: p5 }], 'Example Boutique');
  A.approve(R5, id5, confirmed, fresh);
  ok('the unbranded scorecard approves',
    A.loadQueue(R5).find((r) => r.itemId === id5).state === 'approved');

  // Regenerating with a brand rewrites the same path with different bytes.
  fs.writeFileSync(p5, '<html>branded scorecard, navy accent and a logo</html>', 'utf8');
  A.prepare(R5, SLUG, DATE, [{ kind: 'Scorecard', filename: NAME5, absolutePath: p5 }], 'Example Boutique');

  const row = A.queueView(R5).find((r) => r.itemId === id5);
  ok('the approval survives the regenerate, as a decision the operator made',
    row.state === 'approved');
  ok('but the queue flags that the bytes changed after it was approved',
    row.changedSinceApproved === true);
  // The refusal is at assertMinted, not at tokenFor: a token still mints from
  // the stored approval (the operator's decision is real and survives), and
  // the byte check is what refuses to let the CHANGED artifact ship on it.
  // That is the "approve, edit, send" wall doing exactly its job on the first
  // feature that regenerates approved bytes as a matter of routine.
  const rebrandToken = A.tokenFor(R5, id5, confirmed, fresh);
  ok('a token still mints, because the operator really did approve this item',
    rebrandToken !== null);
  ok('but assertMinted refuses it: the bytes are not the bytes they approved',
    refuses(() => A.assertMinted(rebrandToken)) instanceof A.ApprovalRefused);
  ok('and the refusal names re-approval as the way out',
    /changed since it was approved/i.test(String(refuses(() => A.assertMinted(rebrandToken)))));

  try { fs.rmSync(R5, { recursive: true, force: true }); } catch { /* best effort */ }
}

try { fs.rmSync(ROOT_DIR, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('\n--- APPROVAL QUEUE TESTS ---');
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n  ${pass}/${pass + failures.length} passed${failures.length ? ', FAIL' : ', PASS'}\n`);
process.exit(failures.length ? 1 : 0);

/**
 * Packet generation. The step the whole pipeline exists to earn.
 *
 * TWO REFUSALS, BOTH BEFORE ANY FILE IS WRITTEN.
 *
 * 1. Nothing is generated from an unconfirmed finding. This calls the same
 *    `releasable()` the approval gate will call, so generation and release
 *    cannot disagree about what is safe. Generating first and checking later
 *    is what the pipeline was reordered to prevent: a finished branded PDF in
 *    a client folder looks done, and the only thing between it and a prospect
 *    is memory.
 *
 * 2. Every string that will reach a prospect passes the copy guardrails, and
 *    a violation throws rather than being repaired. A generator that launders
 *    its own mistakes is worse than one that stops.
 *
 * THE FREE TIER IS THREE ARTIFACTS. Scan, scorecard, schema starter. The
 * social post and postcard are delivery vehicles rather than deliverables.
 * 00-INDEX records that anything after those three is paid, so the rule lives
 * where the work does instead of in somebody's memory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Candidate, FlawFinding, Score } from '../../shared/types';
import { releasable } from '../confirmation/gate';
import { scoreSentence } from '../scoring/instrument';
import { QueueItem, loadQueue, prepare } from '../approval/gate';
import { BrandContext } from './brand';
import { assertClean, AllowedFacts, GuardrailError, sweepAsk } from './guardrails';
import {
  ArtifactKind,
  FREE_TIER,
  artifactFilename,
  businessSlug,
  isoDate,
  packetPaths,
} from './paths';

export type GeneratedArtifact = {
  kind: ArtifactKind;
  filename: string;
  absolutePath: string;
  bytes: number;
  freeTier: boolean;
};

export type GenerateRequest = {
  candidate: Candidate;
  findings: FlawFinding[];
  /** Must be inside the 72 hour window; the wall checks it. */
  confirmedAt: string | null;
  outputRoot: string;
  contactName?: string | null;
  /**
   * Operator's own contact line, printed in the artifact footers.
   *
   * `askMode` picks the scorecard's closing ask: the house pitch ('default')
   * or the operator's own `ask` text ('custom', where blank prints no ask at
   * all). Both optional because operator objects persisted before the fields
   * existed have neither; absent reads as 'default', which is what every
   * packet printed before the setting existed.
   */
  operator: { name: string; email: string; scannerUrl: string; askMode?: 'default' | 'custom'; ask?: string };
  /** Derived in main from config; null when nothing is branded. */
  brand?: BrandContext | null;
};

export type GenerateResult = {
  slug: string;
  date: string;
  draftsDir: string;
  artifacts: GeneratedArtifact[];
  /** The approval queue after this packet entered it. Every row is 'prepared'. */
  queue: QueueItem[];
};

/**
 * How many characters of a capture's sha256 an artifact prints.
 *
 * Lives here rather than in the renderer because `allowedFactsFrom` below has
 * to allow exactly what gets printed. Two copies of this number drift, and the
 * drift shows up as a packet that refuses to generate for one prospect and not
 * another, depending on whether a hash happened to start with digits.
 */
export const EVIDENCE_HASH_CHARS = 6;

/** Longer, because the capture manifest uses it to name files on disk. */
export const MANIFEST_HASH_CHARS = 12;

export class NotReleasableError extends Error {
  constructor(readonly reason: string) {
    super(`Refusing to generate: ${reason}`);
    this.name = 'NotReleasableError';
  }
}

/**
 * Numbers this packet is permitted to contain, collected from what the app
 * actually measured. The guardrail sweep rejects any other figure, which is
 * what stops a model inserting a plausible statistic into copy.
 */
export function allowedFactsFrom(findings: FlawFinding[]): AllowedFacts {
  const numbers = new Set<string>();
  for (const f of findings) {
    /**
     * Detail AND the fix, including its snippet. NOT the headline.
     *
     * The fix was originally left out, and it is not a small omission: fix
     * text is written by the same deterministic check code from the same
     * measured data, so its numbers are exactly as sourced as the rest. A real
     * freshness finding carries the snippet `"datePublished": "2026-07-29"`,
     * whose 07 and 29 are not years and not structural, so leaving the fix
     * unscanned made generatePacket throw on any candidate whose fix contained
     * a date or a phone number. That is most of them. The wall was correct;
     * it was being fed an incomplete list of what the app had measured.
     *
     * The headline was seeded here too, and that was a hole: five checks'
     * headlines are model output, so any number the model wrote allowlisted
     * itself and the wall could never catch it. A headline restating a real
     * figure is covered by the detail and fix that carry the same figure; a
     * headline inventing one now throws, which is the wall doing its job.
     * Found by the adversarial pass on the brand-voice commit.
     */
    const own = [f.detail, f.fix?.summary ?? '', f.fix?.snippet ?? ''].join(' ');
    for (const m of own.matchAll(/\b\d[\d,.]*\b/g)) numbers.add(m[0]);
    if (f.unverifiedNote) for (const m of f.unverifiedNote.matchAll(/\b\d[\d,.]*\b/g)) numbers.add(m[0]);
    if (f.divergenceNote) for (const m of f.divergenceNote.matchAll(/\b\d[\d,.]*\b/g)) numbers.add(m[0]);
    const s: Score | undefined = f.score;
    if (s) {
      numbers.add(String(s.raw));
      numbers.add(String(s.base));
      numbers.add(String(s.rescaled));
      for (const item of s.items) {
        numbers.add(String(item.earned));
        numbers.add(String(item.possible));
      }
    }
    for (const e of f.evidence) {
      numbers.add(String(e.byteLength));
      if (e.httpStatus !== null) numbers.add(String(e.httpStatus));
      /**
       * The hash is a measured fact, exactly like the two figures above it.
       *
       * It was missing, and artifacts print the first characters of it so a
       * reader can confirm they are looking at the same bytes. A hex character
       * is a digit ten times in sixteen, so a short prefix comes out all
       * digits often enough that across a dozen captures it is better than
       * even odds, and the sweep then reads a real hash as an invented figure
       * and refuses the whole packet. That happened on a real run: two of
       * fourteen captures hashed to a prefix of pure digits.
       */
      if (e.sha256) {
        numbers.add(e.sha256);
        numbers.add(e.sha256.slice(0, EVIDENCE_HASH_CHARS));
        // The capture manifest prints a longer prefix, because it names files
        // and six hex characters collide sooner than is comfortable.
        numbers.add(e.sha256.slice(0, MANIFEST_HASH_CHARS));
      }
      /**
       * Digits inside the URL that was actually fetched.
       *
       * The capture manifest prints these URLs and is swept like everything
       * else, so a perfectly ordinary path such as `/sitemap-2024-07.xml` or
       * `/blog/2026/03/` would otherwise read as an invented figure and refuse
       * the whole packet. Same shape as the evidence-hash problem above: a
       * measured fact tripping the wall that exists to catch made-up ones.
       */
      for (const m of e.url.matchAll(/\b\d[\d,.]*\b/g)) numbers.add(m[0]);
    }
  }
  return { numbers: [...numbers] };
}

/** A renderer turns confirmed findings into one artifact's text. */
export type Renderer = (ctx: {
  candidate: Candidate;
  findings: FlawFinding[];
  score: Score | null;
  date: string;
  operator: GenerateRequest['operator'];
  /** Null when the operator set no brand; renderers then emit no brand markup. */
  brand?: BrandContext | null;
}) => { kind: ArtifactKind; ext: string; text: string };

/**
 * Turns one rendered HTML document into PDF bytes.
 *
 * Injected rather than imported, because printing is Electron and this module
 * is deliberately plain Node so its two walls can be tested without booting a
 * browser. When it is absent the HTML is written as-is, which is what the
 * packet tests exercise.
 */
export type HtmlToPdf = (html: string) => Promise<Buffer>;

export async function generatePacket(
  req: GenerateRequest,
  renderers: Renderer[],
  opts: { htmlToPdf?: HtmlToPdf } = {}
): Promise<GenerateResult> {
  // WALL 1. Same function the approval gate calls, so the two cannot disagree.
  const verdict = releasable(req.findings, req.confirmedAt);
  if (!verdict.ok) throw new NotReleasableError(verdict.reason);

  // The operator's closing ask is verbatim prose bound for a client document,
  // so it passes a stricter wall than the rendered sweep; see sweepAsk. The
  // house pitch is reviewed source, not operator input, and takes its own path.
  if (req.operator.askMode === 'custom') {
    const askViolations = sweepAsk(req.operator.ask ?? '');
    if (askViolations.length) throw new GuardrailError('Scorecard closing ask', askViolations);
  }

  /**
   * Read the approval ledger before anything is written.
   *
   * This function ends by recording every artifact as prepared, and loadQueue
   * throws on an unreadable or malformed ledger on purpose. Finding that out
   * after the files are on disk would leave a finished, branded packet in a
   * client folder that the approval gate has never heard of, which is the one
   * state the gate exists to make impossible. Fail here, with nothing written,
   * for the same reason the guardrail sweep runs before the first file.
   */
  loadQueue(req.outputRoot);

  const date = isoDate();
  const slug = businessSlug(req.candidate, req.contactName ?? null);
  const paths = packetPaths(req.outputRoot, slug, date);
  const score = req.findings.find((f) => f.score)?.score ?? null;
  const allowed = allowedFactsFrom(req.findings);

  // Render everything and sweep everything BEFORE writing anything, so a
  // violation in the fourth artifact cannot leave the first three on disk.
  const rendered = renderers.map((r) =>
    r({
      candidate: req.candidate,
      findings: req.findings,
      score,
      date,
      operator: req.operator,
      brand: req.brand ?? null,
    })
  );

  for (const a of rendered) {
    // WALL 2. Markup is exempt from the prose sweep; its text content is not.
    const proseOnly = a.ext === 'html' ? stripMarkup(a.text) : a.text;
    assertClean(a.kind, proseOnly, allowed);
  }

  /**
   * The index was written unswept.
   *
   * 00-INDEX.md prints EVERY finding's headline and fix text, including
   * findings the scorecard leaves out (it renders only status 'flaw'). Those
   * headlines are model-written. So the one artifact that reproduced all of
   * them was the one artifact that never passed Law 2, and the header above
   * claiming "every string that will reach a prospect passes the copy
   * guardrails" was not true of it.
   *
   * Swept here as prose rather than as the whole rendered file: the file also
   * carries generated filenames and an ISO timestamp, whose digits are neither
   * years nor structural and would fail the unsourced-number rule for reasons
   * that have nothing to do with fabricated copy.
   */
  const indexProse = req.findings
    .flatMap((f) => [f.headline, f.fix?.summary ?? '', f.unverifiedNote ?? '', f.divergenceNote ?? ''])
    .filter(Boolean)
    .join('\n');
  assertClean('00-INDEX', indexProse, allowed);

  // WALL 2 again, for the one document that used to be written after it. The
  // manifest reaches the prospect inside the client folder, so it passes the
  // same sweep before a byte of the packet is written.
  const manifest = renderCaptureManifest(req.findings);
  assertClean('01-evidence/00-CAPTURES', manifest.sweepText, allowed);

  fs.mkdirSync(paths.drafts, { recursive: true });
  fs.mkdirSync(paths.evidence, { recursive: true });


  /**
   * HTML becomes PDF when a printer is available, and the .html is not kept.
   *
   * A loose .html file is a rendering target, not a deliverable: it opens
   * differently in every browser and is trivially editable after approval,
   * which matters because the approval gate hashes the bytes it approved.
   * Writing both would leave two documents making the same claims with only
   * one of them under the gate.
   *
   * If the PDF render fails the whole generation fails. Silently falling back
   * to HTML would hand over a different artifact than the one that was asked
   * for, and the operator would find out when a prospect opened it.
   */
  // Render EVERY artifact to bytes before writing ANY of them. htmlToPdf runs
  // here, and if it threw partway through a write-as-you-go loop it would leave
  // orphaned drafts on disk from the artifacts already written, contradicting
  // the promise above that a refusal leaves nothing behind. Pre-rendering keeps
  // the first disk write from happening until all of them are known to succeed.
  const prepared = [];
  for (const a of rendered) {
    const asPdf = a.ext === 'html' && opts.htmlToPdf;
    const body: Buffer = asPdf
      ? await (opts.htmlToPdf as HtmlToPdf)(a.text)
      : Buffer.from(a.text, 'utf8');
    const filename = artifactFilename(req.candidate.name, a.kind, date, asPdf ? 'pdf' : a.ext);
    prepared.push({ kind: a.kind, filename, absolutePath: path.join(paths.drafts, filename), body });
  }

  const artifacts: GeneratedArtifact[] = [];
  for (const p of prepared) {
    fs.writeFileSync(p.absolutePath, p.body);
    artifacts.push({
      kind: p.kind,
      filename: p.filename,
      absolutePath: p.absolutePath,
      bytes: p.body.length,
      freeTier: FREE_TIER.includes(p.kind),
    });
  }

  fs.writeFileSync(paths.index, renderIndex(req, slug, date, artifacts, score), 'utf8');

  fs.writeFileSync(path.join(paths.evidence, '00-CAPTURES.md'), manifest.text, 'utf8');
  for (const c of manifest.files) {
    // Best effort per file: a capture that will not copy is a missing receipt,
    // not a reason to throw away a packet that is otherwise correct and has
    // already passed every wall.
    try {
      fs.copyFileSync(c.from, path.join(paths.evidence, c.name));
    } catch {
      /* the manifest still records the hash and the byte count */
    }
  }

  /**
   * PREPARED, and not one step further.
   *
   * Called from inside generation rather than left to the caller on purpose.
   * The gate is only load-bearing if EVERY generated artifact is in the ledger,
   * and a rule that depends on each future call site remembering to opt in is
   * not a rule. Nothing here approves anything: prepare() records state
   * 'prepared', and it refuses to downgrade an artifact the operator has
   * already ruled on, so regenerating a packet cannot reset a decision.
   */
  const queue = prepare(req.outputRoot, slug, date, artifacts, req.candidate.name);

  return { slug, date, draftsDir: paths.drafts, artifacts, queue };
}

/**
 * Copy the captures this packet cites into the packet, with a manifest.
 *
 * `01-evidence/` has been in the folder layout since the first packet and
 * nothing ever wrote to it. 00-INDEX describes it as "raw captures, crawler and
 * operator, hashed" and lists a sha256 under every finding, so somebody opening
 * the packet to check a claim found an empty directory and no route from a hash
 * to the bytes it names. The captures themselves were in a single global cache
 * keyed by scan, which is not something a client folder can be handed over
 * with.
 *
 * Copies, so the packet is self-contained and survives the cache being cleared.
 * Never throws: evidence is the receipt for the artifacts, and a missing receipt
 * is not a reason to throw away a generated packet that is otherwise correct.
 */
/**
 * Third-party text, made inert inside a markdown table cell.
 *
 * A capture URL comes off the scanned site, so on a hostile or merely
 * compromised target it is attacker-controlled text landing in a document the
 * prospect trusts because the operator handed it to them. Wrapped in a code
 * span, a payload like `https://evil.test/x) [Reset your password](https://…`
 * renders as characters rather than as a link. A backtick would close the span
 * and a pipe would forge a new column, so those two are the ones that go.
 */
function inertCell(s: string): string {
  return '`' + s.replace(/`/g, "'").replace(/\|/g, '%7C') + '`';
}

/** Hex, or it does not get to name a file. */
function safeHashPrefix(sha256: string): string | null {
  return /^[0-9a-f]{16,}$/i.test(sha256) ? sha256.slice(0, MANIFEST_HASH_CHARS) : null;
}

type CaptureFile = { from: string; name: string };

/**
 * The captures this packet cites, as a manifest plus the files to copy.
 *
 * PURE, and separate from the writing, so the manifest can go through the same
 * guardrail sweep as every other document before anything reaches disk. The
 * first version wrote it after the sweep had already run, which is exactly the
 * defect the 00-INDEX comment above records being fixed once before: the one
 * document nobody swept was the one reproducing everything.
 *
 * `01-evidence/` has been in the folder layout since the first packet with
 * nothing ever written to it, while 00-INDEX described it as "raw captures,
 * crawler and operator, hashed" and cited a sha256 under every finding. The
 * copies are what make a client folder portable: checkable by somebody who has
 * neither this app nor its cache.
 */
export function renderCaptureManifest(findings: FlawFinding[]): {
  text: string;
  /**
   * The rows only, for the sweep.
   *
   * Same reasoning as `indexProse` above: the fixed preamble is a constant in
   * this file, reviewed like any other source and incapable of carrying
   * third-party text, and it mentions `00-INDEX.md` and `00-CAPTURES.md`,
   * whose `00` is structural rather than a claim. Sweeping the scaffolding
   * fails the packet for a filename. The rows are where the untrusted text is.
   */
  sweepText: string;
  files: CaptureFile[];
} {
  const rows: string[] = [];
  const files: CaptureFile[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    for (const e of f.evidence ?? []) {
      if (seen.has(e.sha256)) continue;
      seen.add(e.sha256);

      const short = safeHashPrefix(e.sha256);
      // Named by hash first: two captures of the same URL, one from the crawler
      // and one from the operator's browser, are different bytes and telling
      // them apart is the whole point. `source` is a two-value union in the
      // type and is pinned to one here anyway, so neither half of the name can
      // carry a separator no matter what reaches this function.
      const src = e.source === 'operator-browser' ? 'operator-browser' : 'crawler';
      const ext = /html/i.test(e.contentType ?? '') ? 'html' : 'txt';
      const name = short ? `${short}__${src}.${ext}` : null;

      const kept = Boolean(name && e.storedPath && fs.existsSync(e.storedPath));
      if (kept && name) files.push({ from: e.storedPath, name });

      rows.push(
        `| ${kept && name ? inertCell(name) : '_not kept_'} | ${inertCell(e.url)} | ${src} | ` +
          `${e.httpStatus} | ${e.byteLength} | ${inertCell(short ?? 'unhashed')} |`
      );
    }
  }

  const text = [
    '# Captures behind this packet',
    '',
    'Every claim in `00-INDEX.md` and in the scorecard cites one of these by the',
    'first characters of its sha256. The files here are copies, so this folder',
    'stays readable after the scan cache is cleared.',
    '',
    'URLs are shown as code rather than as links. They came off the scanned site',
    'and this document does not make third-party text clickable.',
    '',
    '`_not kept_` means the fetch succeeded and writing it to disk did not. The',
    'finding still stands on the hash and the byte count recorded at fetch time;',
    'the bytes themselves are simply not here to re-read.',
    '',
    '| File | URL | Source | Status | Bytes | sha256 |',
    '|---|---|---|---|---|---|',
    ...(rows.length ? rows : ['| _none_ | | | | | |']),
    '',
  ].join('\n');

  return { text, sweepText: rows.join('\n'), files };
}

/** Text content of an HTML document, so the prose sweep does not trip on tags. */
function stripMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The per-prospect ledger. Written every generation, overwriting the last. */
function renderIndex(
  req: GenerateRequest,
  slug: string,
  date: string,
  artifacts: GeneratedArtifact[],
  score: Score | null
): string {
  const lines: string[] = [];
  // Places controls the business name and this file is Markdown, so a name like
  // "[x](http://evil)" would inject a live link into the operator's own index.
  // The delivered scorecard/PDF path escapes everything; this internal index did
  // not sweep the name. Neutralise the characters that carry Markdown or HTML
  // meaning before printing the heading.
  const safeName = req.candidate.name.replace(/[\\`*_[\]()<>#]/g, ' ').replace(/\s+/g, ' ').trim();
  lines.push(`# ${safeName || 'Prospect'}`);
  lines.push('');
  lines.push(`Folder: \`${slug}\` · Packet generated ${date}`);
  lines.push('');
  lines.push('## Status');
  lines.push('');
  lines.push(`- Confirmed against the operator's own view-source: ${req.confirmedAt}`);
  lines.push('- Confirmations expire 72 hours after that timestamp. Past it, re-paste before sending.');
  lines.push('- Nothing in `02-drafts` has been approved. Approval is per item, in the app.');
  lines.push('');

  if (score) {
    lines.push('## Score');
    lines.push('');
    // scoreSentence, not a second copy of it. This line drifted from the one
    // in instrument.ts the moment partial exclusions existed: the index would
    // have printed "nothing marked out" beside a base of 100.
    lines.push(scoreSentence(score));
    lines.push('');
    lines.push('| Check | Weight | Earned | Note |');
    lines.push('|---|---|---|---|');
    for (const i of score.items) {
      lines.push(`| ${i.label} | ${i.possible} | ${i.na ? 'N/A' : i.earned} | ${i.note} |`);
    }
    lines.push('');
  }

  lines.push('## Findings');
  lines.push('');
  for (const f of req.findings) {
    lines.push(`- **${f.checkId}** (${f.status}, severity ${f.severity}, ${f.confirmation}): ${f.headline}`);
    if (f.fix) lines.push(`  - Fix (${f.fix.effort}): ${f.fix.summary}`);
    for (const e of f.evidence) {
      lines.push(`  - Evidence: ${e.source} · HTTP ${e.httpStatus} · ${e.byteLength} bytes · sha256 ${e.sha256.slice(0, 12)}`);
    }
  }
  lines.push('');

  lines.push('## Artifacts');
  lines.push('');
  lines.push('| File | Free tier |');
  lines.push('|---|---|');
  for (const a of artifacts) lines.push(`| \`${a.filename}\` | ${a.freeTier ? 'yes' : 'delivery vehicle'} |`);
  lines.push('');
  lines.push(
    '**The free tier is exactly three artifacts: the scan, the scorecard, and the schema starter kit.** ' +
      'After those are delivered, the next artifact for this prospect is paid. The generosity is the pitch; ' +
      'a fourth free artifact turns it into free consulting.'
  );
  lines.push('');
  lines.push('## Folder layout');
  lines.push('');
  lines.push('```');
  lines.push('01-evidence/   raw captures, crawler and operator, hashed');
  lines.push('02-drafts/     generated, not approved');
  lines.push('03-approved/   reserved, not created yet; approval is ledger-only today');
  lines.push('04-sent/       reserved for a future sender; nothing writes here yet');
  lines.push('99-rejected/   reserved; a rejection and its reason live in approvals.json');
  lines.push('```');
  return lines.join('\n') + '\n';
}

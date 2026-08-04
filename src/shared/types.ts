/**
 * Every type that crosses the main <-> renderer boundary lives here.
 * Imported by main process TS and mirrored by hand in the renderer JS (no bundler),
 * so keep it plain: no classes, no enums, no runtime values except const objects.
 */

// ---------------------------------------------------------------------------
// Result envelope. Main-process handlers never throw across IPC; they return this.
// ---------------------------------------------------------------------------

export type Ok<T> = { ok: true; data: T };
export type Err = {
  ok: false;
  error: {
    kind: ErrorKind;
    message: string;      // safe to show the user
    detail?: string;      // technical, for the log pane
    status?: number;
  };
};
export type Result<T> = Ok<T> | Err;

export type ErrorKind =
  | 'config'         // a key is missing or malformed
  | 'auth'           // key rejected, or CLI not logged in
  | 'quota'          // rate limited / billing
  | 'not_enabled'    // API not enabled on the project
  | 'transport'      // network, DNS, timeout
  | 'bad_request'    // we sent something wrong
  | 'not_found'
  | 'internal';

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function err(
  kind: ErrorKind,
  message: string,
  extra?: { detail?: string; status?: number }
): Err {
  return { ok: false, error: { kind, message, ...extra } };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type Candidate = {
  placeId: string;
  name: string;
  address: string;
  location: { lat: number; lng: number } | null;
  website: string | null;
  phone: string | null;
  rating: number | null;
  reviewCount: number | null;
  businessStatus: string | null;
  primaryType: string | null;
  mapsUri: string | null;
  discoveredAt: string;              // ISO 8601
  source: 'google-places-new';
};

export type SearchPlacesRequest = {
  city: string;
  category: string;
  limit?: number;                    // default 10, clamped 1..20 per page
  pageToken?: string;
};

export type SearchPlacesResponse = {
  candidates: Candidate[];
  nextPageToken: string | null;
  /** Short, per-scan counts. Belongs in the results band. */
  quotaNote: string;
  /**
   * The static billing attribution for the field mask. Changes only when the
   * mask changes, so it is said once in the footer rather than re-rendered as
   * a headline on every scan.
   */
  quotaDetail: string;
  /** Echoed so the ledger and the UI agree on what was asked. */
  query: { textQuery: string; city: string; category: string };
};

// ---------------------------------------------------------------------------
// Evidence  (Phase 2, declared now so checks compile against a stable shape)
// ---------------------------------------------------------------------------

/**
 * Who fetched these bytes.
 *
 * These are not interchangeable and the difference is the whole problem. What
 * a server returns to this app's crawler is frequently NOT what the operator
 * sees in Ctrl+U: bot challenges, user-agent sniffing, consent walls, CDN
 * variance and geo routing all diverge. Since the entire pitch rests on the
 * prospect reproducing every claim themselves, a claim the crawler saw and the
 * browser does not is worse than no claim at all.
 */
export type EvidenceSource =
  /** This app's own fetch. Approximates what an AI crawler receives. */
  | 'crawler'
  /** Raw view-source the operator pasted in. Admissible per the house law. */
  | 'operator-browser';

/**
 * The house law: "Mark remote findings REMOTE until the operator's own
 * browser confirms them." This is that rule as a type. The approval gate refuses to
 * release any packet citing a finding that is not 'operator-confirmed', which
 * makes confirmation a wall rather than a habit.
 */
export type ConfirmationState =
  /** Crawler only. Real, logged, and not allowed out of the app. */
  | 'remote'
  /** The operator's own view-source reproduces the finding. Safe to send. */
  | 'operator-confirmed'
  /**
   * The operator's source contradicts the crawl. The finding is void as a
   * claim. Worth keeping, because a site that answers crawlers differently
   * than browsers is itself a real and consequential finding.
   */
  | 'diverged';

export type EvidenceRef = {
  id: string;
  /** Final URL, after every redirect hop. */
  url: string;
  /**
   * The URL we ASKED for, before redirects. Kept because `url` alone cannot
   * answer "does this document exist".
   *
   * A very common CMS behaviour is the soft 404: a request for a document that
   * is not there returns HTTP 200 and the homepage instead of a 404. Every
   * document-presence test in this app was `httpStatus === 200 && body !== ''`,
   * which a soft 404 passes. That is how a site with NO llms.txt was scored
   * "Real file, 240 URLs" and awarded 10 of 15 points, on a client document:
   * the homepage HTML was parsed as an llms.txt and its links counted.
   *
   * Comparing this against `url` makes the difference deterministic and free.
   */
  requestedUrl: string;
  source: EvidenceSource;
  method: 'GET';
  httpStatus: number | null;         // null = never got a response
  contentType: string | null;
  fetchedAt: string;                 // ISO 8601
  sha256: string;
  byteLength: number;
  storedPath: string;
  redirectChain?: string[];
  transportError?: string;
  /**
   * The response arrived intact and writing it to disk failed: an AV lock, a
   * full disk, a path too long. The bytes are real; the receipt is not.
   *
   * Kept separate from transportError for exactly the reason `truncated` below
   * is, and it was folded into transportError in the same way. Two failures
   * came out of that. The website check reads any transportError as "the
   * listed website did not load", so a healthy HTTP 200 page was reported to
   * its owner as unreachable because OUR disk was busy. And because the ref
   * still carried httpStatus 200 and a full body, every other homepage gate
   * judged it and produced findings cited against a capture with no file
   * behind it, contradicting the promise in fetch-raw.ts that a finding never
   * outlives its receipt.
   *
   * A check may not draw a verdict from a capture it cannot produce.
   */
  storeError?: string;
  /**
   * The response was longer than maxBytes and this capture is a PREFIX of it.
   *
   * Kept separate from transportError, which it used to be folded into. That
   * conflation made the website check report a perfectly healthy HTTP 200 page
   * as "the listed website did not load", and it let every other check make
   * absence claims ("no tel: link appears anywhere on the page") about bytes it
   * never received. A partial read is not a failure and it is not a whole page;
   * it is its own thing, and no absence may be asserted from it.
   */
  truncated?: boolean;
  /**
   * A small allowlist of response headers, lowercased. Deliberately not every
   * header: `x-robots-tag` can carry a noindex that appears nowhere in the
   * HTML, which is the most invisible version of that failure and impossible
   * to find by reading the page. `last-modified` and `server` feed staleness
   * and the "small catches" section of the starter kit.
   */
  headers?: Record<string, string>;
};

/** Response headers worth keeping. Everything else is noise or gratuitous. */
export const CAPTURED_HEADERS = [
  'x-robots-tag',
  'content-type',
  'last-modified',
  'server',
  'x-powered-by',
  'cf-mitigated',
] as const;

// ---------------------------------------------------------------------------
// Checks + scoring  (Phase 2-3)
// ---------------------------------------------------------------------------

export type FlawId =
  | 'website'
  | 'freshness'
  | 'ai-readiness'
  | 'crawl-index'
  | 'booking-path'
  | 'nap-consistency';

export type CheckStatus =
  | 'ok'
  | 'flaw'
  | 'unverified'
  | 'error'
  /**
   * Not a prospect for this pipeline, and never ranked.
   *
   * The test is not "is this business bad", it is "do we have a fix to hand
   * them". The offer is always: here are your issues, here are the fixes, and
   * if you like what you got we can talk about more later. A business with no
   * website has nothing to scan, nothing to put in the PDF and nothing to put
   * in the schema starter, so there is no free tier to deliver and the pitch
   * would collapse into "buy a website from me". That is a different business
   * and not this one.
   */
  | 'disqualified';

/**
 * Hook quality, NOT technical severity. This ladder decides who gets contacted,
 * so it ranks by how good a finding is to open a conversation with:
 * invisible to the owner, provable by them in one keystroke, and consequential.
 *
 * A site that looks perfect in the owner's browser and renders as an empty
 * page to a crawler outranks a site that is visibly down, because the owner
 * already knows about the second one. 0 = clean, 4 = best hook.
 * Ranking uses the max across checks, never a sum.
 */
export type Severity = 0 | 1 | 2 | 3 | 4;

/**
 * Every flaw ships with its fix. The free tier is scan + PDF + schema starter,
 * and the starter is copy-paste fixes built from the prospect's own source, so
 * a finding without a fix is half a deliverable.
 */
export type FlawFix = {
  /** What to do, in plain language, aimed at the owner rather than a developer. */
  summary: string;
  /** True scope. Never undersell the work to make the pitch easier. */
  effort: 'minutes' | 'an afternoon' | 'needs a developer';
  /** Copy-paste ready and built from THEIR live source. Absent when the fix is not a snippet. */
  snippet?: string;
};

export type ScoreItem = {
  id: string;
  label: string;
  earned: number;
  /**
   * The weight this item was actually scored out of. Usually its full weight,
   * but reduced when part of the item could not be measured, so the rubric
   * table a client uses to recompute the number still adds up.
   */
  possible: number;
  na: boolean;
  note: string;
  /** Which shape of the finding this is. Selects the owner-facing copy. */
  variant?: string;
};

/**
 * Note every field is required. A score cannot be constructed, passed, or
 * rendered without its instrument and its base, that is Law 4, enforced by
 * the type rather than by review.
 */
export type Score = {
  instrument: 'aeo-baseline-six-check';
  instrumentVersion: string;
  raw: number;
  /** 105 full; 90 with product-review N/A; less 5 again when vocabulary could not be tested. */
  base: 105 | 100 | 90 | 85;
  rescaled: number;
  naItems: string[];
  /**
   * Items that had part of their weight marked out as unmeasurable, labelled
   * with the points removed. Required, not optional: a base the reader cannot
   * reconstruct is the same defect as a score with no instrument beside it.
   */
  markedOut: string[];
  items: ScoreItem[];
};

export type FlawFinding = {
  checkId: FlawId;
  status: CheckStatus;
  severity: Severity;
  headline: string;
  detail: string;
  evidence: EvidenceRef[];
  /**
   * The candidate this finding is about, exactly as Places returned the name.
   * Stamped once by runChecks so a finding never travels without saying whose
   * evidence it is.
   *
   * The approval gate reads it: a packet row records its candidate, and a
   * finding stamped for a DIFFERENT business is refused there rather than
   * minting a token against another prospect's artifact. releasable() only
   * checks a finding is confirmed and unexpired, not that it belongs to the
   * thing being approved, so without this the two could not be tied together.
   *
   * Optional because a finding deserialized from an older session predates the
   * field. A missing stamp cannot be proven foreign, so the gate lets it pass
   * rather than break an in-flight approval; a present, mismatched stamp is the
   * refusal.
   */
  candidateName?: string;
  /**
   * Starts at 'remote' for every machine-produced finding and only moves once
   * the operator pastes their own view-source and the signals still hold.
   */
  confirmation: ConfirmationState;
  /** Set when confirmation is 'diverged': what the crawl saw versus what the browser saw. */
  divergenceNote?: string;
  /** Required whenever status is 'flaw'. A problem we cannot fix is not a pitch. */
  fix?: FlawFix;
  score?: Score;
  unverifiedNote?: string;
  /**
   * Same-origin pages BEYOND the homepage that the crawler read and scored, as
   * full URLs. Set only by the ai-readiness check. The confirmation UI offers a
   * paste slot for each, so a multi-page site's site-wide score can be
   * reproduced from the operator's own source; a page the score rests on that
   * was not pasted keeps the finding unconfirmed rather than letting it diverge.
   */
  extraPages?: string[];
  /**
   * Which verdict shape of the check this finding is, e.g. 'no-sitemap' versus
   * 'noindex'. Same job as ScoreItem.variant: it selects the owner-facing hook
   * copy, so a postcard about a missing sitemap cannot print the noindex
   * sentence. Severity cannot do this work because several checks score two
   * different shapes at the same rung. Optional because a finding deserialized
   * from an older session predates the field; the hooks fall back to a
   * sentence true of any flaw rather than guessing a shape.
   */
  variant?: string;
};

export type RunCheckRequest = {
  candidate: Candidate;
  /** Groups this run's captures on disk. Generated by the renderer per scan. */
  scanId: string;
  /** Omit to run every registered check. */
  only?: FlawId[];
};

export type RunCheckResponse = {
  candidate: Candidate;
  scanId: string;
  findings: FlawFinding[];
  /** Highest severity across findings. Ranking uses this, never a sum. */
  worstSeverity: Severity;
  /** True when any check disqualified this business. Disqualified is never ranked. */
  disqualified: boolean;
  /** Wall clock for the whole candidate. */
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Confirmation gate (Phase 4)
// ---------------------------------------------------------------------------

/**
 * `page` is any same-origin page beyond the four named documents. A multi-page
 * site's site-wide items (entity schema, FAQ) are scored across pages the
 * crawler discovered, and the operator pastes those pages under this kind so
 * the reconciling pass can reproduce the score from their own source.
 */
export type PasteKind = 'homepage' | 'robots' | 'llms' | 'sitemap' | 'page';

export type OperatorPasteInput = {
  kind: PasteKind;
  url: string;
  content: string;
};

export type ConfirmRequest = {
  candidate: Candidate;
  scanId: string;
  /** The crawler-derived findings this confirmation is reconciling against. */
  crawlerFindings: FlawFinding[];
  pastes: OperatorPasteInput[];
};

export type DivergenceView = {
  checkId: FlawId;
  crawler: { status: string; severity: number; headline: string };
  operator: { status: string; severity: number; headline: string };
};

export type ConfirmResponse = {
  findings: FlawFinding[];
  divergences: DivergenceView[];
  confirmedAt: string;
  missingPastes: PasteKind[];
  /** Which pastes looked like an escaped view-source wrapper rather than source. */
  suspectPastes: PasteKind[];
  /** Whether this packet could be released right now, and why not. */
  release: { ok: boolean; reason?: string };
};

export type PolicyVerdict = {
  blocked: boolean;
  blockReason?: string;
  pacingWarning?: string;
};

export type AgentStatus = {
  id: string;
  label: string;
  available: boolean;
  detail: string;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type AgentMode = 'auto' | 'cli' | 'sdk-apikey' | 'sdk-subscription';

export type AppConfig = {
  version: 1;
  keys: {
    googlePlaces: string | null;
    anthropic: string | null;
    lob: string | null;
    postgrid: string | null;
  };
  agent: {
    mode: AgentMode;
  };
  defaults: {
    city: string;
    category: string;
    limit: number;
  };
  /**
   * Who the packet says it is from. Printed in every artifact footer.
   *
   * Not a secret, so it lives in config next to the defaults rather than in
   * the key store. It is required to generate: an artifact that reaches a
   * prospect has to say who sent it and how to reply, and a footer reading
   * "undefined" is worse than a refusal.
   */
  operator: {
    name: string;
    email: string;
    /** Where the prospect can re-run the scan themselves. May be empty. */
    scannerUrl: string;
    /**
     * Which closing ask the scorecard prints: the house pitch ('default') or
     * the operator's own words ('custom'). Default preserves what every
     * packet has always printed.
     */
    askMode: 'default' | 'custom';
    /**
     * The operator's own closing ask, printed verbatim (escaped) at the end
     * of the scorecard's owner page above the signature when askMode is
     * 'custom'. Blank in custom mode means the document closes with the
     * signature alone; nothing stock is substituted. Held to a stricter wall
     * than the document sweep (guardrails.ts sweepAsk): no digits at all and
     * no invisible characters, because verbatim operator prose is the one
     * channel where a fabricated figure would print under the operator's own
     * signature. May be empty.
     */
    ask: string;
    /**
     * The operator's voice instructions for the model that rewords findings
     * into owner-facing sentences. Tone and word choice only: it is fenced
     * below the mandatory rules at the one place the agent is invoked, so it
     * cannot change a severity, a number, a fact or a fix, and the headline
     * validator still runs on whatever comes back. May be empty.
     */
    brandVoice: string;
  };
  /**
   * The operator's visual brand on generated documents.
   *
   * `logo` is an extension MARKER, never a path: the file lives at
   * `<dataRoot>/brand/logo.<marker>` and is resolved there at generate time,
   * so a hand-edited config cannot point the renderer at an arbitrary file
   * and have its bytes embedded in a client document.
   */
  brand: {
    /** '' or a validated `#rrggbb`. Severity shading never takes it. */
    accent: string;
    logo: '' | 'png' | 'jpg';
  };
};

/** Config as the renderer sees it: presence flags, never the secret itself. */
export type ConfigStatus = {
  version: 1;
  keys: {
    googlePlaces: KeyStatus;
    anthropic: KeyStatus;
    lob: KeyStatus;
    postgrid: KeyStatus;
  };
  agent: { mode: AgentMode };
  defaults: AppConfig['defaults'];
  /** Not a secret, so unlike keys this is returned in full. */
  operator: AppConfig['operator'];
  /** Not a secret either: the accent and which logo kind is on file. */
  brand: AppConfig['brand'];
  configPath: string;
};

export type KeyStatus = {
  present: boolean;
  source: 'config' | 'env' | 'none';
  /** Last 4 characters only, for "is this the key I think it is". */
  hint: string | null;
};

export type SetKeyRequest = {
  key: keyof AppConfig['keys'];
  /** Empty string clears the stored value. */
  value: string;
};

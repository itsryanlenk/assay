/**
 * THE ONLY WAY TARGET-SITE BYTES ENTER THIS APPLICATION.
 *
 * Law 1 of this project: AI-summarized page content is never evidence, raw
 * source only. That law is enforced structurally rather than by convention,
 * and this file is where. Only fetchRaw() mints an EvidenceRef, so there is
 * no code path by which a model's description of a page can be cited as
 * evidence. Agents in this app are given no fetch tool, no browser and no
 * search; they only ever receive bytes that were already captured, hashed and
 * written to disk here.
 *
 * Two consequences worth stating plainly:
 *   - The body is persisted BEFORE this function returns. A finding always has
 *     a file behind it, even if the process dies immediately afterward.
 *   - The sha256 is of the exact bytes received, so a claim can be re-checked
 *     against the capture months later and a changed page cannot silently
 *     rewrite history.
 *
 * Law 5: discovery is the Places API plus the business's own site. Google Maps
 * HTML is refused here, not merely avoided by callers.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dns from 'node:dns/promises';
import { lookup as lookupCb, LookupAddress, LookupOptions } from 'node:dns';
// undici is also the engine behind the global fetch. Kept as a DIRECT dependency
// so this security-critical import is stable rather than transitive, and pinned
// to the same major Electron bundles, so this Agent and the fetch engine
// interoperate over the (duck-typed, stable) dispatch protocol.
import { Agent } from 'undici';
import { CAPTURED_HEADERS, EvidenceRef, EvidenceSource } from '../../shared/types';

/** Identifies the crawler by name and purpose. A tool that hides what it is has already lost the argument. */
export const USER_AGENT =
  'Assay/0.1 (local outreach research tool; one operator; contact via the site being scanned)';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2_500_000;
const MAX_REDIRECTS = 10;

export type FetchRawOptions = {
  scanId: string;
  /** Directory that holds per-scan capture folders. */
  evidenceRoot: string;
  timeoutMs?: number;
  maxBytes?: number;
};

export type RawCapture = {
  ref: EvidenceRef;
  /** Decoded body. Empty string when the fetch never produced one. */
  body: string;
  /** True when bytes were received and stored. */
  captured: boolean;
};

/**
 * Hosts and paths this tool refuses to read, with the reason.
 * Scraping Maps is both a terms violation and the thing that gets an outreach
 * tool banned before it ships a single postcard.
 */
const REFUSED = [
  { test: (u: URL) => u.hostname === 'maps.google.com', why: 'Google Maps HTML' },
  {
    test: (u: URL) => isPrivateHostLiteral(u.hostname),
    why: 'a private or loopback address',
  },
  {
    test: (u: URL) => /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && /^\/maps(\/|$)/i.test(u.pathname),
    why: 'Google Maps HTML',
  },
  {
    // Search on ANY Google TLD, not just www.google.com. The old rule was
    // www-and-.com only, so google.com/search (no www) and google.co.uk/search
    // (any ccTLD) sailed through, contradicting the README's claim that Search
    // hosts are refused.
    test: (u: URL) => /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && /^\/search(\/|$)/i.test(u.pathname),
    why: 'Google Search HTML',
  },
];

/**
 * SSRF guard.
 *
 * The URLs this function fetches are NOT ours. `websiteUri` comes from a Google
 * Places listing, which the business owner controls, and any site we reach can
 * redirect us somewhere else. Without this, a listing pointing at
 * `http://127.0.0.1:8080/` or `http://169.254.169.254/` would be fetched by the
 * app and the response written to disk as "evidence".
 *
 * Two layers, because either alone is insufficient:
 *   - literal check, which catches an address written directly in the URL
 *   - DNS resolution check, which catches a hostname that resolves inward
 *
 * The TOCTOU gap between our lookup and the socket's own IS closed, by the
 * pinned-lookup dispatcher below (makeSafeLookup/safeAgent): the address that
 * passed validation is the address the socket connects to. An earlier
 * revision of this comment recorded the gap as accepted; that trade-off was
 * reversed on 2026-08-02 and SECURITY.md now names the pinning as in scope.
 */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = 0, b = 0] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/**
 * Expands a possibly-compressed IPv6 literal to its eight 16-bit groups.
 *
 * Written out in full so the private-address check does not depend on how the
 * address happened to be spelled. The literal check used to match only the
 * DOTTED IPv4-mapped form (`::ffff:127.0.0.1`), but `new URL(...).hostname`
 * hands back the HEX form (`::ffff:7f00:1`), so every mapped-loopback literal
 * slipped past the literal layer and was caught only because dns.lookup
 * happened to re-canonicalise it. undici connects to a literal without a
 * lookup, so on any platform where that normalisation differs the socket
 * reached 127.0.0.1. Expanding here removes that dependency.
 */
function ipv6Groups(literal: string): number[] | null {
  let s = literal.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  // A trailing dotted IPv4 (::ffff:127.0.0.1) becomes its two hex groups first.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted) {
    const v4 = (dotted[2] ?? '').split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    s = `${dotted[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let parts: string[];
  if (tail === null) {
    parts = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (parts.length !== 8) return null;
  const nums = parts.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : nums;
}

function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    return s === '::1' || s === '::';
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  const asV4 = (hi: number, lo: number) =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  // Any address that embeds an IPv4 in its low 32 bits and re-checks it there:
  // ::/96 (loopback ::1, unspecified ::, and the deprecated IPv4-compatible
  // range), ::ffff:0:0/96 (IPv4-mapped, dotted or hex), and 64:ff9b::/96
  // (NAT64 well-known). A private v4 reached through any of these is refused.
  const lowEmbedsV4 =
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) ||
    (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0);
  if (lowEmbedsV4 && isPrivateIPv4(asV4(g6, g7))) return true;
  // 6to4 2002::/16 carries the v4 in the two groups after the prefix.
  if (g0 === 0x2002 && isPrivateIPv4(asV4(g1, g2))) return true;
  return false;
}

function isPrivateHostLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateIPv4(h);
  if (h.includes(':')) return isPrivateIPv6(h);
  return false;
}

/** Resolves the hostname and refuses if ANY answer points inward. */
async function resolvesPrivately(hostname: string): Promise<string | null> {
  if (isPrivateHostLiteral(hostname)) return hostname;
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    for (const { address, family } of addrs) {
      const priv = family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
      if (priv) return `${hostname} resolves to ${address}`;
    }
  } catch {
    // A name that will not resolve fails at fetch time with a clearer message.
    return null;
  }
  return null;
}

/**
 * The connect-time half of the guard, and the one that closes the TOCTOU.
 *
 * resolvesPrivately() checks a name BEFORE the fetch, but undici then does its
 * OWN resolution when it opens the socket, and a hostile DNS server can answer
 * public to our check and private to the socket in that gap (DNS rebinding).
 * This is the resolution undici actually connects with: it resolves once,
 * refuses if ANY answer is private, and hands back exactly the addresses it
 * validated, so the check and the connection can never disagree. Attached to a
 * dispatcher below, it turns a public hostname that resolves to 127.0.0.1 into
 * a refused connection rather than a fetched one.
 *
 * The resolver is injectable so the refusal can be exercised without a network.
 */
type AllResolver = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

export function makeSafeLookup(
  resolve: AllResolver = lookupCb as unknown as AllResolver
) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
  ): void => {
    const refuse = (why: string): void => {
      const refusal: NodeJS.ErrnoException = new Error(`refused: ${why}`);
      refusal.code = 'ESSRFREFUSED';
      callback(refusal, '', 0);
    };
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = Array.isArray(addresses) ? addresses : [addresses as unknown as LookupAddress];
      // A degenerate empty result is refused explicitly rather than crashing on
      // list[0] or handing undici an empty set.
      if (list.length === 0) return refuse(`${hostname} resolved to no addresses`);
      // Classify by the ADDRESS, never by the family label. A resolver that
      // mislabelled an IPv6 as family 4 would otherwise reach isPrivateIPv4,
      // which cannot parse it, and a private address would pass. Running both
      // checks means only a genuinely public address gets through.
      const bad = list.find((a) => isPrivateIPv4(a.address) || isPrivateIPv6(a.address));
      if (bad) return refuse(`${hostname} resolves to a private or reserved address (${bad.address})`);
      // undici asks with all:true; hand back the validated set. The single-form
      // branch is defensive, for any caller that does not.
      if (options.all) return callback(null, list);
      const first = list[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

/**
 * One dispatcher for every outbound fetch, so the pinned lookup above is what
 * opens the socket. Reusing it pools connections by origin, which is safe here:
 * a pooled socket is already connected to an address we validated, so a later
 * request over it cannot be rebound to somewhere private.
 */
const safeAgent = new Agent({ connect: { lookup: makeSafeLookup() as never } });

/**
 * Fail closed if the runtime does not route fetch through the dispatcher.
 *
 * The whole guard rests on `fetch(url, { dispatcher })` actually consulting the
 * connect-time lookup. That needs a runtime undici new enough to honour the
 * per-request dispatcher; on an older one the option is silently ignored, fetch
 * resolves with the default resolver, and the pinned lookup never runs. That is
 * the worst failure shape: a security control that no-ops with no signal while
 * the docs promise it holds.
 *
 * This drives the REAL fetch through a probe Agent whose lookup resolves to
 * loopback. If the dispatcher is honoured, our safe lookup refuses (private) and
 * the rejection says so. If it is ignored, fetch instead tries to resolve the
 * .invalid host and fails for an unrelated reason, which is exactly the no-op we
 * must catch. No network: the probe lookup provides the resolution. Call it at
 * startup and refuse to run target-site fetches if it does not hold.
 */
export async function assertEgressGuardWired(): Promise<void> {
  const probeLookup = makeSafeLookup((_h, _o, cb) =>
    cb(null, [{ address: '127.0.0.1', family: 4 }]));
  const probe = new Agent({ connect: { lookup: probeLookup as never } });
  let refusedForPrivate = false;
  try {
    const init: RequestInit & { dispatcher: Agent } = {
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
      dispatcher: probe,
    };
    await fetch('http://assay-egress-selftest.invalid/', init);
  } catch (e) {
    const msg = (e as Error & { cause?: { message?: string } }).cause?.message || (e as Error).message;
    refusedForPrivate = /private|reserved|refused/i.test(msg);
  } finally {
    await probe.close().catch(() => undefined);
  }
  if (!refusedForPrivate) {
    throw new Error(
      'Egress guard self-test failed: this runtime did not route fetch through the pinned-DNS ' +
        'dispatcher, so target-site fetches would skip the connect-time SSRF guard. Refusing to start.'
    );
  }
}

/**
 * Turns a URL into a readable filename fragment.
 *
 * Captures were originally named `<sha256>.<ext>`, which is correct for
 * integrity and useless for a human opening the folder. The hash still anchors
 * the file, but the name now says which site, which document, and critically
 * whether the bytes came from this app's crawler or the operator's own browser.
 * That distinction decides whether a finding may leave the app, so it should be
 * visible in Explorer without opening anything.
 *
 *   crawler__example-com__cart__754ed90e.html
 *   operator__example-com__homepage__a3f1c2b8.html
 *   crawler__example-com__robots-txt__c7fb220a.txt
 */
export function captureFilename(
  url: string,
  source: EvidenceSource,
  sha256: string,
  ext: string
): string {
  let host = 'unknown-host';
  let slug = 'homepage';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./i, '').replace(/[^a-z0-9.-]/gi, '').replace(/\./g, '-');
    const p = u.pathname.replace(/^\/+|\/+$/g, '');
    // Dots survive the first pass so the second can turn them into hyphens;
    // stripping them first gave "robotstxt" instead of "robots-txt".
    if (p) slug = p.replace(/[^a-z0-9/._-]/gi, '').replace(/[/_.]+/g, '-').slice(0, 48) || 'page';
  } catch {
    /* fall through to the defaults */
  }
  const who = source === 'operator-browser' ? 'operator' : 'crawler';
  return `${who}__${host}__${slug}__${sha256.slice(0, 8)}.${ext}`;
}

function extensionFor(contentType: string | null): string {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('html')) return 'html';
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('javascript')) return 'js';
  if (ct.includes('css')) return 'css';
  if (ct.includes('text/')) return 'txt';
  return 'bin';
}

/** Reads at most maxBytes from the body, so a hostile or huge response cannot exhaust memory. */
async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), truncated: false };

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = Buffer.from(value);
    if (total + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }

  return { bytes: Buffer.concat(chunks), truncated };
}

/**
 * Did the server actually give us the document we asked for?
 *
 * A soft 404 answers a request for a missing file with HTTP 200 and the
 * homepage. `httpStatus === 200 && body !== ''` cannot tell that apart from a
 * real document, which is how a site with no llms.txt scored 10 of 15 points
 * for having one, with "Real file, 240 URLs" printed on a client scorecard:
 * the check counted the hyperlinks in the homepage HTML it was handed.
 *
 * Two independent signals, because either alone has holes:
 *   - the final URL's path no longer matches what we requested, so we were
 *     redirected away from the document
 *   - we asked for a text document and were handed HTML
 */
export type DocumentStatus = 'present' | 'absent' | 'unknown';

/**
 * Three states, because two is what caused the bug.
 *
 *   present  the server gave us this exact document
 *   absent   the server answered and the document is not there (404, or a
 *            soft 404 that redirected us to a page instead)
 *   unknown  we never got an answer, so nothing may be concluded either way
 *
 * The absent/unknown split matters as much as the soft-404 detection. A
 * robots.txt that TIMED OUT used to read as "no robots.txt, so nothing is
 * blocked" and score a perfect 25 of 25, which is the opposite of the truth
 * for a site whose robots.txt says `Disallow: /`.
 */
export function documentStatus(ref: EvidenceRef): DocumentStatus {
  // A capture we could not store is a capture we cannot produce, so it answers
  // nothing about the document either way.
  if (ref.transportError || ref.storeError || ref.httpStatus === null) return 'unknown';
  // Any 4xx is a definitive answer that a crawler cannot have this document,
  // which is what the instrument is measuring. 5xx is the server failing, not
  // an answer about the document.
  if (ref.httpStatus >= 400 && ref.httpStatus < 500) return 'absent';
  if (ref.httpStatus !== 200) return 'unknown';
  return servedAsRequested(ref) ? 'present' : 'absent';
}

export function servedAsRequested(ref: EvidenceRef): boolean {
  if (ref.transportError || ref.storeError || ref.httpStatus !== 200) return false;

  const norm = (u: string): string | null => {
    try {
      return new URL(u).pathname.replace(/\/+$/, '').toLowerCase() || '/';
    } catch {
      return null;
    }
  };
  const want = norm(ref.requestedUrl);
  const got = norm(ref.url);

  /**
   * A redirect is only evidence of absence when it lands on the SITE ROOT.
   *
   * The first version of this refused any redirect that changed the path,
   * which is far too wide: `/sitemap.xml` redirecting to `/sitemap_index.xml`
   * is a real sitemap at a real address, and this function called it absent.
   * A live site with a perfectly good sitemap was then told, at severity 3 on
   * a client document, "There is no sitemap.xml and robots.txt declares none".
   * That is a worse false claim than the soft 404 this check exists to catch.
   *
   * The soft 404 pattern is specifically "we could not find that, here is the
   * homepage", so root is the signal. A redirect to another real path is a
   * redirect, and the content-type test below still catches being handed a web
   * page when a text document was asked for.
   */
  if (want !== null && got !== null && want !== got && (got === '/' || got === '')) return false;

  // Asked for a text document, handed a web page. The extension is ours, not
  // the server's guess, so this does not depend on content negotiation.
  if (/\.(txt|md|xml)$/i.test(want ?? '') && /text\/html/i.test(ref.contentType ?? '')) {
    return false;
  }

  return true;
}

function baseRef(url: string): EvidenceRef {
  return {
    id: randomUUID(),
    url,
    requestedUrl: url,
    // This app's own fetch. REMOTE until the operator's own view-source
    // confirms it; see ConfirmationState in shared/types.ts.
    source: 'crawler',
    method: 'GET',
    httpStatus: null,
    contentType: null,
    fetchedAt: new Date().toISOString(),
    sha256: '',
    byteLength: 0,
    storedPath: '',
  };
}

/**
 * Fetches a URL and persists the exact bytes before returning. Never throws;
 * a failure comes back as a ref carrying transportError, so a check can record
 * "could not verify" as its verdict instead of silently treating an outage as a flaw.
 */
export async function fetchRaw(rawUrl: string, opts: FetchRawOptions): Promise<RawCapture> {
  const ref = baseRef(rawUrl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    ref.transportError = 'not a valid URL';
    return { ref, body: '', captured: false };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    ref.transportError = `refusing a ${url.protocol} URL`;
    return { ref, body: '', captured: false };
  }

  const redirectChain: string[] = [];
  let current = url;
  let res: Response;

  try {
    for (let hop = 0; ; hop++) {
      // Re-assert the scheme on EVERY hop, not just the first. A redirect can
      // hand back a Location with any scheme, and while undici currently
      // refuses file:/gopher:/ftp: on its own, that is its behaviour rather
      // than our guarantee. Only http(s) leaves this loop toward a socket.
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        ref.transportError = `refused: a ${current.protocol} URL reached via redirect`;
        if (redirectChain.length) ref.redirectChain = redirectChain;
        return { ref, body: '', captured: false };
      }

      const refused = REFUSED.find((r) => r.test(current));
      if (refused) {
        // Reached via redirect or asked for directly, the answer is the same.
        ref.transportError = `refused: ${refused.why} is off limits by project law`;
        ref.redirectChain = redirectChain.length ? redirectChain : undefined;
        return { ref, body: '', captured: false };
      }

      // Every hop is re-checked. A public hostname that redirects to an
      // internal one is the whole point of the attack.
      const privateReason = await resolvesPrivately(current.hostname);
      if (privateReason) {
        ref.transportError = `refused: ${privateReason}, which is a private or loopback address`;
        if (redirectChain.length) ref.redirectChain = redirectChain;
        return { ref, body: '', captured: false };
      }

      if (hop > MAX_REDIRECTS) {
        ref.transportError = `more than ${MAX_REDIRECTS} redirects`;
        ref.redirectChain = redirectChain;
        return { ref, body: '', captured: false };
      }

      const init: RequestInit & { dispatcher: Agent } = {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
        // Every socket opens through the pinned-DNS dispatcher, so the address
        // resolvesPrivately() validated is the address the connection uses.
        dispatcher: safeAgent,
      };
      res = await fetch(current.toString(), init);

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        // Each hop is recorded. A site whose http:// bounces to a parked
        // domain is a finding, and the chain is the proof.
        const next = new URL(location, current);
        redirectChain.push(`${res.status} ${current.toString()} -> ${next.toString()}`);
        current = next;
        continue;
      }
      break;
    }
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    // fetch wraps a connect-time refusal as "fetch failed" and puts the real
    // reason on `cause`, which is where the pinned-DNS dispatcher's refusal
    // lands. Surface it so an SSRF refusal reads as one, not as a vague failure.
    const reason = err.cause?.message || err.message;
    ref.transportError =
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : `${err.name}: ${reason}`;
    if (redirectChain.length) ref.redirectChain = redirectChain;
    return { ref, body: '', captured: false };
  }

  ref.url = current.toString();
  ref.httpStatus = res.status;
  ref.contentType = res.headers.get('content-type');
  if (redirectChain.length) ref.redirectChain = redirectChain;

  const captured: Record<string, string> = {};
  for (const name of CAPTURED_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) captured[name] = value;
  }
  if (Object.keys(captured).length) ref.headers = captured;

  let bytes: Buffer;
  let truncated = false;
  try {
    const read = await readCapped(res, maxBytes);
    bytes = read.bytes;
    truncated = read.truncated;
  } catch (e) {
    ref.transportError = `body read failed: ${(e as Error).message}`;
    return { ref, body: '', captured: false };
  }

  ref.sha256 = createHash('sha256').update(bytes).digest('hex');
  ref.byteLength = bytes.length;
  // Truncation is recorded on its own field, NOT as a transport error. It used
  // to set transportError, and the website check reads any transportError as
  // "the site did not load", so a large but perfectly healthy page was reported
  // to its owner as unreachable. See EvidenceRef.truncated.
  if (truncated) ref.truncated = true;

  // Persist BEFORE returning. A finding must never outlive its receipt.
  const dir = path.join(opts.evidenceRoot, opts.scanId);
  const file = path.join(
    dir,
    captureFilename(ref.url, ref.source, ref.sha256, extensionFor(ref.contentType))
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, bytes);
    ref.storedPath = file;
  } catch (e) {
    // NOT transportError. The transport succeeded; our disk did not. See
    // EvidenceRef.storeError for the two false claims that conflation caused.
    ref.storeError = `could not store capture: ${(e as Error).message}`;
    return { ref, body: bytes.toString('utf8'), captured: false };
  }

  return { ref, body: bytes.toString('utf8'), captured: true };
}

/**
 * Test hook for the egress guard. Not part of the module's real surface; kept
 * here so the SSRF checks can be exercised directly rather than only through a
 * live socket. `refusedReason` runs a URL through the REFUSED host/path list.
 */
export const __ssrf = {
  isPrivateHostLiteral,
  makeSafeLookup,
  refusedReason(url: string): string | null {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    return REFUSED.find((r) => r.test(u))?.why ?? null;
  },
};

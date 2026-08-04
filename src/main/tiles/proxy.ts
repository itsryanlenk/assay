/**
 * The map tile proxy.
 *
 * The renderer makes no network requests: its CSP names no external origin
 * and connect-src is 'none'. When the operator opens the map, Leaflet asks
 * for tiles as tiles://osm/{z}/{x}/{y}.png, and those requests arrive HERE,
 * in main, where every other outbound request of this app already lives.
 * Each one is validated, fetched from the one pinned host with an
 * identifying User-Agent (the OSM tile policy refuses anonymous apps),
 * cached under the data root, and served back as bytes.
 *
 * Under --smoke the handler serves a generated stub tile and never touches
 * the network, so the gates run offline and a tile outage cannot fail a
 * build.
 *
 * The cache has no eviction. Tiles are ~15KB each, a session over one town
 * touches a few hundred, and the data-root README lists tiles/ as a cache
 * that is safe to delete.
 */

import { protocol, net } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TILE_SCHEME = 'tiles';
export const TILE_HOST = 'tile.openstreetmap.org';

/**
 * Identifies the app to the tile server, same principle as fetch-raw's UA:
 * a tool that hides what it is has already lost the argument.
 */
const TILE_UA = 'Assay/0.1 (local outreach scanner, single operator; https://github.com/itsryanlenk/assay)';

const MIN_ZOOM = 0;
const MAX_ZOOM = 19;

const PNG_HEADERS = { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' };

/** OSM tiles run ~10-60KB; anything past this is not a tile. */
const MAX_TILE_BYTES = 1024 * 1024;

/**
 * A 1x1 paper-grey PNG. Leaflet stretches it to tile size, which is exactly
 * what an offline gate needs: a request that resolves, draws, and proves the
 * whole path without a network.
 */
const STUB_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

export type TileCoords = { z: number; x: number; y: number };

/**
 * tiles://osm/{z}/{x}/{y}.png to validated integer coordinates, or null.
 *
 * The regex admits digits only, so a path traversal, a negative number, a
 * float, or an exponent never reaches the range checks, and x/y are bounded
 * by 2^z so a coordinate cannot name a tile the zoom level does not have.
 */
export function parseTileUrl(rawUrl: string): TileCoords | null {
  // Dot segments (".." and its percent-encodings) are canonicalized away by
  // the URL layer before this regex runs, both by Chromium (the scheme is
  // registered `standard`) and by the URL constructor here, so a
  // traversal-shaped request arrives as a plain tile path. Containment does
  // not rest on filtering the string: the only things that ever reach the
  // filesystem are three bounded integers, stringified.
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${TILE_SCHEME}:` || u.hostname !== 'osm') return null;
  const m = /^\/(\d{1,2})\/(\d{1,10})\/(\d{1,10})\.png$/.exec(u.pathname);
  if (!m) return null;
  const z = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (z < MIN_ZOOM || z > MAX_ZOOM) return null;
  const extent = 2 ** z;
  if (x >= extent || y >= extent) return null;
  return { z, x, y };
}

let loggedFirstFetch = false;

/** The handler body, factored out so the suite can drive it without a window. */
export async function handleTileRequest(
  rawUrl: string,
  opts: { cacheDir: string; stub: boolean }
): Promise<Response> {
  const coords = parseTileUrl(rawUrl);
  if (!coords) return new Response('refused', { status: 400 });

  if (opts.stub) return new Response(new Uint8Array(STUB_TILE), { status: 200, headers: PNG_HEADERS });

  const cachePath = path.join(
    opts.cacheDir,
    String(coords.z),
    String(coords.x),
    `${coords.y}.png`
  );
  try {
    const cached = await fs.promises.readFile(cachePath);
    return new Response(new Uint8Array(cached), { status: 200, headers: PNG_HEADERS });
  } catch {
    // Not cached yet; fall through to the one permitted fetch.
  }

  if (!loggedFirstFetch) {
    loggedFirstFetch = true;
    console.log(`[tiles] map opened; fetching street tiles from ${TILE_HOST}`);
  }

  // The same discipline as every other egress in this app: the host is
  // pinned, so a redirect off it is refused rather than followed; the wait
  // is bounded; and the body is read against a cap, the way fetch-raw's
  // readCapped does, so a hostile or broken response cannot exhaust memory.
  let res: globalThis.Response;
  try {
    res = await net.fetch(`https://${TILE_HOST}/${coords.z}/${coords.x}/${coords.y}.png`, {
      headers: { 'User-Agent': TILE_UA, Accept: 'image/png' },
      redirect: 'error',
      // Nothing in the default session should ever hold a cookie for this
      // host, and omitting them keeps SECURITY.md's account of what the tile
      // server learns (IP and coordinates) true regardless.
      credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return new Response('tile fetch failed', { status: 502 });
  }
  if (!res.ok || !res.body) {
    try {
      await res.body?.cancel();
    } catch {
      // Already closed; nothing owed.
    }
    return new Response('tile unavailable', { status: 502 });
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_TILE_BYTES) {
        await res.body.cancel();
        return new Response('tile too large', { status: 502 });
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    return new Response('tile read failed', { status: 502 });
  }
  const buf = Buffer.concat(chunks);

  // Written tmp-then-rename like every other file this app persists, so a
  // crash mid-write cannot leave a truncated tile served as a PNG forever.
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, cachePath);
  } catch {
    // A failed cache write costs a refetch, never a tile.
  }
  return new Response(new Uint8Array(buf), { status: 200, headers: PNG_HEADERS });
}

/**
 * Must run at module scope, before app ready, or Chromium refuses the
 * scheme. `standard` gives tiles:// real URL parsing (host and path).
 */
export function registerTileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: TILE_SCHEME, privileges: { standard: true } },
  ]);
}

/** Call once app is ready. */
export function installTileProtocol(opts: { cacheDir: string; stub: boolean }): void {
  protocol.handle(TILE_SCHEME, (req) => handleTileRequest(req.url, opts));
}

export const __test = { parseTileUrl, handleTileRequest };

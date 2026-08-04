/**
 * Config + secret storage.
 *
 * Secrets live in `<data root>/config.json`, never in the repo. That root is
 * `<install>/data` by default; see config/data-root.ts for how it is chosen and
 * why it is no longer %APPDATA%. Everything here keeps going through
 * `app.getPath('userData')`, which main.ts repoints at startup.
 * Environment variables act as a read-only fallback so you can export a key in a
 * shell instead of typing it into the app.
 *
 * The renderer NEVER receives a secret. It gets ConfigStatus: presence flags,
 * where the value came from, and a last-4 hint. getKey() is main-process only.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { layout } from './data-root';
import {
  ACCENT_RE,
  dimensionsAcceptable,
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION,
  logoFilePath,
  sniffImage,
} from '../packet/brand';
import {
  AgentMode,
  AppConfig,
  ConfigStatus,
  KeyStatus,
} from '../../shared/types';

const ENV_NAMES: Record<keyof AppConfig['keys'], string> = {
  googlePlaces: 'GOOGLE_PLACES_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  lob: 'LOB_API_KEY',
  postgrid: 'POSTGRID_API_KEY',
};

const DEFAULTS: AppConfig = {
  version: 1,
  keys: { googlePlaces: null, anthropic: null, lob: null, postgrid: null },
  agent: { mode: 'auto' },
  defaults: { city: '', category: '', limit: 10 },
  operator: { name: '', email: '', scannerUrl: '', askMode: 'default', ask: '', brandVoice: '' },
  brand: { accent: '', logo: '' },
};

/**
 * Voice instructions ride the agent's system prompt, which travels as an
 * argv argument on Windows (~32k cap shared with everything else on the
 * command line). The cap keeps a pasted style guide from breaking the spawn;
 * anything longer is truncated at save, where the operator can see it.
 */
export const BRAND_VOICE_MAX = 1500;

/**
 * The closing ask prints inside one scorecard block, and the no-split print
 * rule can only keep a block whole if a block never outgrows a page. This
 * caps the characters; the renderer separately caps the paragraph count,
 * because seven hundred characters of blank lines is tall and cheap.
 */
export const ASK_MAX = 700;

/** Cap without bisecting an astral character into a lone surrogate. */
function capped(s: string, max: number): string {
  return s.trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}

function capVoice(s: string): string {
  return capped(s, BRAND_VOICE_MAX);
}

let cache: AppConfig | null = null;

/**
 * The one root, set once by main.ts before anything reads a path.
 *
 * Falls back to `userData` when unset, which is the case in the test harnesses:
 * they point `userData` at a temp directory of their own and never boot main.ts,
 * so they keep getting an isolated root without knowing this module exists.
 */
let root: string | null = null;

export function setDataRoot(dir: string): void {
  root = dir;
  cache = null;
}

/**
 * Drops the in-memory copy so the next read comes off disk and back through
 * coerce().
 *
 * config.json is a documented hand-edit surface, and this is what proves a
 * hand-edited value is re-validated rather than trusted. Note the app itself
 * caches for the session: an edit made while it is running takes effect on
 * the next start, which is why the README tells the operator to edit it
 * rather than expecting live reload.
 */
export function reload(): void {
  cache = null;
}

export function dataRoot(): string {
  return root ?? app.getPath('userData');
}

export function configPath(): string {
  return layout(dataRoot()).config;
}

/**
 * Raw fetched bytes, kept so a finding can be re-checked against what was
 * actually read. A cache, and named one: the copies a packet cites are written
 * into that packet's own `01-evidence/`, so deleting this loses history rather
 * than deliverables.
 */
export function evidenceDir(): string {
  return layout(dataRoot()).captures;
}

/** Where the operator's own logo copy lives. */
export function brandDir(): string {
  return layout(dataRoot()).brand;
}

/**
 * Accepts an accent, refusing anything that is not exactly `#rrggbb`. The
 * derived treatments are computed at render time, never stored, so a change
 * to the derivation cannot leave stale colours in config.
 */
export function setAccent(accent: string): { ok: boolean; message?: string } {
  const v = accent.trim();
  if (v !== '' && !ACCENT_RE.test(v)) {
    return { ok: false, message: 'An accent colour must be a six-digit hex code, like #2E5AAC.' };
  }
  const cfg = load();
  cfg.brand.accent = v;
  persist(cfg);
  return { ok: true };
}

/**
 * Copies a chosen image into the data root and records only its KIND.
 *
 * Verified three ways before it is accepted: size, magic bytes, and an
 * actual decode with a dimension cap, because magic bytes alone prove
 * neither decodability nor that a 512KB file is not a decompression bomb.
 */
export function setLogoFromFile(
  sourcePath: string,
  decode: (bytes: Buffer) => { width: number; height: number; empty: boolean }
): { ok: boolean; message?: string } {
  /**
   * Bounded read, not readFileSync.
   *
   * The size gate has to happen on bytes already in hand (a stat-then-read
   * checks a file that can be swapped in between), but reading the whole file
   * first means a mis-picked video is loaded into main before anything
   * refuses it. Reading one byte past the cap satisfies both: enough to know
   * the file is too big, never more than that.
   */
  let buf: Buffer;
  try {
    const fd = fs.openSync(sourcePath, 'r');
    try {
      const room = Buffer.alloc(LOGO_MAX_BYTES + 1);
      const read = fs.readSync(fd, room, 0, room.length, 0);
      buf = room.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, message: 'That file could not be read.' };
  }
  if (buf.length > LOGO_MAX_BYTES) {
    return { ok: false, message: 'That image is over 512KB. Use a smaller PNG or JPEG.' };
  }

  const kind = sniffImage(buf);
  if (kind === '') {
    return { ok: false, message: 'Only PNG and JPEG are accepted. SVG is markup, so it is refused.' };
  }

  // Header dimensions BEFORE any decode: a 500KB file can declare 20000px a
  // side, and a decoder learns that by allocating gigabytes to find out.
  if (!dimensionsAcceptable(buf, kind)) {
    return {
      ok: false,
      message: `That image is unreadable or larger than ${LOGO_MAX_DIMENSION}px on a side.`,
    };
  }

  // Only now, on a file whose header is already vouched for, confirm a real
  // decoder can render it. It is handed the BYTES already read, not the path:
  // re-opening the file would validate a different file than the one stored.
  const size = decode(buf);
  if (size.empty) return { ok: false, message: 'That file is not a readable image.' };

  const dir = brandDir();
  const dest = logoFilePath(dir, kind);
  // Unique tmp, so two picks in flight cannot collide on one scratch name.
  const tmp = `${dest}.tmp-${process.pid}-${counterForTmp++}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return { ok: false, message: 'The logo could not be saved to your data folder.' };
  }

  /**
   * Marker first, THEN remove the superseded copy.
   *
   * The other order loses the operator's logo entirely if persist() throws
   * between the two: config would still name the deleted extension, and
   * every later document would render with no logo and no explanation.
   */
  const cfg = load();
  const previous = cfg.brand.logo;
  cfg.brand.logo = kind;
  persist(cfg);
  if (previous !== '' && previous !== kind) {
    try {
      fs.rmSync(logoFilePath(dir, previous), { force: true });
    } catch {
      /* best effort: a stale unreferenced file costs disk, never correctness */
    }
  }
  return { ok: true };
}

let counterForTmp = 0;

/** Removes both copies, any leftover scratch file, and the marker. */
export function clearLogo(): void {
  const dir = brandDir();
  for (const k of ['png', 'jpg'] as const) {
    try {
      fs.rmSync(logoFilePath(dir, k), { force: true });
    } catch {
      /* best effort */
    }
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.includes('.tmp-')) fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    /* the folder may not exist yet, which is the same as clean */
  }
  const cfg = load();
  cfg.brand.logo = '';
  persist(cfg);
}

/**
 * Where client folders are written, and where the approval ledger lives beside
 * them.
 *
 * This is the data root itself, so client work lands at `data/clients/...`
 * rather than `data/packets/clients/...`. One root for every prospect rather
 * than one per client folder, because the queue's only useful question is
 * "what is waiting on me", across all of them.
 */
export function packetsDir(): string {
  return dataRoot();
}

function coerce(raw: unknown): AppConfig {
  const base: AppConfig = JSON.parse(JSON.stringify(DEFAULTS));
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<AppConfig>;

  if (r.keys && typeof r.keys === 'object') {
    for (const k of Object.keys(base.keys) as (keyof AppConfig['keys'])[]) {
      const v = (r.keys as Record<string, unknown>)[k];
      base.keys[k] = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    }
  }

  const mode = r.agent?.mode;
  if (mode === 'auto' || mode === 'cli' || mode === 'sdk-apikey' || mode === 'sdk-subscription') {
    base.agent.mode = mode;
  }

  if (r.operator && typeof r.operator === 'object') {
    const o = r.operator as Partial<AppConfig['operator']>;
    if (typeof o.name === 'string') base.operator.name = o.name.trim();
    if (typeof o.email === 'string') base.operator.email = o.email.trim();
    if (typeof o.scannerUrl === 'string') base.operator.scannerUrl = o.scannerUrl.trim();
    if (o.askMode === 'default' || o.askMode === 'custom') base.operator.askMode = o.askMode;
    if (typeof o.ask === 'string') base.operator.ask = capped(o.ask, ASK_MAX);
    if (typeof o.brandVoice === 'string') {
      base.operator.brandVoice = capVoice(o.brandVoice);
    }
  }

  /**
   * Validated HERE, not only at the IPC channel, because config.json is
   * documented in two READMEs as the one file an operator edits by hand. A
   * value that only the channel checks is unvalidated for every value that
   * did not arrive over the channel.
   */
  if (r.brand && typeof r.brand === 'object') {
    const b = r.brand as Partial<AppConfig['brand']>;
    if (typeof b.accent === 'string' && ACCENT_RE.test(b.accent)) base.brand.accent = b.accent;
    if (b.logo === 'png' || b.logo === 'jpg') base.brand.logo = b.logo;
  }

  if (r.defaults && typeof r.defaults === 'object') {
    const d = r.defaults as Partial<AppConfig['defaults']>;
    if (typeof d.city === 'string') base.defaults.city = d.city;
    if (typeof d.category === 'string') base.defaults.category = d.category;
    if (typeof d.limit === 'number' && Number.isFinite(d.limit)) {
      base.defaults.limit = Math.min(20, Math.max(1, Math.round(d.limit)));
    }
  }

  return base;
}

export function load(): AppConfig {
  if (cache) return cache;
  const file = configPath();
  try {
    if (fs.existsSync(file)) {
      cache = coerce(JSON.parse(fs.readFileSync(file, 'utf8')));
      return cache;
    }
  } catch (e) {
    // A corrupt config must not brick the app. Move it aside and start clean.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    console.error('[config] unreadable, starting fresh:', (e as Error).message);
  }
  cache = coerce(null);
  return cache;
}

function persist(cfg: AppConfig): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write cannot truncate a good config.
  //
  // `mode: 0o600` is owner-only on POSIX. On Windows it is largely a no-op: Node
  // maps only the read-only bit onto NTFS, so the config's confidentiality there
  // rests on the user profile's directory ACL (the data root sits under the
  // user's own profile), not on this mode. Kept because it is correct where it
  // works and harmless where it does not; the one stored secret is a low-value
  // Places key, so an explicit per-file ACL is not worth the platform-specific
  // machinery.
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    /**
     * Every setter mutates the cached object before calling this, so a failed
     * write would leave the session running on a value that never reached
     * disk: the operator sees "saving failed" and then watches the app behave
     * as though it had worked until the next restart. Dropping the cache
     * makes the next read come off disk, which is the truth.
     */
    cache = null;
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw e;
  }
  cache = cfg;
}

/** Main-process only. Returns the real secret, config first then env. */
export function getKey(name: keyof AppConfig['keys']): string | null {
  const fromConfig = load().keys[name];
  if (fromConfig) return fromConfig;
  const fromEnv = process.env[ENV_NAMES[name]];
  return fromEnv && fromEnv.trim() !== '' ? fromEnv.trim() : null;
}

function keyStatus(name: keyof AppConfig['keys']): KeyStatus {
  const fromConfig = load().keys[name];
  if (fromConfig) {
    return { present: true, source: 'config', hint: fromConfig.slice(-4) };
  }
  const fromEnv = process.env[ENV_NAMES[name]];
  if (fromEnv && fromEnv.trim() !== '') {
    return { present: true, source: 'env', hint: fromEnv.trim().slice(-4) };
  }
  return { present: false, source: 'none', hint: null };
}

export function status(): ConfigStatus {
  const cfg = load();
  return {
    version: 1,
    keys: {
      googlePlaces: keyStatus('googlePlaces'),
      anthropic: keyStatus('anthropic'),
      lob: keyStatus('lob'),
      postgrid: keyStatus('postgrid'),
    },
    agent: { mode: cfg.agent.mode },
    defaults: { ...cfg.defaults },
    operator: { ...cfg.operator },
    brand: { ...cfg.brand },
    configPath: configPath(),
  };
}

export function setKey(name: keyof AppConfig['keys'], value: string): ConfigStatus {
  const cfg = load();
  const trimmed = value.trim();
  cfg.keys[name] = trimmed === '' ? null : trimmed;
  persist(cfg);
  return status();
}

/**
 * The identity printed on artifacts. Trimmed, never validated into shape here.
 *
 * Whether it is COMPLETE enough to generate is a question for the generate
 * path, not for the setter: half-entered settings are a normal state and
 * refusing to save them loses what the operator typed.
 */
export function setOperator(partial: Partial<AppConfig['operator']>): ConfigStatus {
  const cfg = load();
  if (typeof partial.name === 'string') cfg.operator.name = partial.name.trim();
  if (typeof partial.email === 'string') cfg.operator.email = partial.email.trim();
  if (typeof partial.scannerUrl === 'string') cfg.operator.scannerUrl = partial.scannerUrl.trim();
  if (partial.askMode === 'default' || partial.askMode === 'custom') cfg.operator.askMode = partial.askMode;
  if (typeof partial.ask === 'string') cfg.operator.ask = capped(partial.ask, ASK_MAX);
  if (typeof partial.brandVoice === 'string') {
    cfg.operator.brandVoice = capVoice(partial.brandVoice);
  }
  persist(cfg);
  return status();
}

export function setDefaults(partial: Partial<AppConfig['defaults']>): ConfigStatus {
  const cfg = load();
  if (typeof partial.city === 'string') cfg.defaults.city = partial.city;
  if (typeof partial.category === 'string') cfg.defaults.category = partial.category;
  if (typeof partial.limit === 'number' && Number.isFinite(partial.limit)) {
    cfg.defaults.limit = Math.min(20, Math.max(1, Math.round(partial.limit)));
  }
  persist(cfg);
  return status();
}

export function setAgentMode(mode: AgentMode): ConfigStatus {
  const cfg = load();
  cfg.agent.mode = mode;
  persist(cfg);
  return status();
}

/**
 * Where everything this app writes goes.
 *
 * Electron's default is `app.getPath('userData')`, which on Windows resolves to
 * %APPDATA%/assay. That put client packets, raw captures of third-party
 * sites and the operator's API keys in the same directory as Chromium's own
 * `Preferences`, `Local State`, `DIPS` and `lockfile`, four levels inside a
 * hidden folder. An operator cannot answer "where are my files" without first
 * knowing an Electron convention, and half of what is in there is not ours.
 *
 * So the root moves next to the install and everything hangs off it, Chromium's
 * files included: `app.setPath('userData', ...)` is called once at startup
 * before anything reads a path, which relocates the lot in one move.
 *
 * Order of preference:
 *
 *   1. `ASSAY_DATA_DIR`, for anyone who wants it on another drive.
 *   2. `<install>/data`, the default and the point of this module.
 *   3. Electron's userData, only when the install folder is read-only, which
 *      is the normal case for a machine-wide install under Program Files.
 *
 * No electron import: this is resolved before `app` is ready, and the tests
 * drive it from plain node.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Folder name created under the install root. */
export const DATA_DIR_NAME = 'data';

export type DataRootReason = 'override' | 'install' | 'fallback';

export interface DataRootInput {
  /** Install directory: the exe's folder when packaged, the repo when not. */
  anchor: string;
  /** Electron's own userData path, used only if nothing better is writable. */
  fallback: string;
  /** Contents of ASSAY_DATA_DIR, if set. */
  override?: string | null;
  /** Injected so the decision can be tested without a read-only filesystem. */
  canWrite: (dir: string) => boolean;
}

export interface DataRootChoice {
  root: string;
  reason: DataRootReason;
  /** One line for the startup log and the settings screen. Never empty. */
  note: string;
}

/**
 * True if `dir` can be created and written to. Probes with a real file rather
 * than `fs.access`: on Windows a directory under Program Files reports
 * writable to `access` and still refuses the write under UAC virtualization.
 */
export function canWriteDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function resolveDataRoot(input: DataRootInput): DataRootChoice {
  const { anchor, fallback, canWrite } = input;
  const override = (input.override ?? '').trim();
  const install = path.join(anchor, DATA_DIR_NAME);

  if (override !== '') {
    if (canWrite(override)) {
      return { root: override, reason: 'override', note: `ASSAY_DATA_DIR is set, using ${override}` };
    }
    // Falling through in silence would recreate the exact problem this module
    // exists to fix, so the unusable override is named in the note either way.
    const why = `ASSAY_DATA_DIR is set to ${override}, which is not writable`;
    return canWrite(install)
      ? { root: install, reason: 'install', note: `${why}; using ${install}` }
      : { root: fallback, reason: 'fallback', note: `${why}; using ${fallback}` };
  }

  if (canWrite(install)) {
    return { root: install, reason: 'install', note: `using ${install}` };
  }

  return {
    root: fallback,
    reason: 'fallback',
    note: `${install} is not writable, so falling back to ${fallback}`,
  };
}

/**
 * Every path the app owns, from one root.
 *
 * The names are the documentation. An operator opening `data/` should be able
 * to tell what each entry is without being told, which is why Chromium's
 * thirteen profile files go into a single dot-prefixed folder instead of
 * sitting in the same listing as the five that are ours, and why the folder
 * holding the actual work is called `clients` rather than `packets/clients`.
 */
export function layout(root: string) {
  return {
    root,
    /** One folder per business. The work. */
    clients: path.join(root, 'clients'),
    /** Raw fetched bytes, keyed by scan. A cache: safe to delete. */
    captures: path.join(root, 'captures'),
    /** API keys and operator identity. The only file an operator edits by hand. */
    config: path.join(root, 'config.json'),
    /** What has been approved, rejected and reopened, and when. */
    ledger: path.join(root, 'approvals.json'),
    /** Businesses that must never be contacted again. */
    blocklist: path.join(root, 'blocklist.json'),
    /** First-contact dates, for pacing. */
    packetStarts: path.join(root, 'packet-starts.json'),
    /** Map tile cache, written by the tiles:// proxy. A cache: safe to delete. */
    tiles: path.join(root, 'tiles'),
    /** The operator's own logo copy, for branding generated documents. */
    brand: path.join(root, 'brand'),
    /** Electron's own profile. Not ours, never edited, safe to delete. */
    chromium: path.join(root, '.chromium'),
    readme: path.join(root, 'README.md'),
  };
}

const README = `# Assay data

Everything this app keeps lives in this one folder, and you can move or back
up the folder as a unit. The one thing written outside it is a temporary HTML
file during PDF rendering, in your system temp folder, removed after the print.

## What is in here

| Name | What it is |
|---|---|
| \`clients/\` | The work. One folder per business, named \`<Town-ST>__<Business>\`. |
| \`config.json\` | API keys and your operator identity. The only file here you edit by hand. |
| \`approvals.json\` | The approval ledger: what was approved, rejected or reopened, when, and over which bytes. |
| \`captures/\` | Raw fetched pages, kept so a finding can be re-checked against the bytes it was read from. |
| \`tiles/\` | Map tiles cached from OpenStreetMap by the main process. A cache: safe to delete. |
| \`brand/\` | Your logo, copied here when you set one in Settings. Deleting it removes the logo from new documents. |
| \`blocklist.json\` | Businesses that must never be contacted again. |
| \`packet-starts.json\` | When each business was first contacted, used for pacing. |
| \`.chromium/\` | Electron's browser profile. Not written by this app and not useful to read. |
| \`.superseded/\` | Only appears after an upgrade moved things. Old copies, kept until you delete them. |

## Inside a client folder

    00-INDEX.md    what was found, the score, and every capture behind it
    01-evidence/   the captures this packet cites, with a manifest
    02-drafts/     generated, NOT approved, one folder per scan date
    03-approved/   reserved; not created yet. Approval is ledger-only today
    04-sent/       reserved for a future sender; nothing writes here yet
    99-rejected/   reserved; a rejection and its reason live in approvals.json

The numbers are the order the work happens in. A folder's number tells you the
state of what is inside it without opening a file, which is why approval does
not rename anything: a path that has been pasted into a message must keep
working.

A client folder is self-contained. \`01-evidence/\` holds copies of the captures
the packet cites, so the folder can be handed to somebody else without this app
and still be checkable.

## Safe to delete

\`captures/\` and \`.chromium/\` are caches and regenerate on demand. Deleting
\`captures/\` loses the ability to re-check an old finding against its original
bytes, but breaks nothing.

\`.superseded/\` holds copies of things an upgrade replaced. The app never reads
it. Compare it against the live folders once, then delete the whole thing.

Everything else is the record. \`clients/\` and \`approvals.json\` are the two
that cannot be regenerated from anything.

## Moving it

Set \`ASSAY_DATA_DIR\` to an absolute path and restart. The app copies
nothing on its own beyond a one-time carry-over from the old %APPDATA%
location; move the folder yourself and point the variable at it.
`;

/**
 * Write the folder's own explanation into it.
 *
 * Rewritten on every start rather than only when absent: a README describing a
 * layout the app no longer uses is worse than none, and this one is generated
 * from the same module that decides the layout.
 */
export function writeDataReadme(root: string): void {
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), README, 'utf8');
  } catch {
    // A missing README is not a reason to refuse to start.
  }
}

/**
 * Everything under the old root that belongs to this app. Chromium's files are
 * deliberately absent: `Preferences`, `Local State`, `DIPS*`, `SharedStorage*`
 * and `lockfile` are the browser's, they are regenerated on demand, and
 * carrying a stale `lockfile` across is a way to lose a startup.
 */
const MIGRATIONS: { from: string[]; to: string }[] = [
  { from: ['config.json'], to: 'config.json' },
  { from: ['packet-starts.json'], to: 'packet-starts.json' },
  { from: ['blocklist.json'], to: 'blocklist.json' },
  { from: ['evidence'], to: 'captures' },
  { from: [path.join('packets', 'clients')], to: 'clients' },
  { from: [path.join('packets', 'approvals.json')], to: 'approvals.json' },
];

/**
 * Root entries that are no longer read, paired with the entry that replaced
 * them. An entry is only swept once its replacement exists, so a sweep can
 * never leave the only copy of something in a folder named for rubbish.
 *
 * The unpaired ones are Chromium's, left loose in the root by the first pass of
 * this move before `userData` was pointed at `.chromium/`. They regenerate.
 */
// Never name a live folder here. `brand/` in particular holds the operator's
// only copy of their logo: parking it would take the branding off their
// documents with no error to explain why.
const SUPERSEDED: { name: string; replacedBy?: string }[] = [
  { name: 'evidence', replacedBy: 'captures' },
  { name: 'packets', replacedBy: 'clients' },
  { name: 'Cache' },
  { name: 'Code Cache' },
  { name: 'GPUCache' },
  { name: 'DawnGraphiteCache' },
  { name: 'DawnWebGPUCache' },
  { name: 'Local Storage' },
  { name: 'Network' },
  { name: 'Session Storage' },
  { name: 'Shared Dictionary' },
  { name: 'blob_storage' },
  { name: 'DIPS' },
  { name: 'DIPS-wal' },
  { name: 'Local State' },
  { name: 'Preferences' },
  { name: 'SharedStorage' },
  { name: 'SharedStorage-wal' },
  { name: 'lockfile' },
];

/** Where superseded entries are parked. One thing to delete, not nineteen. */
export const SUPERSEDED_DIR = '.superseded';

/**
 * Move what the app no longer reads out of the root's top level.
 *
 * Migration copies and never deletes, which is the right instinct and on its
 * own made the folder worse: the first real run of the move left `evidence/`
 * beside `captures/`, `packets/` beside `clients/`, and thirteen loose Chromium
 * files from before `userData` was repointed. Twenty-three entries in the one
 * directory whose whole purpose is being readable without an explanation.
 *
 * Moves rather than deletes, into one dot-folder the operator can remove in a
 * single action once they are satisfied nothing was lost. Best effort: a file
 * still held open simply stays where it is and gets swept next start.
 *
 * Returns what it moved, for the startup log.
 */
export function tidyDataRoot(root: string): string[] {
  const parked = path.join(root, SUPERSEDED_DIR);
  const moved: string[] = [];

  for (const { name, replacedBy } of SUPERSEDED) {
    const from = path.join(root, name);
    if (!fs.existsSync(from)) continue;
    // Never sweep something whose replacement was not written: that would park
    // the only copy of the operator's captures or client folders.
    if (replacedBy && !fs.existsSync(path.join(root, replacedBy))) continue;

    /**
     * Never overwrite what is already parked.
     *
     * The first version did `rmSync(to, { recursive: true })` before the
     * rename, so a second sweep silently destroyed the copy the first one had
     * set aside. This folder's whole promise, stated in the README the
     * operator reads, is that nothing is deleted; a recursive delete on the
     * only remaining copy of a superseded client folder makes that a lie.
     */
    let to = path.join(parked, name);
    for (let n = 2; fs.existsSync(to) && n < 100; n++) to = path.join(parked, `${name}-${n}`);
    if (fs.existsSync(to)) continue;

    try {
      fs.mkdirSync(parked, { recursive: true });
      fs.renameSync(from, to);
      moved.push(path.basename(to));
    } catch {
      // In use, or across a device boundary. It will still be here next start.
    }
  }
  return moved;
}

/**
 * Bring the app's own files forward into the current layout.
 *
 * `from` is a list because there have been two earlier shapes: the original
 * %APPDATA% root, and the first pass of this move, which kept the old
 * `evidence/` and `packets/` names inside the new folder. Both resolve here,
 * so neither leaves an operator with a half-migrated directory to sort out.
 *
 * Copies rather than moves, and never overwrites: the operator's API keys and
 * their client folders are the two things in here worth anything, and a
 * migration that eats them on a bad guess is worse than one that leaves a
 * duplicate behind. Deleting the old copy stays the operator's decision.
 *
 * Safe to call with `oldRoot === newRoot`, which is how the intermediate
 * layout heals itself on the next start.
 *
 * Returns what it brought across, for the startup log.
 */
export function migrateLegacyData(oldRoot: string, newRoot: string): string[] {
  if (!fs.existsSync(oldRoot)) return [];
  const sameRoot = path.resolve(oldRoot) === path.resolve(newRoot);

  const moved: string[] = [];
  for (const { from: candidates, to } of MIGRATIONS) {
    const dest = path.join(newRoot, to);
    if (fs.existsSync(dest)) continue;

    for (const rel of candidates) {
      // Copying a path onto itself would recurse, and there is nothing to do.
      if (sameRoot && rel === to) continue;
      const src = path.join(oldRoot, rel);
      if (!fs.existsSync(src)) continue;
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true, errorOnExist: false, force: false });
        moved.push(rel === to ? to : `${rel} -> ${to}`);
      } catch {
        // A packet that will not copy is not worth refusing to start over.
      }
      break;
    }
  }
  return moved;
}

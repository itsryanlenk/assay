/**
 * Electron main process, app lifecycle and window creation.
 *
 * Security posture: the renderer is untrusted UI. contextIsolation on,
 * nodeIntegration off, sandbox on, navigation blocked, window.open denied.
 * Everything the renderer can do is the explicit channel list in shared/channels.ts.
 */

import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { buildAppMenu } from './menu';
import { assertEgressGuardWired } from './evidence/fetch-raw';
import { registerHandlers } from './ipc/handlers';
import { evidenceDir, setDataRoot } from './config/store';
import {
  canWriteDir,
  layout,
  migrateLegacyData,
  resolveDataRoot,
  SUPERSEDED_DIR,
  tidyDataRoot,
  writeDataReadme,
} from './config/data-root';
import { installTileProtocol, registerTileScheme } from './tiles/proxy';

const isDev = process.argv.includes('--dev');

/**
 * `--smoke` loads the window, collects anything the renderer complained about,
 * prints a verdict and exits non-zero on failure. It exists so "Phase N runs"
 * is a command with an exit code rather than a claim.
 */
const isSmoke = process.argv.includes('--smoke');

// Renderer lives outside the TS build, so resolve it relative to the app root
// rather than __dirname (which is dist/main/main).
const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const RENDERER_INDEX = path.join(APP_ROOT, 'src', 'renderer', 'index.html');
// Window and taskbar icon. .ico carries the multi-resolution set Windows wants;
// every other platform takes the 512px png.
const APP_ICON = path.join(
  APP_ROOT,
  'assets',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png'
);

/**
 * Move the data root before anything reads a path.
 *
 * This has to happen here, at module scope, rather than in `whenReady`: the
 * single-instance lockfile below lives in userData, and `app.setPath` after
 * that point would leave the lock in the old location and split the app's
 * files across two roots, which is the problem rather than the fix.
 *
 * Packaged, the anchor is the folder holding the exe. Unpackaged it is the
 * repo, whose `data/` is gitignored.
 */
/** Where the tiles:// proxy caches. Set once the data root is resolved below. */
let tilesCacheDir = '';

{
  const anchor = app.isPackaged ? path.dirname(app.getPath('exe')) : APP_ROOT;
  const legacy = app.getPath('userData');
  const choice = resolveDataRoot({
    anchor,
    fallback: legacy,
    override: process.env.ASSAY_DATA_DIR,
    canWrite: canWriteDir,
  });

  const paths = layout(choice.root);
  setDataRoot(choice.root);
  tilesCacheDir = paths.tiles;

  /**
   * Electron's profile goes in a subfolder, not the root.
   *
   * userData is where Chromium keeps `Preferences`, `Local State`, `DIPS`,
   * `SharedStorage` and a dozen cache directories. Pointing it at the data
   * root put thirteen files nobody here wrote in the same listing as the five
   * that matter, which is the same "where are my files" problem one level in.
   * sessionData is resolved separately from userData and has to be said too,
   * or the caches go back to %APPDATA%/Electron.
   */
  fs.mkdirSync(paths.chromium, { recursive: true });
  app.setPath('userData', paths.chromium);
  app.setPath('sessionData', paths.chromium);

  const brought = [
    ...migrateLegacyData(legacy, choice.root),
    // Same root, older layout: an install that ran the first pass of this move.
    ...migrateLegacyData(choice.root, choice.root),
  ];
  // After the carry-forward, or it would sweep aside the folders it is about
  // to copy from.
  const swept = tidyDataRoot(choice.root);
  writeDataReadme(choice.root);

  console.log(`[main] data root: ${choice.note}`);
  if (brought.length) console.log(`[main] carried forward: ${brought.join(', ')}`);
  if (swept.length) {
    console.log(`[main] moved ${swept.length} superseded entr(y/ies) into ${SUPERSEDED_DIR}: ${swept.join(', ')}`);
  }
}

// Chromium refuses a privileged scheme registered after ready, so this sits
// at module scope with the rest of the before-ready work.
registerTileScheme();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#F1EEE3',
    title: 'Assay',
    icon: APP_ICON,
    show: false,
    // The menu bar is shown, not auto-hidden: it carries the Help menu, which is
    // the conventional first place a user looks, and the Edit roles the paste
    // boxes rely on. On a clean-look app this is a deliberate trade for a
    // discoverable front door to Help.
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // The native menu owns Help and the Edit roles the paste boxes need. Set from
  // the window so its Help items can drive this window's view.
  Menu.setApplicationMenu(buildAppMenu(win, { isDev }));

  // The app window renders local UI only. Anything trying to navigate it
  // elsewhere is either a bug or hostile; send real links to the real browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      console.warn('[main] blocked in-window navigation to', url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('[main] blocked window.open to', url);
    return { action: 'deny' };
  });

  if (isSmoke) attachSmokeTest(win);

  void win.loadFile(RENDERER_INDEX);
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  return win;
}

function attachSmokeTest(win: BrowserWindow): void {
  const problems: string[] = [];

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // level 2 = warning, 3 = error. CSP violations and blocked font loads
    // surface here, which is exactly what we want a smoke run to catch.
    if (level >= 2) problems.push(`[console:${level}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    problems.push(`[did-fail-load] ${code} ${desc}, ${url}`);
  });

  win.webContents.on('preload-error', (_e, path, error) => {
    problems.push(`[preload-error] ${path}, ${error.message}`);
  });

  win.webContents.once('did-finish-load', () => {
    // Let DOMContentLoaded handlers and the boot() IPC round-trip settle.
    setTimeout(() => {
      void win.webContents
        .executeJavaScript(
          `(async () => {
             const shown = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none';
             const base = {
               bridge: typeof window.assay === 'object',
               version: document.querySelector('#app-version')?.textContent || '',
               cfgPath: document.querySelector('#cfg-path')?.textContent || '',
               rows: document.querySelectorAll('.key-row').length,
               font: getComputedStyle(document.querySelector('h1')).fontFamily,
               cream: getComputedStyle(document.body).backgroundColor,
               scanShown: shown('#view-scan'),
               settingsShown: shown('#view-settings'),
               approvalsShown: shown('#view-approvals'),
               activeNav: document.querySelector('.app-nav .btn.is-active')?.dataset.view || 'none',
               keyWarnShown: !document.querySelector('#key-warning').hidden,
             };
             // Actually drive the nav. A view that exists in the markup and
             // cannot be reached is the same bug as a view that is missing,
             // and only clicking it tells them apart.
             document.querySelector('.app-nav .btn[data-view="approvals"]').click();
             base.approvalsReachable = shown('#view-approvals');
             // Either the empty-state box or a populated counter is correct.
             // This asserted "empty" and therefore passed on a clean machine
             // and failed the moment the operator generated a real packet,
             // which is a test that measures the ledger rather than the view.
             base.approvalsRows = document.querySelectorAll('.rail-item').length;
             // Three correct states, not two: the empty-state line, a visible
             // queue, or an all-archived rail collapsed to its ARCHIVED BY YOU
             // toggle. The third was missing, so this probe passed on every
             // clean data root and failed on the operator's own machine the
             // day every real row was decided and filed. A probe that cannot
             // recognize a legitimate state is the bug, not the state.
             base.approvalsRendered =
               (document.querySelector('#approvals-status')?.textContent || '').includes('NOTHING IS WAITING') ||
               (!document.querySelector('#counter').hidden && base.approvalsRows > 0) ||
               document.querySelector('.rail-archived-toggle') !== null;
             document.querySelector('.app-nav .btn[data-view="scan"]').click();
             base.scanReturns = shown('#view-scan');
             // The one new egress path, driven end to end: an <img> through
             // the tiles: scheme proves the privileged registration, the CSP
             // admission, and the handler (stub mode under --smoke) in one
             // shot. A typo in any of the three fails here, not in the field.
             base.tileServed = await new Promise((resolve) => {
               const probeImg = new Image();
               probeImg.onload = () => resolve(probeImg.naturalWidth > 0);
               probeImg.onerror = () => resolve(false);
               setTimeout(() => resolve(false), 3000);
               probeImg.src = 'tiles://osm/1/0/0.png';
             });
             return base;
           })()`
        )
        .then((probe: Record<string, unknown>) => {
          if (!probe.bridge) problems.push('preload bridge window.assay is missing');
          if (!probe.version) problems.push('app info IPC never resolved (version empty)');
          if (probe.rows !== 4) problems.push(`expected 4 key rows, got ${String(probe.rows)}`);
          if (!probe.scanShown) problems.push('scan view is not visible on boot');
          if (probe.settingsShown) problems.push('settings view leaked through its hidden attribute');
          if (probe.approvalsShown) problems.push('approvals view leaked through its hidden attribute');
          if (probe.activeNav !== 'scan') problems.push(`nav active is "${String(probe.activeNav)}", expected "scan"`);
          if (!probe.approvalsReachable) problems.push('the approvals nav button does not open the approvals view');
          if (!probe.approvalsRendered) {
            problems.push('the approvals view rendered neither an empty state nor a queue');
          }
          if (!probe.scanReturns) problems.push('navigating back to scan does not restore it');
          if (!probe.tileServed) {
            problems.push('the tiles:// scheme did not serve the stub tile (scheme registration, CSP, or handler)');
          }

          console.log('\n--- SMOKE ---');
          for (const [k, v] of Object.entries(probe)) console.log(`  ${k}: ${String(v)}`);
          if (problems.length) {
            console.log(`\n  FAIL, ${problems.length} problem(s):`);
            for (const p of problems) console.log(`    ${p}`);
          } else {
            console.log('\n  PASS, window loaded, bridge live, IPC round-tripped.');
          }
          app.exit(problems.length ? 1 : 0);
        })
        .catch((e: Error) => {
          console.log('\n--- SMOKE ---\n  FAIL, probe threw:', e.message);
          app.exit(1);
        });
    }, 1200);
  });
}

// Single instance, two copies writing the same ledger is a corruption path.
if (!app.requestSingleInstanceLock()) {
  /**
   * Losing the lock is normal for the app and FATAL for the smoke test.
   *
   * `app.quit()` here exits 0 with no output. `npm test` chains on `&&`, so a
   * leftover Electron from a previous run, or a crashed test that never
   * released the lock, made the smoke gate silently no-op and the suite
   * carried on to report everything else green. A gate that cannot tell
   * "passed" from "never ran" is not a gate, and this one hid behind a
   * successful exit code for as long as any stray instance was alive.
   *
   * The app still exits with a success code and no window. The smoke run says so and fails.
   */
  if (process.argv.includes('--smoke')) {
    console.log('\n--- SMOKE ---');
    console.log('  FAIL, another instance holds the single-instance lock, so nothing was verified.');
    console.log('  Close any running Assay, or kill leftover electron processes, and re-run.');
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    // Fail closed: prove the SSRF dispatcher is actually consulted on THIS
    // runtime before any target-site fetch is possible. If a future Node or
    // Electron silently stopped honouring the per-request dispatcher, the
    // connect-time guard would no-op; better to refuse to start than to scan
    // with a half-open egress.
    try {
      await assertEgressGuardWired();
    } catch (e) {
      const msg = (e as Error).message;
      console.error('[main]', msg);
      dialog.showErrorBox('Assay cannot start safely', msg);
      app.exit(1);
      return;
    }

    fs.mkdirSync(evidenceDir(), { recursive: true });
    // Under --smoke the proxy serves a stub tile and never touches the
    // network, so the gate proves the tiles:// path offline.
    installTileProtocol({ cacheDir: tilesCacheDir, stub: isSmoke });
    registerHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

export { shell };

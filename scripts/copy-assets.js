/**
 * Copies the exact woff2 files the house theme references out of @fontsource
 * and into assets/fonts/, and Leaflet out of its npm package into
 * assets/vendor/. The renderer's CSP names no external origin, so both must
 * be local files, not a CDN; the only network the map ever touches is the
 * main-process tile proxy.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'fonts');

const WANTED = [
  ['@fontsource/archivo-black', 'archivo-black-latin-400-normal.woff2'],
  ['@fontsource/inter', 'inter-latin-400-normal.woff2'],
  ['@fontsource/inter', 'inter-latin-700-normal.woff2'],
  ['@fontsource/jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2'],
  ['@fontsource/jetbrains-mono', 'jetbrains-mono-latin-700-normal.woff2'],
];

fs.mkdirSync(OUT, { recursive: true });

const missing = [];
let copied = 0;

for (const [pkg, file] of WANTED) {
  const src = path.join(ROOT, 'node_modules', ...pkg.split('/'), 'files', file);
  const dest = path.join(OUT, file);
  if (!fs.existsSync(src)) {
    missing.push(`${pkg}/files/${file}`);
    continue;
  }
  fs.copyFileSync(src, dest);
  copied++;
}

if (missing.length) {
  console.error(
    `[assets] ${missing.length} font file(s) not found, run "npm install" first:\n  ` +
      missing.join('\n  ')
  );
  console.error('[assets] The app still runs; text falls back to a system font.');
  process.exitCode = 0; // a missing font is cosmetic, not a build failure
}

if (copied) console.log(`[assets] ${copied} font file(s) -> assets/fonts/`);

/**
 * Leaflet, vendored for the map picker. Unlike a font, a missing leaflet.js
 * is named in a boot <script> tag: it becomes a console error and a smoke
 * failure with a misleading message, so this copy FAILS the build instead of
 * shrugging. The images/ folder rides along so no leaflet.css url() ever
 * 404s, even though the app's own pins are divIcons.
 */
const LEAFLET_SRC = path.join(ROOT, 'node_modules', 'leaflet', 'dist');
const LEAFLET_OUT = path.join(ROOT, 'assets', 'vendor', 'leaflet');
const LEAFLET_FILES = ['leaflet.js', 'leaflet.css'];

fs.mkdirSync(path.join(LEAFLET_OUT, 'images'), { recursive: true });

for (const f of LEAFLET_FILES) {
  const src = path.join(LEAFLET_SRC, f);
  if (!fs.existsSync(src)) {
    console.error(`[assets] leaflet/dist/${f} not found, run "npm install" first.`);
    process.exitCode = 1;
  } else {
    fs.copyFileSync(src, path.join(LEAFLET_OUT, f));
  }
}

const imgDir = path.join(LEAFLET_SRC, 'images');
if (fs.existsSync(imgDir)) {
  for (const f of fs.readdirSync(imgDir)) {
    fs.copyFileSync(path.join(imgDir, f), path.join(LEAFLET_OUT, 'images', f));
  }
}

if (process.exitCode !== 1) {
  const leafletVersion = require(path.join(ROOT, 'package.json')).dependencies.leaflet;
  console.log(`[assets] leaflet ${leafletVersion} -> assets/vendor/leaflet/`);
}

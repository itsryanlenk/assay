/**
 * Dev tool: run a single flaw check against one business, end to end.
 *
 *   node scripts/check-one.js "<business name>" [website-url]
 *
 * Omit the URL to exercise the no-website-listed path. Runs real HTTP through
 * fetch-raw (so a capture lands on disk) and a real agent call for the
 * headline. No Places key needed, no Electron.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const { runChecks } = require(path.join(ROOT, 'dist/main/main/checks/registry.js'));
const { ClaudeCliProvider } = require(path.join(ROOT, 'dist/main/main/agent/cli.js'));

const name = process.argv[2];
const website = process.argv[3] || null;
// Real Places candidates carry a phone and an address. Passing nulls made two
// checks reason from degenerate input and produce claims about the site that
// were really claims about the missing listing data.
const phone = process.argv[4] || null;
const address = process.argv[5] || '';

if (!name) {
  console.error('usage: node scripts/check-one.js "<business name>" [website-url]');
  process.exit(2);
}

const evidenceRoot = path.join(ROOT, 'evidence');
const scanId = `devcheck-${new Date().toISOString().slice(0, 10)}`;

const candidate = {
  placeId: 'dev',
  name,
  address,
  location: null,
  website,
  phone,
  rating: null,
  reviewCount: null,
  businessStatus: 'OPERATIONAL',
  primaryType: null,
  mapsUri: null,
  discoveredAt: new Date().toISOString(),
  source: 'google-places-new',
};

const SEV = ['CLEAN', 'MINOR', 'NOTABLE', 'BAD', 'WORST'];

(async () => {
  const res = await runChecks(
    { candidate, scanId },
    { agent: new ClaudeCliProvider(), evidenceRoot }
  );

  console.log(`\n${'='.repeat(78)}`);
  console.log(`${name}${website ? `  (${website})` : '  (no website listed)'}`);
  console.log(
    `worst ${res.worstSeverity} (${SEV[res.worstSeverity]})` +
      (res.disqualified ? '  ·  DISQUALIFIED' : '') +
      `  ·  ${res.findings.length} checks  ·  ${res.durationMs}ms`
  );
  console.log('='.repeat(78));

  for (const f of res.findings) {
    console.log(
      `\n  [${f.checkId}] ${f.status.toUpperCase()}  sev ${f.severity} ${SEV[f.severity]}  ·  ${f.confirmation}`
    );
    console.log(`     headline : ${f.headline}`);
    console.log(`     detail   : ${f.detail}`);
    if (f.fix) {
      console.log(`     FIX      : ${f.fix.summary}`);
      console.log(`     effort   : ${f.fix.effort}`);
      if (f.fix.snippet) console.log(`     snippet  : ${f.fix.snippet.replace(/\n/g, ' ⏎ ')}`);
    }
    if (f.unverifiedNote) console.log(`     unverif. : ${f.unverifiedNote}`);
    for (const e of f.evidence) {
      const onDisk = e.storedPath && fs.existsSync(e.storedPath);
      console.log(
        `     evidence : ${String(e.httpStatus).padEnd(4)}${String(e.byteLength).padStart(9)}b  ` +
          `${e.sha256.slice(0, 12) || '(none)'.padEnd(12)}  ${onDisk ? 'ON DISK' : 'NOT STORED'}  ${e.url}`
      );
      if (e.headers?.['x-robots-tag']) console.log(`                x-robots-tag: ${e.headers['x-robots-tag']}`);
      if (e.transportError) console.log(`                error: ${e.transportError}`);
    }
  }
  console.log('');
})();

/**
 * The same-day scrub rule, made mechanical.
 *
 * Both leaks that forced the 2026-08-04 history rebuild were details of
 * businesses this app itself had scanned, and the rule that would have caught
 * them ("anything the app scans goes in .scrub-terms the same day") lived in
 * somebody's memory. This module reads what data/ actually holds, so
 * preflight can refuse the build when a scanned business's name is not
 * covered by the operator's term list. A guard that learns the name the
 * moment the scan produces work is one that cannot be forgotten.
 *
 * Two sources, deduped by slug:
 *   - the approval ledger (data/approvals.json), whose rows carry the
 *     candidate's name exactly as Places returned it;
 *   - client folder names under data/clients/, a lossy backstop for folders
 *     that predate their ledger rows. "Town-ST__Business-Name" gives back
 *     "Business Name"; punctuation the slug dropped stays dropped, which is
 *     fine for coverage because matching is substring-based either way.
 *
 * This covers what reached the packet stage. A raw capture whose business
 * never produced a client folder or ledger row carries no name to harvest;
 * the structural detectors in leak-patterns.js remain the net for those.
 *
 * Also here: the tracked-binary check. Every leak scan in this repo reads
 * text, so a tracked image is invisible to all of them, and pixels can carry
 * a business's name and number as well as bytes can. A tracked binary must
 * be listed in .binary-allow (a deliberate, reviewed act) or preflight
 * refuses it.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Coverage means: some term of meaningful length appears inside the name,
 * both collapsed to letters and digits only, case-insensitive. Collapsing
 * both sides keeps punctuation the slug dropped ("Dane's" against a folder
 * that could only hold "Danes") from failing an operator who added the name
 * exactly as the business writes it. The floor stops a stopword-sized term
 * ("co", "the") covering every business by accident, and it relaxes to the
 * name's own length so a business named "Zia" is still clearable at all.
 *
 * What this does NOT promise: that the covering term would catch every
 * partial leak. A term "Rockport" covers "Rockport Marine Supply" here, and
 * a leak saying only "Marine Supply" is still invisible to the term scan.
 * The gate guarantees the list has HEARD of every scanned business; choosing
 * terms distinctive enough to bite is still the operator's judgment.
 */
const MIN_TERM_LEN = 4;

/** "Town-ST__Business-Name" -> "Business Name", or null when the folder is not a client slug. */
function nameFromSlug(slug) {
  const idx = slug.indexOf('__');
  if (idx === -1) return null;
  const business = slug.slice(idx + 2).replace(/-+/g, ' ').trim();
  return business === '' ? null : business;
}

function covered(name, terms) {
  const hay = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const floor = Math.min(MIN_TERM_LEN, Math.max(1, hay.length));
  return terms.some((t) => {
    const needle = String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
    return needle.length >= floor && hay.includes(needle);
  });
}

/** The scanned names no term covers, in input order, deduped. */
function missingCoverage(names, terms) {
  const out = [];
  const seen = new Set();
  for (const n of names) {
    const key = String(n).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!covered(n, terms)) out.push(n);
  }
  return out;
}

/**
 * Every business name data/ knows about, as { name, slug } rows.
 * Missing files and unreadable JSON yield fewer rows, never a throw:
 * preflight's other checks still run on a machine with no data yet.
 */
function harvestScannedNames(dataRoot) {
  const bySlug = new Map();

  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(dataRoot, 'approvals.json'), 'utf8'));
    const rows = Array.isArray(ledger) ? ledger : Array.isArray(ledger?.items) ? ledger.items : [];
    for (const row of rows) {
      if (row && typeof row.slug === 'string' && typeof row.candidateName === 'string' && row.candidateName.trim() !== '') {
        bySlug.set(row.slug, row.candidateName.trim());
      }
    }
  } catch {
    /* no ledger, or not yet readable: the clients/ walk below still runs */
  }

  try {
    for (const entry of fs.readdirSync(path.join(dataRoot, 'clients'), { withFileTypes: true })) {
      if (!entry.isDirectory() || bySlug.has(entry.name)) continue;
      const name = nameFromSlug(entry.name);
      if (name) bySlug.set(entry.name, name);
    }
  } catch {
    /* no clients folder yet */
  }

  return [...bySlug.values()];
}

/**
 * What is KNOWN to be text, listed explicitly. The first version listed
 * binary extensions instead and the adversary pass walked straight through
 * it: .heic (the iPhone camera default), .tiff, office formats, database
 * files and every extensionless blob were all "not binary" to that list and
 * published unexamined. A gate that enumerates the enemy fails open on the
 * enemy it forgot; enumerating the friendly set fails closed. svg is text on
 * purpose: it is markup, reads as text, and IS scanned.
 */
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|json|md|markdown|html|htm|css|yml|yaml|txt|sh|ps1|bat|cmd|xml|svg|csv|tsv|example|conf|ini|toml|sql|nvmrc|editorconfig)$/i;
const TEXT_BASENAMES = new Set([
  'LICENSE', 'LICENCE', 'NOTICE', 'CODEOWNERS', 'Dockerfile', 'Makefile',
  '.gitignore', '.gitattributes', '.nvmrc', '.npmrc', '.editorconfig',
  '.binary-allow', '.scrub-terms',
]);

/**
 * Tracked files no leak scan can vouch for: not known text, not allowlisted.
 * Allowlist lines are exact repo paths (git's forward slashes); # comments
 * and blanks are ignored.
 */
function nonTextFiles(trackedFiles, allowLines) {
  const allowed = new Set(
    (allowLines || [])
      .map((l) => String(l).trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
  );
  return trackedFiles.filter((f) => {
    const base = f.split('/').pop() ?? f;
    if (TEXT_EXT.test(f) || TEXT_BASENAMES.has(base)) return false;
    return !allowed.has(f);
  });
}

module.exports = {
  MIN_TERM_LEN,
  nameFromSlug,
  covered,
  missingCoverage,
  harvestScannedNames,
  nonTextFiles,
};

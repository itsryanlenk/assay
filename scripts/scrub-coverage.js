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

/**
 * The scanned names no term covers, in input order, deduped.
 *
 * `dismissed` is the reviewed-and-not-identifying list, and it exists because
 * the harvest below reads names a scanned site chose, not names this repo
 * chose. A real capture typed a Person node whose name was an ordinary
 * English job word. Demanding a scrub term for that would put that word on
 * the term list, and the term scan would then stop the build for every
 * tracked file using it in its ordinary sense. A reviewed dismissal is a
 * deliberate act with no blast radius; a dangerous term is neither. Comments
 * and blanks are ignored, same convention as .binary-allow.
 */
function missingCoverage(names, terms, dismissed) {
  const waived = new Set(
    (dismissed || [])
      .map((l) => String(l).trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.toLowerCase())
  );
  const out = [];
  const seen = new Set();
  for (const n of names) {
    const key = String(n).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (waived.has(key)) continue;
    if (!covered(n, terms)) out.push(n);
  }
  return out;
}

/**
 * IDENTIFYING node types. Narrow on purpose.
 *
 * The harvest has to catch the human and the product and stop there. A
 * FAQPage Question carries page copy in `name`, a BreadcrumbList ListItem
 * carries "Blog", and an ItemList carries whatever the site felt like: making
 * the operator add a scrub term per FAQ question would retire the gate within
 * a week. These are the types whose `name` is a party rather than a phrase.
 */
const IDENTIFYING_TYPES = new Set([
  'organization', 'person', 'product', 'softwareapplication', 'brand',
  'localbusiness', 'store', 'professionalservice', 'newsletterservice',
  'corporation', 'ngo', 'educationalorganization', 'newsmediaorganization',
]);

const isIdentifyingType = (t) =>
  IDENTIFYING_TYPES.has(t) || t.endsWith('business') || t.endsWith('store');

/**
 * Every identifying entity name one captured document names, at any depth.
 *
 * The business-name harvest above reads folder slugs and ledger rows, so it
 * only ever knows the party this app went looking for. It cannot know the
 * owner the site names on its About page or the product it sells, and on
 * 2026-08-19 that gap let a scanned client's product name and two lines of
 * their FAQ sit in a tracked source comment with both leak gates reporting
 * PASS. schema.org hangs exactly those names one key down, at `author`,
 * `founder` and `brand`, so this walks rather than reading the top of a
 * graph. Malformed JSON-LD yields nothing, the way a parser sees it.
 */
function entityNamesIn(text) {
  const out = [];
  const push = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s !== '' && !out.includes(s)) out.push(s);
  };

  const walk = (v, depth, seen) => {
    if (!v || typeof v !== 'object' || depth > 8 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1, seen);
      return;
    }
    const t = v['@type'];
    const types = (Array.isArray(t) ? t : [t])
      .filter((x) => typeof x === 'string')
      .map((x) => x.toLowerCase());
    if (types.some(isIdentifyingType)) push(v.name);
    for (const x of Object.values(v)) walk(x, depth + 1, seen);
  };

  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(text).matchAll(re)) {
    try {
      walk(JSON.parse((m[1] || '').trim()), 0, new Set());
    } catch {
      /* malformed JSON-LD names nobody, which is what a parser sees */
    }
  }

  // og:site_name is the other place a site states who it is, and it survives
  // on pages that carry no JSON-LD at all.
  const og = String(text).match(
    /<meta\b[^>]*property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']+)["']/i
  );
  if (og) push(og[1]);

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

/**
 * Every identifying name the captured documents under a data root state.
 *
 * Reads the text files a scan wrote. Size-capped per file and unreadable
 * files skipped, because this runs on every preflight and a gate that makes
 * the build slow is a gate somebody turns off.
 */
const MAX_HARVEST_BYTES = 4 * 1024 * 1024;

function harvestCapturedNames(dataRoot) {
  const out = [];
  const seen = new Set();
  const add = (n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };

  const walkDir = (dir, depth) => {
    if (depth > 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walkDir(p, depth + 1);
        continue;
      }
      if (!/\.(html?|txt|json|md)$/i.test(e.name)) continue;
      try {
        if (fs.statSync(p).size > MAX_HARVEST_BYTES) continue;
        for (const n of entityNamesIn(fs.readFileSync(p, 'utf8'))) add(n);
      } catch {
        /* an unreadable capture names nobody */
      }
    }
  };

  for (const sub of ['captures', 'clients']) walkDir(path.join(dataRoot, sub), 0);
  return out;
}

module.exports = {
  MIN_TERM_LEN,
  IDENTIFYING_TYPES,
  nameFromSlug,
  covered,
  missingCoverage,
  harvestScannedNames,
  entityNamesIn,
  harvestCapturedNames,
  nonTextFiles,
};

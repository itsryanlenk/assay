/**
 * Publication preflight. Run: npm run preflight
 *
 * The suite's scrub guard scans a fixed set of directories. This scans every
 * file git would actually publish, which is the question that matters at
 * release, and it is the check that caught a key-shaped test fixture that
 * would have tripped GitHub's push protection on the first push.
 *
 * Operator-specific terms come from an untracked `.scrub-terms`, one per line.
 * Without that file the generic patterns still run, so a fresh clone gets the
 * path, email and secret checks even though it has no personal list.
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// The patterns live in one place, shared with the scrub guard in
// test-parsers.js. They used to be restated in both and drifted the way
// duplicated rules do. The FILE SETS stay different on purpose: this scans
// what git would publish, the guard scans what is on disk.
const LEAKS = require('./leak-patterns.js');
const scrub = LEAKS.scrubTermsState(ROOT);
const terms = scrub.terms;

/**
 * -z and quotepath=false, everywhere a path leaves git. With the default
 * quoting, a non-ASCII filename comes back octal-escaped inside double
 * quotes: readFileSync then throws on the mangled path (silently skipping
 * the file's content scan), and the trailing quote defeats every
 * extension-anchored check. A screenshot named after a business, saved from
 * a Mac (NFD names), was the adversary's reproduced escape. NUL-separated
 * output has no quoting at all.
 */
function gitPaths(args) {
  return execSync(`git -c core.quotepath=false ${args} -z`, { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

let files;
try {
  files = gitPaths('ls-files');
} catch {
  console.log('\n--- PREFLIGHT ---\n\n  SKIPPED, not a git checkout so there is no publish set to inspect.\n');
  process.exit(0);
}

let bad = 0;
const flag = (f, why) => {
  console.log(`  LEAK  ${f}  <-  ${why}`);
  bad++;
};

/**
 * GATE 1. A missing term list is a failure, not zero terms.
 *
 * `.scrub-terms` is untracked by design, so it exists on exactly one machine.
 * Everywhere else this scanned for zero operator terms and still printed PASS,
 * which is the worst kind of gate: the check most likely to catch a real client
 * name reported success while doing nothing. A fork with genuinely nothing to
 * scrub declares that by committing an empty file, and the declaration is
 * deliberate rather than accidental.
 */
const scrubMissing = !scrub.present;

/**
 * GATE 2. Nothing under the data root may ever be tracked.
 *
 * The app now writes to `data/` inside the checkout so an operator has one
 * answer to "where are my files". That folder holds third-party businesses'
 * captured pages and the operator's own API keys. It is gitignored, and an
 * ignore rule is one `git add -f` or one bad merge away from publishing a real
 * client's packet. Neither the other guard nor this scan would notice: this one
 * reads tracked files, and reading them is already too late.
 */
let trackedData = [];
try {
  trackedData = gitPaths('ls-files -- data');
} catch {
  trackedData = [];
}

/**
 * GATE 3. Every business data/ knows about must be covered by the term list.
 *
 * Both leaks that forced the history rebuild were details of businesses this
 * app itself had scanned, and the rule that would have caught them
 * ("anything the app scans goes in .scrub-terms the same day") lived in
 * memory. This reads the approval ledger and the client folders and refuses
 * the build for any scanned name the term list has never heard of. Skipped
 * when the term list itself is missing: GATE 1 already fails that run, and
 * coverage against an empty list would just name every client twice.
 */
/**
 * BOTH roots the app can be using. data-root.ts honours ASSAY_DATA_DIR
 * before the install-dir default, so a gate that only read ROOT/data passed
 * vacuously for an operator running with the override set: zero names
 * harvested, zero uncovered, PASS having examined nothing, the exact
 * reported-success-while-doing-nothing failure GATE 1 exists to kill.
 * Harvesting the union also keeps old scans in the retired root covered.
 */
const COV = require('./scrub-coverage.js');
const dataRoots = [process.env.ASSAY_DATA_DIR, path.join(ROOT, 'data')].filter(Boolean);
const scannedNames = [...new Set(dataRoots.flatMap((r) => COV.harvestScannedNames(r)))];
const uncovered = scrub.present ? COV.missingCoverage(scannedNames, terms) : [];

/**
 * GATE 4. A tracked binary must be allowlisted by name.
 *
 * Every scan in this repo reads text. A tracked image is published
 * unexamined, and pixels carry a business's name and phone number as well as
 * bytes do; a screenshot is exactly how that happens. `.binary-allow` is
 * tracked and holds one repo path per line, so a binary entering the publish
 * set is always a deliberate, reviewed act rather than a quiet `git add -A`.
 */
let allowLines = [];
try {
  allowLines = fs.readFileSync(path.join(ROOT, '.binary-allow'), 'utf8').split('\n');
} catch {
  /* no allowlist file means nothing is allowed */
}
const unallowed = COV.nonTextFiles(files, allowLines);

/**
 * `git ls-files` is the publish set, which is the right thing to scan and also
 * a trap: a brand new file is untracked, so it is invisible here until it is
 * staged. I hit this immediately after writing this script, on a new handoff
 * document. Untracked and not ignored means "about to be published and never
 * checked", so name them rather than silently skipping them.
 */
const untracked = gitPaths('ls-files --others --exclude-standard');

for (const f of files) {
  if (f === 'scripts/preflight.js') continue; // it names the patterns it bans
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  } catch {
    continue; // binary or unreadable, nothing to scan
  }
  for (const reason of LEAKS.leaksIn(text, terms)) flag(f, reason);
}

console.log('\n--- PREFLIGHT ---\n');

if (scrubMissing) {
  console.log(`  NO ${LEAKS.SCRUB_TERMS_FILE}. The operator-term scan checked NOTHING, and a run`);
  console.log('  that checks nothing must not report PASS. This file is untracked on');
  console.log('  purpose, so it does not travel with a clone.');
  console.log('');
  console.log('    - Carrying it from another machine? Copy it in.');
  console.log('    - Genuinely nothing to scrub? Declare that, and this passes:');
  console.log(`        echo "# no operator terms on this machine" > ${LEAKS.SCRUB_TERMS_FILE}`);
  console.log('');
  bad++;
}

if (trackedData.length) {
  console.log(`  ${trackedData.length} file(s) under data/ are TRACKED BY GIT. That folder holds`);
  console.log('  captured third-party pages and the operator API keys, and it is meant to');
  console.log('  be ignored. Untrack them before this goes anywhere:');
  for (const f of trackedData.slice(0, 20)) console.log(`    ${f}`);
  if (trackedData.length > 20) console.log(`    ... and ${trackedData.length - 20} more`);
  console.log('');
  console.log('    git rm -r --cached data');
  console.log('');
  bad++;
}

if (uncovered.length) {
  console.log(`  ${uncovered.length} scanned business(es) in data/ have no ${LEAKS.SCRUB_TERMS_FILE} entry covering`);
  console.log('  them. A scan the term list has never heard of is a leak the term scan');
  console.log('  cannot catch, which is how both history leaks happened. Add each name:');
  for (const n of uncovered.slice(0, 10)) console.log(`    ${n}`);
  if (uncovered.length > 10) console.log(`    ... and ${uncovered.length - 10} more`);
  console.log('');
  bad++;
}

if (unallowed.length) {
  console.log(`  ${unallowed.length} tracked file(s) are neither known text nor listed in .binary-allow.`);
  console.log('  Every leak scan here reads text, so anything else publishes unexamined,');
  console.log("  and pixels carry a business's name as well as bytes do. Eyeball each");
  console.log('  one, then list it:');
  for (const f of unallowed.slice(0, 20)) console.log(`    ${f}`);
  console.log('');
  bad++;
}

if (untracked.length) {
  console.log(`  ${untracked.length} untracked file(s) were NOT scanned, because they are not in the`);
  console.log('  publish set yet. Stage them and run again before publishing:');
  for (const f of untracked.slice(0, 20)) console.log(`    ${f}`);
  if (untracked.length > 20) console.log(`    ... and ${untracked.length - 20} more`);
  console.log('');
}
if (bad) {
  console.log(`  ${bad} problem(s) in the publish set, FAIL\n`);
} else {
  console.log(
    `  ${files.length} tracked files, ${terms.length} operator term(s) checked.\n` +
      `  Nothing under data/ is tracked. ${scannedNames.length} scanned business(es) covered by the term list.\n` +
      '  No unallowed binaries, no user paths, no key-shaped strings, no live email domains, PASS\n'
  );
}
process.exit(bad ? 1 : 0);

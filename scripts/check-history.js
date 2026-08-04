/**
 * The leak gate, applied to COMMITS rather than to the working tree.
 *
 * Why this exists. Both existing gates answer "is the tree clean right now":
 * preflight walks `git ls-files`, the scrub guard walks src/ and scripts/ on
 * disk. Neither has ever looked at a commit. So a leak could be introduced,
 * committed, pushed, and then scrubbed from the tip, and every gate would
 * report PASS while the data sat in an ancestor commit that GitHub serves
 * forever. That is exactly what happened on 2026-08-03: a live prospect's
 * name, address and phone numbers went into a regression fixture, the tip was
 * cleaned, preflight passed, and the blob was still public.
 *
 * A tree-clean gate cannot catch a history leak. This one can.
 *
 * Commit MESSAGES are scanned too, not just trees. Two of the leaks that
 * forced the 2026-08-04 rebuild sat in commit messages, where no file walker
 * will ever look, and a message is published exactly as permanently as a blob.
 *
 * Usage:
 *   node scripts/check-history.js              # every commit not on origin/main
 *   node scripts/check-history.js <range>      # any git rev-list range
 *
 * Wire it to pre-push and the class closes.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const LEAKS = require('./leak-patterns');

const ROOT = path.resolve(__dirname, '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Text files only. A binary blob cannot carry a term we would recognise. */
const TEXTUAL = /\.(js|ts|tsx|json|md|yml|yaml|html|css|txt|sh|ps1)$/i;

/**
 * Noreply hosts a co-author trailer legitimately carries, exempt by DOMAIN
 * rather than by line. An earlier version stripped whole trailer lines
 * before scanning, which also hid a client name, phone or address that a
 * trailer happened to carry, and a leak in a commit message is the exact
 * class that forced the 2026-08-04 rebuild. Killed by the release-day
 * adversary pass. Every character of every message is scanned; the one
 * finding excused is "this well-known noreply host appeared". (Bare
 * domains, not addresses, so this file cannot flag itself.)
 */
const SAFE_MESSAGE_DOMAINS = new Set(['anthropic.com', 'users.noreply.github.com']);

function excusedMessageFinding(reason) {
  const prefix = 'email domain ';
  return reason.startsWith(prefix) && SAFE_MESSAGE_DOMAINS.has(reason.slice(prefix.length));
}

function main() {
  const range = process.argv[2] || defaultRange();
  if (!range) {
    console.log('\n--- HISTORY LEAK SCAN ---\n  No range to scan.\n');
    return 0;
  }

  const state = LEAKS.scrubTermsState(ROOT);
  if (!state.present) {
    console.error(
      `\n--- HISTORY LEAK SCAN ---\n  REFUSING: ${LEAKS.SCRUB_TERMS_FILE} is missing, so the ` +
        `operator-term half of this gate would check nothing.\n`
    );
    return 1;
  }

  let commits;
  try {
    commits = git(['rev-list', range]).split('\n').filter(Boolean);
  } catch {
    // A gate that cannot resolve what it was asked to scan must refuse, the
    // same way the missing-.scrub-terms branch above refuses: exiting 0 here
    // let a typo'd or unresolvable range publish unscanned history.
    console.error(`\n--- HISTORY LEAK SCAN ---\n  REFUSING: range "${range}" is not resolvable, so nothing was scanned.\n`);
    return 1;
  }

  /**
   * What the published branch already contains, so this gate reports what
   * THIS work adds rather than re-litigating existing debt.
   *
   * Without it the gate fails on every push for anything already on main,
   * and a gate that always fails is a gate everyone learns to skip. Existing
   * findings are still counted and printed as a reminder; they just do not
   * fail the push.
   */
  const baseline = new Set();
  try {
    const base = range.split('..')[0];
    for (const file of git(['ls-tree', '-r', '--name-only', base]).split('\n').filter((f) => f && TEXTUAL.test(f))) {
      let text;
      try {
        text = git(['show', `${base}:${file}`]);
      } catch {
        continue;
      }
      for (const reason of LEAKS.leaksIn(text, state.terms)) baseline.add(`${file}|${reason}`);
    }
  } catch {
    /* no baseline: every finding is treated as new, which fails safe */
  }

  const problems = [];
  const preExisting = new Set();
  let blobsScanned = 0;

  for (const commit of commits) {
    const files = git(['ls-tree', '-r', '--name-only', commit])
      .split('\n')
      .filter((f) => f && TEXTUAL.test(f));
    for (const file of files) {
      let text;
      try {
        text = git(['show', `${commit}:${file}`]);
      } catch {
        continue;
      }
      blobsScanned++;
      for (const reason of LEAKS.leaksIn(text, state.terms)) {
        if (baseline.has(`${file}|${reason}`)) {
          preExisting.add(`${file}  <-  ${reason}`);
          continue;
        }
        problems.push(`${commit.slice(0, 9)}  ${file}  <-  ${reason}`);
      }
    }

    // Every commit in the range is new work, so a message finding has no
    // baseline to be excused by.
    let message = '';
    try {
      message = git(['show', '-s', '--format=%B', commit]);
    } catch {
      /* an unreadable message scans as empty */
    }
    for (const reason of LEAKS.leaksIn(message, state.terms)) {
      if (excusedMessageFinding(reason)) continue;
      problems.push(`${commit.slice(0, 9)}  (commit message)  <-  ${reason}`);
    }
  }

  console.log('\n--- HISTORY LEAK SCAN ---');
  console.log(`  ${commits.length} commit(s), trees and messages, ${blobsScanned} blob(s), ${state.terms.length} term(s).`);
  if (preExisting.size) {
    console.log(`  ${preExisting.size} finding(s) already present on the base, not introduced here:`);
    for (const p of [...preExisting].slice(0, 6)) console.log(`    note  ${p}`);
  }
  if (problems.length) {
    // Deduped: one leak repeated across twenty commits is one thing to fix.
    for (const p of [...new Set(problems)].slice(0, 40)) console.log(`  LEAK  ${p}`);
    console.log(
      `\n  ${problems.length} problem(s) in history, FAIL.\n` +
        `  A leak in an ancestor commit is published even when the tip is clean.\n` +
        `  Rewrite the offending commits, trees and messages both, then re-run this.\n`
    );
    return 1;
  }
  console.log('  No leaks in any commit on this range, PASS\n');
  return 0;
}

/** Everything this branch adds on top of the published main. */
function defaultRange() {
  for (const base of ['origin/main', 'main']) {
    try {
      git(['rev-parse', '--verify', base]);
      return `${base}..HEAD`;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

process.exit(main());

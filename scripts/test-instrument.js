/**
 * The calibration gate. The README says the scoring instrument is calibrated
 * against two delivered client scans which publish three scored properties.
 * Until this file existed, nothing proved the instrument still reproduced
 * those three numbers; the claim was a comment. Now a change to a weight, a
 * rounding rule, or the N/A machinery fails the build instead of shipping a
 * different number under the same instrument version.
 *
 * The item values below are the published rubric rows from the instrument
 * header in src/main/scoring/instrument.ts. Client identity is deliberately
 * absent, as it is there; the operator holds the mapping.
 *
 * Also pinned here: the agent CLI lockout (Law 1's agent half). The lockout
 * is three argv flags, and until now no test asserted they were constructed,
 * so it enforced neither a test nor a type. Now it is a test.
 *
 * Run: npm run test:instrument
 */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const I = require(path.join(ROOT, 'dist/main/main/scoring/instrument.js'));
const CLI = require(path.join(ROOT, 'dist/main/main/agent/cli.js'));

let pass = 0;
const failures = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n      expected ${e}\n      got      ${a}`);
}

function ok(name, cond) {
  if (cond) pass++;
  else failures.push(name);
}

const item = (id, earned, note, extra = {}) => ({ id, earned, na: false, note, ...extra });

// --- the instrument itself, before the scans --------------------------------
// Each weight pinned by value, not just the sum: a swap between two items
// preserves the sum and every total below, and still changes what a client
// document prints per row. Caught by an adversarial pass on this suite.
eq('published item weights, each pinned', I.ITEM_WEIGHTS, {
  'crawler-access': 25,
  'llms-txt': 15,
  'entity-schema': 20,
  'faq-page': 15,
  'product-review': 15,
  'plain-words': 15,
});
eq('weights sum to 105 at full measurement',
  Object.values(I.ITEM_WEIGHTS).reduce((a, b) => a + b, 0), 105);
eq('only product-review may be N/A', I.NA_ELIGIBLE, ['product-review']);
eq('only plain-words may mark points out, and only 5',
  I.PARTIAL_NA_POINTS, { 'plain-words': 5 });

// --- SCAN A, property 1: published 24/100, raw 25 of 105 --------------------
{
  const s = I.scoreFrom([
    item('crawler-access', 12, 'retrieval bots open, training bots blocked'),
    item('llms-txt', 0, '404'),
    item('entity-schema', 0, 'no JSON-LD at all'),
    item('faq-page', 0, 'no FAQ written'),
    item('product-review', 0, 'free product, no Offer node'),
    item('plain-words', 13, 'title and description present, category in plain words'),
  ]);
  eq('scan A property 1 raw', s.raw, 25);
  eq('scan A property 1 base', s.base, 105);
  eq('scan A property 1 published score', s.rescaled, 24);
}

// --- SCAN A, property 2: published 68/100, raw 71 of 105 --------------------
{
  const s = I.scoreFrom([
    item('crawler-access', 25, 'nothing blocked'),
    item('llms-txt', 12, 'real hand-written file, money page missing'),
    item('entity-schema', 14, 'Org + WebSite + SearchAction, no founder'),
    item('faq-page', 6, 'FAQPage on one guide page, absent on the paid page'),
    item('product-review', 0, 'three priced tiers, no Offer node'),
    item('plain-words', 14, 'category said in the industry\'s own words'),
  ]);
  eq('scan A property 2 raw', s.raw, 71);
  eq('scan A property 2 base', s.base, 105);
  eq('scan A property 2 published score', s.rescaled, 68);
}

// --- SCAN B: published 29/100, raw 26 of 90, product-review N/A -------------
// The deliverable publishes the totals and the N/A, and does not publish a
// per-item split, so the split below is one legal decomposition of raw 26.
// What this pins is the published arithmetic: N/A leaves both numerator and
// denominator, the base lands at 90, and 26 of 90 prints as 29.
{
  const s = I.scoreFrom([
    item('crawler-access', 12, 'retrieval open, training blocked'),
    item('llms-txt', 0, 'absent'),
    item('entity-schema', 0, 'no JSON-LD'),
    item('faq-page', 0, 'no FAQ'),
    item('product-review', 0, 'sells nothing at all; stores are separate entities', { na: true }),
    item('plain-words', 14, 'plain-words present'),
  ]);
  eq('scan B raw', s.raw, 26);
  eq('scan B base with product-review N/A', s.base, 90);
  eq('scan B published score', s.rescaled, 29);
  ok('scan B sentence names the N/A so the client can recompute',
    I.scoreSentence(s).includes('N/A') && I.scoreSentence(s).includes('26 of 90'));
}

// The rounding rule needs no assertion of its own: 25/105 is 23.81 and 26/90
// is 28.89, so a floor ships 23 and 28 where the deliverables printed 24 and
// 29, and the scan fixtures above fail. Verified by breaking it.

// --- partial NA: the vocabulary 5 leaves numerator and denominator ----------
// Rule 3 applied to part of an item. Base 100 with the 5 marked out, base 85
// with product-review N/A as well, and any other marked-out number throws.
{
  const partial = (extraProduct) => [
    item('crawler-access', 25, 'open'),
    item('llms-txt', 0, 'absent'),
    item('entity-schema', 0, 'none'),
    item('faq-page', 0, 'none'),
    extraProduct
      ? item('product-review', 0, 'sells nothing at all', { na: true })
      : item('product-review', 0, 'no Offer node'),
    item('plain-words', 8, 'category term missing from the listing', { naPoints: 5 }),
  ];

  const s100 = I.scoreFrom(partial(false));
  eq('vocabulary 5 marked out lands the base at 100', s100.base, 100);
  eq('and the raw total keeps the earned 8', s100.raw, 33);
  eq('and 33 of 100 prints as 33', s100.rescaled, 33);
  ok('the sentence names the marked-out points so the client can recompute',
    I.scoreSentence(s100).includes('marked out') && I.scoreSentence(s100).includes('33 of 100'));

  const s85 = I.scoreFrom(partial(true));
  eq('N/A plus the vocabulary 5 lands the base at 85', s85.base, 85);
  eq('and 33 of 85 prints as 39', s85.rescaled, 39);

  let threw = null;
  try {
    I.scoreFrom([
      item('crawler-access', 25, 'open'),
      item('llms-txt', 0, 'x'),
      item('entity-schema', 0, 'x'),
      item('faq-page', 0, 'x'),
      item('product-review', 0, 'x'),
      item('plain-words', 8, 'x', { naPoints: 3 }),
    ]);
  } catch (e) { threw = e; }
  ok('marking out any number but the declared 5 throws', threw instanceof Error);
}

// --- rule 3: no number from an unmeasured item ------------------------------
{
  let threw = null;
  try {
    I.scoreFrom([
      item('crawler-access', 25, 'open'),
      item('llms-txt', 0, 'could not fetch', { unknown: true }),
      item('entity-schema', 0, 'x'),
      item('faq-page', 0, 'x'),
      item('product-review', 0, 'x'),
      item('plain-words', 0, 'x'),
    ]);
  } catch (e) { threw = e; }
  ok('an unmeasured item refuses the whole number',
    threw instanceof I.InsufficientCaptureError);
}

// --- the agent CLI lockout (Law 1, agent half) ------------------------------
// Spawns nothing. Asserts the argv the provider constructs carries the three
// flags that deny the model tools, MCP servers and settings-sourced anything.
{
  const args = CLI.__test.buildArgs({ systemPrompt: 'x', prompt: 'y' });
  // Each flag must appear exactly once: a second occurrence later in the argv
  // would win in most CLI parsers, so "present once with the empty value" is
  // the assertion, not merely "present".
  const onceWithEmpty = (flag) =>
    args.indexOf(flag) !== -1 &&
    args.indexOf(flag) === args.lastIndexOf(flag) &&
    args[args.indexOf(flag) + 1] === '';
  ok('agent CLI denies all tools (--tools "", exactly once)', onceWithEmpty('--tools'));
  ok('agent CLI refuses ambient MCP config (--strict-mcp-config, exactly once)',
    args.indexOf('--strict-mcp-config') !== -1 &&
    args.indexOf('--strict-mcp-config') === args.lastIndexOf('--strict-mcp-config'));
  ok('agent CLI reads no settings sources (--setting-sources "", exactly once)',
    onceWithEmpty('--setting-sources'));
}

// --- report -----------------------------------------------------------------
console.log('\n--- INSTRUMENT CALIBRATION ---');
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
}
console.log(`\n  ${pass}/${pass + failures.length} passed${failures.length ? ', FAIL' : ', PASS'}\n`);
process.exit(failures.length ? 1 : 0);

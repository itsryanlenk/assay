/**
 * Packet generation has two walls, and both are the kind that fail silently if
 * they fail at all. A generator that writes an unconfirmed claim to disk, or
 * that launders an invented statistic into a client document, produces an
 * artifact that looks exactly like a correct one. So both are tested against
 * the behaviours rather than the happy path.
 *
 * Run: npm run test:packet
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const G = require(path.join(ROOT, 'dist/main/main/packet/generate.js'));
const GR = require(path.join(ROOT, 'dist/main/main/packet/guardrails.js'));
const P = require(path.join(ROOT, 'dist/main/main/packet/paths.js'));

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass++;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}

const OUT = path.join(os.tmpdir(), `packet-test-${process.pid}`);

const candidate = {
  placeId: 'p1', name: 'Example Boutique', address: '170 Harbor Rd, Rockport, ME 00000, USA',
  location: null, website: 'https://example-boutique.test', phone: '(555) 555-0142',
  rating: null, reviewCount: null, businessStatus: 'OPERATIONAL', primaryType: 'clothing_store',
  mapsUri: null, discoveredAt: new Date().toISOString(), source: 'google-places-new',
};

const evidence = [{
  id: 'e1', url: 'https://example-boutique.test/', source: 'operator-browser', method: 'GET',
  httpStatus: 200, contentType: 'text/html', fetchedAt: new Date().toISOString(),
  sha256: 'a'.repeat(64), byteLength: 41234, storedPath: '(test)',
}];

const confirmedFinding = {
  checkId: 'website', status: 'flaw', severity: 3,
  headline: 'Your homepage has no title tag, so search engines have nothing to show.',
  detail: 'The page works but has no title element.',
  evidence, confirmation: 'operator-confirmed',
  fix: { summary: 'Add a title tag naming the business.', effort: 'minutes' },
};

const remoteFinding = { ...confirmedFinding, confirmation: 'remote' };

const operator = { name: 'Operator', email: 'hello@example.test', scannerUrl: 'https://example.test/scan' };
const base = { candidate, outputRoot: OUT, operator };

/** A minimal renderer, so the walls are tested independent of real artifacts. */
const plain = (text) => () => ({ kind: 'Scorecard', ext: 'md', text });

(async () => {
  // --- WALL 1: unconfirmed findings are never written ---------------------
  let threw = null;
  try {
    await G.generatePacket(
      { ...base, findings: [remoteFinding], confirmedAt: new Date().toISOString() },
      [plain('Fine copy with no problems.')]
    );
  } catch (e) { threw = e; }
  ok('a remote finding refuses generation', threw instanceof G.NotReleasableError, String(threw));
  ok('nothing was written when generation refused', !fs.existsSync(path.join(OUT, 'clients')),
    'clients/ exists after a refused generation');

  threw = null;
  try {
    await G.generatePacket({ ...base, findings: [confirmedFinding], confirmedAt: null }, [plain('Fine.')]);
  } catch (e) { threw = e; }
  ok('a never-confirmed packet refuses generation', threw instanceof G.NotReleasableError);

  threw = null;
  const stale = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
  try {
    await G.generatePacket({ ...base, findings: [confirmedFinding], confirmedAt: stale }, [plain('Fine.')]);
  } catch (e) { threw = e; }
  ok('an expired confirmation refuses generation', threw instanceof G.NotReleasableError);

  // --- WALL 2: bad copy refuses, and leaves nothing behind ----------------
  const fresh = new Date().toISOString();
  const badCopies = [
    ['an invented percentage', 'This change delivers 40% more traffic to the shop.'],
    ['a fabricated testimonial', 'Customers say the new page is much easier to use.'],
    ['a guarantee', 'This will guarantee better placement in results.'],
    ['a banned AI word', 'A robust and seamless fix for the homepage.'],
    ['an em dash', `A fine sentence ${String.fromCharCode(0x2014)} with a dash in it.`],
    ['a curly quote', 'The page’s title is missing.'],
    ['an unsourced number', 'We reviewed 37 competitor pages in the area.'],
  ];
  for (const [label, text] of badCopies) {
    let caught = null;
    try {
      await G.generatePacket({ ...base, findings: [confirmedFinding], confirmedAt: fresh }, [plain(text)]);
    } catch (e) { caught = e; }
    ok(`copy guardrail rejects ${label}`, caught && caught.name === 'GuardrailError',
      `got ${caught && caught.name}: ${caught && caught.message}`);
  }

  ok('no artifact survived a guardrail refusal', !fs.existsSync(path.join(OUT, 'clients')),
    'clients/ exists after refusals only');

  // --- The happy path -----------------------------------------------------
  // Numbers that came from the findings must be allowed through; the sweep
  // must not be so strict that real measurements cannot be reported.
  const good = 'The homepage returned HTTP 200 and 41234 bytes. Adding a title tag takes minutes.';
  const res = await G.generatePacket(
    { ...base, findings: [confirmedFinding], confirmedAt: fresh },
    [plain(good)]
  );
  ok('a confirmed packet with clean copy generates', res.artifacts.length === 1);
  ok('measured numbers are allowed through the sweep',
    GR.sweep(good, G.allowedFactsFrom([confirmedFinding])).length === 0,
    JSON.stringify(GR.sweep(good, G.allowedFactsFrom([confirmedFinding]))));
  ok('the artifact is on disk', fs.existsSync(res.artifacts[0].absolutePath));
  ok('00-INDEX was written',
    fs.existsSync(path.join(OUT, 'clients', res.slug, '00-INDEX.md')));

  const index = fs.readFileSync(path.join(OUT, 'clients', res.slug, '00-INDEX.md'), 'utf8');
  ok('00-INDEX states the free tier is exactly three', /exactly three artifacts/.test(index));
  ok('00-INDEX records the confirmation timestamp', index.includes(fresh));
  ok('00-INDEX warns about the 72 hour expiry', /72 hours/.test(index));

  /**
   * 01-evidence has existed in the folder layout since the first packet and
   * nothing has ever written to it. 00-INDEX documents it as "raw captures,
   * crawler and operator, hashed" and every finding in the same file cites a
   * sha256, so a reader opening the packet to check a claim finds an empty
   * directory and no way to get from a hash to the bytes it names.
   *
   * The captures the packet actually cites are copied in beside it, which is
   * also what makes a client folder portable: it can be handed to somebody
   * else without the app, the cache, or an explanation.
   */
  {
    const CAP = path.join(os.tmpdir(), `cap-${process.pid}.html`);
    fs.writeFileSync(CAP, '<html>the bytes that were read</html>');
    const OUTE = path.join(os.tmpdir(), `packet-ev-${process.pid}`);
    const stored = {
      ...evidence[0], id: 'e-stored', storedPath: CAP,
      sha256: 'c'.repeat(64), url: 'https://example-boutique.test/about',
    };
    const withStored = { ...confirmedFinding, evidence: [stored] };
    const r2 = await G.generatePacket(
      { ...base, outputRoot: OUTE, findings: [withStored], confirmedAt: fresh },
      [plain('A clean artifact.')]
    );
    const evDir = path.join(OUTE, 'clients', r2.slug, '01-evidence');
    const files = fs.readdirSync(evDir);
    ok('the folder the index documents is not empty', files.length > 0, JSON.stringify(files));
    ok('the captured bytes are there, unchanged',
      files.some((f) => {
        try { return fs.readFileSync(path.join(evDir, f), 'utf8').includes('the bytes that were read'); }
        catch { return false; }
      }), JSON.stringify(files));

    const manifest = fs.readFileSync(path.join(evDir, '00-CAPTURES.md'), 'utf8');
    ok('a manifest ties each file back to its URL', manifest.includes('https://example-boutique.test/about'), manifest);
    ok('and to the hash the packet cites', manifest.includes('c'.repeat(12)), manifest);

    /**
     * THE MANIFEST IS A CLIENT-FACING DOCUMENT AND MUST PASS LAW 2.
     *
     * It was written after the guardrail sweep had already run, which is the
     * same defect the 00-INDEX comment in generate.ts documents being fixed
     * once before. Its URLs come from the scanned site, so on a hostile or
     * compromised target they are attacker-controlled text landing unescaped
     * in a document the client trusts because the operator sent it.
     */
    const hostile = {
      ...evidence[0], id: 'e-hostile', storedPath: CAP, sha256: 'd'.repeat(64),
      url: 'https://evil.test/x)+[Reset+your+password](https://phish.test/go',
    };
    const OUTH = path.join(os.tmpdir(), `packet-ev-h-${process.pid}`);
    const rh = await G.generatePacket(
      { ...base, outputRoot: OUTH, findings: [{ ...confirmedFinding, evidence: [hostile] }], confirmedAt: fresh },
      [plain('A clean artifact.')]
    );
    const manH = fs.readFileSync(
      path.join(OUTH, 'clients', rh.slug, '01-evidence', '00-CAPTURES.md'), 'utf8');
    // Inertness is structural, not textual: the payload is still readable, it
    // is just inside a code span, so no markdown renderer turns it into a
    // link. Asserting the bytes are absent would be asserting the wrong thing.
    const urlCell = manH.split('\n').find((l) => l.includes('phish.test')).split('|')[2].trim();
    ok('a hostile URL is confined to a code span',
      urlCell.startsWith('`') && urlCell.endsWith('`'), urlCell);
    ok('and cannot close that span to escape it',
      urlCell.slice(1, -1).includes('`') === false, urlCell);
    ok('the URL is still shown, so the manifest stays checkable',
      manH.includes('phish.test'), manH);

    // A pipe would end the table cell early and shunt the rest into columns
    // that mean something else.
    const piped = {
      ...evidence[0], id: 'e-pipe', storedPath: CAP, sha256: 'e'.repeat(64),
      url: 'https://evil.test/a|200|999999|deadbeefcafe',
    };
    const OUTP = path.join(os.tmpdir(), `packet-ev-p-${process.pid}`);
    const rp = await G.generatePacket(
      { ...base, outputRoot: OUTP, findings: [{ ...confirmedFinding, evidence: [piped] }], confirmedAt: fresh },
      [plain('A clean artifact.')]
    );
    const manP = fs.readFileSync(
      path.join(OUTP, 'clients', rp.slug, '01-evidence', '00-CAPTURES.md'), 'utf8');
    ok('a URL cannot forge extra table columns',
      manP.split('\n').filter((l) => l.includes('evil.test')).every((l) => l.split('|').length === 8),
      manP);

    // Sweeping the manifest without allowing what it measures would refuse
    // real packets at random, which is the hash-prefix bug in 9631aa8 again.
    const numeric = {
      ...evidence[0], id: 'e-num', storedPath: CAP, sha256: 'f'.repeat(64),
      url: 'https://example-boutique.test/sitemap-2024-07.xml',
    };
    let numThrew = null;
    const OUTN = path.join(os.tmpdir(), `packet-ev-n-${process.pid}`);
    try {
      await G.generatePacket(
        { ...base, outputRoot: OUTN, findings: [{ ...confirmedFinding, evidence: [numeric] }], confirmedAt: fresh },
        [plain('A clean artifact.')]
      );
    } catch (e) { numThrew = e; }
    ok('digits inside a fetched URL do not refuse the packet',
      numThrew === null, numThrew && numThrew.message);

    // And the sweep really does cover it: banned copy reaching the manifest
    // has to refuse, before anything is written.
    const bannedUrl = {
      ...evidence[0], id: 'e-ban', storedPath: CAP, sha256: '9'.repeat(64),
      url: 'https://example-boutique.test/seamless-robust-delve',
    };
    let banThrew = null;
    const OUTB2 = path.join(os.tmpdir(), `packet-ev-b-${process.pid}`);
    try {
      await G.generatePacket(
        { ...base, outputRoot: OUTB2, findings: [{ ...confirmedFinding, evidence: [bannedUrl] }], confirmedAt: fresh },
        [plain('A clean artifact.')]
      );
    } catch (e) { banThrew = e; }
    ok('the manifest is inside the guardrail sweep, not after it',
      banThrew && banThrew.name === 'GuardrailError', `threw=${banThrew && banThrew.name}`);
    ok('and the refusal happens before anything is written',
      !fs.existsSync(path.join(OUTB2, 'clients')), '');

    /**
     * The capture filename is built from the hash and the source. Both are set
     * in-process today, so this is not reachable, and it is four lines to make
     * it unreachable by construction rather than by audit.
     */
    const traversal = {
      ...evidence[0], id: 'e-trav', storedPath: CAP,
      sha256: '../../../../evil', source: '../../also-evil',
      url: 'https://example-boutique.test/t',
    };
    const OUTT = path.join(os.tmpdir(), `packet-ev-t-${process.pid}`);
    await G.generatePacket(
      { ...base, outputRoot: OUTT, findings: [{ ...confirmedFinding, evidence: [traversal] }], confirmedAt: fresh },
      [plain('A clean artifact.')]
    );
    const travDir = path.join(OUTT, 'clients');
    /**
     * Asserts on the NAME the manifest produces, not on probe files.
     *
     * Two rewrites of this test were vacuous. Probing for files called `evil`
     * and `also-evil` could never fire: the hash is truncated to twelve
     * characters, so `../../../../evil` becomes exactly `../../../../` and
     * the escaped file is named `__crawler.html`. Removing the sanitizer
     * entirely still passed. The value is the thing under test, so the test
     * now resolves it and checks containment directly. Found by the
     * pre-merge verification pass, which proved it by mutation.
     */
    const evidenceDirT = path.join(travDir, fs.readdirSync(travDir)[0], '01-evidence');
    // renderCaptureManifest takes FINDINGS. Handing it the evidence object
    // directly returned an empty file list and made the assertion vacuous a
    // third time; the SETUP line below now proves the list is non-empty
    // before anything is concluded from it.
    const namesFor = (ev) =>
      G.renderCaptureManifest([{ ...confirmedFinding, evidence: [ev] }]).files.map((f) => f.name);

    // Control first: an ordinary capture IS named, so the zero below means
    // "refused" rather than "this function never names anything".
    const goodNames = namesFor({ ...traversal, sha256: 'a'.repeat(64), source: 'crawler' });
    ok('SETUP: an ordinary capture is named in the manifest',
      goodNames.length === 1 && goodNames[0].startsWith('a'.repeat(12)),
      JSON.stringify(goodNames));

    const travNames = namesFor(traversal);
    ok('SETUP: the traversal fixture really does carry a climbing hash',
      traversal.sha256.includes('..'), traversal.sha256);
    ok('a hash that is not hex names no file at all, so nothing can walk out',
      travNames.length === 0, JSON.stringify(travNames));
    ok('and every name the manifest does produce resolves inside 01-evidence',
      goodNames.every((n) =>
        path.resolve(evidenceDirT, n).startsWith(path.resolve(evidenceDirT) + path.sep)),
      JSON.stringify(goodNames));
    ok('and every capture file written stays inside 01-evidence',
      fs.readdirSync(path.join(travDir, fs.readdirSync(travDir)[0], '01-evidence'))
        .every((f) => !f.includes('..') && !f.includes('/') && !f.includes('\\')), '');

    for (const d of [OUTH, OUTP, OUTN, OUTB2, OUTT]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    // A capture the app never managed to store must not silently look present.
    const OUTU = path.join(os.tmpdir(), `packet-ev-u-${process.pid}`);
    const r3 = await G.generatePacket(
      { ...base, outputRoot: OUTU, findings: [confirmedFinding], confirmedAt: fresh },
      [plain('A clean artifact.')]
    );
    const man3 = fs.readFileSync(
      path.join(OUTU, 'clients', r3.slug, '01-evidence', '00-CAPTURES.md'), 'utf8');
    ok('an unstored capture is listed as not kept rather than omitted',
      /not kept|not stored/i.test(man3), man3);

    for (const d of [OUTE, OUTU]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    try { fs.rmSync(CAP, { force: true }); } catch { /* best effort */ }
  }

  // --- the delivery vehicles must not contradict the scorecard -------------
  // REGRESSION from the first real packet. The postcard and the social post
  // each kept ONE fixed sentence per checkId, and for ai-readiness it read
  // "your homepage carries no structured data telling AI assistants who you
  // are or what you do". ai-readiness is SIX items. That business scored 13 of
  // 20 on entity schema, with Organization and WebSite both present and named
  // as such in the scorecard, so the postcard would have been mailed to them
  // asserting the opposite of the document in the same envelope.
  {
    const PC = require(path.join(ROOT, 'dist/main/main/packet/render/postcard.js'));
    const SO = require(path.join(ROOT, 'dist/main/main/packet/render/social.js'));

    // That business HAD published the answers and had not marked them up,
    // which is variant `unmarked`. Saying so explicitly is the point: the
    // second block below is the same fixture with the other variant, and the
    // two must not produce the same sentence.
    const items = [
      { id: 'crawler-access', label: 'AI crawlers allowed', earned: 25, possible: 25, na: false, note: 'nothing blocked' },
      { id: 'entity-schema', label: 'Entity schema', earned: 13, possible: 20, na: false, note: 'Organization + WebSite' },
      { id: 'faq-page', label: 'FAQPage', earned: 0, possible: 15, na: false, note: 'No FAQ markup', variant: 'unmarked' },
    ];
    const scored = {
      instrument: 'aeo-baseline-six-check', instrumentVersion: 't',
      raw: 62, base: 105, rescaled: 59, naItems: [], markedOut: [], items,
    };
    const aiFinding = {
      ...confirmedFinding, checkId: 'ai-readiness', severity: 2, score: scored,
      headline: 'Scores 59/100.',
      fix: { summary: 'Biggest single gain is FAQPage.', effort: 'an afternoon' },
    };
    const ctx = { candidate, findings: [aiFinding], score: scored, date: '2026-07-31', operator };

    const card = PC.postcardFrontRenderer(ctx).text;
    const post = SO.socialPostRenderer(ctx).text;

    ok('the postcard does not claim there is no structured data when there is',
      !/no structured data/i.test(card), card.slice(0, 400));
    ok('the social post does not claim it either',
      !/no structured data/i.test(post), post.slice(0, 400));

    // It should describe the item that actually lost the points: the FAQ one.
    ok('the postcard describes the item that actually lost the points',
      /quote/i.test(card), card.slice(0, 400));
    ok('the social post describes it too, as a phrase that reads as English',
      /found a business that had answered/i.test(post), post.slice(0, 300));

    // With entity-schema the worst item, saying so IS correct.
    const schemaWorst = {
      ...aiFinding,
      score: { ...scored, items: [items[0], { ...items[1], earned: 0 }, { ...items[2], earned: 15 }] },
    };
    const card2 = PC.postcardFrontRenderer({ ...ctx, findings: [schemaWorst], score: schemaWorst.score }).text;
    ok('when entity schema IS the worst item, the postcard says so',
      /hidden format/i.test(card2), card2.slice(0, 400));

    /**
     * REGRESSION from the SECOND real packet. Same three surfaces, opposite
     * error. This business had written no FAQ at all, and the scorecard said
     * so on page two: "No FAQ written and no FAQPage markup." Page one, the
     * postcard and the social post all told it that it had "already answered"
     * those questions "in writing" and only needed the markup, because one
     * static block of copy served both findings.
     */
    const nothingWritten = {
      ...aiFinding,
      score: { ...scored, items: [items[0], items[1], { ...items[2], variant: 'none', note: 'No FAQ written and no FAQPage markup.' }] },
    };
    const nwCtx = { ...ctx, findings: [nothingWritten], score: nothingWritten.score };
    const card3 = PC.postcardFrontRenderer(nwCtx).text;
    const post3 = SO.socialPostRenderer(nwCtx).text;
    const claimsWriting = /already answered|have written|had answered|written about these topics/i;

    ok('a business with no FAQ is not mailed a card saying it already wrote one',
      !claimsWriting.test(card3), card3.slice(0, 400));
    ok('and the social post does not say it either',
      !claimsWriting.test(post3), post3.slice(0, 300));
    ok('the card still names the gap rather than going vague',
      /answered|question/i.test(card3), card3.slice(0, 400));
    ok('the two FAQ findings do not produce the same card',
      card3 !== card, '');
  }

  // --- the hooks must be verdict-aware for the five score-less checks ------
  // REGRESSION from the 2026-08-03 adversarial review. worstCopy() reads the
  // finding's score, and only ai-readiness carries one, so for the other five
  // checks the postcard and the social post fell through to ONE fixed sentence
  // per checkId. Each sentence describes a single verdict shape and printed for
  // all of them: a site whose scorecard NAMED the machine-readable date it
  // found was mailed "Nothing on your site carries a date a machine can read",
  // and a site merely missing a sitemap was told it was asking not to be
  // indexed. The checks now stamp the verdict shape on the finding as
  // `variant`, and the hooks key their copy on it.
  {
    const PC = require(path.join(ROOT, 'dist/main/main/packet/render/postcard.js'));
    const SO = require(path.join(ROOT, 'dist/main/main/packet/render/social.js'));
    const PL = require(path.join(ROOT, 'dist/main/main/packet/render/plain-language.js'));

    const mk = (checkId, severity, variant, headline) => ({
      ...confirmedFinding, checkId, severity, variant, headline, detail: headline,
      fix: { summary: 'Fix it.', effort: 'minutes' },
    });
    const render = (f) => {
      const ctx = { candidate, findings: [f], score: undefined, date: '2026-08-03', operator };
      return { card: PC.postcardFrontRenderer(ctx).text, post: SO.socialPostRenderer(ctx).text };
    };

    // Confirmed case 1: freshness FOUND a machine-readable date; it is stale.
    // The scorecard in the same envelope names that date, so the card must not
    // assert there is none.
    const stale = render(mk('freshness', 3, 'stale',
      'The newest date a machine can read on this site is about thirty months old.'));
    ok('a stale-date site is not told it has no machine-readable date',
      !/no date a machine can read|nothing on your site carries a date/i.test(stale.card),
      stale.card.slice(0, 400));
    ok('the stale-date card says the date is old instead',
      /more than two years old/i.test(stale.card), stale.card.slice(0, 400));
    ok('the stale-date social post matches its verdict too',
      /more than two years old/i.test(stale.post) && !/no date a machine can read/i.test(stale.post),
      stale.post.slice(0, 300));

    // Confirmed case 2: a missing sitemap is an enumeration gap, and the card
    // accused the site of asking not to be indexed.
    const noSitemap = render(mk('crawl-index', 3, 'no-sitemap',
      'There is no sitemap.xml and robots.txt declares none.'));
    ok('a missing-sitemap site is not accused of blocking indexing',
      !/not to index|noindex/i.test(noSitemap.card), noSitemap.card.slice(0, 400));
    ok('the missing-sitemap card names the sitemap gap',
      /sitemap/i.test(noSitemap.card), noSitemap.card.slice(0, 400));
    ok('the missing-sitemap social post matches its verdict too',
      /sitemap/i.test(noSitemap.post) && !/not to index/i.test(noSitemap.post),
      noSitemap.post.slice(0, 300));

    // A real noindex still earns the strong sentence, now without "quietly",
    // which the house voice bans in public copy.
    const noindex = render(mk('crawl-index', 4, 'noindex',
      'The page tells search engines not to index it.'));
    ok('a real noindex still gets the noindex sentence',
      /telling search engines not to index it/i.test(noindex.card), noindex.card.slice(0, 400));
    ok('the noindex hook no longer says "quietly"',
      !/quietly/i.test(noindex.card) && !/quietly/i.test(noindex.post), noindex.card.slice(0, 400));

    // A page with NO contact path at all was told its contact path "lives
    // inside a script", which asserts a path exists.
    const noPath = render(mk('booking-path', 3, 'no-contact-path',
      'No tel:, mailto:, form or booking link anywhere on the page.'));
    ok('a page with no contact path at all is not told the path lives in a script',
      !/inside a script/i.test(noPath.card), noPath.card.slice(0, 400));
    ok('the no-contact-path card says the page offers software no way in',
      /no phone link/i.test(noPath.card), noPath.card.slice(0, 400));

    // A homepage that merely omits its address was accused of a phone number
    // that "does not match" the listing.
    const napGap = render(mk('nap-consistency', 2, 'address-unfindable',
      'No address matching the listing appears in the homepage source.'));
    ok('a homepage that omits its address is not accused of a phone mismatch',
      !/does not match/i.test(napGap.card), napGap.card.slice(0, 400));
    ok('the card says the listing address is unfindable in the source',
      /appears nowhere in your homepage source/i.test(napGap.card), napGap.card.slice(0, 400));

    // A site that did not load was told it "looks fine in a browser".
    const dead = render(mk('website', 2, 'unreachable', 'The listed website did not load.'));
    ok('a site that does not load is not told it looks fine in a browser',
      !/looks fine in a browser/i.test(dead.card), dead.card.slice(0, 400));

    // Same bug class in the social FRAME: "The owner had no way to know:
    // nothing about the site looked wrong from inside a normal browser" was
    // one fixed claim for every flaw, and a dead site looks very wrong from
    // inside a normal browser. The frame may only make the general claim.
    ok('the social frame no longer claims the owner could not have known',
      !/owner had no way to know|nothing about the site looked wrong/i.test(dead.post),
      dead.post.slice(0, 300));

    // A finding deserialized from an older session carries no variant. It must
    // fall back to a sentence true of any flaw, never to the old fixed claim.
    const legacy = render(mk('crawl-index', 3, undefined,
      'There is no sitemap.xml and robots.txt declares none.'));
    ok('a legacy no-variant finding falls back to a sentence true of any flaw',
      !/not to index|noindex|quietly/i.test(legacy.card), legacy.card.slice(0, 400));

    // Every verdict-copy sentence ships on a public surface, so each one has
    // to pass the same guardrail sweep the artifacts do, carry no digits, and
    // avoid the words the house voice bans in public copy.
    const entries = Object.entries(PL.VERDICT_COPY ?? {});
    ok('verdict copy covers the five score-less checks', entries.length >= 20, `got ${entries.length}`);
    for (const [k, c] of entries) {
      const joined = `${c.short} ${c.phrase}`;
      const bad = GR.sweep(joined);
      ok(`verdict copy ${k} passes the guardrail sweep`, bad.length === 0, JSON.stringify(bad));
      ok(`verdict copy ${k} carries no digits`, !/\d/.test(joined), joined);
      ok(`verdict copy ${k} avoids publicly banned words`, !/\b(quietly|honest|honestly)\b/i.test(joined), joined);
    }
  }

  // --- the schema kit must not publish a type it did not measure -----------
  // REGRESSION from a real packet. Places typed a heating and cooling company
  // as general_contractor, which mapped straight through to a GeneralContractor
  // schema type. Unlike a sentence on a scorecard this is markup the owner is
  // told to paste onto their live site, so a wrong type does not merely read
  // badly, it ships. Section 5 also dumped the whole ai-readiness detail: six
  // rubric notes run together with the page list repeated four times.
  {
    const SK = require(path.join(ROOT, 'dist/main/main/packet/render/schema-kit.js'));
    const scored = {
      instrument: 'aeo-baseline-six-check', instrumentVersion: 't',
      raw: 62, base: 105, rescaled: 59, naItems: [],
      items: [
        { id: 'crawler-access', label: 'AI crawlers allowed', earned: 25, possible: 25, na: false, note: 'nothing blocked' },
        { id: 'llms-txt', label: 'llms.txt', earned: 12, possible: 15, na: false, note: 'Real file, sectioned.' },
        { id: 'faq-page', label: 'FAQPage', earned: 0, possible: 15, na: false, note: `No FAQ written. Read across 7 page(s): ${'/a, '.repeat(7)}` },
      ],
    };
    const kitFor = (primaryType) => SK.schemaKitRenderer({
      candidate: { ...candidate, primaryType },
      findings: [{ ...confirmedFinding, checkId: 'ai-readiness', score: scored }],
      score: scored, date: '2026-07-31', operator,
    }).text;

    const umbrella = kitFor('general_contractor');
    ok('an umbrella Places bucket never becomes a published schema type',
      !/GeneralContractor/.test(umbrella), 'GeneralContractor is in the kit');
    ok('it falls back to LocalBusiness instead',
      /"@type": "LocalBusiness"/.test(umbrella), umbrella.slice(0, 200));
    ok('and the kit says the type is a floor rather than a finding',
      /safe floor, not a finding/.test(umbrella), 'no provenance caveat');

    // A specific type is still published, which is the point of the mapping.
    ok('a specific Places type is still used',
      /"@type": "ClothingStore"/.test(kitFor('clothing_store')), 'clothing_store did not map');

    // Section 5 is about robots.txt and llms.txt, not about FAQ markup.
    const section5 = umbrella.slice(umbrella.indexOf('## 5.'), umbrella.indexOf('## 6.'));
    ok('section 5 does not dump the whole readiness detail into the kit',
      !/Read across/.test(section5), section5.slice(0, 220));
    ok('section 5 still says what was seen about the two files it is about',
      /llms\.txt:/.test(section5) && /AI crawler access:/.test(section5), section5.slice(0, 220));

    /**
     * REGRESSION from the second real packet. Section 5 printed a "minimum
     * viable" robots.txt and llms.txt unconditionally. That business scored
     * 25/25 on crawler access and 12/15 for a real, sectioned llms.txt of 77
     * URLs, and the kit handed it a one-line replacement listing only the
     * homepage. Pasting what the kit recommends would have undone the two
     * things the same scan had just scored it well on.
     */
    ok('a passing llms.txt is not handed a one-line replacement',
      !/## Pages/.test(section5), section5);
    ok('and the kit says the file is already there',
      /already|leave it|do not replace/i.test(section5), section5);
    ok('a passing robots.txt is not handed a replacement either',
      !/User-agent: \*/.test(section5), section5);

    // Absent, and the starter files are exactly what they need.
    const absent = {
      ...scored,
      items: [
        { id: 'crawler-access', label: 'AI crawlers allowed', earned: 0, possible: 25, na: false, note: 'GPTBot and ClaudeBot are disallowed' },
        { id: 'llms-txt', label: 'llms.txt', earned: 0, possible: 15, na: false, note: '404, no file.' },
      ],
    };
    const missingKit = SK.schemaKitRenderer({
      candidate: { ...candidate, primaryType: 'general_contractor' },
      findings: [{ ...confirmedFinding, checkId: 'ai-readiness', score: absent }],
      score: absent, date: '2026-07-31', operator,
    }).text;
    const missing5 = missingKit.slice(missingKit.indexOf('## 5.'), missingKit.indexOf('## 6.'));
    ok('a site with no llms.txt still gets a starter file', /## Pages/.test(missing5), missing5);
    ok('a site turning crawlers away still gets a robots.txt', /User-agent: \*/.test(missing5), missing5);

    /**
     * The Sitemap: line was hardcoded to `/sitemap.xml` regardless of where the
     * scan actually found one, so the kit could tell a business to declare a
     * path that does not exist on its own site.
     */
    const withSitemap = SK.schemaKitRenderer({
      candidate: { ...candidate, primaryType: 'general_contractor' },
      findings: [
        { ...confirmedFinding, checkId: 'ai-readiness', score: absent },
        {
          ...confirmedFinding, checkId: 'crawl-index', headline: 'A crawler can get in.',
          evidence: [{ ...evidence[0], id: 'e-sm', url: 'https://example-boutique.test/sitemap_index.xml' }],
        },
      ],
      score: absent, date: '2026-07-31', operator,
    }).text;
    const sm5 = withSitemap.slice(withSitemap.indexOf('## 5.'), withSitemap.indexOf('## 6.'));
    ok('the kit declares the sitemap the scan actually read',
      /Sitemap: https:\/\/example-boutique\.test\/sitemap_index\.xml/.test(sm5), sm5);
    ok('and does not invent the conventional path beside it',
      !/Sitemap:.*\/sitemap\.xml/.test(sm5), sm5);

    /**
     * Section 3 told the reader a good title names the business, the category
     * and the town, then printed an example with no category, because the
     * Places bucket was an umbrella and nothing narrower could be read. The
     * instruction and its own example contradicted each other on the page.
     */
    const s3 = umbrella.slice(umbrella.indexOf('## 3.'), umbrella.indexOf('## 4.'));
    const promisesCategory = /names the business, the category and the town/.test(s3);
    const exampleHasCategory = /<title>[^<]*\|[^<]*\|/.test(s3);
    ok('the title rule and the title example agree with each other',
      promisesCategory === exampleHasCategory, s3);
  }

  // --- an evidence hash that happens to be all digits ----------------------
  // REGRESSION from a real run. The scorecard prints the first characters of
  // each capture's sha256 so a reader can confirm they are looking at the same
  // bytes. A hex character is a digit ten times in sixteen, so a six character
  // prefix is all digits about one time in seventeen, and across a dozen
  // captures that is better than even odds on any given packet. The sweep read
  // it as an invented figure and refused to generate. Two of the fourteen
  // hashes in the first real packet were exactly this.
  //
  // The hash is a measured fact from the app's own evidence, the same as the
  // byte count and the status code beside it, so it belongs on the allowlist.
  {
    const SC = require(path.join(ROOT, 'dist/main/main/packet/render/scorecard.js'));
    const digitHash = { ...evidence[0], id: 'e-digits', sha256: `669679${'b'.repeat(58)}` };
    const digitFinding = { ...confirmedFinding, evidence: [digitHash] };

    ok('a hash prefix that reads as digits is an allowed fact',
      GR.sweep('sha256 669679', G.allowedFactsFrom([digitFinding])).length === 0,
      JSON.stringify(GR.sweep('sha256 669679', G.allowedFactsFrom([digitFinding])).map((v) => v.found)));

    const rendered = SC.scorecardRenderer({
      candidate, findings: [digitFinding], score: null, date: '2026-07-31', operator,
    });
    const prose = rendered.text
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ');
    const violations = GR.sweep(prose, G.allowedFactsFrom([digitFinding]));
    ok('the scorecard generates when a capture hashes to digits',
      violations.length === 0, JSON.stringify(violations.map((v) => `${v.rule}: ${v.found}`)));
  }

  // --- a model-written headline cannot allowlist its own numbers -----------
  // The allowlist used to seed from f.headline, and five checks' headlines
  // are model output, so any figure the model wrote (or an operator's brand
  // voice induced) approved itself and the number wall could never fire on
  // it. Found by the adversarial pass on the brand-voice commit. A headline
  // restating a real figure stays fine, because the detail and fix that
  // carry the same figure still seed it.
  {
    const voicedFinding = {
      ...confirmedFinding,
      headline: 'Your site loses 87 of every 100 visitors before they read a word.',
    };
    const facts = G.allowedFactsFrom([voicedFinding]);
    ok('a number only the headline carries is NOT an allowed fact',
      GR.sweep('87 of every 100 visitors', facts).length > 0,
      JSON.stringify(GR.sweep('87 of every 100 visitors', facts).map((v) => v.found)));
    // The detail must carry a real DIGIT for this to mean anything: asserting
    // a digit-free sentence sweeps clean would pass however the allowlist was
    // seeded. Found by the pre-merge correctness review.
    const numeric = {
      ...voicedFinding,
      detail: 'The newest machine-readable date on this site is 31 months old.',
    };
    const numericFacts = G.allowedFactsFrom([numeric]);
    ok('SETUP: the detail carries a figure the headline does not',
      /\b31\b/.test(numeric.detail) && !/\b31\b/.test(numeric.headline), numeric.detail);
    ok('a figure the detail carries is allowed when the copy restates it',
      GR.sweep('31 months old', numericFacts).length === 0,
      JSON.stringify(GR.sweep('31 months old', numericFacts).map((v) => v.found)));
    ok('while the headline-only figure is still refused in the same finding',
      GR.sweep('87 of every 100', numericFacts).length > 0,
      JSON.stringify(GR.sweep('87 of every 100', numericFacts).map((v) => v.found)));
  }

  // --- brand on the scorecard ----------------------------------------------
  // Two properties matter: a branded document overrides exactly the three
  // accent slots and carries exactly one image, and an unbranded one carries
  // no brand markup at all, so "null brand renders as it always did" is a
  // tested property rather than a promise.
  {
    const SC = require(path.join(ROOT, 'dist/main/main/packet/render/scorecard.js'));
    const PNG_1PX =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const args = { candidate, findings: [confirmedFinding], score: null, date: '2026-07-31', operator };

    const plain = SC.scorecardRenderer({ ...args, brand: null });
    ok('an unbranded scorecard carries no image at all',
      !/<img/i.test(plain.text), (plain.text.match(/<img[^>]*>/i) || [''])[0]);
    ok('and no accent override block',
      !/--accent-bg:/.test(plain.text.split('</style>')[1] || ''), 'override found');
    ok('the accent defaults ARE the house values, so it renders as it always did',
      /--accent-bg: #F5D90A/.test(plain.text) && /--accent-on-ink: #F5D90A/.test(plain.text),
      'defaults drifted from the house palette');

    const branded = SC.scorecardRenderer({
      ...args,
      brand: { accentBg: '#1B2A5B', accentBgText: '#FFFFFF', accentOnInk: '#FFFFFF', logoDataUri: PNG_1PX },
    });
    ok('a branded scorecard overrides all three accent slots',
      /--accent-bg: #1B2A5B/.test(branded.text) && /--accent-bg-text: #FFFFFF/.test(branded.text) &&
        /--accent-on-ink: #FFFFFF/.test(branded.text),
      'override block missing');
    ok('and carries exactly one image, the operator logo',
      (branded.text.match(/<img/gi) || []).length === 1,
      String((branded.text.match(/<img/gi) || []).length));
    ok('whose source is a data: URI, never a remote address',
      /<img[^>]+src="data:image\/png;base64,/.test(branded.text),
      (branded.text.match(/<img[^>]*>/i) || [''])[0].slice(0, 120));

    // THE ONE THE DESIGN REVIEW INSISTED ON. Severity shading must stay on the
    // house scale: a sev-2 block recoloured to a client's navy while its badge
    // stayed yellow would destroy the severity encoding on a client document.
    const sev2 = { ...confirmedFinding, severity: 2 };
    const brandedSev = SC.scorecardRenderer({
      ...args,
      findings: [sev2],
      brand: { accentBg: '#1B2A5B', accentBgText: '#FFFFFF', accentOnInk: '#FFFFFF', logoDataUri: '' },
    });
    ok('severity shading still uses the house yellow, not the brand accent',
      /\.block\.yellow \{ background: var\(--color-yellow\)/.test(brandedSev.text) &&
        /class="block yellow"/.test(brandedSev.text),
      'severity block took the accent');

    const brandedFacts = G.allowedFactsFrom([confirmedFinding]);
    const brandedProse = branded.text
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ');
    ok('a branded scorecard still passes the guardrail sweep',
      GR.sweep(brandedProse, brandedFacts).length === 0,
      JSON.stringify(GR.sweep(brandedProse, brandedFacts).map((v) => `${v.rule}: ${v.found}`)));
  }

  // --- HTML artifacts become PDFs when a printer is supplied ---------------
  // The scorecard used to land as a loose .html. That is a rendering target,
  // not a deliverable: it opens differently in every browser and is trivially
  // editable after approval, which matters because the gate hashes the bytes
  // it approved. printToPDF is Electron, so generation takes the converter as
  // an injected function and stays plain Node; these prove the seam without
  // booting a browser. The real print runs in the IPC suite.
  {
    let sawHtml = null;
    const stubPdf = async (html) => {
      sawHtml = html;
      return Buffer.from('%PDF-1.7\nstub\n%%EOF\n', 'latin1');
    };
    const asHtml = () => ({ kind: 'Scorecard', ext: 'html', text: '<html><body><p>Fine copy.</p></body></html>' });

    // Its own output root. These generate Scorecard artifacts for the same
    // prospect, and a newer artifact of a kind now supersedes the older row,
    // so sharing a ledger with the tests below would have them archive each
    // other's fixtures.
    const PDF_OUT = path.join(os.tmpdir(), `packet-pdf-${process.pid}`);
    const pdfBase = { ...base, outputRoot: PDF_OUT };

    const pdfRes = await G.generatePacket(
      { ...pdfBase, findings: [confirmedFinding], confirmedAt: fresh },
      [asHtml],
      { htmlToPdf: stubPdf }
    );
    ok('an html artifact is written as .pdf when a printer is supplied',
      pdfRes.artifacts[0].filename.endsWith('.pdf'), pdfRes.artifacts[0].filename);
    ok('the pdf bytes are what got written, not the html',
      fs.readFileSync(pdfRes.artifacts[0].absolutePath).slice(0, 5).toString('latin1') === '%PDF-',
      fs.readFileSync(pdfRes.artifacts[0].absolutePath).slice(0, 12).toString('latin1'));
    ok('the printer was handed the rendered html',
      typeof sawHtml === 'string' && sawHtml.includes('Fine copy.'), String(sawHtml).slice(0, 60));
    ok('no loose .html is left beside the pdf',
      !fs.existsSync(pdfRes.artifacts[0].absolutePath.replace(/\.pdf$/, '.html')),
      pdfRes.artifacts[0].absolutePath.replace(/\.pdf$/, '.html'));
    ok('the queue row points at the pdf, so the gate hashes the real deliverable',
      pdfRes.queue.some((q) => q.absolutePath === pdfRes.artifacts[0].absolutePath),
      JSON.stringify(pdfRes.queue.map((q) => q.filename)));
    ok('the recorded byte count is the pdf, not the html',
      pdfRes.artifacts[0].bytes === fs.statSync(pdfRes.artifacts[0].absolutePath).size,
      `${pdfRes.artifacts[0].bytes} vs ${fs.statSync(pdfRes.artifacts[0].absolutePath).size}`);

    // A failed print must fail the generation. Falling back to HTML would hand
    // over a different artifact than the one that was asked for, and the
    // operator would find out when a prospect opened it.
    let printThrew = null;
    try {
      await G.generatePacket(
        { ...pdfBase, findings: [confirmedFinding], confirmedAt: fresh },
        [asHtml],
        { htmlToPdf: async () => { throw new Error('printer exploded'); } }
      );
    } catch (e) { printThrew = e; }
    ok('a failed print fails the generation rather than falling back to html',
      printThrew !== null, String(printThrew));

    // Markdown is untouched: only html is a rendering target.
    const mdRes = await G.generatePacket(
      { ...pdfBase, findings: [confirmedFinding], confirmedAt: fresh },
      [plain('Fine copy with no problems.')],
      { htmlToPdf: stubPdf }
    );
    ok('a markdown artifact is left alone', mdRes.artifacts[0].filename.endsWith('.md'),
      mdRes.artifacts[0].filename);
  }

  // --- Phase 6: generation feeds the approval queue -----------------------
  // Generated artifacts used to enter the queue nowhere at all: prepare()
  // existed, was tested, and had no caller, so Law 3's enforcement point sat
  // beside the pipeline instead of in it. prepare() is now called from inside
  // generatePacket rather than left to the caller, because a rule that every
  // future call site has to remember to opt into is not a rule.
  {
    const AG = require(path.join(ROOT, 'dist/main/main/approval/gate.js'));

    ok('generation returns the approval queue',
      Array.isArray(res.queue) && res.queue.length === 1,
      JSON.stringify(res.queue && res.queue.map((q) => `${q.filename}:${q.state}`)));
    ok('the ledger is on disk', fs.existsSync(path.join(OUT, 'approvals.json')));

    const row = AG.loadQueue(OUT).find((q) => q.filename === res.artifacts[0].filename);
    ok('every generated artifact is in the ledger', !!row,
      JSON.stringify(AG.loadQueue(OUT).map((q) => q.filename)));
    ok('a generated artifact is PREPARED, never approved',
      row && row.state === 'prepared', row && row.state);
    ok('the ledger row points at the artifact actually written',
      row && row.absolutePath === res.artifacts[0].absolutePath && fs.existsSync(row.absolutePath),
      row && row.absolutePath);

    // REGRESSION. The row has to carry the candidate name so a caller can tie
    // it to a confirmation by equality. The renderer used to infer it, by
    // testing whether the normalised name was a SUBSTRING of the slug, and any
    // two prospects whose names nest cross-matched. releasable() only checks
    // that findings are confirmed and unexpired, never that they belong to
    // this artifact, so that near-miss minted a real token against another
    // business's view-source rather than failing safe.
    ok('the ledger row records which candidate it belongs to',
      row && row.candidateName === candidate.name,
      row && `candidateName=${row.candidateName} expected=${candidate.name}`);

    /**
     * Drives the real gate rather than comparing two literals in this file.
     * The old version reduced to 'Example Boutique' !== 'Example', which is
     * true no matter what findingsBelong does, so the substring-matching
     * regression its comment describes was never exercised. Found by the
     * pre-merge correctness review.
     */
    const nests = { ...candidate, name: 'Example' };
    ok('SETUP: one candidate name nests inside the other',
      candidate.name.startsWith(nests.name) && candidate.name !== nests.name,
      `${nests.name} vs ${candidate.name}`);
    AG.approve(OUT, row.itemId, [{ ...confirmedFinding, candidateName: candidate.name }], fresh);
    ok('the gate refuses a token minted against the nesting name',
      AG.tokenFor(OUT, row.itemId, [{ ...confirmedFinding, candidateName: nests.name }], fresh) === null,
      'a prefix of the real name was accepted as the same candidate');
    ok('and still mints for the candidate that really owns the row',
      AG.tokenFor(OUT, row.itemId, [{ ...confirmedFinding, candidateName: candidate.name }], fresh) !== null,
      'the real candidate was refused');

    // Law 3: approving is a separate act, and regenerating must not undo it.
    // A finished branded PDF sitting in a folder already looks done, so the
    // only thing that may move an item out of 'prepared' is the operator.
    const approved = AG.approve(OUT, row.itemId, [confirmedFinding], fresh);
    ok('an operator can approve a prepared artifact',
      approved.item.filename === row.filename);

    const again = await G.generatePacket(
      { ...base, findings: [confirmedFinding], confirmedAt: fresh },
      [plain(good)]
    );
    const afterRow = again.queue.find((q) => q.itemId === row.itemId);
    ok('regenerating never downgrades an approved decision back to prepared',
      afterRow && afterRow.state === 'approved', afterRow && afterRow.state);

    // An unreadable ledger has to stop generation BEFORE any file is written.
    // Discovering it afterwards leaves a finished packet in a client folder
    // that the approval gate has never heard of, which is precisely the state
    // the gate exists to make impossible.
    const OUT2 = path.join(os.tmpdir(), `packet-ledger-${process.pid}`);
    fs.mkdirSync(OUT2, { recursive: true });
    fs.writeFileSync(path.join(OUT2, 'approvals.json'), 'not json', 'utf8');
    let ledgerThrew = null;
    try {
      await G.generatePacket(
        { candidate, outputRoot: OUT2, operator, findings: [confirmedFinding], confirmedAt: fresh },
        [plain(good)]
      );
    } catch (e) { ledgerThrew = e; }
    ok('an unreadable approval ledger refuses generation', !!ledgerThrew, String(ledgerThrew));
    ok('nothing was written when the ledger was unreadable',
      !fs.existsSync(path.join(OUT2, 'clients')), 'clients/ exists');
    try { fs.rmSync(OUT2, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // --- REGRESSION: fix text is a source of allowed numbers ----------------
  // allowedFactsFrom originally scanned only headline and detail, so a real
  // freshness finding (snippet: "datePublished": "2026-07-29") produced four
  // unsourced-number violations and generatePacket threw on any candidate
  // whose fix carried a date or a phone. The wall was right; its list of what
  // the app had measured was incomplete.
  const realFreshness = {
    checkId: 'freshness', status: 'flaw', severity: 3,
    headline: 'Your homepage carries no dates a machine can read.',
    detail: 'The site publishes a blog and the homepage carries no machine-readable dates.',
    evidence, confirmation: 'operator-confirmed',
    fix: {
      summary: 'Add datePublished and dateModified to the structured data.',
      effort: 'an afternoon',
      snippet: '"datePublished": "2026-07-29",\n"dateModified": "2026-07-29"',
    },
  };
  ok('a fix snippet containing a date passes the sweep',
    GR.sweep(`${realFreshness.fix.summary} ${realFreshness.fix.snippet}`,
      G.allowedFactsFrom([realFreshness])).length === 0,
    JSON.stringify(GR.sweep(`${realFreshness.fix.summary} ${realFreshness.fix.snippet}`,
      G.allowedFactsFrom([realFreshness])).map((v) => v.found)));

  const realBooking = {
    checkId: 'booking-path', status: 'flaw', severity: 2,
    headline: 'Your phone number is not tappable.',
    detail: 'A number is visible but carries no tel link.',
    evidence, confirmation: 'operator-confirmed',
    fix: {
      summary: 'Add the number as a tel link.', effort: 'minutes',
      snippet: '<a href="tel:+15555550142">(555) 555-0142</a>',
    },
  };
  ok('a fix snippet containing a phone number passes the sweep',
    GR.sweep(`${realBooking.fix.summary} ${realBooking.fix.snippet}`,
      G.allowedFactsFrom([realBooking])).length === 0,
    JSON.stringify(GR.sweep(`${realBooking.fix.summary} ${realBooking.fix.snippet}`,
      G.allowedFactsFrom([realBooking])).map((v) => v.found)));

  // The exemption must stay narrow. Widening allowedFactsFrom to include fix
  // text must not become a hole an invented figure can walk through.
  const bothAllowed = G.allowedFactsFrom([realFreshness, realBooking]);
  ok('an invented number is still rejected alongside real fix numbers',
    GR.sweep('Adding this lifts you 40% in three weeks.', bothAllowed).length > 0,
    'an unmeasured 40 passed the sweep');
  ok('a percentage-result claim is caught as fabrication specifically',
    GR.sweep('This change delivers 40% more traffic.', bothAllowed)
      .some((v) => v.rule === 'possible fabrication'),
    JSON.stringify(GR.sweep('This change delivers 40% more traffic.', bothAllowed).map((v) => v.rule)));

  // --- Naming -------------------------------------------------------------
  ok('slug leads with town and state',
    res.slug.startsWith('Rockport-ME__'), res.slug);
  ok('drafts live under 02-drafts with the date',
    res.draftsDir.includes(path.join('02-drafts', res.date)), res.draftsDir);
  ok('filename carries business, artifact and date',
    /^Example-Boutique__Scorecard__\d{4}-\d{2}-\d{2}\.md$/.test(res.artifacts[0].filename),
    res.artifacts[0].filename);
  ok('the scorecard is marked free tier', res.artifacts[0].freeTier === true);
  ok('a postcard is not free tier',
    P.FREE_TIER.includes('Postcard-Front') === false);

  // --- All-or-nothing writing ---------------------------------------------
  // A violation in the LAST artifact must not leave earlier ones on disk.
  const OUT2 = path.join(os.tmpdir(), `packet-test2-${process.pid}`);
  let caught2 = null;
  try {
    await G.generatePacket(
      { ...base, outputRoot: OUT2, findings: [confirmedFinding], confirmedAt: fresh },
      [plain('Clean first artifact.'), plain('Second one promises 90% growth.')]
    );
  } catch (e) { caught2 = e; }
  ok('a violation in the last artifact writes none of them',
    caught2 && caught2.name === 'GuardrailError' && !fs.existsSync(path.join(OUT2, 'clients')),
    `threw=${caught2 && caught2.name} clientsExists=${fs.existsSync(path.join(OUT2, 'clients'))}`);

  // --- 00-INDEX is prospect-facing copy and was never swept ----------------
  // REGRESSION. The index prints EVERY finding's headline, including ones the
  // scorecard leaves out (it renders only status 'flaw'). Those headlines are
  // model-written. So the one artifact reproducing all of them was the one
  // artifact that never passed Law 2, and it was written after the sweep loop,
  // which also meant a violation could still leave it on disk.
  const OUT3 = path.join(os.tmpdir(), `packet-test3-${process.pid}`);
  const sneaky = {
    checkId: 'ai-readiness', status: 'ok', severity: 0,
    // Never reaches the scorecard, because the scorecard renders flaws only.
    headline: 'This site is a seamless, robust delve into best-in-class design.',
    detail: 'Scored.', evidence, confirmation: 'operator-confirmed',
  };
  let caught3 = null;
  try {
    await G.generatePacket(
      { ...base, outputRoot: OUT3, findings: [confirmedFinding, sneaky], confirmedAt: fresh },
      [plain('A clean artifact.')]
    );
  } catch (e) { caught3 = e; }
  ok('banned copy in a non-flaw headline is caught by the index sweep',
    caught3 && caught3.name === 'GuardrailError', `threw=${caught3 && caught3.name}`);
  ok('the index sweep refuses before anything is written',
    !fs.existsSync(path.join(OUT3, 'clients')),
    `clientsExists=${fs.existsSync(path.join(OUT3, 'clients'))}`);

  for (const d of [OUT, OUT2, OUT3]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

  // --- where everything lands ------------------------------------------------
  //
  // Until now every path in the app hung off Electron's userData, which on
  // Windows is %APPDATA%/assay: client packets, raw captures of third-party
  // sites and the API keys, sitting in the same directory as Chromium's own
  // Preferences and lockfile. The operator could not answer "where are my
  // files" without knowing an Electron convention. One root, next to the
  // install, and it is the same answer for every artifact.
  const DR = require(path.join(ROOT, 'dist/main/main/config/data-root.js'));

  const always = () => true;
  const never = () => false;

  {
    const c = DR.resolveDataRoot({ anchor: '/app', fallback: '/appdata', canWrite: always });
    ok('the install folder wins when it is writable',
      c.root === path.join('/app', 'data') && c.reason === 'install', JSON.stringify(c));
  }

  // The layout is the documentation. Anyone opening the folder should be able
  // to tell what each entry is without being told, which means Chromium's
  // thirteen profile files cannot sit in the same list as the five that are
  // ours. They go in one clearly-not-yours subfolder and stop being noise.
  {
    const L = DR.layout('/root');
    ok('the client work is under one obvious name', L.clients === path.join('/root', 'clients'), JSON.stringify(L));
    ok('raw captures are named for what they are', L.captures === path.join('/root', 'captures'), '');
    ok('the one file an operator edits is at the top', L.config === path.join('/root', 'config.json'), '');
    ok("Electron's profile is out of the way", L.chromium === path.join('/root', '.chromium'), '');

    const HOME = path.join(os.tmpdir(), `dr-readme-${process.pid}`);
    fs.mkdirSync(HOME, { recursive: true });
    DR.writeDataReadme(HOME);
    const readme = fs.readFileSync(path.join(HOME, 'README.md'), 'utf8');
    // Every top-level name the app creates has to be explained in there, or
    // the folder still needs a person to explain it.
    for (const name of ['clients', 'captures', 'config.json', 'approvals.json', '.chromium', '.superseded']) {
      ok(`the README explains ${name}`, readme.includes(name), readme.slice(0, 300));
    }
    ok('and it says which folders are safe to delete', /safe to delete|regenerat/i.test(readme), '');
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  {
    const c = DR.resolveDataRoot({ anchor: '/app', fallback: '/appdata', canWrite: never });
    ok('a read-only install folder falls back rather than bricking the app',
      c.root === '/appdata' && c.reason === 'fallback', JSON.stringify(c));
  }
  {
    const c = DR.resolveDataRoot({
      anchor: '/app', fallback: '/appdata', override: '  /chosen  ', canWrite: always,
    });
    ok('an explicit override wins over the install folder, trimmed',
      c.root === '/chosen' && c.reason === 'override', JSON.stringify(c));
  }
  {
    // Silently writing somewhere else is the exact complaint this change
    // exists to answer, so an override that cannot be used has to say so.
    const c = DR.resolveDataRoot({
      anchor: '/app', fallback: '/appdata', override: '/chosen',
      canWrite: (d) => d !== '/chosen',
    });
    ok('an unusable override does not fail silently',
      c.root === path.join('/app', 'data') && /chosen/.test(c.note), JSON.stringify(c));
  }
  {
    const c = DR.resolveDataRoot({ anchor: '/app', fallback: '/appdata', override: '   ', canWrite: always });
    ok('a blank override is treated as unset',
      c.reason === 'install', JSON.stringify(c));
  }

  // Migration: the operator already has a config with live API keys and a
  // client packet in the old location. Moving the root must not strand them.
  {
    const OLD = path.join(os.tmpdir(), `dr-old-${process.pid}`);
    const NEW = path.join(os.tmpdir(), `dr-new-${process.pid}`);
    fs.mkdirSync(path.join(OLD, 'packets', 'clients', 'Anytown__Example'), { recursive: true });
    fs.mkdirSync(path.join(OLD, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(OLD, 'config.json'), '{"keys":{"googlePlaces":"K"}}');
    fs.writeFileSync(path.join(OLD, 'packets', 'clients', 'Anytown__Example', '00-INDEX.md'), '# x');
    fs.writeFileSync(path.join(OLD, 'packets', 'approvals.json'), '[{"id":"a"}]');
    fs.writeFileSync(path.join(OLD, 'evidence', 'cap.html'), '<html></html>');
    fs.writeFileSync(path.join(OLD, 'Preferences'), '{"chromium":true}');
    fs.mkdirSync(NEW, { recursive: true });

    const moved = DR.migrateLegacyData(OLD, NEW);
    ok('the config comes across, so the keys do not vanish',
      fs.existsSync(path.join(NEW, 'config.json')), `moved=${JSON.stringify(moved)}`);
    ok('client folders land under the name the new layout uses',
      fs.existsSync(path.join(NEW, 'clients', 'Anytown__Example', '00-INDEX.md')), JSON.stringify(moved));
    ok('the approval ledger comes with them',
      fs.existsSync(path.join(NEW, 'approvals.json')), JSON.stringify(moved));
    ok('and the capture cache is renamed to what it actually is',
      fs.existsSync(path.join(NEW, 'captures', 'cap.html')), JSON.stringify(moved));
    ok('the old nesting is not recreated in the new root',
      !fs.existsSync(path.join(NEW, 'packets')), '');
    ok("Chromium's own files are left where they were",
      !fs.existsSync(path.join(NEW, 'Preferences')), '');
    ok('the originals are left in place, so a bad migration is not a data loss',
      fs.existsSync(path.join(OLD, 'config.json')), '');

    // Second boot. Overwriting here would revert edits made since the move.
    fs.writeFileSync(path.join(NEW, 'config.json'), '{"keys":{"googlePlaces":"NEWER"}}');
    DR.migrateLegacyData(OLD, NEW);
    ok('a second boot does not clobber what is already there',
      fs.readFileSync(path.join(NEW, 'config.json'), 'utf8').includes('NEWER'), '');

    ok('an already-current root has nothing left to do',
      DR.migrateLegacyData(NEW, NEW).length === 0, '');

    /**
     * Migration copies and never deletes, which is right, and on its own it
     * made the folder WORSE: the first real run left `evidence/` beside
     * `captures/`, `packets/` beside `clients/`, and thirteen loose Chromium
     * files from when userData pointed at the root. Twenty-three entries in the
     * one directory that is supposed to be readable at a glance.
     *
     * Superseded entries go into one dot-folder. Nothing is destroyed, and
     * there is exactly one thing to delete once the operator is satisfied.
     */
    fs.mkdirSync(path.join(NEW, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(NEW, 'packets'), { recursive: true });
    fs.writeFileSync(path.join(NEW, 'Preferences'), '{}');
    fs.writeFileSync(path.join(NEW, 'Local State'), '{}');
    fs.mkdirSync(path.join(NEW, 'GPUCache'), { recursive: true });

    const swept = DR.tidyDataRoot(NEW);
    ok('the superseded copy of the capture cache is swept aside',
      !fs.existsSync(path.join(NEW, 'evidence')), JSON.stringify(swept));
    ok('so is the old packets nesting', !fs.existsSync(path.join(NEW, 'packets')), '');
    ok("and Chromium's files left loose in the root",
      !fs.existsSync(path.join(NEW, 'Preferences')) && !fs.existsSync(path.join(NEW, 'GPUCache')), '');
    ok('nothing is destroyed, it is all in one place',
      fs.existsSync(path.join(NEW, '.superseded', 'evidence')) &&
        fs.existsSync(path.join(NEW, '.superseded', 'Preferences')), '');
    ok('what the app actually uses is untouched',
      fs.existsSync(path.join(NEW, 'clients')) && fs.existsSync(path.join(NEW, 'config.json')) &&
        fs.existsSync(path.join(NEW, 'captures')), '');
    ok('a second sweep finds nothing to do', DR.tidyDataRoot(NEW).length === 0, '');

    // A later upgrade must not destroy what an earlier one set aside. The
    // first version rmSync'd the destination before renaming onto it.
    fs.mkdirSync(path.join(NEW, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(NEW, 'evidence', 'round-two.txt'), 'x');
    DR.tidyDataRoot(NEW);
    ok('the copy parked by an earlier sweep survives a later one',
      fs.existsSync(path.join(NEW, '.superseded', 'evidence')), '');
    ok('and the later one is kept beside it rather than dropped',
      fs.existsSync(path.join(NEW, '.superseded', 'evidence-2', 'round-two.txt')), '');

    // The live profile must never be swept: it is in use while the app runs.
    fs.mkdirSync(path.join(NEW, '.chromium'), { recursive: true });
    DR.tidyDataRoot(NEW);
    ok('the live Chromium profile is left alone', fs.existsSync(path.join(NEW, '.chromium')), '');

    // Refuses to orphan data: no `captures/` means `evidence/` is still the
    // only copy and must stay exactly where it is.
    const ORPH = path.join(os.tmpdir(), `dr-orph-${process.pid}`);
    fs.mkdirSync(path.join(ORPH, 'evidence'), { recursive: true });
    DR.tidyDataRoot(ORPH);
    ok('an old folder with no replacement is not swept away',
      fs.existsSync(path.join(ORPH, 'evidence')), '');
    try { fs.rmSync(ORPH, { recursive: true, force: true }); } catch { /* best effort */ }

    // The shape shipped by the first pass of this move: right root, old names.
    const MID = path.join(os.tmpdir(), `dr-mid-${process.pid}`);
    fs.mkdirSync(path.join(MID, 'packets', 'clients', 'Anytown__Example'), { recursive: true });
    fs.writeFileSync(path.join(MID, 'packets', 'clients', 'Anytown__Example', '00-INDEX.md'), '# x');
    ok('a root left in the intermediate layout heals itself in place',
      DR.migrateLegacyData(MID, MID).length > 0 &&
        fs.existsSync(path.join(MID, 'clients', 'Anytown__Example', '00-INDEX.md')), '');
    try { fs.rmSync(MID, { recursive: true, force: true }); } catch { /* best effort */ }

    for (const d of [OLD, NEW]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  console.log('\n--- PACKET GENERATION TESTS ---');
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\n  ${pass}/${pass + failures.length} passed${failures.length ? ', FAIL' : ', PASS'}\n`);
  process.exit(failures.length ? 1 : 0);
})();

/**
 * The confirmation gate is the wall everything downstream trusts. If it can be
 * walked around, every law in this project is decoration. So it is tested
 * against the behaviours that matter rather than its happy path.
 *
 * Run: npm run test:confirm
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { runChecks } = require(path.join(ROOT, 'dist/main/main/checks/registry.js'));
const { napConsistencyCheck } = require(path.join(ROOT, 'dist/main/main/checks/nap-consistency.js'));
const { crawlIndexCheck } = require(path.join(ROOT, 'dist/main/main/checks/crawl-index.js'));
const { websiteCheck } = require(path.join(ROOT, 'dist/main/main/checks/website.js'));
const G = require(path.join(ROOT, 'dist/main/main/confirmation/gate.js'));
const P = require(path.join(ROOT, 'dist/main/main/confirmation/policy.js'));

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass++;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}

const EV = path.join(os.tmpdir(), `confirm-test-${process.pid}`);

/** An agent that never runs: confirmation must not depend on a model. */
const deadAgent = {
  id: 'cli',
  label: 'stub',
  probe: async () => ({ available: false, detail: 'stub' }),
  run: async () => ({ ok: false, text: '', durationMs: 0, error: { kind: 'not_available', message: 'stub' } }),
};

const candidate = {
  placeId: 'test', name: 'Test Shop', address: '1 Main St, Anytown, PA 00000',
  location: null, website: 'https://example-shop.test', phone: '(717) 555-0100',
  rating: null, reviewCount: null, businessStatus: 'OPERATIONAL',
  primaryType: null, mapsUri: null, discoveredAt: new Date().toISOString(),
  source: 'google-places-new',
};

// A page with NO dates and a blog link -> freshness flags it.
const PAGE_UNDATED = `<html><head><title>Test Shop Home Page</title>
<meta name="description" content="Test Shop sells handmade goods in Anytown and has done for years.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Store","name":"Test Shop","telephone":"+1-717-555-0100"}</script>
</head><body><a href="/blogs/news">Blog</a><p>${'Handmade goods. '.repeat(30)}</p></body></html>`;

// Same page, but dated -> freshness is clean. Used to force a divergence.
const PAGE_DATED = PAGE_UNDATED.replace(
  '"telephone":"+1-717-555-0100"',
  '"telephone":"+1-717-555-0100","datePublished":"2026-07-20","dateModified":"2026-07-28"'
);

const ROBOTS = 'User-agent: *\nAllow: /\n\nSitemap: https://example-shop.test/sitemap.xml\n';

async function crawlerRunFrom(html) {
  const cap = (url) => ({
    ref: {
      id: url, url, source: 'crawler', method: 'GET', httpStatus: 200,
      contentType: url.endsWith('.txt') ? 'text/plain' : 'text/html',
      fetchedAt: new Date().toISOString(),
      sha256: require('node:crypto').createHash('sha256').update(url + html).digest('hex'),
      byteLength: html.length, storedPath: '(test)',
    },
    body: url.includes('robots') ? ROBOTS : url.includes('.xml') || url.includes('llms') || url.includes('agents') ? '' : html,
    captured: true,
  });
  return runChecks(
    { candidate, scanId: 'crawl' },
    { agent: deadAgent, evidenceRoot: EV, fetchOverride: async (u) => cap(u) }
  );
}

(async () => {
  // --- 1. Operator source AGREES -> confirmed -----------------------------
  const crawler = await crawlerRunFrom(PAGE_UNDATED);

  // Every finding carries the candidate it is about, stamped once by runChecks.
  // This is what lets the approval gate refuse one prospect's confirmed findings
  // against another prospect's artifact; without the stamp the gate is dormant.
  ok('every crawler finding is stamped with the candidate it is about',
    crawler.findings.length > 0 && crawler.findings.every((f) => f.candidateName === 'Test Shop'),
    JSON.stringify(crawler.findings.map((f) => `${f.checkId}:${f.candidateName}`)));

  const agreeing = await G.confirm(candidate, crawler, [
    { kind: 'homepage', url: 'https://example-shop.test', content: PAGE_UNDATED },
    { kind: 'robots', url: 'https://example-shop.test/robots.txt', content: ROBOTS },
  ], { agent: deadAgent, evidenceRoot: EV, scanId: 'c1' });

  const fresh = agreeing.findings.find((f) => f.checkId === 'freshness');
  ok('agreeing paste confirms a finding', fresh && fresh.confirmation === 'operator-confirmed',
    `got ${fresh && fresh.confirmation}`);
  ok('no divergences when sources agree', agreeing.divergences.length === 0,
    JSON.stringify(agreeing.divergences.map((d) => d.checkId)));
  // The stamp has to survive reconciliation's spreads, or the gate loses it on
  // exactly the findings it is meant to protect.
  ok('confirmation keeps the candidate stamp on every finding',
    agreeing.findings.every((f) => f.candidateName === 'Test Shop'),
    JSON.stringify(agreeing.findings.map((f) => `${f.checkId}:${f.candidateName}`)));

  // --- 2. Operator source DISAGREES -> diverged, claim void ---------------
  const diverging = await G.confirm(candidate, crawler, [
    { kind: 'homepage', url: 'https://example-shop.test', content: PAGE_DATED },
    { kind: 'robots', url: 'https://example-shop.test/robots.txt', content: ROBOTS },
  ], { agent: deadAgent, evidenceRoot: EV, scanId: 'c2' });

  const divFresh = diverging.findings.find((f) => f.checkId === 'freshness');
  ok('disagreeing paste flips the finding to diverged', divFresh && divFresh.confirmation === 'diverged',
    `got ${divFresh && divFresh.confirmation}`);
  ok('divergence is recorded with both readings',
    diverging.divergences.some((d) => d.checkId === 'freshness' && d.crawler.severity !== d.operator.severity),
    JSON.stringify(diverging.divergences));
  ok('diverged finding carries an explanation', !!(divFresh && divFresh.divergenceNote));

  // --- 3. Nothing pasted -> stays REMOTE, never promoted ------------------
  const nothing = await G.confirm(candidate, crawler, [],
    { agent: deadAgent, evidenceRoot: EV, scanId: 'c3' });
  ok('no paste leaves every finding remote',
    nothing.findings.every((f) => f.confirmation === 'remote'),
    JSON.stringify(nothing.findings.map((f) => `${f.checkId}:${f.confirmation}`)));
  ok('missing required pastes are named', nothing.missingPastes.join(',') === 'homepage,robots',
    nothing.missingPastes.join(','));

  // --- 3b. A missing OPTIONAL paste is not a divergence -------------------
  // The crawler reads a real llms.txt and a sitemap that lead it to a services
  // page carrying the business schema. The operator confirms with homepage and
  // robots only. The reconciling pass has no bytes for the optional documents or
  // the services page, so it scores them absent and the number falls two bands.
  // That is a paste gap, not a site answering crawlers differently than
  // browsers, so the finding must stay unconfirmed with a note naming the
  // missing paste rather than flip to a false 'diverged'.
  {
    const crypto = require('node:crypto');
    const candCk = { ...candidate, website: 'https://ck.test', name: 'Copper Kettle Bakery', primaryType: null };
    // Sparse homepage: a title and description, and no schema and no links, so
    // reconciling from the homepage alone scores the site-wide items at zero.
    const HOME = '<html><head><title>Copper Kettle Bakery Home Page</title>' +
      '<meta name="description" content="' + 'x'.repeat(80) + '"></head><body><p>' +
      'Fresh bread daily. '.repeat(20) + '</p></body></html>';
    // The services page carries the business schema. The crawler reaches it via
    // the sitemap; the operator cannot paste it, only the four named documents.
    const SERVICE = '<html><head><title>Copper Kettle Services</title></head><body>' +
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Bakery",' +
      '"name":"Copper Kettle Bakery","telephone":"+1-717-555-0100","sameAs":["https://example.test/x"],' +
      '"@id":"https://ck.test/#org"}</script>' +
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage",' +
      '"mainEntity":[{"@type":"Question","name":"Do you deliver?"}]}</script>' +
      '<p>Our services.</p></body></html>';
    const ROBOTS2 = 'User-agent: *\nAllow: /\n\nSitemap: https://ck.test/sitemap.xml\n';
    const PATHS = ['services', 'p0', 'p1', 'p2', 'p3', 'p4'];
    const LLMS = '# Copper Kettle Bakery\n\n## Pages\n' +
      PATHS.map((p) => `- https://ck.test/${p}`).join('\n');
    const SITEMAP = '<?xml version="1.0"?><urlset>' +
      PATHS.map((p) => `<loc>https://ck.test/${p}</loc>`).join('') + '</urlset>';

    const serve = (url) => {
      const u = url.toLowerCase();
      let body = HOME;
      let ct = 'text/html';
      if (u.includes('robots')) { body = ROBOTS2; ct = 'text/plain'; }
      else if (u.includes('agents')) { body = ''; ct = 'text/plain'; }
      else if (u.includes('llms')) { body = LLMS; ct = 'text/plain'; }
      else if (u.includes('sitemap') || u.endsWith('.xml')) { body = SITEMAP; ct = 'application/xml'; }
      else if (u.includes('service')) { body = SERVICE; ct = 'text/html'; }
      return {
        ref: {
          id: url, url, requestedUrl: url, source: 'crawler', method: 'GET', httpStatus: 200,
          contentType: ct, fetchedAt: new Date().toISOString(),
          sha256: crypto.createHash('sha256').update(url + body).digest('hex'),
          byteLength: body.length, storedPath: '(test)',
        },
        body, captured: true,
      };
    };

    const crawlerCk = await runChecks(
      { candidate: candCk, scanId: 'ck' },
      { agent: deadAgent, evidenceRoot: EV, fetchOverride: async (u) => serve(u) }
    );
    const crawlerAi = crawlerCk.findings.find((f) => f.checkId === 'ai-readiness');
    ok('SETUP: the crawler produced a scored ai-readiness finding from the services page',
      !!(crawlerAi && crawlerAi.score && crawlerAi.status === 'flaw'), crawlerAi && crawlerAi.status);

    const confCk = await G.confirm(candCk, crawlerCk, [
      { kind: 'homepage', url: 'https://ck.test', content: HOME },
      { kind: 'robots', url: 'https://ck.test/robots.txt', content: ROBOTS2 },
    ], { agent: deadAgent, evidenceRoot: EV, scanId: 'ck1' });

    const ai = confCk.findings.find((f) => f.checkId === 'ai-readiness');
    ok('an unpasted but crawler-present optional document does not read as a divergence',
      !!(ai && ai.confirmation !== 'diverged'), ai && ai.confirmation);
    ok('the finding stays remote and names a document to paste',
      !!(ai && ai.confirmation === 'remote' && /llms\.txt|sitemap\.xml/i.test(ai.unverifiedNote || '')),
      ai && `${ai.confirmation}: ${ai.unverifiedNote}`);
    ok('no ai-readiness divergence is recorded for the paste gap',
      !confCk.divergences.some((d) => d.checkId === 'ai-readiness'),
      JSON.stringify(confCk.divergences.map((d) => d.checkId)));

    // The finding lists the extra pages it read, so the UI can offer paste slots.
    ok('the crawler ai-readiness finding lists the extra pages it read',
      !!(crawlerAi && Array.isArray(crawlerAi.extraPages) &&
        crawlerAi.extraPages.some((u) => /\/services$/.test(u))),
      crawlerAi && JSON.stringify(crawlerAi.extraPages));

    // Paste everything the score rests on: homepage, robots, the sitemap that
    // leads to the services page, the llms.txt, and the services page itself.
    // The multi-page finding then confirms.
    const confFull = await G.confirm(candCk, crawlerCk, [
      { kind: 'homepage', url: 'https://ck.test', content: HOME },
      { kind: 'robots', url: 'https://ck.test/robots.txt', content: ROBOTS2 },
      { kind: 'sitemap', url: 'https://ck.test/sitemap.xml', content: SITEMAP },
      { kind: 'llms', url: 'https://ck.test/llms.txt', content: LLMS },
      { kind: 'page', url: 'https://ck.test/services', content: SERVICE },
    ], { agent: deadAgent, evidenceRoot: EV, scanId: 'ck2' });
    const aiFull = confFull.findings.find((f) => f.checkId === 'ai-readiness');
    ok('pasting the extra pages confirms a multi-page ai-readiness finding',
      !!(aiFull && aiFull.confirmation === 'operator-confirmed'),
      aiFull && `${aiFull.confirmation}: ${aiFull.unverifiedNote || ''}`);
  }

  // --- 4. The release wall ------------------------------------------------
  const flaws = crawler.findings.filter((f) => f.status === 'flaw');
  ok('never-confirmed packet cannot be released', G.releasable(flaws, null).ok === false);
  ok('remote findings cannot be released',
    G.releasable(flaws, new Date().toISOString()).ok === false);

  const confirmedFlaws = agreeing.findings
    .filter((f) => f.status === 'flaw')
    .map((f) => ({ ...f, confirmation: 'operator-confirmed' }));
  ok('confirmed and fresh packet CAN be released',
    G.releasable(confirmedFlaws, new Date().toISOString()).ok === true,
    JSON.stringify(G.releasable(confirmedFlaws, new Date().toISOString())));

  const old = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
  ok('confirmation older than 72h cannot be released', G.releasable(confirmedFlaws, old).ok === false);
  ok('71h old confirmation is still releasable',
    G.releasable(confirmedFlaws, new Date(Date.now() - 71 * 3600 * 1000).toISOString()).ok === true);

  // --- 5. Escaped view-source detection -----------------------------------
  ok('escaped view-source wrapper is detected',
    G.looksLikeEscapedViewSource('&lt;html&gt;&lt;head&gt;&lt;meta&gt;&lt;script&gt;&lt;div&gt;') === true);
  ok('real source is not flagged as escaped',
    G.looksLikeEscapedViewSource(PAGE_UNDATED) === false);

  // --- 6. Blocklist -------------------------------------------------------
  // The seed array used to carry a real company name, so publishing the repo
  // published one operator's business relationships. An off-limits list is
  // data, not source. These tests now prove the MECHANISM with a synthetic
  // entry, and prove the two properties that actually make it permanent.
  const blockRoot = path.join(EV, 'policy');
  fs.mkdirSync(blockRoot, { recursive: true });

  ok('a fresh install blocks nobody', P.loadBlocklist(blockRoot).length === 0);

  P.addToBlocklist(blockRoot, { pattern: 'northwind', reason: 'Standing off limits.' });
  const list = P.loadBlocklist(blockRoot);
  ok('an added entry persists', list.some((e) => e.pattern === 'northwind'));
  ok('blocked by business name',
    !!P.blockedBy(list, { name: 'Northwind Fire and Life Safety', website: null }));
  ok('blocked by domain',
    !!P.blockedBy(list, { name: 'Unrelated Name', website: 'https://www.northwind.test' }));
  ok('unrelated business is not blocked',
    P.blockedBy(list, { name: 'Test Shop', website: 'https://example-shop.test' }) === null);

  // FAIL CLOSED. This used to swallow the parse error and return the seed
  // array, which only looked safe while that array was non-empty. With seeds
  // in operator data, the old behaviour turns a corrupt file into "nothing is
  // blocked", which is exactly the failure it claimed to prevent.
  fs.writeFileSync(path.join(blockRoot, 'blocklist.json'), 'not json', 'utf8');
  let blocklistThrew = null;
  try { P.loadBlocklist(blockRoot); } catch (e) { blocklistThrew = e; }
  ok('a corrupt blocklist throws rather than reading as empty',
    blocklistThrew instanceof P.BlocklistUnreadableError, String(blocklistThrew));

  fs.writeFileSync(path.join(blockRoot, 'blocklist.json'), '{"not":"a list"}', 'utf8');
  let shapeThrew = null;
  try { P.loadBlocklist(blockRoot); } catch (e) { shapeThrew = e; }
  ok('a blocklist of the wrong shape also fails closed',
    shapeThrew instanceof P.BlocklistUnreadableError, String(shapeThrew));

  // --- 7. Pacing ----------------------------------------------------------
  ok('no recent packets means no warning', P.pacingWarning([]).warn === false);
  ok('a packet started an hour ago warns',
    P.pacingWarning([{ candidateName: 'X', startedAt: new Date(Date.now() - 3600e3).toISOString() }]).warn === true);
  ok('a packet from three days ago does not warn',
    P.pacingWarning([{ candidateName: 'X', startedAt: new Date(Date.now() - 72 * 3600e3).toISOString() }]).warn === false);

  // --- 8. Claims may never be wider than the evidence ----------------------
  // Every one of these shipped a confident false statement onto a document
  // handed to a small business. All four were found in the pre-publication
  // audit and all four were invisible to a green suite.
  {
    const mk = (over) => ({
      ref: {
        id: 'e', url: 'https://example-shop.test', source: 'crawler', method: 'GET',
        httpStatus: 200, contentType: 'text/html', fetchedAt: new Date().toISOString(),
        sha256: 'd'.repeat(64), byteLength: 1024, storedPath: '(test)', ...over,
      },
      body: over && over.__body !== undefined ? over.__body : PAGE_UNDATED,
      captured: true,
    });
    const ctxWith = (cand, fetchFn) => ({
      candidate: cand, scanId: 'claims', evidenceRoot: EV, agent: deadAgent, fetch: fetchFn,
    });

    // 8a. NAP: Places returned no phone and no address. That is a gap in OUR
    // data. It used to be reported as "nothing in the site's own source states
    // a phone number or an address", with a fix telling the owner to publish
    // what their homepage already showed.
    const SITE_WITH_NAP = `<html><head><title>Test Shop</title></head><body>
      <h1>Test Shop</h1><p>Call us: (207) 555-0143</p>
      <address>84 Harbor Road, Rockport, ME 00000</address>
      <p>${'Handmade goods. '.repeat(30)}</p></body></html>`;
    const thin = { ...candidate, phone: null, address: '' };
    const nap = await napConsistencyCheck.run(
      ctxWith(thin, async () => mk({ __body: SITE_WITH_NAP }))
    );
    ok('a thin Places record never becomes a claim about their site',
      !/Nothing in the site's own source states/.test(nap.detail), nap.detail);
    // A severity-1 "name is text-only, not in JSON-LD" verdict here is real and
    // earned: the name IS on the page and IS absent from structured data. What
    // must never happen is a phone or address ABSENCE claim driving severity
    // when the Google listing gave us nothing to look for in the first place.
    ok('a thin Places record never drives a phone or address absence verdict',
      !/states a phone number|states an address|no phone number|no address/i.test(nap.detail),
      nap.detail);
    ok('the fix never tells them to publish what is already on the page',
      !/Publish a phone number|Publish an address/i.test(nap.fix ? nap.fix.summary : ''),
      nap.fix && nap.fix.summary);
    ok('the gap is still disclosed in the unverified note',
      (nap.unverifiedNote ?? '').includes('could not be cross-checked'), nap.unverifiedNote);

    // 8b. crawl-index had no homepage-load guard, so a failed fetch read as
    // "no noindex found" and the check announced "a crawler can get in" about
    // a page it never saw, contradicting website.ts on the same capture.
    const deadHome = async (url) =>
      url === 'https://example-shop.test'
        ? { ref: { id: 'e', url, source: 'crawler', method: 'GET', httpStatus: null,
                   contentType: null, fetchedAt: new Date().toISOString(), sha256: '',
                   byteLength: 0, storedPath: '', transportError: 'timed out after 15000ms' },
            body: '', captured: false }
        : mk({ url, __body: url.includes('robots') ? ROBOTS : '<urlset><url><loc>https://example-shop.test/</loc></url></urlset>' });
    const ci = await crawlIndexCheck.run(ctxWith(candidate, deadHome));
    ok('a homepage that never loaded is not reported as crawlable',
      ci.status === 'unverified', `${ci.status}: ${ci.detail}`);
    ok('a homepage that never loaded does not claim there is no noindex',
      !/no noindex/.test(ci.detail), ci.detail);

    // 8c. A 2.5MB truncation used to be written into transportError, and the
    // website check reads any transportError as "the site did not load". A
    // large, healthy HTTP 200 page was reported to its owner as unreachable.
    const web = await websiteCheck.run(
      ctxWith(candidate, async () => mk({ truncated: true }))
    );
    ok('a truncated capture is not reported as a failure to load',
      !/did not load/.test(web.detail), web.detail);
    ok('a truncated capture yields no verdict about page content',
      web.status === 'unverified', `${web.status}: ${web.detail}`);

    // 8d. A capture that arrived intact and then failed to WRITE. fetch-raw
    // recorded that in transportError and left httpStatus 200 and a full body
    // on the ref, so two things went wrong at once: website.ts reads any
    // transportError as "the listed website did not load" and told the owner
    // their site was down when it was our disk that was busy, and the other
    // five gates checked only httpStatus, body and truncated, judged the
    // capture, and cited findings against an EvidenceRef with no file behind
    // it. fetch-raw's own header promises a finding never outlives its receipt.
    {
      const A = require(path.join(ROOT, 'dist/main/main/checks/ai-readiness.js'));
      const Bk = require(path.join(ROOT, 'dist/main/main/checks/booking-path.js'));
      const Fr = require(path.join(ROOT, 'dist/main/main/checks/freshness.js'));

      const ORIGIN = 'https://unstored.test';
      const cand = { ...candidate, name: 'Unstored Co', website: ORIGIN };
      const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/</loc></url></urlset>`;

      const capOf = (url, body, ct, over) => ({
        ref: {
          id: url, url: url === ORIGIN ? `${ORIGIN}/` : url, requestedUrl: url,
          source: 'crawler', method: 'GET', httpStatus: 200, contentType: ct,
          fetchedAt: new Date().toISOString(), sha256: 'b'.repeat(64),
          byteLength: body.length, storedPath: '(test)', ...(over || {}),
        },
        body, captured: !over,
      });

      // The only difference between the two runs is this field.
      const UNSTORED = { storedPath: '', storeError: 'could not store capture: EBUSY: resource busy or locked' };

      const fetchWith = (homeOver) => async (url) => {
        const u = url.replace(/\/+$/, '');
        if (u === ORIGIN) return capOf(ORIGIN, PAGE_UNDATED, 'text/html', homeOver);
        if (u.endsWith('/robots.txt')) return capOf(url, ROBOTS, 'text/plain');
        if (u.endsWith('/sitemap.xml')) return capOf(url, SITEMAP, 'application/xml');
        return capOf(url, '', 'text/plain');
      };

      const gated = [
        ['ai-readiness', A.aiReadinessCheck],
        ['crawl-index', crawlIndexCheck],
        ['booking-path', Bk.bookingPathCheck],
        ['nap-consistency', napConsistencyCheck],
        ['freshness', Fr.freshnessCheck],
        ['website', websiteCheck],
      ];

      for (const [name, check] of gated) {
        // Non-vacuity guard: with the capture stored, this check DOES judge.
        // Without it, the assertion below would pass for any unrelated reason.
        const stored = await check.run(ctxWith(cand, fetchWith(null)));
        ok(`SETUP: ${name} judges a stored capture`,
          stored.status !== 'unverified', `${stored.status}: ${stored.headline}`);

        const unstored = await check.run(ctxWith(cand, fetchWith(UNSTORED)));
        ok(`${name} refuses to judge a capture that could not be stored`,
          unstored.status === 'unverified', `${unstored.status}: ${unstored.headline}`);
      }

      // The specific false claim: our disk failing is not their site failing.
      const webUnstored = await websiteCheck.run(ctxWith(cand, fetchWith(UNSTORED)));
      ok('a storage failure is never reported as the site failing to load',
        !/did not load/.test(webUnstored.detail), webUnstored.detail);
      ok('a storage failure says whose fault it is',
        /not on their site/.test(webUnstored.detail), webUnstored.detail);

      // Same class one layer up. storePaste hashes the bytes BEFORE writing,
      // so a paste that never reached disk still carried a sha256 and counted
      // as "the operator pasted this". It has to read as not confirmed, and
      // specifically NOT as a divergence: the site did nothing wrong.
      // Make the evidence root a FILE, so the mkdir for the scan directory
      // cannot succeed. Deterministic on Windows and POSIX alike, rather than
      // resting on which odd directory names a given OS happens to refuse.
      fs.mkdirSync(EV, { recursive: true });
      const unwritable = path.join(EV, 'root-is-a-file');
      fs.writeFileSync(unwritable, 'not a directory', 'utf8');
      const failed = await G.confirm(candidate, crawler, [
        { kind: 'homepage', url: 'https://example-shop.test', content: PAGE_UNDATED },
        { kind: 'robots', url: 'https://example-shop.test/robots.txt', content: ROBOTS },
      ], { agent: deadAgent, evidenceRoot: unwritable, scanId: 'cfail' });

      ok('SETUP: the paste really did fail to store',
        failed.pastedPaths.every((p) => !p.startsWith(EV)), JSON.stringify(failed.pastedPaths));
      ok('a paste that could not be stored confirms nothing',
        failed.findings.every((f) => f.confirmation === 'remote'),
        JSON.stringify(failed.findings.map((f) => `${f.checkId}:${f.confirmation}`)));
      ok('a paste that could not be stored is never reported as a divergence',
        failed.divergences.length === 0,
        JSON.stringify(failed.divergences.map((d) => d.checkId)));
    }
  }

  // --- 9. releasable() gates scores, not only flaws ------------------------
  // It filtered on status === 'flaw'. The AI-readiness score rides on a
  // finding that is usually status 'ok', and generate.ts prints it with its
  // full rubric, so a packet could ship a number computed entirely from
  // crawler bytes while every finding was still 'remote'.
  {
    const scored = {
      checkId: 'ai-readiness', status: 'ok', severity: 0,
      headline: 'Broadly readable.', detail: 'Scored.',
      evidence: [], confirmation: 'remote',
      score: { instrument: 'aeo-baseline-six-check', instrumentVersion: 't',
               raw: 71, base: 105, rescaled: 68, naItems: [], items: [] },
    };
    const now = new Date().toISOString();
    ok('an unconfirmed score cannot be released',
      G.releasable([scored], now).ok === false,
      JSON.stringify(G.releasable([scored], now)));
    ok('a confirmed score can be released',
      G.releasable([{ ...scored, confirmation: 'operator-confirmed' }], now).ok === true);
  }

  // --- 8. Soft 404s and page discovery, from a real operator scan ---------
  // The site had no llms.txt, no agents.md and no /sitemap.xml. Its CMS
  // answered all three with HTTP 200 and the homepage, and its robots.txt
  // declared the sitemap at /sitemap_index.xml. The scan reported a "Real
  // file" llms.txt worth 10 points, "a sitemap lists 0 URLs", and
  // "No FAQPage markup" for a site whose FAQPage node was on a page linked
  // straight off the homepage.
  {
    const ORIGIN = 'https://softfour.test';
    const REVIEWS = `${ORIGIN}/customer-reviews/`;
    const HOME = `<html><head><title>Soft Four Fire</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Soft Four Fire","url":"${ORIGIN}"}</script>
</head><body><h1>Soft Four Fire</h1>
<a href="${REVIEWS}">Reviews</a><a href="${ORIGIN}/wp-content/style.css">x</a>
<p>${'Fire protection for Rockport businesses. '.repeat(20)}</p></body></html>`;
    const REVIEWS_HTML = `<html><head><title>Reviews</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[
{"@type":"Question","name":"Do you service extinguishers?","acceptedAnswer":{"@type":"Answer","text":"Yes we service extinguishers."}},
{"@type":"Question","name":"How often are inspections?","acceptedAnswer":{"@type":"Answer","text":"Inspections are annual."}}]}</script>
</head><body><p>Do you service extinguishers? Yes we service extinguishers.
How often are inspections? Inspections are annual.</p></body></html>`;
    const ROBOTS_DECL = `User-agent: *\nDisallow: /wp-admin/\n\nSitemap: ${ORIGIN}/sitemap_index.xml\n`;
    const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${REVIEWS}</loc></url></urlset>`;

    const mk = (requestedUrl, finalUrl, body, ct) => ({
      ref: {
        id: requestedUrl, url: finalUrl, requestedUrl, source: 'crawler', method: 'GET',
        httpStatus: 200, contentType: ct, fetchedAt: new Date().toISOString(),
        sha256: 'a'.repeat(64), byteLength: body.length, storedPath: '(test)',
      },
      body, captured: true,
    });

    // Everything not explicitly present soft-404s to the homepage.
    const softFetch = async (url) => {
      const u = url.replace(/\/+$/, '');
      if (u === ORIGIN) return mk(url, `${ORIGIN}/`, HOME, 'text/html');
      if (u.endsWith('/robots.txt')) return mk(url, url, ROBOTS_DECL, 'text/plain');
      if (u.endsWith('/sitemap_index.xml')) return mk(url, url, SITEMAP, 'application/xml');
      if (u === REVIEWS.replace(/\/+$/, '')) return mk(url, url, REVIEWS_HTML, 'text/html');
      return mk(url, `${ORIGIN}/`, HOME, 'text/html');
    };
    const cand = { ...candidate, website: ORIGIN };
    const run = (fetchOverride) => runChecks({ candidate: cand, scanId: 'soft' },
      { agent: deadAgent, evidenceRoot: EV, fetchOverride });

    const res = await run(softFetch);
    const ai = res.findings.find((f) => f.checkId === 'ai-readiness');
    const ci = res.findings.find((f) => f.checkId === 'crawl-index');

    const llmsItem = ai.score && ai.score.items.find((i) => i.id === 'llms-txt');
    ok('a soft-404 llms.txt scores zero, not ten',
      llmsItem && llmsItem.earned === 0, llmsItem && `${llmsItem.earned}: ${llmsItem.note}`);
    ok('a soft-404 llms.txt is never called a real file',
      llmsItem && !/real file/i.test(llmsItem.note), llmsItem && llmsItem.note);

    // The sitemap lives where robots.txt says, not at the conventional path.
    ok('the sitemap declared in robots.txt is followed',
      !/no sitemap was readable/i.test(ci.detail), ci.detail);
    ok('crawl-index never reports a sitemap listing zero URLs',
      !/sitemap lists 0 URLs/i.test(ci.detail), ci.detail);

    const faqItem = ai.score && ai.score.items.find((i) => i.id === 'faq-page');
    ok('FAQPage markup on a non-homepage page is found',
      faqItem && faqItem.earned > 0, faqItem && `${faqItem.earned}: ${faqItem.note}`);
    ok('the score says how many pages it actually read',
      /Read across 2 page\(s\)/.test(faqItem ? faqItem.note : ''), faqItem && faqItem.note);

    // REGRESSIONS from the adversarial review of this session's own code.
    // A single-page site navigated by anchors, plus a lookalike domain linked
    // from the page. Both were confirmed broken by running before being fixed.
    {
      const SOLO = 'https://anchors.test';
      const SOLO_HOME = `<html><head><title>Anchors</title></head><body>
<a href="#faq">FAQ</a><a href="#about">About</a><a href="#contact">Contact</a><a href="#hours">Hours</a>
<a href="https://anchors.test.attacker.test/evil">partner</a>
<p>${'Fire protection for local businesses. '.repeat(20)}</p></body></html>`;
      const seen = [];
      const soloFetch = async (url) => {
        seen.push(url);
        const u = url.replace(/\/+$/, '');
        if (u === SOLO) return mk(url, `${SOLO}/`, SOLO_HOME, 'text/html');
        if (u.endsWith('/robots.txt')) return mk(url, url, 'User-agent: *\nAllow: /\n', 'text/plain');
        return mk(url, `${SOLO}/`, SOLO_HOME, 'text/html');
      };
      const soloRes = await runChecks(
        { candidate: { ...candidate, website: SOLO, name: 'Anchors' }, scanId: 'solo' },
        { agent: deadAgent, evidenceRoot: EV, fetchOverride: soloFetch }
      );
      const soloAi = soloRes.findings.find((f) => f.checkId === 'ai-readiness');
      const note = soloAi.unverifiedNote ?? '';
      ok('anchor links do not count the homepage as several pages',
        !/page\(s\) \(\/, \//.test(note), note);
      ok('a lookalike domain is never fetched as the business own site',
        !seen.some((u) => u.includes('attacker.test')),
        seen.filter((u) => u.includes('attacker')).join(', '));
    }

    // REGRESSION from the first real scan. WordPress and Shopify serve
    // /sitemap.xml as a <sitemapindex> whose entries are child sitemap FILES.
    // Coverage was computed against those, so a live business lost the
    // coverage points and its scorecard told it to add /post-sitemap.xml and
    // /page-sitemap.xml to its llms.txt. No llms.txt should ever list one.
    {
      const IDX = 'https://indexed.test';
      const INDEX_XML = `<?xml version="1.0"?><sitemapindex>
<sitemap><loc>${IDX}/page-sitemap.xml</loc></sitemap>
<sitemap><loc>${IDX}/post-sitemap.xml</loc></sitemap></sitemapindex>`;
      // Two child sitemaps, five real pages. The two numbers have to differ or
      // the assertions below cannot tell a page count from a file count.
      const PAGE_SM = `<?xml version="1.0"?><urlset><url><loc>${IDX}/</loc></url><url><loc>${IDX}/services/</loc></url></urlset>`;
      const POST_SM = `<?xml version="1.0"?><urlset><url><loc>${IDX}/blog/hello/</loc></url><url><loc>${IDX}/blog/two/</loc></url><url><loc>${IDX}/blog/three/</loc></url></urlset>`;
      // An llms.txt that lists every real PAGE and, correctly, no sitemap file.
      const LLMS_FULL = `# Indexed Co\n\n## Pages\n- [Home](${IDX}/)\n- [Services](${IDX}/services/)\n- [Hello](${IDX}/blog/hello/)\n- [Two](${IDX}/blog/two/)\n- [Three](${IDX}/blog/three/)\n${
        Array.from({ length: 7 }, (_, n) => `- [More](${IDX}/more-${n}/)`).join('\n')
      }\n`;
      const IDX_HOME = `<html><head><title>Indexed Co</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Indexed Co","url":"${IDX}"}</script>
</head><body><h1>Indexed Co</h1><p>${'Service work for local businesses. '.repeat(20)}</p></body></html>`;

      const idxFetch = async (url) => {
        const u = url.replace(/\/+$/, '');
        if (u === IDX) return mk(url, `${IDX}/`, IDX_HOME, 'text/html');
        if (u.endsWith('/robots.txt')) return mk(url, url, `User-agent: *\nAllow: /\n\nSitemap: ${IDX}/sitemap.xml\n`, 'text/plain');
        if (u.endsWith('/sitemap.xml')) return mk(url, url, INDEX_XML, 'application/xml');
        if (u.endsWith('/page-sitemap.xml')) return mk(url, url, PAGE_SM, 'application/xml');
        if (u.endsWith('/post-sitemap.xml')) return mk(url, url, POST_SM, 'application/xml');
        if (u.endsWith('/llms.txt')) return mk(url, url, LLMS_FULL, 'text/plain');
        return mk(url, url, IDX_HOME, 'text/html');
      };

      const idxRes = await runChecks(
        { candidate: { ...candidate, website: IDX, name: 'Indexed Co' }, scanId: 'idx' },
        { agent: deadAgent, evidenceRoot: EV, fetchOverride: idxFetch }
      );
      const idxAi = idxRes.findings.find((f) => f.checkId === 'ai-readiness');
      const llmsNote = idxAi.score
        ? (idxAi.score.items.find((i) => i.id === 'llms-txt') || {}).note || ''
        : '(no score)';
      ok('a sitemap index never asks an llms.txt to list sitemap files',
        !/\.xml/.test(llmsNote), llmsNote);
      ok('coverage is judged against the pages the index resolves to',
        /Covers every path/.test(llmsNote), llmsNote);

      // Same root cause, different check. crawl-index counted the index's own
      // entries, so a site with five pages behind two child sitemaps was told
      // "The sitemap lists 2 URLs" on a client document.
      const idxCi = idxRes.findings.find((f) => f.checkId === 'crawl-index');
      ok('crawl-index counts pages, not the child sitemap files',
        /lists 5 URLs/.test(idxCi.detail), idxCi.detail);
      ok('crawl-index does not report the index entry count as pages',
        !/lists 2 URLs/.test(idxCi.detail), idxCi.detail);

      // And when the children CANNOT be read, which is every confirm pass
      // because a child sitemap is not one of the four pasteable documents,
      // no page count may be claimed at all. "The sitemap lists 3 URLs" went
      // onto a client document for a site with a good few dozen pages.
      // A real 404, not mk()'s 200-with-an-empty-body: an empty child that was
      // successfully fetched reads as present and would exercise a different
      // path entirely.
      const gone = (url) => ({
        ref: {
          id: url, url, requestedUrl: url, source: 'crawler', method: 'GET', httpStatus: 404,
          contentType: 'text/html', fetchedAt: new Date().toISOString(),
          sha256: 'c'.repeat(64), byteLength: 0, storedPath: '(test)',
        },
        body: '', captured: true,
      });
      const blindIdxFetch = async (url) => {
        const u = url.replace(/\/+$/, '');
        if (/-sitemap\.xml$/.test(u)) return gone(url);
        return idxFetch(url);
      };
      const blindIdx = await runChecks(
        { candidate: { ...candidate, website: IDX, name: 'Indexed Co' }, scanId: 'idx2' },
        { agent: deadAgent, evidenceRoot: EV, fetchOverride: blindIdxFetch }
      );
      const blindCi = blindIdx.findings.find((f) => f.checkId === 'crawl-index');
      ok('an index whose children could not be read claims no page count',
        !/lists \d+ URL/.test(blindCi.detail), blindCi.detail);
      ok('it says what it actually saw instead',
        /index pointing at 2 child sitemaps/.test(blindCi.detail), blindCi.detail);
    }

    // Same site, but discovery finds nothing at all: no number may be printed.
    const blindFetch = async (url) => {
      const u = url.replace(/\/+$/, '');
      if (u === ORIGIN) return mk(url, `${ORIGIN}/`, '<html><body><p>Just a page.</p></body></html>', 'text/html');
      return mk(url, `${ORIGIN}/`, '<html><body><p>Just a page.</p></body></html>', 'text/html');
    };
    const blind = await run(blindFetch);
    const blindAi = blind.findings.find((f) => f.checkId === 'ai-readiness');
    ok('a capture that cannot enumerate the site prints no number',
      blindAi.status === 'unverified' && !blindAi.score,
      `${blindAi.status} score=${blindAi.score ? blindAi.score.rescaled : 'none'}`);
  }

  // --- 10. The confirmed packet never ships the thinner score --------------
  // `agrees` compared only status and severity. severityFor() is a band
  // (<25:4 <45:3 <65:2 <85:1 else 0), so two different scores inside one band
  // agree. The reconciling pass reads only pasted documents and only four
  // kinds can be pasted, so every multi-page rubric item is thinner there by
  // construction. The result was that the homepage-only number shipped
  // labelled operator-confirmed and the better-supported one was discarded.
  //
  // Both passes here agree on status and severity. The ONLY difference is a
  // Service node on a second page, worth 7 raw points, which the operator
  // cannot paste at any price. checks/types.ts and ai-readiness.ts both state
  // the contract: the crawler pass is the pass that produces the shippable
  // number.
  {
    const ORIGIN = 'https://thinscore.test';
    const SERVICES = `${ORIGIN}/services/`;
    const cand = { ...candidate, name: 'Thin Score Fire', website: ORIGIN };

    const HOME = `<html><head><title>Thin Score Fire</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Thin Score Fire","url":"${ORIGIN}","telephone":"+1-717-555-0100","address":{"@type":"PostalAddress","streetAddress":"1 Main St","addressLocality":"Anytown","addressRegion":"PA","postalCode":"00000"}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[
{"@type":"Question","name":"Do you service extinguishers?","acceptedAnswer":{"@type":"Answer","text":"Yes we service extinguishers."}},
{"@type":"Question","name":"How often are inspections?","acceptedAnswer":{"@type":"Answer","text":"Inspections are annual."}}]}</script>
</head><body><h1>Thin Score Fire</h1>
<a href="${SERVICES}">Services</a>
<p>Do you service extinguishers? Yes we service extinguishers.
How often are inspections? Inspections are annual.</p>
<p>${'Fire protection and extinguisher service for local businesses. '.repeat(20)}</p></body></html>`;

    const SERVICES_HTML = `<html><head><title>Services</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Service","name":"Extinguisher inspection","provider":{"@type":"Organization","name":"Thin Score Fire"}}</script>
</head><body><p>${'We inspect and service fire extinguishers. '.repeat(20)}</p></body></html>`;

    const ROB = `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`;
    const SMAP = `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${SERVICES}</loc></url></urlset>`;
    const LLMS = `# Thin Score Fire\n\n## Services\n- [Home](${ORIGIN}/)\n- [Services](${SERVICES})\n`;

    const cap = (requestedUrl, finalUrl, body, ct, status) => ({
      ref: {
        id: requestedUrl, url: finalUrl, requestedUrl, source: 'crawler', method: 'GET',
        httpStatus: status === undefined ? 200 : status, contentType: ct,
        fetchedAt: new Date().toISOString(),
        sha256: require('node:crypto').createHash('sha256').update(requestedUrl + body).digest('hex'),
        byteLength: body.length, storedPath: '(test)',
      },
      body, captured: true,
    });

    const crawlerFetch = async (url) => {
      const u = url.replace(/\/+$/, '');
      if (u === ORIGIN) return cap(url, `${ORIGIN}/`, HOME, 'text/html');
      if (u.endsWith('/robots.txt')) return cap(url, url, ROB, 'text/plain');
      if (u.endsWith('/sitemap.xml')) return cap(url, url, SMAP, 'application/xml');
      if (u.endsWith('/llms.txt')) return cap(url, url, LLMS, 'text/plain');
      if (u === SERVICES.replace(/\/+$/, '')) return cap(url, url, SERVICES_HTML, 'text/html');
      return cap(url, url, '', 'text/html', 404);
    };

    const thinCrawler = await runChecks(
      { candidate: cand, scanId: 'thin' },
      { agent: deadAgent, evidenceRoot: EV, fetchOverride: crawlerFetch }
    );
    const crawlerAi = thinCrawler.findings.find((f) => f.checkId === 'ai-readiness');

    // All four paste kinds. This is the most the operator can possibly do.
    const thin = await G.confirm(cand, thinCrawler, [
      { kind: 'homepage', url: ORIGIN, content: HOME },
      { kind: 'robots', url: `${ORIGIN}/robots.txt`, content: ROB },
      { kind: 'llms', url: `${ORIGIN}/llms.txt`, content: LLMS },
      { kind: 'sitemap', url: `${ORIGIN}/sitemap.xml`, content: SMAP },
    ], { agent: deadAgent, evidenceRoot: EV, scanId: 'thin1' });

    const shipped = thin.findings.find((f) => f.checkId === 'ai-readiness');

    // Guards that keep the three assertions below from passing vacuously: if
    // the fixture ever stops producing agreement, or stops producing a score
    // gap, this section proves nothing and must fail loudly instead.
    ok('SETUP: the two passes agree on status and severity',
      !!shipped && shipped.confirmation === 'operator-confirmed',
      `${shipped && shipped.confirmation}, divergences ${JSON.stringify(thin.divergences.map((d) => d.checkId))}`);
    ok('SETUP: the reconciling pass really did score lower on its own',
      !!crawlerAi && !!crawlerAi.score && crawlerAi.score.items.some((i) => i.id === 'product-review' && i.earned > 0),
      crawlerAi && crawlerAi.score && JSON.stringify(crawlerAi.score.items.map((i) => `${i.id}=${i.earned}`)));

    ok('a confirmed packet ships the crawler pass number, not the homepage-only one',
      !!shipped && !!shipped.score && !!crawlerAi.score &&
        shipped.score.rescaled === crawlerAi.score.rescaled,
      `shipped ${shipped && shipped.score && shipped.score.rescaled} vs crawler ${crawlerAi && crawlerAi.score && crawlerAi.score.rescaled}`);

    ok('every rubric item shipped is the crawler pass reading',
      !!shipped && !!shipped.score &&
        JSON.stringify(shipped.score.items) === JSON.stringify(crawlerAi.score.items),
      shipped && shipped.score && JSON.stringify(shipped.score.items.map((i) => `${i.id}=${i.earned}`)));

    // generate.ts prints the headline AND the scorecard, and allowedFactsFrom
    // draws its number allowlist from both, so a headline quoting one number
    // beside a scorecard quoting another passes the sweep and contradicts
    // itself on a document handed to a business.
    ok('the shipped headline quotes the number the shipped score carries',
      !!shipped && !!shipped.score && shipped.headline.includes(String(shipped.score.rescaled)),
      shipped && `${shipped.headline} / score ${shipped.score && shipped.score.rescaled}`);

    // The number was computed partly from a page the operator never pasted, so
    // that page's capture has to be cited with it. A claim may never be wider
    // than its evidence.
    ok('the confirmed finding cites the crawler captures the number rests on',
      !!shipped && crawlerAi.evidence.every((ce) => shipped.evidence.some((se) => se.sha256 === ce.sha256)),
      shipped && `${shipped.evidence.length} refs, sources ${[...new Set(shipped.evidence.map((e) => e.source))].join(',')}`);

    ok('the confirmed finding still cites the operator paste that confirmed it',
      !!shipped && shipped.evidence.some((e) => e.source === 'operator-browser' && e.sha256 !== ''),
      shipped && [...new Set(shipped.evidence.map((e) => e.source))].join(','));
  }

  try { fs.rmSync(EV, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log('\n--- CONFIRMATION GATE TESTS ---');
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\n  ${pass}/${pass + failures.length} passed${failures.length ? ', FAIL' : ', PASS'}\n`);
  process.exit(failures.length ? 1 : 0);
})();

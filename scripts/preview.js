/**
 * Visual check. Run with: npm run preview
 *
 * Boots the real renderer, injects sample results so the layout can be seen
 * without burning a Places request or needing a key, and writes a PNG to
 * out/preview-<view>.png. Phase 4 renders scorecards and mockups where the
 * visual IS the deliverable, so this stays.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PREVIEW_USER_DATA = path.join(os.tmpdir(), `assay-preview-${process.pid}`);
app.setPath('userData', PREVIEW_USER_DATA);
// Also sessionData, or Chromium's caches land in %APPDATA%/Electron and stay
// there after the cleanup below removes the userData dir. See test-ipc.js.
app.setPath('sessionData', PREVIEW_USER_DATA);

const APP_ROOT = path.resolve(__dirname, '..');
const OUT = path.join(APP_ROOT, 'out');
const { registerHandlers } = require(path.join(APP_ROOT, 'dist/main/main/ipc/handlers.js'));

// Deliberately awkward sample data: a long business name, a long URL, a
// missing website and phone, and a four-digit review count. If the layout
// survives this it survives real results.
//
// SYNTHETIC ON PURPOSE. This fixture previously held five real local
// businesses with their actual names, street addresses, phone numbers and
// websites, copied out of a live scan. That is third-party personal data and
// it would have been published with the repo. Reserved 555 numbers and .test
// domains only; keep it that way when adding cases.
const SAMPLE = {
  // Locations are fixture coordinates near Rockport, so the MAP toggle
  // renders in the band the way a real scan's results make it render; one
  // candidate deliberately carries none, matching real responses.
  candidates: [
    { placeId: '1', name: "Tilly's Corner Boutique", address: '170 Harbor Rd, Rockport, ME 00000, USA', location: { lat: 44.1809, lng: -69.0762 }, website: null, phone: null, rating: 5.0, reviewCount: 1, businessStatus: 'OPERATIONAL' },
    { placeId: '2', name: "Dane's", address: '158 Harbor Rd, Rockport, ME 00000, USA', location: { lat: 44.1821, lng: -69.0771 }, website: 'https://www.example-hardware.test', phone: '(555) 010-2599', rating: 4.2, reviewCount: 993, businessStatus: 'OPERATIONAL' },
    { placeId: '3', name: 'Copper Kettle Bakery', address: '127 Mill St, Rockport, ME 00000, USA', location: { lat: 44.1854, lng: -69.0729 }, website: 'https://copperkettle.test', phone: '(555) 010-2042', rating: 5.0, reviewCount: 53, businessStatus: 'OPERATIONAL' },
    { placeId: '4', name: 'The Blue Heron Bridal And Formalwear Boutique', address: '346 Tri-County Plaza, Rockport, ME 00000, USA', location: { lat: 44.1766, lng: -69.0888 }, website: 'https://www.example-blueheronbridalformalwear.test/collections', phone: '(555) 010-4411', rating: 4.5, reviewCount: 133, businessStatus: 'OPERATIONAL' },
    { placeId: '5', name: 'Shoppes at Northfield', address: '100 Ridge Rd, Rockport, ME 00000, USA', location: null, website: null, phone: null, rating: 4.2, reviewCount: 7154, businessStatus: 'CLOSED_TEMPORARILY' },
  ],
  quotaNote: '1 request · 5 results · more available',
  quotaDetail:
    'Billed at Text Search Enterprise, the highest tier present in the field mask (websiteUri, nationalPhoneNumber, rating, userRatingCount). Each Load more is another billed request.',
};

app.whenReady().then(async () => {
  registerHandlers();
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#F1EEE3',
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist/main/main/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadFile(path.join(APP_ROOT, 'src/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 600));

  // app.js is a classic script, so its top-level bindings are reachable by
  // bare name in the page's main world.
  const measured = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#f-city').value = 'Rockport, ME';
    document.querySelector('#f-category').value = "Women's clothing";
    state.candidates = ${JSON.stringify(SAMPLE.candidates)};
    state.nextPageToken = 'FAKE_TOKEN';
    document.querySelector('#results-note').textContent = ${JSON.stringify(SAMPLE.quotaNote)};
    document.querySelector('#quota-detail').textContent = ${JSON.stringify(SAMPLE.quotaDetail)};
    renderResults(false);

    const band = document.querySelector('#results-band');
    const l = band.querySelector('.l');
    const r = band.querySelector('.r');
    return {
      bandHeight: Math.round(band.getBoundingClientRect().height),
      leftLines: Math.round(l.getBoundingClientRect().height / parseFloat(getComputedStyle(l).fontSize)),
      leftText: l.textContent,
      rightText: r.textContent,
      rightOverflows: r.scrollWidth > r.clientWidth + 1,
      pageScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  })()`);

  // capturePage can return the last painted frame, so wait for the compositor
  // to flush the DOM changes above or the PNG shows the pre-injection state.
  await win.webContents.executeJavaScript(
    `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`
  );
  await new Promise((r) => setTimeout(r, 400));

  const png = await win.webContents.capturePage();
  const file = path.join(OUT, 'preview-scan.png');
  fs.writeFileSync(file, png.toPNG());

  // Third shot: the findings panel, rendered with a sample flaw so the REMOTE
  // marker, the fix block and the evidence lines can be looked at without
  // spending a real agent call or a real fetch.
  await win.webContents.executeJavaScript(`(() => {
    const tr = document.querySelector('#results-body tr.cand-row');
    // ensurePanelRow returns the <tr>. renderFindingsPanel calls
    // replaceChildren() on what it is given, so handing it the row would
    // destroy the <td colspan="7"> and drop bare divs into a table row.
    // The real call site resolves .panel-results; do the same here.
    const panel = ensurePanelRow(tr, 'preview').querySelector('.panel-results');
    renderFindingsPanel(panel, {
      disqualified: false,
      // A real check run always carries the candidate; the confirm section
      // needs it to build the four paste URLs. Without it this preview
      // silently omitted the entire Phase 4 surface from the screenshot,
      // which is the one thing a visual check exists to catch.
      candidate: {
        placeId: 'preview', name: 'Example Boutique',
        address: '1 Main St, Rockport, ME 00000, USA',
        website: 'https://example-boutique.com', phone: '(555) 555-0142',
        location: null, rating: null, reviewCount: null,
        businessStatus: 'OPERATIONAL', primaryType: null, mapsUri: null,
        discoveredAt: new Date(0).toISOString(), source: 'google-places-new',
      },
      findings: [{
        checkId: 'website',
        status: 'flaw',
        severity: 4,
        confirmation: 'remote',
        headline: 'Your homepage looks fine in a browser but arrives almost empty to the crawlers that feed AI answers.',
        detail: 'The page is 312KB of markup with 14 scripts but only 118 characters of readable text in the source.',
        evidence: [{
          url: 'https://example-boutique.com/', source: 'crawler', httpStatus: 200,
          contentType: 'text/html; charset=utf-8', byteLength: 319488,
          sha256: '5e9dfb01b2dfd8b8d3c461e49eac6c42c912155b91525857ad5e06e13d95b052',
          storedPath: 'C:/evidence/x.html', fetchedAt: new Date().toISOString(), method: 'GET',
        }],
        fix: {
          summary: 'Serve the main page text in the HTML itself instead of building it with JavaScript. Most site builders have a prerender or static setting.',
          effort: 'needs a developer',
          snippet: '<title>Example Boutique | Rockport</title>',
        },
      }],
    }, '#scan-status');
    return true;
  })()`);
  await win.webContents.executeJavaScript(
    `document.querySelector('.app-main').scrollTop = 420;
     new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`
  );
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT, 'preview-findings.png'), (await win.webContents.capturePage()).toPNG());

  // Third shot: the Phase 4 confirmation surface, which sits below the fold of
  // the findings panel. A visual check that cannot see the thing it is checking
  // is worth nothing, and the first version of this preview omitted it entirely.
  const sawConfirm = await win.webContents.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => /confirm/i.test(b.textContent || ''));
    if (!btn) return false;
    btn.click();
    btn.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await win.webContents.executeJavaScript(
    `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`
  );
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT, 'preview-confirm.png'), (await win.webContents.capturePage()).toPNG());
  console.log(`  confirm control found: ${sawConfirm}`);

  // Second shot at the bottom, where the billing attribution and the
  // provenance law line live.
  await win.webContents.executeJavaScript(
    `document.querySelector('.app-main').scrollTop = 99999;
     new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`
  );
  await new Promise((r) => setTimeout(r, 400));
  const png2 = await win.webContents.capturePage();
  const file2 = path.join(OUT, 'preview-scan-footer.png');
  fs.writeFileSync(file2, png2.toPNG());

  console.log('\n--- PREVIEW ---');
  for (const [k, v] of Object.entries(measured)) console.log(`  ${k}: ${JSON.stringify(v)}`);

  const bad = [];
  if (measured.bandHeight > 56) bad.push(`band is ${measured.bandHeight}px tall, it is wrapping`);
  if (measured.rightOverflows) bad.push('band note is clipped');
  if (measured.pageScrollsSideways) bad.push('page scrolls sideways');
  console.log(bad.length ? `\n  ISSUES: ${bad.join('; ')}` : '\n  Band fits on one line, nothing clipped.');
  console.log(`  wrote ${file}\n`);

  try {
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  app.exit(bad.length ? 1 : 0);
});

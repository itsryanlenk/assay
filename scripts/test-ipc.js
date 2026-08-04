/**
 * IPC integration test. Run with: npm run test:ipc
 *
 * Drives the REAL preload bridge from a REAL renderer against the REAL
 * handlers, exactly as clicking a button in the app does. It exists because
 * the smoke test only exercised the two zero-argument channels (config:get and
 * app:info) and therefore passed while five payload-carrying channels were
 * completely broken. Any new channel gets a case here.
 *
 * Writes to an isolated temp userData dir so it never touches the real config.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TEST_USER_DATA = path.join(os.tmpdir(), `assay-ipc-test-${process.pid}`);
app.setPath('userData', TEST_USER_DATA);
// sessionData is resolved separately from userData and defaults to the
// unqualified Electron profile, so setting only userData left every run's
// Cache, GPUCache, Network, Local Storage, DIPS and Preferences behind in
// %APPDATA%/Electron. Isolated means isolated.
app.setPath('sessionData', TEST_USER_DATA);

const APP_ROOT = path.resolve(__dirname, '..');
const { registerHandlers } = require(path.join(APP_ROOT, 'dist/main/main/ipc/handlers.js'));

const CONFIG_FILE = path.join(TEST_USER_DATA, 'config.json');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return { __parseError: String(e) };
  }
}

/** Runs an expression in the renderer against the real contextBridge API. */
function inRenderer(win, expr) {
  return win.webContents.executeJavaScript(`(async () => { ${expr} })()`);
}

async function run(win) {
  // --- 1. The reported symptom: save an API key ---------------------------
  const setRes = await inRenderer(
    win,
    `return await window.assay.config.setKey('googlePlaces', 'TEST-KEY-ABC123');`
  );
  check(
    'config:setKey returns ok',
    setRes && setRes.ok === true,
    setRes && setRes.error ? `${setRes.error.kind}: ${setRes.error.message}` : JSON.stringify(setRes)
  );

  const onDisk = readConfig();
  check('config.json written to disk', onDisk !== null, `expected ${CONFIG_FILE}`);
  check(
    'saved key is in the file',
    onDisk && onDisk.keys && onDisk.keys.googlePlaces === 'TEST-KEY-ABC123',
    onDisk ? `keys.googlePlaces = ${JSON.stringify(onDisk.keys && onDisk.keys.googlePlaces)}` : 'no file'
  );
  check(
    'setKey response reports the key present',
    setRes && setRes.ok && setRes.data.keys.googlePlaces.present === true &&
      setRes.data.keys.googlePlaces.source === 'config' &&
      setRes.data.keys.googlePlaces.hint === 'C123',
    setRes && setRes.ok ? JSON.stringify(setRes.data.keys.googlePlaces) : 'call failed'
  );

  // --- 2. config:get must agree after a reload ---------------------------
  const getRes = await inRenderer(win, `return await window.assay.config.get();`);
  check(
    'config:get reflects the saved key',
    getRes && getRes.ok && getRes.data.keys.googlePlaces.present === true,
    getRes && getRes.ok ? JSON.stringify(getRes.data.keys.googlePlaces) : JSON.stringify(getRes)
  );

  // --- 3. Clearing a key --------------------------------------------------
  const clearRes = await inRenderer(
    win,
    `return await window.assay.config.setKey('googlePlaces', '');`
  );
  const afterClear = readConfig();
  check(
    'empty value clears the key',
    clearRes && clearRes.ok && afterClear && afterClear.keys.googlePlaces === null,
    afterClear ? `keys.googlePlaces = ${JSON.stringify(afterClear.keys.googlePlaces)}` : 'no file'
  );

  // --- 4. Rejecting a bogus key name (proves the payload arrives) --------
  const badRes = await inRenderer(
    win,
    `return await window.assay.config.setKey('notAKey', 'x');`
  );
  check(
    'unknown key name is rejected as bad_request',
    badRes && badRes.ok === false && badRes.error.kind === 'bad_request' &&
      badRes.error.message.includes('notAKey'),
    JSON.stringify(badRes && badRes.error)
  );

  // --- 5. config:setAgentMode --------------------------------------------
  const modeRes = await inRenderer(
    win,
    `return await window.assay.config.setAgentMode('cli');`
  );
  const afterMode = readConfig();
  check(
    'config:setAgentMode persists',
    modeRes && modeRes.ok && modeRes.data.agent.mode === 'cli' &&
      afterMode && afterMode.agent.mode === 'cli',
    afterMode ? `agent.mode = ${JSON.stringify(afterMode.agent.mode)}` : 'no file'
  );

  const badMode = await inRenderer(
    win,
    `return await window.assay.config.setAgentMode('nonsense');`
  );
  check(
    'invalid agent mode is rejected',
    badMode && badMode.ok === false && badMode.error.kind === 'bad_request',
    JSON.stringify(badMode && badMode.error)
  );

  // --- 6. config:setDefaults ---------------------------------------------
  const defRes = await inRenderer(
    win,
    `return await window.assay.config.setDefaults({ city: 'Asheville, NC', category: 'hvac', limit: 5 });`
  );
  const afterDef = readConfig();
  check(
    'config:setDefaults persists',
    defRes && defRes.ok && afterDef && afterDef.defaults.city === 'Asheville, NC' &&
      afterDef.defaults.category === 'hvac' && afterDef.defaults.limit === 5,
    afterDef ? JSON.stringify(afterDef.defaults) : 'no file'
  );

  // --- 7. discover:search payload validation ------------------------------
  const noCity = await inRenderer(
    win,
    `return await window.assay.discover.search({ city: '', category: 'hvac' });`
  );
  check(
    'discover:search rejects a missing city',
    noCity && noCity.ok === false && noCity.error.message === 'Enter a city.',
    JSON.stringify(noCity && noCity.error)
  );

  // Key was cleared in step 3, so this must surface the no-key config error, // proving the payload got through validation and reached the key lookup.
  const noKey = await inRenderer(
    win,
    `return await window.assay.discover.search({ city: 'Asheville, NC', category: 'hvac' });`
  );
  check(
    'discover:search reaches the key check with a valid payload',
    noKey && noKey.ok === false && noKey.error.kind === 'config',
    JSON.stringify(noKey && noKey.error)
  );

  // --- 8. app:openExternal scheme guard -----------------------------------
  const badScheme = await inRenderer(
    win,
    `return await window.assay.app.openExternal('file:///C:/Windows/System32/calc.exe');`
  );
  check(
    'openExternal refuses a non-http scheme',
    badScheme && badScheme.ok === false && badScheme.error.kind === 'bad_request',
    JSON.stringify(badScheme && badScheme.error)
  );

  // --- 9. THE ORIGINAL REPORTED SCENARIO ----------------------------------
  // Not the channel, the actual button. This is what "setting the API key
  // doesn't save it" meant, so this is what has to pass.
  const ui = await inRenderer(
    win,
    `
    const input = document.querySelector('#key-googlePlaces');
    const saveBtn = Array.from(input.closest('.key-row').querySelectorAll('button'))
      .find(b => b.textContent === 'Save');
    input.value = 'UI-CLICK-KEY-9876';
    saveBtn.click();
    await new Promise(r => setTimeout(r, 500));
    // renderKeys() rebuilds the list on success, so re-query rather than
    // holding stale node references.
    const freshInput = document.querySelector('#key-googlePlaces');
    const badge = freshInput.closest('.key-row').querySelector('.badge');
    return {
      badgeText: badge ? badge.textContent.trim() : null,
      inputCleared: freshInput.value === '',
      placeholder: freshInput.getAttribute('placeholder'),
      status: document.querySelector('#settings-status').textContent.trim(),
      keyWarningHidden: document.querySelector('#key-warning').hidden,
    };
  `
  );

  const afterUi = readConfig();
  check(
    'clicking Save persists the key to disk',
    afterUi && afterUi.keys && afterUi.keys.googlePlaces === 'UI-CLICK-KEY-9876',
    afterUi ? `keys.googlePlaces = ${JSON.stringify(afterUi.keys.googlePlaces)}` : 'no file'
  );
  check(
    'the badge flips to SET after saving',
    ui && typeof ui.badgeText === 'string' && ui.badgeText.startsWith('SET'),
    `badge = ${JSON.stringify(ui && ui.badgeText)}`
  );
  check(
    'the input clears and shows a masked hint',
    ui && ui.inputCleared === true && ui.placeholder === '•••• 9876',
    `cleared=${ui && ui.inputCleared} placeholder=${JSON.stringify(ui && ui.placeholder)}`
  );
  check(
    'the NO API KEY warning disappears once a key is saved',
    ui && ui.keyWarningHidden === true,
    `keyWarningHidden = ${ui && ui.keyWarningHidden}`
  );

  // --- 10. Failures must be VISIBLE, not swallowed ------------------------
  // The defect class that hid the original bug: a typed Err that never
  // reaches a human is the same as no error handling at all.
  const emptySave = await inRenderer(
    win,
    `
    // Driven through a WIRED field. This used to use #key-lob, which no
    // longer has a Save button: lob, postgrid and anthropic have no consumer
    // in this build, so the app refuses the secret instead of writing it to
    // disk where nothing would read it. The assertion is unchanged.
    const input = document.querySelector('#key-googlePlaces');
    const saveBtn = Array.from(input.closest('.key-row').querySelectorAll('button'))
      .find(b => b.textContent === 'Save');
    input.value = '';
    saveBtn.click();
    await new Promise(r => setTimeout(r, 300));
    return document.querySelector('#settings-status').textContent.trim();
  `
  );
  check(
    'saving an empty field says so instead of doing nothing',
    typeof emptySave === 'string' && emptySave.length > 0,
    `settings status = ${JSON.stringify(emptySave)}`
  );

  // A field with no consumer must not offer to store a secret at all.
  const unwired = await inRenderer(
    win,
    `
    const input = document.querySelector('#key-anthropic');
    const saveBtn = Array.from(input.closest('.key-row').querySelectorAll('button'))
      .find(b => b.textContent === 'Save');
    return { disabled: input.disabled, hasSave: !!saveBtn };
  `
  );
  check(
    'an unwired key field offers no way to store a secret',
    unwired && unwired.disabled === true && unwired.hasSave === false,
    JSON.stringify(unwired)
  );

  // And the main process refuses it too, so the guard is not only cosmetic.
  const refused = await inRenderer(
    win,
    `return await window.assay.config.setKey('anthropic', 'PLACEHOLDER-should-never-be-stored');`
  );
  check(
    'the main process refuses to store an unwired key',
    refused && refused.ok === false && refused.error.kind === 'bad_request',
    JSON.stringify(refused)
  );
  check(
    'and the refusal never echoes the secret back',
    refused && !JSON.stringify(refused).includes('should-never-be-stored'),
    JSON.stringify(refused)
  );

  // --- 11. Phase 4 channels -----------------------------------------------
  // Added the moment these channels existed, not after. The dead-bridge bug
  // survived because the smoke test only exercised zero-argument channels
  // while every payload-carrying one was broken. Any new channel gets a case
  // here or it is untested by construction.
  // Seed the isolated userData rather than relying on a name compiled into
  // the source. The seed array used to carry a real company, so the repo
  // published one operator's off-limits list; it is data, not source. Writing
  // it here also makes this test prove more than it used to, because the
  // file-backed list is now the only list there is.
  fs.mkdirSync(TEST_USER_DATA, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_USER_DATA, 'blocklist.json'),
    JSON.stringify([{ pattern: 'northwind', reason: 'Standing off limits.', addedAt: '2026-07-30' }], null, 2),
    'utf8'
  );

  const blocked = await inRenderer(
    win,
    `return await window.assay.policy.check({ name: 'Northwind Fire and Life Safety', website: null });`
  );
  check(
    'policy:check blocks a business on the permanent off-limits list',
    blocked && blocked.ok === true && blocked.data.blocked === true &&
      typeof blocked.data.blockReason === 'string',
    JSON.stringify(blocked && blocked.data)
  );

  // A list that cannot be parsed must block everyone, not nobody.
  fs.writeFileSync(path.join(TEST_USER_DATA, 'blocklist.json'), 'not json', 'utf8');
  const corrupt = await inRenderer(
    win,
    `return await window.assay.policy.check({ name: 'Some Unrelated Shop', website: 'https://example.test' });`
  );
  check(
    'policy:check fails closed when the off-limits list is corrupt',
    corrupt && corrupt.ok === true && corrupt.data.blocked === true,
    JSON.stringify(corrupt && corrupt.data)
  );
  fs.writeFileSync(path.join(TEST_USER_DATA, 'blocklist.json'), '[]', 'utf8');

  // Barring a business has to be possible FROM THE APP. Without this channel
  // the off-limits list was inert: addToBlocklist had no callers, the seed
  // array is empty, and the only way to block anyone was hand-editing JSON.
  const blockAdd = await inRenderer(
    win,
    `return await window.assay.policy.block({ pattern: 'eastwind', reason: 'Standing off limits.' });`
  );
  check('policy:block records an entry', blockAdd && blockAdd.ok === true, JSON.stringify(blockAdd));

  const nowBlocked = await inRenderer(
    win,
    `return await window.assay.policy.check({ name: 'Eastwind Fire Protection', website: null });`
  );
  check(
    'a business blocked through the app is blocked on the next check',
    nowBlocked && nowBlocked.ok === true && nowBlocked.data.blocked === true,
    JSON.stringify(nowBlocked && nowBlocked.data)
  );

  const noPattern = await inRenderer(
    win,
    `return await window.assay.policy.block({ pattern: '   ', reason: 'x' });`
  );
  check('policy:block refuses an empty pattern',
    noPattern && noPattern.ok === false, JSON.stringify(noPattern));

  const noReason = await inRenderer(
    win,
    `return await window.assay.policy.block({ pattern: 'westwind', reason: '' });`
  );
  check('policy:block refuses an empty reason',
    noReason && noReason.ok === false, JSON.stringify(noReason));

  fs.writeFileSync(path.join(TEST_USER_DATA, 'blocklist.json'), '[]', 'utf8');

  const allowed = await inRenderer(
    win,
    `return await window.assay.policy.check({ name: 'Some Unrelated Shop', website: 'https://example.test' });`
  );
  check(
    'policy:check allows an unrelated business',
    allowed && allowed.ok === true && allowed.data.blocked === false,
    JSON.stringify(allowed && allowed.data)
  );

  const noFindings = await inRenderer(
    win,
    `return await window.assay.confirm.run({
       candidate: { name: 'X', website: 'https://example.test' },
       scanId: 'ipc', crawlerFindings: [], pastes: [] });`
  );
  check(
    'confirm:run refuses to reconcile against nothing',
    noFindings && noFindings.ok === false && noFindings.error.kind === 'bad_request',
    JSON.stringify(noFindings && noFindings.error)
  );

  // The invariant that matters most: no paste means no confirmation, and a
  // packet in that state cannot be released. If this ever passes, every law
  // downstream of the gate is decoration.
  const unconfirmed = await inRenderer(
    win,
    `return await window.assay.confirm.run({
       candidate: { placeId:'p', name: 'X', address: '', location: null,
         website: 'https://example.test', phone: null, rating: null,
         reviewCount: null, businessStatus: 'OPERATIONAL', primaryType: null,
         mapsUri: null, discoveredAt: new Date().toISOString(),
         source: 'google-places-new' },
       scanId: 'ipc',
       crawlerFindings: [{ checkId: 'website', status: 'flaw', severity: 3,
         headline: 'h', detail: 'd', evidence: [], confirmation: 'remote' }],
       pastes: [] });`
  );
  check(
    'confirm:run with no pastes leaves the finding remote',
    unconfirmed && unconfirmed.ok === true &&
      unconfirmed.data.findings.every((f) => f.confirmation === 'remote'),
    JSON.stringify(unconfirmed && unconfirmed.ok && unconfirmed.data.findings.map((f) => f.confirmation))
  );
  check(
    'confirm:run reports an unconfirmed packet as NOT releasable',
    unconfirmed && unconfirmed.ok === true && unconfirmed.data.release.ok === false &&
      typeof unconfirmed.data.release.reason === 'string',
    JSON.stringify(unconfirmed && unconfirmed.ok && unconfirmed.data.release)
  );
  check(
    'confirm:run names the missing required pastes',
    unconfirmed && unconfirmed.ok === true &&
      unconfirmed.data.missingPastes.join(',') === 'homepage,robots',
    JSON.stringify(unconfirmed && unconfirmed.ok && unconfirmed.data.missingPastes)
  );

  // --- packet:generate ------------------------------------------------------
  // The last unwired step: generatePacket had no caller outside the tests, so
  // in a running app the approval queue could only ever be filled out of band.
  const CAND = `{ placeId:'pg', name: 'Generate Test Co',
       address: '12 Harbor Rd, Anytown, PA 00000, USA', location: null,
       website: 'https://example.test', phone: null, rating: null,
       reviewCount: null, businessStatus: 'OPERATIONAL', primaryType: null,
       mapsUri: null, discoveredAt: new Date().toISOString(),
       source: 'google-places-new' }`;
  const CONFIRMED_FINDING = `[{ checkId: 'website', status: 'flaw', severity: 3,
       headline: 'Your homepage has no title tag.',
       detail: 'The page works but has no title element.',
       evidence: [{ id:'e1', url:'https://example.test/', source:'operator-browser',
         method:'GET', httpStatus:200, contentType:'text/html',
         fetchedAt: new Date().toISOString(), sha256:'a'.repeat(64),
         byteLength: 41234, storedPath:'(test)' }],
       confirmation: 'operator-confirmed',
       fix: { summary: 'Add a title tag naming the business.', effort: 'minutes' } }]`;

  // Identity first. An artifact that reaches a business has to say who sent
  // it, so generation must refuse before writing rather than print a footer
  // with a blank name in it.
  await inRenderer(win, `return await window.assay.config.setOperator({ name: '', email: '', scannerUrl: '' });`);
  const noIdentity = await inRenderer(
    win,
    `return await window.assay.packet.generate({ candidate: ${CAND},
       findings: ${CONFIRMED_FINDING}, confirmedAt: new Date().toISOString() });`
  );
  check(
    'packet:generate refuses until the operator has set their details',
    noIdentity && noIdentity.ok === false && /Settings/i.test(noIdentity.error.message),
    JSON.stringify(noIdentity && noIdentity.error)
  );

  const setOp = await inRenderer(
    win,
    `return await window.assay.config.setOperator({ name: 'Operator', email: 'hello@example.test', scannerUrl: '' });`
  );
  check('config:setOperator persists and returns it in full',
    setOp && setOp.ok === true && setOp.data.operator.name === 'Operator' &&
      setOp.data.operator.email === 'hello@example.test',
    JSON.stringify(setOp && setOp.ok && setOp.data.operator));

  // --- brand voice: stored, trimmed, capped, and fenced into the prompt -----
  const setVoice = await inRenderer(
    win,
    `return await window.assay.config.setOperator({ brandVoice: '  Short sentences. No exclamation marks.  ' });`
  );
  check('config:setOperator stores a trimmed brand voice',
    setVoice && setVoice.ok === true &&
      setVoice.data.operator.brandVoice === 'Short sentences. No exclamation marks.' &&
      setVoice.data.operator.name === 'Operator',
    JSON.stringify(setVoice && setVoice.ok && setVoice.data.operator));

  const setLongVoice = await inRenderer(
    win,
    `return await window.assay.config.setOperator({ brandVoice: 'x'.repeat(9000) });`
  );
  check('a pasted style guide is capped, not allowed to break the spawn',
    setLongVoice && setLongVoice.ok === true &&
      setLongVoice.data.operator.brandVoice.length === 1500,
    String(setLongVoice && setLongVoice.ok && setLongVoice.data.operator.brandVoice.length));

  // --- the closing ask: stored, trimmed, capped ----------------------------
  const setAsk = await inRenderer(
    win,
    `return await window.assay.config.setOperator({ ask: '  Reply and we will walk your site together.  ' });`
  );
  check('config:setOperator stores a trimmed closing ask',
    setAsk && setAsk.ok === true &&
      setAsk.data.operator.ask === 'Reply and we will walk your site together.' &&
      setAsk.data.operator.name === 'Operator',
    JSON.stringify(setAsk && setAsk.ok && setAsk.data.operator));

  const setLongAsk = await inRenderer(
    win,
    `return await window.assay.config.setOperator({ ask: 'y'.repeat(9000) });`
  );
  check('an essay of an ask is capped at the block size',
    setLongAsk && setLongAsk.ok === true && setLongAsk.data.operator.ask.length === 700,
    String(setLongAsk && setLongAsk.ok && setLongAsk.data.operator.ask.length));

  const setAskMode = await inRenderer(
    win,
    `return await window.assay.config.setOperator({ askMode: 'custom' });`
  );
  check('config:setOperator stores the ask mode',
    setAskMode && setAskMode.ok === true && setAskMode.data.operator.askMode === 'custom',
    JSON.stringify(setAskMode && setAskMode.ok && setAskMode.data.operator));

  const setBadAskMode = await inRenderer(
    win,
    `return await window.assay.config.setOperator({ askMode: 'shout-it' });`
  );
  check('an unknown ask mode is ignored, never stored',
    setBadAskMode && setBadAskMode.ok === true && setBadAskMode.data.operator.askMode === 'custom',
    JSON.stringify(setBadAskMode && setBadAskMode.ok && setBadAskMode.data.operator));

  {
    const BV = require(path.join(APP_ROOT, 'dist/main/main/agent/brand-voice.js'));
    const base = 'RULES.\n- Invent nothing.';
    const out = BV.applyBrandVoice(base, 'Sound like my site.');
    check('voice rides BELOW the rules with the precedence fence between',
      out.startsWith(base) && out.indexOf('OPERATOR VOICE') > out.indexOf('Invent nothing.') &&
        out.endsWith('Sound like my site.') && /rule above outranks|rule above|follow the rule/i.test(out),
      out.slice(0, 400));
    check('an empty voice leaves the prompt byte-identical',
      BV.applyBrandVoice(base, '   ') === base, BV.applyBrandVoice(base, '   '));

    let ranWith = null;
    const stub = {
      id: 'cli', label: 'stub',
      probe: async () => ({ available: true, detail: '' }),
      run: async (req) => { ranWith = req; return { ok: true, text: 'x', durationMs: 1 }; },
    };
    const wrapped = BV.withBrandVoice(stub, 'Say we, not I.');
    await wrapped.run({ systemPrompt: base, prompt: 'p', model: 'haiku' });
    check('the wrapper rewrites only the system prompt and passes the rest through',
      ranWith && ranWith.prompt === 'p' && ranWith.model === 'haiku' &&
        ranWith.systemPrompt.startsWith(base) && ranWith.systemPrompt.endsWith('Say we, not I.'),
      JSON.stringify(ranWith && { prompt: ranWith.prompt, model: ranWith.model }));
    check('a blank voice returns the provider itself, not a wrapper',
      BV.withBrandVoice(stub, '') === stub, String(BV.withBrandVoice(stub, '') === stub));
  }

  // Reset so later fixtures see the operator state they expect.
  await inRenderer(win, `return await window.assay.config.setOperator({ brandVoice: '' });`);

  // --- brand: accent validation and the main-side logo picker --------------
  {
    const store = require(path.join(APP_ROOT, 'dist/main/main/config/store.js'));
    const { dialog, nativeImage } = require('electron');

    const goodAccent = await inRenderer(win, `return await window.assay.config.setAccent('#2E5AAC');`);
    check('config:setAccent accepts a six-digit hex',
      goodAccent && goodAccent.ok === true && goodAccent.data.brand.accent === '#2E5AAC',
      JSON.stringify(goodAccent && goodAccent.ok && goodAccent.data.brand));

    const badAccents = ['red', '#F5D90', '#GGGGGG', "#111; } body { display:none"];
    let allRefused = true;
    for (const bad of badAccents) {
      const res = await inRenderer(win, `return await window.assay.config.setAccent(${JSON.stringify(bad)});`);
      if (!res || res.ok !== false) allRefused = false;
    }
    check('every non-hex accent is refused at the channel', allRefused, JSON.stringify(badAccents));

    const stillGood = await inRenderer(win, `return await window.assay.config.get();`);
    check('a refused accent leaves the stored one untouched',
      stillGood && stillGood.ok === true && stillGood.data.brand.accent === '#2E5AAC',
      JSON.stringify(stillGood && stillGood.ok && stillGood.data.brand));

    // A hand-edited config is the surface the channel cannot police, so the
    // load path re-validates. Write garbage straight into the file.
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    raw.brand = { accent: 'javascript:alert(1)', logo: '../../etc/passwd' };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw), 'utf8');
    store.reload();
    const coerced = store.status();
    check('a hand-edited config.json is re-validated on load, not trusted',
      coerced.brand.accent === '' && coerced.brand.logo === '',
      JSON.stringify(coerced.brand));

    // The picker runs in main, so the test stubs the dialog and drives the
    // whole choose-verify-copy flow the renderer can never fake.
    const realShowOpen = dialog.showOpenDialog;
    const fixtureDir = path.join(TEST_USER_DATA, 'brand-fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });

    const onePxPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const pngPath = path.join(fixtureDir, 'logo.png');
    fs.writeFileSync(pngPath, onePxPng);

    const svgPath = path.join(fixtureDir, 'evil.png'); // PNG name, SVG bytes
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>', 'utf8');

    const hugePath = path.join(fixtureDir, 'huge.png');
    fs.writeFileSync(hugePath, Buffer.concat([onePxPng, Buffer.alloc(600 * 1024)]));

    const pick = (p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    };

    pick(pngPath);
    const chosen = await inRenderer(win, `return await window.assay.config.chooseLogo();`);
    check('choosing a real PNG records the KIND, never a path',
      chosen && chosen.ok === true && chosen.data.brand.logo === 'png' &&
        !JSON.stringify(chosen.data.brand).includes(path.sep === '\\' ? '\\\\' : '/'),
      JSON.stringify(chosen && chosen.ok && chosen.data.brand));
    check('and the bytes are copied into the data root, not referenced in place',
      fs.existsSync(path.join(store.brandDir(), 'logo.png')),
      store.brandDir());

    pick(svgPath);
    const refusedSvg = await inRenderer(win, `return await window.assay.config.chooseLogo();`);
    check('SVG bytes wearing a .png name are refused',
      refusedSvg && refusedSvg.ok === false, JSON.stringify(refusedSvg && refusedSvg.error));

    pick(hugePath);
    const refusedHuge = await inRenderer(win, `return await window.assay.config.chooseLogo();`);
    check('an oversize image is refused',
      refusedHuge && refusedHuge.ok === false, JSON.stringify(refusedHuge && refusedHuge.error));

    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    const cancelled = await inRenderer(win, `return await window.assay.config.chooseLogo();`);
    check('cancelling the picker changes nothing',
      cancelled && cancelled.ok === true && cancelled.data.brand.logo === 'png',
      JSON.stringify(cancelled && cancelled.ok && cancelled.data.brand));

    const cleared = await inRenderer(win, `return await window.assay.config.clearLogo();`);
    check('clearing removes the marker and the stored copy',
      cleared && cleared.ok === true && cleared.data.brand.logo === '' &&
        !fs.existsSync(path.join(store.brandDir(), 'logo.png')),
      JSON.stringify(cleared && cleared.ok && cleared.data.brand));

    dialog.showOpenDialog = realShowOpen;
    await inRenderer(win, `return await window.assay.config.setAccent('');`);
  }

  const unconfirmedGen = await inRenderer(
    win,
    `return await window.assay.packet.generate({ candidate: ${CAND},
       findings: [{ checkId:'website', status:'flaw', severity:3, headline:'h', detail:'d',
         evidence: [], confirmation: 'remote' }],
       confirmedAt: new Date().toISOString() });`
  );
  check(
    'packet:generate refuses an unconfirmed finding',
    unconfirmedGen && unconfirmedGen.ok === false && unconfirmedGen.error.kind === 'bad_request',
    JSON.stringify(unconfirmedGen && unconfirmedGen.error)
  );

  const emptyFindings = await inRenderer(
    win,
    `return await window.assay.packet.generate({ candidate: ${CAND}, findings: [], confirmedAt: null });`
  );
  check('packet:generate refuses with nothing to generate from',
    emptyFindings && emptyFindings.ok === false && emptyFindings.error.kind === 'bad_request',
    JSON.stringify(emptyFindings && emptyFindings.error));

  const generated = await inRenderer(
    win,
    `return await window.assay.packet.generate({ candidate: ${CAND},
       findings: ${CONFIRMED_FINDING}, confirmedAt: new Date().toISOString() });`
  );
  check(
    'packet:generate writes a packet from a confirmed finding',
    generated && generated.ok === true && generated.data.artifacts.length >= 3,
    JSON.stringify(generated && generated.error ? generated.error : generated && generated.data && generated.data.artifacts.length)
  );
  check(
    'every generated artifact is on disk',
    generated && generated.ok === true &&
      generated.data.artifacts.every((a) => fs.existsSync(a.absolutePath)),
    JSON.stringify(generated && generated.ok && generated.data.artifacts.map((a) => a.filename))
  );

  // The scorecard is the document a prospect opens. It ships as a PDF, not as
  // a loose .html that renders differently in every browser and can be edited
  // after the gate has hashed it. This is the only place the real printer runs.
  const pdfArtifact = generated && generated.ok
    ? generated.data.artifacts.find((a) => a.filename.endsWith('.pdf'))
    : null;
  check('the scorecard ships as a PDF', !!pdfArtifact && pdfArtifact.kind === 'Scorecard',
    JSON.stringify(generated && generated.ok && generated.data.artifacts.map((a) => a.filename)));
  check('no loose .html is written beside it',
    generated && generated.ok === true &&
      generated.data.artifacts.every((a) => !a.filename.endsWith('.html')),
    JSON.stringify(generated && generated.ok && generated.data.artifacts.map((a) => a.filename)));

  const pdfBytes = pdfArtifact ? fs.readFileSync(pdfArtifact.absolutePath) : Buffer.alloc(0);
  check('it is a real PDF, header and trailer',
    pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-' &&
      pdfBytes.subarray(-1024).toString('latin1').includes('%%EOF'),
    `${pdfBytes.length} bytes, head ${pdfBytes.subarray(0, 8).toString('latin1')}`);
  /**
   * Embedded faces are what make it look the same on a machine that has never
   * seen Archivo Black. `/FontFile` alone does NOT prove that: Chromium
   * embeds a subset of whatever it used, so a total fallback to Arial embeds
   * a FontFile too and the old assertion passed on a document with none of
   * the brand type in it. Verified by the pre-merge verification pass, which
   * rendered with no woff2 at all and watched it pass. The face names are
   * the evidence.
   */
  const pdfText = pdfBytes.toString('latin1');
  check('the brand fonts are embedded in the PDF, by name',
    pdfBytes.includes(Buffer.from('/FontFile')) &&
      /ArchivoBlack/.test(pdfText) && /Inter/.test(pdfText) && /JetBrainsMono/.test(pdfText),
    `${pdfBytes.length} bytes, faces: ${(pdfText.match(/\/BaseFont\s*\/[A-Za-z0-9+-]+/g) || []).join(', ')}`);
  // A blank or one-line page would still be a valid PDF, so size is the cheap
  // proxy for "it actually rendered the sheet".
  check('the PDF is a rendered document rather than a blank page',
    // Threshold recalibrated when the fonts started embedding correctly: the
    // subsets of the five real faces are smaller than the four fallback faces
    // Chromium was embedding when it could not find them, so a correct
    // document is now ~33KB where a wrong one was ~75KB. Bigger is not
    // better here; this is only a floor against a blank page.
    pdfBytes.length > 20000, `${pdfBytes.length} bytes`);

  // --- the PDF window's egress, now that images are enabled ----------------
  // FIRST direct coverage of the real printer's request blocker. The map's
  // images:true flip means an <img> can DRAW; this proves it still cannot
  // FETCH. A live local server stands in for a prospect's tracking pixel: if
  // the blocker ever stops cancelling, this test records a hit and fails,
  // rather than a client's server learning when their PDF was rendered.
  {
    const http = require('node:http');
    const { htmlToPdf } = require(path.join(APP_ROOT, 'dist/main/main/packet/pdf.js'));

    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const hostile =
      `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>` +
      `<p>rendered</p>` +
      `<img src="http://127.0.0.1:${port}/pixel.png" alt="">` +
      `<div style="background-image:url('http://127.0.0.1:${port}/bg.png');width:10px;height:10px"></div>` +
      `</body></html>`;

    let pdfOut = Buffer.alloc(0);
    let threw = null;
    try {
      pdfOut = await htmlToPdf(hostile, { fontsDir: path.join(APP_ROOT, 'assets', 'fonts') });
    } catch (e) {
      threw = e;
    }
    await new Promise((resolve) => server.close(resolve));

    check('a document that asks for a remote image still renders',
      !threw && pdfOut.subarray(0, 5).toString('latin1') === '%PDF-',
      threw ? String(threw.message) : `${pdfOut.length} bytes`);
    check('and the remote server is never contacted, with images enabled',
      hits === 0, `${hits} request(s) reached the test server`);

    /**
     * The other half, and the half the egress test cannot see: images are
     * ENABLED. Both assertions above pass identically with images:false, so
     * without this a revert of the flip would ship a logo-shaped hole in
     * every branded PDF with a green suite. A large red data: PNG either
     * draws, and the page carries an image object, or it does not.
     */
    const RED_DOT =
      'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAWklEQVR42u3PQREAAAgDoC1c6BbwFRp' +
      'wm3bYbBIFCRIkSJAgQYIECRIkSJAgQYIECRIkSJAgQYIECRIkSJAgQYIECRIkSJAgQYIECRIkSJAgQ' +
      'YIECRIk6MUCFPUBAYUB1z0AAAAASUVORK5CYII=';
    // Identical documents but for the tag, so the only difference measured is
    // the image itself rather than font embedding.
    const doc = (body) =>
      `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><p>x</p>${body}</body></html>`;
    const opts = { fontsDir: path.join(APP_ROOT, 'assets', 'fonts') };
    const imgPdf = await htmlToPdf(doc(`<img src="data:image/png;base64,${RED_DOT}" alt="x">`), opts);
    const plainPdf = await htmlToPdf(doc(''), opts);
    // "/Image" alone is in Chromium's default ProcSet and appears either way;
    // an actual drawn bitmap is an XObject and adds real bytes.
    const hasBitmap = (b) => b.includes(Buffer.from('/Subtype /Image')) || b.includes(Buffer.from('/XObject'));
    check('a data: image actually DRAWS, which is what images:true buys',
      hasBitmap(imgPdf) && !hasBitmap(plainPdf) && imgPdf.length > plainPdf.length + 200,
      `with: ${hasBitmap(imgPdf)} (${imgPdf.length}B), without: ${hasBitmap(plainPdf)} (${plainPdf.length}B)`);
  }

  // "Clean every time" is the requirement, so print it twice and compare.
  const again = await inRenderer(
    win,
    `return await window.assay.packet.generate({ candidate: ${CAND},
       findings: ${CONFIRMED_FINDING}, confirmedAt: new Date().toISOString() });`
  );
  const pdf2 = again && again.ok
    ? fs.readFileSync(again.data.artifacts.find((a) => a.filename.endsWith('.pdf')).absolutePath)
    : Buffer.alloc(0);
  check('a second run renders the same document, not a race',
    pdf2.length > 20000 && Math.abs(pdf2.length - pdfBytes.length) < pdfBytes.length * 0.02,
    `${pdfBytes.length} then ${pdf2.length}`);
  // The whole point of the wiring: generation cannot produce something the
  // approval gate has never heard of.
  check(
    'generation puts every artifact in the queue as PREPARED, never approved',
    generated && generated.ok === true &&
      generated.data.queue.length === generated.data.artifacts.length &&
      generated.data.queue.every((q) => q.state === 'prepared'),
    JSON.stringify(generated && generated.ok && generated.data.queue.map((q) => `${q.filename}:${q.state}`))
  );
  check(
    'the queue rows carry the candidate they belong to',
    generated && generated.ok === true &&
      generated.data.queue.every((q) => q.candidateName === 'Generate Test Co'),
    JSON.stringify(generated && generated.ok && generated.data.queue.map((q) => q.candidateName))
  );

  const viaQueue = await inRenderer(win, `return await window.assay.approval.queue();`);
  check(
    'approval:queue sees what generation just wrote',
    viaQueue && viaQueue.ok === true && viaQueue.data.length >= 3,
    JSON.stringify(viaQueue && viaQueue.ok && viaQueue.data.length)
  );

  // Asked of the app rather than spelled out here. These paths were written as
  // `<userData>/packets/...` and broke the moment the data root was reshaped,
  // which is a test asserting a directory name rather than a behaviour.
  const PACKETS = require(path.join(APP_ROOT, 'dist/main/main/config/store.js')).packetsDir();

  // Reset so the Law 3 fixtures below start from a known ledger.
  fs.mkdirSync(PACKETS, { recursive: true });
  fs.writeFileSync(path.join(PACKETS, 'approvals.json'), '[]', 'utf8');

  // --- Law 3 over the bridge ----------------------------------------------
  // Every one of these passes a PAYLOAD. The dead-bridge bug survived a green
  // suite because the smoke test only ever exercised zero-argument channels,
  // so a channel is not considered wired here until it has been called with
  // arguments and its refusals have been driven too.
  const draftDir = path.join(PACKETS, 'clients', 'Anytown-PA__Test-Shop', '02-drafts', '2026-07-31');
  fs.mkdirSync(draftDir, { recursive: true });
  const artifactPath = path.join(draftDir, 'Test-Shop__Scorecard__2026-07-31.md');
  fs.writeFileSync(artifactPath, '# Scorecard\n\nA real file, so the gate can hash it.\n', 'utf8');

  const ITEM_ID = 'Anytown-PA__Test-Shop::2026-07-31::Test-Shop__Scorecard__2026-07-31.md';
  const writeLedger = (rows) =>
    fs.writeFileSync(path.join(PACKETS, 'approvals.json'), JSON.stringify(rows, null, 2), 'utf8');

  const preparedRow = {
    itemId: ITEM_ID,
    kind: 'Scorecard',
    slug: 'Anytown-PA__Test-Shop',
    filename: 'Test-Shop__Scorecard__2026-07-31.md',
    absolutePath: artifactPath,
    state: 'prepared',
  };
  writeLedger([preparedRow]);

  const CONFIRMED = `[{ checkId: 'website', status: 'flaw', severity: 3, headline: 'h', detail: 'd',
      evidence: [], confirmation: 'operator-confirmed' }]`;

  const queue1 = await inRenderer(win, `return await window.assay.approval.queue();`);
  check(
    'approval:queue returns the prepared item',
    queue1 && queue1.ok === true && queue1.data.length === 1 && queue1.data[0].state === 'prepared',
    JSON.stringify(queue1 && queue1.ok && queue1.data.map((q) => `${q.filename}:${q.state}`))
  );

  // Approval re-runs releasable(), so an unconfirmed finding is refused HERE
  // even if it somehow passed at generation time. This is the check that makes
  // checking twice worth anything.
  const remoteApprove = await inRenderer(
    win,
    `return await window.assay.approval.approve({ itemId: ${JSON.stringify(ITEM_ID)},
       findings: [{ checkId: 'website', status: 'flaw', severity: 3, headline: 'h', detail: 'd',
         evidence: [], confirmation: 'remote' }],
       confirmedAt: new Date().toISOString() });`
  );
  check(
    'approval:approve refuses an unconfirmed finding',
    remoteApprove && remoteApprove.ok === false && remoteApprove.error.kind === 'bad_request',
    JSON.stringify(remoteApprove && remoteApprove.error)
  );

  const stale = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
  const staleApprove = await inRenderer(
    win,
    `return await window.assay.approval.approve({ itemId: ${JSON.stringify(ITEM_ID)},
       findings: ${CONFIRMED}, confirmedAt: ${JSON.stringify(stale)} });`
  );
  check(
    'approval:approve refuses a confirmation older than 72 hours',
    staleApprove && staleApprove.ok === false,
    JSON.stringify(staleApprove && staleApprove.error)
  );

  const noId = await inRenderer(
    win,
    `return await window.assay.approval.approve({ findings: [], confirmedAt: null });`
  );
  check('approval:approve refuses a missing itemId',
    noId && noId.ok === false && noId.error.kind === 'bad_request', JSON.stringify(noId));

  const approved = await inRenderer(
    win,
    `return await window.assay.approval.approve({ itemId: ${JSON.stringify(ITEM_ID)},
       findings: ${CONFIRMED}, confirmedAt: new Date().toISOString() });`
  );
  check(
    'approval:approve approves a confirmed, prepared item',
    approved && approved.ok === true && approved.data.item.filename === preparedRow.filename,
    JSON.stringify(approved && approved.error ? approved.error : approved && approved.data && approved.data.item)
  );
  check(
    'the approved row records when, and the bytes it approved',
    approved && approved.ok === true &&
      approved.data.queue[0].state === 'approved' &&
      typeof approved.data.queue[0].approvedAt === 'string' &&
      typeof approved.data.queue[0].sha256 === 'string',
    JSON.stringify(approved && approved.ok && approved.data.queue[0])
  );
  // The token's authority is a WeakSet private to main. Anything crossing the
  // bridge is a plain object, and it must not look like one.
  check(
    'no approval token crosses the bridge',
    approved && approved.ok === true &&
      Object.keys(approved.data.item).sort().join(',') ===
        'approvedAt,filename,itemId,kind,slug',
    JSON.stringify(approved && approved.ok && Object.keys(approved.data.item))
  );

  const noReasonReject = await inRenderer(
    win,
    `return await window.assay.approval.reject({ itemId: ${JSON.stringify(ITEM_ID)}, reason: '   ' });`
  );
  check(
    'approval:reject refuses an empty reason',
    noReasonReject && noReasonReject.ok === false && noReasonReject.error.kind === 'bad_request',
    JSON.stringify(noReasonReject && noReasonReject.error)
  );

  const rejected = await inRenderer(
    win,
    `return await window.assay.approval.reject({ itemId: ${JSON.stringify(ITEM_ID)},
       reason: 'Wrong contact named on the scorecard.' });`
  );
  check(
    'approval:reject revokes an approval and keeps the reason',
    rejected && rejected.ok === true &&
      rejected.data.queue[0].state === 'rejected' &&
      rejected.data.queue[0].reason === 'Wrong contact named on the scorecard.',
    JSON.stringify(rejected && rejected.ok && rejected.data.queue[0])
  );

  // A ledger that cannot be read must not report as "nothing is waiting".
  // That silently re-offers a rejected item and loses why it was rejected.
  fs.writeFileSync(path.join(PACKETS, 'approvals.json'), 'not json', 'utf8');
  const corruptQueue = await inRenderer(win, `return await window.assay.approval.queue();`);
  check(
    'approval:queue fails loudly on an unreadable ledger, never as empty',
    corruptQueue && corruptQueue.ok === false,
    JSON.stringify(corruptQueue)
  );

  // --- The counter, driven through the real UI ----------------------------
  // Rendering a view from a hand-made object proves nothing about the channel
  // behind it, so these click the real nav button and the real buttons in the
  // pane, against the real ledger on disk.
  const crypto = require('node:crypto');
  const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  const scanPath = path.join(draftDir, 'Test-Shop__AI-Readiness-Scan__2026-07-31.md');
  fs.writeFileSync(scanPath, '# Scan\n', 'utf8');
  const kitPath = path.join(draftDir, 'Test-Shop__Schema-Starter__2026-07-31.md');
  fs.writeFileSync(kitPath, '# Kit\n', 'utf8');

  writeLedger([
    preparedRow,
    {
      itemId: 'Anytown-PA__Test-Shop::2026-07-31::Test-Shop__AI-Readiness-Scan__2026-07-31.md',
      kind: 'AI-Readiness-Scan', slug: 'Anytown-PA__Test-Shop',
      filename: 'Test-Shop__AI-Readiness-Scan__2026-07-31.md', absolutePath: scanPath,
      state: 'approved', approvedAt: new Date().toISOString(), sha256: hashOf(scanPath),
    },
    {
      // Approved, then the bytes changed. Looks identical in a folder.
      itemId: 'Anytown-PA__Test-Shop::2026-07-31::Test-Shop__Schema-Starter__2026-07-31.md',
      kind: 'Schema-Starter', slug: 'Anytown-PA__Test-Shop',
      filename: 'Test-Shop__Schema-Starter__2026-07-31.md', absolutePath: kitPath,
      state: 'approved', approvedAt: new Date().toISOString(), sha256: 'f'.repeat(64),
    },
  ]);

  const queueUi = await inRenderer(
    win,
    `document.querySelector('.app-nav .btn[data-view="approvals"]').click();
     await new Promise((r) => setTimeout(r, 400));
     return {
       counterShown: !document.querySelector('#counter').hidden,
       railItems: document.querySelectorAll('.rail-item').length,
       groups: [...document.querySelectorAll('.rail-group')].map((n) => n.textContent),
       chip: document.querySelector('#rail-waiting-chip').textContent,
       navCount: document.querySelector('#nav-approvals-count').textContent,
       navHidden: document.querySelector('#nav-approvals-count').hidden,
     };`
  );
  check('the queue renders every ledger row in the rail',
    queueUi && queueUi.counterShown === true && queueUi.railItems === 3, JSON.stringify(queueUi));
  // Three groups, not two: the fixture's third row is approved AND edited
  // since, which must not be filed with the genuinely cleared work.
  check('the rail separates what is waiting from what is decided',
    queueUi && queueUi.groups.some((g) => /Waiting on you \(1\)/.test(g)) &&
      queueUi.groups.some((g) => /Cleared \(1\)/.test(g)),
    JSON.stringify(queueUi && queueUi.groups));
  check('an item edited after approval is not filed as cleared',
    queueUi && queueUi.groups.some((g) => /Needs another look \(1\)/.test(g)),
    JSON.stringify(queueUi && queueUi.groups));
  check('the waiting count is on the nav and in the rail head',
    queueUi && queueUi.chip === '1 WAITING' && queueUi.navCount === '1' && queueUi.navHidden === false,
    JSON.stringify(queueUi));

  // An artifact edited after approval is the failure mode a folder cannot
  // show: assertMinted refuses it, but only at send time, by which point the
  // operator believes it is cleared.
  const changed = await inRenderer(
    win,
    `[...document.querySelectorAll('.rail-item')]
       .find((b) => b.textContent.includes('Schema starter kit')).click();
     await new Promise((r) => setTimeout(r, 150));
     const pane = document.querySelector('#queue-detail');
     return {
       warned: (pane.textContent || '').includes('CHANGED AFTER IT WAS APPROVED'),
       chip: pane.querySelector('.chip').textContent,
     };`
  );
  check('an artifact edited after approval says so in the pane',
    changed && changed.warned === true && changed.chip === 'CHANGED SINCE APPROVED',
    JSON.stringify(changed));

  // Rejecting without a reason must be refused, and the refusal must be the
  // gate's, surfaced where the operator is looking.
  const emptyReject = await inRenderer(
    win,
    `[...document.querySelectorAll('.rail-item')]
       .find((b) => b.textContent.includes('Scorecard')).click();
     await new Promise((r) => setTimeout(r, 150));
     document.querySelector('#reject-open').click();
     document.querySelector('#reject-reason').value = '   ';
     document.querySelector('#reject-go').click();
     await new Promise((r) => setTimeout(r, 400));
     return { status: document.querySelector('#approvals-status').textContent || '' };`
  );
  check('rejecting with no reason is refused, visibly',
    emptyReject && /reason/i.test(emptyReject.status), JSON.stringify(emptyReject));

  const realReject = await inRenderer(
    win,
    `document.querySelector('#reject-reason').value = 'Wrong contact named on the scorecard.';
     document.querySelector('#reject-go').click();
     await new Promise((r) => setTimeout(r, 400));
     return {
       groups: [...document.querySelectorAll('.rail-group')].map((n) => n.textContent),
       chip: document.querySelector('#rail-waiting-chip').textContent,
       navHidden: document.querySelector('#nav-approvals-count').hidden,
     };`
  );
  check('rejecting through the UI moves the item out of waiting',
    realReject && realReject.chip === '0 WAITING' &&
      realReject.groups.some((g) => /Rejected \(1\)/.test(g)),
    JSON.stringify(realReject));
  check('the nav count disappears when nothing is waiting',
    realReject && realReject.navHidden === true, JSON.stringify(realReject));

  const ledgerAfter = JSON.parse(fs.readFileSync(path.join(PACKETS, 'approvals.json'), 'utf8'));
  const rejectedRow = ledgerAfter.find((r) => r.itemId === ITEM_ID);
  check('the rejection reason reached the ledger on disk',
    rejectedRow && rejectedRow.state === 'rejected' &&
      rejectedRow.reason === 'Wrong contact named on the scorecard.',
    JSON.stringify(rejectedRow));

  // Reject then approve was a dead end over the bridge too: the operator got
  // "was rejected" and no way forward. Reopening is the way forward, and it is
  // not an unapprove: it returns the item to prepared, still short of sendable.
  const blockedApprove = await inRenderer(
    win,
    `return await window.assay.approval.approve({ itemId: ${JSON.stringify(ITEM_ID)},
       findings: ${CONFIRMED}, confirmedAt: new Date().toISOString() });`
  );
  check('approving a rejected item is refused, and names reopening',
    blockedApprove && blockedApprove.ok === false && /reopen/i.test(blockedApprove.error.message),
    JSON.stringify(blockedApprove && blockedApprove.error));

  const reopenNoReason = await inRenderer(
    win,
    `return await window.assay.approval.reopen({ itemId: ${JSON.stringify(ITEM_ID)}, reason: '  ' });`
  );
  check('approval:reopen refuses an empty reason',
    reopenNoReason && reopenNoReason.ok === false, JSON.stringify(reopenNoReason && reopenNoReason.error));

  const reopened = await inRenderer(
    win,
    `return await window.assay.approval.reopen({ itemId: ${JSON.stringify(ITEM_ID)},
       reason: 'Regenerated with the contact fixed.' });`
  );
  check('approval:reopen returns a rejection to prepared',
    reopened && reopened.ok === true &&
      reopened.data.queue.find((q) => q.itemId === ITEM_ID).state === 'prepared',
    JSON.stringify(reopened && reopened.ok && reopened.data.queue.find((q) => q.itemId === ITEM_ID)));

  const nowApproved = await inRenderer(
    win,
    `return await window.assay.approval.approve({ itemId: ${JSON.stringify(ITEM_ID)},
       findings: ${CONFIRMED}, confirmedAt: new Date().toISOString() });`
  );
  check('and it can then be approved through the bridge',
    nowApproved && nowApproved.ok === true, JSON.stringify(nowApproved && nowApproved.error));

  const noUnapprove = await inRenderer(
    win,
    `return await window.assay.approval.reopen({ itemId: ${JSON.stringify(ITEM_ID)}, reason: 'changed my mind' });`
  );
  check('an approved item cannot be reopened over the bridge either',
    noUnapprove && noUnapprove.ok === false && /unapprove/i.test(noUnapprove.error.message),
    JSON.stringify(noUnapprove && noUnapprove.error));

  writeLedger([]);

  // --- the tiles:// proxy, the map picker's only egress ---------------------
  // Positive coverage for the one new outbound surface: the handler is driven
  // directly (no window, no network) in stub mode, and the refusal shapes are
  // pinned so a coordinate can never name a path or an out-of-range tile.
  {
    const T = require(path.join(APP_ROOT, 'dist/main/main/tiles/proxy.js'));

    check('a valid tile URL parses to integer coordinates',
      JSON.stringify(T.parseTileUrl('tiles://osm/12/1145/1545.png')) ===
        JSON.stringify({ z: 12, x: 1145, y: 1545 }),
      JSON.stringify(T.parseTileUrl('tiles://osm/12/1145/1545.png')));

    const refused = [
      'tiles://osm/20/1/1.png',          // zoom past the cap
      'tiles://osm/2/4/1.png',           // x outside 2^z
      'tiles://osm/2/1/4.png',           // y outside 2^z
      'tiles://osm/12/-1/5.png',         // negative
      'tiles://osm/12/1.5/5.png',        // float
      'tiles://osm/12/1/5.jpg',          // wrong extension
      'tiles://elsewhere/12/1/5.png',    // wrong host
      'https://tile.openstreetmap.org/12/1/5.png', // wrong scheme
      'not a url',
    ];
    check('every malformed or out-of-range tile URL is refused',
      refused.every((u) => T.parseTileUrl(u) === null),
      JSON.stringify(refused.map((u) => [u, T.parseTileUrl(u)])));

    // Dot segments are canonicalized by the URL layer before the parser
    // runs (Chromium does the same before the handler ever sees the URL),
    // so a traversal-shaped request resolves to a plain in-range tile.
    // Containment rests on the coordinates being bounded integers, never on
    // string filtering; this pins that the output is exactly that.
    check('a traversal-shaped URL canonicalizes to bounded integers, nothing else',
      JSON.stringify(T.parseTileUrl('tiles://osm/12/1/../1/5.png')) ===
        JSON.stringify({ z: 12, x: 1, y: 5 }) &&
      JSON.stringify(T.parseTileUrl('tiles://osm/12/1/2/%2e%2e/3.png')) ===
        JSON.stringify({ z: 12, x: 1, y: 3 }),
      JSON.stringify([
        T.parseTileUrl('tiles://osm/12/1/../1/5.png'),
        T.parseTileUrl('tiles://osm/12/1/2/%2e%2e/3.png'),
      ]));

    const stub = await T.handleTileRequest('tiles://osm/12/1145/1545.png',
      { cacheDir: path.join(TEST_USER_DATA, 'tiles'), stub: true });
    const stubBytes = Buffer.from(await stub.arrayBuffer());
    check('stub mode serves a real PNG with no network',
      stub.status === 200 && stub.headers.get('Content-Type') === 'image/png' &&
        stubBytes.length > 8 && stubBytes.readUInt32BE(0) === 0x89504e47,
      `status ${stub.status}, ${stubBytes.length} bytes`);

    const bad = await T.handleTileRequest('tiles://osm/20/1/1.png',
      { cacheDir: path.join(TEST_USER_DATA, 'tiles'), stub: true });
    check('the handler refuses what the parser refuses, before any fetch',
      bad.status === 400, `status ${bad.status}`);
  }

  // --- the map panel in the loaded window -----------------------------------
  const mapUi = await inRenderer(
    win,
    `return {
       panelExists: !!document.querySelector('#map-panel'),
       panelHidden: document.querySelector('#map-panel').hidden,
       toggleHidden: document.querySelector('#map-toggle').hidden,
       leafletLoaded: typeof window.L !== 'undefined',
       coreLoaded: typeof window.assayMapCore !== 'undefined',
       csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
     };`
  );
  check('the map panel ships closed and the toggle waits for results',
    mapUi && mapUi.panelExists === true && mapUi.panelHidden === true && mapUi.toggleHidden === true,
    JSON.stringify(mapUi));
  check('Leaflet and the map core loaded under script-src self',
    mapUi && mapUi.leafletLoaded === true && mapUi.coreLoaded === true,
    JSON.stringify(mapUi));
  check('the CSP names the tiles: scheme and still no external origin',
    mapUi && /img-src [^;]*tiles:/.test(mapUi.csp) && !/https:/.test(mapUi.csp) &&
      /connect-src 'none'/.test(mapUi.csp),
    mapUi && mapUi.csp);
}

app.whenReady().then(async () => {
  registerHandlers();

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist/main/main/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadFile(path.join(APP_ROOT, 'src/renderer/index.html'));

  let fatal = null;
  try {
    await run(win);
  } catch (e) {
    fatal = e;
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n--- IPC INTEGRATION TEST ---');
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (!r.pass && r.detail) console.log(`        got: ${r.detail}`);
  }
  if (fatal) console.log(`\n  THREW: ${fatal.stack || fatal}`);
  console.log(
    `\n  ${results.length - failed.length}/${results.length} passed` +
      (failed.length || fatal ? ', FAIL\n' : ', PASS\n')
  );

  try {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  app.exit(failed.length || fatal ? 1 : 0);
});

/**
 * One ipcMain.handle per channel. Handlers stay thin: validate the payload,
 * call the module that does the work, return a Result. They never throw across
 * the IPC boundary, an uncaught error there surfaces in the renderer as an
 * opaque "Error invoking remote method", which is useless to debug.
 */

import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron';
import { CH, AppInfo } from '../../shared/channels';
import {
  AgentMode,
  AppConfig,
  Candidate,
  ConfirmRequest,
  ConfirmResponse,
  FlawFinding,
  PolicyVerdict,
  Result,
  RunCheckRequest,
  SearchPlacesRequest,
  err,
  ok,
} from '../../shared/types';
import { ApprovalRefused, approve, queueView, reject, reopen } from '../approval/gate';
import { generatePacket, type Renderer } from '../packet/generate';
import { brandContext } from '../packet/brand';
import { htmlToPdf } from '../packet/pdf';
import { scorecardRenderer } from '../packet/render/scorecard';
import { schemaKitRenderer } from '../packet/render/schema-kit';
import { socialPostRenderer } from '../packet/render/social';
import { postcardFrontRenderer } from '../packet/render/postcard';

/**
 * Every artifact a packet produces, in the order they are written.
 *
 * The first three are the free tier. The social post and postcard are
 * delivery vehicles rather than deliverables, and 00-INDEX says so in the
 * packet itself, so the rule travels with the work instead of living here.
 */
const PACKET_RENDERERS: Renderer[] = [
  scorecardRenderer,
  schemaKitRenderer,
  socialPostRenderer,
  postcardFrontRenderer,
];

/**
 * Where the woff2 files copy-assets.js produces live, so the PDF can embed
 * them. Resolved from this file's own location, the way main.ts resolves
 * APP_ROOT, rather than from app.getAppPath().
 *
 * getAppPath() answers a different question depending on how Electron was
 * started: `electron .` gives the repo, `electron scripts/test-ipc.js` gives
 * the script's folder. The suite took the second path, so the fonts were
 * never found there and every PDF it printed fell back to Arial while
 * asserting only that SOME font was embedded. Found when the pre-merge
 * verification pass showed that assertion could not fail.
 */
const fontsDir = (): string => path.resolve(__dirname, '..', '..', '..', '..', 'assets', 'fonts');
import * as config from '../config/store';
import { searchPlaces } from '../discovery/places';
import { providerFor } from '../agent/resolve';
import { withBrandVoice } from '../agent/brand-voice';
import { runChecks } from '../checks/registry';
import { confirm, looksLikeEscapedViewSource, releasable } from '../confirmation/gate';
import { addToBlocklist, blockedBy, loadBlocklist, pacingWarning, type PacketStart } from '../confirmation/policy';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Packet starts, for the pacing rule. A tiny append-only log rather than a
 * table: the only question ever asked of it is "what did I start recently",
 * and it must survive a restart or the rule is trivially defeated by quitting
 * the app.
 */
function packetLogPath(root: string): string {
  return path.join(root, 'packet-starts.json');
}

function readPacketStarts(root: string): PacketStart[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(packetLogPath(root), 'utf8'));
    if (Array.isArray(raw)) {
      return raw.filter(
        (x): x is PacketStart =>
          !!x && typeof (x as PacketStart).candidateName === 'string' && typeof (x as PacketStart).startedAt === 'string'
      );
    }
  } catch {
    /* no log yet, or unreadable: pacing simply has nothing to warn about */
  }
  return [];
}

function recordPacketStart(root: string, candidateName: string): void {
  try {
    const starts = readPacketStarts(root);
    starts.push({ candidateName, startedAt: new Date().toISOString() });
    // Keep the tail only; this is a pacing window, not a history.
    const trimmed = starts.slice(-50);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(packetLogPath(root), JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (e) {
    console.error('[pacing] could not record packet start:', (e as Error).message);
  }
}

type PayloadHandler = (payload: unknown) => Promise<unknown> | unknown;

/**
 * Wraps a handler so that (a) any thrown error becomes a typed Err instead of
 * an opaque IPC fault, and (b) the handler receives the PAYLOAD, not Electron's
 * event object.
 *
 * Point (b) is load-bearing. `ipcMain.handle` invokes its listener as
 * `listener(event, ...args)`. An earlier version of this wrapper forwarded
 * `...args` verbatim, which bound every handler's first parameter to the
 * IpcMainInvokeEvent instead of the payload. The two zero-argument channels
 * kept working, so the app looked healthy while all five payload-carrying
 * channels silently rejected everything as malformed.
 *
 * The event is dropped on purpose: no handler here needs the sender, and
 * dropping it makes the mistake unrepeatable. scripts/test-ipc.js is the guard.
 */
function safe(channel: string, fn: PayloadHandler) {
  return async (_event: IpcMainInvokeEvent, payload: unknown) => {
    try {
      return await fn(payload);
    } catch (e) {
      const error = e as Error;
      console.error(`[ipc:${channel}]`, error);
      return err('internal', 'Something failed inside the app.', {
        detail: `${error.name}: ${error.message}`,
      });
    }
  };
}

const VALID_KEY_NAMES: (keyof AppConfig['keys'])[] = [
  'googlePlaces',
  'anthropic',
  'lob',
  'postgrid',
];

/**
 * Keys whose consumer actually exists.
 *
 * Everything else is a field that takes a real API key, writes it to disk, and
 * is never read by anything. `anthropic` is only consulted by
 * `apiKeyAvailable()`, which has no callers at all: `providerFor('auto')`
 * returns the CLI provider unconditionally and `providerFor('sdk-apikey')`
 * returns a provider that always fails, because sdk-apikey.ts does not exist.
 * `lob` and `postgrid` are worse, because there is no sender in this codebase
 * at all.
 *
 * Storing a secret nothing reads is a liability with no upside, and a Settings
 * field that accepts one is a claim the app cannot back. Refuse until the
 * consumer lands, then add the name here.
 */
const WIRED_KEY_NAMES: (keyof AppConfig['keys'])[] = ['googlePlaces'];

const UNWIRED_REASON: Record<string, string> = {
  anthropic:
    'The Agent SDK path is not built, and auto mode always uses the claude CLI, so this key would never be read. Run `claude login` instead.',
  lob: 'There is no sender in this build, so a postcard key would never be read.',
  postgrid: 'There is no sender in this build, so a postcard key would never be read.',
};

const VALID_AGENT_MODES: AgentMode[] = ['auto', 'cli', 'sdk-apikey', 'sdk-subscription'];

export function registerHandlers(): void {
  ipcMain.handle(
    CH.configGet,
    safe(CH.configGet, () => ok(config.status()))
  );

  ipcMain.handle(
    CH.configSetKey,
    safe(CH.configSetKey, (payload) => {
      const p = payload as { key?: unknown; value?: unknown };
      const key = p?.key;
      const value = p?.value;
      if (typeof key !== 'string' || !VALID_KEY_NAMES.includes(key as keyof AppConfig['keys'])) {
        return err('bad_request', `Unknown key name: ${String(key)}`);
      }
      if (typeof value !== 'string') {
        return err('bad_request', 'Key value must be a string.');
      }
      // Clearing an unwired key is always allowed, so a key stored by an
      // earlier build can still be removed.
      if (value !== '' && !WIRED_KEY_NAMES.includes(key as keyof AppConfig['keys'])) {
        return err(
          'bad_request',
          UNWIRED_REASON[key] ?? 'Nothing in this build reads that key, so it will not be stored.'
        );
      }
      return ok(config.setKey(key as keyof AppConfig['keys'], value));
    })
  );

  ipcMain.handle(
    CH.configSetDefaults,
    safe(CH.configSetDefaults, (payload) => {
      const p = (payload ?? {}) as Partial<AppConfig['defaults']>;
      return ok(config.setDefaults(p));
    })
  );

  ipcMain.handle(
    CH.configSetAgentMode,
    safe(CH.configSetAgentMode, (payload) => {
      if (typeof payload !== 'string' || !VALID_AGENT_MODES.includes(payload as AgentMode)) {
        return err('bad_request', `Unknown agent mode: ${String(payload)}`);
      }
      return ok(config.setAgentMode(payload as AgentMode));
    })
  );

  ipcMain.handle(
    CH.discoverSearch,
    safe(CH.discoverSearch, async (payload) => {
      const p = (payload ?? {}) as Partial<SearchPlacesRequest>;
      const city = typeof p.city === 'string' ? p.city.trim() : '';
      const category = typeof p.category === 'string' ? p.category.trim() : '';

      if (!city) return err('bad_request', 'Enter a city.');
      if (!category) return err('bad_request', 'Enter a business category.');

      const apiKey = config.getKey('googlePlaces');
      if (!apiKey) {
        return err('config', 'No Google Places API key set. Add one in Settings.', {
          detail:
            'Needs a key with "Places API (New)" enabled and billing active on the Google Cloud project.',
        });
      }

      const req: SearchPlacesRequest = {
        city,
        category,
        limit: typeof p.limit === 'number' ? p.limit : 10,
      };
      if (typeof p.pageToken === 'string' && p.pageToken !== '') {
        req.pageToken = p.pageToken;
      }

      const result = await searchPlaces(req, apiKey);

      // Remember what worked, so the next scan starts where this one did.
      if (result.ok) config.setDefaults({ city, category, limit: req.limit });

      return result;
    })
  );

  ipcMain.handle(
    CH.checksRun,
    safe(CH.checksRun, async (payload) => {
      const p = (payload ?? {}) as Partial<RunCheckRequest>;
      const candidate = p.candidate;
      if (!candidate || typeof candidate !== 'object' || typeof candidate.name !== 'string') {
        return err('bad_request', 'A candidate is required.');
      }
      const scanId =
        typeof p.scanId === 'string' && p.scanId.trim() !== ''
          ? p.scanId.trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_')
          : `scan-${Date.now()}`;

      const cfg = config.load();
      // The one place voice meets the model: every check's headline call goes
      // through this provider, so the operator's instructions apply uniformly
      // and no check can forget them.
      const agent = withBrandVoice(providerFor(cfg.agent.mode), cfg.operator.brandVoice);

      const req: RunCheckRequest = { candidate, scanId };
      if (Array.isArray(p.only) && p.only.length) req.only = p.only;

      return ok(await runChecks(req, { agent, evidenceRoot: config.evidenceDir() }));
    })
  );

  ipcMain.handle(
    CH.agentProbe,
    safe(CH.agentProbe, async () => {
      const mode = config.load().agent.mode;
      const provider = providerFor(mode);
      const probe = await provider.probe();
      return ok({
        id: provider.id,
        label: provider.label,
        available: probe.available,
        detail: probe.detail,
      });
    })
  );

  ipcMain.handle(
    CH.policyCheck,
    safe(CH.policyCheck, (payload) => {
      const c = payload as { name?: unknown; website?: unknown } | null;
      if (!c || typeof c.name !== 'string') return err('bad_request', 'A candidate is required.');

      const root = config.dataRoot();

      // A blocklist that cannot be read blocks everything. Letting a parse
      // error read as "nothing is blocked" would disarm the one permanent
      // rule in the app with no error to show for it.
      let list;
      try {
        list = loadBlocklist(root);
      } catch (e) {
        return ok({
          blocked: true,
          blockReason: `${(e as Error).message}. Fix or delete blocklist.json before selecting anyone.`,
        } satisfies PolicyVerdict);
      }

      const hit = blockedBy(list, {
        name: c.name,
        website: typeof c.website === 'string' ? c.website : null,
      });
      const pacing = pacingWarning(readPacketStarts(root));

      const verdict: PolicyVerdict = { blocked: hit !== null };
      if (hit) verdict.blockReason = `${hit.pattern}: ${hit.reason}`;
      if (pacing.warn) verdict.pacingWarning = pacing.message;
      return ok(verdict);
    })
  );

  /**
   * The only way to bar a business from inside the app.
   *
   * Without this the off-limits list was inert: `addToBlocklist` had no
   * callers and no channel, the seed array was empty, and the only way to
   * block anyone was hand-editing JSON in %APPDATA%. There is deliberately no
   * unblock channel; a list you can clear in a tired moment is not a list.
   */
  ipcMain.handle(
    CH.policyBlock,
    safe(CH.policyBlock, (payload) => {
      const p = payload as { pattern?: unknown; reason?: unknown } | null;
      if (!p || typeof p.pattern !== 'string' || p.pattern.trim() === '') {
        return err('bad_request', 'A pattern is required: a domain or a business name.');
      }
      if (typeof p.reason !== 'string' || p.reason.trim() === '') {
        return err('bad_request', 'A reason is required. The reasons are the point.');
      }
      try {
        return ok(addToBlocklist(config.dataRoot(), { pattern: p.pattern, reason: p.reason }));
      } catch (e) {
        return err('internal', (e as Error).message);
      }
    })
  );

  ipcMain.handle(
    CH.confirmRun,
    safe(CH.confirmRun, async (payload) => {
      const p = (payload ?? {}) as Partial<ConfirmRequest>;
      const candidate = p.candidate;
      if (!candidate || typeof candidate.name !== 'string') {
        return err('bad_request', 'A candidate is required.');
      }
      if (!Array.isArray(p.crawlerFindings) || p.crawlerFindings.length === 0) {
        return err('bad_request', 'Run the checks before confirming; there is nothing to reconcile against.');
      }
      const pastes = Array.isArray(p.pastes) ? p.pastes : [];
      const scanId =
        typeof p.scanId === 'string' && p.scanId.trim() !== ''
          ? p.scanId.trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_')
          : `confirm-${Date.now()}`;

      // Flag anything that looks like Chrome's escaped view-source wrapper
      // rather than the source itself, before it is scored as real markup.
      const suspectPastes = pastes
        .filter((x) => typeof x?.content === 'string' && looksLikeEscapedViewSource(x.content))
        .map((x) => x.kind);

      // Same wrapped provider as checksRun. The confirm pass regenerates the
      // headline for every model-headline check, and for those checks the
      // confirm-pass finding is the one that ships, so an unwrapped provider
      // here silently strips the operator's voice from every deliverable.
      // Found by the adversarial pass on the brand-voice commit.
      const cfgForConfirm = config.load();
      const agent = withBrandVoice(providerFor(cfgForConfirm.agent.mode), cfgForConfirm.operator.brandVoice);
      const result = await confirm(
        candidate,
        {
          candidate,
          scanId,
          findings: p.crawlerFindings,
          worstSeverity: 0,
          disqualified: false,
          durationMs: 0,
        },
        pastes.filter((x) => typeof x?.content === 'string' && x.content.trim() !== ''),
        { agent, evidenceRoot: config.evidenceDir(), scanId }
      );

      recordPacketStart(config.dataRoot(), candidate.name);

      const response: ConfirmResponse = {
        findings: result.findings,
        divergences: result.divergences,
        confirmedAt: result.confirmedAt,
        missingPastes: result.missingPastes,
        suspectPastes,
        release: releasable(result.findings, result.confirmedAt),
      };
      return ok(response);
    })
  );

  ipcMain.handle(
    CH.configSetOperator,
    safe(CH.configSetOperator, (payload) => {
      const p = (payload ?? {}) as Partial<AppConfig['operator']>;
      return ok(config.setOperator(p));
    })
  );

  ipcMain.handle(
    CH.configSetAccent,
    safe(CH.configSetAccent, (payload) => {
      // A non-string is a bad request, never a silent clear: coercing it to ''
      // would wipe the operator's accent and report success.
      if (typeof payload !== 'string') {
        return err('bad_request', 'An accent colour must be a six-digit hex code, like #2E5AAC.');
      }
      const res = config.setAccent(payload);
      if (!res.ok) return err('bad_request', res.message ?? 'That accent colour was refused.');
      return ok(config.status());
    })
  );

  /**
   * The picker runs HERE, in main. The renderer asks for a logo and never
   * names a file, so this channel cannot be driven into reading an arbitrary
   * path. The chosen bytes are verified and copied into the data root;
   * config records only which kind is on file.
   */
  ipcMain.handle(
    CH.brandChooseLogo,
    safe(CH.brandChooseLogo, async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const picked = win
        ? await dialog.showOpenDialog(win, {
            title: 'Choose a logo for your documents',
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
          })
        : await dialog.showOpenDialog({
            title: 'Choose a logo for your documents',
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
          });

      if (picked.canceled || picked.filePaths.length === 0) return ok(config.status());

      const res = config.setLogoFromFile(picked.filePaths[0] as string, (bytes) => {
        // From the buffer already read, so the decoder sees exactly the bytes
        // that will be stored, and a filename cannot carry an @2x hint that
        // halves the reported size past the dimension cap.
        const img = nativeImage.createFromBuffer(bytes);
        const size = img.getSize();
        return { width: size.width, height: size.height, empty: img.isEmpty() };
      });
      if (!res.ok) return err('bad_request', res.message ?? 'That image was refused.');
      return ok(config.status());
    })
  );

  ipcMain.handle(
    CH.brandClearLogo,
    safe(CH.brandClearLogo, () => {
      config.clearLogo();
      return ok(config.status());
    })
  );

  /**
   * Generate a packet.
   *
   * outputRoot and operator come from THIS process, never from the renderer.
   * The renderer supplying either would let a caller write artifacts anywhere
   * on disk and sign them as anyone, and neither is a decision the UI should
   * be making. What the renderer sends is the candidate and the findings it
   * just confirmed.
   *
   * Everything below refuses BEFORE any file is written: generatePacket runs
   * releasable() and the guardrail sweep over every rendered artifact first.
   * Whatever it does write is recorded in the approval queue as prepared.
   */
  ipcMain.handle(
    CH.packetGenerate,
    safe(CH.packetGenerate, async (payload) => {
      const p = (payload ?? {}) as {
        candidate?: unknown;
        findings?: unknown;
        confirmedAt?: unknown;
        contactName?: unknown;
      };
      const candidate = p.candidate as Candidate | undefined;
      if (!candidate || typeof candidate.name !== 'string' || candidate.name.trim() === '') {
        return err('bad_request', 'A candidate is required.');
      }
      if (!Array.isArray(p.findings) || p.findings.length === 0) {
        return err('bad_request', 'There are no findings to generate from.');
      }

      // An artifact reaching a prospect has to say who it is from. A footer
      // reading "undefined" is worse than a refusal, and this is the only
      // place that can tell the operator what is missing.
      // Only the fields a document may print. brandVoice stays behind: it is
      // the operator's internal style instruction, and handing the whole
      // object to the renderers would let any future renderer that dumps
      // operator fields put it on a client PDF.
      const op = config.load().operator;
      const operator = { name: op.name, email: op.email, scannerUrl: op.scannerUrl, askMode: op.askMode, ask: op.ask };
      // Derived here, from validated config, so nothing operator-typed
      // reaches a renderer's CSS or an <img> without passing the checks.
      const brand = brandContext(config.load().brand, config.brandDir());
      const missing = (['name', 'email'] as const).filter((k) => operator[k].trim() === '');
      if (missing.length) {
        return err(
          'bad_request',
          `Set your ${missing.join(' and ')} in Settings first. Every artifact prints who it is from.`
        );
      }

      try {
        const result = await generatePacket(
          {
            candidate,
            findings: p.findings as FlawFinding[],
            confirmedAt: typeof p.confirmedAt === 'string' ? p.confirmedAt : null,
            outputRoot: config.packetsDir(),
            contactName: typeof p.contactName === 'string' ? p.contactName : null,
            operator,
            brand,
          },
          PACKET_RENDERERS,
          { htmlToPdf: (html) => htmlToPdf(html, { fontsDir: fontsDir() }) }
        );
        return ok(result);
      } catch (e) {
        // NotReleasableError and GuardrailError are both the app refusing on
        // purpose, and the operator can act on either, so they are
        // bad_request with the reason intact rather than an opaque internal.
        const name = (e as Error).name;
        if (name === 'NotReleasableError' || name === 'GuardrailError') {
          return err('bad_request', (e as Error).message);
        }
        return err('internal', (e as Error).message);
      }
    })
  );

  /**
   * The approval queue. Read-only, and it does NOT swallow a bad ledger.
   *
   * loadQueue throws on an unreadable or malformed approvals.json on purpose,
   * for the same reason the blocklist does: a ledger that reads as empty
   * silently re-offers a rejected item and loses the reason it was rejected
   * for. Surfacing the error makes the operator fix it; defaulting to [] would
   * make the gate stop existing with no error to show for it.
   */
  ipcMain.handle(
    CH.approvalQueue,
    safe(CH.approvalQueue, () => {
      try {
        return ok(queueView(config.packetsDir()));
      } catch (e) {
        return err('internal', (e as Error).message);
      }
    })
  );

  /**
   * Approve one artifact.
   *
   * The findings and confirmation timestamp come from the renderer, and the
   * gate does not take them on trust: `approve` re-runs the same
   * `releasable()` that generation ran, so an expired confirmation or an
   * unconfirmed finding is refused here even though it passed at generation
   * time. That is the point of checking twice; a packet generated on Tuesday
   * must not be approvable on Friday.
   *
   * The minted token stays in this process. Only a serializable summary of it
   * goes back, and it is not, and cannot be, an ApprovedItem.
   */
  ipcMain.handle(
    CH.approvalApprove,
    safe(CH.approvalApprove, (payload) => {
      const p = (payload ?? {}) as {
        itemId?: unknown;
        findings?: unknown;
        confirmedAt?: unknown;
      };
      if (typeof p.itemId !== 'string' || p.itemId.trim() === '') {
        return err('bad_request', 'An itemId is required.');
      }
      if (!Array.isArray(p.findings)) {
        return err('bad_request', 'The confirmed findings are required; approval re-checks them.');
      }
      const confirmedAt = typeof p.confirmedAt === 'string' ? p.confirmedAt : null;

      try {
        const { item, queue } = approve(
          config.packetsDir(),
          p.itemId.trim(),
          p.findings as FlawFinding[],
          confirmedAt
        );
        return ok({
          item: {
            itemId: item.itemId,
            kind: item.kind,
            slug: item.slug,
            filename: item.filename,
            approvedAt: item.approvedAt,
          },
          queue,
        });
      } catch (e) {
        if (e instanceof ApprovalRefused) return err('bad_request', e.reason);
        return err('internal', (e as Error).message);
      }
    })
  );

  /** Rejection requires a reason, and the reason is the point. */
  ipcMain.handle(
    CH.approvalReject,
    safe(CH.approvalReject, (payload) => {
      const p = (payload ?? {}) as { itemId?: unknown; reason?: unknown };
      if (typeof p.itemId !== 'string' || p.itemId.trim() === '') {
        return err('bad_request', 'An itemId is required.');
      }
      if (typeof p.reason !== 'string' || p.reason.trim() === '') {
        return err('bad_request', 'A rejection needs a reason, and the reason is the point.');
      }
      try {
        return ok(reject(config.packetsDir(), p.itemId.trim(), p.reason));
      } catch (e) {
        if (e instanceof ApprovalRefused) return err('bad_request', e.reason);
        return err('internal', (e as Error).message);
      }
    })
  );

  /** Reopen a rejection. Costs a reason, same as the rejection did. */
  ipcMain.handle(
    CH.approvalReopen,
    safe(CH.approvalReopen, (payload) => {
      const p = (payload ?? {}) as { itemId?: unknown; reason?: unknown };
      if (typeof p.itemId !== 'string' || p.itemId.trim() === '') {
        return err('bad_request', 'An itemId is required.');
      }
      if (typeof p.reason !== 'string' || p.reason.trim() === '') {
        return err('bad_request', 'Reopening a rejection needs a reason, the same as the rejection did.');
      }
      try {
        return ok(reopen(config.packetsDir(), p.itemId.trim(), p.reason));
      } catch (e) {
        if (e instanceof ApprovalRefused) return err('bad_request', e.reason);
        return err('internal', (e as Error).message);
      }
    })
  );

  ipcMain.handle(
    CH.appInfo,
    safe(CH.appInfo, (): Result<AppInfo> =>
      ok({
        appVersion: app.getVersion(),
        electron: process.versions.electron ?? 'unknown',
        node: process.versions.node ?? 'unknown',
        chrome: process.versions.chrome ?? 'unknown',
        // The data root, not Electron's userData: this is the path the
        // settings screen shows under "User data", and the answer to "where
        // are my files" is the folder holding them, not Chromium's profile.
        userDataPath: config.dataRoot(),
        evidencePath: config.evidenceDir(),
      })
    )
  );

  ipcMain.handle(
    CH.openExternal,
    safe(CH.openExternal, async (payload) => {
      if (typeof payload !== 'string') {
        return err('bad_request', 'URL must be a string.');
      }
      let parsed: URL;
      try {
        parsed = new URL(payload);
      } catch {
        return err('bad_request', `Not a URL: ${payload}`);
      }
      // Only ever hand http(s) to the OS. file:, and anything custom-scheme,
      // is a local-code-execution vector via the shell handler.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return err('bad_request', `Refusing to open a ${parsed.protocol} URL.`);
      }
      await shell.openExternal(parsed.toString());
      return ok(true);
    })
  );
}

/**
 * The entire renderer -> main surface. If it is not on this object, the
 * renderer cannot do it.
 *
 * Note what is deliberately absent: no filesystem, no shell, no arbitrary
 * fetch, and nothing that sends, posts, or prints. Outbound actions arrive in
 * Phase 7 and will go through the approval gate, not through here directly.
 *
 * WHY THE CHANNEL NAMES ARE REPEATED HERE. This preload runs with
 * `sandbox: true`, and a sandboxed preload cannot `require()` a relative
 * module, it gets a restricted loader that resolves 'electron' and little
 * else. Importing '../shared/channels' at runtime fails with
 * "module not found" and silently kills the whole bridge.
 *
 * So the strings are local, and `import type` (erased at compile time, zero
 * runtime cost) plus the CHANNELS_MATCH assertion below makes the compiler
 * fail if these ever drift from shared/channels.ts. Duplication that cannot
 * rot is cheaper here than adding a bundler to the build.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { ChannelName } from '../shared/channels';

const CH = {
  configGet: 'config:get',
  configSetKey: 'config:setKey',
  configSetDefaults: 'config:setDefaults',
  configSetOperator: 'config:setOperator',
  configSetAccent: 'config:setAccent',
  brandChooseLogo: 'brand:chooseLogo',
  brandClearLogo: 'brand:clearLogo',
  packetGenerate: 'packet:generate',
  configSetAgentMode: 'config:setAgentMode',
  discoverSearch: 'discover:search',
  discoverFromUrl: 'discover:fromUrl',
  checksRun: 'checks:run',
  agentProbe: 'agent:probe',
  confirmRun: 'confirm:run',
  policyCheck: 'policy:check',
  policyBlock: 'policy:block',
  approvalQueue: 'approval:queue',
  approvalApprove: 'approval:approve',
  approvalReject: 'approval:reject',
  approvalReopen: 'approval:reopen',
  appInfo: 'app:info',
  openExternal: 'app:openExternal',
  menuNavigate: 'menu:navigate',
} as const;

/**
 * Compile-time drift guard. If shared/channels.ts gains a channel or renames
 * one, ChannelName stops being assignable to the local union and this line
 * fails the build. Type-only, so nothing survives into the sandbox.
 */
type LocalChannel = (typeof CH)[keyof typeof CH];
type CHANNELS_MATCH = ChannelName extends LocalChannel
  ? LocalChannel extends ChannelName
    ? true
    : never
  : never;
const _channelsMatch: CHANNELS_MATCH = true;
void _channelsMatch;

const api = {
  config: {
    get: () => ipcRenderer.invoke(CH.configGet),
    setKey: (key: string, value: string) => ipcRenderer.invoke(CH.configSetKey, { key, value }),
    setDefaults: (defaults: Record<string, unknown>) =>
      ipcRenderer.invoke(CH.configSetDefaults, defaults),
    setAgentMode: (mode: string) => ipcRenderer.invoke(CH.configSetAgentMode, mode),
    setOperator: (operator: Record<string, unknown>) =>
      ipcRenderer.invoke(CH.configSetOperator, operator),
    setAccent: (accent: string) => ipcRenderer.invoke(CH.configSetAccent, accent),
    /**
     * No path argument by design. The picker opens in main and the renderer
     * never names a file, so this cannot be turned into a read-any-file
     * primitive by a renderer that stops behaving.
     */
    chooseLogo: () => ipcRenderer.invoke(CH.brandChooseLogo),
    clearLogo: () => ipcRenderer.invoke(CH.brandClearLogo),
  },
  /**
   * Generation. Note what is NOT here: no outputRoot and no operator. Both
   * come from the main process, because a renderer that could choose where
   * artifacts land, or who they claim to be from, is a renderer that can write
   * anywhere and sign as anyone.
   */
  packet: {
    generate: (req: Record<string, unknown>) => ipcRenderer.invoke(CH.packetGenerate, req),
  },
  discover: {
    search: (req: Record<string, unknown>) => ipcRenderer.invoke(CH.discoverSearch, req),
    fromUrl: (req: Record<string, unknown>) => ipcRenderer.invoke(CH.discoverFromUrl, req),
  },
  checks: {
    run: (req: Record<string, unknown>) => ipcRenderer.invoke(CH.checksRun, req),
  },
  agent: {
    probe: () => ipcRenderer.invoke(CH.agentProbe),
  },
  confirm: {
    run: (req: Record<string, unknown>) => ipcRenderer.invoke(CH.confirmRun, req),
  },
  policy: {
    check: (candidate: Record<string, unknown>) => ipcRenderer.invoke(CH.policyCheck, candidate),
    block: (entry: { pattern: string; reason: string }) => ipcRenderer.invoke(CH.policyBlock, entry),
  },
  /**
   * Law 3. Three verbs, no fourth: there is no unapprove, because reversing
   * an approval must leave a record, and no send, because nothing
   * outbound exists yet and adding it here would be the wrong door for it.
   */
  approval: {
    queue: () => ipcRenderer.invoke(CH.approvalQueue),
    approve: (req: { itemId: string; findings: unknown[]; confirmedAt: string | null }) =>
      ipcRenderer.invoke(CH.approvalApprove, req),
    reject: (req: { itemId: string; reason: string }) =>
      ipcRenderer.invoke(CH.approvalReject, req),
    /** Rejected -> prepared. There is still no unapprove. */
    reopen: (req: { itemId: string; reason: string }) =>
      ipcRenderer.invoke(CH.approvalReopen, req),
  },
  app: {
    info: () => ipcRenderer.invoke(CH.appInfo),
    openExternal: (url: string) => ipcRenderer.invoke(CH.openExternal, url),
  },
  /**
   * Subscribe to view-switch requests from the native menu. The callback
   * receives only the view name, never the IPC event, so the renderer cannot
   * reach back through it into anything the bridge does not already expose.
   */
  menu: {
    onNavigate: (cb: (view: string) => void) => {
      ipcRenderer.on(CH.menuNavigate, (_event, view: string) => cb(view));
    },
  },
} as const;

contextBridge.exposeInMainWorld('assay', api);

export type AssayApi = typeof api;

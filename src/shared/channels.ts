/**
 * IPC channel names. One place, so preload / handlers / renderer cannot drift.
 * Every channel is invoke/handle (request-response). No renderer-initiated
 * fire-and-forget, and nothing that sends anything outward exists yet by design.
 */

export const CH = {
  /** Returns ConfigStatus, presence flags and hints, never the secrets. */
  configGet: 'config:get',
  /** SetKeyRequest -> ConfigStatus */
  configSetKey: 'config:setKey',
  /** Partial<AppConfig['defaults']> -> ConfigStatus */
  configSetDefaults: 'config:setDefaults',
  /** Partial<AppConfig['operator']> -> ConfigStatus. Who artifacts are from. */
  configSetOperator: 'config:setOperator',
  configSetAccent: 'config:setAccent',
  /** Opens the picker IN MAIN, so no path ever crosses the bridge. */
  brandChooseLogo: 'brand:chooseLogo',
  brandClearLogo: 'brand:clearLogo',
  /** AgentMode -> ConfigStatus */
  configSetAgentMode: 'config:setAgentMode',

  /** SearchPlacesRequest -> SearchPlacesResponse */
  discoverSearch: 'discover:search',

  /**
   * RunCheckRequest -> FlawFinding. Runs the flaw checks for one candidate.
   * Findings come back 'remote' and cannot be turned into artifacts until the
   * operator confirms them with their own view-source (Phase 4).
   */
  checksRun: 'checks:run',

  /** Returns { id, label, available, detail } for the resolved agent provider. */
  agentProbe: 'agent:probe',

  /**
   * ConfirmRequest -> ConfirmationResult. Re-runs the six checks against the
   * operator's pasted view-source and returns confirmed/diverged/remote per
   * finding. Nothing may be generated or sent from an unconfirmed finding.
   */
  confirmRun: 'confirm:run',

  /**
   * Candidate -> PolicyVerdict. The off-limits list and the pacing rule, both
   * checked before a candidate can be worked, so neither depends on memory.
   */
  policyCheck: 'policy:check',
  policyBlock: 'policy:block',

  /**
   * GenerateRequest minus outputRoot and operator, which main supplies ->
   * { slug, date, draftsDir, artifacts, queue }.
   *
   * Refuses before writing anything if the findings are not operator-confirmed,
   * if the confirmation has expired, or if any artifact's copy trips the
   * guardrail sweep. Everything it writes lands in the approval queue as
   * PREPARED, never approved.
   */
  packetGenerate: 'packet:generate',

  /**
   * Law 3's surface. Nothing auto-sends, auto-posts or auto-prints, and
   * approval is per item, so these are the only three verbs.
   *
   * No ApprovedItem token ever crosses this boundary. The token's authority is
   * a WeakSet private to the main process, so a serialized copy would be a
   * plain object that `assertMinted` refuses, and handing one to the renderer
   * would suggest a power it does not have. The renderer moves rows; a sender
   * calls `tokenFor` in main when it needs the real thing.
   */
  /** Returns QueueItem[], every prepared, approved and rejected row. */
  approvalQueue: 'approval:queue',
  /** { itemId, findings, confirmedAt } -> { item, queue }. Re-runs releasable(). */
  approvalApprove: 'approval:approve',
  /** { itemId, reason } -> { item, queue }. An empty reason is refused. */
  approvalReject: 'approval:reject',
  /**
   * { itemId, reason } -> { queue }. Returns a REJECTED item to prepared.
   *
   * Not an unapprove, and the distinction is why it is allowed to exist:
   * this puts nothing in front of a prospect, it returns the item to the
   * state where it still has to be approved before it can go anywhere.
   */
  approvalReopen: 'approval:reopen',

  /** Returns { version, electron, node, chrome, userDataPath } */
  appInfo: 'app:info',

  /** Opens a URL in the user's real browser. Never navigates the app window. */
  openExternal: 'app:openExternal',

  /**
   * MAIN -> RENDERER, the one direction that is not invoke/handle.
   *
   * The native application menu lives in the main process, so a Help item there
   * asks the renderer to switch to a view by name. It carries a view string and
   * nothing else, and there is no reply. This is not a power the renderer gains
   * over main; it is main telling its own window which tab to show.
   */
  menuNavigate: 'menu:navigate',
} as const;

export type ChannelName = (typeof CH)[keyof typeof CH];

export type AppInfo = {
  appVersion: string;
  electron: string;
  node: string;
  chrome: string;
  userDataPath: string;
  evidencePath: string;
};

/**
 * The agent boundary.
 *
 * Everything the checks know about Claude is this interface. Swapping the CLI
 * for the Agent SDK, or for subscription auth once Anthropic un-pauses it, is
 * a matter of adding a file and changing config.agent.mode, no check changes.
 *
 * Note what an AgentProvider CANNOT do: fetch, search, browse, or read the
 * filesystem. It takes text and returns text. Page content reaches it only
 * because evidence/fetch-raw.ts already captured, hashed and stored the bytes.
 * That is Law 1 expressed as a type signature.
 */

export type AgentProviderId = 'cli' | 'sdk-apikey' | 'sdk-subscription';

export type AgentRunRequest = {
  /** Replaces the default system prompt entirely. Keep it short; it is billed per call. */
  systemPrompt: string;
  /** Delivered on stdin, so size is not bounded by the OS argv limit. */
  prompt: string;
  /**
   * Mechanical work should stay on a cheap model. The operator's standing
   * rule: Haiku/Sonnet-class for mechanical or dispatch work, Opus reserved
   * for planning and hard debugging.
   */
  model?: 'haiku' | 'sonnet' | 'opus';
  timeoutMs?: number;
};

export type AgentErrorKind = 'auth' | 'rate_limit' | 'transport' | 'not_available' | 'unknown';

export type AgentRunResult = {
  ok: boolean;
  /** The model's reply text. Empty when ok is false. */
  text: string;
  sessionId?: string;
  costUsd?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  error?: { kind: AgentErrorKind; message: string; status?: number };
  /** Wall-clock, for spotting a provider whose latency creeps up before anything errors. */
  durationMs: number;
};

export type ProviderProbe = {
  available: boolean;
  /** Human-readable, shown in Settings. Says what to do when unavailable. */
  detail: string;
};

export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly label: string;
  probe(): Promise<ProviderProbe>;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}

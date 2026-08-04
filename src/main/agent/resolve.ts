/**
 * Picks the agent provider from config, rather than hardcoding one.
 *
 * 'auto' resolves to the CLI so the work draws on the Pro/Max plan's usage
 * pool instead of metered API spend. There is no API-key fallback: that path
 * is not built, which is why Settings refuses to store an Anthropic key. The
 * subscription-auth path for the Agent SDK itself is deliberately not part of
 * 'auto': Anthropic had it marked PAUSED as of 2026-07-28. When it goes live,
 * implement sdk-subscription.ts and set config.agent.mode explicitly.
 */

import { AgentMode } from '../../shared/types';
import { getKey } from '../config/store';
import { ClaudeCliProvider } from './cli';
import { AgentProvider, ProviderProbe } from './provider';

/** Placeholder until the Agent SDK path is built. Fails loudly rather than silently. */
class UnbuiltProvider implements AgentProvider {
  constructor(
    readonly id: 'sdk-apikey' | 'sdk-subscription',
    readonly label: string,
    private readonly why: string
  ) {}

  async probe(): Promise<ProviderProbe> {
    return { available: false, detail: this.why };
  }

  async run() {
    return {
      ok: false,
      text: '',
      durationMs: 0,
      error: { kind: 'not_available' as const, message: this.why },
    };
  }
}

const SDK_APIKEY_NOTE =
  'The Agent SDK path is not built yet. The claude CLI is the primary path; set agent mode to Auto or CLI.';

const SDK_SUBSCRIPTION_NOTE =
  'Subscription auth for the Agent SDK was marked paused by Anthropic as of 7/28/26, so this path is deliberately unbuilt. Use Auto, which runs the claude CLI on your Pro/Max plan.';

export function providerFor(mode: AgentMode): AgentProvider {
  switch (mode) {
    case 'cli':
      return new ClaudeCliProvider();
    case 'sdk-apikey':
      return new UnbuiltProvider('sdk-apikey', 'Agent SDK + API key', SDK_APIKEY_NOTE);
    case 'sdk-subscription':
      return new UnbuiltProvider('sdk-subscription', 'Agent SDK + subscription', SDK_SUBSCRIPTION_NOTE);
    case 'auto':
    default:
      // Only one path is built, so 'auto' resolves to it. When the SDK path
      // exists this becomes a real probe-then-fall-back.
      return new ClaudeCliProvider();
  }
}

/** Whether an API key fallback would even be possible, for the Settings copy. */
export function apiKeyAvailable(): boolean {
  return getKey('anthropic') !== null;
}

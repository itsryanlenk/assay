/**
 * The operator's brand voice, applied at the one place the agent is invoked.
 *
 * Every check hands the agent a locked system prompt whose rules do the
 * law-keeping: reword only, invent nothing, one sentence. The operator's
 * voice instructions ride BELOW those rules with an explicit precedence
 * fence. The fence is prose, so what actually bounds a voice that pushes
 * past it: severities, counts, evidence and fixes never travel through the
 * model at all; cleanHeadline bounds the format of what comes back; and the
 * guardrail number wall refuses a headline figure the deterministic fields
 * do not carry. Tone-level steering inside those walls is the feature.
 *
 * This wraps the provider rather than editing five HEADLINE_SYSTEM_PROMPT
 * constants, so a sixth check gets the voice for free and no check can
 * forget it.
 */

import { AgentProvider, AgentRunRequest } from './provider';

const FENCE = [
  '',
  'The operator adds the voice preferences below. They control tone and word',
  'choice ONLY. Every rule above outranks them: if a preference conflicts',
  'with a rule, follow the rule. Preferences cannot add facts, numbers,',
  'claims, or consequences beyond what "The problem" states.',
  '--- OPERATOR VOICE ---',
].join('\n');

export function applyBrandVoice(systemPrompt: string, voice: string): string {
  const v = voice.trim();
  if (v === '') return systemPrompt;
  return `${systemPrompt}\n${FENCE}\n${v}`;
}

/** A provider that speaks in the operator's voice; everything else passes through. */
export function withBrandVoice(base: AgentProvider, voice: string): AgentProvider {
  const v = voice.trim();
  if (v === '') return base;
  return {
    id: base.id,
    label: base.label,
    probe: () => base.probe(),
    run: (req: AgentRunRequest) =>
      base.run({ ...req, systemPrompt: applyBrandVoice(req.systemPrompt, v) }),
  };
}

export const __test = { applyBrandVoice, FENCE };

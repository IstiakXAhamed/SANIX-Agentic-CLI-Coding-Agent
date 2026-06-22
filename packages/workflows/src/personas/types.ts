/**
 * @file personas/types.ts
 * @description Agent persona / template definitions. A persona bundles a
 * system prompt, a tool whitelist, and provider/model defaults so an
 * agent loop can be spun up in a known role with one call.
 *
 * Personas are intentionally framework-light: they don't depend on
 * `@sanix/core`'s `AgentLoop` directly, so they can be consumed by
 * any caller that knows how to interpret the fields.
 *
 * @packageDocumentation
 */

/**
 * A pre-baked agent persona. The {@link systemPrompt} is the canonical
 * "who you are" instruction; the remaining fields are advisory defaults
 * that an `AgentLoopFactory` may honor when constructing the agent.
 *
 * @example
 * ```ts
 * import { getPersona } from '@sanix/workflows';
 *
 * const coder = getPersona('coder');
 * if (coder) {
 *   console.log(coder.name);
 *   console.log('Tools:', coder.tools?.join(', '));
 * }
 * ```
 */
export interface AgentPersona {
  /** Stable unique persona id (e.g. `'coder'`, `'researcher'`). */
  id: string;
  /** Display name (e.g. `'SANIX Coder'`). */
  name: string;
  /** Short human-readable description of when to use this persona. */
  description: string;
  /** The full system prompt — sets the agent's role, tone, and constraints. */
  systemPrompt: string;
  /** Whitelist of tool names this persona is allowed to use. */
  tools?: string[];
  /** Preferred provider id (e.g. `'anthropic'`, `'openai'`). */
  provider?: string;
  /** Sampling temperature override (0 = deterministic, 1 = creative). */
  temperature?: number;
  /** Max output tokens per response. */
  maxTokens?: number;
  /** Short tag list characterizing the persona (e.g. `'thorough'`, `'cites sources'`). */
  traits: string[];
  /** Example queries this persona shines on — surfaced in CLI help. */
  exampleQueries: string[];
}

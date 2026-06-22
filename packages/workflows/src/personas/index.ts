/**
 * @file personas/index.ts
 * @description Barrel re-export for `@sanix/workflows/personas`.
 * Aggregates all built-in personas into a `PERSONAS` map and exposes
 * `getPersona(id)` and `listPersonas()` helpers.
 *
 * @packageDocumentation
 */

import type { AgentPersona } from './types.js';
import { RESEARCHER_PERSONA } from './researcher.js';
import { CODER_PERSONA } from './coder.js';
import { REVIEWER_PERSONA } from './reviewer.js';
import { ARCHITECT_PERSONA } from './architect.js';
import { DEBUGGER_PERSONA } from './debugger.js';
import { EXPLAINER_PERSONA } from './explainer.js';
import { PLANNER_PERSONA } from './planner.js';
import { WRITER_PERSONA } from './writer.js';

export type { AgentPersona } from './types.js';
export { RESEARCHER_PERSONA } from './researcher.js';
export { CODER_PERSONA } from './coder.js';
export { REVIEWER_PERSONA } from './reviewer.js';
export { ARCHITECT_PERSONA } from './architect.js';
export { DEBUGGER_PERSONA } from './debugger.js';
export { EXPLAINER_PERSONA } from './explainer.js';
export { PLANNER_PERSONA } from './planner.js';
export { WRITER_PERSONA } from './writer.js';

/**
 * The full persona registry, keyed by `id`. Use {@link getPersona} for
 * safe lookup with a `null` return on miss.
 */
export const PERSONAS: Record<string, AgentPersona> = {
  researcher: RESEARCHER_PERSONA,
  coder: CODER_PERSONA,
  reviewer: REVIEWER_PERSONA,
  architect: ARCHITECT_PERSONA,
  debugger: DEBUGGER_PERSONA,
  explainer: EXPLAINER_PERSONA,
  planner: PLANNER_PERSONA,
  writer: WRITER_PERSONA,
};

/**
 * Look up a persona by id.
 *
 * @param id - Persona id (e.g. `'coder'`).
 * @returns The persona, or `null` if no persona has that id.
 *
 * @example
 * ```ts
 * import { getPersona } from '@sanix/workflows';
 * const coder = getPersona('coder');
 * if (coder) console.log(coder.systemPrompt);
 * ```
 */
export function getPersona(id: string): AgentPersona | null {
  return PERSONAS[id] ?? null;
}

/**
 * List the ids of all registered personas.
 *
 * @example
 * ```ts
 * import { listPersonas } from '@sanix/workflows';
 * console.log(listPersonas()); // ['researcher', 'coder', ...]
 * ```
 */
export function listPersonas(): string[] {
  return Object.keys(PERSONAS);
}

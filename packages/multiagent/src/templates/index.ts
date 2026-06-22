/**
 * @file templates/index.ts
 * @description Barrel re-export for all built-in team templates plus
 * the {@link TEAM_TEMPLATES} registry and {@link getTeamTemplate} lookup.
 *
 * @packageDocumentation
 */

import type { TeamConfig } from '../types.js';
import { CODE_REVIEW_TEAM } from './code-review-team.js';
import { RESEARCH_TEAM } from './research-team.js';
import { BUG_FIX_TEAM } from './bug-fix-team.js';
import { BRAINSTORM_TEAM } from './brainstorm-team.js';
import { MOE_TEAM, MOE_TEAM_SPECIALTIES } from './moe-team.js';
import { SWARM_TEAM } from './swarm-team.js';

export { CODE_REVIEW_TEAM } from './code-review-team.js';
export { RESEARCH_TEAM } from './research-team.js';
export { BUG_FIX_TEAM } from './bug-fix-team.js';
export { BRAINSTORM_TEAM } from './brainstorm-team.js';
export { MOE_TEAM, MOE_TEAM_SPECIALTIES } from './moe-team.js';
export { SWARM_TEAM } from './swarm-team.js';

/**
 * The full team template registry. Each entry is a complete
 * {@link TeamConfig} ready to be passed to {@link AgentTeam}.
 */
export const TEAM_TEMPLATES: TeamConfig[] = [
  CODE_REVIEW_TEAM,
  RESEARCH_TEAM,
  BUG_FIX_TEAM,
  BRAINSTORM_TEAM,
  MOE_TEAM,
  SWARM_TEAM,
];

/**
 * Lookup table: template name → config.
 */
const TEMPLATE_BY_NAME: Record<string, TeamConfig> = {
  'code-review-team': CODE_REVIEW_TEAM,
  'research-team': RESEARCH_TEAM,
  'bug-fix-team': BUG_FIX_TEAM,
  'brainstorm-team': BRAINSTORM_TEAM,
  'moe-team': MOE_TEAM,
  'swarm-team': SWARM_TEAM,
};

/**
 * Look up a team template by name.
 *
 * @param name - The template name (e.g. `'code-review-team'`).
 * @returns The matching {@link TeamConfig}, or `null` if no template has that name.
 *
 * @example
 * ```ts
 * import { getTeamTemplate } from '@sanix/multiagent/templates';
 * const config = getTeamTemplate('code-review-team');
 * if (config) {
 *   const team = new AgentTeam(config, { agentFactory });
 *   await team.solve('Review this PR.');
 * }
 * ```
 */
export function getTeamTemplate(name: string): TeamConfig | null {
  return TEMPLATE_BY_NAME[name] ?? null;
}

/**
 * List the names of all available team templates.
 *
 * @example
 * ```ts
 * import { listTeamTemplates } from '@sanix/multiagent/templates';
 * console.log(listTeamTemplates()); // ['code-review-team', 'research-team', ...]
 * ```
 */
export function listTeamTemplates(): string[] {
  return Object.keys(TEMPLATE_BY_NAME);
}

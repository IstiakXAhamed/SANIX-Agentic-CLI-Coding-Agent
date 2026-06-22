/**
 * @file templates/brainstorm-team.ts
 * @description 5-member brainstorm team: 5 different personas (coder,
 * architect, researcher, writer, reviewer) propose solutions, then
 * vote on the best. Strategy: voting. Consensus: weighted.
 *
 * @packageDocumentation
 */

import type { TeamConfig } from '../types.js';

/**
 * The brainstorm team: 5 diverse personas propose, then vote.
 *
 * @example
 * ```ts
 * import { getTeamTemplate } from '@sanix/multiagent/templates';
 * const config = getTeamTemplate('brainstorm-team')!;
 * ```
 */
export const BRAINSTORM_TEAM: TeamConfig = {
  name: 'Brainstorm Team',
  description:
    'Diverse-persona brainstorm with voting. Use for: feature ideation, ' +
    'product decisions, naming, alternative exploration, design choices.',
  strategy: 'voting',
  consensus: 'weighted',
  rounds: 1,
  maxConcurrent: 5,
  timeoutMs: 120_000,
  onConflict: 'best_effort',
  members: [
    {
      id: 'coder',
      persona: 'coder',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'architect',
      persona: 'architect',
      role: 'synthesizer',
      weight: 1.3,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'researcher',
      persona: 'researcher',
      role: 'researcher',
      weight: 1.1,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'writer',
      persona: 'writer',
      role: 'worker',
      weight: 0.9,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'reviewer',
      persona: 'reviewer',
      role: 'critic',
      weight: 1.2,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
  ],
};

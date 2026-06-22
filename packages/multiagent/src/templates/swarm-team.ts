/**
 * @file templates/swarm-team.ts
 * @description 8-particle swarm optimization team. Each particle is a
 * different persona (with some duplication to broaden the search).
 * Strategy: swarm, 5 iterations.
 *
 * @packageDocumentation
 */

import type { TeamConfig } from '../types.js';

/**
 * The swarm team: 8 particles, 5 iterations.
 *
 * @example
 * ```ts
 * import { getTeamTemplate } from '@sanix/multiagent/templates';
 * const config = getTeamTemplate('swarm-team')!;
 * ```
 */
export const SWARM_TEAM: TeamConfig = {
  name: 'Swarm Optimization Team',
  description:
    'Particle swarm optimization across 8 agents. Use for: optimization ' +
    'problems, design space exploration, parameter tuning, ' +
    'multi-modal search, best-of-many selection.',
  strategy: 'swarm',
  consensus: 'best_of_n',
  rounds: 5,
  maxConcurrent: 4,
  timeoutMs: 300_000,
  onConflict: 'best_effort',
  members: [
    {
      id: 'particle-1',
      persona: 'architect',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'particle-2',
      persona: 'coder',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'particle-3',
      persona: 'researcher',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'particle-4',
      persona: 'reviewer',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'particle-5',
      persona: 'architect',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'particle-6',
      persona: 'writer',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'particle-7',
      persona: 'debugger',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'particle-8',
      persona: 'planner',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
  ],
};

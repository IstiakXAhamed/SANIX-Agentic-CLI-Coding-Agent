/**
 * @file templates/code-review-team.ts
 * @description 3-member code-review team: coder (proposes), reviewer
 * (critiques), architect (system-level view) + judge. Strategy: debate,
 * 2 rounds. Consensus: judge_decided.
 *
 * @packageDocumentation
 */

import type { TeamConfig } from '../types.js';

/**
 * The code-review team: 3 debaters + 1 judge, 2 debate rounds.
 *
 * @example
 * ```ts
 * import { getTeamTemplate } from '@sanix/multiagent/templates';
 * const config = getTeamTemplate('code-review-team')!;
 * ```
 */
export const CODE_REVIEW_TEAM: TeamConfig = {
  name: 'Code Review Team',
  description:
    'Reviews code changes for correctness, style, and architecture. ' +
    'Use for: PR review, code audit, refactoring proposals, design feedback.',
  strategy: 'debate',
  consensus: 'judge_decided',
  rounds: 2,
  maxConcurrent: 4,
  timeoutMs: 120_000,
  onConflict: 'best_effort',
  judgeMemberId: 'judge',
  members: [
    {
      id: 'coder',
      persona: 'coder',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'reviewer',
      persona: 'reviewer',
      role: 'critic',
      weight: 1.2,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'architect',
      persona: 'architect',
      role: 'critic',
      weight: 1.1,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
    {
      id: 'judge',
      persona: 'architect',
      role: 'judge',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
  ],
};

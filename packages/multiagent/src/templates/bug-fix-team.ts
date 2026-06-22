/**
 * @file templates/bug-fix-team.ts
 * @description 3-member bug-fix team: debugger (reproduce + diagnose) →
 * coder (apply fix) → tester (verify). Strategy: sequential.
 *
 * @packageDocumentation
 */

import type { TeamConfig } from '../types.js';

/**
 * The bug-fix team: debugger → coder → tester, relay-style.
 *
 * @example
 * ```ts
 * import { getTeamTemplate } from '@sanix/multiagent/templates';
 * const config = getTeamTemplate('bug-fix-team')!;
 * ```
 */
export const BUG_FIX_TEAM: TeamConfig = {
  name: 'Bug Fix Team',
  description:
    'Reproduces, diagnoses, fixes, and verifies bugs. Use for: ' +
    'debugging, regression fixes, error reproduction, test-driven bug resolution.',
  strategy: 'sequential',
  consensus: 'best_of_n',
  rounds: 1,
  maxConcurrent: 1,
  timeoutMs: 240_000,
  onConflict: 'best_effort',
  members: [
    {
      id: 'debugger',
      persona: 'debugger',
      role: 'researcher',
      weight: 1.0,
      budget: { tokens: 8192, costUsd: 0.20 },
    },
    {
      id: 'coder',
      persona: 'coder',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 8192, costUsd: 0.20 },
    },
    {
      id: 'tester',
      persona: 'reviewer',
      role: 'critic',
      weight: 1.0,
      budget: { tokens: 4096, costUsd: 0.10 },
    },
  ],
};

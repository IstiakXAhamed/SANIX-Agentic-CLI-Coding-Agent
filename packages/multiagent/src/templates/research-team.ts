/**
 * @file templates/research-team.ts
 * @description 4-member research team: 2 researchers (different domains)
 * + synthesizer + judge. Strategy: parallel. Consensus: judge_decided.
 *
 * @packageDocumentation
 */

import type { TeamConfig } from '../types.js';

/**
 * The research team: 2 researchers + 1 synthesizer + 1 judge.
 *
 * @example
 * ```ts
 * import { getTeamTemplate } from '@sanix/multiagent/templates';
 * const config = getTeamTemplate('research-team')!;
 * ```
 */
export const RESEARCH_TEAM: TeamConfig = {
  name: 'Research Team',
  description:
    'Multi-source research with synthesis. Use for: literature review, ' +
    'technology comparison, fact-finding, source gathering, summarization.',
  strategy: 'parallel',
  consensus: 'judge_decided',
  rounds: 1,
  maxConcurrent: 4,
  timeoutMs: 180_000,
  onConflict: 'best_effort',
  judgeMemberId: 'judge',
  members: [
    {
      id: 'researcher-a',
      persona: 'researcher',
      role: 'researcher',
      weight: 1.0,
      budget: { tokens: 8192, costUsd: 0.20 },
    },
    {
      id: 'researcher-b',
      persona: 'researcher',
      role: 'researcher',
      weight: 1.0,
      budget: { tokens: 8192, costUsd: 0.20 },
    },
    {
      id: 'synthesizer',
      persona: 'writer',
      role: 'synthesizer',
      weight: 1.2,
      budget: { tokens: 8192, costUsd: 0.20 },
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

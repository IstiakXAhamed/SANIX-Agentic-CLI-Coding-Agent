/**
 * @file templates/moe-team.ts
 * @description 5-member Mixture-of-Experts team: each member has a
 * distinct domain specialty (code, reasoning, creative, research,
 * debugging). Strategy: mixture_of_experts. Consensus: best_of_n
 * (for multi-expert collaboration).
 *
 * The team's `description` enumerates the domains so the
 * {@link TeamCoordinator} can auto-route queries to it.
 *
 * @packageDocumentation
 */

import type { MoESpecialty, TeamConfig } from '../types.js';

/**
 * The MoE team's specialties — one per expert member. Domains:
 *   - coder       → code, programming, typescript
 *   - architect   → reasoning, design, architecture
 *   - writer      → creative, writing, docs
 *   - researcher  → research, search, analysis
 *   - debugger    → debugging, errors, troubleshooting
 */
export const MOE_TEAM_SPECIALTIES: MoESpecialty[] = [
  { memberId: 'coder', domains: ['code', 'programming', 'typescript', 'implementation'], weight: 1.0 },
  { memberId: 'architect', domains: ['reasoning', 'design', 'architecture', 'system'], weight: 1.2 },
  { memberId: 'writer', domains: ['creative', 'writing', 'docs', 'communication'], weight: 1.0 },
  { memberId: 'researcher', domains: ['research', 'search', 'analysis', 'sources'], weight: 1.1 },
  { memberId: 'debugger', domains: ['debugging', 'errors', 'troubleshooting', 'fixes'], weight: 1.0 },
];

/**
 * The MoE team: 5 experts with distinct domains; router picks the best.
 *
 * @example
 * ```ts
 * import { getTeamTemplate } from '@sanix/multiagent/templates';
 * const config = getTeamTemplate('moe-team')!;
 * ```
 */
export const MOE_TEAM: TeamConfig = {
  name: 'Mixture of Experts Team',
  description:
    'Routes queries to the most relevant expert. Domains: code, reasoning, ' +
    'creative, research, debugging. Use for: mixed-domain queries, ' +
    'specialist routing, multi-disciplinary problems.',
  strategy: 'mixture_of_experts',
  consensus: 'best_of_n',
  rounds: 1,
  maxConcurrent: 4,
  timeoutMs: 120_000,
  onConflict: 'best_effort',
  members: [
    {
      id: 'coder',
      persona: 'coder',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 8192, costUsd: 0.20 },
    },
    {
      id: 'architect',
      persona: 'architect',
      role: 'synthesizer',
      weight: 1.2,
      budget: { tokens: 8192, costUsd: 0.20 },
    },
    {
      id: 'writer',
      persona: 'writer',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 8192, costUsd: 0.20 },
    },
    {
      id: 'researcher',
      persona: 'researcher',
      role: 'researcher',
      weight: 1.1,
      budget: { tokens: 8192, costUsd: 0.20 },
    },
    {
      id: 'debugger',
      persona: 'debugger',
      role: 'worker',
      weight: 1.0,
      budget: { tokens: 8192, costUsd: 0.20 },
    },
  ],
};

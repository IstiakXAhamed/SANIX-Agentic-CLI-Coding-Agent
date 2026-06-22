/**
 * @file index.ts
 * @description Public entry point for `@sanix/multiagent`. Re-exports
 * the full surface of SANIX multi-agent orchestration:
 *
 *   - **AgentTeam**       — the main entry point; bundles members +
 *     strategy + consensus and drives them via a caller-supplied
 *     `agentFactory`.
 *   - **Strategies**      — 7 execution strategies: parallel, sequential,
 *     debate, voting, mixture_of_experts, hierarchical, swarm.
 *   - **ConsensusEngine** — 6 reconciliation methods: majority,
 *     supermajority, unanimous, weighted, judge_decided, best_of_n.
 *   - **MoERouter**       — Mixture-of-Experts query router (keyword /
 *     embedding / LLM-based).
 *   - **TeamCoordinator** — registry of teams + auto-routing + parallel
 *     dispatch.
 *   - **QualityScorer**   — 5-dimension output quality scoring.
 *   - **Templates**       — 6 pre-built team configs (code-review,
 *     research, bug-fix, brainstorm, MoE, swarm).
 *
 * Importing paths:
 *   import { AgentTeam, TeamCoordinator } from '@sanix/multiagent';
 *   import { getStrategy, ParallelStrategy } from '@sanix/multiagent/strategies';
 *   import { TEAM_TEMPLATES, getTeamTemplate } from '@sanix/multiagent/templates';
 *
 * @packageDocumentation
 */

// ── Types ───────────────────────────────────────────────────────────────────
export type {
  AgentRole,
  TeamStrategy,
  ConsensusMethod,
  TeamMember,
  TeamConfig,
  TeamContribution,
  TeamResult,
  DebateTurn,
  MoESpecialty,
  SwarmParticle,
  AgentHandle,
  TeamEvents,
  ConsensusOptions,
  ConsensusResult,
  QualityDimensions,
  QualityScore,
} from './types.js';

// ── ConsensusEngine ─────────────────────────────────────────────────────────
export { ConsensusEngine, type ConsensusInput, qualityHeuristic } from './ConsensusEngine.js';

// ── QualityScorer ───────────────────────────────────────────────────────────
export { QualityScorer, type QualityScorerOptions } from './QualityScorer.js';

// ── MoERouter ───────────────────────────────────────────────────────────────
export { MoERouter, type MoERouterOptions, type RoutingResult } from './MoERouter.js';

// ── AgentTeam ───────────────────────────────────────────────────────────────
export { AgentTeam, type AgentTeamOptions } from './AgentTeam.js';

// ── TeamCoordinator ─────────────────────────────────────────────────────────
export { TeamCoordinator, type TeamCoordinatorOptions } from './TeamCoordinator.js';

// ── Strategies ──────────────────────────────────────────────────────────────
export {
  getStrategy,
  ParallelStrategy,
  SequentialStrategy,
  DebateStrategy,
  VotingStrategy,
  MoEStrategy,
  HierarchicalStrategy,
  SwarmStrategy,
} from './strategies/index.js';
export type {
  StrategyImpl,
  StrategyContext,
  MemberRunResult,
} from './strategies/index.js';
// Re-export the helpers for callers building custom strategies.
export { runMember, toContribution, buildTeamResult } from './strategies/index.js';

// ── Templates ───────────────────────────────────────────────────────────────
export {
  TEAM_TEMPLATES,
  getTeamTemplate,
  listTeamTemplates,
  CODE_REVIEW_TEAM,
  RESEARCH_TEAM,
  BUG_FIX_TEAM,
  BRAINSTORM_TEAM,
  MOE_TEAM,
  MOE_TEAM_SPECIALTIES,
  SWARM_TEAM,
} from './templates/index.js';

/**
 * @file types.ts
 * @description Shared types for `@sanix/multiagent`. Defines the roles,
 * strategies, consensus methods, team configuration, and result shapes
 * used across the AgentTeam, strategies, consensus engine, MoE router,
 * team coordinator, quality scorer, and templates.
 *
 * @packageDocumentation
 */

/**
 * The functional role an agent plays inside a team. Roles are advisory —
 * strategies may use them to route sub-tasks (e.g. hierarchical puts the
 * `coordinator` in charge of decomposition, `worker`s in charge of
 * sub-tasks, `judge` synthesizes final output).
 */
export type AgentRole =
  | 'coordinator'
  | 'worker'
  | 'critic'
  | 'researcher'
  | 'synthesizer'
  | 'judge';

/**
 * The execution strategy a team uses to combine member contributions.
 *
 * - `parallel`            — all members solve in parallel, outputs synthesized.
 * - `sequential`          — members solve one after another, each building on the previous.
 * - `debate`              — members argue for N rounds; optional judge synthesizes.
 * - `voting`              — each member proposes a solution; members vote on the best.
 * - `mixture_of_experts`  — a router picks the most relevant expert(s) per query.
 * - `hierarchical`        — coordinator decomposes; workers handle sub-tasks.
 * - `swarm`               — particle swarm optimization across N iterations.
 */
export type TeamStrategy =
  | 'parallel'
  | 'sequential'
  | 'debate'
  | 'voting'
  | 'mixture_of_experts'
  | 'hierarchical'
  | 'swarm';

/**
 * How a team reconciles divergent member outputs into a single consensus.
 *
 * - `majority`        — most common output (fuzzy-matched).
 * - `supermajority`   — 67% agreement required.
 * - `unanimous`       — 100% agreement required (else `onConflict`).
 * - `weighted`        — sum weights per output cluster.
 * - `judge_decided`   — a designated judge picks the best.
 * - `best_of_n`       — pick the highest-quality output via heuristic.
 */
export type ConsensusMethod =
  | 'majority'
  | 'supermajority'
  | 'unanimous'
  | 'weighted'
  | 'judge_decided'
  | 'best_of_n';

/**
 * A single agent participating in a team.
 */
export interface TeamMember {
  /** Stable unique id (nanoid or user-supplied). */
  id: string;
  /** References an `@sanix/workflows` persona id (e.g. `'coder'`, `'reviewer'`). */
  persona: string;
  /** The functional role this member plays in the team. */
  role: AgentRole;
  /** LLM provider id (e.g. `'anthropic'`, `'openai'`); optional. */
  provider?: string;
  /** Override the persona's system prompt. */
  systemPromptOverride?: string;
  /** Weight for weighted voting (default 1.0). */
  weight: number;
  /** Per-member budget cap (the team aborts the member if exceeded). */
  budget: { tokens: number; costUsd: number };
}

/**
 * Full configuration for an {@link AgentTeam}.
 */
export interface TeamConfig {
  /** Human-readable team name (e.g. `'Code Review Team'`). */
  name: string;
  /** Short description (used by the team coordinator for auto-routing). */
  description: string;
  /** The team's members (must be ≥1). */
  members: TeamMember[];
  /** Execution strategy. */
  strategy: TeamStrategy;
  /** Consensus reconciliation method. */
  consensus: ConsensusMethod;
  /** Number of rounds (debate strategy default 1). */
  rounds: number;
  /** Member id of the judge (required for `judge_decided` consensus). */
  judgeMemberId?: string;
  /** Coordinator member id (required for `hierarchical` strategy). */
  coordinatorId?: string;
  /** Max concurrent member executions (default 4). */
  maxConcurrent: number;
  /** Team-wide timeout in ms. */
  timeoutMs: number;
  /** Conflict-resolution policy when consensus cannot be reached. */
  onConflict?: 'retry' | 'escalate' | 'best_effort';
}

/**
 * A single member's contribution to a team result.
 */
export interface TeamContribution {
  /** Member id. */
  memberId: string;
  /** Persona id (e.g. `'coder'`). */
  persona: string;
  /** Role this member played. */
  role: AgentRole;
  /** The member's final output (string). */
  output: string;
  /** Cost in USD for this member's LLM calls. */
  costUsd: number;
  /** Total tokens used by this member. */
  tokensUsed: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** 0..1 — how much this member agrees with the final consensus. */
  agreementScore?: number;
}

/**
 * The result of an {@link AgentTeam.solve} call.
 */
export interface TeamResult {
  /** Team name (from config). */
  teamName: string;
  /** The final consensus answer. */
  consensus: string;
  /** Per-member contributions. */
  contributions: TeamContribution[];
  /** 0..1 — confidence in the consensus (agreement rate). */
  consensusConfidence: number;
  /** Total cost in USD across all members. */
  totalCostUsd: number;
  /** Total tokens used across all members. */
  totalTokens: number;
  /** Total wall-clock duration in ms. */
  totalDurationMs: number;
  /** Number of rounds executed (debate/swarm). */
  rounds: number;
  /** Member ids that disagreed with the consensus. */
  disagreements: string[];
}

/**
 * A single turn in a debate — one member's position + rebuttals.
 */
export interface DebateTurn {
  /** Round index (0-based). */
  round: number;
  /** The member who spoke. */
  memberId: string;
  /** The member's stated position. */
  position: string;
  /** Rebuttals against other members' positions. */
  rebuttals: Array<{ targetMemberId: string; argument: string }>;
}

/**
 * Mixture-of-Experts specialty declaration. One per expert member.
 */
export interface MoESpecialty {
  /** The member id this specialty applies to. */
  memberId: string;
  /** Domain tags (e.g. `['code', 'reasoning', 'creative']`). */
  domains: string[];
  /** Routing weight (default 1.0; boosts this expert's score). */
  weight: number;
}

/**
 * A single particle in a swarm strategy. Each member is one particle.
 */
export interface SwarmParticle {
  /** Particle id (= member id). */
  id: string;
  /** Current candidate solution (the particle's "position"). */
  position: string;
  /** Direction of exploration (a natural-language hint for the next iteration). */
  velocity: string;
  /** Best solution this particle has found so far. */
  personalBest: string;
  /** Quality score of `personalBest` (0..1). */
  personalBestScore: number;
}

/**
 * A handle to a running agent. Returned by the {@link AgentTeam}'s
 * `agentFactory` callback; the team uses it to drive the agent.
 *
 * The `run` method is the core call — it submits a prompt (optionally with
 * additional context) and returns the agent's textual response. The
 * optional `lastRun` accessor exposes cost/tokens/duration for the most
 * recent call so the team can aggregate them into {@link TeamResult}.
 */
export interface AgentHandle {
  /** Stable unique id (matches the {@link TeamMember.id}). */
  id: string;
  /**
   * Run the agent on a single prompt.
   *
   * @param input   - The primary prompt (the problem or sub-task).
   * @param context - Optional additional context (prior outputs, debate history, etc.).
   * @returns The agent's textual response.
   */
  run: (input: string, context?: string) => Promise<string>;
  /** Abort any in-flight run (best-effort). */
  abort: () => void;
  /**
   * Optional accessor for the most recent run's metrics. If omitted,
   * the team records `costUsd = 0`, `tokensUsed = 0` for this member.
   */
  lastRun?: () => { costUsd: number; tokensUsed: number; durationMs: number };
}

/**
 * Events emitted by {@link AgentTeam}. Each event has a typed payload.
 */
export interface TeamEvents {
  /** Fired when the team starts solving a problem. */
  'team:start': { teamName: string; problem: string; strategy: TeamStrategy };
  /** Fired when the team completes (success or failure). */
  'team:complete': { teamName: string; result: TeamResult };
  /** Fired when a member starts a run. */
  'member:start': { teamName: string; memberId: string; persona: string; role: AgentRole };
  /** Fired when a member completes a run. */
  'member:complete': {
    teamName: string;
    memberId: string;
    output: string;
    durationMs: number;
    costUsd: number;
    tokensUsed: number;
    error?: string;
  };
  /** Fired at the start of a debate/swarm round. */
  'round:start': { teamName: string; round: number; totalRounds: number };
  /** Fired at the end of a debate/swarm round. */
  'round:complete': { teamName: string; round: number; outputs: string[] };
  /** Fired when consensus is reached. */
  'consensus:reached': { teamName: string; consensus: string; confidence: number };
  /** Fired when consensus fails (conflict). */
  'consensus:failed': { teamName: string; reason: string };
  /** Fired when a conflict is detected between members. */
  'conflict:detected': { teamName: string; disagreements: string[] };
}

/**
 * Options for {@link ConsensusEngine.reach}.
 */
export interface ConsensusOptions {
  /**
   * Judge callback for `judge_decided` — receives the candidate outputs
   * and returns the winning output.
   */
  judge?: (outputs: string[]) => Promise<string>;
  /**
   * Threshold for fuzzy-match similarity (0..1). Outputs whose pairwise
   * similarity ≥ threshold are clustered together. Default 0.85.
   */
  threshold?: number;
  /**
   * Embedding function for semantic similarity. If omitted, falls back
   * to bag-of-words cosine similarity.
   */
  embed?: (text: string) => Promise<number[]>;
  /** Conflict-resolution policy (default `'best_effort'`). */
  onConflict?: 'retry' | 'escalate' | 'best_effort';
}

/**
 * Result of a consensus round.
 */
export interface ConsensusResult {
  /** The winning consensus output. */
  consensus: string;
  /** 0..1 — confidence (agreement rate). */
  confidence: number;
  /** Member ids whose output was in the minority cluster. */
  disagreements: string[];
}

/**
 * Per-dimension quality scores (0..1 each).
 */
export interface QualityDimensions {
  /** Semantic similarity to the original query. */
  relevance: number;
  /** Fraction of expected sub-topics covered. */
  completeness: number;
  /** Inverse of avg sentence length + presence of structure. */
  clarity: number;
  /** LLM-judge or fact-count heuristic. */
  correctness: number;
  /** Inverse of genericness (proper nouns, numbers, examples). */
  specificity: number;
}

/**
 * Output of {@link QualityScorer.score}.
 */
export interface QualityScore {
  /** Weighted average across dimensions. */
  overall: number;
  /** Per-dimension breakdown. */
  dimensions: QualityDimensions;
}

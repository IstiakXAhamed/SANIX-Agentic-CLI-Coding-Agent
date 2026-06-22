/**
 * @file AgentTeam.ts
 * @description The main entry point for SANIX multi-agent orchestration.
 * An `AgentTeam` bundles a set of {@link TeamMember}s with an execution
 * strategy and a consensus method, then drives them via the caller-
 * supplied `agentFactory` to solve problems.
 *
 * Events (emitted via EventEmitter3):
 *   - `team:start`        — fired when `solve()` begins.
 *   - `team:complete`     — fired when `solve()` finishes (success/failure).
 *   - `member:start`      — fired when a member starts a run.
 *   - `member:complete`   — fired when a member finishes a run.
 *   - `round:start`       — fired at the start of each debate/swarm round.
 *   - `round:complete`    — fired at the end of each debate/swarm round.
 *   - `consensus:reached` — fired when the team reaches consensus.
 *   - `consensus:failed`  — fired when the team fails to reach consensus.
 *   - `conflict:detected` — fired when divergent outputs are detected.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import pLimit from 'p-limit';
import type { AgentObserver, SanixTracer } from '@sanix/observe';
import type {
  AgentHandle,
  MoESpecialty,
  TeamConfig,
  TeamEvents,
  TeamMember,
  TeamResult,
  TeamStrategy,
} from './types.js';
import { ConsensusEngine } from './ConsensusEngine.js';
import { QualityScorer } from './QualityScorer.js';
import { MoERouter } from './MoERouter.js';
import { getStrategy } from './strategies/index.js';
import type { StrategyContext } from './strategies/types.js';

/** Constructor options for {@link AgentTeam}. */
export interface AgentTeamOptions {
  /**
   * Factory that creates an {@link AgentHandle} for a given team member.
   * Called once per member at team construction time.
   */
  agentFactory: (member: TeamMember) => AgentHandle;
  /**
   * Optional observer (for hook-based integration with inner AgentLoop
   * runs invoked inside the agent handle). Not used directly by built-in
   * strategies — they use `tracer` for span creation.
   */
  observer?: AgentObserver;
  /**
   * Optional tracer (for strategy-level trace spans around each member
   * run). If omitted, no spans are emitted by the strategies themselves.
   */
  tracer?: SanixTracer;
  /**
   * Optional Mixture-of-Experts specialties (one per expert member).
   * If omitted, the team derives default specialties from member
   * personas (e.g. `coder` → `['code']`).
   */
  specialties?: MoESpecialty[];
  /** Optional shared consensus engine (default: a fresh instance). */
  consensusEngine?: ConsensusEngine;
  /** Optional shared quality scorer (default: a fresh instance). */
  qualityScorer?: QualityScorer;
}

/**
 * An agent team — a coordinated group of agents that solve problems
 * via a configurable strategy (parallel, sequential, debate, voting,
 * MoE, hierarchical, or swarm).
 *
 * @example
 * ```ts
 * const team = new AgentTeam(config, {
 *   agentFactory: (member) => ({
 *     id: member.id,
 *     run: async (input, context) => {
 *       const res = await provider.chat({
 *         messages: [
 *           { role: 'system', content: getPersona(member.persona)?.systemPrompt ?? '' },
 *           { role: 'user', content: context ? `${context}\n\n${input}` : input },
 *         ],
 *       });
 *       return res.content;
 *     },
 *     abort: () => {},
 *   }),
 * });
 * const result = await team.solve('Design a REST API for a todo app.');
 * console.log(result.consensus);
 * ```
 */
export class AgentTeam extends EventEmitter<TeamEvents> {
  private readonly config: TeamConfig;
  private readonly handles: Map<string, AgentHandle> = new Map();
  private readonly observer?: AgentObserver;
  private readonly tracer?: SanixTracer;
  private readonly consensusEngine: ConsensusEngine;
  private readonly qualityScorer: QualityScorer;
  private readonly moeRouter?: MoERouter;
  private readonly limit: ReturnType<typeof pLimit>;
  private abortController: AbortController | null = null;

  /**
   * @param config - The team configuration.
   * @param opts   - Constructor options (agentFactory, observer, tracer, etc.).
   */
  constructor(config: TeamConfig, opts: AgentTeamOptions) {
    super();
    this.config = config;
    this.observer = opts.observer;
    this.tracer = opts.tracer;
    this.consensusEngine = opts.consensusEngine ?? new ConsensusEngine();
    this.qualityScorer = opts.qualityScorer ?? new QualityScorer();
    this.limit = pLimit(config.maxConcurrent ?? 4);

    // Build handles for every member via the factory.
    for (const member of config.members) {
      const handle = opts.agentFactory(member);
      this.handles.set(member.id, handle);
    }

    // Build the MoE router if any specialties are provided OR if the
    // strategy is mixture_of_experts (in which case we derive defaults).
    const specialties = opts.specialties ?? this.deriveSpecialties();
    if (config.strategy === 'mixture_of_experts' || specialties.length > 0) {
      try {
        this.moeRouter = new MoERouter(specialties, { topK: 1 });
      } catch {
        // If specialty derivation failed, the MoE strategy will fall
        // back to parallel at execution time.
      }
    }
  }

  /**
   * The team's configuration (read-only).
   */
  get teamConfig(): TeamConfig {
    return this.config;
  }

  /**
   * Solve a problem using the team's configured strategy.
   *
   * @param problem - The problem to solve.
   * @param context - Optional additional context (prior outputs, debate history, etc.).
   * @returns The team's result (consensus + per-member contributions + metrics).
   *
   * @example
   * ```ts
   * const result = await team.solve('Find the best sorting algorithm for nearly-sorted data.');
   * console.log(result.consensus);
   * console.log(`Confidence: ${result.consensusConfidence}`);
   * ```
   */
  async solve(problem: string, context?: string): Promise<TeamResult> {
    return this.executeStrategy(this.config.strategy, problem, context);
  }

  /**
   * Execute a specific strategy (overrides the config's strategy).
   * Useful for A/B comparison: run the same team with different strategies.
   *
   * @param strategy - The strategy to execute.
   * @param problem  - The problem to solve.
   * @param context  - Optional additional context.
   * @returns The team's result.
   *
   * @example
   * ```ts
   * const debateResult = await team.executeStrategy('debate', problem);
   * const votingResult = await team.executeStrategy('voting', problem);
   * ```
   */
  async executeStrategy(
    strategy: TeamStrategy,
    problem: string,
    context?: string,
  ): Promise<TeamResult> {
    this.emit('team:start', {
      teamName: this.config.name,
      problem,
      strategy,
    });

    // Fresh abort controller + timeout for this run.
    this.abortController = new AbortController();
    const timeoutId = setTimeout(
      () => this.abortController?.abort(new Error('Team timeout')),
      this.config.timeoutMs,
    );

    const ctx: StrategyContext = {
      config: this.config,
      members: this.config.members,
      handles: this.handles,
      observer: this.observer,
      tracer: this.tracer,
      consensusEngine: this.consensusEngine,
      qualityScorer: this.qualityScorer,
      moeRouter: this.moeRouter,
      emit: (event, payload) => this.emit(event, payload),
      signal: this.abortController.signal,
      limit: this.limit,
    };

    try {
      const strategyImpl = getStrategy(strategy);
      const result = await strategyImpl.execute(ctx, problem, context);
      this.emit('team:complete', {
        teamName: this.config.name,
        result,
      });
      return result;
    } catch (err) {
      // Strategy threw — emit a failed team:complete with an empty result.
      const errorMsg = err instanceof Error ? err.message : String(err);
      const fallbackResult: TeamResult = {
        teamName: this.config.name,
        consensus: '',
        contributions: [],
        consensusConfidence: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        totalDurationMs: 0,
        rounds: 0,
        disagreements: this.config.members.map((m) => m.id),
      };
      this.emit('consensus:failed', {
        teamName: this.config.name,
        reason: `Strategy error: ${errorMsg}`,
      });
      this.emit('team:complete', {
        teamName: this.config.name,
        result: fallbackResult,
      });
      return fallbackResult;
    } finally {
      clearTimeout(timeoutId);
      this.abortController = null;
    }
  }

  /**
   * Abort any in-flight team execution (best-effort). Subsequent member
   * runs will see the abort signal and bail out.
   */
  abort(): void {
    this.abortController?.abort(new Error('User aborted'));
    for (const handle of this.handles.values()) {
      try {
        handle.abort();
      } catch {
        // best-effort
      }
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Derive default MoE specialties from member personas. Maps known
   * @sanix/workflows persona ids to domain sets; unknown personas get
   * a generic `['general']` specialty.
   */
  private deriveSpecialties(): MoESpecialty[] {
    return this.config.members.map((m) => ({
      memberId: m.id,
      domains: PERSONA_DOMAINS[m.persona] ?? ['general'],
      weight: m.weight,
    }));
  }
}

/**
 * Default domain mapping from @sanix/workflows persona ids to MoE
 * domains. Used when the caller doesn't supply explicit specialties.
 */
const PERSONA_DOMAINS: Record<string, string[]> = {
  coder: ['code', 'programming', 'typescript', 'debugging'],
  reviewer: ['code', 'review', 'quality', 'testing'],
  architect: ['code', 'design', 'architecture', 'system'],
  debugger: ['code', 'debugging', 'troubleshooting', 'errors'],
  researcher: ['research', 'search', 'analysis', 'sources'],
  writer: ['writing', 'docs', 'creative', 'communication'],
  explainer: ['explainer', 'teaching', 'communication', 'simplification'],
  planner: ['planning', 'decomposition', 'strategy', 'scheduling'],
};

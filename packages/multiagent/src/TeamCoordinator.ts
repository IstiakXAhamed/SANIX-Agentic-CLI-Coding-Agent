/**
 * @file TeamCoordinator.ts
 * @description Manages multiple {@link AgentTeam}s working on related
 * sub-problems. Maintains a registry of teams + their last-run stats,
 * and provides:
 *
 *   - `registerTeam(config)`     — register a team, get its id.
 *   - `dispatch(problem, teamId?)` — run a specific team, or auto-route.
 *   - `parallelDispatch(problems, teamIds?)` — run multiple teams in parallel.
 *   - `autoRoute(problem)`       — pick the best team for a problem.
 *
 * Auto-routing uses a simple keyword-overlap score between the problem
 * and each team's `description` (and member persona tags). The team
 * with the highest score is selected.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type { AgentObserver, SanixTracer } from '@sanix/observe';
import type {
  AgentHandle,
  MoESpecialty,
  TeamConfig,
  TeamMember,
  TeamResult,
} from './types.js';
import { AgentTeam } from './AgentTeam.js';

/** A registered team + its last-run stats. */
interface RegisteredTeam {
  /** Unique team id (nanoid). */
  id: string;
  /** The team config. */
  config: TeamConfig;
  /** The live AgentTeam instance (built lazily on first dispatch). */
  team: AgentTeam;
  /** Last-run stats (undefined if never run). */
  lastRun?: {
    problem: string;
    result: TeamResult;
    timestamp: number;
  };
  /** Number of times this team has been dispatched. */
  runCount: number;
}

/** Options for {@link TeamCoordinator.constructor}. */
export interface TeamCoordinatorOptions {
  /**
   * Factory that creates an {@link AgentHandle} for a given team member.
   * Passed to every {@link AgentTeam} built by this coordinator.
   */
  agentFactory: (member: TeamMember) => AgentHandle;
  /** Optional observer (forwarded to every team). */
  observer?: AgentObserver;
  /** Optional tracer (forwarded to every team for span creation). */
  tracer?: SanixTracer;
  /** Optional specialties (forwarded to every team). */
  specialties?: MoESpecialty[];
}


/**
 * Coordinates multiple {@link AgentTeam}s working on related sub-problems.
 *
 * @example
 * ```ts
 * const coord = new TeamCoordinator({ agentFactory });
 * coord.registerTeam(codeReviewTeamConfig);
 * coord.registerTeam(researchTeamConfig);
 * const result = await coord.dispatch('Review this PR for security issues.');
 * // auto-routes to the code-review team
 * ```
 */
export class TeamCoordinator {
  private readonly teams = new Map<string, RegisteredTeam>();
  private readonly opts: TeamCoordinatorOptions;

  /**
   * @param opts - Constructor options (agentFactory, observer, specialties).
   */
  constructor(opts: TeamCoordinatorOptions) {
    this.opts = opts;
  }

  /**
   * Register a team. The {@link AgentTeam} instance is built immediately
   * so the agent handles are constructed (and any setup errors surface
   * at registration time, not at dispatch time).
   *
   * @param config - The team configuration.
   * @returns The new team's id.
   *
   * @example
   * ```ts
 *   const id = coord.registerTeam(codeReviewTeamConfig);
 *   console.log(`Registered team with id ${id}`);
 *   ```
   */
  registerTeam(config: TeamConfig): string {
    const id = nanoid(10);
    const team = new AgentTeam(config, {
      agentFactory: this.opts.agentFactory,
      observer: this.opts.observer,
      tracer: this.opts.tracer,
      specialties: this.opts.specialties,
    });
    this.teams.set(id, {
      id,
      config,
      team,
      runCount: 0,
    });
    return id;
  }

  /**
   * Dispatch a problem to a specific team (by id), or auto-route to
   * the best-matching team.
   *
   * @param problem - The problem to solve.
   * @param teamId  - Optional team id; if omitted, the coordinator
   *                  auto-routes via {@link autoRoute}.
   * @returns The team's result.
   *
   * @example
   * ```ts
 *   const result = await coord.dispatch('Find sources on quantum computing.');
 *   ```
   */
  async dispatch(problem: string, teamId?: string): Promise<TeamResult> {
    const id = teamId ?? this.autoRoute(problem);
    const entry = this.teams.get(id);
    if (!entry) {
      throw new Error(`No team registered with id '${id}'`);
    }
    const result = await entry.team.solve(problem);
    entry.lastRun = {
      problem,
      result,
      timestamp: Date.now(),
    };
    entry.runCount += 1;
    return result;
  }

  /**
   * Dispatch multiple problems in parallel (each to its own team).
   * If `teamIds` is omitted, each problem is auto-routed independently.
   *
   * @param problems - The problems to solve.
   * @param teamIds  - Optional team ids (one per problem; if omitted, auto-route each).
   * @returns The results, in the same order as `problems`.
   *
   * @example
   * ```ts
 *   const [r1, r2, r3] = await coord.parallelDispatch([
 *     'Review this PR.',
 *     'Find sources on quantum computing.',
 *     'Design a database schema.',
 *   ]);
 *   ```
   */
  async parallelDispatch(
    problems: string[],
    teamIds?: string[],
  ): Promise<TeamResult[]> {
    if (teamIds && teamIds.length !== problems.length) {
      throw new Error(
        `parallelDispatch: teamIds.length (${teamIds.length}) must equal problems.length (${problems.length})`,
      );
    }
    return Promise.all(
      problems.map((p, i) => this.dispatch(p, teamIds?.[i])),
    );
  }

  /**
   * Auto-route: pick the best team for a problem by keyword overlap
   * between the problem and each team's description + member personas.
   *
   * @param problem - The problem to route.
   * @returns The best-matching team's id.
   * @throws If no teams are registered.
   *
   * @example
   * ```ts
 *   const id = coord.autoRoute('Find sources on quantum computing.');
 *   console.log(`Routed to team ${id}`);
 *   ```
   */
  autoRoute(problem: string): string {
    if (this.teams.size === 0) {
      throw new Error('No teams registered');
    }
    let bestId: string | undefined;
    let bestScore = -1;
    for (const entry of this.teams.values()) {
      const score = this.scoreTeam(problem, entry.config);
      if (score > bestScore) {
        bestScore = score;
        bestId = entry.id;
      }
    }
    if (!bestId) {
      // Fallback: return the first team.
      return this.teams.keys().next().value!;
    }
    return bestId;
  }

  /**
   * List all registered team ids.
   */
  listTeams(): string[] {
    return [...this.teams.keys()];
  }

  /**
   * Get a registered team's config by id.
   */
  getTeamConfig(id: string): TeamConfig | undefined {
    return this.teams.get(id)?.config;
  }

  /**
   * Get a registered team's last-run stats by id.
   */
  getLastRun(id: string): { problem: string; result: TeamResult; timestamp: number } | undefined {
    return this.teams.get(id)?.lastRun;
  }

  /**
   * Get a registered team's run count by id.
   */
  getRunCount(id: string): number {
    return this.teams.get(id)?.runCount ?? 0;
  }

  /**
   * Unregister a team (and abort any in-flight run).
   */
  unregisterTeam(id: string): boolean {
    const entry = this.teams.get(id);
    if (!entry) return false;
    entry.team.abort();
    this.teams.delete(id);
    return true;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Score a team's relevance to a problem by keyword overlap between
   * the problem text and the team's description + member persona tags.
   */
  private scoreTeam(problem: string, config: TeamConfig): number {
    const problemTokens = new Set(tokenize(problem));
    if (problemTokens.size === 0) return 0;
    const teamText = [
      config.name,
      config.description,
      config.strategy,
      ...config.members.map((m) => m.persona),
      ...config.members.map((m) => m.role),
    ].join(' ');
    const teamTokens = new Set(tokenize(teamText));
    let intersection = 0;
    for (const t of problemTokens) {
      if (teamTokens.has(t)) intersection++;
    }
    return intersection / problemTokens.size;
  }
}

/**
 * Tokenize a string into lowercase alphanumeric words.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

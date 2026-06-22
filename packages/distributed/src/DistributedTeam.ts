/**
 * @file DistributedTeam.ts
 * @description Drop-in replacement for `@sanix/multiagent`'s
 * `AgentTeam` that runs each team member on a different cluster node.
 * Useful for parallel strategies where each member is a different LLM
 * provider (e.g. Anthropic on worker-1, OpenAI on worker-2) — the
 * coordinator dispatches each member's run as a distributed `llm_chat`
 * task to a capability-matched worker.
 *
 * Falls back to a local `AgentTeam` when no cluster nodes are
 * available (graceful degradation).
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import type {
  AgentHandle,
  TeamConfig,
  TeamEvents,
  TeamResult,
} from '@sanix/multiagent';
import { AgentTeam } from '@sanix/multiagent';
import type { ClusterCoordinator } from './ClusterCoordinator.js';

/**
 * Options for {@link DistributedTeam.constructor}.
 */
export interface DistributedTeamOptions {
  /** The cluster coordinator to dispatch through. */
  coordinator: ClusterCoordinator;
  /**
   * Local `agentFactory` for fallback execution (when no cluster
   * nodes are available) AND for any member whose required capability
   * is not advertised by any worker.
   */
  agentFactory: (member: { id: string; persona: string; provider?: string }) => AgentHandle;
  /**
   * Whether to fall back to local execution when the cluster has no
   * online worker nodes. Default `true`.
   */
  fallbackToLocal?: boolean;
  /**
   * Map of provider id → capability tag the worker must advertise.
   * Default: `anthropic → 'llm:anthropic'`, `openai → 'llm:openai'`,
   * `google → 'llm:google'`, `mistral → 'llm:mistral'`, `ollama →
   * 'llm:ollama'`, `cohere → 'llm:cohere'`.
   */
  providerCapabilityMap?: Record<string, string>;
}

/**
 * Distributed agent team — same public interface as `AgentTeam`, but
 * each member's `run()` is dispatched to a different cluster worker
 * as a distributed `llm_chat` task (round-robin or capability-matched).
 *
 * @example
 * ```ts
 * const team = new DistributedTeam(teamConfig, {
 *   coordinator,
 *   agentFactory: (member) => buildLocalHandle(member),
 * });
 * team.on('team:complete', ({ result }) => console.log(result.consensus));
 * const result = await team.solve('Design a REST API.');
 * ```
 */
export class DistributedTeam extends EventEmitter<TeamEvents> {
  private readonly config: TeamConfig;
  private readonly opts: DistributedTeamOptions;
  private readonly localTeam: AgentTeam;
  private readonly memberCapabilities: Map<string, string[]>;

  constructor(config: TeamConfig, opts: DistributedTeamOptions) {
    super();
    this.config = config;
    this.opts = opts;
    // Build a local AgentTeam whose agentFactory routes through the cluster.
    this.localTeam = new AgentTeam(config, {
      agentFactory: (member) => this.buildDistributedHandle(member),
    });
    this.memberCapabilities = this.deriveMemberCapabilities(config);
    // Forward all team events.
    this.localTeam.on('team:start', (e) => this.emit('team:start', e));
    this.localTeam.on('team:complete', (e) => this.emit('team:complete', e));
    this.localTeam.on('member:start', (e) => this.emit('member:start', e));
    this.localTeam.on('member:complete', (e) => this.emit('member:complete', e));
    this.localTeam.on('round:start', (e) => this.emit('round:start', e));
    this.localTeam.on('round:complete', (e) => this.emit('round:complete', e));
    this.localTeam.on('consensus:reached', (e) => this.emit('consensus:reached', e));
    this.localTeam.on('consensus:failed', (e) => this.emit('consensus:failed', e));
    this.localTeam.on('conflict:detected', (e) => this.emit('conflict:detected', e));
  }

  /**
   * Solve a problem using the team's strategy. Each member's run is
   * dispatched to a cluster worker (capability-matched) — or run
   * locally if no worker advertises the required capability.
   *
   * @param problem - The problem to solve.
   * @param context - Optional additional context (passed to members).
   */
  async solve(problem: string, context?: string): Promise<TeamResult> {
    return this.localTeam.solve(problem, context);
  }

  /** Abort any in-flight team run (best-effort). */
  abort(): void {
    this.localTeam.abort();
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Build an {@link AgentHandle} for a member that dispatches each
   * `run()` call to the cluster as a distributed `llm_chat` task.
   */
  private buildDistributedHandle(member: { id: string; persona: string; provider?: string }): AgentHandle {
    const requiredCaps = this.memberCapabilities.get(member.id) ?? [];
    const localFallback = this.opts.agentFactory(member);
    let lastRunMetrics: { costUsd: number; tokensUsed: number; durationMs: number } = {
      costUsd: 0,
      tokensUsed: 0,
      durationMs: 0,
    };
    return {
      id: member.id,
      run: async (input: string, context?: string): Promise<string> => {
        const onlineNodes = this.opts.coordinator.getRegistry().onlineNodes();
        const hasCapableNode =
          onlineNodes.length > 0 &&
          (requiredCaps.length === 0 ||
            onlineNodes.some((n) =>
              requiredCaps.every(
                (cap) => n.capabilities.includes(cap) || n.capabilities.includes(cap.replace(/:.*$/, ':any')),
              ),
            ));
        const shouldFallback =
          !hasCapableNode && (this.opts.fallbackToLocal ?? true);
        if (shouldFallback) {
          const start = Date.now();
          const out = await localFallback.run(input, context);
          lastRunMetrics = {
            costUsd: 0,
            tokensUsed: 0,
            durationMs: Date.now() - start,
          };
          return out;
        }
        const messages = [
          { role: 'system', content: member.persona },
          {
            role: 'user',
            content: context ? `${context}\n\n${input}` : input,
          },
        ];
        const start = Date.now();
        const taskId = await this.opts.coordinator.submitTask({
          type: 'llm_chat',
          payload: { messages, provider: member.provider },
          requiredCapabilities: requiredCaps,
        });
        const task = await this.opts.coordinator.waitForTask(taskId);
        lastRunMetrics = {
          costUsd: extractCost(task.result),
          tokensUsed: extractTokens(task.result),
          durationMs: Date.now() - start,
        };
        if (task.status !== 'complete') {
          // Last-resort: run locally to produce some output.
          return localFallback.run(input, context);
        }
        return extractContent(task.result);
      },
      abort: () => localFallback.abort(),
      lastRun: () => lastRunMetrics,
    };
  }

  /**
   * Derive per-member capability requirements from the team config.
   * Each member's `provider` field (if any) maps to a capability tag
   * via {@link DistributedTeamOptions.providerCapabilityMap}.
   */
  private deriveMemberCapabilities(config: TeamConfig): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const defaultMap: Record<string, string> = {
      anthropic: 'llm:anthropic',
      openai: 'llm:openai',
      google: 'llm:google',
      gemini: 'llm:google',
      mistral: 'llm:mistral',
      ollama: 'llm:ollama',
      cohere: 'llm:cohere',
      azure: 'llm:azure',
    };
    const map = this.opts.providerCapabilityMap ?? defaultMap;
    for (const member of config.members) {
      const caps: string[] = [];
      if (member.provider && map[member.provider]) {
        caps.push(map[member.provider]!);
      }
      out.set(member.id, caps);
    }
    return out;
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * Extract the textual content from a distributed task result.
 */
function extractContent(result: unknown): string {
  if (typeof result === 'string') return result;
  if (typeof result !== 'object' || result === null) return '';
  const r = result as Record<string, unknown>;
  if (typeof r.content === 'string') return r.content;
  if (typeof r.response === 'string') return r.response;
  if (typeof r.response === 'object' && r.response !== null) {
    const inner = r.response as Record<string, unknown>;
    if (typeof inner.content === 'string') return inner.content;
  }
  if (typeof r.output === 'string') return r.output;
  try {
    return JSON.stringify(r);
  } catch {
    return '';
  }
}

/**
 * Extract a USD cost figure from a distributed task result.
 */
function extractCost(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const r = result as Record<string, unknown>;
  if (typeof r.costUsd === 'number') return r.costUsd;
  if (typeof r.usage === 'object' && r.usage !== null) {
    const u = r.usage as Record<string, unknown>;
    if (typeof u.costUsd === 'number') return u.costUsd;
  }
  return 0;
}

/**
 * Extract a token-count figure from a distributed task result.
 */
function extractTokens(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const r = result as Record<string, unknown>;
  if (typeof r.usage === 'object' && r.usage !== null) {
    const u = r.usage as Record<string, unknown>;
    const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
    const output = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
    return input + output;
  }
  return 0;
}

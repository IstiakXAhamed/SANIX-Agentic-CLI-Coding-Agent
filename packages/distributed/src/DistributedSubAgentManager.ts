/**
 * @file DistributedSubAgentManager.ts
 * @description Drop-in replacement for `@sanix/core`'s `SubAgentManager`
 * that distributes sub-agent execution across the cluster. Falls back
 * to the local `SubAgentManager` when no cluster nodes are available
 * (graceful degradation).
 *
 * Each sub-agent is submitted as a distributed `agent_run` task. The
 * remote worker spins up its own AgentLoop to handle the sub-task and
 * reports the result back; we map that to a {@link SubAgentResult}.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { nanoid } from 'nanoid';
import type {
  AgentReport,
  RunContext,
  SubAgentHandle,
  SubAgentResult,
  SubTask,
  SubAgentManagerEvents,
  SubAgentManagerOptions,
} from '@sanix/core';
import { SubAgentManager } from '@sanix/core';
import type { SanixConfig } from '@sanix/config';
import type { ClusterCoordinator } from './ClusterCoordinator.js';

/**
 * Options for {@link DistributedSubAgentManager.constructor}.
 */
export interface DistributedSubAgentManagerOptions extends SubAgentManagerOptions {
  /** The cluster coordinator to dispatch through. */
  coordinator: ClusterCoordinator;
  /**
   * Whether to fall back to local execution when the cluster has no
   * online worker nodes. Default `true`.
   */
  fallbackToLocal?: boolean;
}

/**
 * Distributed sub-agent manager — same public interface as
 * `@sanix/core`'s `SubAgentManager`, but dispatches each sub-agent as
 * a distributed `agent_run` task to the cluster.
 *
 * @example
 * ```ts
 * const manager = new DistributedSubAgentManager(config, {
 *   coordinator,
 *   provider: cheapProvider,
 *   memory: router,
 * });
 * const handle = await manager.spawn(task, parentContext);
 * const results = await manager.waitForAll();
 * ```
 */
export class DistributedSubAgentManager extends EventEmitter<SubAgentManagerEvents> {
  private readonly config: SanixConfig;
  private readonly opts: DistributedSubAgentManagerOptions;
  private readonly localFallback: SubAgentManager;
  private readonly handles = new Map<string, SubAgentHandle>();

  constructor(config: SanixConfig, opts: DistributedSubAgentManagerOptions) {
    super();
    this.config = config;
    this.opts = opts;
    // Always keep a local fallback around for graceful degradation.
    this.localFallback = new SubAgentManager(config, opts);
  }

  /**
   * Spawn a sub-agent. Submits the sub-task to the cluster as an
   * `agent_run` distributed task; if no worker nodes are available
   * and `fallbackToLocal` is true (default), runs locally instead.
   *
   * @param task - The sub-task to delegate.
   * @param parentContext - The parent's run context (for fallback execution).
   * @returns A handle to the running sub-agent.
   */
  async spawn(task: SubTask, parentContext: RunContext): Promise<SubAgentHandle> {
    const id = task.id ?? nanoid();
    const subTask: SubTask = { ...task, id };

    const onlineNodes = this.opts.coordinator.getRegistry().onlineNodes();
    const shouldFallback =
      onlineNodes.length === 0 && (this.opts.fallbackToLocal ?? true);
    if (shouldFallback) {
      const localHandle = await this.localFallback.spawn(subTask, parentContext);
      this.handles.set(id, localHandle);
      return localHandle;
    }

    this.emit('spawn', { agentId: id, task: subTask });

    const abortController = new AbortController();
    const taskId = await this.opts.coordinator.submitTask({
      type: 'agent_run',
      payload: {
        goal: subTask.description,
        options: {
          tools: subTask.tools,
          tokenBudget: subTask.tokenBudget,
          parentContextSummary: subTask.parentContextSummary,
        },
      },
      requiredCapabilities: ['agent:loop'],
    });

    const resultPromise = this.opts.coordinator
      .waitForTask(taskId)
      .then((dt): SubAgentResult => this.mapTaskToResult(dt, id, subTask))
      .catch((err): SubAgentResult => {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('error', { agentId: id, error: msg });
        return {
          agentId: id,
          success: false,
          summary: `Sub-agent '${subTask.title}' failed: ${msg}`,
          modifiedFiles: [],
          learnedFacts: [],
          tokensUsed: { inputTokens: 0, outputTokens: 0 },
          error: msg,
        };
      });

    const handle: SubAgentHandle = {
      id,
      result: resultPromise,
      isRunning: true,
      cancel: () => {
        abortController.abort();
        void this.opts.coordinator.getDispatcher().abort(taskId);
      },
    };

    void resultPromise.then((r) => {
      const entry = this.handles.get(id);
      if (entry) entry.isRunning = false;
      const report: AgentReport = {
        agentId: id,
        task: subTask,
        result: r,
        reportedAt: new Date().toISOString(),
      };
      this.emit('complete', { report });
    });

    this.handles.set(id, handle);
    return handle;
  }

  /**
   * Wait for all running sub-agents to complete. Returns their results
   * in completion order (not spawn order).
   */
  async waitForAll(): Promise<SubAgentResult[]> {
    const allHandles = [...this.handles.values()];
    const localResults = await this.localFallback.waitForAll();
    const distributedResults = await Promise.all(
      allHandles
        .filter((h) => !localResults.some((r) => r.agentId === h.id))
        .map((h) => h.result),
    );
    return [...localResults, ...distributedResults];
  }

  /**
   * Receive a sub-agent's report manually (out-of-band). Forwards to
   * the local fallback (which handles memory merging).
   */
  async receiveReport(agentId: string, report: AgentReport): Promise<void> {
    await this.localFallback.receiveReport(agentId, report);
  }

  /**
   * Cancel all running sub-agents (best-effort). Returns the count of
   * cancelled agents.
   */
  cancelAll(): number {
    let count = this.localFallback.cancelAll();
    for (const entry of this.handles.values()) {
      if (entry.isRunning) {
        entry.cancel();
        count++;
      }
    }
    return count;
  }

  /** Number of currently-running sub-agents. */
  get runningCount(): number {
    let count = this.localFallback.runningCount;
    for (const entry of this.handles.values()) {
      if (entry.isRunning) count++;
    }
    return count;
  }

  /** All known sub-agent ids (running or finished). */
  listIds(): string[] {
    return [
      ...this.localFallback.listIds(),
      ...[...this.handles.keys()].filter((id) => !this.localFallback.listIds().includes(id)),
    ];
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Map a completed {@link DistributedTask} to a {@link SubAgentResult].
   */
  private mapTaskToResult(
    task: { status: string; result?: unknown; error?: string },
    agentId: string,
    subTask: SubTask,
  ): SubAgentResult {
    if (task.status === 'complete') {
      const r = task.result as
        | { summary?: string; modifiedFiles?: string[]; learnedFacts?: string[]; success?: boolean; tokensUsed?: { inputTokens: number; outputTokens: number } }
        | string
        | undefined;
      if (typeof r === 'object' && r !== null) {
        return {
          agentId,
          success: r.success ?? true,
          summary: r.summary ?? `Sub-agent '${subTask.title}' completed.`,
          modifiedFiles: Array.isArray(r.modifiedFiles) ? r.modifiedFiles : [],
          learnedFacts: Array.isArray(r.learnedFacts) ? r.learnedFacts : [],
          tokensUsed: r.tokensUsed ?? { inputTokens: 0, outputTokens: 0 },
        };
      }
      return {
        agentId,
        success: true,
        summary: typeof r === 'string' ? r.slice(0, 500) : `Sub-agent '${subTask.title}' completed.`,
        modifiedFiles: [],
        learnedFacts: [],
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
      };
    }
    return {
      agentId,
      success: false,
      summary: `Sub-agent '${subTask.title}' failed: ${task.error ?? task.status}`,
      modifiedFiles: [],
      learnedFacts: [],
      tokensUsed: { inputTokens: 0, outputTokens: 0 },
      error: task.error ?? task.status,
    };
  }
}

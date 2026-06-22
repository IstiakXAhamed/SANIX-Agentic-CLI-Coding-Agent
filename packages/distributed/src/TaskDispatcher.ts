/**
 * @file TaskDispatcher.ts
 * @description Routes {@link DistributedTask}s to the best-suited worker
 * node via the configured load-balancing strategy. Handles per-task
 * retries with exponential backoff, timeouts, and fall-through to
 * alternate nodes on failure.
 *
 * Each task type maps to a specific REST endpoint on the worker:
 *
 *   - `llm_chat`        → `POST /v1/chat`
 *   - `tool_execute`    → `POST /v1/tools/:name/execute`
 *   - `agent_run`       → `POST /v1/run` then poll `GET /v1/runs/:id`
 *   - `rag_query`       → `POST /v1/rag/query`
 *   - `sandbox_execute` → `POST /v1/sandbox/execute`
 *
 * @packageDocumentation
 */

import type { NodeRegistry } from './NodeRegistry.js';
import type {
  ClusterConfig,
  ClusterNode,
  DistributedTask,
  DistributedTaskType,
  LoadBalancer,
} from './types.js';

/**
 * Outcome of a single dispatch attempt.
 */
interface DispatchAttempt {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Whether this failure is retryable (network/timeout vs. logical 4xx). */
  retryable: boolean;
}

/**
 * Maps a task type to the default capability tag a node must advertise
 * to handle it. Used by the `capability` load-balancer when the task
 * doesn't supply explicit `requiredCapabilities`.
 */
const DEFAULT_CAPABILITY_FOR_TYPE: Record<DistributedTaskType, string> = {
  llm_chat: 'llm:any',
  tool_execute: 'tools:any',
  agent_run: 'agent:loop',
  rag_query: 'rag:store',
  sandbox_execute: 'sandbox:any',
};

/**
 * Routes tasks to worker nodes via the configured load-balancer.
 *
 * The dispatcher is stateful: it keeps a round-robin counter (when
 * `loadBalancer === 'round_robin'`) and a registry of in-flight tasks
 * (for `abort()`).
 *
 * @example
 * ```ts
 * const dispatcher = new TaskDispatcher(registry, config);
 * const task: DistributedTask = {
 *   id: 't1', type: 'llm_chat', payload: { messages: [...] },
 *   status: 'pending', createdAt: Date.now(), retries: 0,
 * };
 * const finished = await dispatcher.dispatch(task);
 * console.log(finished.status, finished.result);
 * ```
 */
export class TaskDispatcher {
  private readonly registry: NodeRegistry;
  private readonly config: ClusterConfig;
  private roundRobinIndex = 0;
  private readonly inFlight = new Map<string, AbortController>();

  constructor(registry: NodeRegistry, config: ClusterConfig) {
    this.registry = registry;
    this.config = config;
  }

  /**
   * Dispatch a task to a worker node. Picks a node via the configured
   * load-balancer, sends the task, polls/awaits completion, applies
   * retry-on-failure with exponential backoff, and times out the task
   * after `config.taskTimeoutMs`.
   *
   * @param task - The task to dispatch (mutated in-place + returned).
   * @returns The task in its terminal state.
   */
  async dispatch(task: DistributedTask): Promise<DistributedTask> {
    const maxRetries = this.config.retryPolicy.maxRetries;
    const baseBackoff = this.config.retryPolicy.backoffMs;
    const taskTimeout = this.config.taskTimeoutMs ?? 300000;

    const controller = new AbortController();
    this.inFlight.set(task.id, controller);
    const timeoutTimer = setTimeout(() => controller.abort(), taskTimeout);

    try {
      let lastError = '';
      const triedNodes = new Set<string>();
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (controller.signal.aborted) {
          task.status = 'timeout';
          task.error = `task timed out after ${taskTimeout}ms`;
          task.completedAt = Date.now();
          return task;
        }
        const node = this.pickNode(task, triedNodes);
        if (!node) {
          // No node available — wait briefly and retry (graceful
          // degradation handled by the caller; we just exit the loop).
          if (attempt < maxRetries) {
            await sleep(baseBackoff * 2 ** attempt);
            continue;
          }
          task.status = 'failed';
          task.error = lastError || 'no available cluster nodes';
          task.completedAt = Date.now();
          return task;
        }
        triedNodes.add(node.id);
        task.assignedNodeId = node.id;
        task.assignedAt = Date.now();
        task.status = 'assigned';
        task.retries = attempt;

        const attemptResult = await this.runOnNode(node, task, controller.signal);
        if (attemptResult.ok) {
          task.status = 'complete';
          task.result = attemptResult.result;
          task.completedAt = Date.now();
          // Update node load bookkeeping (down-tick).
          this.registry.updateHeartbeat(
            node.id,
            Math.max(0, node.currentLoad - 1 / Math.max(node.maxConcurrency, 1)),
          );
          return task;
        }
        lastError = attemptResult.error ?? 'unknown error';
        if (!attemptResult.retryable) {
          task.status = 'failed';
          task.error = lastError;
          task.completedAt = Date.now();
          return task;
        }
        if (attempt < maxRetries) {
          const backoff = baseBackoff * 2 ** attempt;
          await sleep(backoff);
        }
      }
      task.status = 'failed';
      task.error = lastError;
      task.completedAt = Date.now();
      return task;
    } finally {
      clearTimeout(timeoutTimer);
      this.inFlight.delete(task.id);
    }
  }

  /**
   * Dispatch a batch of tasks in parallel with a global concurrency
   * limit (`config.maxDispatchConcurrency`, default 32). Each task is
   * dispatched independently; failures of one do not affect others.
   *
   * @param tasks - The tasks to dispatch.
   * @returns The tasks in their terminal states (same order as input).
   */
  async dispatchBatch(tasks: DistributedTask[]): Promise<DistributedTask[]> {
    const limit = this.config.maxDispatchConcurrency ?? 32;
    const results: DistributedTask[] = new Array(tasks.length);
    let nextIndex = 0;
    let active = 0;
    return new Promise((resolve) => {
      const launchNext = (): void => {
        while (active < limit && nextIndex < tasks.length) {
          const i = nextIndex++;
          active++;
          void this.dispatch(tasks[i]!).then((t) => {
            results[i] = t;
            active--;
            if (nextIndex < tasks.length) launchNext();
            else if (active === 0) resolve(results);
          });
        }
        if (tasks.length === 0) resolve(results);
      };
      launchNext();
    });
  }

  /**
   * Abort a running task. Best-effort: aborts the local fetch + marks
   * the task `timeout`.
   *
   * @param taskId - The task id to abort.
   */
  async abort(taskId: string): Promise<void> {
    const controller = this.inFlight.get(taskId);
    if (controller) controller.abort();
  }

  // ─── Load balancer ─────────────────────────────────────────────────────

  /**
   * Pick the next node for a task, excluding nodes already tried for
   * this dispatch. Returns `null` if no candidate is available.
   *
   * @param task - The task being dispatched.
   * @param exclude - Node ids already tried for this task.
   */
  private pickNode(task: DistributedTask, exclude: Set<string>): ClusterNode | null {
    const required = task.requiredCapabilities ?? [DEFAULT_CAPABILITY_FOR_TYPE[task.type]];
    const onlines = this.registry.onlineNodes().filter((n) => !exclude.has(n.id));
    if (onlines.length === 0) return null;

    const lb: LoadBalancer = this.config.loadBalancer;
    switch (lb) {
      case 'least_load':
        return onlines.reduce((best, n) => (n.currentLoad < best.currentLoad ? n : best));
      case 'round_robin': {
        // Rotate through online nodes using a stable counter.
        const sorted = [...onlines].sort((a, b) => a.id.localeCompare(b.id));
        const choice = sorted[this.roundRobinIndex % sorted.length]!;
        this.roundRobinIndex = (this.roundRobinIndex + 1) % Math.max(sorted.length, 1);
        // Skip nodes already at max load if possible.
        if (choice.currentLoad >= 1 && sorted.length > 1) {
          const alternative = sorted.find((n) => n.currentLoad < 1);
          if (alternative) return alternative;
        }
        return choice;
      }
      case 'capability': {
        const capable = onlines.filter((n) =>
          required.every((cap) => n.capabilities.includes(cap) || n.capabilities.includes(cap.replace(/:.*$/, ':any'))),
        );
        if (capable.length === 0) {
          // Fall back to least_load among all online nodes if no node
          // advertises the exact capability (graceful degradation).
          return onlines.reduce((best, n) => (n.currentLoad < best.currentLoad ? n : best));
        }
        return capable.reduce((best, n) => (n.currentLoad < best.currentLoad ? n : best));
      }
      case 'random':
        return onlines[Math.floor(Math.random() * onlines.length)]!;
      default: {
        const _exhaustive: never = lb;
        void _exhaustive;
        return onlines[0]!;
      }
    }
  }

  // ─── HTTP transport ────────────────────────────────────────────────────

  /**
   * Send a task to a specific node and await its result.
   */
  private async runOnNode(
    node: ClusterNode,
    task: DistributedTask,
    signal: AbortSignal,
  ): Promise<DispatchAttempt> {
    try {
      switch (task.type) {
        case 'llm_chat':
          return await this.callJson(node, 'POST', '/v1/chat', task.payload, signal);
        case 'tool_execute':
          return await this.callToolExecute(node, task.payload, signal);
        case 'agent_run':
          return await this.callAgentRun(node, task.payload, signal);
        case 'rag_query':
          return await this.callJson(node, 'POST', '/v1/rag/query', task.payload, signal);
        case 'sandbox_execute':
          return await this.callJson(node, 'POST', '/v1/sandbox/execute', task.payload, signal);
        default: {
          const _exhaustive: never = task.type;
          void _exhaustive;
          return { ok: false, error: `unknown task type`, retryable: false };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Network errors + aborts are retryable.
      const retryable = signal.aborted || isNetworkError(err);
      return { ok: false, error: msg, retryable };
    }
  }

  /**
   * Generic JSON POST. Returns a parsed response object.
   */
  private async callJson(
    node: ClusterNode,
    method: string,
    path: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<DispatchAttempt> {
    const url = `${node.url.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (node.authToken) headers.Authorization = `Bearer ${node.authToken}`;
    const res = await fetch(url, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal,
    });
    const bodyText = await res.text();
    let parsed: unknown = bodyText;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json') && bodyText.length > 0) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // keep raw text
      }
    }
    if (!res.ok) {
      // 4xx (except 429) are non-retryable; 5xx + 429 are retryable.
      const retryable = res.status >= 500 || res.status === 429;
      return { ok: false, error: `HTTP ${res.status}: ${truncate(bodyText, 200)}`, retryable };
    }
    const root = parsed as { response?: unknown; result?: unknown; error?: string } | string;
    if (typeof root === 'object' && root !== null && typeof root.error === 'string') {
      return { ok: false, error: root.error, retryable: false };
    }
    const result = (typeof root === 'object' && root !== null)
      ? (root.response ?? root.result ?? root)
      : root;
    return { ok: true, result, retryable: false };
  }

  /**
   * Tool execution: extract the tool name from the payload, hit
   * `/v1/tools/:name/execute`.
   */
  private async callToolExecute(
    node: ClusterNode,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<DispatchAttempt> {
    const p = payload as { name?: string; input?: unknown } | undefined;
    if (!p || typeof p.name !== 'string') {
      return { ok: false, error: 'tool_execute requires payload.name', retryable: false };
    }
    return this.callJson(
      node,
      'POST',
      `/v1/tools/${encodeURIComponent(p.name)}/execute`,
      { input: p.input ?? {} },
      signal,
    );
  }

  /**
   * Agent run: POST /v1/run to start, then poll GET /v1/runs/:id until
   * the run reaches a terminal state. Returns the final run object.
   */
  private async callAgentRun(
    node: ClusterNode,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<DispatchAttempt> {
    const start = await this.callJson(node, 'POST', '/v1/run', payload, signal);
    if (!start.ok) return start;
    const startBody = start.result as { runId?: string } | undefined;
    if (!startBody || typeof startBody.runId !== 'string') {
      return { ok: false, error: 'agent_run: missing runId in start response', retryable: false };
    }
    const runId = startBody.runId;
    const pollInterval = 500;
    const maxPolls = Math.floor((this.config.taskTimeoutMs ?? 300000) / pollInterval);
    for (let i = 0; i < maxPolls; i++) {
      if (signal.aborted) return { ok: false, error: 'aborted', retryable: false };
      await sleep(pollInterval);
      const poll = await this.callJson(node, 'GET', `/v1/runs/${encodeURIComponent(runId)}`, undefined, signal);
      if (!poll.ok) {
        // Transient poll failures: retry on next iteration rather than bail.
        if (poll.retryable) continue;
        return poll;
      }
      const run = poll.result as {
        run?: { id?: string; status?: string; result?: unknown; error?: string };
      } | undefined;
      const status = run?.run?.status;
      if (status === 'complete' || status === 'completed' || status === 'succeeded') {
        return { ok: true, result: run?.run?.result ?? run?.run, retryable: false };
      }
      if (status === 'failed' || status === 'error' || status === 'aborted') {
        return { ok: false, error: run?.run?.error ?? `agent run ${status}`, retryable: false };
      }
      // otherwise still running — keep polling.
    }
    return { ok: false, error: 'agent_run polling timed out', retryable: true };
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds. Resolves immediately if `ms <= 0`.
 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate a string to `max` chars, appending an ellipsis if needed.
 */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Heuristic: was the given error a network-level failure (DNS, TCP,
 * TLS, timeout)? Used to decide whether to retry.
 */
function isNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('fetch failed')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('enotfound')) return true;
    if (msg.includes('etimedout')) return true;
    if (msg.includes('aborted')) return true;
    if (err.name === 'TypeError' && msg.includes('network')) return true;
  }
  return false;
}

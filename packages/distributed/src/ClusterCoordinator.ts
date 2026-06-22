/**
 * @file ClusterCoordinator.ts
 * @description Top-level orchestrator that runs on the coordinator
 * node. Owns the {@link NodeRegistry}, drives service discovery, and
 * routes submitted tasks through the {@link TaskDispatcher}.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { nanoid } from 'nanoid';
import type { NodeRegistry } from './NodeRegistry.js';
import type { NodeRegistryEvents } from './types.js';
import { NodeRegistry as NodeRegistryClass } from './NodeRegistry.js';
import { TaskDispatcher } from './TaskDispatcher.js';
import { createDiscovery, type ServiceDiscovery } from './discovery/index.js';
import type {
  ClusterConfig,
  ClusterCoordinatorEvents,
  ClusterStats,
  DistributedTask,
  DistributedTaskInput,
  NodeStatus,
} from './types.js';
// Re-export NodeRegistryEvents so callers can import it from this module.
export type { NodeRegistryEvents };

/**
 * Per-node stats accumulator. Mirrors the `byNode` field of
 * {@link ClusterStats} but tracks extra bookkeeping (latency samples).
 */
interface NodeStats {
  tasksCompleted: number;
  tasksFailed: number;
  loadSum: number;
  loadSamples: number;
  costUsd: number;
}

/**
 * Top-level cluster orchestrator. Runs on the coordinator node.
 *
 * Lifecycle:
 *   1. `new ClusterCoordinator(config)` — construct.
 *   2. `await coord.start()` — start discovery, sweep, dispatcher.
 *   3. `const id = await coord.submitTask({...})` — submit work.
 *   4. `const task = await coord.waitForTask(id)` — block for completion.
 *   5. `await coord.stop()` — graceful shutdown.
 *
 * @example
 * ```ts
 * const coord = new ClusterCoordinator({
 *   nodeId: 'coord-1',
 *   role: 'coordinator',
 *   discovery: { type: 'static', nodes: [{ url: 'http://worker-1:7331' }] },
 *   heartbeatIntervalMs: 5000,
 *   heartbeatTimeoutMs: 15000,
 *   loadBalancer: 'least_load',
 *   retryPolicy: { maxRetries: 3, backoffMs: 500 },
 * });
 * coord.on('task:complete', ({ taskId }) => console.log(`done: ${taskId}`));
 * await coord.start();
 * const id = await coord.submitTask({ type: 'llm_chat', payload: { messages: [...] } });
 * const result = await coord.waitForTask(id);
 * await coord.stop();
 * ```
 */
export class ClusterCoordinator extends EventEmitter<ClusterCoordinatorEvents> {
  private readonly config: ClusterConfig;
  private readonly registry: NodeRegistry;
  private readonly dispatcher: TaskDispatcher;
  private discovery: ServiceDiscovery | null = null;
  private readonly tasks = new Map<string, DistributedTask>();
  private readonly stats = new Map<string, NodeStats>();
  private latencySamples: number[] = [];
  private totalCostUsd = 0;
  private started = false;

  constructor(config: ClusterConfig) {
    super();
    this.config = config;
    this.registry = new NodeRegistryClass(config);
    this.dispatcher = new TaskDispatcher(this.registry, config);
    this.forwardRegistryEvents();
  }

  /**
   * Start the coordinator: kicks off service discovery, the registry
   * sweep job, and prepares the dispatcher. Idempotent.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.registry.startSweep();
    this.discovery = createDiscovery(this.config.discovery);
    // Initial discovery is fire-and-forget; continuous updates flow via start().
    this.discovery.start((nodes) => this.reconcileDiscovered(nodes));
    try {
      const initial = await this.discovery.discover();
      this.reconcileDiscovered(initial);
    } catch {
      // Discovery failures are non-fatal — coordinator still works for
      // nodes that register themselves via the REST API.
    }
  }

  /**
   * Stop the coordinator: stops discovery + sweep. In-flight tasks are
   * NOT aborted (call `await Promise.all(...)` on `waitForTask` first).
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.discovery?.stop();
    this.registry.stopSweep();
  }

  /**
   * Submit a task to the cluster. Returns the new task id immediately;
   * the task runs asynchronously. Use {@link waitForTask} or listen for
   * `task:complete`/`task:failed` events.
   *
   * @param input - Task definition (without auto-generated fields).
   * @returns The new task id.
   */
  async submitTask(input: DistributedTaskInput): Promise<string> {
    const task: DistributedTask = {
      id: nanoid(),
      type: input.type,
      payload: input.payload,
      assignedNodeId: input.assignedNodeId,
      status: 'pending',
      result: input.result,
      error: input.error,
      createdAt: Date.now(),
      assignedAt: input.assignedAt,
      completedAt: input.completedAt,
      retries: 0,
      requiredCapabilities: input.requiredCapabilities,
    };
    this.tasks.set(task.id, task);
    this.emit('task:submitted', { taskId: task.id, type: task.type });

    // Kick off dispatch in the background.
    void this.dispatcher
      .dispatch(task)
      .then((finished) => {
        this.tasks.set(finished.id, finished);
        const stats = this.ensureNodeStats(finished.assignedNodeId ?? 'unknown');
        const latency = (finished.completedAt ?? Date.now()) - (finished.assignedAt ?? finished.createdAt);
        if (finished.status === 'complete') {
          stats.tasksCompleted++;
          this.latencySamples.push(latency);
          if (this.latencySamples.length > 200) this.latencySamples.shift();
          const cost = extractCost(finished.result);
          if (cost > 0) {
            stats.costUsd += cost;
            this.totalCostUsd += cost;
          }
          this.emit('task:complete', {
            taskId: finished.id,
            nodeId: finished.assignedNodeId ?? 'unknown',
            result: finished.result,
          });
        } else {
          stats.tasksFailed++;
          this.emit('task:failed', {
            taskId: finished.id,
            nodeId: finished.assignedNodeId,
            error: finished.error ?? finished.status,
          });
        }
      })
      .catch((err) => {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = Date.now();
        this.tasks.set(task.id, task);
        this.emit('task:failed', { taskId: task.id, error: task.error });
      });

    return task.id;
  }

  /**
   * Get the current state of a task, or `null` if unknown.
   *
   * @param taskId - The task id.
   */
  getTaskStatus(taskId: string): DistributedTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * Block until a task reaches a terminal state. Rejects on timeout
   * (default 5 min) or if the task is unknown.
   *
   * @param taskId - The task id.
   * @param timeoutMs - Max wait (default `config.taskTimeoutMs`).
   */
  async waitForTask(taskId: string, timeoutMs?: number): Promise<DistributedTask> {
    const existing = this.tasks.get(taskId);
    if (!existing) throw new Error(`unknown task: ${taskId}`);
    if (isTerminal(existing.status)) return existing;

    const timeout = timeoutMs ?? this.config.taskTimeoutMs ?? 300000;
    return new Promise<DistributedTask>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('task:complete', onComplete);
        this.off('task:failed', onFail);
        reject(new Error(`waitForTask timed out after ${timeout}ms`));
      }, timeout);

      const onComplete = (e: { taskId: string }): void => {
        if (e.taskId === taskId) {
          clearTimeout(timer);
          this.off('task:complete', onComplete);
          this.off('task:failed', onFail);
          const t = this.tasks.get(taskId);
          if (t) resolve(t);
        }
      };
      const onFail = (e: { taskId: string }): void => {
        if (e.taskId === taskId) {
          clearTimeout(timer);
          this.off('task:complete', onComplete);
          this.off('task:failed', onFail);
          const t = this.tasks.get(taskId);
          if (t) resolve(t);
        }
      };
      this.on('task:complete', onComplete);
      this.on('task:failed', onFail);
    });
  }

  /**
   * Compute cluster-wide statistics. Latency is the rolling mean of the
   * last ~200 completed tasks.
   */
  getStats(): ClusterStats {
    const nodes = this.registry.list();
    const byNode: ClusterStats['byNode'] = {};
    let totalCompleted = 0;
    let totalFailed = 0;
    for (const [nodeId, s] of this.stats) {
      byNode[nodeId] = {
        tasksCompleted: s.tasksCompleted,
        tasksFailed: s.tasksFailed,
        avgLoad: s.loadSamples > 0 ? s.loadSum / s.loadSamples : 0,
        costUsd: s.costUsd,
      };
      totalCompleted += s.tasksCompleted;
      totalFailed += s.tasksFailed;
    }
    const avgLatency =
      this.latencySamples.length > 0
        ? this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length
        : 0;
    return {
      nodeCount: nodes.length,
      onlineNodes: nodes.filter((n) => n.status === 'online').length,
      totalTasksCompleted: totalCompleted,
      totalTasksFailed: totalFailed,
      avgLatencyMs: avgLatency,
      totalCostUsd: this.totalCostUsd,
      byNode,
    };
  }

  /**
   * Drain a node: mark it `draining` (no new tasks assigned), wait for
   * in-flight tasks to complete, then mark it `offline`. Resolves once
   * the node has no in-flight tasks (or after `timeoutMs`).
   *
   * @param nodeId - The node id to drain.
   * @param timeoutMs - Max wait (default 60s).
   */
  async drainNode(nodeId: string, timeoutMs = 60000): Promise<void> {
    this.registry.markDraining(nodeId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const inFlight = [...this.tasks.values()].filter(
        (t) => t.assignedNodeId === nodeId && !isTerminal(t.status),
      );
      if (inFlight.length === 0) {
        this.registry.markOffline(nodeId);
        this.emit('node:left', { nodeId, reason: 'drained' });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // Timed out — force offline.
    this.registry.markOffline(nodeId);
    this.emit('node:left', { nodeId, reason: 'drain timeout' });
  }

  /** Direct accessor for the underlying registry (used by routes). */
  getRegistry(): NodeRegistry {
    return this.registry;
  }

  /** Direct accessor for the underlying dispatcher (advanced use). */
  getDispatcher(): TaskDispatcher {
    return this.dispatcher;
  }

  /**
   * Register a node manually (typically called by the cluster REST
   * endpoint when a worker POSTs to `/v1/cluster/register`).
   */
  registerNode(node: Parameters<NodeRegistry['register']>[0]): void {
    this.registry.register(node);
    this.ensureNodeStats(node.id);
    this.emit('node:joined', { nodeId: node.id, url: node.url });
  }

  /**
   * Process a heartbeat received from a worker. Updates the node's
   * load + capability snapshot in the registry.
   */
  processHeartbeat(payload: {
    nodeId: string;
    load: number;
    capabilities: string[];
    maxConcurrency: number;
    metadata?: Record<string, unknown>;
  }): void {
    const existing = this.registry.get(payload.nodeId);
    if (existing) {
      existing.capabilities = payload.capabilities;
      existing.maxConcurrency = payload.maxConcurrency;
      if (payload.metadata) existing.metadata = { ...existing.metadata, ...payload.metadata };
    }
    this.registry.updateHeartbeat(payload.nodeId, payload.load);
    const stats = this.ensureNodeStats(payload.nodeId);
    stats.loadSum += payload.load;
    stats.loadSamples++;
  }

  /**
   * Record a task result reported by a worker (out-of-band — typically
   * called by the cluster REST endpoint when a worker POSTs to
   * `/v1/cluster/tasks/:id/result`).
   */
  recordTaskResult(report: {
    taskId: string;
    status: 'complete' | 'failed' | 'timeout';
    result?: unknown;
    error?: string;
    tokensUsed?: { inputTokens: number; outputTokens: number };
    costUsd?: number;
    durationMs?: number;
  }): void {
    const task = this.tasks.get(report.taskId);
    if (!task) return;
    if (isTerminal(task.status)) return; // already settled (e.g. via dispatch)
    task.status = report.status === 'timeout' ? 'timeout' : report.status;
    task.result = report.result;
    task.error = report.error;
    task.completedAt = Date.now();
    const stats = this.ensureNodeStats(task.assignedNodeId ?? 'unknown');
    if (task.status === 'complete') {
      stats.tasksCompleted++;
      if (report.costUsd && report.costUsd > 0) {
        stats.costUsd += report.costUsd;
        this.totalCostUsd += report.costUsd;
      }
      if (report.durationMs && report.durationMs > 0) {
        this.latencySamples.push(report.durationMs);
        if (this.latencySamples.length > 200) this.latencySamples.shift();
      }
      this.emit('task:complete', {
        taskId: task.id,
        nodeId: task.assignedNodeId ?? 'unknown',
        result: task.result,
      });
    } else {
      stats.tasksFailed++;
      this.emit('task:failed', { taskId: task.id, nodeId: task.assignedNodeId, error: task.error ?? task.status });
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Reconcile a freshly-discovered node list against the registry:
   * add new nodes, mark missing ones offline. Does NOT remove nodes
   * outright — they'll be swept to offline by the registry.
   */
  private reconcileDiscovered(nodes: Parameters<NodeRegistry['register']>[0][]): void {
    const seen = new Set<string>();
    for (const n of nodes) {
      seen.add(n.id);
      const existing = this.registry.get(n.id);
      if (!existing) {
        this.registry.register(n);
        this.ensureNodeStats(n.id);
        this.emit('node:joined', { nodeId: n.id, url: n.url });
      } else {
        // Refresh mutable fields.
        existing.url = n.url;
        existing.authToken = n.authToken ?? existing.authToken;
        existing.capabilities = n.capabilities;
        existing.maxConcurrency = n.maxConcurrency;
        this.registry.updateHeartbeat(n.id, n.currentLoad);
      }
    }
    // Nodes we used to know about but no longer discoverable → offline.
    for (const known of this.registry.list()) {
      if (!seen.has(known.id) && known.status !== 'offline') {
        this.registry.markOffline(known.id);
        this.emit('node:left', { nodeId: known.id, reason: 'disappeared from discovery' });
      }
    }
  }

  /**
   * Forward select registry events as coordinator events.
   */
  private forwardRegistryEvents(): void {
    const reg = this.registry as unknown as EventEmitter<NodeRegistryEvents>;
    reg.on('node:offline', ({ nodeId, reason }) => {
      this.emit('node:left', { nodeId, reason });
    });
    reg.on('cluster:degraded', (e) => {
      // Re-emit as cluster event.
      void e;
      this.emit('cluster:degraded', { onlineNodes: this.registry.onlineCount, totalNodes: this.registry.size });
    });
    reg.on('cluster:healthy', () => {
      this.emit('cluster:healthy', { onlineNodes: this.registry.onlineCount, totalNodes: this.registry.size });
    });
  }

  /**
   * Get (or create) the per-node stats accumulator.
   */
  private ensureNodeStats(nodeId: string): NodeStats {
    let s = this.stats.get(nodeId);
    if (!s) {
      s = { tasksCompleted: 0, tasksFailed: 0, loadSum: 0, loadSamples: 0, costUsd: 0 };
      this.stats.set(nodeId, s);
    }
    return s;
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * Is a task status terminal (no further state transitions)?
 */
function isTerminal(status: DistributedTask['status']): boolean {
  return status === 'complete' || status === 'failed' || status === 'timeout';
}

/**
 * Best-effort: extract a USD cost figure from a task result object.
 * Looks for `costUsd`, `cost`, or `usage.costUsd` fields.
 */
function extractCost(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const r = result as Record<string, unknown>;
  if (typeof r.costUsd === 'number') return r.costUsd;
  if (typeof r.cost === 'number') return r.cost;
  if (typeof r.usage === 'object' && r.usage !== null) {
    const u = r.usage as Record<string, unknown>;
    if (typeof u.costUsd === 'number') return u.costUsd;
  }
  return 0;
}

// Re-export the NodeStatus type for callers who want to construct
// filters via `import { type NodeStatus } from '@sanix/distributed'`.
export type { NodeStatus };

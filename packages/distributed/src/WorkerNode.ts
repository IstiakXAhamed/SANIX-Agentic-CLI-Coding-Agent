/**
 * @file WorkerNode.ts
 * @description Runs on worker nodes. Connects to the coordinator,
 * sends periodic heartbeats, accepts task assignments (via webhook
 * push or polling), executes them locally, and POSTs results back.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { nanoid } from 'nanoid';
import type {
  TaskAssignment,
  TaskResultReport,
  WorkerNodeEvents,
} from './types.js';

/**
 * Executor callback: given a task assignment, run it locally and
 * return a result report. The caller wires this up to their own
 * `AgentLoop`, tool registry, RAG pipeline, or sandbox manager.
 *
 * @example
 * ```ts
 * const executor: TaskExecutor = async (task) => {
 *   if (task.type === 'llm_chat') {
 *     const res = await provider.chat(task.payload as LLMRequest);
 *     return { taskId: task.taskId, status: 'complete', result: res, costUsd: 0.001 };
 *   }
 *   return { taskId: task.taskId, status: 'failed', error: 'unsupported' };
 * };
 * ```
 */
export type TaskExecutor = (task: TaskAssignment) => Promise<TaskResultReport>;

/**
 * Options for {@link WorkerNode.constructor}.
 */
export interface WorkerNodeOptions {
  /** Base URL of the coordinator (e.g. `http://coord.local:7331`). */
  coordinatorUrl: string;
  /** Optional bearer token for authenticating to the coordinator. */
  authToken?: string;
  /** Capability tags this worker advertises. */
  capabilities: string[];
  /** Max concurrent in-flight tasks this worker accepts. */
  maxConcurrency: number;
  /** Heartbeat interval (default 5000ms). */
  heartbeatIntervalMs?: number;
  /**
   * This worker's externally-reachable URL. The coordinator calls
   * back to this URL to push task assignments. If omitted, the
   * coordinator must use polling (worker pulls tasks via
   * `GET /v1/cluster/tasks/next`).
   */
  selfUrl?: string;
  /** Optional self-reported id (default: nanoid). */
  nodeId?: string;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * A worker node: registers with the coordinator, heartbeats, and
 * executes assigned tasks.
 *
 * @example
 * ```ts
 * const worker = new WorkerNode({
 *   coordinatorUrl: 'http://coord.local:7331',
 *   authToken: 'secret',
 *   capabilities: ['llm:anthropic', 'tools:filesystem'],
 *   maxConcurrency: 4,
 *   selfUrl: 'http://10.0.0.21:7331',
 * }, executor);
 * worker.on('task:received', ({ taskId }) => console.log(`got: ${taskId}`));
 * await worker.start();
 * ```
 */
export class WorkerNode extends EventEmitter<WorkerNodeEvents> {
  private readonly opts: Required<Omit<WorkerNodeOptions, 'authToken' | 'selfUrl' | 'nodeId' | 'metadata'>> & {
    authToken?: string;
    selfUrl?: string;
    nodeId: string;
    metadata?: Record<string, unknown>;
  };
  private readonly executor: TaskExecutor;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  private started = false;

  constructor(opts: WorkerNodeOptions, executor: TaskExecutor) {
    super();
    this.opts = {
      coordinatorUrl: opts.coordinatorUrl.replace(/\/$/, ''),
      authToken: opts.authToken,
      capabilities: opts.capabilities,
      maxConcurrency: opts.maxConcurrency,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 5000,
      selfUrl: opts.selfUrl,
      nodeId: opts.nodeId ?? `worker-${nanoid(8)}`,
      metadata: opts.metadata,
    };
    this.executor = executor;
  }

  /** This worker's self-reported id. */
  get id(): string {
    return this.opts.nodeId;
  }

  /**
   * Start the worker: register with the coordinator, kick off
   * heartbeats, and (if no `selfUrl`) start polling for tasks.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.register();
    this.startHeartbeats();
    if (!this.opts.selfUrl) {
      // No callback URL — pull tasks from the coordinator.
      this.startPolling();
    }
  }

  /** Stop the worker: stops heartbeats + polling. Does NOT abort in-flight tasks. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Wait briefly for in-flight tasks to finish (best-effort).
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /**
   * Add a capability to this worker's advertisement. Takes effect on
   * the next heartbeat.
   *
   * @param cap - The capability tag (e.g. `llm:openai`).
   */
  registerCapability(cap: string): void {
    if (!this.opts.capabilities.includes(cap)) {
      this.opts.capabilities.push(cap);
    }
  }

  /**
   * Handle a task assignment pushed by the coordinator (via the
   * cluster REST API). Executes the task locally and POSTs the result
   * back. Returns immediately; the result is delivered asynchronously.
   *
   * @param assignment - The task assignment from the coordinator.
   */
  handleAssignment(assignment: TaskAssignment): void {
    if (this.inFlight.size >= this.opts.maxConcurrency) {
      // Reject — coordinator should retry on another node.
      void this.postResult({
        taskId: assignment.taskId,
        status: 'failed',
        error: 'worker at max concurrency',
      });
      return;
    }
    this.emit('task:received', { taskId: assignment.taskId, type: assignment.type });
    const runPromise = this.executeAssignment(assignment);
    this.inFlight.set(assignment.taskId, runPromise);
    void runPromise.finally(() => this.inFlight.delete(assignment.taskId));
  }

  /** Current in-flight task count (for heartbeats). */
  get currentLoad(): number {
    return this.inFlight.size / this.opts.maxConcurrency;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Register this worker with the coordinator.
   */
  private async register(): Promise<void> {
    const body = {
      nodeId: this.opts.nodeId,
      url: this.opts.selfUrl ?? '',
      role: 'worker' as const,
      capabilities: this.opts.capabilities,
      maxConcurrency: this.opts.maxConcurrency,
      authToken: this.opts.authToken,
      metadata: this.opts.metadata,
    };
    try {
      const res = await fetch(`${this.opts.coordinatorUrl}/v1/cluster/register`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.emit('registered', { nodeId: this.opts.nodeId, coordinatorUrl: this.opts.coordinatorUrl });
      } else {
        this.emit('heartbeat:error', { error: `register failed: HTTP ${res.status}` });
      }
    } catch (err) {
      this.emit('heartbeat:error', {
        error: `register failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Start the periodic heartbeat loop.
   */
  private startHeartbeats(): void {
    if (this.heartbeatTimer) return;
    const send = (): void => {
      void this.sendHeartbeat();
    };
    void send();
    this.heartbeatTimer = setInterval(send, this.opts.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  /**
   * Send one heartbeat to the coordinator.
   */
  private async sendHeartbeat(): Promise<void> {
    const body = {
      nodeId: this.opts.nodeId,
      load: this.currentLoad,
      capabilities: this.opts.capabilities,
      maxConcurrency: this.opts.maxConcurrency,
      metadata: this.opts.metadata,
    };
    try {
      const res = await fetch(`${this.opts.coordinatorUrl}/v1/cluster/heartbeat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        this.emit('heartbeat:sent', { ts: Date.now(), load: body.load });
      } else {
        this.emit('heartbeat:error', { error: `HTTP ${res.status}` });
      }
    } catch (err) {
      this.emit('heartbeat:error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Start the polling loop (used when no `selfUrl` is configured).
   * Pulls one task at a time from `GET /v1/cluster/tasks/next?nodeId=...`.
   */
  private startPolling(): void {
    if (this.pollTimer) return;
    const poll = (): void => {
      if (this.inFlight.size >= this.opts.maxConcurrency) return;
      void this.pollForTask();
    };
    this.pollTimer = setInterval(poll, 1000);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
  }

  /**
   * Poll the coordinator for a pending task assigned to this worker.
   */
  private async pollForTask(): Promise<void> {
    try {
      const url = `${this.opts.coordinatorUrl}/v1/cluster/tasks/next?nodeId=${encodeURIComponent(this.opts.nodeId)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 204) return;
      if (!res.ok) return;
      const body = (await res.json()) as { assignment?: TaskAssignment };
      if (body?.assignment) {
        this.handleAssignment(body.assignment);
      }
    } catch {
      // Transient — try again next tick.
    }
  }

  /**
   * Execute one task assignment and POST the result back.
   */
  private async executeAssignment(assignment: TaskAssignment): Promise<void> {
    const start = Date.now();
    let report: TaskResultReport;
    try {
      // Honor the deadline if the executor doesn't.
      const remaining = Math.max(assignment.deadline - Date.now(), 1000);
      const timeout = setTimeout(() => {
        // Best-effort: just post a timeout result. The executor's
        // promise may still resolve later — its result is discarded.
        void this.postResult({
          taskId: assignment.taskId,
          status: 'timeout',
          error: `worker exceeded ${remaining}ms deadline`,
          durationMs: Date.now() - start,
        });
      }, remaining);
      try {
        report = await this.executor(assignment);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      report = {
        taskId: assignment.taskId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
    report.taskId = assignment.taskId;
    if (report.durationMs === undefined) report.durationMs = Date.now() - start;
    await this.postResult(report);
    if (report.status === 'complete') {
      this.emit('task:complete', { taskId: assignment.taskId, durationMs: report.durationMs });
    } else {
      this.emit('task:failed', { taskId: assignment.taskId, error: report.error ?? 'failed' });
    }
  }

  /**
   * POST a task result to the coordinator.
   */
  private async postResult(report: TaskResultReport): Promise<void> {
    try {
      await fetch(`${this.opts.coordinatorUrl}/v1/cluster/tasks/${encodeURIComponent(report.taskId)}/result`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      this.emit('heartbeat:error', {
        error: `failed to post result: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Build the standard headers for an outbound request to the coordinator.
   */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.opts.authToken) h.Authorization = `Bearer ${this.opts.authToken}`;
    return h;
  }
}

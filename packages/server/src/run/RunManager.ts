/**
 * @file RunManager — tracks active agent runs, supports abort + SSE event streaming.
 *
 * Each run gets its own AgentLoop instance running in the background. The RunManager
 * collects events from the loop and re-broadcasts them to any SSE subscribers.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import { nanoid } from 'nanoid';

export type RunEventType =
  | 'plan:created'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'iteration:before'
  | 'iteration:after'
  | 'tool:before'
  | 'tool:after'
  | 'llm:before'
  | 'llm:after'
  | 'cost:recorded'
  | 'subagent:spawn'
  | 'subagent:complete'
  | 'error'
  | 'progress'
  | 'status'
  | 'complete'
  | 'aborted';

export interface RunEvent {
  runId: string;
  type: RunEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface RunState {
  id: string;
  goal: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: number;
  endedAt?: number;
  iteration: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  lastEvent?: string;
  error?: string;
  result?: unknown;
}

interface RunRecord {
  state: RunState;
  abortController: AbortController;
  emitter: EventEmitter<Record<string, unknown>>;
  events: RunEvent[];     // bounded buffer (keep last 200)
  subscribers: Set<(evt: RunEvent) => void>;
}

const MAX_EVENT_BUFFER = 200;

/**
 * Manages concurrent agent runs in-process. Thread-safe (single-threaded Node).
 *
 * @example
 * ```ts
 * const mgr = new RunManager();
 * const runId = await mgr.startRun({
 *   goal: 'Refactor auth',
 *   agentLoopFactory: async (signal) => { ... return result; },
 * });
 * for await (const evt of mgr.getRunEvents(runId)) {
 *   console.log(evt.type, evt.data);
 * }
 * ```
 */
export class RunManager {
  private runs: Map<string, RunRecord> = new Map();

  /** Start a new agent run. Returns the run ID immediately. */
  async startRun(opts: {
    goal: string;
    agentLoopFactory: (signal: AbortSignal, emit: (type: RunEventType, data: Record<string, unknown>) => void) => Promise<unknown>;
  }): Promise<string> {
    const id = nanoid();
    const abortController = new AbortController();
    const emitter = new EventEmitter<Record<string, unknown>>();
    const state: RunState = {
      id,
      goal: opts.goal,
      status: 'starting',
      startedAt: Date.now(),
      iteration: 0,
      totalCostUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
    };
    const record: RunRecord = {
      state,
      abortController,
      emitter,
      events: [],
      subscribers: new Set(),
    };
    this.runs.set(id, record);

    const emit = (type: RunEventType, data: Record<string, unknown>): void => {
      const evt: RunEvent = { runId: id, type, timestamp: Date.now(), data };
      record.events.push(evt);
      // Trim buffer if it grows too large.
      if (record.events.length > MAX_EVENT_BUFFER) {
        record.events.splice(0, record.events.length - MAX_EVENT_BUFFER);
      }
      record.state.lastEvent = type;
      // Update aggregate counters.
      if (type === 'iteration:after') {
        const it = data.iteration;
        if (typeof it === 'number') record.state.iteration = it;
      }
      if (type === 'cost:recorded') {
        const cost = data.costUsd;
        if (typeof cost === 'number') record.state.totalCostUsd += cost;
        const tin = data.inputTokens;
        if (typeof tin === 'number') record.state.totalTokensIn += tin;
        const tout = data.outputTokens;
        if (typeof tout === 'number') record.state.totalTokensOut += tout;
      }
      // Fan out to SSE subscribers.
      for (const sub of record.subscribers) {
        try { sub(evt); } catch { /* one bad subscriber shouldn't break others */ }
      }
    };

    // Kick off the loop asynchronously.
    record.state.status = 'running';
    emit('status', { status: 'running' });

    void Promise.resolve()
      .then(() => opts.agentLoopFactory(abortController.signal, emit))
      .then((result) => {
        record.state.status = 'completed';
        record.state.endedAt = Date.now();
        record.state.result = result;
        emit('complete', { result });
      })
      .catch((err: unknown) => {
        record.state.status = abortController.signal.aborted ? 'aborted' : 'failed';
        record.state.endedAt = Date.now();
        record.state.error = err instanceof Error ? err.message : String(err);
        if (record.state.status === 'aborted') {
          emit('aborted', { reason: record.state.error });
        } else {
          emit('error', { error: record.state.error });
        }
      });

    return id;
  }

  getRun(id: string): RunState | null {
    return this.runs.get(id)?.state ?? null;
  }

  abortRun(id: string): boolean {
    const record = this.runs.get(id);
    if (!record) return false;
    if (record.state.status === 'completed' || record.state.status === 'failed' || record.state.status === 'aborted') return false;
    record.abortController.abort();
    return true;
  }

  /** Async iterable of run events — for SSE streaming. Completes when run ends. */
  async *getRunEvents(id: string): AsyncIterable<RunEvent> {
    const record = this.runs.get(id);
    if (!record) return;

    // Replay buffered events first.
    for (const evt of record.events) {
      yield evt;
    }

    // If already finished, we're done.
    if (record.state.status === 'completed' || record.state.status === 'failed' || record.state.status === 'aborted') {
      return;
    }

    // Otherwise, subscribe to new events.
    const queue: RunEvent[] = [];
    let resolveNext: ((v: IteratorResult<RunEvent>) => void) | null = null;
    let done = false;

    const subscriber = (evt: RunEvent): void => {
      if (done) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: evt, done: false });
      } else {
        queue.push(evt);
      }
      if (evt.type === 'complete' || evt.type === 'aborted' || evt.type === 'error') {
        done = true;
      }
    };
    record.subscribers.add(subscriber);

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          const evt = await new Promise<RunEvent>((resolve) => {
            resolveNext = (v) => {
              if (v.done) {
                // End of stream — reject to break out of the loop.
                throw new Error('stream ended');
              }
              return resolve(v.value);
            };
          });
          if (!evt) break;
          yield evt;
        }
      }
    } finally {
      record.subscribers.delete(subscriber);
      done = true;
    }
  }

  /** List all runs (optionally filtered by status). */
  list(filter?: { status?: RunState['status'] }): RunState[] {
    const states = [...this.runs.values()].map((r) => r.state);
    if (filter?.status) return states.filter((s) => s.status === filter.status);
    return states;
  }

  /** Remove old completed runs from memory (older than maxAgeMs). */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, record] of this.runs) {
      if (
        (record.state.status === 'completed' || record.state.status === 'failed' || record.state.status === 'aborted') &&
        (record.state.endedAt ?? 0) < cutoff
      ) {
        this.runs.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

/**
 * @file checkpoint/CheckpointManager.ts
 * @description Persistent session checkpointing for SANIX. A `Checkpoint`
 * captures the full agent state at a point in time so a run can be resumed
 * after a crash, a deliberate pause, or a context-window reset.
 *
 * Storage: one JSON file per checkpoint under `~/.sanix/checkpoints/`
 * (overridable via the `dir` constructor option). Filenames are
 * `<checkpointId>.json`.
 *
 * Two integration points:
 *   1. **Manual**: caller invokes {@link save} / {@link load} / {@link resume}.
 *   2. **Auto**: caller wires {@link startAutoCheckpoint} to an `AgentLoop`
 *      to save every N iterations.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { nanoid } from 'nanoid';
import type { LLMMessage } from '@sanix/providers';
import type { AgentLoop } from '../agent/AgentLoop.js';
import type { AgentState, Plan } from '../agent/types.js';
import type { CostSummary } from '../cost/CostTracker.js';

// ─── Checkpoint shape ───────────────────────────────────────────────────────

/**
 * A serialized agent state at a point in time. Written to disk as JSON; the
 * caller reloads it via {@link CheckpointManager.load} and feeds it to
 * {@link AgentLoop.resume} to continue the session.
 */
export interface Checkpoint {
  /** Unique id (nanoid). Used as the filename stem. */
  id: string;
  /** Logical session id (typically the run's project or a caller-chosen id). */
  sessionId: string;
  /** The originating goal (echoed for traceability). */
  goal: string;
  /** Unix epoch milliseconds. */
  createdAt: number;
  /** The full agent state at checkpoint time (serialized). */
  agentState: AgentState;
  /** The plan at checkpoint time. */
  plan: Plan;
  /** Task ids that had completed by checkpoint time. */
  completedTaskIds: string[];
  /** Conversation history at checkpoint time. */
  messages: LLMMessage[];
  /** Aggregate cost summary at checkpoint time. */
  costSummary: CostSummary;
  /** Iteration index at checkpoint time. */
  iteration: number;
  /** Free-form caller metadata (e.g. reason for checkpoint). */
  metadata?: Record<string, unknown>;
}

// ─── CheckpointManager ──────────────────────────────────────────────────────

/**
 * Options for {@link CheckpointManager.constructor}.
 */
export interface CheckpointManagerOptions {
  /**
   * Directory to store checkpoint files. Default: `~/.sanix/checkpoints/`.
   * Created on first write if it doesn't exist.
   */
  dir?: string;
}

/**
 * Persistent checkpoint manager. Stores checkpoints as JSON files on disk.
 *
 * @example
 * ```ts
 * const cm = new CheckpointManager();
 * const id = await cm.save({
 *   id: nanoid(),
 *   sessionId: 'my-project',
 *   goal: 'Refactor auth',
 *   createdAt: Date.now(),
 *   agentState, plan, completedTaskIds, messages,
 *   costSummary: { totalCostUsd: 0, ... },
 *   iteration: 5,
 * });
 *
 * // Later (possibly in a new process):
 * const cp = await cm.load(id);
 * if (cp) await agentLoop.resume(cp.id);
 *
 * // Or auto-save every 5 iterations:
 * const stop = cm.startAutoCheckpoint(agentLoop, 5);
 * // ... later:
 * stop();
 * ```
 */
export class CheckpointManager {
  /** Absolute path to the checkpoint directory. */
  private readonly checkpointDir: string;

  constructor(opts: CheckpointManagerOptions = {}) {
    this.checkpointDir =
      opts.dir ?? path.join(os.homedir(), '.sanix', 'checkpoints');
  }

  /**
   * Save a checkpoint to disk. Returns the file path written.
   *
   * @param checkpoint - The checkpoint to save (id is used as the filename).
   * @returns The absolute file path of the written checkpoint.
   */
  async save(checkpoint: Checkpoint): Promise<string> {
    await this.ensureDir();
    const filePath = this.pathFor(checkpoint.id);
    const json = JSON.stringify(checkpoint, null, 2);
    await fs.writeFile(filePath, json, 'utf8');
    return filePath;
  }

  /**
   * Load a checkpoint by id. Returns `null` if the file doesn't exist or
   * can't be parsed.
   *
   * @param id - The checkpoint id.
   */
  async load(id: string): Promise<Checkpoint | null> {
    const filePath = this.pathFor(id);
    try {
      const json = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(json) as unknown;
      return validateCheckpoint(parsed);
    } catch {
      return null;
    }
  }

  /**
   * List checkpoints, optionally filtered by session id. Returns the most
   * recent first (sorted by `createdAt` descending).
   *
   * @param opts - `{ sessionId?, limit? }`.
   */
  async list(
    opts: { sessionId?: string; limit?: number } = {},
  ): Promise<Checkpoint[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.checkpointDir);
    } catch {
      return [];
    }

    const checkpoints: Checkpoint[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      const cp = await this.load(id);
      if (!cp) continue;
      if (opts.sessionId && cp.sessionId !== opts.sessionId) continue;
      checkpoints.push(cp);
    }

    checkpoints.sort((a, b) => b.createdAt - a.createdAt);
    if (opts.limit !== undefined && opts.limit > 0) {
      return checkpoints.slice(0, opts.limit);
    }
    return checkpoints;
  }

  /**
   * Delete a checkpoint by id. Returns `true` if a file was deleted.
   */
  async delete(id: string): Promise<boolean> {
    const filePath = this.pathFor(id);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Return the most recent checkpoint, optionally filtered by session id.
   * Returns `null` if no checkpoints exist.
   */
  async latest(sessionId?: string): Promise<Checkpoint | null> {
    const list = await this.list({ sessionId, limit: 1 });
    return list[0] ?? null;
  }

  /**
   * Wire automatic checkpointing into an `AgentLoop`. Saves a checkpoint
   * every `interval` iterations (using the loop's `iteration` event).
   *
   * The checkpoint captures the loop's current state via its
   * `currentState` getter. If the loop has no state yet (e.g. before
   * `run()` is called), the save is skipped.
   *
   * @param agentLoop - The agent loop to observe.
   * @param interval - Number of iterations between checkpoints (e.g. 5).
   * @returns A stop function — call to remove the listener.
   */
  startAutoCheckpoint(agentLoop: AgentLoop, interval: number): () => void {
    if (interval <= 0) {
      throw new Error(`startAutoCheckpoint: interval must be > 0 (got ${interval})`);
    }
    let count = 0;
    const handler = async (): Promise<void> => {
      count++;
      if (count % interval !== 0) return;
      const state = agentLoop.currentState;
      if (!state) return;
      try {
        await this.save({
          id: nanoid(),
          sessionId: state.context.project ?? 'default',
          goal: state.goal,
          createdAt: Date.now(),
          agentState: state,
          plan: state.plan,
          completedTaskIds: [...state.worldModel.completedTaskIds],
          messages: [...state.messages],
          costSummary: deriveCostSummary(state),
          iteration: state.iterationCount,
          metadata: { source: 'auto', interval },
        });
      } catch {
        // Checkpoint failures must not crash the loop.
      }
    };
    agentLoop.on('iteration', handler);
    return () => {
      agentLoop.off('iteration', handler);
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /** Compute the absolute file path for a checkpoint id. */
  private pathFor(id: string): string {
    // Sanitize: keep only alphanumerics + dash + underscore to avoid path
    // traversal. nanoid already produces safe chars, but be defensive.
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
    return path.join(this.checkpointDir, `${safe}.json`);
  }

  /** Ensure the checkpoint directory exists. */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.checkpointDir, { recursive: true });
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Validate a parsed JSON object as a {@link Checkpoint}. Returns the typed
 * checkpoint or `null` if the shape is wrong.
 */
function validateCheckpoint(raw: unknown): Checkpoint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  if (typeof r.sessionId !== 'string') return null;
  if (typeof r.goal !== 'string') return null;
  if (typeof r.createdAt !== 'number') return null;
  if (typeof r.agentState !== 'object' || r.agentState === null) return null;
  if (typeof r.plan !== 'object' || r.plan === null) return null;
  if (!Array.isArray(r.completedTaskIds)) return null;
  if (!Array.isArray(r.messages)) return null;
  if (typeof r.costSummary !== 'object' || r.costSummary === null) return null;
  if (typeof r.iteration !== 'number') return null;
  return {
    id: r.id,
    sessionId: r.sessionId,
    goal: r.goal,
    createdAt: r.createdAt,
    agentState: r.agentState as AgentState,
    plan: r.plan as Plan,
    completedTaskIds: r.completedTaskIds.filter(
      (s): s is string => typeof s === 'string',
    ),
    messages: r.messages as LLMMessage[],
    costSummary: r.costSummary as CostSummary,
    iteration: r.iteration,
    metadata:
      r.metadata && typeof r.metadata === 'object'
        ? (r.metadata as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Derive a basic {@link CostSummary} from the agent state. Since the
 * CheckpointManager does not have direct access to a CostTracker instance,
 * it builds a minimal summary from the state's aggregate token totals.
 * For accurate per-provider / per-session breakdowns, callers should
 * construct a real CostSummary from their CostTracker and pass it via the
 * checkpoint's `costSummary` field directly.
 */
function deriveCostSummary(state: AgentState): CostSummary {
  const inputTokens = state.totalTokens.inputTokens;
  const outputTokens = state.totalTokens.outputTokens;
  return {
    totalCostUsd: 0,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    savedFromCachingUsd: 0,
    byProvider: {},
    bySession: {},
  };
}

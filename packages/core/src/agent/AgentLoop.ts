/**
 * @file agent/AgentLoop.ts
 * @description The OODA agent loop — SANIX's heart. Per spec §1:
 *
 *   Observe → Orient → Decide → Act
 *
 * Each iteration:
 *   1. `observe()`  — gather environment state, tool results, file changes.
 *   2. `orient()`   — update world model, check memory, assess progress.
 *   3. `decide()`   — select next action via LLM (returns a `Decision`).
 *   4. `act(d)`     — execute the decision (tool call, LLM completion,
 *                     spawn sub-agent, complete, abort, ask user).
 *
 * The Reflector runs every N iterations (config.agent.reflectEveryN, default 3).
 * The MemoryCompressor runs every 10 iterations. The loop terminates on
 * COMPLETE / ABORT, on max-iterations, or on unrecoverable error. At the
 * end, the session is persisted to episodic memory.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import { nanoid } from 'nanoid';
import type { IProvider, LLMMessage, LLMRequest, LLMResponse, TokenUsage } from '@sanix/providers';
import type { SanixConfig } from '@sanix/config';
// Type-only import for V4 conversation state tracker. Erased at compile
// time — no runtime cycle. The tracker instance flows in via
// `RunContext.stateTracker` (preferred) or `AgentLoopOptions.stateTracker`
// (constructor fallback).
import type { ConversationStateTracker } from '@sanix/compressor';
import type {
  ActionRecord,
  AgentLoopEvents,
  AgentResult,
  AgentState,
  Decision,
  Plan,
  RunContext,
  TaskResult,
  TaskType,
} from './types.js';
import type { Planner } from './Planner.js';
import type { Executor } from './Executor.js';
import type { Reflector } from './Reflector.js';
import type { SubAgentManager } from './SubAgentManager.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { MemoryRouter } from '../memory/MemoryRouter.js';
import type { ScoredMemoryItem } from '../memory/types.js';
import type { ContextBuilder } from '../context/ContextBuilder.js';
import type { BuiltContext as OptimizerBuiltContext, BudgetAllocation } from '../context/TokenBudget.js';
import type { MemoryCompressor } from '../memory/MemoryCompressor.js';
import type { HookManager } from '../hooks/HookManager.js';
import type { Checkpoint, CheckpointManager } from '../checkpoint/CheckpointManager.js';
import { computeCost, type CostEntry, type CostTracker } from '../cost/CostTracker.js';

// ─── V3 optimizer integration (lazy, optional) ──────────────────────────────
//
// The optimizer surface is declared locally and loaded via dynamic `import()`
// on first use. If `@sanix/optimizer` is not installed, all V3 integration
// points silently no-op — the loop behaves exactly as before.

/**
 * Minimal surface we use from `@sanix/optimizer` in the agent loop:
 * `ContextCompressor` (pre-LLM-call compression) and `ToolResultTruncator`
 * (post-tool-call truncation).
 */
interface AgentLoopOptimizerSurface {
  ContextCompressor: new () => {
    compress: (
      ctx: OptimizerBuiltContext,
      targetTokens: number,
      opts?: {
        summarizer?: (texts: string[]) => Promise<string>;
        toolResultHeadTailLines?: number;
        summarizeOldestN?: number;
        memoryImportanceFloor?: number;
        truncateToolResults?: boolean;
        omitOldFiles?: boolean;
        consolidateMessages?: boolean;
        summarizeOldest?: boolean;
        dropLowImportanceMemories?: boolean;
      },
    ) => Promise<OptimizerBuiltContext>;
  };
  ToolResultTruncator: new () => {
    truncate: (
      result: string,
      opts: { maxTokens?: number; type?: string; headTailLines?: number; maxJsonArrayElements?: number },
    ) => string;
  };
}

let agentLoopOptimizer: AgentLoopOptimizerSurface | null | undefined = undefined;
let agentLoopOptimizerLoadAttempted = false;

/**
 * Lazily load the optimizer surface used by the agent loop. Cached after
 * first load; `null` if unavailable.
 */
async function loadAgentLoopOptimizer(): Promise<AgentLoopOptimizerSurface | null> {
  if (agentLoopOptimizerLoadAttempted) return agentLoopOptimizer ?? null;
  agentLoopOptimizerLoadAttempted = true;
  try {
    const mod = (await import('@sanix/optimizer')) as Partial<AgentLoopOptimizerSurface>;
    if (mod?.ContextCompressor && mod?.ToolResultTruncator) {
      agentLoopOptimizer = mod as AgentLoopOptimizerSurface;
      return agentLoopOptimizer;
    }
    agentLoopOptimizer = null;
    return null;
  } catch {
    agentLoopOptimizer = null;
    return null;
  }
}

/**
 * Per-tier token usage observed from the last built context. Set by
 * `decide()` and consumed by the iteration loop's reallocator-observe
 * step.
 */
interface ObservedTierUsage {
  system: number;
  memory: number;
  plan: number;
  history: number;
  context: number;
  output: number;
}

/**
 * Options for {@link AgentLoop.constructor}.
 */
export interface AgentLoopOptions {
  /** The primary LLM provider (used for decide()). */
  provider?: IProvider;
  /** The planner instance (Phase 1 + 2). */
  planner?: Planner;
  /** The task executor. */
  executor?: Executor;
  /** The reflector (self-critique). */
  reflector?: Reflector;
  /** The sub-agent manager. */
  subAgentManager?: SubAgentManager;
  /** The tool registry. */
  toolRegistry?: ToolRegistry;
  /** The memory router. */
  memory?: MemoryRouter;
  /** The context builder. */
  contextBuilder?: ContextBuilder;
  /** The memory compressor (background job). */
  memoryCompressor?: MemoryCompressor;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Override max iterations (else config.agent.maxIterations). */
  maxIterations?: number;
  /**
   * Optional hook manager. When set, the loop emits `agent:start`,
   * `iteration:before`, `iteration:after`, `agent:complete`, `plan:*`,
   * `subagent:*`, `llm:*`, and `error` events. Also auto-wired into the
   * tool registry (if one is provided) for `tool:before` / `tool:after`.
   * Opt-in.
   */
  hookManager?: HookManager;
  /**
   * Optional checkpoint manager (used by {@link AgentLoop.resume} when no
   * explicit manager is passed). Auto-checkpointing during {@link run} is
   * controlled by {@link RunContext.checkpointManager} + {@link RunContext.checkpointEveryN}.
   */
  checkpointManager?: CheckpointManager;
  /**
   * V4: Optional conversation state tracker. When set (either here or
   * via {@link RunContext.stateTracker}), the loop calls
   * `stateTracker.observe(assistantMessage, toolResult)` after each
   * `act()` so the tracker can update its state machine. The tracker
   * is typically also wired into the {@link ContextBuilder} so its
   * `[STATE]` block is injected into the system prompt.
   *
   * At runtime, the loop resolves the tracker from
   * {@link RunContext.stateTracker} first (preferred — per-run), then
   * falls back to this constructor opt. Opt-in — `undefined` by default.
   */
  stateTracker?: ConversationStateTracker;
}

/**
 * The SANIX OODA agent loop.
 *
 * @example
 * ```ts
 * const loop = new AgentLoop(config, {
 *   provider, planner, executor, reflector, subAgentManager,
 *   toolRegistry, memory, contextBuilder, memoryCompressor,
 * });
 * loop.on('decide', ({ decision }) => console.log('decided:', decision.type));
 * const result = await loop.run('Refactor the auth module', runContext);
 * console.log(result.success ? 'done' : 'failed', result.summary);
 * ```
 */
export class AgentLoop extends EventEmitter<AgentLoopEvents> {
  private state!: AgentState;
  private readonly config: SanixConfig;
  private readonly provider: IProvider | undefined;
  private readonly planner: Planner | undefined;
  private readonly executor: Executor | undefined;
  private readonly reflector: Reflector | undefined;
  private readonly subAgentManager: SubAgentManager | undefined;
  private readonly toolRegistry: ToolRegistry | undefined;
  private readonly memory: MemoryRouter | undefined;
  private readonly contextBuilder: ContextBuilder | undefined;
  private readonly memoryCompressor: MemoryCompressor | undefined;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  /** The hook manager (optional; null until set). */
  private readonly hookManager: HookManager | undefined;
  /** Checkpoint manager from constructor opts (used by resume() as fallback). */
  private readonly checkpointManagerFromOpts: CheckpointManager | undefined;
  /**
   * V4 conversation state tracker from constructor opts. Used as a
   * fallback when {@link RunContext.stateTracker} is not set on a
   * given run. Resolved per-run via {@link resolveStateTracker}.
   */
  private readonly stateTrackerFromOpts: ConversationStateTracker | undefined;
  /**
   * Cost tracker (optional). Set from {@link RunContext.costTracker} at the
   * start of {@link run} / {@link resume}. When absent, cost tracking is
   * silently skipped.
   */
  private costTracker: CostTracker | undefined;
  /**
   * Session id used to group cost entries from a single run. Generated at
   * run start (or taken from {@link RunContext.sessionId}).
   */
  private sessionId: string = 'sess-unknown';
  /** Running cumulative USD cost across the current session. */
  private cumulativeCostUsd: number = 0;

  constructor(config: SanixConfig, opts: AgentLoopOptions = {}) {
    super();
    this.config = config;
    this.provider = opts.provider;
    this.planner = opts.planner;
    this.executor = opts.executor;
    this.reflector = opts.reflector;
    this.subAgentManager = opts.subAgentManager;
    this.toolRegistry = opts.toolRegistry;
    this.memory = opts.memory;
    this.contextBuilder = opts.contextBuilder;
    this.memoryCompressor = opts.memoryCompressor;
    this.systemPrompt =
      opts.systemPrompt ??
      `You are SANIX, an autonomous agent. Observe, orient, decide, act.
You have access to tools for filesystem, shell, code, web, memory, and sub-agent operations.
Always make progress toward the user's goal. When done, emit a COMPLETE decision.`;
    this.maxIterations = opts.maxIterations ?? config.agent.maxIterations;
    this.hookManager = opts.hookManager;
    this.checkpointManagerFromOpts = opts.checkpointManager;
    this.stateTrackerFromOpts = opts.stateTracker;
    // Auto-wire the hook manager into the tool registry so tool:before /
    // tool:after fire without the caller having to do it manually.
    if (this.hookManager && this.toolRegistry) {
      this.toolRegistry.setHookManager(this.hookManager);
    }
  }

  /**
   * Snapshot of the current agent state, or `undefined` before `run()` /
   * `resume()` is called. Used by {@link CheckpointManager.startAutoCheckpoint}
   * to read the live state on each iteration event.
   */
  get currentState(): AgentState | undefined {
    return this.state;
  }

  /**
   * Initialize the agent state for a new run. Called automatically by
   * {@link run}; exposed publicly for testing.
   *
   * @param goal - The user's high-level goal.
   * @param context - The run context (config, cwd, signal, ...).
   * @returns The initial agent state.
   */
  initState(goal: string, context: RunContext): AgentState {
    const emptyPlan: Plan = {
      goal,
      understanding: '',
      ambiguities: [],
      tasks: [],
      successCriteria: [],
      estimatedTokenBudget: this.config.agent.defaultTokenBudget,
      recommendedProvider: this.config.providers.default,
      parallelizable: false,
      createdAt: new Date().toISOString(),
    };
    return {
      iterationCount: 0,
      maxIterations: this.maxIterations,
      isComplete: false,
      isAborted: false,
      goal,
      context,
      plan: emptyPlan,
      worldModel: {
        goal,
        understanding: '',
        ambiguities: [],
        completedTaskIds: [],
        inFlightTaskIds: [],
        failedTaskIds: [],
        lessonsLearned: [],
        modifiedFiles: [],
        toolCallCounts: {},
        totalTokens: { inputTokens: 0, outputTokens: 0 },
      },
      messages: context.seedMessages ? [...context.seedMessages] : [],
      actions: [],
      systemPrompt: this.systemPrompt,
      fileContext: {},
      currentTask: null,
      totalTokens: { inputTokens: 0, outputTokens: 0 },
    };
  }

  /**
   * Run the OODA loop to completion (or abort). The main entry point.
   *
   * @param goal - The user's high-level goal.
   * @param context - The run context.
   * @returns The final `AgentResult`.
   */
  async run(goal: string, context: RunContext): Promise<AgentResult> {
    this.state = this.initState(goal, context);
    const startedAt = new Date().toISOString();

    // ── Wire cost tracking (opt-in via RunContext.costTracker). ──
    this.costTracker = context.costTracker;
    this.sessionId = context.sessionId ?? this.generateSessionId();
    this.cumulativeCostUsd = 0;
    if (this.costTracker) {
      // Best-effort: load historical entries so the cumulative includes
      // prior sessions on this machine. Failures are non-fatal.
      try {
        await this.costTracker.load();
      } catch {
        // swallow — cost tracking is best-effort
      }
    }

    // ── V4: Seed the conversation state tracker with the goal + any
    // seed user messages so the tracker's `[STATE]` block has
    // meaningful content from iteration 0. Best-effort — failures are
    // swallowed (the loop must never abort because the tracker choked
    // on a seed message). ──
    const tracker = this.resolveStateTracker();
    if (tracker) {
      try {
        tracker.setGoal(goal);
        // Observe any seed user messages so their questions are
        // captured in `pendingQuestions`.
        for (const m of this.state.messages) {
          if (m.role === 'user') {
            tracker.observe(m);
          }
        }
      } catch {
        // swallow — state tracker is best-effort
      }
    }

    // ── Hook: agent:start (before the loop begins). ──
    if (this.hookManager) {
      await this.hookManager.emit('agent:start', { agentState: this.state });
    }

    // ── Phase 1: decompose the goal into a plan (if a planner is configured). ──
    if (this.planner) {
      try {
        const plan = await this.planner.decompose(goal, {
          cwd: context.cwd,
          project: context.project,
          availableTools: this.toolRegistry?.enabledNames(),
        });
        this.state.plan = plan;
        this.state.worldModel.understanding = plan.understanding;
        this.state.worldModel.ambiguities = plan.ambiguities;

        // ── Hook: plan:created (after Planner.decompose). ──
        if (this.hookManager) {
          const hookCtx = await this.hookManager.emit('plan:created', {
            plan,
            agentState: this.state,
          });
          if (hookCtx.plan) {
            this.state.plan = hookCtx.plan;
          }
        }
      } catch (err) {
        // Planner failure is non-fatal — the loop can still proceed with a
        // fallback single-task plan (the Planner itself handles fallback).
        const msg = err instanceof Error ? err.message : String(err);
        void msg;
      }
    }

    await this.runLoop(context);
    return this.finalize(context, startedAt);
  }

  /**
   * Resume an agent run from a previously-saved checkpoint. The checkpoint
   * is loaded, the agent state is restored, and the OODA loop continues
   * from the saved iteration count.
   *
   * @param checkpointId - The checkpoint id to resume from.
   * @param checkpointManager - The manager to load the checkpoint from. If
   *   omitted, falls back to the manager set via {@link AgentLoopOptions}
   *   (constructor), then to a default manager at `~/.sanix/checkpoints/`.
   * @returns The final `AgentResult`.
   * @throws if the checkpoint cannot be found via any available manager.
   */
  async resume(
    checkpointId: string,
    checkpointManager?: CheckpointManager,
  ): Promise<AgentResult> {
    // Resolve the checkpoint manager: explicit arg → constructor opt →
    // default (~/.sanix/checkpoints).
    const candidates: CheckpointManager[] = [];
    if (checkpointManager) candidates.push(checkpointManager);
    if (this.checkpointManagerFromOpts) candidates.push(this.checkpointManagerFromOpts);

    let cp: Checkpoint | null = null;
    let usedManager: CheckpointManager | undefined;
    for (const m of candidates) {
      cp = await m.load(checkpointId);
      if (cp) {
        usedManager = m;
        break;
      }
    }
    // Last-resort: build a default manager (~/.sanix/checkpoints) if the
    // checkpoint might be there.
    if (!cp) {
      const { CheckpointManager: DefaultCM } = await import(
        '../checkpoint/CheckpointManager.js'
      );
      const fallback = new DefaultCM();
      cp = await fallback.load(checkpointId);
      if (cp) usedManager = fallback;
    }
    if (!cp) {
      throw new Error(`resume: checkpoint '${checkpointId}' not found`);
    }

    // Restore the agent state.
    this.state = cp.agentState;
    const context = this.state.context;
    // Ensure the checkpoint manager is wired for further auto-checkpointing.
    if (usedManager && !context.checkpointManager) {
      context.checkpointManager = usedManager;
    }
    const startedAt = new Date(cp.createdAt).toISOString();

    // ── Wire cost tracking on resume too (so resumed runs keep accounting). ──
    this.costTracker = context.costTracker;
    this.sessionId = context.sessionId ?? this.generateSessionId();
    this.cumulativeCostUsd = 0;
    if (this.costTracker) {
      try {
        await this.costTracker.load();
      } catch {
        // swallow — cost tracking is best-effort
      }
    }

    // Note: no `agent:start` hook on resume — the loop is continuing, not
    // beginning. Callers that need a hook on resume can use `iteration:before`
    // which fires on the next iteration.
    await this.runLoop(context);
    return this.finalize(context, startedAt);
  }

  /**
   * The OODA loop body. Shared by {@link run} and {@link resume}. Reads
   * `this.state` (which must already be initialized or restored).
   */
  private async runLoop(context: RunContext): Promise<void> {
    try {
      while (
        !this.state.isComplete &&
        !this.state.isAborted &&
        this.state.iterationCount < this.maxIterations
      ) {
        // Check for cancellation.
        if (context.signal?.aborted) {
          this.state.isAborted = true;
          this.state.abortReason = 'User aborted.';
          break;
        }

        // ── Hook: iteration:before (before observe()). ──
        if (this.hookManager) {
          await this.hookManager.emit('iteration:before', {
            agentState: this.state,
            iteration: this.state.iterationCount,
          });
        }

        await this.observe();
        await this.orient();

        const decision = await this.decide();
        this.emit('decide', { iteration: this.state.iterationCount, decision });

        // SPAWN_SUBAGENT: hand off, continue.
        if (decision.type === 'SPAWN_SUBAGENT') {
          // ── Hook: subagent:spawn (before the sub-agent starts). ──
          if (this.hookManager) {
            await this.hookManager.emit('subagent:spawn', {
              agentState: this.state,
              subAgentId: decision.subTask.id,
            });
          }
          if (this.subAgentManager) {
            await this.subAgentManager.spawn(
              decision.subTask,
              this.state.context,
            );
          }
          this.recordAction(decision, { inputTokens: 0, outputTokens: 0 });
          this.state.iterationCount++;
          this.emit('iteration', {
            iteration: this.state.iterationCount,
            tokens: this.state.totalTokens,
          });
          continue;
        }

        // COMPLETE: break.
        if (decision.type === 'COMPLETE') {
          this.state.isComplete = true;
          this.recordAction(decision, { inputTokens: 0, outputTokens: 0 });
          break;
        }

        // ABORT: break.
        if (decision.type === 'ABORT') {
          this.state.isAborted = true;
          this.state.abortReason = decision.reason;
          this.recordAction(decision, { inputTokens: 0, outputTokens: 0 });
          break;
        }

        // ASK_USER: yield (the loop pauses; the caller resolves it externally).
        if (decision.type === 'ASK_USER') {
          this.recordAction(decision, { inputTokens: 0, outputTokens: 0 });
          // For now, treat as a pause point — the caller is expected to
          // observe the decision via the 'decide' event and resume. We
          // break here so the run doesn't spin.
          break;
        }

        // TOOL_CALL or LLM_COMPLETION: act.
        const result = await this.act(decision);
        this.emit('act', {
          iteration: this.state.iterationCount,
          decision,
          result: result ?? undefined,
        });

        this.state.iterationCount++;
        this.emit('iteration', {
          iteration: this.state.iterationCount,
          tokens: this.state.totalTokens,
        });

        // ── Hook: iteration:after (after act()). ──
        if (this.hookManager) {
          await this.hookManager.emit('iteration:after', {
            agentState: this.state,
            iteration: this.state.iterationCount,
          });
        }

        // ── Reflector (every N iterations). ──
        if (this.reflector && this.reflector.shouldRun(this.state.iterationCount)) {
          try {
            const reflection = await this.reflector.assess(this.state);
            if (reflection.shouldReplan && this.planner) {
              const newPlan = await this.planner.replan(
                this.state.plan,
                this.state.worldModel.completedTaskIds,
                this.state.actions
                  .filter((a) => a.error)
                  .map((a) => ({ taskId: '', error: a.error ?? '' }))
                  .filter((f) => f.taskId || f.error),
              );
              this.state.plan = newPlan;

              // ── Hook: plan:revised (after Planner.replan). ──
              if (this.hookManager) {
                const hookCtx = await this.hookManager.emit('plan:revised', {
                  plan: newPlan,
                  agentState: this.state,
                });
                if (hookCtx.plan) {
                  this.state.plan = hookCtx.plan;
                }
              }
            }
            // Apply suggested adjustments to the world model (for the next decide()).
            if (reflection.suggestedAdjustments.length > 0) {
              this.state.worldModel.lessonsLearned.push(
                ...reflection.suggestedAdjustments,
              );
            }
          } catch (err) {
            // Reflector failure is non-fatal.
            const msg = err instanceof Error ? err.message : String(err);
            void msg;
          }
        }

        // ── MemoryCompressor (every 10 iterations). ──
        if (this.memoryCompressor && this.memoryCompressor.shouldRun(this.state.iterationCount)) {
          try {
            await this.memoryCompressor.run(this.state);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void msg;
          }
        }

        // ── Auto-checkpoint (every N iterations, opt-in via RunContext). ──
        const cpManager = context.checkpointManager;
        const cpEvery = context.checkpointEveryN;
        if (cpManager && cpEvery && cpEvery > 0 && this.state.iterationCount % cpEvery === 0) {
          try {
            await cpManager.save({
              id: nanoid(),
              sessionId: context.project ?? 'default',
              goal: this.state.goal,
              createdAt: Date.now(),
              agentState: this.state,
              plan: this.state.plan,
              completedTaskIds: [...this.state.worldModel.completedTaskIds],
              messages: [...this.state.messages],
              // Prefer the real CostTracker summary when available; fall
              // back to a token-only placeholder otherwise.
              costSummary: this.costTracker
                ? this.costTracker.summarize({ sessionId: this.sessionId })
                : deriveCostSummary(this.state),
              iteration: this.state.iterationCount,
              metadata: { source: 'auto' },
            });
          } catch {
            // Checkpoint failures must not crash the loop.
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (process.env.SANIX_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error('[SANIX_DEBUG] AgentLoop.runLoop threw:', error.stack || error);
      }
      this.emit('error', {
        error,
        iteration: this.state.iterationCount,
        state: this.state,
      });
      // ── Hook: error (on any unhandled error). ──
      if (this.hookManager) {
        await this.hookManager.emit('error', {
          error,
          agentState: this.state,
        });
      }
      this.state.isAborted = true;
      this.state.abortReason = error.message;
    }
  }

  /**
   * Finalize the run: persist to episodic memory, fire `agent:complete`
   * hook, build the result, and emit the EE3 `complete` event.
   */
  private async finalize(context: RunContext, startedAt: string): Promise<AgentResult> {
    // ── Persist the session to episodic memory. ──
    if (this.memory) {
      try {
        await this.memory.persistSession({
          goal: this.state.goal,
          planJson: JSON.stringify(this.state.plan),
          startedAt,
          endedAt: new Date().toISOString(),
          success: this.state.isComplete && !this.state.isAborted,
          lessons: this.state.worldModel.lessonsLearned,
          project: context.project,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void msg;
      }
    }

    // ── Hook: agent:complete (after the loop finishes). ──
    if (this.hookManager) {
      await this.hookManager.emit('agent:complete', { agentState: this.state });
    }

    const result = this.buildResult();
    this.emit('complete', { result });
    return result;
  }

  /**
   * Observe phase: gather environment state, tool results, file changes.
   * In this implementation, observation is largely passive (the world model
   * is updated incrementally by `act()`); the phase exists for symmetry
   * with the OODA spec and to emit the `observe` event for the TUI.
   */
  async observe(): Promise<void> {
    this.emit('observe', {
      iteration: this.state.iterationCount,
      state: this.state,
    });
  }

  /**
   * Orient phase: update world model, check memory, assess progress. If a
   * memory router is configured, recalls memories relevant to the current
   * task / goal and stashes them on the state for the context builder.
   *
   * ## v2 wiring
   *
   * If a `MemoryCompressor` with a v2 `TierManager` is configured, each
   * recalled memory is reported as a `MemoryAccessEvent` via
   * `tierManager.observe()`. The tier manager accumulates these
   * observations and uses them in its next `runCycle()` to decide
   * promotions / demotions / prunes. This is the opt-in path — if v2
   * isn't installed, the compressor's `tierManager` getter returns
   * `null` and this code path is a no-op.
   */
  async orient(): Promise<void> {
    if (this.memory) {
      try {
        // Recall memories relevant to the current task or goal.
        const taskHint = this.state.currentTask?.title ?? this.state.goal;
        const memories = await this.memory.recall({
          query: taskHint,
          project: this.state.context.project,
          limit: 10,
        });
        // Stash for the context builder (passed via build()).
        this.state.recentMemories = memories;

        // ── v2: report memory accesses to the tier manager. ──
        const tierManager = this.memoryCompressor?.tierManager;
        if (tierManager) {
          const now = Date.now();
          for (const m of memories) {
            try {
              tierManager.observe({
                memoryId: m.item.id,
                tier: m.tier,
                accessedAt: now,
                sessionId: this.sessionId,
                outcome: 'neutral',
              });
            } catch {
              // Observation failures are non-fatal — never abort a
              // session because the tier manager choked on an event.
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void msg;
      }
    }
    this.emit('orient', {
      iteration: this.state.iterationCount,
      state: this.state,
    });
  }

  /**
   * Decide phase: select the next action via the LLM. Returns a `Decision`
   * that the `act()` phase will execute. If no provider is configured,
   * returns an ABORT decision (the loop can't run without an LLM).
   *
   * The decision is parsed from the provider's response via a structured
   * JSON schema (the system prompt instructs the model to emit a Decision-
   * shaped JSON object).
   */
  async decide(): Promise<Decision> {
    if (!this.provider) {
      return {
        type: 'ABORT',
        reason: 'No provider configured — agent cannot decide.',
      };
    }

    // Build the LLM request via the ContextBuilder if available.
    let request: LLMRequest;
    let tokens: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    if (this.contextBuilder) {
      const memories = (this.state.recentMemories ?? []) as ReadonlyArray<ScoredMemoryItem>;
      const built = await this.contextBuilder.build(
        this.state,
        {
          totalBudget: this.config.agent.defaultTokenBudget,
          tools: this.toolRegistry?.list({ enabledOnly: true }).map((e) => ({
            type: 'function' as const,
            function: {
              name: e.tool.name,
              description: e.tool.description,
              parameters: schemaToJsonSchema(e.tool.inputSchema),
            },
          })),
        },
        memories,
      );
      request = built.request;
    } else {
      // No context builder — minimal request.
      request = {
        messages: [
          { role: 'system', content: this.systemPrompt },
          ...this.state.messages,
          {
            role: 'user',
            content: this.state.currentTask
              ? `Continue task: ${this.state.currentTask.title}`
              : 'Continue toward the goal.',
          },
        ],
        maxTokens: 4096,
        temperature: 0.1,
        tools: this.toolRegistry?.list({ enabledOnly: true }).map((e) => ({
          type: 'function' as const,
          function: {
            name: e.tool.name,
            description: e.tool.description,
            parameters: schemaToJsonSchema(e.tool.inputSchema),
          },
        })),
      };
    }

    try {
      // ── Hook: llm:before (can modify or veto the request). ──
      let llmRequest: LLMRequest = request;
      if (this.hookManager) {
        const hookCtx = await this.hookManager.emit('llm:before', {
          llmRequest,
          agentState: this.state,
        });
        if (hookCtx.vetoed) {
          return {
            type: 'ABORT',
            reason: 'LLM call vetoed by hook.',
          };
        }
        if (hookCtx.llmRequest) {
          llmRequest = hookCtx.llmRequest;
        }
      }

      let response = await this.provider.chat(llmRequest);

      // ── Hook: llm:after (can modify the response). ──
      if (this.hookManager) {
        const hookCtx = await this.hookManager.emit('llm:after', {
          llmRequest,
          llmResponse: response,
          agentState: this.state,
        });
        if (hookCtx.llmResponse) {
          response = hookCtx.llmResponse;
        }
      }

      tokens = response.usage;
      this.state.totalTokens = {
        inputTokens: this.state.totalTokens.inputTokens + tokens.inputTokens,
        outputTokens: this.state.totalTokens.outputTokens + tokens.outputTokens,
      };
      this.state.worldModel.totalTokens = { ...this.state.totalTokens };
      this.state.lastReasoning = response.content.slice(0, 200);

      // ── Record cost (opt-in via RunContext.costTracker). ──
      this.recordCost(response);

      // Append the assistant message to history.
      this.state.messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      });

      // Parse the decision.
      const decision = this.parseDecision(response);
      return decision;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type: 'ABORT',
        reason: `Provider error: ${msg}`,
      };
    }
  }

  /**
   * Act phase: execute the decision. For TOOL_CALL, dispatches to the tool
   * registry; for LLM_COMPLETION, records the message; for the other types,
   * the run() loop handles them inline (this method is only called for
   * TOOL_CALL and LLM_COMPLETION).
   *
   * ## V4 state-tracker wiring
   *
   * When a {@link ConversationStateTracker} is resolved (via
   * {@link resolveStateTracker}), `act()` calls
   * `stateTracker.observe(assistantMessage, toolResult)` after each
   * tool execution so the tracker can update its state machine
   * (current phase, errors, tool stats, ...). The tracker is also
   * notified of the tool call itself via `observeToolCall(name,
   * success)` so the per-tool usage stats populate.
   *
   * Tracker failures are swallowed (non-fatal) — the loop must never
   * abort because the state tracker choked on a message.
   *
   * @returns A `TaskResult` for TOOL_CALL decisions; undefined otherwise.
   */
  async act(decision: Decision): Promise<TaskResult | undefined> {
    if (decision.type === 'TOOL_CALL') {
      if (!this.toolRegistry) {
        this.recordAction(decision, { inputTokens: 0, outputTokens: 0 }, 'No tool registry.');
        return undefined;
      }
      const startedAt = Date.now();
      const toolResult = await this.toolRegistry.execute(
        decision.toolName,
        decision.arguments,
        this.state.context.toolContext,
      );
      const durationMs = Date.now() - startedAt;
      // Update world model.
      this.state.worldModel.toolCallCounts[decision.toolName] =
        (this.state.worldModel.toolCallCounts[decision.toolName] ?? 0) + 1;
      if (!toolResult.success && toolResult.error) {
        // Record the error.
        this.recordAction(decision, { inputTokens: 0, outputTokens: 0 }, toolResult.error);
      } else {
        this.recordAction(decision, { inputTokens: 0, outputTokens: 0 });
      }
      // Append the tool result to history.
      this.state.messages.push({
        role: 'tool',
        content: toolResult.success
          ? this.toolRegistry.get(decision.toolName)?.formatForContext(toolResult.output) ??
            JSON.stringify(toolResult.output)
          : `Error: ${toolResult.error}`,
        tool_call_id: decision.toolCallId,
      });

      // ── V4: Observe the assistant message + tool result so the
      // conversation state tracker can update its state machine. ──
      this.observeStateTracker(decision, toolResult.success, toolResult.error);

      const taskResult: TaskResult = {
        taskId: this.state.currentTask?.id ?? 'inline',
        success: toolResult.success,
        toolResults: [toolResult],
        tokensUsed: { inputTokens: 0, outputTokens: toolResult.tokensUsed },
        attempts: 1,
        error: toolResult.error,
        summary: `${toolResult.success ? 'OK' : 'FAIL'} ${decision.toolName} (${durationMs}ms)`,
      };
      return taskResult;
    }

    if (decision.type === 'LLM_COMPLETION') {
      // The assistant message is already in history (added by decide()).
      this.recordAction(decision, { inputTokens: 0, outputTokens: 0 });
      // ── V4: Observe the assistant message (no tool result) so the
      // tracker can pick up phase transitions (e.g. "Done" → complete). ──
      this.observeStateTracker(decision);
      return undefined;
    }

    // Other decision types are handled by run() (not act()).
    return undefined;
  }

  /**
   * V4: Resolve the conversation state tracker for the current run.
   * Prefers {@link RunContext.stateTracker} (per-run), falls back to
   * the constructor {@link AgentLoopOptions.stateTracker}. Returns
   * `undefined` when neither is set (the loop runs without state
   * tracking — identical to pre-V4 behavior).
   */
  private resolveStateTracker(): ConversationStateTracker | undefined {
    return this.state?.context?.stateTracker ?? this.stateTrackerFromOpts;
  }

  /**
   * V4: Observe the most recent assistant message (and optional tool
   * result) on the conversation state tracker. Called from {@link act}
   * after each TOOL_CALL or LLM_COMPLETION decision. Swallows all
   * tracker errors — the loop must never abort because the tracker
   * choked on a message.
   *
   * @param decision - The decision that was just acted on. Used to
   *   extract the tool name (for `observeToolCall`) when the decision
   *   is a TOOL_CALL.
   * @param toolSuccess - Whether the tool call succeeded (only for
   *   TOOL_CALL decisions).
   * @param toolError - Optional tool error message (only for TOOL_CALL
   *   decisions).
   */
  private observeStateTracker(
    decision: Decision,
    toolSuccess?: boolean,
    toolError?: string,
  ): void {
    const tracker = this.resolveStateTracker();
    if (!tracker) return;
    try {
      // Find the most recent assistant message in history (added by
      // decide() just before act() was called).
      const lastAssistant = [...this.state.messages]
        .reverse()
        .find((m) => m.role === 'assistant');
      if (lastAssistant) {
        // For TOOL_CALL decisions, fabricate a minimal tool-result
        // shape so the tracker's heuristics can record errors. The
        // tracker only reads `success` + `error` (its
        // `ObservedToolResult` type), so we don't need the full
        // `ToolResult<T>` shape.
        if (decision.type === 'TOOL_CALL') {
          const observedToolResult = {
            success: toolSuccess ?? false,
            error: toolError,
          };
          tracker.observe(lastAssistant, observedToolResult);
          // Also record the tool-call stats (count + success rate).
          tracker.observeToolCall(decision.toolName, toolSuccess ?? false);
        } else {
          // LLM_COMPLETION: just observe the message (no tool result).
          tracker.observe(lastAssistant);
        }
      }
    } catch {
      // Tracker failures must not crash the loop.
    }
  }

  /**
   * Build the final `AgentResult` from the current state. Called after the
   * loop terminates.
   */
  buildResult(): AgentResult {
    const success = this.state.isComplete && !this.state.isAborted;
    const lastComplete = [...this.state.actions]
      .reverse()
      .find((a) => a.decision.type === 'COMPLETE');
    const summary =
      lastComplete && lastComplete.decision.type === 'COMPLETE'
        ? lastComplete.decision.summary
        : this.state.abortReason ?? 'Agent finished without a COMPLETE decision.';
    return {
      success,
      summary,
      iterations: this.state.iterationCount,
      totalTokens: this.state.totalTokens,
      finalState: this.state,
      actions: this.state.actions,
      modifiedFiles: this.state.worldModel.modifiedFiles,
      lessonsLearned: this.state.worldModel.lessonsLearned,
      abortReason: this.state.abortReason,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Record an action in the agent's structured history.
   */
  private recordAction(
    decision: Decision,
    tokens: TokenUsage,
    error?: string,
  ): void {
    const now = new Date().toISOString();
    const action: ActionRecord = {
      iteration: this.state.iterationCount,
      startedAt: now,
      endedAt: now,
      decision,
      tokens,
      error,
    };
    this.state.actions.push(action);
  }

  /**
   * Generate a unique session id for cost-tracking grouping. Uses nanoid
   * for collision-resistance across concurrent agent runs.
   */
  private generateSessionId(): string {
    return `sess-${nanoid(12)}`;
  }

  /**
   * Record a cost entry for an LLM call. Computes the USD cost from the
   * response usage + pricing table, pushes the entry to the
   * {@link CostTracker}, bumps the running cumulative cost, and emits a
   * `cost:recorded` event. Also fires the `cost:recorded` hook when a
   * {@link HookManager} is wired.
   *
   * No-op when no CostTracker is configured (the common case for tests
   * and local-provider runs).
   */
  private recordCost(response: LLMResponse): void {
    if (!this.costTracker || !this.provider) return;

    const providerId = this.provider.id;
    const costUsd = computeCost(providerId, response.usage);
    // Surface the computed cost back onto the response so downstream
    // consumers (hooks, TUI, telemetry) can read it without recomputing.
    response.costUsd = costUsd;
    const entry: CostEntry = {
      timestamp: Date.now(),
      providerId,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheCreationTokens: response.usage.cacheCreationTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      cachedTokens: response.usage.cachedTokens,
      costUsd,
      taskId: this.state.currentTask?.id,
      sessionId: this.sessionId,
    };
    this.costTracker.record(entry);
    this.cumulativeCostUsd = Math.round(
      (this.cumulativeCostUsd + costUsd) * 1_000_000,
    ) / 1_000_000;

    this.emit('cost:recorded', {
      iteration: this.state.iterationCount,
      entry,
      cumulativeCostUsd: this.cumulativeCostUsd,
    });

    // Best-effort persist: each entry is one append line, safe across
    // concurrent processes. Failures are non-fatal (we still have the
    // in-memory entry for the session summary).
    void this.costTracker.persist().catch(() => {
      // swallow — persist is best-effort
    });

    // Also fire the hook-manager `cost:recorded` event for external
    // subscribers (e.g. CLI status bar). Best-effort: hook failures don't
    // affect the loop.
    if (this.hookManager) {
      void this.hookManager
        .emit('cost:recorded', {
          agentState: this.state,
          costEntry: entry,
        })
        .catch(() => {
          // swallow — hook failures are non-fatal
        });
    }
  }

  /**
   * Parse a `Decision` from the LLM response. The model is instructed (via
   * the system prompt) to emit either a tool call (handled by the provider
   * natively) or a JSON object describing the decision.
   *
   * If the response contains tool calls, we emit a TOOL_CALL decision.
   * Otherwise we parse the JSON object; on failure we default to
   * LLM_COMPLETION with the raw content.
   */
  private parseDecision(response: {
    content: string;
    toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  }): Decision {
    // Native tool calls → TOOL_CALL decisions (pick the first; subsequent
    // calls would be handled in following iterations).
    if (response.toolCalls && response.toolCalls.length > 0) {
      const tc = response.toolCalls[0]!;
      return {
        type: 'TOOL_CALL',
        toolCallId: tc.id,
        toolName: tc.function.name,
        arguments: tc.function.arguments,
        reasoning: response.content.slice(0, 200),
      };
    }

    // Try to parse a Decision JSON from the content.
    const jsonText = extractJson(response.content);
    if (jsonText) {
      try {
        const raw = JSON.parse(jsonText) as unknown;
        const decision = validateDecision(raw);
        if (decision) return decision;
      } catch {
        // fall through
      }
    }

    // Default: treat the raw content as an LLM completion.
    return {
      type: 'LLM_COMPLETION',
      content: response.content,
    };
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Extract the first JSON object from a model response. Strips ``` fences
 * and finds the first brace-matched block.
 */
function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Validate a parsed JSON object as a `Decision`. Returns the typed decision
 * or null if the shape doesn't match any known decision type.
 */
function validateDecision(raw: unknown): Decision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case 'TOOL_CALL': {
      if (
        typeof r.toolCallId === 'string' &&
        typeof r.toolName === 'string' &&
        typeof r.arguments === 'string'
      ) {
        return {
          type: 'TOOL_CALL',
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          arguments: r.arguments,
          reasoning: typeof r.reasoning === 'string' ? r.reasoning : undefined,
        };
      }
      return null;
    }
    case 'LLM_COMPLETION': {
      if (typeof r.content === 'string') {
        return {
          type: 'LLM_COMPLETION',
          content: r.content,
          reasoning: typeof r.reasoning === 'string' ? r.reasoning : undefined,
        };
      }
      return null;
    }
    case 'SPAWN_SUBAGENT': {
      if (typeof r.subTask === 'object' && r.subTask !== null) {
        const st = r.subTask as Record<string, unknown>;
        const taskType: TaskType = isValidTaskType(st.type) ? st.type : 'think';
        return {
          type: 'SPAWN_SUBAGENT',
          subTask: {
            id: typeof st.id === 'string' ? st.id : Math.random().toString(36).slice(2),
            title: typeof st.title === 'string' ? st.title : 'sub-task',
            description: typeof st.description === 'string' ? st.description : '',
            type: taskType,
            tools: Array.isArray(st.tools) ? st.tools.filter((s): s is string => typeof s === 'string') : [],
            tokenBudget: typeof st.tokenBudget === 'number' ? st.tokenBudget : 4096,
            parentContextSummary: typeof st.parentContextSummary === 'string' ? st.parentContextSummary : undefined,
          },
          reasoning: typeof r.reasoning === 'string' ? r.reasoning : undefined,
        };
      }
      return null;
    }
    case 'COMPLETE': {
      if (typeof r.summary === 'string' && typeof r.success === 'boolean') {
        return {
          type: 'COMPLETE',
          summary: r.summary,
          success: r.success,
          reasoning: typeof r.reasoning === 'string' ? r.reasoning : undefined,
        };
      }
      return null;
    }
    case 'ABORT': {
      if (typeof r.reason === 'string') {
        return {
          type: 'ABORT',
          reason: r.reason,
          reasoning: typeof r.reasoning === 'string' ? r.reasoning : undefined,
        };
      }
      return null;
    }
    case 'ASK_USER': {
      if (typeof r.question === 'string') {
        return {
          type: 'ASK_USER',
          question: r.question,
          choices: Array.isArray(r.choices)
            ? r.choices.filter((s): s is string => typeof s === 'string')
            : undefined,
          reasoning: typeof r.reasoning === 'string' ? r.reasoning : undefined,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Type guard for valid task-type strings (used by validateDecision when
 * parsing SPAWN_SUBAGENT payloads).
 */
function isValidTaskType(t: unknown): t is TaskType {
  return (
    t === 'research' ||
    t === 'code_write' ||
    t === 'code_edit' ||
    t === 'test' ||
    t === 'shell' ||
    t === 'review' ||
    t === 'think'
  );
}

/**
 * Convert a Zod schema to a JSON-Schema object for the LLM tool definition.
 * Uses the same minimal converter approach as Planner.zodToJsonSchema.
 *
 * **Defensive (Task V13-2):** every `_def` access is guarded so a malformed
 * tool schema (e.g. a `ZodArray` whose `element` was somehow dropped, or a
 * `ZodOptional` whose `innerType` is `undefined`) degrades to a generic
 * `{ type: 'object' }` instead of crashing the agent loop on iteration 0.
 * Without this, the very first `decide()` throws "Cannot read properties of
 * undefined (reading '_def')" and `sanix run` aborts before the LLM is even
 * called.
 */
function schemaToJsonSchema(schema: unknown): object {
  if (typeof schema !== 'object' || schema === null) return { type: 'object' };
  const def = (schema as { _def?: Record<string, unknown> })._def;
  if (!def) return { type: 'object' };
  return convertDef(def) as object;
}

function convertDef(def: Record<string, unknown>): Record<string, unknown> {
  const typeName = def.typeName as string | undefined;
  switch (typeName) {
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, unknown>)();
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(shape)) {
        // Guard against undefined / null property schemas (some tools
        // register a shape with `undefined` placeholders).
        if (v === undefined || v === null) continue;
        const vDef = (v as { _def?: Record<string, unknown> })._def;
        if (vDef) properties[k] = convertDef(vDef);
      }
      return { type: 'object', properties, additionalProperties: false };
    }
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray': {
      // Guard against `def.element` being undefined (a malformed
      // ZodArray) — the previous code would throw
      // "Cannot read properties of undefined (reading '_def')".
      const elementSchema = def.element as
        | { _def?: Record<string, unknown> }
        | undefined;
      const element = elementSchema?._def;
      return { type: 'array', items: element ? convertDef(element) : {} };
    }
    case 'ZodEnum': {
      const values = (def.values as string[]) ?? [];
      return { type: 'string', enum: values };
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault': {
      // All three Zod wrappers expose `innerType`. Guard against it
      // being undefined.
      const innerSchema = def.innerType as
        | { _def?: Record<string, unknown> }
        | undefined;
      const inner = innerSchema?._def;
      return inner ? convertDef(inner) : {};
    }
    default:
      return { type: 'object' };
  }
}

/**
 * Derive a basic cost summary from agent state. Used by the auto-checkpoint
 * code path to populate {@link Checkpoint.costSummary} without a dedicated
 * CostTracker instance. Token totals are captured; monetary cost is left at
 * 0 — callers needing accurate costs should construct a real CostSummary
 * from their CostTracker and save it via the CheckpointManager directly.
 */
function deriveCostSummary(state: AgentState): import('../cost/CostTracker.js').CostSummary {
  return {
    totalCostUsd: 0,
    totalInputTokens: state.totalTokens.inputTokens,
    totalOutputTokens: state.totalTokens.outputTokens,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    savedFromCachingUsd: 0,
    byProvider: {},
    bySession: {},
  };
}

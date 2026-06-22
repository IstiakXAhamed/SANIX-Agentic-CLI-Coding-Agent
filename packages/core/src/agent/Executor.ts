/**
 * @file agent/Executor.ts
 * @description Task execution runtime. Dispatches `TaskNode`s to either
 * the tool registry (for tool-based tasks) or the SubAgentManager (for
 * delegatable tasks). Tracks retries (max 2 per task per spec §2) and
 * triggers replan on failure.
 *
 * The executor is called by the AgentLoop's `act()` phase for each task in
 * the plan graph (respecting dependencies).
 *
 * @packageDocumentation
 */

import type { IProvider, LLMRequest, LLMResponse, TokenUsage } from '@sanix/providers';
import type { SanixConfig } from '@sanix/config';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { ToolContext } from '../tools/interfaces.js';
import type { TaskNode, TaskResult, AgentState } from './types.js';
import type { SubAgentManager } from './SubAgentManager.js';
import type { HookManager } from '../hooks/HookManager.js';

/**
 * Options for {@link Executor.constructor}.
 */
export interface ExecutorOptions {
  /** The provider to use for non-tool tasks (think / review). */
  provider?: IProvider;
  /** Max retries per task. Default 2 (per spec §2: "If a task fails 2x, replan"). */
  maxRetries?: number;
  /** The sub-agent manager (for delegatable tasks). */
  subAgentManager?: SubAgentManager;
  /**
   * Optional hook manager. When set, the executor emits `llm:before` /
   * `llm:after` hooks around its own LLM calls (the pure-LLM task path).
   * Opt-in.
   */
  hookManager?: HookManager;
}

/**
 * Task execution runtime.
 *
 * @example
 * ```ts
 * const executor = new Executor(config, { toolRegistry, provider, subAgentManager });
 * const result = await executor.executeTask(task, state);
 * if (!result.success && result.attempts > 2) {
 *   // trigger replan
 * }
 * ```
 */
export class Executor {
  private readonly config: SanixConfig;
  private readonly toolRegistry: ToolRegistry | undefined;
  private readonly provider: IProvider | undefined;
  private readonly subAgentManager: SubAgentManager | undefined;
  private readonly maxRetries: number;
  /** Optional hook manager (used for llm:before / llm:around on pure-LLM tasks). */
  private hookManager: HookManager | undefined;

  constructor(
    config: SanixConfig,
    toolRegistry: ToolRegistry | undefined,
    opts: ExecutorOptions = {},
  ) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.provider = opts.provider;
    this.subAgentManager = opts.subAgentManager;
    this.maxRetries = opts.maxRetries ?? 2;
    this.hookManager = opts.hookManager;
  }

  /**
   * Attach a {@link HookManager}. The executor will emit `llm:before` /
   * `llm:after` hooks around its own LLM calls (the pure-LLM task path).
   */
  setHookManager(hm: HookManager | undefined): void {
    this.hookManager = hm;
  }

  /**
   * Execute a task. Dispatches based on task type:
   *   - `think` / `review` → straight LLM call (no tools).
   *   - `research` → LLM call with read-only tools.
   *   - `code_write` / `code_edit` / `test` / `shell` → tool-driven (the
   *     agent's `decide()` phase drives the actual tool calls; the executor
   *     just runs the task's lifecycle and retries on failure).
   *
   * Tasks with `canDelegate=true` may be handed to the SubAgentManager
   * instead of being executed inline (the caller decides).
   *
   * @param task - The task to execute.
   * @param state - The current agent state (for context, toolContext, etc.).
   * @returns A `TaskResult` with success/failure, tool results, and token usage.
   */
  async executeTask(task: TaskNode, state: AgentState): Promise<TaskResult> {
    let attempts = 0;
    let lastError: string | undefined;
    const allToolResults: TaskResult['toolResults'] = [];
    let totalTokens: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let llmResponse: LLMResponse | undefined;

    while (attempts <= this.maxRetries) {
      attempts++;
      task.status = 'in_flight';
      task.attempts = attempts;

      try {
        const result = await this.dispatchOnce(task, state);
        allToolResults.push(...result.toolResults);
        totalTokens = {
          inputTokens: totalTokens.inputTokens + result.tokensUsed.inputTokens,
          outputTokens: totalTokens.outputTokens + result.tokensUsed.outputTokens,
        };
        if (result.llmResponse) llmResponse = result.llmResponse;

        if (result.success) {
          task.status = 'completed';
          task.lastError = undefined;
          return {
            taskId: task.id,
            success: true,
            toolResults: allToolResults,
            tokensUsed: totalTokens,
            attempts,
            llmResponse,
            summary: result.summary,
          };
        }
        lastError = result.error;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      // Retry with a brief backoff (200ms * attempts).
      if (attempts <= this.maxRetries) {
        await sleep(200 * attempts);
      }
    }

    task.status = 'failed';
    task.lastError = lastError;
    return {
      taskId: task.id,
      success: false,
      toolResults: allToolResults,
      tokensUsed: totalTokens,
      attempts,
      llmResponse,
      error: lastError ?? 'Unknown error',
      summary: `Task failed after ${attempts} attempt(s): ${lastError ?? 'unknown'}`,
    };
  }

  /**
   * Execute one attempt of the task. Internal — callers use {@link executeTask}.
   */
  private async dispatchOnce(
    task: TaskNode,
    state: AgentState,
  ): Promise<Omit<TaskResult, 'taskId' | 'attempts'>> {
    const ctx: ToolContext = {
      config: this.config,
      cwd: state.context.cwd,
      signal: state.context.signal,
      allowedPermissions: state.context.toolContext.allowedPermissions,
      project: state.context.project,
      log: state.context.toolContext.log,
      metadata: { taskId: task.id, ...state.context.toolContext.metadata },
    };

    // ── Delegate to sub-agent if the task is delegatable. ──
    if (task.canDelegate && this.subAgentManager && task.tools.length > 0) {
      const handle = await this.subAgentManager.spawn(
        {
          id: task.id,
          title: task.title,
          description: task.description,
          type: task.type,
          tools: task.tools,
          tokenBudget: task.tokenBudget,
        },
        state.context,
      );
      const result = await handle.result;
      return {
        success: result.success,
        toolResults: [],
        tokensUsed: result.tokensUsed,
        summary: result.summary,
        error: result.error,
      };
    }

    // ── Tool-driven tasks: the agent's decide() phase drives individual ──
    // ── tool calls; the executor just confirms the task type and yields ──
    // ── a no-op "ready" result. The actual tool calls happen in the     ──
    // ── AgentLoop's act() phase via the ToolRegistry.                   ──
    if (this.toolRegistry && task.tools.length > 0) {
      // Verify all required tools are registered.
      const missing = task.tools.filter((t) => !this.toolRegistry!.get(t));
      if (missing.length > 0) {
        return {
          success: false,
          toolResults: [],
          tokensUsed: { inputTokens: 0, outputTokens: 0 },
          error: `Required tools not registered: ${missing.join(', ')}`,
          summary: `Task ${task.id} could not start — missing tools.`,
        };
      }
      // Yield a "ready" result; the AgentLoop will run the tool calls.
      return {
        success: true,
        toolResults: [],
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        summary: `Task ${task.id} ready for tool execution (tools: ${task.tools.join(', ')}).`,
      };
    }

    // ── Pure-LLM tasks (think / review). ──
    if (!this.provider) {
      return {
        success: false,
        toolResults: [],
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        error: 'No provider available for LLM task',
        summary: `Task ${task.id} could not run — no provider.`,
      };
    }

    try {
      let llmRequest: LLMRequest = {
        messages: [
          {
            role: 'system',
            content: `You are SANIX. Complete the following task:\n${task.description}`,
          },
          { role: 'user', content: state.goal },
        ],
        maxTokens: task.tokenBudget,
        temperature: 0.1,
        taskType: task.type === 'review' ? 'reasoning' : 'general',
      };

      // ── Hook: llm:before (can modify or veto the request). ──
      if (this.hookManager) {
        const hookCtx = await this.hookManager.emit('llm:before', {
          llmRequest,
          agentState: state,
        });
        if (hookCtx.vetoed) {
          return {
            success: false,
            toolResults: [],
            tokensUsed: { inputTokens: 0, outputTokens: 0 },
            error: 'LLM call vetoed by hook',
            summary: `Task ${task.id} vetoed by llm:before hook.`,
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
          agentState: state,
        });
        if (hookCtx.llmResponse) {
          response = hookCtx.llmResponse;
        }
      }

      return {
        success: true,
        toolResults: [],
        tokensUsed: response.usage,
        llmResponse: response,
        summary: response.content.slice(0, 200),
      };
    } catch (err) {
      return {
        success: false,
        toolResults: [],
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        error: err instanceof Error ? err.message : String(err),
        summary: `Task ${task.id} LLM call failed.`,
      };
    }
  }

  /**
   * Find the next executable task in the plan (pending, with all
   * dependencies completed). Returns null if no task is ready.
   *
   * @example
   * ```ts
   * const next = executor.nextExecutableTask(state.plan, state.worldModel.completedTaskIds);
   * if (next) await executor.executeTask(next, state);
   * ```
   */
  nextExecutableTask(
    plan: AgentState['plan'],
    completedTaskIds: ReadonlyArray<string>,
  ): TaskNode | null {
    const completed = new Set(completedTaskIds);
    for (const task of plan.tasks) {
      if (task.status !== 'pending') continue;
      const depsOk = task.dependencies.every((d) => completed.has(d));
      if (depsOk) return task;
    }
    return null;
  }

  /**
   * Check if all tasks in the plan are terminal (completed or failed).
   * Used by the AgentLoop to decide when to stop iterating.
   */
  isPlanTerminal(plan: AgentState['plan']): boolean {
    return plan.tasks.every((t) => t.status === 'completed' || t.status === 'failed');
  }

  /**
   * Check if all *required* tasks (i.e. all tasks, since SANIX doesn't yet
   * support optional tasks) have completed successfully.
   */
  isPlanSatisfied(plan: AgentState['plan']): boolean {
    return plan.tasks.length > 0 && plan.tasks.every((t) => t.status === 'completed');
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

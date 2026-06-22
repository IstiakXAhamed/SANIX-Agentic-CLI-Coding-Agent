/**
 * @file tui-adapter.ts
 * @description Typed bridge between the CLI's AgentLoop and the @sanix/tui
 * Ink-based renderer.
 *
 * The TUI package (Task 5) exports three symbols:
 *
 *   - `renderApp(state, opts)` → returns `{ mode, instance?, text? }`. When
 *     stdout is a TTY, mounts the Ink TUI and returns the instance (used
 *     for live updates via `instance.rerender(...)`). Otherwise returns
 *     the chalk-rendered text.
 *   - `renderNonTui(state, opts)` → returns a chalk-rendered string
 *     snapshot (used for one-shot / CI rendering).
 *   - `sanixTheme` → the SANIX brand theme (colors + spacing).
 *
 * The CLI uses `renderApp` for live TUI mode (TTY only). For non-TUI
 * mode, the CLI falls back to its own built-in streaming renderer in
 * `run-helpers.ts` (the TUI's `renderNonTui` is one-shot, not streaming,
 * so it's only useful for a final snapshot — which the CLI's
 * `renderResult` already covers).
 *
 * @packageDocumentation
 */

import * as React from 'react';
import * as tuiModule from '@sanix/tui';
import type { AgentLoop, AgentState, AgentResult, RunContext, ToolPermission } from '@sanix/core';
import type { SubAgentManager } from '@sanix/core';
import type { SanixContext } from './bootstrap.js';

/**
 * The CLI's expected TUI API surface. Cast from the actual `@sanix/tui`
 * module via `unknown` (type-safe; no `any`).
 */
export interface TuiApi {
  /** Render the agent state — TTY → Ink, else chalk snapshot. */
  renderApp: (
    state: unknown,
    opts?: {
      forceTui?: boolean;
      forceNonTui?: boolean;
      color?: boolean;
      onQuit?: () => void;
      onPause?: () => void;
      onSkip?: () => void;
      onMemory?: () => void;
      onInteractive?: () => void;
    },
  ) => {
    mode: 'tui' | 'nontui';
    instance?: { rerender: (el: React.ReactElement) => void; unmount: () => void };
    text?: string;
  };
  /** Always-non-TUI snapshot renderer. */
  renderNonTui: (state: unknown, opts?: { color?: boolean }) => string;
  /** The SANIX brand theme. */
  sanixTheme: unknown;
}

/**
 * The resolved TUI API. We import the entire `@sanix/tui` module and cast
 * it to {@link TuiApi} via `unknown`. If `@sanix/tui` doesn't yet export
 * these symbols, the values will be `undefined` and the CLI gracefully
 * falls back to its built-in plain-text renderer.
 */
const tui = tuiModule as unknown as Partial<TuiApi>;

/** True when `@sanix/tui` exports both `renderApp` and `renderNonTui`. */
export function tuiAvailable(): boolean {
  return (
    typeof tui.renderApp === 'function' &&
    typeof tui.renderNonTui === 'function'
  );
}

/** The SANIX brand theme from `@sanix/tui` (or `null` if unavailable). */
export function getSanixTheme(): unknown {
  return tui.sanixTheme ?? null;
}

/**
 * A snapshot view of the agent state, shaped to match the TUI's
 * `AgentStateView`. We build this on every AgentLoop event so the TUI
 * can re-render with fresh data.
 *
 * The fields are deliberately permissive (lots of optional / defaults)
 * because not every field on the core `AgentState` maps 1:1 to the TUI's
 * view model — we synthesize sensible defaults for the gaps.
 */
export interface CliAgentStateView {
  readonly provider: string;
  readonly latencyMs: number;
  readonly goal: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly plan: readonly CliTaskNodeView[];
  readonly tokenUsed: number;
  readonly tokenTotal: number;
  readonly memoryFacts: readonly CliMemoryFactView[];
  readonly subAgents: readonly CliSubAgentView[];
  readonly currentTool?: CliToolCallView;
  readonly messages: readonly CliMessageView[];
  readonly paused: boolean;
}

/** Task node view (mirrors the TUI's TaskNodeView). */
export interface CliTaskNodeView {
  readonly id: string;
  readonly title: string;
  readonly status: 'done' | 'active' | 'pending' | 'failed';
  readonly detail?: string;
}

/** Tool call view (mirrors the TUI's ToolCallView). */
export interface CliToolCallView {
  readonly toolName: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly diff?: string;
  readonly durationMs?: number;
  readonly status: 'running' | 'success' | 'error';
}

/** Sub-agent view (mirrors the TUI's SubAgentView). */
export interface CliSubAgentView {
  readonly id: string;
  readonly task: string;
  readonly status: 'running' | 'complete' | 'failed';
  readonly progress?: number;
}

/** Memory fact view (mirrors the TUI's MemoryFactView). */
export interface CliMemoryFactView {
  readonly id: string;
  readonly content: string;
  readonly score: number;
}

/** Message view (mirrors the TUI's MessageView). */
export interface CliMessageView {
  readonly role: 'agent' | 'user' | 'system' | 'assistant';
  readonly content: string;
  readonly ts?: number;
}

/**
 * Convert a core `AgentState` into a {@link CliAgentStateView} the TUI can
 * render. Synthesizes sensible defaults for fields the core state doesn't
 * directly carry (e.g. `latencyMs`).
 *
 * @param state      - The core agent state.
 * @param ctx        - The wired SANIX context.
 * @param subAgents  - Live sub-agent statuses (Task A4 / Part 1). Defaults
 *                     to an empty array (no sub-agents in flight).
 */
export function stateToView(
  state: AgentState,
  ctx: SanixContext,
  subAgents: readonly CliSubAgentView[] = [],
): CliAgentStateView {
  const plan: CliTaskNodeView[] = state.plan.tasks.map((t) => {
    const statusMap: Record<string, CliTaskNodeView['status']> = {
      pending: 'pending',
      in_flight: 'active',
      completed: 'done',
      failed: 'failed',
    };
    return {
      id: t.id,
      title: t.title,
      status: statusMap[t.status] ?? 'pending',
      detail: t.lastError ? `error: ${t.lastError}` : undefined,
    };
  });

  const messages: CliMessageView[] = state.messages.map((m) => ({
    role: m.role === 'tool' ? 'system' : (m.role as CliMessageView['role']),
    content: m.content,
  }));

  // recentMemories is typed as `unknown[]` in the core state; narrow it.
  const memoryFacts: CliMemoryFactView[] = [];
  if (Array.isArray(state.recentMemories)) {
    for (const m of state.recentMemories) {
      if (typeof m === 'object' && m !== null) {
        const item = (m as { item?: { id?: string; content?: string }; score?: number }).item;
        const score = (m as { score?: number }).score;
        if (item && typeof item.content === 'string') {
          memoryFacts.push({
            id: typeof item.id === 'string' ? item.id : '',
            content: item.content,
            score: typeof score === 'number' ? score : 0,
          });
        }
      }
    }
  }

  // Current tool: most recent TOOL_CALL action.
  let currentTool: CliToolCallView | undefined;
  for (let i = state.actions.length - 1; i >= 0; i--) {
    const action = state.actions[i]!;
    if (action.decision.type === 'TOOL_CALL') {
      currentTool = {
        toolName: action.decision.toolName,
        status: action.error ? 'error' : 'success',
        durationMs: undefined,
      };
      break;
    }
  }

  return {
    provider: ctx.config.providers.default,
    latencyMs: 0,
    goal: state.goal,
    iteration: state.iterationCount,
    maxIterations: state.maxIterations,
    plan,
    tokenUsed: state.totalTokens.inputTokens + state.totalTokens.outputTokens,
    tokenTotal: ctx.config.agent.defaultTokenBudget,
    memoryFacts,
    subAgents: [...subAgents],
    currentTool,
    messages,
    paused: false,
  };
}

/** Options accepted by {@link runWithTui}. */
export interface RunWithTuiOptions {
  /** The wired SANIX context. */
  context: SanixContext;
  /** The user's high-level goal. */
  goal: string;
  /** The configured (but not-yet-running) agent loop. */
  loop: AgentLoop;
  /**
   * The sub-agent manager (Task A4 / Part 1). When provided, the TUI's
   * SubAgentTracker is populated from the manager's `spawn` / `complete`
   * events so the user sees live sub-agent progress.
   */
  subAgentManager?: SubAgentManager;
  /** Abort signal (used to wire the TUI's onQuit to loop cancellation). */
  signal: AbortSignal;
  /** Callback to invoke when the user hits 'q' in the TUI. */
  onQuit?: () => void;
}

/**
 * Run the agent loop with the Ink TUI mounted. Subscribes to AgentLoop
 * events; on each `iteration` event, rebuilds the state view and calls
 * `instance.rerender(...)` to update the TUI.
 *
 * If stdout is not a TTY (or `@sanix/tui` is unavailable), this function
 * throws so the caller can fall back to the plain-text renderer.
 *
 * @returns The final {@link AgentResult}.
 */
export async function runWithTui(opts: RunWithTuiOptions): Promise<AgentResult> {
  if (typeof tui.renderApp !== 'function') {
    throw new Error('@sanix/tui does not export renderApp.');
  }

  // ── Sub-agent tracking (Task A4 / Part 1). ──────────────────────────
  // Maintain a list of sub-agent statuses that we re-render into the TUI
  // on every change. The SubAgentManager emits `spawn` / `complete` /
  // `error` events; we mutate the list in response.
  const subAgents: CliSubAgentView[] = [];
  const subAgentManager = opts.subAgentManager;
  if (subAgentManager) {
    subAgentManager.on('spawn', ({ agentId, task }) => {
      subAgents.push({
        id: agentId,
        task: task.title,
        status: 'running',
      });
    });
    subAgentManager.on('complete', ({ report }) => {
      const entry = subAgents.find((s) => s.id === report.agentId);
      if (entry) {
        entry.status = report.result.success ? 'complete' : 'failed';
      }
    });
    subAgentManager.on('error', ({ agentId }) => {
      const entry = subAgents.find((s) => s.id === agentId);
      if (entry) {
        entry.status = 'failed';
      }
    });
  }

  // Build the initial state view (before the loop starts).
  const initialState = stateToView(
    {
      iterationCount: 0,
      maxIterations: opts.context.config.agent.maxIterations,
      isComplete: false,
      isAborted: false,
      goal: opts.goal,
      context: {
        config: opts.context.config,
        cwd: process.cwd(),
        toolContext: {
          config: opts.context.config,
          cwd: process.cwd(),
          allowedPermissions: [],
        },
      },
      plan: {
        goal: opts.goal,
        understanding: '',
        ambiguities: [],
        tasks: [],
        successCriteria: [],
        estimatedTokenBudget: opts.context.config.agent.defaultTokenBudget,
        recommendedProvider: opts.context.config.providers.default,
        parallelizable: false,
        createdAt: new Date().toISOString(),
      },
      worldModel: {
        goal: opts.goal,
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
      messages: [],
      actions: [],
      systemPrompt: '',
      fileContext: {},
      currentTask: null,
      totalTokens: { inputTokens: 0, outputTokens: 0 },
    } as AgentState,
    opts.context,
    subAgents,
  );

  // Mount the TUI. The TUI's renderApp returns `{ mode, instance?, text? }`.
  const renderResult = tui.renderApp(initialState as unknown, {
    onQuit: () => {
      opts.onQuit?.();
    },
  });

  if (renderResult.mode !== 'tui' || !renderResult.instance) {
    // Non-TTY: the TUI returned a chalk snapshot. Fall back to the
    // CLI's streaming plain-text renderer instead.
    throw new Error(
      'TUI renderApp returned non-tui mode — caller should use the plain-text renderer.',
    );
  }

  const instance = renderResult.instance;

  // Subscribe to AgentLoop events and re-render on each iteration.
  const updateFromState = (state: AgentState) => {
    try {
      const view = stateToView(state, opts.context, subAgents);
      // Build the new App element and re-render. We import App lazily so
      // the CLI doesn't pull in React/Ink at module-load time when the
      // TUI isn't being used.
      const App = (tuiModule as { App?: React.ComponentType<{ agentState: unknown; onQuit?: () => void }> }).App;
      if (App) {
        instance.rerender(
          React.createElement(App, {
            agentState: view as unknown,
            onQuit: opts.onQuit,
          }) as React.ReactElement,
        );
      }
    } catch {
      // Non-fatal — a render failure shouldn't kill the loop.
    }
  };

  opts.loop.on('observe', ({ state }) => updateFromState(state));
  opts.loop.on('iteration', () => {
    // The iteration event doesn't carry the state, but observe() already
    // fired with it. We re-render on observe for richer detail.
  });

  try {
    // Run the loop. We synthesize a minimal RunContext — the loop was
    // wired with ctx by the caller, so the runContext just carries the
    // signal + cwd + a permissive toolContext.
    const allowedPermissions: ToolPermission[] = [
      'file_read',
      'file_write',
      'shell_exec',
      'web_request',
      'memory_read',
      'memory_write',
      'subprocess_long',
      'mcp_call',
      'ask_user',
    ];
    const runContext: RunContext = {
      config: opts.context.config,
      cwd: process.cwd(),
      signal: opts.signal,
      toolContext: {
        config: opts.context.config,
        cwd: process.cwd(),
        allowedPermissions,
      },
    };
    const result = await opts.loop.run(opts.goal, runContext);
    instance.unmount();
    return result;
  } catch (err) {
    instance.unmount();
    throw err;
  }
}

/**
 * One-shot snapshot renderer: returns the TUI's chalk-rendered string for
 * the given state. Useful for printing a final state summary in non-TUI
 * mode (though the CLI's `renderResult` is the primary summary printer).
 */
export function renderStateSnapshot(
  state: AgentState,
  ctx: SanixContext,
  subAgents: readonly CliSubAgentView[] = [],
): string {
  if (typeof tui.renderNonTui !== 'function') {
    throw new Error('@sanix/tui does not export renderNonTui.');
  }
  const view = stateToView(state, ctx, subAgents);
  return tui.renderNonTui(view as unknown);
}

/**
 * @file View-model types shared between the TUI (Ink), the non-TUI
 * (chalk) renderer, and the SANIX core agent loop.
 *
 * These are deliberately plain (no methods, no class instances) so they
 * can be JSON-serialized for IPC to sub-agents and snapshot files.
 */

/** Lifecycle state of a single task in the plan graph. */
export type TaskStatus = 'done' | 'active' | 'pending' | 'failed';

/** Lifecycle state of a single tool invocation. */
export type ToolCallStatus = 'running' | 'success' | 'error';

/** Lifecycle state of a delegated sub-agent. */
export type SubAgentStatus = 'running' | 'complete' | 'failed';

/** Message sender role. `assistant` is treated as `agent` for display. */
export type MessageRole = 'agent' | 'user' | 'system' | 'assistant';

/**
 * A node in the plan task graph. May contain nested children to express
 * sub-task delegation within a single plan.
 */
export interface TaskNodeView {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  /** Optional status detail (e.g. `"3 files read"`, `"→ delegated to sub-agent #2"`). */
  readonly detail?: string;
  /** Optional child tasks rendered as a sub-tree. */
  readonly children?: readonly TaskNodeView[];
}

/** A single tool invocation rendered by {@link ToolCall}. */
export interface ToolCallView {
  readonly toolName: string;
  /** Arbitrary tool input — narrowed via `unknown` + runtime guards at the call site. */
  readonly input?: unknown;
  /** Arbitrary tool output — narrowed via `unknown` + runtime guards at the call site. */
  readonly output?: unknown;
  /** Unified diff string for filesystem edits. */
  readonly diff?: string;
  /** Wall-clock duration of the tool call in milliseconds. */
  readonly durationMs?: number;
  readonly status: ToolCallStatus;
}

/** A delegated sub-agent. */
export interface SubAgentView {
  readonly id: string;
  readonly task: string;
  readonly status: SubAgentStatus;
  /** Optional 0..1 progress fraction. */
  readonly progress?: number;
}

/** A single message in the agent <-> user <-> system stream. */
export interface MessageView {
  readonly role: MessageRole;
  readonly content: string;
  /** Optional epoch-millis timestamp. */
  readonly ts?: number;
}

/** A single recalled memory fact with relevance score. */
export interface MemoryFactView {
  readonly id: string;
  readonly content: string;
  /** 0..1 relevance score. */
  readonly score: number;
}

/**
 * Snapshot of the entire agent loop state — the single source of truth
 * consumed by both the Ink TUI and the non-TUI chalk renderer.
 */
export interface AgentStateView {
  /** Active provider id (e.g. `claude-sonnet-4`). */
  readonly provider: string;
  /** Last measured round-trip latency in milliseconds. */
  readonly latencyMs: number;
  /** User-supplied high-level goal. */
  readonly goal: string;
  /** Current iteration counter (1-indexed). */
  readonly iteration: number;
  /** Hard iteration cap. */
  readonly maxIterations: number;
  /** Root-level plan tasks. */
  readonly plan: readonly TaskNodeView[];
  /** Tokens consumed so far. */
  readonly tokenUsed: number;
  /** Token budget cap. */
  readonly tokenTotal: number;
  /** Currently-active recalled memory facts. */
  readonly memoryFacts: readonly MemoryFactView[];
  /** Live sub-agents. */
  readonly subAgents: readonly SubAgentView[];
  /** Currently-running tool call, if any. */
  readonly currentTool?: ToolCallView;
  /** Streaming message log (newest last). */
  readonly messages: readonly MessageView[];
  /** Whether the loop is paused. */
  readonly paused: boolean;
}

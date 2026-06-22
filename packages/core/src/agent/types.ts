/**
 * @file agent/types.ts
 * @description Core type system for the SANIX agent. Defines the OODA loop's
 * state machine, decision union, plan/task graph, world model, and sub-agent
 * reporting contracts. Every other module in `agent/` imports from here.
 *
 * @packageDocumentation
 */

import type { LLMMessage, LLMResponse, TokenUsage } from '@sanix/providers';
import type { SanixConfig } from '@sanix/config';
import type { ToolContext, ToolResult } from '../tools/interfaces.js';
import type { CostEntry, CostTracker } from '../cost/CostTracker.js';
// Type-only import to avoid a runtime cycle: CheckpointManager imports
// AgentState from this file, and RunContext references CheckpointManager.
import type { CheckpointManager } from '../checkpoint/CheckpointManager.js';
// Type-only import for V4 conversation state tracker integration.
// `@sanix/compressor` is declared as a dep in core's package.json; the
// type-only import is erased at compile time so there's no runtime
// cycle. The tracker instance is set at runtime by the caller (via
// `RunContext.stateTracker` or `AgentLoopOptions.stateTracker`).
import type { ConversationStateTracker } from '@sanix/compressor';

// ─── OODA loop state ────────────────────────────────────────────────────────

/**
 * A single entry in the agent's structured action history. Unlike raw
 * `LLMMessage[]`, an `ActionRecord` tracks the *outcome* of each step so the
 * Reflector can reason about what worked and what didn't.
 */
export interface ActionRecord {
  /** Monotonic iteration index this action was taken at. */
  iteration: number;
  /** ISO timestamp the action started. */
  startedAt: string;
  /** ISO timestamp the action completed (set even on failure). */
  endedAt: string;
  /** The decision that produced this action. */
  decision: Decision;
  /** Token accounting for this action (input + output). */
  tokens: TokenUsage;
  /** Outcome of tool execution (only set for TOOL_CALL decisions). */
  toolResult?: ToolResult<unknown>;
  /** Set when the action failed; null on success or in-progress. */
  error?: string;
}

/**
 * The structured world model the agent maintains across iterations. This is
 * what makes SANIX "agentic" rather than a stateless chat loop — the agent
 * knows what it has tried, what succeeded, what failed, and why.
 */
export interface WorldModel {
  /** The high-level goal, verbatim from the user. */
  goal: string;
  /** The agent's interpretation of the goal (filled by Planner Phase 1). */
  understanding: string;
  /** Open ambiguities the agent has not yet resolved. */
  ambiguities: string[];
  /** Ids of tasks that have been completed (in dependency order). */
  completedTaskIds: string[];
  /** Ids of tasks currently in-flight (being executed). */
  inFlightTaskIds: string[];
  /** Ids of tasks that have failed at least once. */
  failedTaskIds: string[];
  /** Human-readable lessons learned so far this session. */
  lessonsLearned: string[];
  /** Files modified this session (absolute paths). */
  modifiedFiles: string[];
  /** Counter for tool invocations per tool name. */
  toolCallCounts: Record<string, number>;
  /** Aggregate token usage across the session. */
  totalTokens: TokenUsage;
}

/**
 * Per-run execution context: the inputs the agent needs that are *not*
 * derived from the goal itself. This is what `run(goal, context)` receives.
 */
export interface RunContext {
  /** Fully-resolved SANIX config (already env-substituted). */
  config: SanixConfig;
  /** Project root the agent operates in (cwd for relative paths). */
  cwd: string;
  /** Optional user-provided seed messages (pre-pended to history). */
  seedMessages?: LLMMessage[];
  /** Optional abort signal for graceful cancellation. */
  signal?: AbortSignal;
  /** Project identifier for episodic memory scoping. */
  project?: string;
  /** Caller-supplied tool context (cwd, permissions, etc.). */
  toolContext: ToolContext;
  /**
   * Optional checkpoint manager. When set (along with {@link checkpointEveryN}),
   * the agent loop auto-saves a checkpoint every N iterations so the run
   * can be resumed via {@link AgentLoop.resume}. Opt-in.
   */
  checkpointManager?: CheckpointManager;
  /**
   * Number of iterations between auto-checkpoints. Only takes effect when
   * {@link checkpointManager} is also set. Default: no auto-checkpointing.
   */
  checkpointEveryN?: number;
  /**
   * Optional cost tracker. When set, the agent loop records a
   * {@link CostEntry} for every LLM call (in `decide()`) and emits a
   * `cost:recorded` event. When absent, cost tracking is silently
   * skipped (the loop runs in "no-cost" mode — useful for tests and
   * local providers).
   */
  costTracker?: CostTracker;
  /**
   * Optional session id used to group cost entries. When omitted, the
   * agent loop generates one (`sess-<timestamp>-<rand>`) at run start so
   * every cost entry from a single `run()` call is grouped together.
   */
  sessionId?: string;
  /**
   * V4: Optional conversation state tracker. When set, the agent loop
   * calls `stateTracker.observe(assistantMessage, toolResult)` after
   * each `act()` so the tracker can update its state machine (current
   * phase, decisions, facts, tool stats, errors, ...). The tracker is
   * typically also wired into the `ContextBuilder` (via
   * `setStateTracker`) so its `[STATE]` block is injected into the
   * system prompt at the next `buildOptimized()` call.
   *
   * Opt-in — `undefined` by default. Existing callers that don't set
   * it see identical behavior to before.
   */
  stateTracker?: ConversationStateTracker;
}

/**
 * The complete agent state — passed between OODA phases and persisted to
 * memory at the end of a session. This is the single source of truth for the
 * loop: every phase reads and mutates this object.
 */
export interface AgentState {
  /** Monotonic iteration counter. */
  iterationCount: number;
  /** Hard cap on iterations (from config.agent.maxIterations). */
  maxIterations: number;
  /** True once a COMPLETE decision has been acted on. */
  isComplete: boolean;
  /** True if the loop aborted due to error or budget exhaustion. */
  isAborted: boolean;
  /** Human-readable abort reason (set when isAborted). */
  abortReason?: string;
  /** The originating goal string. */
  goal: string;
  /** The originating run context. */
  context: RunContext;
  /** The current plan (mutable; replaced on replan). */
  plan: Plan;
  /** The structured world model. */
  worldModel: WorldModel;
  /** Full conversation history (raw LLM messages). */
  messages: LLMMessage[];
  /** Structured action history (one entry per executed decision). */
  actions: ActionRecord[];
  /** System prompt (compressed + cacheable prefix). */
  systemPrompt: string;
  /** Files currently loaded into context, keyed by absolute path. */
  fileContext: Record<string, string>;
  /** Task currently being executed (null between tasks). */
  currentTask: TaskNode | null;
  /** Aggregate token usage so far. */
  totalTokens: TokenUsage;
  /** Reasoning for the most recent decision (for TUI display). */
  lastReasoning?: string;
  /**
   * Most-recent MemoryRouter.recall() results, stashed by `orient()` for
   * the context builder to consume in `decide()`. Typed as `unknown[]`
   * here (rather than `ScoredMemoryItem[]`) to avoid a circular type
   * dependency between `agent/types` and `memory/types`; the context
   * builder casts to the concrete type at the call site.
   */
  recentMemories?: unknown[];
}

// ─── Decision union ─────────────────────────────────────────────────────────

/**
 * The agent has decided to call a tool. The provider's tool-call payload is
 * carried verbatim; the Executor parses it against the tool's Zod schema.
 */
export interface ToolCallDecision {
  type: 'TOOL_CALL';
  /** Provider-issued tool call id (used to correlate the result). */
  toolCallId: string;
  /** Tool name; must match a registered SanixTool. */
  toolName: string;
  /** Raw JSON arguments string from the provider. */
  arguments: string;
  /** Free-text reasoning the model gave for this call. */
  reasoning?: string;
}

/**
 * The agent has decided to emit a plain LLM completion (e.g. explaining
 * progress to the user, asking a clarifying question that doesn't require
 * `ASK_USER`, or producing final prose).
 */
export interface LLMCompletionDecision {
  type: 'LLM_COMPLETION';
  /** The text the model produced. */
  content: string;
  reasoning?: string;
}

/**
 * The agent has decided to delegate a sub-task to a sub-agent. The
 * SubAgentManager handles the actual spawn.
 */
export interface SpawnSubAgentDecision {
  type: 'SPAWN_SUBAGENT';
  /** The sub-task definition (id, title, tools, budget, ...). */
  subTask: SubTask;
  reasoning?: string;
}

/**
 * The agent has decided the goal is satisfied. The loop will break on the
 * next iteration check.
 */
export interface CompleteDecision {
  type: 'COMPLETE';
  /** Final summary the agent produced. */
  summary: string;
  /** Whether the agent believes it succeeded. */
  success: boolean;
  reasoning?: string;
}

/**
 * The agent has decided to abort (e.g. unrecoverable error, budget exceeded,
 * user cancellation). The loop sets isAborted and breaks.
 */
export interface AbortDecision {
  type: 'ABORT';
  /** Why the agent aborted. */
  reason: string;
  reasoning?: string;
}

/**
 * The agent needs human input to proceed. The loop yields back to the caller
 * with this decision; the caller is expected to resolve it and resume.
 */
export interface AskUserDecision {
  type: 'ASK_USER';
  /** The question to ask. */
  question: string;
  /** Optional preset choices (for menu-style prompts). */
  choices?: string[];
  reasoning?: string;
}

/**
 * The discriminated union of all decisions the agent can make. The `decide()`
 * phase returns one of these and the `act()` phase dispatches on `type`.
 */
export type Decision =
  | ToolCallDecision
  | LLMCompletionDecision
  | SpawnSubAgentDecision
  | CompleteDecision
  | AbortDecision
  | AskUserDecision;

// ─── Plan & task graph ──────────────────────────────────────────────────────

/**
 * Task type taxonomy mirroring the Planner spec. The Executor uses `type` to
 * dispatch (tool-based tasks → tool registry, sub-agent-delegatable →
 * SubAgentManager, `think` → straight LLM call).
 */
export type TaskType =
  | 'research'
  | 'code_write'
  | 'code_edit'
  | 'test'
  | 'shell'
  | 'review'
  | 'think';

/**
 * A single node in the plan DAG. `dependencies` lists task ids that must
 * complete before this task starts; the Executor respects this ordering.
 */
export interface TaskNode {
  id: string;
  title: string;
  description: string;
  type: TaskType;
  /** Task ids that must complete before this one starts. */
  dependencies: string[];
  /** Tool names the agent expects to use for this task. */
  tools: string[];
  /** Token budget allocated to this task. */
  tokenBudget: number;
  /** True if a sub-agent can take this task. */
  canDelegate: boolean;
  /** Current lifecycle status. */
  status: 'pending' | 'in_flight' | 'completed' | 'failed';
  /** Number of attempts so far (for retry tracking). */
  attempts: number;
  /** Last error message (set when status === 'failed'). */
  lastError?: string;
}

/**
 * A plan: the output of Planner Phase 1 (decompose) and Phase 2 (replan).
 * The agent maintains exactly one `Plan` at a time and replaces it on replan.
 */
export interface Plan {
  /** The originating goal (echoed for traceability). */
  goal: string;
  /** The agent's interpretation of the goal. */
  understanding: string;
  /** Open ambiguities (may trigger ASK_USER). */
  ambiguities: string[];
  /** The task graph (ordered, but execution respects dependencies). */
  tasks: TaskNode[];
  /** Verifiable success criteria. */
  successCriteria: string[];
  /** Estimated total token budget for the plan. */
  estimatedTokenBudget: number;
  /** Recommended provider alias for this plan. */
  recommendedProvider: string;
  /** True if sub-agents can run concurrently. */
  parallelizable: boolean;
  /** ISO timestamp the plan was created. */
  createdAt: string;
}

/**
 * A sub-task handed to a sub-agent. Lighter than a full `TaskNode` — it
 * carries only what a child needs to run independently.
 */
export interface SubTask {
  /** Unique id (nanoid). */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** Detailed description of what the sub-agent should accomplish. */
  description: string;
  /** Type hint for routing. */
  type: TaskType;
  /** Tools the sub-agent is allowed to use. */
  tools: string[];
  /** Token budget for the sub-agent. */
  tokenBudget: number;
  /** Compressed parent context summary the sub-agent starts with. */
  parentContextSummary?: string;
}

/**
 * A handle to a running sub-agent. The parent uses this to await results and
 * inspect lifecycle state.
 */
export interface SubAgentHandle {
  /** Unique sub-agent id (matches the SubTask.id). */
  id: string;
  /** Promise that resolves with the sub-agent's final report. */
  result: Promise<SubAgentResult>;
  /** True if the sub-agent is still running. */
  isRunning: boolean;
  /** Cancels the sub-agent (best-effort). */
  cancel: () => void;
}

/**
 * The result a sub-agent returns. Merged back into the parent's memory by the
 * SubAgentManager.
 */
export interface SubAgentResult {
  /** The sub-agent id. */
  agentId: string;
  /** True if the sub-agent believes it succeeded. */
  success: boolean;
  /** Free-text summary of what the sub-agent did. */
  summary: string;
  /** Files the sub-agent modified (absolute paths). */
  modifiedFiles: string[];
  /** Facts the sub-agent learned (for semantic memory). */
  learnedFacts: string[];
  /** Tokens the sub-agent consumed. */
  tokensUsed: TokenUsage;
  /** Error message on failure. */
  error?: string;
}

/**
 * A full report from a sub-agent, delivered to the parent via
 * `SubAgentManager.receiveReport`. Carries everything the parent needs to
 * merge the sub-agent's work back into its own world model.
 */
export interface AgentReport {
  /** The sub-agent id this report is from. */
  agentId: string;
  /** The originating sub-task. */
  task: SubTask;
  /** The sub-agent's result. */
  result: SubAgentResult;
  /** ISO timestamp the report was generated. */
  reportedAt: string;
}

// ─── Execution results ──────────────────────────────────────────────────────

/**
 * The outcome of executing a `TaskNode` via the Executor. Carries the tool
 * results (if any), token usage, and retry/failure metadata.
 */
export interface TaskResult {
  /** The task that was executed. */
  taskId: string;
  /** True if the task succeeded. */
  success: boolean;
  /** Tool results produced during execution (may be multiple). */
  toolResults: ToolResult<unknown>[];
  /** Tokens consumed by this task. */
  tokensUsed: TokenUsage;
  /** Number of attempts made (1 = first try, 2 = one retry, etc.). */
  attempts: number;
  /** Final LLM response for the task (if any). */
  llmResponse?: LLMResponse;
  /** Error message on failure. */
  error?: string;
  /** Free-text summary of what was accomplished. */
  summary: string;
}

/**
 * The final result of `AgentLoop.run()`. Carries the agent's summary, the
 * final state, and the structured action history for replay/audit.
 */
export interface AgentResult {
  /** True if the agent reached a COMPLETE decision with success=true. */
  success: boolean;
  /** The agent's final summary text. */
  summary: string;
  /** Total iterations executed. */
  iterations: number;
  /** Total tokens consumed. */
  totalTokens: TokenUsage;
  /** The final state (for inspection / persistence). */
  finalState: AgentState;
  /** The structured action history. */
  actions: ActionRecord[];
  /** Files modified during the session. */
  modifiedFiles: string[];
  /** Lessons learned (extracted to episodic memory). */
  lessonsLearned: string[];
  /** Abort reason (set when success === false due to abort). */
  abortReason?: string;
}

// ─── Reflector ──────────────────────────────────────────────────────────────

/**
 * Output of the Reflector's `assess()` call. The agent reads `shouldReplan`
 * to decide whether to invoke the Planner's Phase 2.
 */
export interface ReflectionResult {
  /** Free-text critique of recent actions. */
  critique: string;
  /** True if the Reflector thinks the current plan is no longer viable. */
  shouldReplan: boolean;
  /** Concrete adjustments the agent should make (e.g. "switch to bash tool"). */
  suggestedAdjustments: string[];
  /** Score 0..1 indicating progress toward the goal (1 = done). */
  progressScore: number;
}

// ─── Loop events ────────────────────────────────────────────────────────────

/**
 * Event payloads emitted by the AgentLoop's EventEmitter3. Subscribers (TUI,
 * CLI, telemetry) listen for these to render live state.
 */
export interface AgentLoopEvents {
  /** Fired at the start of each observe() phase. */
  observe: { iteration: number; state: AgentState };
  /** Fired at the start of each orient() phase. */
  orient: { iteration: number; state: AgentState };
  /** Fired when a decision is made (before act()). */
  decide: { iteration: number; decision: Decision };
  /** Fired when an action is taken (after act()). */
  act: { iteration: number; decision: Decision; result?: TaskResult };
  /** Fired at the end of each iteration. */
  iteration: { iteration: number; tokens: TokenUsage };
  /** Fired when the loop completes successfully. */
  complete: { result: AgentResult };
  /** Fired on unrecoverable error. */
  error: { error: Error; iteration: number; state: AgentState };
  /**
   * Fired after each LLM call when a {@link CostTracker} is configured.
   * Carries the recorded {@link CostEntry} plus the running cumulative
   * cost across the session. Subscribers can use this to render a live
   * cost readout in the TUI / CLI status bar.
   */
  'cost:recorded': {
    iteration: number;
    entry: CostEntry;
    /** Cumulative USD cost across this session so far. */
    cumulativeCostUsd: number;
  };
}

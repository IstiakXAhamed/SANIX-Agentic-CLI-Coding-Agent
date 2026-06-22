/**
 * @file types.ts
 * @description Public type contracts for `@sanix/agents`. Defines the
 * `SpecializedAgent` interface, the `BaseAgent` run options / result /
 * finding / action / progress types, and the `AgentCategory` union used
 * to classify every specialized agent in the SANIX catalog.
 *
 * Every specialized agent (Security Sentinel, Migration Maestro, Test
 * Architect, Perf Profiler, Doc Doctor, ...) implements
 * {@link SpecializedAgent}. The abstract {@link BaseAgent} class provides
 * the shared scaffolding (event emission, finding/action collection, cost
 * tracking, output formatting); subclasses supply the metadata and a
 * `run()` implementation.
 *
 * @packageDocumentation
 */

/**
 * The set of categories a specialized agent may belong to. Surfaced by
 * `AgentRegistry.listByCategory` for the TUI/CLI's category browser.
 *
 * Categories are intentionally narrow so a future 30+ agent catalog can
 * still navigate cleanly — each agent gets exactly one category.
 */
export type AgentCategory =
  | 'security'
  | 'migration'
  | 'testing'
  | 'performance'
  | 'documentation'
  | 'refactoring'
  | 'dependencies'
  | 'api'
  | 'database'
  | 'devops'
  | 'data'
  | 'accessibility'
  | 'release'
  | 'onboarding'
  | 'debugging'
  | 'optimization'
  | 'pairing'
  | 'learning'
  | 'analysis'
  | 'monitoring'
  | 'design'
  | 'orchestration';

/**
 * Options passed to {@link SpecializedAgent.run}. All fields optional —
 * an agent has sensible defaults for everything except `goal` (passed as
 * the first positional argument).
 */
export interface AgentRunOptions {
  /**
   * Working directory the agent operates within. Defaults to
   * `process.cwd()` when omitted. Every relative path in findings and
   * actions is resolved against this.
   */
  cwd?: string;
  /**
   * Provider id hint (e.g. `'claude-sonnet-4'`). When omitted, the
   * agent uses its declared {@link SpecializedAgent.provider} default,
   * falling back to a no-LLM static analysis mode if no provider is
   * wired in by the caller.
   */
  provider?: string;
  /**
   * Hard cap on the number of internal iterations the agent performs
   * (file batches, scan rounds, ...). Defaults to 25 — enough for a
   * thorough scan of a medium repo without runaway cost.
   */
  maxIterations?: number;
  /**
   * When true, the agent performs analysis and produces a report but
   * does NOT write any files or execute any patch commands. Useful for
   * previewing what an agent would do before committing.
   */
  dryRun?: boolean;
  /**
   * Output serialization format. `'markdown'` is the human-readable
   * default; `'json'` returns a JSON-stringified {@link AgentRunResult};
   * `'text'` is a flat plain-text digest suitable for piping into
   * another tool.
   */
  outputFormat?: 'text' | 'json' | 'markdown';
  /**
   * Optional progress callback. Invoked for every `start`, `analyze`,
   * `finding`, `action`, `complete`, and `error` event the agent emits.
   * Use this to render live progress in a TUI / CLI.
   */
  onProgress?: (event: AgentProgressEvent) => void;
  /**
   * Optional agent registry. Currently consumed by the UltraWorker
   * orchestrator agent to spawn sub-agents by id. When omitted,
   * UltraWorker falls back to the package-level singleton
   * (`getGlobalRegistry()`). Other agents ignore this field.
   */
  registry?: import('./AgentRegistry.js').AgentRegistry;
}

/**
 * The structured outcome of {@link SpecializedAgent.run}. Always returned
 * — agents do NOT throw on analysis failures; they return
 * `{ success: false, output: '<reason>' }` instead. Exceptions are
 * reserved for programmer errors (bad cwd, permission denied).
 */
export interface AgentRunResult {
  /** The id of the agent that produced this result. */
  agentId: string;
  /** The originating goal, verbatim. */
  goal: string;
  /** True if the agent completed its analysis without aborting. */
  success: boolean;
  /**
   * Human-readable output. Format depends on
   * {@link AgentRunOptions.outputFormat} — markdown by default.
   */
  output: string;
  /** Structured findings discovered during the run. */
  findings: AgentFinding[];
  /** Structured actions performed during the run. */
  actions: AgentAction[];
  /** Agent-specific metrics (e.g. `filesScanned`, `cvesFound`). */
  metrics: Record<string, number>;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** Estimated USD cost of any LLM calls made (0 in static mode). */
  costUsd: number;
  /** Total tokens consumed by any LLM calls made (0 in static mode). */
  tokensUsed: number;
}

/**
 * A single finding produced by an agent. Findings are the structured
 * payload that lives underneath every agent's prose report — they're
 * suitable for piping into issue trackers, PR comments, or dashboards.
 */
export interface AgentFinding {
  /** Stable unique id (nanoid). */
  id: string;
  /** Severity bucket — drives triage priority. */
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  /**
   * Category label — agent-specific. For Security Sentinel this is the
   * CWE id (`'CWE-79'`); for Perf Profiler it's the anti-pattern name
   * (`'N+1-query'`); etc.
   */
  category: string;
  /** One-line summary suitable for a list view. */
  title: string;
  /** Detailed multi-paragraph description with impact + reasoning. */
  description: string;
  /** File the finding applies to (absolute or cwd-relative). */
  file?: string;
  /** 1-indexed line number (or start line for ranges). */
  line?: number;
  /** Optional end line for multi-line findings. */
  endLine?: number;
  /** Code snippet around the finding (for context). */
  snippet?: string;
  /** Concrete suggested fix — code or steps. */
  suggestion?: string;
  /**
   * True when the agent can produce an auto-patch (e.g. via edit_file
   * or write_file). The CLI's `--apply` flag leverages this.
   */
  autoFixable?: boolean;
  /**
   * Optional structured tags for downstream filtering (e.g.
   * `['OWASP-A1', 'injection']`).
   */
  tags?: string[];
}

/**
 * A single action an agent performed during its run. Every file read,
 * shell exec, search, and analysis step gets recorded as an
 * `AgentAction` so the caller can audit exactly what the agent did.
 */
export interface AgentAction {
  /** Stable unique id (nanoid). */
  id: string;
  /** The kind of action. */
  type: 'read' | 'write' | 'edit' | 'exec' | 'search' | 'analyze';
  /** Human-readable description of what the action did. */
  description: string;
  /** Structured input to the action (path, command, query, ...). */
  input?: unknown;
  /** Structured output of the action (file contents, exit code, ...). */
  output?: unknown;
  /** Wall-clock duration of the action in milliseconds. */
  durationMs: number;
  /** True if the action completed without error. */
  success: boolean;
  /** Optional error message (set when `success === false`). */
  error?: string;
}

/**
 * Progress events streamed from an agent to its caller via
 * {@link AgentRunOptions.onProgress} and the BaseAgent's EventEmitter.
 */
export interface AgentProgressEvent {
  /** Event kind. */
  type: 'start' | 'analyze' | 'finding' | 'action' | 'complete' | 'error';
  /** Human-readable message suitable for display. */
  message: string;
  /** Optional structured payload (the finding, the action, ...). */
  data?: unknown;
  /** Monotonic iteration counter (1-indexed). */
  iteration?: number;
  /** ISO timestamp. */
  timestamp?: string;
}

/**
 * The contract every specialized SANIX agent implements. Agents are
 * immutable identity bundles (id/name/description/category/icon/systemPrompt/
 * tools/provider/temperature/exampleQueries) PLUS a single `run()` method.
 *
 * The abstract {@link BaseAgent} class supplies most of the shared
 * machinery (event emission, finding/action collection, output
 * formatting); subclasses implement `run()` and the metadata fields.
 *
 * @example
 * ```ts
 * import { AgentRegistry, SecuritySentinel } from '@sanix/agents';
 *
 * const registry = new AgentRegistry();
 * registry.register(new SecuritySentinel());
 *
 * const result = await registry.run('security-sentinel',
 *   'Scan this repo for hardcoded secrets', { cwd: '/repo' });
 * console.log(result.findings.length, 'findings');
 * ```
 */
export interface SpecializedAgent {
  /** Stable unique agent id (e.g. `'security-sentinel'`). */
  readonly id: string;
  /** Display name (e.g. `'Security Sentinel'`). */
  readonly name: string;
  /** One-paragraph description of what this agent does. */
  readonly description: string;
  /** Category — used by the registry's `listByCategory`. */
  readonly category: AgentCategory;
  /** Emoji icon for the TUI/CLI. */
  readonly icon: string;
  /** The full system prompt — sets the agent's role and constraints. */
  readonly systemPrompt: string;
  /** Tool names this agent needs (whitelist for the ToolRegistry). */
  readonly tools: string[];
  /** Recommended provider id (e.g. `'claude-sonnet-4'`). */
  readonly provider?: string;
  /** Sampling temperature override (0 = deterministic, 1 = creative). */
  readonly temperature?: number;
  /** Example user goals — surfaced in CLI help. */
  readonly exampleQueries: string[];
  /**
   * Run the agent against a goal. Returns a structured
   * {@link AgentRunResult} — never throws on analysis failures.
   *
   * @param goal - The user's high-level goal.
   * @param opts - Optional run configuration (cwd, dryRun, ...).
   */
  run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult>;
}

/**
 * A compact, JSON-serializable summary of an agent — used by the
 * registry's `list()` for CLI/TUI display without leaking the full
 * systemPrompt or tools array.
 */
export interface AgentSummary {
  id: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  exampleQueries: string[];
  toolCount: number;
}

/**
 * Cost estimate input — agents use this with the BaseAgent's
 * `trackCost` helper to record USD spend per LLM call.
 */
export interface CostEstimate {
  /** Provider id used (e.g. `'claude-sonnet-4'`). */
  providerId: string;
  /** Input tokens billed. */
  inputTokens: number;
  /** Output tokens billed. */
  outputTokens: number;
}

// ─── Re-exports for caller convenience ───────────────────────────────────────
//
// The BaseAgent also exposes the EventEmitter3 type surface so consumers
// can subscribe to progress events without pulling eventemitter3 directly.

/**
 * The event map emitted by {@link BaseAgent}. Keys map to
 * {@link AgentProgressEvent.type} values; payloads are the full
 * {@link AgentProgressEvent}.
 */
export type BaseAgentEvents = Record<AgentProgressEvent['type'], AgentProgressEvent>;

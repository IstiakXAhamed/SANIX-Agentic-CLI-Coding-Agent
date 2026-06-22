/**
 * @file types.ts
 * @description Shared types for `@sanix/autotool` — tool registry contract,
 * task classifier categories, effectiveness scores, and recommendation
 * results.
 *
 * @packageDocumentation
 */

/**
 * The result of invoking a tool. Mirrors a subset of MCP's `CallToolResult`.
 */
export interface ToolResult {
  /** Whether the tool succeeded. */
  ok: boolean;
  /** The textual or JSON-stringified output. */
  output: string;
  /** Optional structured data. */
  data?: unknown;
  /** Wall-clock ms the tool took. */
  durationMs: number;
  /** Optional error message (when `ok` is false). */
  error?: string;
}

/**
 * A tool definition. Tools are sync or async functions that take a
 * JSON-serializable argument object and return a {@link ToolResult}.
 */
export interface ToolDef {
  /** Unique tool name (e.g. `read_file`). */
  name: string;
  /** Short human-readable description (used for matching). */
  description: string;
  /** Optional list of keywords for task-classifier matching. */
  keywords?: string[];
  /** The tool implementation. */
  run: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
}

/**
 * The registry contract that {@link SmartDispatcher} wraps. Mirrors the
 * shape exposed by `@sanix/tools` so callers can pass their existing
 * registry directly.
 */
export interface ToolRegistry {
  /** List all registered tools. */
  list: () => ToolDef[];
  /** Look up a single tool by name. Returns undefined if not registered. */
  get: (name: string) => ToolDef | undefined;
  /** Invoke a tool by name with the given args. */
  invoke: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * Coarse task category produced by {@link TaskClassifier}. The 11 categories
 * here mirror the 11 keyword-rule buckets in the classifier.
 */
export type TaskCategory =
  | 'file'
  | 'search'
  | 'code'
  | 'web'
  | 'shell'
  | 'memory'
  | 'data'
  | 'network'
  | 'math'
  | 'time'
  | 'unknown';

/**
 * The output of {@link TaskClassifier.classify}.
 */
export interface Classification {
  /** The detected category. */
  category: TaskCategory;
  /** Confidence in the classification (0..1). */
  confidence: number;
  /** The keywords that triggered the match. */
  matchedKeywords: string[];
  /** Whether an LLM fallback was used. */
  usedFallback: boolean;
}

/**
 * Effectiveness record for a single tool invocation, accumulated by
 * {@link EffectivenessTracker}.
 */
export interface ToolEffectivenessRecord {
  /** Tool name. */
  tool: string;
  /** Number of times the tool was invoked. */
  invocations: number;
  /** Number of times the invocation succeeded (`ok === true`). */
  successes: number;
  /** Exponentially-weighted moving average of success (0..1). */
  ema: number;
  /** Exponentially-weighted moving average of latency in ms. */
  emaLatencyMs: number;
  /** Trend: positive = improving, negative = degrading. */
  trend: number;
  /** Last-updated Unix ms timestamp. */
  updatedAt: number;
}

/**
 * A scored tool recommendation produced by {@link ToolRecommender}.
 */
export interface ToolRecommendation {
  /** The recommended tool. */
  tool: ToolDef;
  /** Recommendation score (0..1). */
  score: number;
  /** Why this tool was recommended (human-readable). */
  reason: string;
}

/**
 * A composed tool sequence produced by {@link CompositionEngine}.
 */
export interface ComposedSequence {
  /** The steps, in order. */
  steps: Array<{ tool: ToolDef; argsHint?: Record<string, unknown> }>;
  /** A human-readable description of the sequence. */
  description: string;
  /** Estimated total latency in ms (sum of historical averages). */
  estimatedLatencyMs: number;
}

/**
 * Usage insights produced by {@link UsageAnalyzer}.
 */
export interface UsageInsights {
  /** Total invocations across all tools. */
  totalInvocations: number;
  /** Top-N most-used tools. */
  topTools: Array<{ tool: string; invocations: number }>;
  /** Tools that have never been used. */
  unusedTools: string[];
  /** Tools with success rate below 0.5 (with ≥3 invocations). */
  unreliableTools: Array<{ tool: string; successRate: number }>;
  /** Tools whose EMA latency is in the top quartile. */
  slowTools: Array<{ tool: string; emaLatencyMs: number }>;
  /** Human-readable recommendations. */
  recommendations: string[];
}

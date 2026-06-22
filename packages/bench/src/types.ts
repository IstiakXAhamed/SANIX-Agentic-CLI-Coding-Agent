/**
 * @file types.ts
 * @description Benchmark type system for `@sanix/bench`. Defines the
 * benchmark / prompt / scoring / result contracts used by the suite,
 * the runner, and the reporters.
 *
 * @packageDocumentation
 */

import type { LLMMessage } from '@sanix/providers';

/**
 * A memory item that can be injected as context for a benchmark prompt.
 * Mirrors the shape produced by `@sanix/core`'s MemoryRouter.
 */
export interface MemoryItem {
  /** Stable unique id. */
  id: string;
  /** The memory content (free-form text). */
  content: string;
  /** Memory tier (working / episodic / semantic / procedural). */
  tier?: 'working' | 'episodic' | 'semantic' | 'procedural';
  /** Optional importance score [0, 1]. */
  importance?: number;
  /** Optional embedding (for re-derivation by the agent). */
  embedding?: number[];
}

/**
 * The scoring specification — how the runner decides pass / fail for a
 * single prompt.
 *
 * - `exact`      — output must equal `expected` (after trim).
 * - `contains`   — output must contain `expected` as a substring.
 * - `regex`      — output must match `expected` (interpreted as a regex).
 * - `llm_judge`  — a second LLM call (model `judge`) grades the output.
 * - `custom`     — `expected` is a `(output) => boolean` predicate.
 */
export interface ScoringSpec {
  /** Scoring strategy. */
  type: 'exact' | 'contains' | 'regex' | 'llm_judge' | 'custom';
  /** Optional model id (for `llm_judge`). */
  judge?: string;
  /** Pass threshold for `llm_judge` scores [0, 1]. Default 0.7. */
  threshold?: number;
}

/**
 * A single benchmark prompt. The `input` can be a plain string (for
 * simple benchmarks) or a full `LLMMessage[]` (for multi-turn / system-
 * prompt-bearing benchmarks). The `expected` field is interpreted by
 * the {@link ScoringSpec}.
 */
export interface BenchmarkPrompt {
  /** Stable unique prompt id. */
  id: string;
  /** The input — either a plain user message or a full message array. */
  input: string | LLMMessage[];
  /**
   * The expected answer. For `exact` / `contains` / `regex` / `llm_judge`,
   * a string. For `custom`, a predicate function `(output) => boolean`.
   */
  expected?: string | ((output: string) => boolean);
  /** Optional file context to mount for the agent (path → content). */
  context?: {
    files?: Record<string, string>;
    memory?: MemoryItem[];
  };
  /** Optional max iterations cap (for agent-based benchmarks). */
  maxIterations?: number;
}

/**
 * The benchmark category. Drives grouping in the reporter output.
 */
export type BenchmarkCategory =
  | 'reasoning'
  | 'coding'
  | 'tools'
  | 'memory'
  | 'context'
  | 'multi_turn';

/**
 * A benchmark — a named, categorized collection of prompts with a
 * scoring spec and a per-prompt timeout.
 */
export interface Benchmark {
  /** Stable unique benchmark id (e.g. `basic-reasoning`). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description (shown in the reporter output). */
  description: string;
  /** Category (for grouping). */
  category: BenchmarkCategory;
  /** The prompts that make up this benchmark. */
  prompts: BenchmarkPrompt[];
  /** How each prompt's output is scored. */
  scoring: ScoringSpec;
  /** Per-prompt timeout in milliseconds. */
  timeout: number;
}

/**
 * The result of a single prompt.
 */
export interface PromptResult {
  /** The prompt id. */
  promptId: string;
  /** `true` if the prompt passed scoring. */
  passed: boolean;
  /** The raw output produced by the model / agent. */
  output: string;
  /** The expected answer (string form), when applicable. */
  expected?: string;
  /** Numeric score [0, 1] (1.0 = full pass; 0.0 = full fail). */
  score: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Cost in USD for this prompt (when cost tracking is available). */
  costUsd: number;
  /** Total tokens consumed by this prompt. */
  tokens: number;
  /** Error message (set when the prompt errored out). */
  error?: string;
}

/**
 * The result of running one benchmark (possibly multiple prompts in
 * parallel, possibly repeated). The `summary` field has aggregate
 * pass-rate, cost, and duration figures.
 */
export interface BenchmarkResult {
  /** The benchmark id. */
  benchmarkId: string;
  /** The unique run id (one per `BenchmarkSuite.run` invocation). */
  runId: string;
  /** Unix ms timestamp when the run finished. */
  timestamp: number;
  /** Total wall-clock duration in ms. */
  durationMs: number;
  /** Total cost in USD across all prompts. */
  totalCostUsd: number;
  /** Total tokens across all prompts. */
  totalTokens: number;
  /** Per-prompt results (in the order they were run). */
  promptResults: PromptResult[];
  /** Aggregate summary. */
  summary: {
    /** Number of prompts that passed. */
    passed: number;
    /** Number of prompts that failed. */
    failed: number;
    /** Pass rate [0, 1]. */
    passRate: number;
    /** Average cost in USD per prompt. */
    avgCostUsd: number;
    /** Average duration in ms per prompt. */
    avgDurationMs: number;
  };
}

/**
 * Options for {@link BenchmarkSuite.run}.
 */
export interface RunOptions {
  /**
   * Provider id to use. If unset, the suite uses whichever provider is
   * the first available in the supplied registry.
   */
  provider?: string;
  /**
   * Number of prompts to run in parallel. Default 1 (sequential).
   */
  parallel?: number;
  /**
   * Number of times to repeat each prompt. The reported pass-rate is the
   * fraction of *any* pass across the repeats. Default 1.
   */
  repeat?: number;
}

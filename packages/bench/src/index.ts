/**
 * @file index.ts
 * @description Public entry point for `@sanix/bench`. Re-exports the
 * suite, the scorer, the reporters, all shared types, and the built-in
 * benchmarks.
 *
 * Importing paths:
 *   import { BenchmarkSuite, formatReport, BUILTIN_BENCHMARKS } from '@sanix/bench';
 *   import type { Benchmark, BenchmarkResult } from '@sanix/bench';
 *
 * @packageDocumentation
 */

export {
  BenchmarkSuite,
  type BenchmarkSuiteOptions,
  type ChatFn,
} from './BenchmarkSuite.js';
export { scoreOutput, type ScoreOutcome } from './Scorer.js';
export {
  formatReport,
  formatJSON,
  formatMarkdown,
  compare,
} from './Reporter.js';

export type {
  Benchmark,
  BenchmarkCategory,
  BenchmarkPrompt,
  ScoringSpec,
  MemoryItem,
  PromptResult,
  BenchmarkResult,
  RunOptions,
} from './types.js';

export {
  BUILTIN_BENCHMARKS,
  basicReasoning,
  basicCoding,
  toolUse,
  memoryRecall,
  longContext,
  multiTurnConversation,
} from './benchmarks/index.js';

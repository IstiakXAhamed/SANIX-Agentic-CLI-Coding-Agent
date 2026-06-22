/**
 * @file benchmarks/index.ts
 * @description Barrel for the built-in benchmarks shipped with
 * `@sanix/bench`. Also exports `BUILTIN_BENCHMARKS` — the flat array of
 * all built-in benchmarks, ready to register with a `BenchmarkSuite`.
 *
 * @packageDocumentation
 */

import type { Benchmark } from '../types.js';
import { basicReasoning } from './reasoning/basic-reasoning.js';
import { basicCoding } from './coding/basic-coding.js';
import { toolUse } from './tools/tool-use.js';
import { memoryRecall } from './memory/recall.js';
import { longContext } from './context/long-context.js';
import { multiTurnConversation } from './multi_turn/conversation.js';

export { basicReasoning } from './reasoning/basic-reasoning.js';
export { basicCoding } from './coding/basic-coding.js';
export { toolUse } from './tools/tool-use.js';
export { memoryRecall } from './memory/recall.js';
export { longContext } from './context/long-context.js';
export { multiTurnConversation } from './multi_turn/conversation.js';

/**
 * All built-in benchmarks. Useful for one-liner registration:
 *
 * @example
 * ```ts
 * import { BenchmarkSuite, BUILTIN_BENCHMARKS } from '@sanix/bench';
 *
 * const suite = new BenchmarkSuite({ provider });
 * for (const b of BUILTIN_BENCHMARKS) suite.register(b);
 * ```
 */
export const BUILTIN_BENCHMARKS: Benchmark[] = [
  basicReasoning,
  basicCoding,
  toolUse,
  memoryRecall,
  longContext,
  multiTurnConversation,
];

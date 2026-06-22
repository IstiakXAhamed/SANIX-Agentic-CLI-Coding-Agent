/**
 * @file Shared types for memory tools. The memory subsystem delegates
 * storage to callbacks provided via the ToolContext (the core package owns
 * the actual SQLite/LanceDB-backed storage). These types describe the
 * callback contract.
 */
import type { ToolContext } from '../types.js';

/** Memory tier classification. */
export type MemoryType = 'episodic' | 'semantic' | 'procedural';

/** Item shape accepted by the `memoryStore` callback. */
export interface MemoryItem {
  content: string;
  type: MemoryType;
  metadata?: Record<string, unknown>;
}

/** Query shape accepted by the `memoryRecall` callback. */
export interface RecallQuery {
  query: string;
  limit?: number;
  type?: MemoryType;
}

/** Result returned by the `memoryRecall` callback. */
export interface RecalledMemory {
  id: string;
  content: string;
  score: number;
  type: MemoryType;
}

/** Result returned by the `memorySummarize` callback. */
export interface SessionSummary {
  summary: string;
  lessonsLearned: string[];
}

/**
 * Extended ToolContext that memory tools read from. The base `ToolContext`
 * in `@sanix/core` may carry these callbacks (typed as `unknown` there);
 * memory tools cast to this richer type when accessing them. If a callback
 * is absent the tool degrades gracefully (returns an empty / no-op result).
 */
export interface MemoryToolContext extends ToolContext {
  memoryStore?: (item: MemoryItem) => Promise<string>;
  memoryRecall?: (query: RecallQuery) => Promise<RecalledMemory[]>;
  memoryForget?: (id: string) => Promise<boolean>;
  memorySummarize?: (sessionId?: string) => Promise<SessionSummary>;
}

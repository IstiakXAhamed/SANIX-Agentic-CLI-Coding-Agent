/**
 * @file index.ts
 * @description Barrel re-export for `@sanix/optimizer`. Every public
 * symbol is available via a single import:
 *
 *   import {
 *     // Tokenizer
 *     tokenizer, getTokenizer, setTokenizer,
 *     ExactTokenizer, type TokenizerProvider,
 *     // Chunker
 *     SemanticChunker, type Chunk, type ChunkOptions,
 *     // Attention selector
 *     AttentionSelector, type ScoreableItem, type ScoreWeights,
 *     type ScoredItem, DEFAULT_WEIGHTS,
 *     // Budget reallocator
 *     DynamicBudgetReallocator, type TierUsage, type BudgetAllocation,
 *     // Lazy expander
 *     LazyContextExpander, type ExpansionSignal, type ExpansionSignalType,
 *     type ExpansionOptions,
 *     // Message consolidator
 *     MessageConsolidator, type ConsolidateOptions,
 *     // RAC manager
 *     RACManager, type RetrievedChunk, type RetrievalSource,
 *     type RetrieveOptions, type MemoryRecallFn, type WebSearchFn,
 *     type McpListToolsFn, type FileGlobFn, type FileReadFn,
 *     // Context compressor
 *     ContextCompressor, type CompressOptions,
 *     // Tool result truncator
 *     ToolResultTruncator, type ToolResultType, type TruncateOptions,
 *     // Shared types
 *     type BuiltContext,
 *   } from '@sanix/optimizer';
 *
 * @packageDocumentation
 */

// ─── Exact tokenizer ────────────────────────────────────────────────────────
export {
  ExactTokenizer,
  tokenizer,
  getTokenizer,
  setTokenizer,
  type TokenizerProvider,
} from './ExactTokenizer.js';

// ─── Semantic chunker ───────────────────────────────────────────────────────
export {
  SemanticChunker,
  type Chunk,
  type ChunkOptions,
} from './SemanticChunker.js';

// ─── Attention selector ─────────────────────────────────────────────────────
export {
  AttentionSelector,
  DEFAULT_WEIGHTS,
  type ScoreableItem,
  type ScoreWeights,
  type ScoredItem,
} from './AttentionSelector.js';

// ─── Budget reallocator ─────────────────────────────────────────────────────
export {
  DynamicBudgetReallocator,
  type TierUsage,
  type BudgetAllocation,
} from './BudgetReallocator.js';

// ─── Lazy context expander ──────────────────────────────────────────────────
export {
  LazyContextExpander,
  type ExpansionSignal,
  type ExpansionSignalType,
  type ExpansionOptions,
} from './LazyContextExpander.js';

// ─── Message consolidator ───────────────────────────────────────────────────
export {
  MessageConsolidator,
  type ConsolidateOptions,
} from './MessageConsolidator.js';

// ─── RAC manager ────────────────────────────────────────────────────────────
export {
  RACManager,
  type RetrievedChunk,
  type RetrievalSource,
  type RetrieveOptions,
  type MemoryRecallFn,
  type WebSearchFn,
  type McpListToolsFn,
  type FileGlobFn,
  type FileReadFn,
} from './RACManager.js';

// ─── Context compressor ─────────────────────────────────────────────────────
export {
  ContextCompressor,
  type CompressOptions,
} from './ContextCompressor.js';

// ─── Tool result truncator ──────────────────────────────────────────────────
export {
  ToolResultTruncator,
  type ToolResultType,
  type TruncateOptions,
  lineCount,
} from './ToolResultTruncator.js';

// ─── Shared types ───────────────────────────────────────────────────────────
export { type BuiltContext } from './types.js';

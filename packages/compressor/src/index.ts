/**
 * @file index.ts
 * @description Barrel re-export for `@sanix/compressor`. Every public
 * symbol is available via a single import:
 *
 *   import {
 *     // LLM prompt compression
 *     LLMPromptCompressor,
 *     type CompressionResult,
 *     type LLMPromptCompressorOptions,
 *     type CompressOptions,
 *     // Symbol-aware code context
 *     SymbolCodeContext,
 *     type Symbol,
 *     type SymbolType,
 *     type SupportedExtension,
 *     // Conversation state tracker
 *     ConversationStateTracker,
 *     type ConversationState,
 *     type ConversationPhase,
 *     type RecordedDecision,
 *     type LearnedFact,
 *     type ToolUsageStats,
 *     type ObservedToolResult,
 *     // Prompt cache manager
 *     PromptCacheManager,
 *     type CachedPrefixEntry,
 *     type PromptCacheStats,
 *     // Diff-based context updater
 *     DiffContextUpdater,
 *     type DiffResult,
 *     type DiffHunk,
 *   } from '@sanix/compressor';
 *
 * @packageDocumentation
 */

// ─── LLM prompt compressor ──────────────────────────────────────────────────
export {
  LLMPromptCompressor,
  type CompressionResult,
  type LLMPromptCompressorOptions,
  type CompressOptions,
} from './LLMPromptCompressor.js';

// ─── Symbol-aware code context ──────────────────────────────────────────────
export {
  SymbolCodeContext,
  type Symbol,
  type SymbolType,
  type SupportedExtension,
} from './SymbolCodeContext.js';

// ─── Conversation state tracker ─────────────────────────────────────────────
export {
  ConversationStateTracker,
  type ConversationState,
  type ConversationPhase,
  type RecordedDecision,
  type LearnedFact,
  type ToolUsageStats,
  type ObservedToolResult,
} from './ConversationStateTracker.js';

// ─── Prompt cache manager ───────────────────────────────────────────────────
export {
  PromptCacheManager,
  type CachedPrefixEntry,
  type PromptCacheStats,
} from './PromptCacheManager.js';

// ─── Diff-based context updater ─────────────────────────────────────────────
export {
  DiffContextUpdater,
  type DiffResult,
  type DiffHunk,
} from './DiffContextUpdater.js';

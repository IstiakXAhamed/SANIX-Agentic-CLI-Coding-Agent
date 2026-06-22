/**
 * @file memory-v2/src/index.ts
 * @description Barrel re-export for `@sanix/memory-v2`. Surface:
 *
 *   - **HNSW vector index**: `HNSWIndex`, `SearchResult`, `HNSWOptions`
 *   - **Ebbinghaus forgetting curve**: `ForgettingCurve`,
 *     `ForgettingMemory`, `ForgettingCurveOptions`,
 *     `DEFAULT_FORGET_THRESHOLD`
 *   - **Salience scorer**: `SalienceScorer`, `ScoreContext`,
 *     `SalienceWeights`, `DEFAULT_SALIENCE_WEIGHTS`
 *   - **Semantic deduplicator**: `SemanticDeduplicator`,
 *     `DuplicateCluster`, `DeduplicateResult`
 *   - **Tier manager**: `TierManager`, `MemoryAccessEvent`,
 *     `PromotionReport`, `TierTransition`, `TierManagerOptions`,
 *     `DEFAULT_TIER_THRESHOLDS`
 *   - **Episodic extractor**: `EpisodicExtractor`, `SessionRecord`,
 *     `ExtractedFact`, `ExtractOptions`
 *   - **Index manager**: `MemoryIndexManager`, `MemoryIndexManagerOptions`
 *   - **Compactor**: `MemoryCompactor`, `CompactionReport`,
 *     `CompactionContext`, `MemoryCompactorOptions`
 *   - **Types**: `MemoryItem`, `MemoryTier`, `MemoryMetadata`,
 *     `ScoredMemoryItem`, `RecallQuery`, `MemoryRouterLike`
 *
 * Import paths:
 *   import { HNSWIndex, MemoryCompactor } from '@sanix/memory-v2';
 *
 * @packageDocumentation
 */

// HNSW vector index.
export {
  HNSWIndex,
  type SearchResult,
  type HNSWOptions,
} from './HNSWIndex.js';

// Ebbinghaus forgetting curve.
export {
  ForgettingCurve,
  type ForgettingMemory,
  type ForgettingCurveOptions,
  DEFAULT_FORGET_THRESHOLD,
} from './ForgettingCurve.js';

// Salience scorer.
export {
  SalienceScorer,
  type ScoreContext,
  type SalienceWeights,
  type SalienceScorerOptions,
  DEFAULT_SALIENCE_WEIGHTS,
} from './SalienceScorer.js';

// Semantic deduplicator.
export {
  SemanticDeduplicator,
  type DuplicateCluster,
  type DeduplicateResult,
  type SemanticDeduplicatorOptions,
  type EmbedProvider,
} from './SemanticDeduplicator.js';

// Tier manager.
export {
  TierManager,
  type MemoryAccessEvent,
  type PromotionReport,
  type TierTransition,
  type TierManagerOptions,
  DEFAULT_TIER_THRESHOLDS,
} from './TierManager.js';

// Episodic → semantic extractor.
export {
  EpisodicExtractor,
  type SessionRecord,
  type ExtractedFact,
  type ExtractOptions,
  type EpisodicExtractorOptions,
} from './EpisodicExtractor.js';

// Memory index manager.
export {
  MemoryIndexManager,
  type MemoryIndexManagerOptions,
} from './MemoryIndexManager.js';

// Memory compactor (v2 replacement for `MemoryCompressor`).
export {
  MemoryCompactor,
  type CompactionReport,
  type CompactionContext,
  type MemoryCompactorOptions,
} from './MemoryCompactor.js';

// Local type definitions (structurally compatible with @sanix/core/memory).
export type {
  MemoryItem,
  MemoryTier,
  MemoryMetadata,
  RecallQuery,
  ScoredMemoryItem,
  MemoryRouterLike,
  TierLike,
  WorkingTierLike,
  EpisodicTierLike,
  SemanticTierLike,
  ProceduralTierLike,
} from './types.js';

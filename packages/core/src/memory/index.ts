/**
 * @file memory/index.ts
 * @description Barrel re-export for `@sanix/core/memory`. Surface:
 *   - Types: `MemoryItem`, `MemoryType`, `MemoryTier`, `MemoryMetadata`,
 *     `RecallQuery`, `ScoredMemoryItem`, `IMemoryTier`
 *   - Router: `MemoryRouter` (+ `MemoryRouterOptions`, `MemoryRouterEvents`)
 *   - Tiers: `WorkingMemory`, `EpisodicMemory`, `SemanticMemory`,
 *     `ProceduralMemory`
 *   - Compressor: `MemoryCompressor` (+ `CompressionReport`)
 *   - Embeddings: `EmbeddingProvider`, `cosineSimilarity`, `normalizeVector`,
 *     `EMBEDDING_DIM`
 *   - Tier-specific shapes: `WorkingMemoryItem`, `SessionRecord`,
 *     `SemanticFact`, `ProceduralPattern`
 *
 * Import paths:
 *   import { MemoryRouter, WorkingMemory } from '@sanix/core/memory';
 */

export type {
  MemoryItem,
  MemoryType,
  MemoryTier,
  MemoryMetadata,
  RecallQuery,
  ScoredMemoryItem,
  IMemoryTier,
} from './types.js';

export {
  MemoryRouter,
  type MemoryRouterOptions,
  type MemoryRouterEvents,
  type MemoryIndexManagerLike,
} from './MemoryRouter.js';

export {
  WorkingMemory,
  type WorkingMemoryItem,
  type WorkingMemoryOptions,
} from './WorkingMemory.js';

export {
  EpisodicMemory,
  type SessionRecord,
  type EpisodicMemoryOptions,
} from './EpisodicMemory.js';

export {
  SemanticMemory,
  type SemanticFact,
  type SemanticMemoryOptions,
  cosineSimilarity,
} from './SemanticMemory.js';

export {
  ProceduralMemory,
  type ProceduralPattern,
  type ProceduralMemoryOptions,
} from './ProceduralMemory.js';

export {
  MemoryCompressor,
  type CompressionReport,
  type MemoryCompressorOptions,
  type MemoryAccessEvent,
  type TierManagerLike,
  type IndexManagerLike,
  type MemoryCompactorLike,
  type CompactionReportV2,
  type SessionRecordForExtraction,
} from './MemoryCompressor.js';

export {
  EmbeddingProvider,
  cosineSimilarity as cosine,
  normalizeVector,
  EMBEDDING_DIM,
} from './EmbeddingProvider.js';

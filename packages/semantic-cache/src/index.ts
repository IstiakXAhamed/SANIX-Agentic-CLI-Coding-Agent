/**
 * @file index.ts
 * @description Barrel re-export for `@sanix/semantic-cache`. Surface:
 *
 *   - **Semantic cache**: `SemanticCache`, `SemanticCacheOptions`,
 *     `SemanticCacheEvents`, `CacheGetOptions`, `CacheSetOptions`
 *   - **Metadata store**: `CacheMetadataStore`,
 *     `CacheMetadataStoreOptions`
 *   - **Cached provider router**: `CachedProviderRouter`,
 *     `CachedProviderRouterOptions`
 *   - **Embedding providers**: `createEmbeddingProvider`,
 *     `EmbeddingSource`, `CreateEmbeddingProviderOptions`
 *   - **Types**: `CacheEntry`, `CacheStats`, `EmbeddingProvider`
 *
 * Import paths:
 *   import {
 *     SemanticCache, CacheMetadataStore, CachedProviderRouter,
 *     createEmbeddingProvider,
 *   } from '@sanix/semantic-cache';
 *
 * @packageDocumentation
 */

// ─── Types ────────────────────────────────────────────────────────────────
export type {
  CacheEntry,
  CacheStats,
  EmbeddingProvider,
} from './types.js';

// ─── Semantic cache ───────────────────────────────────────────────────────
export {
  SemanticCache,
  type SemanticCacheOptions,
  type SemanticCacheEvents,
  type CacheGetOptions,
  type CacheSetOptions,
} from './SemanticCache.js';

// ─── Metadata store ───────────────────────────────────────────────────────
export {
  CacheMetadataStore,
  type CacheMetadataStoreOptions,
} from './CacheMetadataStore.js';

// ─── Cached provider router ───────────────────────────────────────────────
export {
  CachedProviderRouter,
  type CachedProviderRouterOptions,
} from './CachedProviderRouter.js';

// ─── Embedding providers ──────────────────────────────────────────────────
export {
  createEmbeddingProvider,
  type EmbeddingSource,
  type CreateEmbeddingProviderOptions,
} from './EmbeddingProvider.js';

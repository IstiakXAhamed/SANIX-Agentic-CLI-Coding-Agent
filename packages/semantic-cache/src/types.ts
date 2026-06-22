/**
 * @file types.ts
 * @description Shared types for `@sanix/semantic-cache`. Defines
 * `CacheEntry` (a single cached LLM response, keyed by query
 * embedding), `CacheStats` (rolling hit/miss accounting), and the
 * embedding-provider interface used by the cache.
 *
 * @packageDocumentation
 */

/**
 * A single cached LLM response. The cache key is the **query
 * embedding** (`queryEmbedding`); lookups are done by embedding the
 * incoming query and finding the nearest cached entry by cosine
 * similarity.
 */
export interface CacheEntry {
  /** Unique id (typically a nanoid). */
  id: string;
  /** The original query text (for debugging / invalidation by text). */
  query: string;
  /** The query's embedding vector — the actual cache key. */
  queryEmbedding: Float32Array;
  /** The cached LLM response. */
  response: string;
  /** Arbitrary caller-supplied metadata. */
  metadata: Record<string, unknown>;
  /** Epoch-ms when the entry was created. */
  createdAt: number;
  /** Epoch-ms when the entry expires (0 = never). */
  expiresAt: number;
  /** Number of cache hits on this entry. */
  hitCount: number;
  /** Provider that produced the cached response (e.g. 'anthropic'). */
  provider?: string;
  /** Model that produced the cached response. */
  model?: string;
  /** Token usage of the original (cache-miss) call. */
  tokensUsed?: number;
  /** Cost in USD of the original (cache-miss) call. */
  costUsd?: number;
}

/**
 * Rolling cache statistics. All counters are monotonic except
 * `avgQueryTimeMs` / `avgCacheTimeMs` which are running averages.
 */
export interface CacheStats {
  /** Total entries currently in the cache. */
  entries: number;
  /** Cumulative cache hits. */
  hits: number;
  /** Cumulative cache misses. */
  misses: number;
  /** Hit rate in [0, 1] (`hits / (hits + misses)`; 0 when empty). */
  hitRate: number;
  /** Cumulative tokens saved by cache hits. */
  tokensSaved: number;
  /** Cumulative cost saved by cache hits, in USD. */
  costSavedUsd: number;
  /** Average wall-clock time of a cache-miss (full LLM) query, in ms. */
  avgQueryTimeMs: number;
  /** Average wall-clock time of a cache-hit query, in ms. */
  avgCacheTimeMs: number;
}

/**
 * The embedding-provider interface the cache expects. Any source
 * (Xenova local, OpenAI REST, Cohere REST, custom fn) that can be
 * adapted to this interface can back the cache.
 *
 * Implementations should:
 *   - Return `null` (never throw) when embedding is unavailable.
 *   - Return L2-normalized vectors (so cosine similarity reduces to
 *     a dot product and the HNSW index can compare in O(1) per node).
 */
export interface EmbeddingProvider {
  /** Embed `text`. Returns `null` on failure. */
  embed(text: string): Promise<Float32Array | null>;
}

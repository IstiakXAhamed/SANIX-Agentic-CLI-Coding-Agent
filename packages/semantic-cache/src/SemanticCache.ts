/**
 * @file SemanticCache.ts
 * @description Embedding-based LLM response cache.
 *
 * Unlike a conventional key-value cache (which matches on exact
 * string equality), the semantic cache matches on **cosine
 * similarity** between query embeddings. Two semantically equivalent
 * queries — "How do I authenticate?" and "What's the auth process?" —
 * share a cache entry even though their text differs.
 *
 * ## Architecture
 *
 *   - **Vector index**: HNSWIndex from `@sanix/memory-v2` for fast
 *     approximate nearest-neighbor search over query embeddings.
 *   - **Metadata store**: optional SQLite-backed persistence for the
 *     full {@link CacheEntry} records (response text, metadata,
 *     expiry, hit count, etc.). When no store is configured, entries
 *     live only in memory.
 *   - **Embedding provider**: any source that can produce a
 *     `Float32Array` for a query string (Xenova local, OpenAI REST,
 *     Cohere REST, custom fn). See `EmbeddingProvider.ts`.
 *
 * ## Lifecycle
 *
 *   - `get(query)` — embed the query, search HNSW for the nearest
 *     cached entry. If the top hit's cosine similarity ≥ `threshold`
 *     and the entry hasn't expired, return it (cache hit). Otherwise
 *     return `null` (cache miss).
 *   - `set(query, response)` — embed the query, store the entry in
 *     both HNSW and the metadata store.
 *   - `invalidate(query)` — remove entries whose query is similar to
 *     `query` (similarity ≥ `threshold`).
 *   - `clear()` — remove everything.
 *
 * ## Eviction
 *
 * When `maxSize` is reached, the LRU (least-recently-used) entry is
 * evicted before a new entry is added. "Recently used" = highest
 * `hitCount` + most recent `createdAt` (we use `createdAt` as a proxy
 * for last-access because updating the entry on every hit would be
 * expensive; the HNSW index does not track access time).
 *
 * ## TTL
 *
 * Entries expire `ttlMs` after creation. Expired entries are deleted
 * lazily on `get()` (when they would have been a hit) and can also
 * be purged in bulk via `purgeExpired()`.
 *
 * ## Thread safety
 *
 * All operations on the HNSW index and the metadata store are
 * sequenced through a per-cache mutex (promise chain) so concurrent
 * `get` / `set` calls do not race. Specifically:
 *
 *   - Concurrent `get`s can run in parallel (reads only).
 *   - Concurrent `set`s are serialized.
 *   - A `set` that overlaps a `get` will not corrupt the `get`'s
 *     result because HNSW's `search()` and `add()` are internally
 *     synchronous (no in-flight state).
 *
 * ## Events
 *
 * Extends `EventEmitter3`. Emits:
 *
 *   - `cache:hit`       — `{ id, query, similarity }`
 *   - `cache:miss`      — `{ query, reason: 'no_match' | 'expired' | 'no_embedding' }`
 *   - `cache:set`       — `{ id, query }`
 *   - `cache:invalidate`— `{ ids: string[] }`
 *   - `cache:evict`     — `{ id, reason: 'lru' | 'expired' | 'manual' }`
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { nanoid } from 'nanoid';
import type { HNSWIndex } from '@sanix/memory-v2';
import type { CacheEntry, CacheStats, EmbeddingProvider } from './types.js';
import type { CacheMetadataStore } from './CacheMetadataStore.js';

/** Cache event map. */
export interface SemanticCacheEvents {
  'cache:hit': (payload: { id: string; query: string; similarity: number }) => void;
  'cache:miss': (payload: {
    query: string;
    reason: 'no_match' | 'expired' | 'no_embedding';
  }) => void;
  'cache:set': (payload: { id: string; query: string }) => void;
  'cache:invalidate': (payload: { ids: string[] }) => void;
  'cache:evict': (payload: {
    id: string;
    reason: 'lru' | 'expired' | 'manual';
  }) => void;
}

/** Constructor options. */
export interface SemanticCacheOptions {
  /** Pre-configured HNSW vector index. Required. */
  vectorIndex: HNSWIndex;
  /** Embedding provider (used to embed queries on `get` / `set`). */
  embeddingProvider?: EmbeddingProvider;
  /**
   * Cosine-similarity threshold above which a cached entry is
   * considered a hit. Default 0.92.
   */
  threshold?: number;
  /** TTL in milliseconds. Default 24h (86_400_000). */
  ttlMs?: number;
  /** Max number of entries before LRU eviction kicks in. Default 10_000. */
  maxSize?: number;
  /** Optional persistent metadata store. When absent, in-memory only. */
  metadataStore?: CacheMetadataStore;
  /**
   * Whether to autoload entries from the metadata store on
   * construction. Default true. (The HNSW index must be loaded
   * separately by the caller via `HNSWIndex.load()` before
   * constructing the cache, so this option only affects whether the
   * cache rebuilds its in-memory id→entry map from the metadata
   * store.)
   */
  autoload?: boolean;
}

/** Get options. */
export interface CacheGetOptions {
  /** Override the constructor's `threshold` for this call. */
  threshold?: number;
}

/** Set options. */
export interface CacheSetOptions {
  /** Caller-supplied metadata, stored with the entry. */
  metadata?: Record<string, unknown>;
  /** Provider that produced the cached response. */
  provider?: string;
  /** Model that produced the cached response. */
  model?: string;
  /** Tokens used by the original (cache-miss) call. */
  tokensUsed?: number;
  /** Cost in USD of the original (cache-miss) call. */
  costUsd?: number;
}

/**
 * Embedding-based LLM response cache.
 *
 * @example
 * ```ts
 * const cache = new SemanticCache({
 *   vectorIndex: hnsw,
 *   embeddingProvider: xenovaProvider,
 *   threshold: 0.92,
 *   ttlMs: 6 * 3600 * 1000, // 6h
 * });
 *
 * const hit = await cache.get('How do I authenticate?');
 * if (hit) {
 *   console.log('cache hit:', hit.response);
 * } else {
 *   const response = await llm.chat(...);
 *   await cache.set('How do I authenticate?', response);
 * }
 * ```
 */
export class SemanticCache extends EventEmitter<SemanticCacheEvents> {
  private readonly vectorIndex: HNSWIndex;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly threshold: number;
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly metadataStore?: CacheMetadataStore;
  /** In-memory id→entry map (mirrors the metadata store, if present). */
  private readonly entries = new Map<string, CacheEntry>();
  /** Rolling stats. */
  private hits = 0;
  private misses = 0;
  private tokensSaved = 0;
  private costSavedUsd = 0;
  private queryTimeSum = 0;
  private queryTimeCount = 0;
  private cacheTimeSum = 0;
  private cacheTimeCount = 0;
  /** Promise chain used as a mutex for write operations. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: SemanticCacheOptions) {
    super();
    this.vectorIndex = opts.vectorIndex;
    this.embeddingProvider = opts.embeddingProvider;
    this.threshold = opts.threshold ?? 0.92;
    this.ttlMs = opts.ttlMs ?? 86_400_000;
    this.maxSize = opts.maxSize ?? 10_000;
    this.metadataStore = opts.metadataStore;
    if (opts.autoload !== false && this.metadataStore) {
      this.autoload();
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Look up `query` in the cache. Returns the matching {@link
   * CacheEntry} if a similar-enough cached query exists and hasn't
   * expired; `null` otherwise.
   *
   * @example
   * ```ts
   * const hit = await cache.get('How do I authenticate?');
   * if (hit) console.log(hit.response);
   * ```
   */
  async get(
    query: string,
    opts: CacheGetOptions = {},
  ): Promise<CacheEntry | null> {
    const threshold = opts.threshold ?? this.threshold;
    const start = Date.now();

    if (!this.embeddingProvider) {
      this.misses++;
      this.emit('cache:miss', { query, reason: 'no_embedding' });
      return null;
    }
    let emb: Float32Array | null;
    try {
      emb = await this.embeddingProvider.embed(query);
    } catch {
      emb = null;
    }
    if (!emb) {
      this.misses++;
      this.emit('cache:miss', { query, reason: 'no_embedding' });
      return null;
    }

    // Search HNSW for the top-1 nearest cached entry.
    const results = this.vectorIndex.search(emb, 1);
    if (results.length === 0) {
      this.recordMiss(start, query, 'no_match');
      return null;
    }
    const top = results[0]!;
    const similarity = 1 - top.distance; // HNSW distance = 1 - cos(θ)
    if (similarity < threshold) {
      this.recordMiss(start, query, 'no_match');
      return null;
    }
    const entry = this.entries.get(top.id);
    if (!entry) {
      // HNSW has the id but our map doesn't (desync). Treat as miss.
      this.recordMiss(start, query, 'no_match');
      return null;
    }
    // TTL check.
    if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
      // Lazy eviction: delete the expired entry.
      await this.evict(entry.id, 'expired');
      this.recordMiss(start, query, 'expired');
      return null;
    }
    // Hit!
    entry.hitCount++;
    this.hits++;
    if (entry.tokensUsed) this.tokensSaved += entry.tokensUsed;
    if (entry.costUsd) this.costSavedUsd += entry.costUsd;
    this.cacheTimeSum += Date.now() - start;
    this.cacheTimeCount++;
    // Persist the updated hitCount to the metadata store (best-effort).
    if (this.metadataStore) {
      this.metadataStore.set(entry).catch(() => undefined);
    }
    this.emit('cache:hit', { id: entry.id, query, similarity });
    return entry;
  }

  /**
   * Store a cached response for `query`. Embeds the query, creates a
   * {@link CacheEntry}, adds it to HNSW + the metadata store, and
   * evicts the LRU entry if `maxSize` is exceeded.
   *
   * @example
   * ```ts
   * await cache.set('How do I authenticate?', 'JWT auth works by...', {
   *   provider: 'anthropic', tokensUsed: 542,
   * });
   * ```
   */
  async set(
    query: string,
    response: string,
    opts: CacheSetOptions = {},
  ): Promise<void> {
    return this.serialize(async () => {
      if (!this.embeddingProvider) return;
      let emb: Float32Array | null;
      try {
        emb = await this.embeddingProvider.embed(query);
      } catch {
        return;
      }
      if (!emb) return;

      const now = Date.now();
      const id = nanoid();
      const entry: CacheEntry = {
        id,
        query,
        queryEmbedding: emb,
        response,
        metadata: opts.metadata ?? {},
        createdAt: now,
        expiresAt: this.ttlMs > 0 ? now + this.ttlMs : 0,
        hitCount: 0,
        provider: opts.provider,
        model: opts.model,
        tokensUsed: opts.tokensUsed,
        costUsd: opts.costUsd,
      };

      // Evict LRU if at capacity.
      if (this.entries.size >= this.maxSize) {
        const lru = this.pickLru();
        if (lru) await this.evict(lru, 'lru');
      }

      this.entries.set(id, entry);
      this.vectorIndex.add(id, emb, { query });
      if (this.metadataStore) {
        await this.metadataStore.set(entry);
      }
      this.emit('cache:set', { id, query });
    });
  }

  /**
   * Invalidate (delete) all entries whose query is similar to
   * `query` (cosine similarity ≥ `threshold`). Useful when the
   * underlying data has changed and old cache entries are stale.
   *
   * @example
   * ```ts
   * // Docs were updated — blow away stale auth-related cache entries.
   * await cache.invalidate('How do I authenticate?');
   * ```
   */
  async invalidate(query: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.embeddingProvider) return;
      let emb: Float32Array | null;
      try {
        emb = await this.embeddingProvider.embed(query);
      } catch {
        return;
      }
      if (!emb) return;

      // Search for ALL entries above threshold (not just top-1). HNSW
      // doesn't support "all above threshold" natively, so we pull a
      // generous k and filter.
      const k = Math.min(this.entries.size, 100);
      if (k === 0) return;
      const results = this.vectorIndex.search(emb, k);
      const ids: string[] = [];
      for (const r of results) {
        const sim = 1 - r.distance;
        if (sim < this.threshold) continue;
        ids.push(r.id);
      }
      for (const id of ids) {
        await this.evict(id, 'manual');
      }
      if (ids.length > 0) this.emit('cache:invalidate', { ids });
    });
  }

  /**
   * Remove all entries from the cache (HNSW + metadata store + in-
   * memory map).
   */
  async clear(): Promise<void> {
    return this.serialize(async () => {
      const ids = Array.from(this.entries.keys());
      for (const id of ids) {
        this.vectorIndex.remove(id);
      }
      this.entries.clear();
      if (this.metadataStore) {
        await this.metadataStore.clear();
      }
    });
  }

  /**
   * Purge all expired entries. Returns the number purged.
   */
  async purgeExpired(): Promise<number> {
    return this.serialize(async () => {
      const now = Date.now();
      let purged = 0;
      for (const [id, entry] of this.entries) {
        if (entry.expiresAt > 0 && entry.expiresAt <= now) {
          await this.evict(id, 'expired');
          purged++;
        }
      }
      // Also delegate to the metadata store's bulk-purge.
      if (this.metadataStore) {
        await this.metadataStore.deleteExpired(now);
      }
      return purged;
    });
  }

  /**
   * Snapshot of rolling cache stats.
   *
   * @example
   * ```ts
   * const stats = cache.stats();
   * console.log(`hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
   * ```
   */
  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      tokensSaved: this.tokensSaved,
      costSavedUsd: this.costSavedUsd,
      avgQueryTimeMs: this.queryTimeCount === 0 ? 0 : this.queryTimeSum / this.queryTimeCount,
      avgCacheTimeMs: this.cacheTimeCount === 0 ? 0 : this.cacheTimeSum / this.cacheTimeCount,
    };
  }

  /** Number of entries currently in the cache. */
  size(): number {
    return this.entries.size;
  }

  // ─── Internal ───────────────────────────────────────────────────────

  /**
   * Evict a single entry from all backends. Emits `cache:evict`.
   */
  private async evict(
    id: string,
    reason: 'lru' | 'expired' | 'manual',
  ): Promise<void> {
    this.entries.delete(id);
    this.vectorIndex.remove(id);
    if (this.metadataStore) {
      await this.metadataStore.delete(id).catch(() => undefined);
    }
    this.emit('cache:evict', { id, reason });
  }

  /**
   * Pick the LRU entry id (the one to evict when `maxSize` is
   * reached). The LRU heuristic is the entry with the lowest
   * `hitCount`; ties are broken by oldest `createdAt`.
   */
  private pickLru(): string | null {
    let lruId: string | null = null;
    let lruHits = Infinity;
    let lruCreated = Infinity;
    for (const [id, e] of this.entries) {
      if (
        e.hitCount < lruHits ||
        (e.hitCount === lruHits && e.createdAt < lruCreated)
      ) {
        lruHits = e.hitCount;
        lruCreated = e.createdAt;
        lruId = id;
      }
    }
    return lruId;
  }

  /**
   * Record a cache miss and update the average query time stats.
   */
  private recordMiss(
    start: number,
    query: string,
    reason: 'no_match' | 'expired' | 'no_embedding',
  ): void {
    this.misses++;
    this.queryTimeSum += Date.now() - start;
    this.queryTimeCount++;
    this.emit('cache:miss', { query, reason });
  }

  /**
   * Rebuild the in-memory id→entry map from the metadata store. The
   * HNSW index is NOT rebuilt here — the caller is responsible for
   * loading it via `HNSWIndex.load()` before constructing the cache.
   */
  private autoload(): void {
    if (!this.metadataStore) return;
    try {
      // The metadata store's `listOldestFirst()` returns all rows;
      // we reverse to get newest-first for insertion-order parity
      // with normal `set()` calls.
      const all = this.metadataStore.listOldestFirst().reverse();
      for (const entry of all) {
        this.entries.set(entry.id, entry);
      }
    } catch {
      // Swallow — autoload is best-effort.
    }
  }

  /**
   * Run `fn` under the write mutex. Reads (`get`) do not need to
   * lock (HNSW.search is synchronous), but writes (`set`,
   * `invalidate`, `clear`, `purgeExpired`) are sequenced to avoid
   * interleaving with each other.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

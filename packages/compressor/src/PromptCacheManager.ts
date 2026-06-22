/**
 * @file PromptCacheManager.ts
 * @description Tracks which prompt prefixes have been cached at the
 * provider level (Anthropic prompt cache, OpenAI automatic cache).
 *
 * Both Anthropic and OpenAI expose prompt caching: if you send the
 * same prompt prefix repeatedly, the provider caches it server-side
 * and bills subsequent uses at a steep discount (~10% of input price
 * for Anthropic, ~50% for OpenAI). The catch: the prefix must be
 * *identical* (byte-for-byte) across calls. A single character change
 * invalidates the cache from that point onward.
 *
 * This manager maintains a local LRU of cached prefixes keyed on
 * `{ providerId, prefixHash }`. The context builder queries it while
 * assembling a prompt: when two candidate prefixes would both fit, it
 * prefers the one that's already cached (maximizing cache hits).
 *
 * ## Hashing
 *
 * Prefixes are hashed with SHA-256 (Node's built-in `node:crypto`)
 * so the LRU keys stay small even for huge prefixes. The original
 * prefix text is *not* stored — only the hash, the token count, and
 * the registration timestamp.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A single cached-prefix entry. Stored in the LRU keyed on
 * `${providerId}:${prefixHash}`.
 */
export interface CachedPrefixEntry {
  /** The provider this prefix was cached on (e.g. 'anthropic', 'openai'). */
  providerId: string;
  /** SHA-256 hash of the prefix text. */
  prefixHash: string;
  /** When the prefix was first registered (Unix millis). */
  cachedAt: number;
  /** Approximate token count of the prefix. */
  tokens: number;
}

/**
 * Stats returned by {@link PromptCacheManager.stats}.
 */
export interface PromptCacheStats {
  /** Total entries in the LRU. */
  totalEntries: number;
  /** Total cached tokens across all entries. */
  totalCachedTokens: number;
  /** Cache hit rate (hits / (hits + misses)) since last reset. */
  hitRate: number;
}

// ─── LRU ────────────────────────────────────────────────────────────────────

/**
 * Bounded LRU cache. Uses `Map`'s insertion-order preservation for
 * eviction.
 */
class LruCache<K, V> {
  private readonly store: Map<K, V> = new Map();
  private readonly capacity: number;
  private hits = 0;
  private misses = 0;

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error(`LruCache capacity must be >= 1 (got ${capacity})`);
    }
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const v = this.store.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, v);
    this.hits++;
    return v;
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, value);
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  values(): IterableIterator<V> {
    return this.store.values();
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.store.size;
  }

  get hitCount(): number {
    return this.hits;
  }

  get missCount(): number {
    return this.misses;
  }
}

// ─── PromptCacheManager ─────────────────────────────────────────────────────

/**
 * Tracks which prompt prefixes have been cached at the provider level.
 *
 * Used by the context builder to maximize cache hits — when building
 * a prompt, prefer prefixes that are already cached.
 *
 * @example
 * ```ts
 * import { PromptCacheManager } from '@sanix/compressor';
 *
 * const cache = new PromptCacheManager();
 * cache.registerCachedPrefix('anthropic', systemPrompt, 1200);
 *
 * if (cache.isCached('anthropic', systemPrompt)) {
 *   // Mark this prefix with `cache_control: { type: 'ephemeral' }`
 *   // in the Anthropic adapter request.
 * }
 *
 * const longest = cache.findLongestCachedPrefix('anthropic', fullPrompt);
 * if (longest) {
 *   console.log(`Reusing ${longest.tokens}-token cached prefix`);
 * }
 * ```
 */
export class PromptCacheManager {
  /**
   * LRU keyed on `${providerId}:${prefixHash}`. The default capacity
   * (256) covers a typical multi-provider session (4 providers × 64
   * distinct prefixes per provider) without bloating memory.
   */
  private readonly cache: LruCache<string, CachedPrefixEntry>;

  /**
   * @param capacity - Maximum entries. Default 256.
   */
  constructor(capacity: number = 256) {
    this.cache = new LruCache<string, CachedPrefixEntry>(capacity);
  }

  /**
   * Register a prefix as cached on the given provider. Idempotent —
   * re-registering the same prefix updates `cachedAt` but doesn't
   * duplicate the entry.
   *
   * @param providerId - The provider id (e.g. 'anthropic', 'openai').
   * @param prefix - The prefix text (will be hashed, not stored).
   * @param tokens - Approximate token count of the prefix.
   */
  registerCachedPrefix(providerId: string, prefix: string, tokens: number): void {
    const prefixHash = sha256(prefix);
    const key = `${providerId}:${prefixHash}`;
    this.cache.set(key, {
      providerId,
      prefixHash,
      cachedAt: Date.now(),
      tokens,
    });
  }

  /**
   * Check whether a specific prefix is cached on the given provider.
   *
   * @param providerId - The provider id.
   * @param prefix - The prefix text.
   * @returns True if the prefix is in the cache.
   */
  isCached(providerId: string, prefix: string): boolean {
    const prefixHash = sha256(prefix);
    const key = `${providerId}:${prefixHash}`;
    return this.cache.has(key);
  }

  /**
   * Find the longest cached prefix that appears at the *start* of
   * `prompt`. Walks the cache entries for `providerId` and finds the
   * one whose prefix text is a byte-prefix of `prompt`, returning the
   * longest match (by token count).
   *
   * Because we only store the hash (not the text), this method
   * requires the caller to supply candidate prefixes via the optional
   * `candidates` argument. When `candidates` is omitted, the method
   * returns the longest registered entry for `providerId` (by token
   * count) — useful as a hint that *some* cached prefix exists, even
   * if we can't verify it byte-matches.
   *
   * @param providerId - The provider id.
   * @param prompt - The full prompt text.
   * @param candidates - Optional list of candidate prefix texts to
   *   test against the cache. When provided, only prefixes that are
   *   (a) in the cache AND (b) a byte-prefix of `prompt` are
   *   considered. When omitted, returns the longest registered entry
   *   for the provider.
   * @returns The longest matching cached prefix info, or `null` if
   *   none match.
   */
  findLongestCachedPrefix(
    providerId: string,
    prompt: string,
    candidates?: ReadonlyArray<string>,
  ): { prefix: string; tokens: number } | null {
    if (candidates && candidates.length > 0) {
      let best: { prefix: string; tokens: number } | null = null;
      for (const candidate of candidates) {
        if (!prompt.startsWith(candidate)) continue;
        if (!this.isCached(providerId, candidate)) continue;
        const hash = sha256(candidate);
        const entry = this.cache.get(`${providerId}:${hash}`);
        if (!entry) continue;
        if (best === null || entry.tokens > best.tokens) {
          best = { prefix: candidate, tokens: entry.tokens };
        }
      }
      return best;
    }
    // No candidates supplied: find the longest registered entry for
    // this provider.
    let best: { prefix: string; tokens: number } | null = null;
    // Note: we can't reconstruct the prefix text from the hash, so we
    // return only the token count. Callers that need the prefix text
    // must supply `candidates`.
    let bestTokens = 0;
    for (const entry of this.cache.values()) {
      if (entry.providerId !== providerId) continue;
      if (entry.tokens > bestTokens) {
        bestTokens = entry.tokens;
        best = { prefix: '', tokens: entry.tokens };
      }
    }
    return best;
  }

  /**
   * Return cache stats.
   */
  stats(): PromptCacheStats {
    let totalCachedTokens = 0;
    for (const entry of this.cache.values()) {
      totalCachedTokens += entry.tokens;
    }
    const hits = this.cache.hitCount;
    const misses = this.cache.missCount;
    const total = hits + misses;
    const hitRate = total === 0 ? 0 : hits / total;
    return {
      totalEntries: this.cache.size,
      totalCachedTokens,
      hitRate,
    };
  }

  /**
   * Clear all entries. Useful in tests or after switching providers.
   */
  clear(): void {
    this.cache.clear();
  }

  /** Current entry count. */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * SHA-256 hash a string, returned as hex.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

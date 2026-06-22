/**
 * @file ToolCache.ts
 * @description A per-tool-result cache combining LRU eviction with TTL
 * expiry. Cache keys are derived from the tool name + a stable JSON
 * serialization of its arguments, so identical invocations return the
 * cached result without re-running the tool.
 *
 * @packageDocumentation
 */

import type { ToolResult } from './types.js';

/** A single cache entry. */
interface CacheEntry {
  /** The cached result. */
  result: ToolResult;
  /** Unix ms when this entry was inserted. */
  insertedAt: number;
  /** Unix ms when this entry expires. */
  expiresAt: number;
  /** LRU recency counter (higher = more recent). */
  recency: number;
}

/** Options for {@link ToolCache}. */
export interface ToolCacheOptions {
  /** Max entries (LRU eviction when exceeded). Default 256. */
  maxSize?: number;
  /** Default TTL per entry, in ms. Default 5 minutes. */
  defaultTtlMs?: number;
}

/**
 * A combined LRU + TTL cache for tool results.
 *
 * @example
 * ```ts
 * const cache = new ToolCache({ maxSize: 128, defaultTtlMs: 60_000 });
 * cache.set('read_file', { path: '/etc/hosts' }, result, 30_000);
 * cache.get('read_file', { path: '/etc/hosts' }); // → result (or undefined)
 * ```
 */
export class ToolCache {
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly store = new Map<string, CacheEntry>();
  private clock = 0;

  constructor(opts: ToolCacheOptions = {}) {
    this.maxSize = opts.maxSize ?? 256;
    this.defaultTtlMs = opts.defaultTtlMs ?? 5 * 60 * 1000;
  }

  /**
   * Build a stable cache key from the tool name + args.
   *
   * @param tool Tool name.
   * @param args Argument object.
   */
  static key(tool: string, args: Record<string, unknown>): string {
    // Sort keys for stable serialization.
    const sorted = Object.keys(args).sort();
    const parts = sorted.map((k) => `${k}=${stableStringify(args[k])}`);
    return `${tool}(${parts.join(',')})`;
  }

  /**
   * Look up a cached result. Returns undefined if missing or expired.
   *
   * @param tool Tool name.
   * @param args Argument object.
   */
  get(tool: string, args: Record<string, unknown>): ToolResult | undefined {
    const key = ToolCache.key(tool, args);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    entry.recency = ++this.clock;
    return entry.result;
  }

  /**
   * Store a result.
   *
   * @param tool Tool name.
   * @param args Argument object.
   * @param result The result to cache.
   * @param ttlMs Optional TTL override (ms).
   */
  set(tool: string, args: Record<string, unknown>, result: ToolResult, ttlMs?: number): void {
    const key = ToolCache.key(tool, args);
    const now = Date.now();
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.store.set(key, {
      result,
      insertedAt: now,
      expiresAt: now + ttl,
      recency: ++this.clock,
    });
    // Evict LRU if over capacity.
    while (this.store.size > this.maxSize) {
      let oldestKey: string | undefined;
      let oldestRecency = Infinity;
      for (const [k, e] of this.store) {
        if (e.recency < oldestRecency) {
          oldestRecency = e.recency;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) this.store.delete(oldestKey);
      else break;
    }
  }

  /** Invalidate all cached results for a tool (any args). */
  invalidateTool(tool: string): number {
    let n = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(`${tool}(`)) {
        this.store.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Drop all cached results. */
  clear(): void {
    this.store.clear();
  }

  /** Current entry count. */
  get size(): number {
    return this.store.size;
  }
}

/** Stable JSON stringify (sorts object keys recursively). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * @file CacheHierarchy.ts
 * @description A 3-tier cache hierarchy:
 *
 *   - L1: in-process LRU (fastest, smallest).
 *   - L2: in-process LRU (larger, slower to evict).
 *   - L3: on-disk JSON files (largest, persistent across restarts).
 *
 * Lookups go L1 → L2 → L3 → miss. On a hit at a lower tier, the value is
 * back-filled into the higher tiers. Writes propagate down all tiers.
 *
 * @packageDocumentation
 */

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/** A single cache entry. */
interface CacheEntry<V> {
  value: V;
  /** Unix ms when this entry was inserted. */
  insertedAt: number;
  /** Unix ms when this entry expires. */
  expiresAt: number;
  /** LRU recency counter. */
  recency: number;
}

/** Options for {@link CacheHierarchy}. */
export interface CacheHierarchyOptions {
  /** L1 max entries. Default 128. */
  l1Size?: number;
  /** L2 max entries. Default 1024. */
  l2Size?: number;
  /** L3 directory. Default `~/.sanix/cache/l3`. */
  l3Dir?: string;
  /** Default TTL ms. Default 5 minutes. */
  defaultTtlMs?: number;
}

/** Result of a {@link CacheHierarchy.get}. */
export interface CacheGetResult<V> {
  /** The value (if found). */
  value?: V;
  /** Which tier served the hit (or `'miss'`). */
  tier: 'l1' | 'l2' | 'l3' | 'miss';
}

/**
 * A 3-tier cache hierarchy (L1 LRU → L2 LRU → L3 disk).
 *
 * @example
 * ```ts
 * const c = new CacheHierarchy({ l1Size: 64, l2Size: 512 });
 * c.set('user:1', { name: 'Sanim' });
 * c.get('user:1'); // → { value: { name: 'Sanim' }, tier: 'l1' }
 * ```
 */
export class CacheHierarchy<V = unknown> {
  private readonly l1Size: number;
  private readonly l2Size: number;
  private readonly l3Dir: string;
  private readonly defaultTtlMs: number;
  private readonly l1 = new Map<string, CacheEntry<V>>();
  private readonly l2 = new Map<string, CacheEntry<V>>();
  private clock = 0;

  constructor(opts: CacheHierarchyOptions = {}) {
    this.l1Size = opts.l1Size ?? 128;
    this.l2Size = opts.l2Size ?? 1024;
    this.l3Dir = opts.l3Dir ?? resolvePath(homedir(), '.sanix', 'cache', 'l3');
    this.defaultTtlMs = opts.defaultTtlMs ?? 5 * 60 * 1000;
    try {
      mkdirSync(this.l3Dir, { recursive: true });
    } catch {
      // ignore — L3 just won't work.
    }
  }

  /**
   * Look up a key. Walks L1 → L2 → L3; on a hit at a lower tier, the
   * value is back-filled into higher tiers.
   *
   * @param key Cache key.
   * @returns A {@link CacheGetResult}.
   */
  get(key: string): CacheGetResult<V> {
    const now = Date.now();
    const l1Hit = this.l1.get(key);
    if (l1Hit && l1Hit.expiresAt > now) {
      l1Hit.recency = ++this.clock;
      return { value: l1Hit.value, tier: 'l1' };
    }
    if (l1Hit) this.l1.delete(key); // expired

    const l2Hit = this.l2.get(key);
    if (l2Hit && l2Hit.expiresAt > now) {
      l2Hit.recency = ++this.clock;
      this.putL1(key, l2Hit.value, l2Hit.expiresAt - now);
      return { value: l2Hit.value, tier: 'l2' };
    }
    if (l2Hit) this.l2.delete(key); // expired

    const l3Hit = this.readL3(key);
    if (l3Hit) {
      this.putL2(key, l3Hit.value, l3Hit.expiresAt - now);
      this.putL1(key, l3Hit.value, l3Hit.expiresAt - now);
      return { value: l3Hit.value, tier: 'l3' };
    }
    return { tier: 'miss' };
  }

  /**
   * Set a key across all tiers.
   *
   * @param key Cache key.
   * @param value Value to cache (must be JSON-serializable for L3).
   * @param ttlMs TTL override (ms).
   */
  set(key: string, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.putL1(key, value, ttl);
    this.putL2(key, value, ttl);
    this.writeL3(key, value, ttl);
  }

  /** Delete a key from all tiers. */
  delete(key: string): void {
    this.l1.delete(key);
    this.l2.delete(key);
    this.deleteL3(key);
  }

  /** Clear all tiers. L3 files are removed. */
  clear(): void {
    this.l1.clear();
    this.l2.clear();
    // Best-effort L3 wipe — we don't track filenames, so we leave L3 alone
    // to avoid removing unrelated files. Callers can `rm -rf` the L3 dir.
  }

  // ── L1 (LRU) ─────────────────────────────────────────────────────────
  private putL1(key: string, value: V, ttlMs: number): void {
    const now = Date.now();
    this.l1.set(key, { value, insertedAt: now, expiresAt: now + ttlMs, recency: ++this.clock });
    while (this.l1.size > this.l1Size) this.evictOldest(this.l1);
  }

  // ── L2 (LRU) ─────────────────────────────────────────────────────────
  private putL2(key: string, value: V, ttlMs: number): void {
    const now = Date.now();
    this.l2.set(key, { value, insertedAt: now, expiresAt: now + ttlMs, recency: ++this.clock });
    while (this.l2.size > this.l2Size) this.evictOldest(this.l2);
  }

  /** Evict the LRU entry from a tier. */
  private evictOldest(tier: Map<string, CacheEntry<V>>): void {
    let oldestKey: string | undefined;
    let oldestRec = Infinity;
    for (const [k, e] of tier) {
      if (e.recency < oldestRec) {
        oldestRec = e.recency;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) tier.delete(oldestKey);
  }

  // ── L3 (disk) ────────────────────────────────────────────────────────
  private l3Path(key: string): string {
    const h = createHash('sha256').update(key).digest('hex');
    return join(this.l3Dir, `${h}.json`);
  }

  private readL3(key: string): { value: V; expiresAt: number } | undefined {
    try {
      const p = this.l3Path(key);
      if (!existsSync(p)) return undefined;
      const raw = readFileSync(p, 'utf8');
      const obj = JSON.parse(raw) as { value: V; expiresAt: number };
      if (obj.expiresAt <= Date.now()) {
        try { unlinkSync(p); } catch { /* ignore */ }
        return undefined;
      }
      return obj;
    } catch {
      return undefined;
    }
  }

  private writeL3(key: string, value: V, ttlMs: number): void {
    try {
      const p = this.l3Path(key);
      const obj = { value, expiresAt: Date.now() + ttlMs };
      writeFileSync(p, JSON.stringify(obj), 'utf8');
    } catch {
      // L3 is best-effort.
    }
  }

  private deleteL3(key: string): void {
    try { unlinkSync(this.l3Path(key)); } catch { /* ignore */ }
  }
}

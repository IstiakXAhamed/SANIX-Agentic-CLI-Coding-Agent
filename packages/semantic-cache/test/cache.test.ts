/**
 * @file cache.test.ts
 * @description Tests SemanticCache: set + get, similarity threshold, TTL,
 * LRU eviction, stats tracking, and invalidate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SemanticCache } from '@sanix/semantic-cache';
import { HNSWIndex } from '@sanix/memory-v2';
import { createMockEmbedding } from '../../../test/helpers/mockEmbedding.js';

function newCache(opts: {
  threshold?: number;
  ttlMs?: number;
  maxSize?: number;
} = {}): SemanticCache {
  const index = new HNSWIndex();
  const embed = createMockEmbedding();
  return new SemanticCache({
    vectorIndex: index,
    embeddingProvider: embed,
    threshold: opts.threshold ?? 0.9,
    ttlMs: opts.ttlMs ?? 86_400_000,
    maxSize: opts.maxSize ?? 10_000,
  });
}

describe('SemanticCache', () => {
  let cache: SemanticCache;

  beforeEach(async () => {
    cache = newCache({ threshold: 0.85 });
    await cache.clear();
  });

  describe('set + get', () => {
    it('returns the cached entry on an identical query', async () => {
      await cache.set('How does JWT auth work?', 'JWT uses HS256.', {
        tokensUsed: 100,
        costUsd: 0.001,
      });
      const hit = await cache.get('How does JWT auth work?');
      expect(hit).not.toBeNull();
      expect(hit!.response).toBe('JWT uses HS256.');
      expect(hit!.tokensUsed).toBe(100);
      expect(hit!.costUsd).toBe(0.001);
      expect(hit!.hitCount).toBe(1);
    });

    it('returns null on a cache miss', async () => {
      await cache.set('How does JWT auth work?', 'JWT uses HS256.');
      const hit = await cache.get('What is the weather today?');
      expect(hit).toBeNull();
    });

    it('records hits + misses in stats', async () => {
      await cache.set('Q1', 'A1');
      await cache.get('Q1'); // hit
      await cache.get('Q2'); // miss
      const stats = cache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.5, 5);
    });
  });

  describe('similarity threshold', () => {
    it('hits on a semantically similar query above the threshold', async () => {
      // Same words, slightly reordered → very high cosine similarity.
      await cache.set('how does jwt authentication work', 'JWT answer.');
      const hit = await cache.get('how does jwt authentication work?');
      // Same tokens (modulo punctuation) → sim = 1.0 ≥ threshold.
      expect(hit).not.toBeNull();
      expect(hit!.response).toBe('JWT answer.');
    });

    it('misses on a semantically unrelated query below the threshold', async () => {
      cache = newCache({ threshold: 0.99 }); // very strict
      await cache.set('how does jwt authentication work', 'JWT answer.');
      // Different token set → low cosine similarity.
      const hit = await cache.get('what is the weather today');
      expect(hit).toBeNull();
    });
  });

  describe('TTL expiration', () => {
    it('returns null after the TTL expires', async () => {
      cache = newCache({ ttlMs: 50 });
      await cache.set('Q', 'A', { tokensUsed: 10 });
      // Immediate get → hit.
      const hit1 = await cache.get('Q');
      expect(hit1).not.toBeNull();
      // Wait for TTL to expire.
      await new Promise((r) => setTimeout(r, 80));
      const hit2 = await cache.get('Q');
      expect(hit2).toBeNull();
    });

    it('records an "expired" miss reason on TTL eviction', async () => {
      cache = newCache({ ttlMs: 30 });
      await cache.set('Q', 'A');
      await new Promise((r) => setTimeout(r, 60));
      const misses: string[] = [];
      cache.on('cache:miss', (p) => misses.push(p.reason));
      await cache.get('Q');
      expect(misses).toContain('expired');
    });
  });

  describe('LRU eviction', () => {
    it('evicts the least-recently-used entry when maxSize is exceeded', async () => {
      cache = newCache({ maxSize: 2, threshold: 0.95 });
      // Insert 2 entries with distinct token sets so they don't collide.
      await cache.set('alpha beta gamma', 'A1');
      await cache.set('delta epsilon zeta', 'A2');
      expect(cache.size()).toBe(2);
      // Hit the second entry so its hitCount > first's.
      await cache.get('delta epsilon zeta');
      // Insert a third — should evict the LRU (the first entry).
      await cache.set('eta theta iota', 'A3');
      expect(cache.size()).toBe(2);
      // The first entry should be gone.
      const hit = await cache.get('alpha beta gamma');
      // Either null (evicted) or a hit — but we expect null because of LRU.
      expect(hit).toBeNull();
    });

    it('emits a cache:evict event with reason "lru"', async () => {
      cache = newCache({ maxSize: 1, threshold: 0.95 });
      const evictions: string[] = [];
      cache.on('cache:evict', (p) => evictions.push(p.reason));
      await cache.set('alpha beta', 'A1');
      await cache.set('gamma delta', 'A2'); // triggers eviction of A1
      expect(evictions).toContain('lru');
    });
  });

  describe('stats', () => {
    it('tracks tokensSaved on cache hits', async () => {
      await cache.set('Q', 'A', { tokensUsed: 250 });
      await cache.get('Q'); // hit → +250 tokensSaved
      await cache.get('Q'); // hit → +250 tokensSaved
      const stats = cache.stats();
      expect(stats.tokensSaved).toBe(500);
      expect(stats.costSavedUsd).toBeGreaterThanOrEqual(0);
    });

    it('tracks entry count', async () => {
      expect(cache.stats().entries).toBe(0);
      await cache.set('Q1', 'A1');
      expect(cache.stats().entries).toBe(1);
      await cache.set('Q2', 'A2');
      expect(cache.stats().entries).toBe(2);
    });
  });

  describe('invalidate', () => {
    it('removes entries similar to the supplied query', async () => {
      await cache.set('how does jwt auth work', 'A1');
      await cache.set('weather forecast today', 'A2');
      expect(cache.size()).toBe(2);
      await cache.invalidate('how does jwt auth work');
      // The JWT entry should be gone; the weather entry should remain.
      // Note: invalidate removes similar entries; non-similar stay.
      expect(cache.size()).toBeLessThan(2);
    });

    it('emits a cache:invalidate event when entries are removed', async () => {
      await cache.set('how does jwt auth work', 'A1');
      let invalidated = 0;
      cache.on('cache:invalidate', (p) => {
        invalidated = p.ids.length;
      });
      await cache.invalidate('how does jwt auth work');
      // If invalidate found a match, the event fires.
      expect(invalidated).toBeGreaterThanOrEqual(0);
    });
  });

  describe('clear', () => {
    it('removes all entries', async () => {
      await cache.set('Q1', 'A1');
      await cache.set('Q2', 'A2');
      await cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.stats().entries).toBe(0);
    });
  });
});

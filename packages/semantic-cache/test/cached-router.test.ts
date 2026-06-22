/**
 * @file cached-router.test.ts
 * @description Tests CachedProviderRouter: cache hit on second call,
 * streaming bypass, tools bypass, and stats accumulation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRouter } from '@sanix/providers';
import type { LLMRequest, ToolDef } from '@sanix/providers';
import { CachedProviderRouter } from '@sanix/semantic-cache';
import { SemanticCache } from '@sanix/semantic-cache';
import { HNSWIndex } from '@sanix/memory-v2';
import { createMockProvider } from '../../../test/helpers/mockProvider.js';
import { createMockEmbedding } from '../../../test/helpers/mockEmbedding.js';

function newCachedRouter(opts: {
  responses?: string[] | ((req: LLMRequest) => string);
  threshold?: number;
} = {}): {
  router: CachedProviderRouter;
  cache: SemanticCache;
  provider: ReturnType<typeof createMockProvider>;
} {
  const provider = createMockProvider({
    responses: opts.responses ?? 'default-answer',
    id: 'mock',
    usage: { inputTokens: 50, outputTokens: 50 },
    costUsd: 0.001,
  });
  const router = new ProviderRouter({ providers: [provider] });
  const cache = new SemanticCache({
    vectorIndex: new HNSWIndex(),
    embeddingProvider: createMockEmbedding(),
    threshold: opts.threshold ?? 0.85,
  });
  const cached = new CachedProviderRouter(router, cache);
  return { router: cached, cache, provider };
}

function userMsg(content: string): LLMRequest {
  return { messages: [{ role: 'user', content }] };
}

describe('CachedProviderRouter', () => {
  let setup: ReturnType<typeof newCachedRouter>;

  beforeEach(() => {
    setup = newCachedRouter({
      responses: 'hello-from-llm',
    });
  });

  describe('cache hit on second call', () => {
    it('returns the cached response on a semantically-similar second call', async () => {
      const { router, provider } = setup;
      const r1 = await router.route(userMsg('What is JWT auth?'));
      expect(r1.content).toBe('hello-from-llm');
      expect(provider.callCount).toBe(1);

      // Second call: identical query (after normalization).
      const r2 = await router.route(userMsg('What is JWT auth?'));
      expect(r2.content).toBe('hello-from-llm');
      // Provider NOT called the second time — cache hit.
      expect(provider.callCount).toBe(1);
      // The synthesized response carries the cacheHit flag.
      expect(r2.cacheHit).toBe(true);
      expect(r2.stopReason).toBe('cache_hit');
    });

    it('does not cache when there is no user message', async () => {
      const { router, provider } = setup;
      const req: LLMRequest = {
        messages: [{ role: 'system', content: 'system-only' }],
      };
      await router.route(req);
      // System-only message → no cache key → straight to provider.
      expect(provider.callCount).toBe(1);
    });
  });

  describe('streaming bypass', () => {
    it('bypasses the cache for streaming requests', async () => {
      const { router, provider } = setup;
      await router.route({ ...userMsg('streaming question'), stream: true });
      await router.route({ ...userMsg('streaming question'), stream: true });
      // Both calls hit the provider (streaming not cached).
      expect(provider.callCount).toBe(2);
    });
  });

  describe('tools bypass', () => {
    it('bypasses the cache when the request carries tools', async () => {
      const { router, provider } = setup;
      const tool: ToolDef = {
        type: 'function',
        function: {
          name: 'search',
          description: 'search',
          parameters: { type: 'object', properties: {} },
        },
      };
      const req: LLMRequest = { ...userMsg('use tools'), tools: [tool] };
      await router.route(req);
      await router.route(req);
      // Both calls hit the provider (tool requests not cached).
      expect(provider.callCount).toBe(2);
    });
  });

  describe('stats accumulation', () => {
    it('accumulates hits + misses in cache.stats()', async () => {
      const { router, cache } = setup;
      await router.route(userMsg('Q1'));
      await router.route(userMsg('Q1')); // hit
      await router.route(userMsg('Q2')); // miss
      const stats = cache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
    });

    it('exposes stats via router.stats()', async () => {
      const { router } = setup;
      await router.route(userMsg('Q'));
      await router.route(userMsg('Q'));
      const stats = router.stats();
      expect(stats.hits).toBe(1);
    });
  });

  describe('invalidate', () => {
    it('removes cached entries via invalidate()', async () => {
      const { router, provider } = setup;
      await router.route(userMsg('How does auth work?'));
      expect(provider.callCount).toBe(1);
      await router.invalidate('How does auth work?');
      const r = await router.route(userMsg('How does auth work?'));
      // After invalidation, the next call is a miss → provider called again.
      expect(provider.callCount).toBe(2);
      expect(r.content).toBe('hello-from-llm');
    });
  });

  describe('long context bypass', () => {
    it('bypasses the cache for very long contexts', async () => {
      const { router, provider } = setup;
      const long = 'x'.repeat(200_000);
      await router.route(userMsg(long));
      await router.route(userMsg(long));
      // Both calls hit the provider (context too long to cache).
      expect(provider.callCount).toBe(2);
    });
  });

  describe('list + circuitBreaker passthrough', () => {
    it('exposes the underlying router.list()', () => {
      const { router } = setup;
      const list = router.list();
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe('mock');
    });

    it('exposes the underlying circuitBreaker', () => {
      const { router } = setup;
      expect(router.circuitBreaker).toBeDefined();
    });
  });
});

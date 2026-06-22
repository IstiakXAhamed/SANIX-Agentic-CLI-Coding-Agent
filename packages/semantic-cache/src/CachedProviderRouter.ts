/**
 * @file CachedProviderRouter.ts
 * @description Cache-aware wrapper around `ProviderRouter` from
 * `@sanix/providers`. Intercepts every `route()` call, checks the
 * semantic cache first, and only delegates to the underlying router
 * on a cache miss.
 *
 * ## When to cache
 *
 * Caching is skipped (the request goes straight to the underlying
 * router) for:
 *
 *   - **Streaming requests** (`req.stream === true`) — streaming
 *     responses cannot be meaningfully cached (the caller consumes
 *     them incrementally).
 *   - **Requests with tools** (`req.tools?.length > 0`) — tool-using
 *     responses are non-deterministic (the model decides which tool
 *     to call based on context, and tool outputs vary).
 *   - **Very long context** (> `skipCacheForLongContext` tokens, see
 *     constructor) — the cache key would be too specific to ever hit.
 *
 * ## Cache key
 *
 * The cache key is the **normalized last user message**: trimmed,
 * lowercased, and with punctuation stripped. This collapses
 * "What is JWT?" and "what is jwt" to the same key. The
 * normalization is intentionally light — heavy normalization would
 * mask semantically distinct queries.
 *
 * ## Cost tracking
 *
 * On a cache hit, the router still records the "would-have-been"
 * cost in the cache's stats (`tokensSaved`, `costSavedUsd`) — this
 * is what makes the cache useful for cost reporting. The original
 * provider's `costUsd` field is preserved on the returned
 * `LLMResponse` so downstream cost trackers see a non-zero value.
 *
 * @packageDocumentation
 */

import type {
  IProvider,
  LLMMessage,
  LLMRequest,
  LLMResponse,
} from '@sanix/providers';
import type { ProviderRouter } from '@sanix/providers';
import type { ContentBlock } from '@sanix/providers';
import type { SemanticCache } from './SemanticCache.js';
import type { CacheStats } from './types.js';

/** Constructor options. */
export interface CachedProviderRouterOptions {
  /**
   * Providers whose responses are eligible for caching. Default:
   * cache responses from every provider. Pass `['anthropic']` to
   * cache only Anthropic responses, for example.
   */
  cacheableProviders?: string[];
  /**
   * Skip caching for requests whose total message content exceeds
   * this many characters (approximated as tokens / 4). Default
   * 128_000 (≈32K tokens).
   */
  skipCacheForLongContext?: number;
  /**
   * Optional cost-per-million-tokens lookup used to estimate the
   * "would-have-been" cost on a cache hit. If absent, hit-cost is
   * recorded as 0.
   */
  costPerMillionTokens?: (providerId: string, model: string) => number;
}

/**
 * Cache-aware provider router.
 *
 * @example
 * ```ts
 * const router = new ProviderRouter({ providers: [claude, gpt4o] });
 * const cached = new CachedProviderRouter(router, semanticCache);
 *
 * // First call: cache miss → routes to underlying router → caches response.
 * const r1 = await cached.route({ messages: [{ role: 'user', content: 'What is JWT?' }] });
 *
 * // Second call: cache hit → returns cached response instantly.
 * const r2 = await cached.route({ messages: [{ role: 'user', content: 'what is jwt' }] });
 * ```
 */
export class CachedProviderRouter {
  private readonly router: ProviderRouter;
  private readonly cache: SemanticCache;
  private readonly cacheableProviders?: Set<string>;
  private readonly skipCacheForLongContext: number;
  private readonly costLookup?: (providerId: string, model: string) => number;

  constructor(
    router: ProviderRouter,
    cache: SemanticCache,
    opts: CachedProviderRouterOptions = {},
  ) {
    this.router = router;
    this.cache = cache;
    this.cacheableProviders = opts.cacheableProviders
      ? new Set(opts.cacheableProviders)
      : undefined;
    this.skipCacheForLongContext = opts.skipCacheForLongContext ?? 128_000;
    this.costLookup = opts.costPerMillionTokens;
  }

  /**
   * Route a request: check the cache, if miss delegate to the
   * underlying router and cache the response.
   *
   * @example
   * ```ts
   * const res = await cached.route({ messages, taskType: 'code' });
   * ```
   */
  async route(req: LLMRequest): Promise<LLMResponse> {
    // Decide whether this request is cacheable.
    const cacheable = this.isCacheable(req);

    if (cacheable) {
      const key = this.cacheKey(req);
      if (key) {
        const hit = await this.cache.get(key);
        if (hit) {
          // Synthesize an LLMResponse from the cached entry.
          return this.synthesizeResponse(hit.response, hit.provider, hit.model, hit.tokensUsed, hit.costUsd);
        }
        // Miss: call the underlying router, then cache the response.
        const res = await this.router.route(req);
        // Only cache text-only responses (no tool calls).
        if (!res.toolCalls) {
          const providerId = this.inferProviderId(req);
          const costUsd =
            res.costUsd ??
            this.estimateCost(providerId, res.model, res.usage.inputTokens + res.usage.outputTokens);
          await this.cache.set(key, res.content, {
            provider: providerId,
            model: res.model,
            tokensUsed: res.usage.inputTokens + res.usage.outputTokens,
            costUsd,
          }).catch(() => undefined);
        }
        return res;
      }
    }

    // Not cacheable — straight through.
    return this.router.route(req);
  }

  /**
   * Invalidate cache entries similar to `query`.
   */
  async invalidate(query: string): Promise<void> {
    await this.cache.invalidate(query);
  }

  /**
   * Snapshot of the underlying cache's stats.
   */
  stats(): CacheStats {
    return this.cache.stats();
  }

  // ─── Accessors passthrough ──────────────────────────────────────────

  /** Underlying router's provider list. */
  list(): IProvider[] {
    return this.router.list();
  }

  /** Underlying router's circuit breaker. */
  get circuitBreaker() {
    return this.router.circuitBreaker;
  }

  // ─── Internal ───────────────────────────────────────────────────────

  /**
   * Determine whether `req` is eligible for caching. See file header.
   */
  private isCacheable(req: LLMRequest): boolean {
    if (req.stream) return false;
    if (req.tools && req.tools.length > 0) return false;
    // Approximate total content length in chars.
    const totalChars = req.messages.reduce((acc, m) => acc + messageLength(m), 0);
    if (totalChars > this.skipCacheForLongContext) return false;
    return true;
  }

  /**
   * Compute the cache key for `req`: the normalized last user
   * message. Returns `null` if there is no user message.
   */
  private cacheKey(req: LLMRequest): string | null {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i]!;
      if (m.role === 'user') {
        return normalize(messageToText(m));
      }
    }
    return null;
  }

  /**
   * Best-effort guess at the provider id that will serve this
   * request. We can't know for sure without calling
   * `router.selectProvider()`, but that has side effects (emits
   * `provider:selected`). For cost-estimation purposes we just use
   * the first registered provider's id; the actual recorded cost
   * comes from the response after the call.
   */
  private inferProviderId(_req: LLMRequest): string | undefined {
    const list = this.router.list();
    return list[0]?.id;
  }

  /**
   * Estimate the cost of a call based on the per-million-tokens
   * lookup. Returns 0 if the lookup is unavailable.
   */
  private estimateCost(
    providerId: string | undefined,
    model: string,
    tokens: number,
  ): number {
    if (!this.costLookup || !providerId) return 0;
    const perMillion = this.costLookup(providerId, model);
    return (tokens / 1_000_000) * perMillion;
  }

  /**
   * Build a synthetic {@link LLMResponse} from a cached entry. The
   * `usage` field reports zero tokens (the cached response didn't
   * cost any this call), but `costUsd` is preserved from the
   * original call so downstream trackers see the original cost.
   */
  private synthesizeResponse(
    content: string,
    provider: string | undefined,
    model: string | undefined,
    tokensUsed: number | undefined,
    costUsd: number | undefined,
  ): LLMResponse {
    return {
      content,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: tokensUsed ?? 0,
      },
      model: model ?? 'unknown',
      latencyMs: 0,
      stopReason: 'cache_hit',
      cacheHit: true,
      costUsd,
      // The `provider` field isn't on LLMResponse, but the cache
      // stores it separately; we expose it through the model id.
      ...(provider ? { model: `${provider}/${model ?? 'unknown'}` } : {}),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Approximate the character length of a message's content. Handles
 * both plain-string and content-block-array shapes.
 */
function messageLength(msg: LLMMessage): number {
  return messageToText(msg).length;
}

/** Extract the plain-text content of a message (concatenating blocks). */
function messageToText(msg: LLMMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return (msg.content as ContentBlock[])
    .map((b) => (b.type === 'text' ? b.text ?? '' : ''))
    .join(' ');
}

/**
 * Normalize a string for use as a cache key: trim, lowercase, strip
 * punctuation, collapse whitespace.
 *
 * @example
 * ```ts
 * normalize('  What is JWT?  ')  // → 'what is jwt'
 * normalize('Hello,  world!')    // → 'hello world'
 * ```
 */
function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

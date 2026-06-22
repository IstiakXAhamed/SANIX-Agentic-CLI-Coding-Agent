/**
 * @file ProviderRouter.ts
 * @description SANIX intelligent multi-provider router.
 *
 * Responsibilities:
 *  - Score every registered provider against an incoming LLMRequest and
 *    pick the best (task-type affinity, cost, latency, local preference,
 *    circuit-breaker state).
 *  - Call the chosen provider with retry+backoff via `p-retry`.
 *  - On failure, select a fallback (next-best non-broken provider) and
 *    retry with a smaller retry budget.
 *  - Emit router lifecycle events via EventEmitter3:
 *      'provider:selected'  → fired after scoring picks a primary.
 *      'provider:fallback'  → fired when the primary fails and we move
 *                              to a fallback.
 *      'provider:error'     → fired on every provider error (retry or
 *                              terminal).
 *
 * The CircuitBreaker (a separate class exposed as `router.circuitBreaker`)
 * tracks per-provider failure counts and opens after `failureThreshold`
 * consecutive failures, half-opens after `resetTimeoutMs`, and closes
 * again on the next success. This prevents the router from hammering a
 * provider that is down.
 */

import { EventEmitter } from 'eventemitter3';
import pRetry, { AbortError as PRetryAbortError } from 'p-retry';
import {
  IProvider,
  LLMRequest,
  LLMResponse,
} from './interfaces/IProvider.js';
import { ProviderError } from './errors.js';

/** Router event map — strongly typed EventEmitter3 payload shapes. */
export interface RouterEvents {
  /** Fired after scoring picks a primary provider. */
  'provider:selected': (payload: { providerId: string; taskType: string; score: number }) => void;
  /** Fired when the primary fails and a fallback is selected. */
  'provider:fallback': (payload: {
    fromId: string;
    toId: string;
    reason: unknown;
  }) => void;
  /** Fired on every provider error (retryable or terminal). */
  'provider:error': (payload: { providerId: string; error: unknown }) => void;
}

/** Constructor options for {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** Consecutive failures required to open the breaker. Default 5. */
  failureThreshold?: number;
  /** Ms to wait before transitioning open → half-open. Default 30_000. */
  resetTimeoutMs?: number;
}

/**
 * Per-provider circuit breaker.
 *
 * State machine:
 *   closed  → (failures ≥ threshold) → open
 *   open    → (elapsed ≥ resetTimeout) → half-open
 *   half-open → (success) → closed
 *   half-open → (failure) → open
 *
 * The breaker is consulted by the router's scoring function: an open
 * breaker subtracts a large score penalty so the provider is effectively
 * skipped. Callers can still force a call (half-open probe) via
 * {@link recordSuccess} / {@link recordFailure} after the attempt.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly failures = new Map<string, number>();
  private readonly openedAt = new Map<string, number>();
  private readonly halfOpen = new Set<string>();

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
  }

  /** True when the breaker is open (call should be skipped). */
  isOpen(providerId: string): boolean {
    const openedAt = this.openedAt.get(providerId);
    if (openedAt === undefined) return false;
    // If enough time has elapsed, transition to half-open (allowing one probe).
    if (Date.now() - openedAt >= this.resetTimeoutMs) {
      this.halfOpen.add(providerId);
      this.openedAt.delete(providerId);
      return false; // half-open means: allow the call (probe)
    }
    return true;
  }

  /** True when the breaker is in the half-open probe state. */
  isHalfOpen(providerId: string): boolean {
    return this.halfOpen.has(providerId);
  }

  /** Record a successful call — resets failure count, closes the breaker. */
  recordSuccess(providerId: string): void {
    this.failures.delete(providerId);
    this.openedAt.delete(providerId);
    this.halfOpen.delete(providerId);
  }

  /** Record a failed call — increments failure count, may open the breaker. */
  recordFailure(providerId: string): void {
    const current = (this.failures.get(providerId) ?? 0) + 1;
    this.failures.set(providerId, current);
    // If we were probing (half-open) and failed, immediately re-open.
    if (this.halfOpen.has(providerId) || current >= this.failureThreshold) {
      this.openedAt.set(providerId, Date.now());
      this.halfOpen.delete(providerId);
    }
  }

  /** Reset all state for a provider (used by `sanix providers reset`). */
  reset(providerId?: string): void {
    if (providerId === undefined) {
      this.failures.clear();
      this.openedAt.clear();
      this.halfOpen.clear();
      return;
    }
    this.failures.delete(providerId);
    this.openedAt.delete(providerId);
    this.halfOpen.delete(providerId);
  }
}

/** Constructor options for {@link ProviderRouter}. */
export interface ProviderRouterOptions {
  /** Initial provider registry. Callers can add more via {@link register}. */
  providers?: IProvider[];
  /** Circuit breaker config. */
  circuitBreaker?: CircuitBreakerOptions;
  /** Primary retry count (default 3). */
  primaryRetries?: number;
  /** Fallback retry count (default 2). */
  fallbackRetries?: number;
  /** Default per-call timeout in ms (default 30_000). */
  defaultTimeoutMs?: number;
}

/**
 * SANIX provider router. Holds the provider registry, the circuit
 * breaker, and exposes the public {@link route} entry point.
 *
 * Typical usage:
 * ```ts
 * const router = new ProviderRouter({ providers: [claude, gpt4o, groq] });
 * router.on('provider:fallback', ({ fromId, toId, reason }) => log(...));
 * const res = await router.route({ messages, taskType: 'code' });
 * ```
 */
export class ProviderRouter extends EventEmitter<RouterEvents> {
  private readonly providers = new Map<string, IProvider>();
  readonly circuitBreaker: CircuitBreaker;
  private readonly primaryRetries: number;
  private readonly fallbackRetries: number;
  private readonly defaultTimeoutMs: number;

  constructor(opts: ProviderRouterOptions = {}) {
    super();
    this.circuitBreaker = new CircuitBreaker(opts.circuitBreaker ?? {});
    this.primaryRetries = opts.primaryRetries ?? 3;
    this.fallbackRetries = opts.fallbackRetries ?? 2;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    for (const p of opts.providers ?? []) this.register(p);
  }

  /** Add a provider to the registry. Idempotent on `provider.id`. */
  register(provider: IProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  /** Remove a provider from the registry by id. */
  unregister(providerId: string): this {
    this.providers.delete(providerId);
    this.circuitBreaker.reset(providerId);
    return this;
  }

  /** Snapshot of the current registry (insertion order). */
  list(): IProvider[] {
    return Array.from(this.providers.values());
  }

  /** Fetch a single provider by id, or undefined. */
  get(providerId: string): IProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Pick the best provider for a request (no call). Exposed publicly so
   * the TUI / `sanix providers list` can show what would be selected.
   */
  selectProvider(req: LLMRequest): IProvider {
    const ranked = this.rankProviders(req);
    if (ranked.length === 0) {
      throw new ProviderError(
        'router',
        'No providers registered with the ProviderRouter',
        0,
        false,
      );
    }
    const top = ranked[0];
    this.emit('provider:selected', {
      providerId: top.provider.id,
      taskType: req.taskType ?? 'general',
      score: top.score,
    });
    return top.provider;
  }

  /**
   * Pick the next-best fallback provider (excluding the failed one and
   * any provider whose circuit breaker is open). Used internally by
   * {@link route} and exposed for callers that want manual control.
   */
  selectFallback(
    failed: IProvider,
    req: LLMRequest,
    _reason: unknown,
  ): IProvider {
    const ranked = this.rankProviders(req).filter(
      (r) => r.provider.id !== failed.id && !this.circuitBreaker.isOpen(r.provider.id),
    );
    if (ranked.length === 0) {
      throw new ProviderError(
        failed.id,
        `No fallback available after ${failed.id} failed`,
        0,
        false,
      );
    }
    return ranked[0].provider;
  }

  /**
   * Call a provider with retry+backoff. Honors `req.signal` (aborts the
   * whole retry loop). Non-retryable errors abort immediately.
   *
   * @param provider     The provider to call.
   * @param req          The request.
   * @param retries      Number of retries (in addition to the initial attempt).
   */
  async callWithRetry(
    provider: IProvider,
    req: LLMRequest,
    retries: number,
  ): Promise<LLMResponse> {
    const execute = async (): Promise<LLMResponse> => {
      try {
        const res = await provider.chat(req);
        this.circuitBreaker.recordSuccess(provider.id);
        return res;
      } catch (err) {
        this.emit('provider:error', { providerId: provider.id, error: err });
        // Abort errors must propagate immediately (user cancelled).
        if (err instanceof Error && err.name === 'AbortError') {
          throw new PRetryAbortError(err.message);
        }
        // Non-retryable ProviderError → stop retrying.
        if (err instanceof ProviderError && !err.retryable) {
          throw new PRetryAbortError(err.message);
        }
        // Retryable failure → record + rethrow (p-retry will back off).
        this.circuitBreaker.recordFailure(provider.id);
        throw err;
      }
    };

    return pRetry(execute, {
      retries,
      // Exponential backoff with a 500ms floor and 8s ceiling.
      minTimeout: 500,
      maxTimeout: 8_000,
      factor: 2,
      randomize: true,
      onFailedAttempt: (err) => {
        // Don't log user aborts as failures.
        if (err.name === 'AbortError') return;
        this.emit('provider:error', {
          providerId: provider.id,
          error: err,
        });
      },
    });
  }

  /**
   * Route a request: pick the best provider, call with retry; on terminal
   * failure, pick a fallback and call again with a smaller retry budget.
   *
   * Emits `provider:selected` (before the primary call), `provider:error`
   * (on each failure), and `provider:fallback` (when moving to the
   * fallback). Throws if both primary and fallback exhaust retries.
   */
  async route(req: LLMRequest): Promise<LLMResponse> {
    const primary = this.selectProvider(req);
    try {
      return await this.callWithRetry(primary, req, this.primaryRetries);
    } catch (err) {
      // Don't fall back if the user aborted.
      if (err instanceof Error && err.name === 'AbortError') throw err;
      let fallback: IProvider;
      try {
        fallback = this.selectFallback(primary, req, err);
      } catch (noFallbackErr) {
        // No fallback available — rethrow the original error.
        throw err;
      }
      this.emit('provider:fallback', {
        fromId: primary.id,
        toId: fallback.id,
        reason: err,
      });
      return await this.callWithRetry(fallback, req, this.fallbackRetries);
    }
  }

  // ── internal helpers ───────────────────────────────────────────────

  /**
   * Rank all providers by score (descending). Providers whose circuit
   * breaker is open are penalized but not excluded — they may be needed
   * if every alternative is also unavailable.
   */
  private rankProviders(req: LLMRequest): Array<{ provider: IProvider; score: number }> {
    return Array.from(this.providers.values())
      .map((p) => ({ provider: p, score: this.scoreProvider(p, req) }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Score a single provider for a request. Higher is better.
   *
   * Scoring components:
   *   +30  task-type affinity (code/reasoning match)
   *   +25  fast_lookup when latencyMs < 500
   *   +(1/cost)*10  cost efficiency (cheaper = higher)
   *   +50  preferLocal + isLocal
   *   -100 circuit breaker open
   *
   * This mirrors the spec's scoreProvider implementation; the only
   * addition is the circuit-breaker penalty, which the spec calls out as
   * `this.circuitBreaker.isOpen(provider.id) ? score -= 100`.
   */
  private scoreProvider(provider: IProvider, req: LLMRequest): number {
    let score = 0;
    const taskType = req.taskType ?? 'general';

    // Task-type affinity.
    if (taskType === 'code' && provider.strengths.includes('code')) score += 30;
    if (taskType === 'reasoning' && provider.strengths.includes('reasoning')) score += 30;
    if (taskType === 'fast_lookup' && provider.latencyMs < 500) score += 25;
    if (taskType === 'general' && provider.strengths.includes('general')) score += 10;

    // Cost efficiency — local providers (cost=0) get the maximum bonus.
    const cost = provider.costPerMillionTokens;
    score += cost > 0 ? (1 / cost) * 10 : 100;

    // Local preference (offline / privacy mode).
    if (req.preferLocal && provider.isLocal) score += 50;

    // Circuit breaker penalty.
    if (this.circuitBreaker.isOpen(provider.id)) score -= 100;

    return score;
  }
}

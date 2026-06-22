/**
 * @file StreamingTokenCounter.ts
 * @description Real-time token counter for streaming LLM responses. Maintains
 * a running tally and emits `delta` / `total` callbacks as new chunks arrive,
 * so the UI can show a live "x / y tokens" indicator and trigger budget
 * enforcement the moment the limit is crossed.
 *
 * @packageDocumentation
 */

import type { TokenProvider } from './types.js';
import { ProviderTokenizer } from './ProviderTokenizer.js';

/**
 * Callback fired for every chunk processed.
 *
 * @param delta Tokens added in this chunk.
 * @param total Running token total.
 */
export type TokenDeltaCallback = (delta: number, total: number) => void;

/**
 * Options for constructing a {@link StreamingTokenCounter}.
 */
export interface StreamingTokenCounterOptions {
  /** Provider whose tokenizer to use. Default `openai`. */
  provider?: TokenProvider;
  /** Hard cap on total tokens. When crossed, `onLimit` fires once. */
  limit?: number;
  /** Fired for every chunk processed. */
  onDelta?: TokenDeltaCallback;
  /** Fired the first time `total` crosses `limit`. */
  onLimit?: (total: number) => void;
}

/**
 * A streaming token counter. Feed it text chunks via {@link push} (or
 * {@link pushString}); the counter maintains a running token total and
 * invokes callbacks in real-time.
 *
 * @example
 * ```ts
 * const c = new StreamingTokenCounter({ provider: 'anthropic', limit: 100,
 *   onDelta: (d, t) => console.log(`+${d} (${t})`),
 *   onLimit: () => console.warn('limit reached'),
 * });
 * for (const chunk of stream) c.push(chunk);
 * c.total; // final count
 * ```
 */
export class StreamingTokenCounter {
  private readonly tokenizer: ProviderTokenizer;
  private readonly limit?: number;
  private readonly onDelta?: TokenDeltaCallback;
  private readonly onLimit?: (total: number) => void;
  /** Running token total. */
  total = 0;
  private limitHit = false;

  constructor(opts: StreamingTokenCounterOptions = {}) {
    this.tokenizer = new ProviderTokenizer(opts.provider ?? 'openai');
    this.limit = opts.limit;
    this.onDelta = opts.onDelta;
    this.onLimit = opts.onLimit;
  }

  /**
   * Push a text chunk and update the running total.
   *
   * @param chunk Text chunk from the stream.
   * @returns The delta (tokens added) for this chunk.
   */
  push(chunk: string): number {
    if (!chunk) return 0;
    const delta = this.tokenizer.count(chunk);
    this.total += delta;
    this.onDelta?.(delta, this.total);
    if (!this.limitHit && this.limit !== undefined && this.total >= this.limit) {
      this.limitHit = true;
      this.onLimit?.(this.total);
    }
    return delta;
  }

  /** Alias for {@link push} (semantically clearer for string streams). */
  pushString(chunk: string): number {
    return this.push(chunk);
  }

  /**
   * Push a list of chunks at once (e.g. when buffering a burst).
   *
   * @param chunks The chunks.
   * @returns Total delta across all chunks.
   */
  pushAll(chunks: readonly string[]): number {
    let delta = 0;
    for (const c of chunks) delta += this.push(c);
    return delta;
  }

  /** Reset the counter to zero (e.g. for a new conversation turn). */
  reset(): void {
    this.total = 0;
    this.limitHit = false;
  }

  /** Whether the configured limit has been crossed. */
  get isOverLimit(): boolean {
    return this.limitHit;
  }
}

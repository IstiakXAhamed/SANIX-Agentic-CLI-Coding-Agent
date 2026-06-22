/**
 * @file RequestBatcher.ts
 * @description Batch LLM (or any async) requests to amortize per-request
 * overhead. Callers submit individual requests via {@link submit}; the
 * batcher waits up to `maxWaitMs` (or until `maxBatchSize` is reached),
 * then calls the user-supplied `batchHandler` with the whole batch.
 *
 * Built-in dedup: in-flight identical requests share the same future.
 *
 * @packageDocumentation
 */

/** Options for {@link RequestBatcher}. */
export interface RequestBatcherOptions<I, O> {
  /** Max batch size (default 16). */
  maxBatchSize?: number;
  /** Max wait ms before flushing a partial batch (default 50). */
  maxWaitMs?: number;
  /**
   * The batch handler: receives the batch of inputs and must return a
   * list of outputs in the same order.
   */
  batchHandler: (inputs: I[]) => Promise<O[]>;
  /** Optional key function for dedup. Default: JSON.stringify. */
  keyFn?: (input: I) => string;
}

/** A pending request waiting for its batch to flush. */
interface Pending<I, O> {
  input: I;
  resolve: (v: O) => void;
  reject: (e: Error) => void;
}

/**
 * Batch async requests with deduplication.
 *
 * @example
 * ```ts
 * const b = new RequestBatcher<string, string>({
 *   batchHandler: async (inputs) => inputs.map(upper),
 *   maxBatchSize: 8, maxWaitMs: 20,
 * });
 * const out = await b.submit('hello'); // → 'HELLO'
 * ```
 */
export class RequestBatcher<I, O> {
  private readonly maxBatchSize: number;
  private readonly maxWaitMs: number;
  private readonly batchHandler: (inputs: I[]) => Promise<O[]>;
  private readonly keyFn: (input: I) => string;
  private readonly buffer: Pending<I, O>[] = [];
  private readonly inFlight = new Map<string, Promise<O>>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing = false;

  constructor(opts: RequestBatcherOptions<I, O>) {
    this.maxBatchSize = opts.maxBatchSize ?? 16;
    this.maxWaitMs = opts.maxWaitMs ?? 50;
    this.batchHandler = opts.batchHandler;
    this.keyFn = opts.keyFn ?? ((i: I) => JSON.stringify(i));
  }

  /**
   * Submit a single request. If an identical request is already in
   * flight, returns the same promise (dedup).
   *
   * @param input The request input.
   * @returns The request output.
   */
  submit(input: I): Promise<O> {
    const key = this.keyFn(input);
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;

    const p = new Promise<O>((resolveP, rejectP) => {
      this.buffer.push({ input, resolve: resolveP, reject: rejectP });
      if (this.buffer.length >= this.maxBatchSize) {
        void this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => { void this.flush(); }, this.maxWaitMs);
        this.timer.unref?.();
      }
    });
    this.inFlight.set(key, p);
    p.finally(() => this.inFlight.delete(key));
    return p;
  }

  /** Flush the current buffer immediately. */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    this.flushing = false;
    try {
      const outputs = await this.batchHandler(batch.map((b) => b.input));
      if (outputs.length !== batch.length) {
        throw new Error(`batch handler returned ${outputs.length} outputs for ${batch.length} inputs`);
      }
      batch.forEach((b, i) => b.resolve(outputs[i]));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      batch.forEach((b) => b.reject(e));
    }
  }

  /** Number of requests currently buffered (waiting for flush). */
  get buffered(): number {
    return this.buffer.length;
  }

  /** Number of in-flight (submitted, not yet resolved) requests. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }
}

/**
 * @file MemoryPool.ts
 * @description Object pool for `Float32Array` and `Buffer`. Allocating
 * typed arrays / buffers is expensive; this pool hands out previously-
 * released instances of the same size, avoiding GC pressure in hot loops
 * (e.g. embedding math, audio processing).
 *
 * @packageDocumentation
 */

/** A pooled object + its size class. */
interface PooledBuffer {
  buffer: Buffer;
  size: number;
}

/** Options for {@link MemoryPool}. */
export interface MemoryPoolOptions {
  /** Max pooled objects per size class. Default 32. */
  maxPerSize?: number;
  /** Size classes to pre-allocate (power-of-two bytes). Default [4096, 16384, 65536]. */
  sizeClasses?: number[];
}

/**
 * An object pool for `Float32Array` and `Buffer`.
 *
 * @example
 * ```ts
 * const pool = new MemoryPool();
 * const buf = pool.acquire(8192);  // Buffer.allocSlow-equivalent
 * pool.release(buf);               // return to pool
 * ```
 */
export class MemoryPool {
  private readonly maxPerSize: number;
  private readonly sizeClasses: number[];
  private readonly pools = new Map<number, PooledBuffer[]>();
  private hits = 0;
  private misses = 0;

  constructor(opts: MemoryPoolOptions = {}) {
    this.maxPerSize = opts.maxPerSize ?? 32;
    this.sizeClasses = (opts.sizeClasses ?? [4096, 16_384, 65_536]).slice().sort((a, b) => a - b);
    for (const s of this.sizeClasses) this.pools.set(s, []);
  }

  /**
   * Acquire a `Buffer` of at least `minBytes` length. The returned buffer
   * may be larger (rounded up to the next size class) — callers should
   * use `buffer.subarray(0, n)` to bound their writes.
   *
   * @param minBytes Minimum byte length.
   */
  acquire(minBytes: number): Buffer {
    const size = this.classFor(minBytes);
    const pool = this.pools.get(size);
    if (pool && pool.length > 0) {
      this.hits++;
      return pool.pop()!.buffer;
    }
    this.misses++;
    return Buffer.allocUnsafeSlow(size);
  }

  /**
   * Return a buffer to the pool. The buffer's size class is computed
   * automatically; unknown sizes are dropped (no recycling).
   *
   * @param buffer The buffer to release.
   */
  release(buffer: Buffer): void {
    const size = this.classFor(buffer.length);
    if (!this.pools.has(size)) return; // unknown size class — drop
    const pool = this.pools.get(size)!;
    if (pool.length >= this.maxPerSize) return; // full — drop
    // Best-effort zero-out to prevent data leakage between users.
    buffer.fill(0);
    pool.push({ buffer, size });
  }

  /**
   * Acquire a `Float32Array` view over a pooled buffer. The array will
   * have at least `minFloats` elements (i.e. `4 * minFloats` bytes).
   *
   * @param minFloats Minimum number of floats.
   */
  acquireFloat32(minFloats: number): Float32Array {
    const buf = this.acquire(minFloats * 4);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  }

  /**
   * Release a `Float32Array` previously acquired via {@link acquireFloat32}.
   *
   * @param arr The array.
   */
  releaseFloat32(arr: Float32Array): void {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    this.release(buf);
  }

  /** Pool-hit count (for diagnostics). */
  get hitCount(): number {
    return this.hits;
  }

  /** Pool-miss count (for diagnostics). */
  get missCount(): number {
    return this.misses;
  }

  /** Hit rate (0..1). */
  get hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  /** Pick the smallest size class >= `n`. */
  private classFor(n: number): number {
    for (const s of this.sizeClasses) if (s >= n) return s;
    // Larger than any class: round up to next power of two (no pool — one-off).
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }
}

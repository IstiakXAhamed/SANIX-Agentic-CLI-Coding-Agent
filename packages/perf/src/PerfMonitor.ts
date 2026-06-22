/**
 * @file PerfMonitor.ts
 * @description A lightweight perf monitor with a per-metric ring buffer,
 * percentile computation, and a simple profiling API (`start`/`end`).
 *
 * The monitor is intentionally dependency-free: it stores samples in a
 * `Float64Array` ring buffer and computes percentiles on demand via
 * selection (no full sort for p50/p99 — for very large buffers a full
 * sort is still cheap enough).
 *
 * @packageDocumentation
 */

/** Options for {@link PerfMonitor}. */
export interface PerfMonitorOptions {
  /** Ring-buffer capacity per metric (default 1024). */
  bufferSize?: number;
}

/** Percentile snapshot of a metric. */
export interface MetricSnapshot {
  /** Metric name. */
  name: string;
  /** Number of samples currently in the buffer. */
  count: number;
  /** Arithmetic mean of samples. */
  mean: number;
  /** Minimum sample. */
  min: number;
  /** Maximum sample. */
  max: number;
  /** p50 (median). */
  p50: number;
  /** p95. */
  p95: number;
  /** p99. */
  p99: number;
}

/** A ring buffer for a single metric. */
class RingBuffer {
  readonly capacity: number;
  private readonly data: Float64Array;
  private head = 0;
  private filled = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
  }

  push(v: number): void {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  get length(): number {
    return this.filled;
  }

  /** Return a sorted copy of the buffer (for percentile computation). */
  sorted(): Float64Array {
    const out = new Float64Array(this.filled);
    for (let i = 0; i < this.filled; i++) out[i] = this.data[i];
    return out.sort();
  }

  sum(): number {
    let s = 0;
    for (let i = 0; i < this.filled; i++) s += this.data[i];
    return s;
  }
}

/**
 * A per-metric ring-buffer perf monitor.
 *
 * @example
 * ```ts
 * const m = new PerfMonitor();
 * const id = m.start('llm:chat');
 * // ... do work ...
 * m.end(id);
 * m.snapshot('llm:chat'); // MetricSnapshot
 * ```
 */
export class PerfMonitor {
  private readonly bufferSize: number;
  private readonly buffers = new Map<string, RingBuffer>();
  private readonly active = new Map<string, { name: string; start: number }>();
  private counter = 0;

  constructor(opts: PerfMonitorOptions = {}) {
    this.bufferSize = opts.bufferSize ?? 1024;
  }

  /**
   * Start a profiling span. Returns an id to pass to {@link end}.
   *
   * @param name Metric name (e.g. `llm:chat`).
   */
  start(name: string): string {
    const id = `${name}#${++this.counter}`;
    this.active.set(id, { name, start: performance.now() });
    return id;
  }

  /**
   * End a profiling span and record its duration (ms) under its metric.
   *
   * @param id The id returned by {@link start}.
   */
  end(id: string): number {
    const entry = this.active.get(id);
    if (!entry) return 0;
    this.active.delete(id);
    const dur = performance.now() - entry.start;
    this.record(entry.name, dur);
    return dur;
  }

  /**
   * Record a raw sample under a metric (without `start`/`end`).
   *
   * @param name Metric name.
   * @param value Sample value (ms, bytes, ...).
   */
  record(name: string, value: number): void {
    let buf = this.buffers.get(name);
    if (!buf) {
      buf = new RingBuffer(this.bufferSize);
      this.buffers.set(name, buf);
    }
    buf.push(value);
  }

  /** Snapshot a single metric, or undefined if no samples. */
  snapshot(name: string): MetricSnapshot | undefined {
    const buf = this.buffers.get(name);
    if (!buf || buf.length === 0) return undefined;
    const sorted = buf.sorted();
    const count = sorted.length;
    const mean = buf.sum() / count;
    return {
      name,
      count,
      mean,
      min: sorted[0] ?? 0,
      max: sorted[count - 1] ?? 0,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    };
  }

  /** Snapshot all metrics. */
  snapshots(): MetricSnapshot[] {
    return [...this.buffers.keys()].map((n) => this.snapshot(n)!).filter(Boolean);
  }

  /** Reset all metrics. */
  clear(): void {
    this.buffers.clear();
    this.active.clear();
  }
}

/** Compute the `p`-th percentile (0..1) from a sorted array. */
function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

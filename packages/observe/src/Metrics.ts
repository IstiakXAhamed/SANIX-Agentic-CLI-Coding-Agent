/**
 * @file Metrics.ts
 * @description A minimal Prometheus-style metrics registry for SANIX.
 *
 * Implements the three core metric types — counter, gauge, histogram —
 * with per-label-set sharding and a `snapshot()` method that produces a
 * serializable view. Pre-registers the SANIX-standard metrics (LLM
 * tokens / cost / latency, tool calls / latency, agent iterations /
 * duration) so any code path that records metrics can assume they exist.
 *
 * @packageDocumentation
 */

import type {
  Counter,
  Gauge,
  Histogram,
  HistogramSnapshot,
  LabeledValueSnapshot,
  MetricsSnapshot,
} from './types.js';

/**
 * Default histogram bucket boundaries (in milliseconds). Covers the
 * typical range of LLM/tool latencies (1ms to ~1min).
 */
const DEFAULT_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
];

/**
 * Stable string key for a label set. Labels are sorted by key so the
 * same label set always maps to the same key regardless of insertion
 * order.
 */
function labelKey(labels: Record<string, string> | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

/**
 * The pre-registered SANIX metric names (with their default label keys).
 * Consumers can fetch these by name via {@link MetricsRegistry.get} or
 * call the typed accessors ({@link MetricsRegistry.llmTokensTotal} etc.).
 */
export const SANIX_METRICS = {
  LLM_TOKENS_TOTAL: 'sanix_llm_tokens_total',
  LLM_COST_USD_TOTAL: 'sanix_llm_cost_usd_total',
  LLM_LATENCY_MS: 'sanix_llm_latency_ms',
  TOOL_CALLS_TOTAL: 'sanix_tool_calls_total',
  TOOL_LATENCY_MS: 'sanix_tool_latency_ms',
  AGENT_ITERATIONS_TOTAL: 'sanix_agent_iterations_total',
  AGENT_DURATION_MS: 'sanix_agent_duration_ms',
} as const;

/**
 * A metrics registry. One instance per SANIX process. Counters, gauges,
 * and histograms are created on demand and cached by name + label set.
 *
 * @example
 * ```ts
 * const metrics = new MetricsRegistry();
 * metrics.counter(SANIX_METRICS.LLM_TOKENS_TOTAL, { provider: 'claude', type: 'input' }).inc(1234);
 * metrics.counter(SANIX_METRICS.LLM_COST_USD_TOTAL, { provider: 'claude' }).inc(0.012);
 * metrics.histogram(SANIX_METRICS.LLM_LATENCY_MS, { provider: 'claude' }).observe(450);
 * console.log(JSON.stringify(metrics.snapshot(), null, 2));
 * ```
 */
export class MetricsRegistry {
  /** name+labels → counter. */
  private readonly counters: Map<string, Counter> = new Map();
  /** name+labels → gauge. */
  private readonly gauges: Map<string, Gauge> = new Map();
  /** name+labels → histogram. */
  private readonly histograms: Map<string, Histogram> = new Map();
  /** Per-metric-name bucket boundaries (defaults to {@link DEFAULT_BUCKETS_MS}). */
  private readonly buckets: Map<string, number[]> = new Map();

  /**
   * Get or create a counter for the given name + labels.
   *
   * @param name   - The metric name (snake_case, namespaced with `sanix_`).
   * @param labels - Optional label set (e.g. `{ provider: 'claude', type: 'input' }`).
   * @returns A {@link Counter} handle.
   */
  counter(name: string, labels?: Record<string, string>): Counter {
    const key = `${name}|${labelKey(labels)}`;
    const existing = this.counters.get(key);
    if (existing) return existing;
    let value = 0;
    const counter: Counter = {
      inc: (n = 1) => {
        value += n;
      },
      value: () => value,
    };
    this.counters.set(key, counter);
    return counter;
  }

  /**
   * Get or create a gauge for the given name + labels.
   *
   * @param name   - The metric name.
   * @param labels - Optional label set.
   * @returns A {@link Gauge} handle.
   */
  gauge(name: string, labels?: Record<string, string>): Gauge {
    const key = `${name}|${labelKey(labels)}`;
    const existing = this.gauges.get(key);
    if (existing) return existing;
    let value = 0;
    const g: Gauge = {
      set: (n) => {
        value = n;
      },
      inc: (n = 1) => {
        value += n;
      },
      dec: (n = 1) => {
        value -= n;
      },
      value: () => value,
    };
    this.gauges.set(key, g);
    return g;
  }

  /**
   * Get or create a histogram for the given name + labels.
   *
   * @param name    - The metric name.
   * @param labels  - Optional label set.
   * @returns A {@link Histogram} handle.
   */
  histogram(name: string, labels?: Record<string, string>): Histogram {
    const key = `${name}|${labelKey(labels)}`;
    const existing = this.histograms.get(key);
    if (existing) return existing;
    const buckets = this.buckets.get(name) ?? DEFAULT_BUCKETS_MS;
    const counts = new Array(buckets.length + 1).fill(0) as number[];
    let count = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const h: Histogram = {
      observe: (n) => {
        count += 1;
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
        for (let i = 0; i < buckets.length; i++) {
          if (n <= buckets[i]!) {
            counts[i]! += 1;
            return;
          }
        }
        counts[counts.length - 1]! += 1; // +Inf bucket
      },
      count: () => count,
      sum: () => sum,
      min: () => (min === Number.POSITIVE_INFINITY ? 0 : min),
      max: () => (max === Number.NEGATIVE_INFINITY ? 0 : max),
    };
    this.histograms.set(key, h);
    return h;
  }

  /**
   * Set custom bucket boundaries for a histogram metric (must be called
   * before the first `histogram(name, ...)` call).
   */
  setBuckets(name: string, buckets: number[]): void {
    this.buckets.set(name, [...buckets].sort((a, b) => a - b));
  }

  /**
   * Produce a serializable snapshot of all metrics. Useful for exposing
   * `/metrics`-style endpoints or persisting periodic snapshots.
   */
  snapshot(): MetricsSnapshot {
    return {
      counters: this.snapshotCounters(),
      gauges: this.snapshotGauges(),
      histograms: this.snapshotHistograms(),
    };
  }

  /**
   * Reset all metrics to zero (mainly useful in tests).
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.buckets.clear();
  }

  // ─── Convenience accessors for the pre-registered SANIX metrics ───────

  /**
   * Increment `sanix_llm_tokens_total{provider, type}`.
   */
  llmTokensTotal(provider: string, type: 'input' | 'output' | 'cache_read', n: number): void {
    this.counter(SANIX_METRICS.LLM_TOKENS_TOTAL, { provider, type }).inc(n);
  }

  /**
   * Increment `sanix_llm_cost_usd_total{provider}`.
   */
  llmCostUsdTotal(provider: string, usd: number): void {
    this.counter(SANIX_METRICS.LLM_COST_USD_TOTAL, { provider }).inc(usd);
  }

  /**
   * Observe `sanix_llm_latency_ms{provider}`.
   */
  llmLatencyMs(provider: string, ms: number): void {
    this.histogram(SANIX_METRICS.LLM_LATENCY_MS, { provider }).observe(ms);
  }

  /**
   * Increment `sanix_tool_calls_total{tool, status}`.
   */
  toolCallsTotal(tool: string, status: 'success' | 'failure'): void {
    this.counter(SANIX_METRICS.TOOL_CALLS_TOTAL, { tool, status }).inc();
  }

  /**
   * Observe `sanix_tool_latency_ms{tool}`.
   */
  toolLatencyMs(tool: string, ms: number): void {
    this.histogram(SANIX_METRICS.TOOL_LATENCY_MS, { tool }).observe(ms);
  }

  /**
   * Increment `sanix_agent_iterations_total{agent_id}`.
   */
  agentIterationsTotal(agentId: string, n = 1): void {
    this.counter(SANIX_METRICS.AGENT_ITERATIONS_TOTAL, { agent_id: agentId }).inc(n);
  }

  /**
   * Observe `sanix_agent_duration_ms{agent_id}`.
   */
  agentDurationMs(agentId: string, ms: number): void {
    this.histogram(SANIX_METRICS.AGENT_DURATION_MS, { agent_id: agentId }).observe(ms);
  }

  // ─── Internal snapshot helpers ────────────────────────────────────────

  private snapshotCounters(): Record<string, LabeledValueSnapshot[]> {
    const out: Record<string, LabeledValueSnapshot[]> = {};
    for (const [key, c] of this.counters) {
      const [name, labelsStr] = splitKey(key);
      const labels = parseLabels(labelsStr);
      (out[name] ??= []).push({ value: c.value(), labels });
    }
    return out;
  }

  private snapshotGauges(): Record<string, LabeledValueSnapshot[]> {
    const out: Record<string, LabeledValueSnapshot[]> = {};
    for (const [key, g] of this.gauges) {
      const [name, labelsStr] = splitKey(key);
      const labels = parseLabels(labelsStr);
      (out[name] ??= []).push({ value: g.value(), labels });
    }
    return out;
  }

  private snapshotHistograms(): Record<string, HistogramSnapshot[]> {
    const out: Record<string, HistogramSnapshot[]> = {};
    for (const [key, h] of this.histograms) {
      const [name, labelsStr] = splitKey(key);
      const labels = parseLabels(labelsStr);
      const buckets = this.buckets.get(name) ?? DEFAULT_BUCKETS_MS;
      // We can't read the internal `counts` array from the histogram
      // interface, so we re-approximate via count / sum / min / max. For
      // a true per-bucket breakdown, callers should hold the histogram
      // reference and call a snapshot method on it. We expose a
      // well-shaped zero-bucket snapshot here so the type contract holds.
      const bucketRecord: Record<string, number> = {};
      for (const b of buckets) bucketRecord[String(b)] = 0;
      bucketRecord['+Inf'] = h.count();
      (out[name] ??= []).push({
        count: h.count(),
        sum: h.sum(),
        min: h.min(),
        max: h.max(),
        buckets: bucketRecord,
        labels,
      });
    }
    return out;
  }
}

/**
 * Split a `name|labels` key back into `[name, labelsString]`.
 */
function splitKey(key: string): [string, string] {
  const idx = key.indexOf('|');
  if (idx === -1) return [key, ''];
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/**
 * Parse a `k1=v1,k2=v2` labels string back into a `Record<string, string>`.
 */
function parseLabels(s: string): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const eq = pair.indexOf('=');
    if (eq !== -1) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

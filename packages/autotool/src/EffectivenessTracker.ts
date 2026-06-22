/**
 * @file EffectivenessTracker.ts
 * @description Per-tool effectiveness tracking with EMA-weighted success rate
 * and latency, plus a trend detector. The EMA weighting makes recent
 * invocations matter more than old ones — perfect for an agent that adapts
 * to changing environments (e.g. a flaky API).
 *
 * @packageDocumentation
 */

import type { ToolEffectivenessRecord, ToolResult } from './types.js';

/**
 * Options for {@link EffectivenessTracker}.
 */
export interface EffectivenessTrackerOptions {
  /** EMA alpha (0..1). Higher = more reactive. Default 0.3. */
  alpha?: number;
  /** Window (ms) over which to compute the trend. Default 5 minutes. */
  trendWindowMs?: number;
}

/**
 * Tracks per-tool effectiveness (success rate + latency) with EMA smoothing
 * and a trend detector.
 *
 * @example
 * ```ts
 * const t = new EffectivenessTracker();
 * t.record('read_file', { ok: true, output: '...', durationMs: 12 } as ToolResult);
 * t.snapshot('read_file'); // ToolEffectivenessRecord
 * ```
 */
export class EffectivenessTracker {
  private readonly alpha: number;
  private readonly trendWindowMs: number;
  private readonly records = new Map<string, ToolEffectivenessRecord>();
  private readonly recent = new Map<string, Array<{ ts: number; ok: boolean }>>();

  constructor(opts: EffectivenessTrackerOptions = {}) {
    this.alpha = opts.alpha ?? 0.3;
    this.trendWindowMs = opts.trendWindowMs ?? 5 * 60 * 1000;
  }

  /**
   * Record a single tool invocation result.
   *
   * @param tool Tool name.
   * @param result The tool's result.
   */
  record(tool: string, result: ToolResult): void {
    const now = Date.now();
    const success = result.ok ? 1 : 0;
    let rec = this.records.get(tool);
    if (!rec) {
      rec = {
        tool,
        invocations: 0,
        successes: 0,
        ema: success,
        emaLatencyMs: result.durationMs,
        trend: 0,
        updatedAt: now,
      };
      this.records.set(tool, rec);
    } else {
      rec.ema = this.alpha * success + (1 - this.alpha) * rec.ema;
      rec.emaLatencyMs = this.alpha * result.durationMs + (1 - this.alpha) * rec.emaLatencyMs;
    }
    rec.invocations += 1;
    if (result.ok) rec.successes += 1;
    rec.updatedAt = now;

    // Track recent samples for trend computation.
    let arr = this.recent.get(tool);
    if (!arr) {
      arr = [];
      this.recent.set(tool, arr);
    }
    arr.push({ ts: now, ok: result.ok });
    // Drop samples older than the trend window.
    const cutoff = now - this.trendWindowMs;
    while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
    // Trend = recent_success_rate - overall_ema (positive = improving).
    if (arr.length >= 3) {
      const recentSuccess = arr.filter((s) => s.ok).length / arr.length;
      rec.trend = recentSuccess - rec.ema;
    }
  }

  /**
   * Get a snapshot of a tool's effectiveness, or undefined if never invoked.
   *
   * @param tool Tool name.
   */
  snapshot(tool: string): ToolEffectivenessRecord | undefined {
    return this.records.get(tool);
  }

  /** Snapshot of all tracked tools. */
  all(): ToolEffectivenessRecord[] {
    return [...this.records.values()];
  }

  /** Reset all tracking data. */
  clear(): void {
    this.records.clear();
    this.recent.clear();
  }
}

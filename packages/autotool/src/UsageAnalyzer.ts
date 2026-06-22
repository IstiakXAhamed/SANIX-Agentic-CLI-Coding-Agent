/**
 * @file UsageAnalyzer.ts
 * @description Summarize effectiveness data from an {@link EffectivenessTracker}
 * into actionable insights: top tools, unused tools, unreliable tools,
 * slow tools, and free-text recommendations.
 *
 * @packageDocumentation
 */

import type { EffectivenessTracker } from './EffectivenessTracker.js';
import type { ToolDef, UsageInsights } from './types.js';

/** Options for {@link UsageAnalyzer.analyze}. */
export interface AnalyzeOptions {
  /** Min invocations before a tool counts as "unreliable". Default 3. */
  minInvocations?: number;
  /** Top-N most-used tools to surface. Default 5. */
  topN?: number;
}

/**
 * Analyze tool usage and produce insights.
 *
 * @example
 * ```ts
 * const a = new UsageAnalyzer(tracker);
 * const insights = a.analyze(registry.list());
 * insights.recommendations; // ['Consider removing unused tool X', ...]
 * ```
 */
export class UsageAnalyzer {
  private readonly tracker: EffectivenessTracker;

  constructor(tracker: EffectivenessTracker) {
    this.tracker = tracker;
  }

  /**
   * Produce a {@link UsageInsights} snapshot.
   *
   * @param tools All registered tools (to detect unused ones).
   * @param opts See {@link AnalyzeOptions}.
   */
  analyze(tools: readonly ToolDef[], opts: AnalyzeOptions = {}): UsageInsights {
    const minInv = opts.minInvocations ?? 3;
    const topN = opts.topN ?? 5;
    const records = this.tracker.all();
    const recordByName = new Map(records.map((r) => [r.tool, r]));

    const totalInvocations = records.reduce((s, r) => s + r.invocations, 0);
    const topTools = [...records]
      .sort((a, b) => b.invocations - a.invocations)
      .slice(0, topN)
      .map((r) => ({ tool: r.tool, invocations: r.invocations }));

    const unusedTools = tools
      .map((t) => t.name)
      .filter((name) => !recordByName.has(name));

    const unreliableTools = records
      .filter((r) => r.invocations >= minInv && r.ema < 0.5)
      .map((r) => ({ tool: r.tool, successRate: r.successes / r.invocations }))
      .sort((a, b) => a.successRate - b.successRate);

    const latencies = records.map((r) => r.emaLatencyMs).sort((a, b) => a - b);
    const q3 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.75)] : Infinity;
    const slowTools = records
      .filter((r) => r.emaLatencyMs >= q3 && r.invocations >= minInv)
      .map((r) => ({ tool: r.tool, emaLatencyMs: r.emaLatencyMs }))
      .sort((a, b) => b.emaLatencyMs - a.emaLatencyMs);

    const recommendations: string[] = [];
    if (unusedTools.length > 0) {
      recommendations.push(`Consider removing ${unusedTools.length} unused tool(s): ${unusedTools.slice(0, 5).join(', ')}.`);
    }
    for (const u of unreliableTools.slice(0, 3)) {
      recommendations.push(`Tool "${u.tool}" has low success rate ${(u.successRate * 100).toFixed(0)}% — investigate or replace.`);
    }
    for (const s of slowTools.slice(0, 3)) {
      recommendations.push(`Tool "${s.tool}" is slow (avg ${Math.round(s.emaLatencyMs)}ms) — consider caching or parallelizing.`);
    }
    if (recommendations.length === 0) {
      recommendations.push('All tools performing within nominal thresholds.');
    }

    return {
      totalInvocations,
      topTools,
      unusedTools,
      unreliableTools,
      slowTools,
      recommendations,
    };
  }
}

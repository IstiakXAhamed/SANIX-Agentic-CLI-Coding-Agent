/**
 * @file ToolRecommender.ts
 * @description Given a task category (from {@link TaskClassifier}) and a
 * registry of tools, filter the tools to those that match the category's
 * keywords, then score each by:
 *
 *   - keyword overlap with the prompt
 *   - historical effectiveness (from {@link EffectivenessTracker})
 *   - inverse latency (faster tools score higher)
 *
 * Returns a sorted list of recommendations.
 *
 * @packageDocumentation
 */

import type {
  EffectivenessTracker,
} from './EffectivenessTracker.js';
import type {
  TaskCategory,
  ToolDef,
  ToolRecommendation,
} from './types.js';

/** Per-category keyword hints used to filter tools. */
const CATEGORY_KEYWORDS: Readonly<Record<TaskCategory, readonly string[]>> = {
  file: ['file', 'read', 'write', 'edit', 'open', 'save', 'path', 'directory'],
  search: ['search', 'find', 'grep', 'lookup', 'locate'],
  code: ['code', 'function', 'class', 'refactor', 'debug', 'lint', 'compile', 'typescript', 'python', 'javascript'],
  web: ['fetch', 'http', 'url', 'web', 'scrape', 'browse', 'request'],
  shell: ['shell', 'bash', 'exec', 'run', 'command', 'terminal', 'spawn'],
  memory: ['memory', 'remember', 'recall', 'note', 'forget'],
  data: ['parse', 'transform', 'csv', 'json', 'yaml', 'sql', 'database', 'query'],
  network: ['ping', 'dns', 'network', 'socket', 'ssh', 'tcp', 'udp'],
  math: ['calculate', 'compute', 'math', 'sum', 'average'],
  time: ['time', 'date', 'schedule', 'cron', 'timer'],
  unknown: [],
};

/** Result of {@link ToolRecommender.recommend}. */
export interface RecommendResult {
  /** Sorted (best-first) recommendations. */
  recommendations: ToolRecommendation[];
  /** Total tools considered (after filtering). */
  considered: number;
}

/**
 * Recommend tools for a given task.
 *
 * @example
 * ```ts
 * const r = new ToolRecommender(tracker);
 * const out = r.recommend('file', 'read package.json', registry.list());
 * out.recommendations[0].tool.name; // 'read_file'
 * ```
 */
export class ToolRecommender {
  private readonly tracker?: EffectivenessTracker;

  constructor(tracker?: EffectivenessTracker) {
    this.tracker = tracker;
  }

  /**
   * Recommend tools.
   *
   * @param category Task category.
   * @param prompt The user's prompt (for keyword overlap scoring).
   * @param tools All available tools.
   * @param opts.maxResults Max recommendations to return. Default 5.
   */
  recommend(
    category: TaskCategory,
    prompt: string,
    tools: readonly ToolDef[],
    opts: { maxResults?: number } = {},
  ): RecommendResult {
    const max = opts.maxResults ?? 5;
    const promptTokens = new Set((prompt.toLowerCase().match(/[a-z_]+/g) ?? []));
    const catKeywords = CATEGORY_KEYWORDS[category];

    // Filter: tool must have ≥1 category keyword in name/description/keywords,
    // unless category is `unknown` (then no filter).
    const candidates = category === 'unknown'
      ? tools
      : tools.filter((t) => {
          const blob = `${t.name} ${t.description} ${(t.keywords ?? []).join(' ')}`.toLowerCase();
          return catKeywords.some((k) => blob.includes(k));
        });

    // Score each candidate.
    const scored: ToolRecommendation[] = candidates.map((tool) => {
      const blob = `${tool.name} ${tCleanDescription(tool.description)} ${(tool.keywords ?? []).join(' ')}`.toLowerCase();
      const blobTokens = new Set(blob.match(/[a-z_]+/g) ?? []);
      // Keyword overlap (Jaccard-ish) with prompt.
      let inter = 0;
      for (const tk of blobTokens) if (promptTokens.has(tk)) inter++;
      const overlap = promptTokens.size === 0 ? 0 : inter / promptTokens.size;

      // Effectiveness score (0..1) — EMA success rate.
      const eff = this.tracker?.snapshot(tool.name);
      const effScore = eff ? Math.max(0, eff.ema) : 0.5; // default 0.5 for untested tools

      // Inverse latency (faster = higher).
      const latency = eff?.emaLatencyMs ?? 200;
      const latencyScore = 1 / (1 + latency / 500); // 500ms ≈ 0.5

      const score = overlap * 0.5 + effScore * 0.35 + latencyScore * 0.15;
      const reason = `overlap=${overlap.toFixed(2)}, eff=${effScore.toFixed(2)}, latency=${Math.round(latency)}ms`;
      return { tool, score: Math.min(1, score), reason };
    });

    scored.sort((a, b) => b.score - a.score);
    return { recommendations: scored.slice(0, max), considered: candidates.length };
  }
}

/** Lowercase + tokenize a tool description for scoring. */
function tCleanDescription(d: string): string {
  return d.toLowerCase();
}

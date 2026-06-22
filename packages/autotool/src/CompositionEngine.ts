/**
 * @file CompositionEngine.ts
 * @description Discover candidate tool sequences for a multi-step task and
 * compose them into a {@link ComposedSequence}. Discovery is rule-based:
 * the engine looks at the task category from {@link TaskClassifier} and
 * picks a known-good sequence template (e.g. `search → read → edit` for
 * code-refactor tasks).
 *
 * @packageDocumentation
 */

import type { EffectivenessTracker } from './EffectivenessTracker.js';
import type { ComposedSequence, TaskCategory, ToolDef } from './types.js';

/** Per-category sequence templates (lists of tool-name patterns). */
const TEMPLATES: Readonly<Record<TaskCategory, readonly string[][]>> = {
  file: [['read', 'write'], ['read', 'edit']],
  search: [['search', 'read']],
  code: [['search', 'read', 'edit'], ['read', 'lint'], ['read', 'debug']],
  web: [['fetch', 'parse'], ['browse', 'scrape']],
  shell: [['exec', 'read']],
  memory: [['recall', 'note']],
  data: [['parse', 'transform', 'write']],
  network: [['ping', 'fetch']],
  math: [['calculate']],
  time: [['schedule']],
  unknown: [],
};

/** Options for {@link CompositionEngine.discover}. */
export interface DiscoverOptions {
  /** Max sequences to return. Default 3. */
  maxResults?: number;
}

/**
 * Discover composed tool sequences for a task.
 *
 * @example
 * ```ts
 * const eng = new CompositionEngine(tracker);
 * const seqs = eng.discover('code', registry.list());
 * seqs[0].steps.map(s => s.tool.name); // ['search', 'read', 'edit']
 * ```
 */
export class CompositionEngine {
  private readonly tracker?: EffectivenessTracker;

  constructor(tracker?: EffectivenessTracker) {
    this.tracker = tracker;
  }

  /**
   * Discover candidate sequences for the given category.
   *
   * @param category The task category.
   * @param tools All available tools.
   * @param opts See {@link DiscoverOptions}.
   */
  discover(
    category: TaskCategory,
    tools: readonly ToolDef[],
    opts: DiscoverOptions = {},
  ): ComposedSequence[] {
    const max = opts.maxResults ?? 3;
    const templates = TEMPLATES[category];
    if (templates.length === 0) return [];
    const byName = new Map<string, ToolDef>();
    for (const t of tools) byName.set(t.name.toLowerCase(), t);

    const out: ComposedSequence[] = [];
    for (const template of templates) {
      // Match each step's pattern to a registered tool by substring.
      const steps: ComposedSequence['steps'] = [];
      let estimatedLatencyMs = 0;
      let ok = true;
      for (const pattern of template) {
        const tool = this.findTool(pattern, byName);
        if (!tool) { ok = false; break; }
        steps.push({ tool });
        const eff = this.tracker?.snapshot(tool.name);
        estimatedLatencyMs += eff?.emaLatencyMs ?? 200;
      }
      if (!ok || steps.length === 0) continue;
      out.push({
        steps,
        description: steps.map((s) => s.tool.name).join(' → '),
        estimatedLatencyMs,
      });
      if (out.length >= max) break;
    }
    return out;
  }

  /** Find a tool whose name contains `pattern`. */
  private findTool(pattern: string, byName: Map<string, ToolDef>): ToolDef | undefined {
    // Exact match first.
    const exact = byName.get(pattern);
    if (exact) return exact;
    // Substring match.
    for (const [name, t] of byName) {
      if (name.includes(pattern)) return t;
    }
    return undefined;
  }
}

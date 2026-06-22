/**
 * @file AutoToolManager.ts
 * @description Top-level facade. Combines {@link SmartDispatcher},
 * {@link TaskClassifier}, {@link ToolRecommender}, {@link CompositionEngine},
 * and {@link UsageAnalyzer} into a single `recommendFor(prompt)` entry
 * point that returns recommendations + composed sequences for the prompt.
 *
 * @packageDocumentation
 */

import { EffectivenessTracker } from './EffectivenessTracker.js';
import { TaskClassifier } from './TaskClassifier.js';
import type { TaskClassifierOptions } from './TaskClassifier.js';
import { ToolRecommender } from './ToolRecommender.js';
import { CompositionEngine } from './CompositionEngine.js';
import { UsageAnalyzer } from './UsageAnalyzer.js';
import { SmartDispatcher } from './SmartDispatcher.js';
import type { SmartDispatcherOptions } from './SmartDispatcher.js';
import type {
  ComposedSequence,
  ToolRecommendation,
  ToolRegistry,
  UsageInsights,
} from './types.js';

/** Result of {@link AutoToolManager.recommendFor}. */
export interface RecommendForResult {
  /** The task category. */
  category: import('./types.js').TaskCategory;
  /** Classifier confidence (0..1). */
  confidence: number;
  /** Ranked tool recommendations. */
  recommendations: ToolRecommendation[];
  /** Composed multi-step sequences. */
  sequences: ComposedSequence[];
}

/** Options for {@link AutoToolManager}. */
export interface AutoToolManagerOptions {
  /** Classifier options (LLM fallback etc). */
  classifier?: TaskClassifierOptions;
  /** Dispatcher options (cache, tracker). */
  dispatcher?: SmartDispatcherOptions;
}

/**
 * Top-level facade for the autotool package.
 *
 * @example
 * ```ts
 * const m = new AutoToolManager(registry);
 * const r = await m.recommendFor('read package.json and find the deps');
 * r.recommendations[0].tool.name; // 'read_file'
 * r.sequences.length; // 1+ composed sequences
 * ```
 */
export class AutoToolManager {
  private readonly dispatcher: SmartDispatcher;
  private readonly classifier: TaskClassifier;
  private readonly recommender: ToolRecommender;
  private readonly composer: CompositionEngine;
  private readonly analyzer: UsageAnalyzer;
  private readonly tracker: EffectivenessTracker;

  constructor(registry: ToolRegistry, opts: AutoToolManagerOptions = {}) {
    this.dispatcher = new SmartDispatcher(registry, opts.dispatcher ?? {});
    this.tracker = this.dispatcher.getTracker();
    this.classifier = new TaskClassifier(opts.classifier ?? {});
    this.recommender = new ToolRecommender(this.tracker);
    this.composer = new CompositionEngine(this.tracker);
    this.analyzer = new UsageAnalyzer(this.tracker);
  }

  /**
   * Classify the prompt and produce recommendations + sequences.
   *
   * @param prompt The user's prompt.
   * @param opts.maxResults Max recommendations. Default 5.
   */
  async recommendFor(
    prompt: string,
    opts: { maxResults?: number } = {},
  ): Promise<RecommendForResult> {
    const cls = await this.classifier.classify(prompt);
    const tools = this.dispatcher.getRegistry().list();
    const rec = this.recommender.recommend(cls.category, prompt, tools, opts);
    const seqs = this.composer.discover(cls.category, tools, { maxResults: 3 });
    return {
      category: cls.category,
      confidence: cls.confidence,
      recommendations: rec.recommendations,
      sequences: seqs,
    };
  }

  /**
   * Invoke a tool through the smart dispatcher (caching + tracking).
   *
   * @param name Tool name.
   * @param args Tool arguments.
   */
  async invoke(name: string, args: Record<string, unknown>): Promise<import('./types.js').ToolResult> {
    return this.dispatcher.invoke(name, args);
  }

  /** Produce a usage insights snapshot. */
  insights(): UsageInsights {
    return this.analyzer.analyze(this.dispatcher.getRegistry().list());
  }

  /** The underlying dispatcher (for cache invalidation, etc). */
  getDispatcher(): SmartDispatcher {
    return this.dispatcher;
  }
}

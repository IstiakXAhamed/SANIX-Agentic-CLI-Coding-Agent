/**
 * @file SelfImprovementManager.ts
 * @description Top-level facade for the self-improvement toolkit. Wires
 * together the {@link PromptMutator}, {@link FitnessEvaluator},
 * {@link EvolutionEngine}, {@link ABTester}, {@link PromptRegistry}, and
 * {@link MetaLearner} into a single entry point.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { IProvider } from '@sanix/providers';
import type { BenchmarkSuite } from '@sanix/bench';
import type {
  ABTestMetric,
  ABTestResult,
  EvolutionConfig,
  EvolutionResult,
  GenerationResult,
  MutationType,
  PromptCategory,
  PromptVariant,
} from './types.js';
import { DEFAULT_EVOLUTION_CONFIG } from './types.js';
import { PromptMutator } from './PromptMutator.js';
import { FitnessEvaluator } from './FitnessEvaluator.js';
import { EvolutionEngine } from './EvolutionEngine.js';
import { ABTester } from './ABTester.js';
import { PromptRegistry } from './PromptRegistry.js';
import { MetaLearner } from './MetaLearner.js';

/**
 * Events emitted by {@link SelfImprovementManager} (forwarded from sub-engines).
 */
export interface SelfImprovementManagerEvents {
  'evolution:start': { seedPrompt: string; config: EvolutionConfig };
  'generation:complete': { result: GenerationResult };
  'variant:evaluated': { variant: PromptVariant; fitness: number };
  'evolution:complete': { result: EvolutionResult };
  'test:complete': { result: ABTestResult };
  'error': { error: Error };
}

/**
 * SelfImprovementManager constructor options.
 */
export interface SelfImprovementManagerOptions {
  /** The LLM provider used for mutations + as the test subject. */
  provider: IProvider;
  /** The benchmark suite to evaluate against. */
  benchmarkSuite: BenchmarkSuite;
  /** SQLite db path for the {@link PromptRegistry}. Default: ~/.sanix/self-improve/prompts.db */
  dbPath?: string;
}

/**
 * Top-level facade for prompt self-improvement.
 *
 * @example
 * ```ts
 * const mgr = new SelfImprovementManager({ provider, benchmarkSuite });
 * const result = await mgr.evolve('You are a helpful assistant.', {
 *   populationSize: 6, generations: 3, benchmarkId: 'basic-reasoning',
 * });
 * console.log(result.bestVariant.fitness);
 * const best = mgr.getBestPrompt();
 * ```
 */
export class SelfImprovementManager extends EventEmitter<SelfImprovementManagerEvents> {
  private readonly provider: IProvider;
  private readonly benchmarkSuite: BenchmarkSuite;
  private readonly mutator: PromptMutator;
  private readonly evaluator: FitnessEvaluator;
  private readonly tester: ABTester;
  private readonly registry: PromptRegistry;
  private readonly metaLearner: MetaLearner;
  private readonly history: GenerationResult[][] = [];
  private readonly metaPath: string;

  constructor(opts: SelfImprovementManagerOptions) {
    super();
    this.provider = opts.provider;
    this.benchmarkSuite = opts.benchmarkSuite;
    const dir = path.join(os.homedir(), '.sanix', 'self-improve');
    fs.mkdirSync(dir, { recursive: true });
    this.registry = new PromptRegistry({ dbPath: opts.dbPath });
    this.mutator = new PromptMutator({ provider: this.provider });
    this.evaluator = new FitnessEvaluator({
      benchmarkSuite: this.benchmarkSuite,
      provider: this.provider,
    });
    this.tester = new ABTester({
      benchmarkSuite: this.benchmarkSuite,
      provider: this.provider,
    });
    this.metaLearner = new MetaLearner();
    this.metaPath = path.join(dir, 'meta-learner.json');

    // Wire sub-engine events to our forwarders.
    this.tester.on('test:complete', ({ result }) => this.emit('test:complete', { result }));
    this.tester.on('error', ({ error }) => this.emit('error', { error }));
  }

  /**
   * Run a full evolutionary search starting from `seedPrompt`.
   *
   * @returns The {@link EvolutionResult} (and persists every variant to the
   *          {@link PromptRegistry}).
   */
  async evolve(seedPrompt: string, config?: Partial<EvolutionConfig>): Promise<EvolutionResult> {
    const fullConfig: EvolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    this.emit('evolution:start', { seedPrompt, config: fullConfig });
    const engine = new EvolutionEngine(fullConfig, {
      mutator: this.mutator,
      evaluator: this.evaluator,
      seedPrompt,
    });
    engine.on('generation:complete', ({ result }) => {
      this.history.push([result]);
      this.emit('generation:complete', { result });
    });
    engine.on('variant:evaluated', ({ variant, fitness }) => {
      this.emit('variant:evaluated', { variant, fitness });
      this.registry.save(variant);
    });
    engine.on('error', ({ error }) => this.emit('error', { error }));

    const result = await engine.run();
    // Persist final population + best.
    for (const v of result.finalPopulation) this.registry.save(v);
    this.registry.save(result.bestVariant);
    this.emit('evolution:complete', { result });
    return result;
  }

  /**
   * Run an A/B test between two or more variants.
   *
   * @param opts.metric - One of `'pass_rate' | 'avg_cost' | 'avg_duration' | 'avg_quality_score'`.
   */
  async abTest(
    variants: PromptVariant[],
    opts: { benchmarkId: string; metric: ABTestMetric | string; samplesPerVariant: number },
  ): Promise<ABTestResult> {
    const test = await this.tester.createTest({
      name: `ab-${Date.now()}`,
      variants,
      benchmarkId: opts.benchmarkId,
      metric: opts.metric as ABTestMetric,
      samplesPerVariant: opts.samplesPerVariant,
    });
    const completed = await this.tester.runTest(test.id);
    if (!completed.results) throw new Error('SelfImprovementManager.abTest: test did not produce results');
    return completed.results;
  }

  /**
   * Get the highest-fitness variant seen so far (across all runs).
   */
  getBestPrompt(): PromptVariant | null {
    return this.registry.getBest();
  }

  /**
   * Get the per-generation history of every evolutionary run.
   */
  getHistory(): GenerationResult[][] {
    return this.history;
  }

  /**
   * Recommend the next mutation strategy to try for `promptCategory`,
   * based on historical outcomes.
   */
  recommendMutation(promptCategory: PromptCategory): MutationType {
    return this.metaLearner.recommendMutation(promptCategory);
  }

  /**
   * Persist the meta-learner's state to disk.
   */
  async saveMetaState(): Promise<void> {
    const json = JSON.stringify(this.metaLearner.toJSON());
    await fs.promises.writeFile(this.metaPath, json, 'utf8');
  }

  /**
   * Load the meta-learner's state from disk (if it exists).
   */
  async loadMetaState(): Promise<void> {
    try {
      const text = await fs.promises.readFile(this.metaPath, 'utf8');
      const data = JSON.parse(text) as Record<string, { count: number; totalDelta: number; successes: number }>;
      const ml = MetaLearner.fromJSON(data);
      // Copy stats into our instance. (We can't reassign `this.metaLearner`;
      // instead we read the new instance's stats and feed them back.)
      const stats = ml.toJSON();
      for (const [k, v] of Object.entries(stats)) {
        // Re-record each outcome count times to reproduce the same stats.
        for (let i = 0; i < v.count; i++) {
          const [m, c] = k.split('|') as [MutationType, PromptCategory];
          this.metaLearner.recordOutcome(m, c, v.count > 0 ? v.totalDelta / v.count : 0);
        }
      }
    } catch { /* file not present yet — no-op */ }
  }

  /**
   * Release resources (close the SQLite handle).
   */
  close(): void {
    this.registry.close();
  }
}

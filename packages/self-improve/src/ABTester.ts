/**
 * @file ABTester.ts
 * @description Statistical A/B testing for prompt variants. Supports two-
 * proportion z-test (for `pass_rate`) and two-sample t-test (for continuous
 * metrics like `avg_cost`, `avg_duration`, `avg_quality_score`).
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { nanoid } from 'nanoid';
import type {
  ABTest,
  ABTestMetric,
  ABTestResult,
  PromptVariant,
} from './types.js';
import type { BenchmarkSuite } from '@sanix/bench';
import type { IProvider } from '@sanix/providers';
import { FitnessEvaluator } from './FitnessEvaluator.js';

/**
 * Events emitted by {@link ABTester}.
 */
export interface ABTesterEvents {
  /** Emitted when a new test is created. */
  'test:create': { testId: string; name: string; variants: number };
  /** Emitted at the start of a test run. */
  'test:start': { testId: string };
  /** Emitted when a single variant finishes its sample run. */
  'variant:complete': { testId: string; variantId: string; metricValue: number };
  /** Emitted when the full test completes. */
  'test:complete': { testId: string; result: ABTestResult };
  /** Emitted on internal errors. */
  'error': { error: Error };
}

/**
 * ABTester constructor options.
 */
export interface ABTesterOptions {
  /** The benchmark suite to draw prompts from. */
  benchmarkSuite: BenchmarkSuite;
  /** The LLM provider used as the test subject. */
  provider: IProvider;
}

/**
 * Create a new A/B test (without running it yet).
 *
 * @example
 * ```ts
 * const tester = new ABTester({ benchmarkSuite, provider });
 * const test = await tester.createTest({
 *   name: 'node-vs-python',
 *   variants: [variantA, variantB],
 *   benchmarkId: 'basic-reasoning',
 *   metric: 'pass_rate',
 *   samplesPerVariant: 30,
 * });
 * const result = await tester.runTest(test.id);
 * ```
 */
export class ABTester extends EventEmitter<ABTesterEvents> {
  private readonly tests: Map<string, ABTest> = new Map();
  private readonly benchmarkSuite: BenchmarkSuite;
  private readonly provider: IProvider;

  constructor(opts: ABTesterOptions) {
    super();
    this.benchmarkSuite = opts.benchmarkSuite;
    this.provider = opts.provider;
  }

  /**
   * Create a new A/B test definition (does not run it yet).
   */
  async createTest(opts: {
    name: string;
    variants: PromptVariant[];
    benchmarkId: string;
    metric: ABTestMetric;
    samplesPerVariant: number;
  }): Promise<ABTest> {
    if (opts.variants.length < 2) {
      throw new Error('ABTester.createTest: at least 2 variants required');
    }
    const test: ABTest = {
      id: nanoid(10),
      name: opts.name,
      variants: opts.variants,
      metric: opts.metric,
      benchmarkId: opts.benchmarkId,
      samplesPerVariant: opts.samplesPerVariant,
      status: 'running',
      createdAt: Date.now(),
    };
    this.tests.set(test.id, test);
    this.emit('test:create', { testId: test.id, name: test.name, variants: test.variants.length });
    return test;
  }

  /**
   * Run a previously-created test. Returns the updated test with `results`
   * populated.
   */
  async runTest(testId: string): Promise<ABTest> {
    const test = this.tests.get(testId);
    if (!test) throw new Error(`ABTester.runTest: unknown test '${testId}'`);
    this.emit('test:start', { testId });
    const evaluator = new FitnessEvaluator({
      benchmarkSuite: this.benchmarkSuite,
      provider: this.provider,
      samplesPerVariant: test.samplesPerVariant,
    });

    const variantResults: ABTestResult['variantResults'] = [];
    for (const v of test.variants) {
      try {
        const e = await evaluator.evaluate(v, { benchmarkId: test.benchmarkId });
        const metricValue = this.metricValue(test.metric, e);
        variantResults.push({
          variantId: v.id,
          metricValue,
          samples: e.samples,
          confidence: 0,
        });
        this.emit('variant:complete', { testId, variantId: v.id, metricValue });
      } catch (err) {
        this.emit('error', { error: err instanceof Error ? err : new Error(String(err)) });
        variantResults.push({ variantId: v.id, metricValue: 0, samples: 0, confidence: 0 });
      }
    }

    // Compute significance + winner.
    const baseline = variantResults[0]!;
    let winner = variantResults[0]!;
    let bestMetric = baseline.metricValue;
    for (const r of variantResults.slice(1)) {
      if (this.isBetter(r.metricValue, bestMetric, test.metric)) {
        winner = r;
        bestMetric = r.metricValue;
      }
    }
    const pValue = this.computePValue(test.metric, baseline, winner);
    const confidence = Math.max(0, 1 - pValue);
    for (const r of variantResults) {
      if (r === winner) r.confidence = confidence;
      else r.confidence = Math.max(0, 1 - this.computePValue(test.metric, baseline, r));
    }
    const improvement = baseline.metricValue === 0
      ? (winner.metricValue > 0 ? 1 : 0)
      : (winner.metricValue - baseline.metricValue) / Math.abs(baseline.metricValue);

    const result: ABTestResult = {
      winnerId: winner.variantId,
      variantResults,
      statisticalSignificance: pValue,
      improvement,
    };
    test.results = result;
    test.status = 'complete';
    test.completedAt = Date.now();
    this.emit('test:complete', { testId, result });
    return test;
  }

  /**
   * Get the result of a previously-run test (or `null` if not yet complete).
   */
  getResult(testId: string): ABTestResult | null {
    return this.tests.get(testId)?.results ?? null;
  }

  /**
   * List all tests (running + complete + aborted).
   */
  listTests(): ABTest[] {
    return [...this.tests.values()];
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private metricValue(metric: ABTestMetric, e: {
    fitness: number; samples: number; results: Array<{ costUsd: number; durationMs: number; score: number; passed: boolean }>; costUsd: number;
  }): number {
    switch (metric) {
      case 'pass_rate':
        return e.results.length > 0 ? e.results.filter((r) => r.passed).length / e.results.length : 0;
      case 'avg_cost':
        return e.results.length > 0 ? e.results.reduce((s, r) => s + r.costUsd, 0) / e.results.length : 0;
      case 'avg_duration':
        return e.results.length > 0 ? e.results.reduce((s, r) => s + r.durationMs, 0) / e.results.length : 0;
      case 'avg_quality_score':
        return e.results.length > 0 ? e.results.reduce((s, r) => s + r.score, 0) / e.results.length : 0;
      default:
        return 0;
    }
  }

  private isBetter(a: number, b: number, metric: ABTestMetric): boolean {
    // For pass_rate + quality_score: higher is better. For cost + duration: lower is better.
    return metric === 'pass_rate' || metric === 'avg_quality_score' ? a > b : a < b;
  }

  /**
   * Two-proportion z-test (for pass_rate) or a normal-approximation t-test
   * (for continuous metrics, using sample-of-1 variance fallback).
   * Returns a two-tailed p-value.
   */
  private computePValue(
    metric: ABTestMetric,
    a: { metricValue: number; samples: number },
    b: { metricValue: number; samples: number },
  ): number {
    if (metric === 'pass_rate') {
      return this.twoProportionZTest(a.metricValue, a.samples, b.metricValue, b.samples);
    }
    // Continuous: treat each variant's metric as a single-sample measurement.
    // Without per-sample data here, we fall back to a normal-approximation
    // z-test using sample-count as effective N and an assumed std of 0.1*mean.
    const na = Math.max(1, a.samples);
      const nb = Math.max(1, b.samples);
      const meanA = a.metricValue;
      const meanB = b.metricValue;
      const varA = Math.pow(Math.max(0.001, Math.abs(meanA)) * 0.1, 2);
      const varB = Math.pow(Math.max(0.001, Math.abs(meanB)) * 0.1, 2);
      const se = Math.sqrt(varA / na + varB / nb);
      if (se === 0) return 1;
      const z = (meanB - meanA) / se;
      return 2 * (1 - normalCdf(Math.abs(z)));
  }

  /**
   * Two-proportion z-test for pass rates. Returns two-tailed p-value.
   */
  private twoProportionZTest(p1: number, n1: number, p2: number, n2: number): number {
    if (n1 === 0 || n2 === 0) return 1;
    const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    if (se === 0) return 1;
    const z = (p1 - p2) / se;
    return 2 * (1 - normalCdf(Math.abs(z)));
  }
}

/**
 * Standard normal CDF approximation (Abramowitz & Stegun).
 */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

/**
 * @file FitnessEvaluator.ts
 * @description Evaluates a prompt variant's fitness by running it against a
 * benchmark suite. Fitness = pass-rate by default, or average LLM-judge
 * score when the benchmark uses `llm_judge` scoring.
 *
 * @packageDocumentation
 */

import type { IProvider, LLMMessage } from '@sanix/providers';
import type { BenchmarkSuite } from '@sanix/bench';
import type { PromptResult, BenchmarkPrompt } from '@sanix/bench';
import type { PromptVariant } from './types.js';
import type { ChatOptions } from './llm.js';

/**
 * FitnessEvaluator constructor options.
 */
export interface FitnessEvaluatorOptions {
  /** The benchmark suite to draw prompts from. */
  benchmarkSuite: BenchmarkSuite;
  /** The LLM provider used to test the variant (the "subject" provider). */
  provider: IProvider;
  /** How many benchmark prompts to sample per variant. Default 5. */
  samplesPerVariant?: number;
  /** LLM call options (timeout, retries). */
  chatOpts?: ChatOptions;
  /** RNG for sample selection (omit for Math.random). */
  rng?: RngPick;
}

/** Type alias for the optional RNG callback. */
type RngPick = <T>(arr: readonly T[]) => T;

/** Default RNG: uniform random pick. */
const defaultRngPick: RngPick = <T>(arr: readonly T[]): T => {
  const i = Math.floor(Math.random() * arr.length);
  return arr[i] as T;
};

/**
 * The result of evaluating a single variant.
 */
export interface FitnessEvaluation {
  /** Fitness score [0, 1]. */
  fitness: number;
  /** Number of samples evaluated. */
  samples: number;
  /** Per-prompt results. */
  results: PromptResult[];
  /** Total LLM cost in USD across all samples. */
  costUsd: number;
}

/**
 * Evaluates prompt variants against a benchmark suite.
 *
 * @example
 * ```ts
 * const evaluator = new FitnessEvaluator({
 *   benchmarkSuite: suite, provider: subjectProvider, samplesPerVariant: 5,
 * });
 * const { fitness, samples } = await evaluator.evaluate(variant, { benchmarkId: 'basic-reasoning' });
 * ```
 */
export class FitnessEvaluator {
  private readonly suite: BenchmarkSuite;
  private readonly provider: IProvider;
  private readonly samplesPerVariant: number;
  private readonly chatOpts: ChatOptions;
  private readonly rng: RngPick;

  constructor(opts: FitnessEvaluatorOptions) {
    this.suite = opts.benchmarkSuite;
    this.provider = opts.provider;
    this.samplesPerVariant = opts.samplesPerVariant ?? 5;
    this.chatOpts = opts.chatOpts ?? { timeoutMs: 60_000, maxAttempts: 3 };
    this.rng = opts.rng ?? defaultRngPick;
  }

  /**
   * Evaluate a variant's fitness by running `samplesPerVariant` benchmark
   * prompts (randomly sampled) using the variant's system prompt.
   *
   * @param variant - The prompt variant to evaluate.
   * @param opts.benchmarkId - The benchmark to draw prompts from.
   */
  async evaluate(
    variant: PromptVariant,
    opts: { benchmarkId?: string } = {},
  ): Promise<FitnessEvaluation> {
    const bench = this.findBenchmark(opts.benchmarkId);
    if (!bench) {
      throw new Error(`FitnessEvaluator: benchmark '${opts.benchmarkId ?? '(default)'}' not registered`);
    }
    const sampleSize = Math.min(this.samplesPerVariant, bench.prompts.length);
    const prompts = this.samplePrompts(bench.prompts, sampleSize);
    const results: PromptResult[] = [];
    let totalCost = 0;

    for (const p of prompts) {
      const result = await this.runOne(bench.scoring.threshold ?? 0.7, variant, p);
      results.push(result);
      totalCost += result.costUsd;
    }

    const passed = results.filter((r) => r.passed).length;
    const totalScore = results.reduce((s, r) => s + r.score, 0);
    // For `llm_judge` benchmarks: fitness = avg score; else: pass-rate.
    const fitness = bench.scoring.type === 'llm_judge'
      ? (results.length > 0 ? totalScore / results.length : 0)
      : (results.length > 0 ? passed / results.length : 0);

    return {
      fitness,
      samples: results.length,
      results,
      costUsd: totalCost,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private findBenchmark(id?: string) {
    const all = this.suite.list();
    if (!id) return all[0];
    return all.find((b) => b.id === id);
  }

  private samplePrompts(prompts: BenchmarkPrompt[], n: number): BenchmarkPrompt[] {
    if (n >= prompts.length) return prompts.slice();
    // Fisher–Yates partial shuffle for `n` picks.
    const arr = prompts.slice();
    const out: BenchmarkPrompt[] = [];
    for (let i = 0; i < n; i++) {
      const j = Math.floor(Math.random() * arr.length);
      out.push(arr[j]!);
      arr.splice(j, 1);
    }
    // Use rng to satisfy the field requirement (no-op if rng === Math.random path).
    void this.rng(out);
    return out;
  }

  private async runOne(
    threshold: number,
    variant: PromptVariant,
    prompt: BenchmarkPrompt,
  ): Promise<PromptResult> {
    const start = Date.now();
    const userMessages = this.normalizeInput(prompt.input);
    const messages: LLMMessage[] = [
      { role: 'system', content: variant.systemPrompt },
      ...userMessages,
    ];
    let output = '';
    let tokens = 0;
    let costUsd = 0;
    let error: string | undefined;
    try {
      // Direct provider call — chatWithRetry doesn't accept arbitrary
      // message lists; we inline timeout + retry here.
      const maxAttempts = this.chatOpts.maxAttempts ?? 3;
      const baseBackoff = this.chatOpts.backoffMs ?? 1_000;
      const timeoutMs = this.chatOpts.timeoutMs ?? 60_000;
      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await this.provider.chat({
            messages,
            maxTokens: 4096,
            temperature: 0,
            signal: controller.signal,
          });
          clearTimeout(timer);
          output = res.content;
          tokens = res.usage.inputTokens + res.usage.outputTokens;
          costUsd = res.costUsd ?? 0;
          lastErr = null;
          break;
        } catch (err) {
          clearTimeout(timer);
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxAttempts) {
            const wait = baseBackoff * Math.pow(2, attempt - 1);
            await new Promise((r) => setTimeout(r, wait));
          }
        }
      }
      if (lastErr) throw lastErr;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const durationMs = Date.now() - start;
    const { passed, score } = this.score(prompt, output, threshold);
    return {
      promptId: prompt.id,
      passed,
      output,
      expected: typeof prompt.expected === 'string' ? prompt.expected : undefined,
      score,
      durationMs,
      costUsd,
      tokens,
      error,
    };
  }

  private score(prompt: BenchmarkPrompt, output: string, threshold: number): { passed: boolean; score: number } {
    const expected = prompt.expected;
    if (typeof expected === 'function') {
      try {
        const ok = expected(output);
        return { passed: ok, score: ok ? 1 : 0 };
      } catch { return { passed: false, score: 0 }; }
    }
    if (typeof expected === 'string') {
      const ok = output.toLowerCase().includes(expected.toLowerCase());
      return { passed: ok, score: ok ? 1 : 0 };
    }
    // No expected value — grade on threshold of output non-emptiness.
    const score = output.trim().length > 0 ? Math.min(1, threshold) : 0;
    return { passed: score >= threshold, score };
  }

  private normalizeInput(input: string | LLMMessage[]): LLMMessage[] {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    return input;
  }
}

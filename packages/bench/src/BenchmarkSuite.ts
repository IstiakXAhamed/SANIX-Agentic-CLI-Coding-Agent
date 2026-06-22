/**
 * @file BenchmarkSuite.ts
 * @description The benchmark runner. Registers benchmarks, runs them
 * against a provider (or the AgentLoop), and produces {@link BenchmarkResult}s.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type {
  IProvider,
  LLMMessage,
  LLMRequest,
  LLMResponse,
} from '@sanix/providers';
import type {
  Benchmark,
  BenchmarkResult,
  PromptResult,
  RunOptions,
} from './types.js';
import { scoreOutput } from './Scorer.js';

/**
 * A chat function: given a list of messages, returns the LLM's response.
 * The suite accepts either a raw {@link IProvider} or a custom function
 * (useful for wiring the AgentLoop, custom routers, etc.).
 */
export type ChatFn = (
  messages: LLMMessage[],
  opts?: { signal?: AbortSignal; maxIterations?: number },
) => Promise<LLMResponse>;

/**
 * Constructor options for {@link BenchmarkSuite}.
 */
export interface BenchmarkSuiteOptions {
  /**
   * The provider used for non-agent benchmarks (direct `provider.chat()`).
   * Either this or {@link chatFn} must be supplied.
   */
  provider?: IProvider;
  /**
   * A custom chat function. When set, takes precedence over {@link provider}.
   * Useful for wiring the AgentLoop (the function may run multiple
   * iterations internally; the returned `LLMResponse` is the final answer).
   */
  chatFn?: ChatFn;
  /**
   * Optional judge function for `llm_judge` scoring. Given the prompt,
   * the model's output, and the expected answer, returns `true` if the
   * output passes the rubric.
   */
  judge?: (input: { prompt: string; output: string; expected: string }) => Promise<boolean>;
}

/**
 * A benchmark suite. Register benchmarks via {@link register}, then run
 * them via {@link run} or {@link runAll}.
 *
 * @example
 * ```ts
 * import { BenchmarkSuite, BUILTIN_BENCHMARKS } from '@sanix/bench';
 *
 * const suite = new BenchmarkSuite({ provider });
 * for (const b of BUILTIN_BENCHMARKS) suite.register(b);
 * const results = await suite.runAll({ parallel: 4 });
 * console.log(formatReport(results));
 * ```
 */
export class BenchmarkSuite {
  private readonly benchmarks: Map<string, Benchmark> = new Map();
  private readonly provider?: IProvider;
  private readonly chatFn?: ChatFn;
  private readonly judge?: BenchmarkSuiteOptions['judge'];

  /**
   * @param opts - See {@link BenchmarkSuiteOptions}.
   */
  constructor(opts: BenchmarkSuiteOptions) {
    this.provider = opts.provider;
    this.chatFn = opts.chatFn;
    this.judge = opts.judge;
    if (!this.provider && !this.chatFn) {
      throw new Error(
        'BenchmarkSuite: either `provider` or `chatFn` must be supplied.',
      );
    }
  }

  /**
   * Register a benchmark. If a benchmark with the same id is already
   * registered, it is replaced.
   */
  register(benchmark: Benchmark): void {
    this.benchmarks.set(benchmark.id, benchmark);
  }

  /**
   * List all registered benchmarks.
   */
  list(): Benchmark[] {
    return [...this.benchmarks.values()];
  }

  /**
   * Run a single benchmark by id.
   *
   * @param id   - The benchmark id.
   * @param opts - See {@link RunOptions}.
   * @returns The {@link BenchmarkResult}.
   */
  async run(id: string, opts: RunOptions = {}): Promise<BenchmarkResult> {
    const benchmark = this.benchmarks.get(id);
    if (!benchmark) {
      throw new Error(`BenchmarkSuite: unknown benchmark '${id}'`);
    }
    const repeat = Math.max(1, opts.repeat ?? 1);
    const parallel = Math.max(1, opts.parallel ?? 1);

    const promptResults: PromptResult[] = [];
    // Build the work list: prompts × repeats.
    const work: { promptId: string; prompt: typeof benchmark.prompts[number]; rep: number }[] = [];
    for (let r = 0; r < repeat; r++) {
      for (const p of benchmark.prompts) {
        work.push({ promptId: `${p.id}#${r + 1}`, prompt: p, rep: r });
      }
    }

    // Run with bounded parallelism.
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const runWorker = async (): Promise<void> => {
      while (cursor < work.length) {
        const job = work[cursor]!;
        cursor += 1;
        const result = await this.runPrompt(benchmark, job.prompt, job.promptId, opts);
        promptResults.push(result);
      }
    };
    for (let i = 0; i < parallel; i++) workers.push(runWorker());
    await Promise.all(workers);

    const totalCost = promptResults.reduce((s, r) => s + r.costUsd, 0);
    const totalTokens = promptResults.reduce((s, r) => s + r.tokens, 0);
    const duration = promptResults.reduce((s, r) => s + r.durationMs, 0);
    const passed = promptResults.filter((r) => r.passed).length;
    const failed = promptResults.length - passed;

    return {
      benchmarkId: id,
      runId: nanoid(),
      timestamp: Date.now(),
      durationMs: duration,
      totalCostUsd: totalCost,
      totalTokens,
      promptResults,
      summary: {
        passed,
        failed,
        passRate: promptResults.length > 0 ? passed / promptResults.length : 0,
        avgCostUsd: promptResults.length > 0 ? totalCost / promptResults.length : 0,
        avgDurationMs: promptResults.length > 0 ? duration / promptResults.length : 0,
      },
    };
  }

  /**
   * Run all registered benchmarks sequentially.
   *
   * @param opts - See {@link RunOptions}.
   * @returns An array of {@link BenchmarkResult}, one per benchmark.
   */
  async runAll(opts: RunOptions = {}): Promise<BenchmarkResult[]> {
    const out: BenchmarkResult[] = [];
    for (const b of this.benchmarks.keys()) {
      out.push(await this.run(b, opts));
    }
    return out;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Run a single prompt against the configured provider / chatFn.
   */
  private async runPrompt(
    benchmark: Benchmark,
    prompt: Benchmark['prompts'][number],
    promptId: string,
    _opts: RunOptions,
  ): Promise<PromptResult> {
    const start = Date.now();
    const messages = normalizeInput(prompt.input);
    let output = '';
    let tokens = 0;
    let costUsd = 0;
    let error: string | undefined;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        benchmark.timeout,
      );
      try {
        let res: LLMResponse;
        if (this.chatFn) {
          res = await this.chatFn(messages, {
            signal: controller.signal,
            maxIterations: prompt.maxIterations,
          });
        } else if (this.provider) {
          const req: LLMRequest = {
            messages,
            signal: controller.signal,
            maxTokens: 4096,
          };
          res = await this.provider.chat(req);
        } else {
          throw new Error('BenchmarkSuite: no provider or chatFn configured');
        }
        output = res.content;
        tokens = res.usage.inputTokens + res.usage.outputTokens;
        costUsd = res.costUsd ?? 0;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - start;

    // Score the output.
    let passed = false;
    let score = 0;
    let expectedStr: string | undefined;
    if (error) {
      passed = false;
      score = 0;
    } else if (benchmark.scoring.type === 'llm_judge') {
      if (this.judge && typeof prompt.expected === 'string') {
        expectedStr = prompt.expected;
        try {
          passed = await this.judge({
            prompt: typeof prompt.input === 'string'
              ? prompt.input
              : messages.map((m) => m.content).join('\n'),
            output,
            expected: prompt.expected,
          });
          score = passed ? 1 : 0;
        } catch (err) {
          error = `judge threw: ${(err as Error).message}`;
        }
      } else {
        // No judge configured — degrade to a `contains` match against the
        // expected string (best-effort).
        if (typeof prompt.expected === 'string') {
          expectedStr = prompt.expected;
          passed = output.toLowerCase().includes(prompt.expected.toLowerCase());
          score = passed ? 1 : 0;
        }
      }
    } else {
      const outcome = scoreOutput(benchmark.scoring, output, prompt.expected);
      passed = outcome.passed;
      score = outcome.score;
      expectedStr = outcome.expected;
      if (outcome.error && !error) error = outcome.error;
    }

    return {
      promptId,
      passed,
      output,
      expected: expectedStr,
      score,
      durationMs,
      costUsd,
      tokens,
      error,
    };
  }
}

/**
 * Normalize a prompt input into a `LLMMessage[]`.
 */
function normalizeInput(input: string | LLMMessage[]): LLMMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  return input;
}

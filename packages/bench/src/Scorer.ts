/**
 * @file Scorer.ts
 * @description Scoring engine for benchmark prompts. Given a
 * {@link ScoringSpec}, an expected value, and the model's output, returns
 * a `PromptResult`-shaped score.
 *
 * @packageDocumentation
 */

import type { ScoringSpec } from './types.js';

/**
 * The result of scoring a single prompt.
 */
export interface ScoreOutcome {
  /** `true` if the prompt passed. */
  passed: boolean;
  /** Numeric score [0, 1]. */
  score: number;
  /** The expected answer (string form), if applicable. */
  expected?: string;
  /** Error message, if scoring itself failed. */
  error?: string;
}

/**
 * Score an output against an expected value using the given spec.
 *
 * @param spec     - The scoring spec.
 * @param output   - The model's output.
 * @param expected - The expected value (string or predicate). For
 *                   `llm_judge`, the string is the rubric / reference.
 * @returns A {@link ScoreOutcome}.
 *
 * @example
 * ```ts
 * const out = scoreOutput(
 *   { type: 'contains' },
 *   'The capital of France is Paris.',
 *   'Paris',
 * );
 * console.log(out.passed, out.score); // true, 1
 * ```
 */
export function scoreOutput(
  spec: ScoringSpec,
  output: string,
  expected?: string | ((output: string) => boolean),
): ScoreOutcome {
  const out = (output ?? '').trim();
  switch (spec.type) {
    case 'exact': {
      if (typeof expected !== 'string') {
        return { passed: false, score: 0, error: 'exact scoring requires string expected' };
      }
      const ok = out === expected.trim();
      return { passed: ok, score: ok ? 1 : 0, expected };
    }
    case 'contains': {
      if (typeof expected !== 'string') {
        return { passed: false, score: 0, error: 'contains scoring requires string expected' };
      }
      const ok = out.toLowerCase().includes(expected.toLowerCase());
      return { passed: ok, score: ok ? 1 : 0, expected };
    }
    case 'regex': {
      if (typeof expected !== 'string') {
        return { passed: false, score: 0, error: 'regex scoring requires string expected' };
      }
      let re: RegExp;
      try {
        re = new RegExp(expected);
      } catch (err) {
        return { passed: false, score: 0, expected, error: `invalid regex: ${(err as Error).message}` };
      }
      const ok = re.test(out);
      return { passed: ok, score: ok ? 1 : 0, expected };
    }
    case 'custom': {
      if (typeof expected !== 'function') {
        return { passed: false, score: 0, error: 'custom scoring requires a predicate' };
      }
      try {
        const ok = expected(out);
        return { passed: ok, score: ok ? 1 : 0 };
      } catch (err) {
        return { passed: false, score: 0, error: `custom scorer threw: ${(err as Error).message}` };
      }
    }
    case 'llm_judge': {
      // llm_judge requires an external LLM call; we surface this as a
      // degenerate result here. The BenchmarkSuite wires up the actual
      // judge call before invoking the scorer, replacing `llm_judge`
      // with `custom` + a predicate that captures the judge's verdict.
      return {
        passed: false,
        score: 0,
        expected: typeof expected === 'string' ? expected : undefined,
        error: 'llm_judge scoring must be replaced with custom by the suite',
      };
    }
  }
}

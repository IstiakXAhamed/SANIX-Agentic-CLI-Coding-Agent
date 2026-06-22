/**
 * @file MetaLearner.ts
 * @description Learns which mutation strategies work best for which kinds
 * of prompts. Uses a simple multi-armed bandit (epsilon-greedy,
 * epsilon=0.1) to balance exploration vs exploitation when recommending
 * the next mutation to try.
 *
 * @packageDocumentation
 */

import { ALL_MUTATION_TYPES, ALL_PROMPT_CATEGORIES } from './types.js';
import type { MutationType, PromptCategory } from './types.js';

/**
 * Per-(mutation, category) statistics.
 */
interface OutcomeStat {
  count: number;
  totalDelta: number;
  successes: number;   // # of times fitnessDelta > 0
}

/**
 * MetaLearner constructor options.
 */
export interface MetaLearnerOptions {
  /** Exploration rate (0 = pure exploitation, 1 = pure exploration). Default 0.1. */
  epsilon?: number;
  /** RNG for reproducibility (omit for Math.random). */
  rng?: () => number;
}

/**
 * Multi-armed bandit over (mutation × prompt-category) pairs. Tracks the
 * historical average fitness-delta of each combination and recommends the
 * best mutation for a given category — while occasionally exploring.
 *
 * @example
 * ```ts
 * const ml = new MetaLearner();
 * ml.recordOutcome('add_examples', 'coding', +0.1);
 * ml.recordOutcome('paraphrase', 'coding', -0.05);
 * ml.recommendMutation('coding');  // → 'add_examples' (most likely)
 * ```
 */
export class MetaLearner {
  private readonly epsilon: number;
  private readonly rng: () => number;
  private readonly outcomes: Map<string, OutcomeStat> = new Map();

  constructor(opts: MetaLearnerOptions = {}) {
    this.epsilon = opts.epsilon ?? 0.1;
    this.rng = opts.rng ?? Math.random;
  }

  /**
   * Record the outcome (`fitnessDelta`) of applying `mutationType` to a
   * prompt in category `promptCategory`.
   *
   * @param mutationType   - The mutation strategy used.
   * @param promptCategory - The prompt category.
   * @param fitnessDelta   - Change in fitness (post - pre).
   */
  recordOutcome(mutationType: MutationType, promptCategory: PromptCategory, fitnessDelta: number): void {
    const key = this.key(mutationType, promptCategory);
    const cur = this.outcomes.get(key) ?? { count: 0, totalDelta: 0, successes: 0 };
    cur.count += 1;
    cur.totalDelta += fitnessDelta;
    if (fitnessDelta > 0) cur.successes += 1;
    this.outcomes.set(key, cur);
  }

  /**
   * Recommend the next mutation to try for `promptCategory`. Uses
   * epsilon-greedy: with probability `epsilon`, explore (random mutation);
   * otherwise, exploit (mutation with highest historical avg delta).
   */
  recommendMutation(promptCategory: PromptCategory): MutationType {
    // Epsilon-greedy exploration.
    if (this.rng() < this.epsilon) {
      // Pick a random non-'random' mutation.
      const pool = ALL_MUTATION_TYPES.filter((m) => m !== 'random');
      return pool[Math.floor(this.rng() * pool.length)]!;
    }
    // Exploitation: best historical avg delta for this category.
    let best: MutationType | null = null;
    let bestAvg = -Infinity;
    for (const m of ALL_MUTATION_TYPES) {
      if (m === 'random') continue;
      const stat = this.outcomes.get(this.key(m, promptCategory));
      if (!stat || stat.count === 0) {
        // Untried — give it a small optimistic prior.
        if (bestAvg < 0.001) { best = m; bestAvg = 0.001; }
        continue;
      }
      const avg = stat.totalDelta / stat.count;
      if (avg > bestAvg) { best = m; bestAvg = avg; }
    }
    return best ?? 'paraphrase';
  }

  /**
   * Aggregate stats per mutation type (across all categories).
   */
  stats(): Record<MutationType, { count: number; avgDelta: number; successRate: number }> {
    const out = {} as Record<MutationType, { count: number; avgDelta: number; successRate: number }>;
    for (const m of ALL_MUTATION_TYPES) {
      let count = 0, totalDelta = 0, successes = 0;
      for (const c of ALL_PROMPT_CATEGORIES) {
        const s = this.outcomes.get(this.key(m, c));
        if (s) {
          count += s.count;
          totalDelta += s.totalDelta;
          successes += s.successes;
        }
      }
      out[m] = {
        count,
        avgDelta: count > 0 ? totalDelta / count : 0,
        successRate: count > 0 ? successes / count : 0,
      };
    }
    return out;
  }

  /**
   * Serialize the learner's state to a plain object (for persistence).
   */
  toJSON(): Record<string, OutcomeStat> {
    return Object.fromEntries(this.outcomes.entries());
  }

  /**
   * Hydrate from a previously-serialized state.
   */
  static fromJSON(data: Record<string, OutcomeStat>, opts?: MetaLearnerOptions): MetaLearner {
    const ml = new MetaLearner(opts);
    for (const [k, v] of Object.entries(data)) {
      ml.outcomes.set(k, { ...v });
    }
    return ml;
  }

  private key(m: MutationType, c: PromptCategory): string {
    return `${m}|${c}`;
  }
}

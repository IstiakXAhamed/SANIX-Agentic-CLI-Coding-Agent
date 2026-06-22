/**
 * @file Selection.ts
 * @description Selection algorithms for the evolutionary loop. All methods
 * are deterministic given the same input + RNG instance.
 *
 * @packageDocumentation
 */

import type { PromptVariant } from './types.js';
import type { Rng } from './rng.js';

/**
 * Selection algorithms for the evolutionary loop.
 *
 * @example
 * ```ts
 * const sel = new Selection(rng);
 * const parent = sel.tournament(population, 3);
 * const elites = sel.elite(population, 0.2);
 * ```
 */
export class Selection {
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  /**
   * Tournament selection: pick `size` random variants, return the one with
   * the highest fitness. Ties broken by lower id (deterministic).
   *
   * @param size - Tournament size (≥ 1). Default 3.
   */
  tournament(population: PromptVariant[], size = 3): PromptVariant {
    if (population.length === 0) throw new Error('Selection.tournament: empty population');
    if (size < 1) size = 1;
    const contestants: PromptVariant[] = [];
    for (let i = 0; i < Math.min(size, population.length); i++) {
      contestants.push(this.rng.pick(population));
    }
    return contestants.reduce((best, v) => (this.fitness(v) > this.fitness(best) ? v : best), contestants[0]!);
  }

  /**
   * Roulette-wheel selection: probability of selection is proportional to
   * fitness. Returns `null` if all variants have zero fitness.
   */
  roulette(population: PromptVariant[]): PromptVariant {
    if (population.length === 0) throw new Error('Selection.roulette: empty population');
    const fitnesses = population.map((v) => Math.max(0, this.fitness(v)));
    const total = fitnesses.reduce((a, b) => a + b, 0);
    if (total === 0) {
      // All-zero — fall back to uniform random.
      return this.rng.pick(population);
    }
    let r = this.rng.next() * total;
    for (let i = 0; i < population.length; i++) {
      r -= fitnesses[i]!;
      if (r <= 0) return population[i]!;
    }
    return population[population.length - 1]!;
  }

  /**
   * Rank-based selection: probability is proportional to rank (linear).
   * The highest-fitness variant gets rank N, the lowest gets rank 1.
   */
  rank(population: PromptVariant[]): PromptVariant {
    if (population.length === 0) throw new Error('Selection.rank: empty population');
    const sorted = population.slice().sort((a, b) => this.fitness(a) - this.fitness(b));
    const total = (sorted.length * (sorted.length + 1)) / 2;
    let r = this.rng.next() * total;
    for (let i = 0; i < sorted.length; i++) {
      r -= (i + 1);
      if (r <= 0) return sorted[i]!;
    }
    return sorted[sorted.length - 1]!;
  }

  /**
   * Elite selection: return the top `fraction` of the population by fitness
   * (at least 1, at most `population.length`).
   *
   * @param fraction - Elite fraction in [0, 1].
   */
  elite(population: PromptVariant[], fraction: number): PromptVariant[] {
    if (population.length === 0) return [];
    const count = Math.max(1, Math.round(population.length * fraction));
    return population
      .slice()
      .sort((a, b) => this.fitness(b) - this.fitness(a))
      .slice(0, count);
  }

  private fitness(v: PromptVariant): number {
    return v.fitness ?? 0;
  }
}

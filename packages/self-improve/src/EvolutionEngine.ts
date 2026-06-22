/**
 * @file EvolutionEngine.ts
 * @description The full evolutionary loop: generates an initial population,
 * evaluates fitness, then for each generation selects elites + applies
 * crossover + mutation to fill the remaining slots. Emits events at each
 * stage. Reproducible via seedable RNG.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import type {
  EvolutionConfig,
  EvolutionResult,
  GenerationResult,
  PromptVariant,
} from './types.js';
import { DEFAULT_EVOLUTION_CONFIG } from './types.js';
import { PromptMutator } from './PromptMutator.js';
import { FitnessEvaluator } from './FitnessEvaluator.js';
import { Selection } from './Selection.js';
import { createRng, type Rng } from './rng.js';

/**
 * Events emitted by {@link EvolutionEngine}.
 */
export interface EvolutionEngineEvents {
  /** Emitted once when `run()` starts. */
  'evolution:start': { config: EvolutionConfig; seedPrompt: string };
  /** Emitted at the start of each generation (including the initial population). */
  'generation:start': { generation: number; populationSize: number };
  /** Emitted when a variant's fitness has been evaluated. */
  'variant:evaluated': { variant: PromptVariant; fitness: number; costUsd: number };
  /** Emitted at the end of each generation with aggregate stats. */
  'generation:complete': { result: GenerationResult };
  /** Emitted once when the entire run completes. */
  'evolution:complete': { result: EvolutionResult };
  /** Emitted on internal errors. */
  'error': { error: Error };
}

/**
 * EvolutionEngine constructor options.
 */
export interface EvolutionEngineOptions {
  /** The mutator used to produce new variants. */
  mutator: PromptMutator;
  /** The evaluator used to score variants. */
  evaluator: FitnessEvaluator;
  /** The seed prompt (generation 0). */
  seedPrompt: string;
  /** Optional override RNG (used for reproducibility). */
  rng?: Rng;
}

/**
 * Runs the full evolutionary loop.
 *
 * Algorithm:
 *   1. Generate the initial population (size N) from the seed prompt.
 *   2. Evaluate fitness for each.
 *   3. For each generation:
 *      a. Select elites (top X%) — carry over unchanged.
 *      b. For the remaining slots: select parents via the configured method,
 *         apply crossover (prob `crossoverRate`), apply mutation (prob `mutationRate`).
 *      c. Evaluate the new variants' fitness.
 *      d. Record generation stats.
 *   4. After `generations` rounds, return the best variant.
 *
 * @example
 * ```ts
 * const engine = new EvolutionEngine(config, { mutator, evaluator, seedPrompt });
 * engine.on('generation:complete', ({ result }) => console.log(result.bestFitness));
 * const final = await engine.run();
 * ```
 */
export class EvolutionEngine extends EventEmitter<EvolutionEngineEvents> {
  private readonly config: EvolutionConfig;
  private readonly mutator: PromptMutator;
  private readonly evaluator: FitnessEvaluator;
  private readonly seedPrompt: string;
  private readonly rng: Rng;
  private readonly selection: Selection;

  constructor(config: EvolutionConfig, opts: EvolutionEngineOptions) {
    super();
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    this.mutator = opts.mutator;
    this.evaluator = opts.evaluator;
    this.seedPrompt = opts.seedPrompt;
    this.rng = opts.rng ?? createRng(this.config.seed ?? DEFAULT_EVOLUTION_CONFIG.seed!);
    this.selection = new Selection(this.rng);
  }

  /**
   * Run the full evolutionary loop. Returns the {@link EvolutionResult} once
   * all generations are complete.
   */
  async run(): Promise<EvolutionResult> {
    const start = Date.now();
    this.emit('evolution:start', { config: this.config, seedPrompt: this.seedPrompt });

    const history: GenerationResult[] = [];
    let totalEvaluations = 0;
    let totalCostUsd = 0;

    // 1. Initial population.
    this.emit('generation:start', { generation: 0, populationSize: this.config.populationSize });
    let population = await this.mutator.generateInitialPopulation(this.seedPrompt, this.config.populationSize);
    for (const v of population) {
      const evalResult = await this.evaluate(v);
      v.fitness = evalResult.fitness;
      v.samples = evalResult.samples;
      totalEvaluations++;
      totalCostUsd += evalResult.costUsd;
      this.emit('variant:evaluated', { variant: v, fitness: v.fitness!, costUsd: evalResult.costUsd });
    }
    const gen0 = this.summarize(0, population);
    history.push(gen0);
    this.emit('generation:complete', { result: gen0 });

    // 2. Subsequent generations.
    for (let g = 1; g <= this.config.generations; g++) {
      this.emit('generation:start', { generation: g, populationSize: this.config.populationSize });
      const next = await this.evolveOneGeneration(population);
      for (const v of next) {
        // Only evaluate newly-produced variants (skip carried-over elites).
        if (v.fitness === undefined) {
          const evalResult = await this.evaluate(v);
          v.fitness = evalResult.fitness;
          v.samples = evalResult.samples;
          totalEvaluations++;
          totalCostUsd += evalResult.costUsd;
          this.emit('variant:evaluated', { variant: v, fitness: v.fitness!, costUsd: evalResult.costUsd });
        }
      }
      population = next;
      const genResult = this.summarize(g, population);
      history.push(genResult);
      this.emit('generation:complete', { result: genResult });
    }

    const bestVariant = population.reduce(
      (best, v) => ((v.fitness ?? 0) > (best.fitness ?? 0) ? v : best),
      population[0]!,
    );

    const result: EvolutionResult = {
      bestVariant,
      finalPopulation: population,
      history,
      totalEvaluations,
      totalCostUsd,
      durationMs: Date.now() - start,
    };
    this.emit('evolution:complete', { result });
    return result;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private async evaluate(variant: PromptVariant): Promise<{ fitness: number; samples: number; costUsd: number }> {
    try {
      const r = await this.evaluator.evaluate(variant, { benchmarkId: this.config.benchmarkId });
      return { fitness: r.fitness, samples: r.samples, costUsd: r.costUsd };
    } catch (err) {
      this.emit('error', { error: err instanceof Error ? err : new Error(String(err)) });
      return { fitness: 0, samples: 0, costUsd: 0 };
    }
  }

  private async evolveOneGeneration(prev: PromptVariant[]): Promise<PromptVariant[]> {
    const next: PromptVariant[] = [];
    // Elites.
    const elites = this.selection.elite(prev, this.config.eliteFraction);
    next.push(...elites.map((e) => ({ ...e })));

    // Fill remaining slots.
    while (next.length < this.config.populationSize) {
      const parentA = this.selectParent(prev);
      let child: PromptVariant;
      if (this.rng.next() < this.config.crossoverRate) {
        const parentB = this.selectParent(prev);
        child = await this.mutator.crossover(parentA, parentB);
      } else {
        child = parentA;
      }
      if (this.rng.next() < this.config.mutationRate) {
        child = await this.mutator.mutate(child, 'random');
      }
      // Clear fitness so we know to evaluate it.
      child = { ...child, fitness: undefined };
      next.push(child);
    }
    return next.slice(0, this.config.populationSize);
  }

  private selectParent(population: PromptVariant[]): PromptVariant {
    switch (this.config.selectionMethod) {
      case 'tournament':
        return this.selection.tournament(population, this.config.tournamentSize ?? 3);
      case 'roulette':
        return this.selection.roulette(population);
      case 'rank':
        return this.selection.rank(population);
      case 'elite':
        return this.selection.elite(population, this.config.eliteFraction)[0]!;
      default:
        return this.selection.tournament(population, this.config.tournamentSize ?? 3);
    }
  }

  private summarize(generation: number, population: PromptVariant[]): GenerationResult {
    const fs = population.map((v) => v.fitness ?? 0);
    const best = Math.max(...fs, 0);
    const worst = Math.min(...fs, 0);
    const avg = fs.length > 0 ? fs.reduce((a, b) => a + b, 0) / fs.length : 0;
    return {
      generation,
      population: population.slice(),
      bestFitness: best,
      avgFitness: avg,
      worstFitness: worst,
      diversity: this.diversity(population),
    };
  }

  /** Diversity = 1 - (avg pairwise prompt equality). Crude but cheap. */
  private diversity(population: PromptVariant[]): number {
    if (population.length < 2) return 0;
    let same = 0;
    let total = 0;
    for (let i = 0; i < population.length; i++) {
      for (let j = i + 1; j < population.length; j++) {
        total++;
        if (population[i]!.systemPrompt === population[j]!.systemPrompt) same++;
      }
    }
    return total === 0 ? 0 : 1 - same / total;
  }
}

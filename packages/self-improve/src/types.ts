/**
 * @file types.ts
 * @description Type system for `@sanix/self-improve`. Defines the prompt
 * variant, mutation, A/B test, evolution config, and evolution result
 * contracts used throughout the package.
 *
 * @packageDocumentation
 */

/**
 * A prompt variant — a single candidate in the evolutionary search. Carries
 * its full system prompt + genealogy (parent + generation + mutation type)
 * + fitness score once evaluated.
 */
export interface PromptVariant {
  /** Stable unique id (nanoid). */
  id: string;
  /** Human-readable name (used in reporter output). */
  name: string;
  /** The system prompt under test. */
  systemPrompt: string;
  /** Short description of what makes this variant different. */
  description: string;
  /** Unix ms timestamp when the variant was created. */
  createdAt: number;
  /** Parent variant id (for evolutionary genealogy tracking). */
  parent?: string;
  /** Generation number — 0 for the original, 1 for first mutation, etc. */
  generation: number;
  /** How this variant was produced from its parent. */
  mutationType?: MutationType;
  /** Fitness score [0, 1] from the benchmark suite (undefined = unevaluated). */
  fitness?: number;
  /** How many benchmark samples were evaluated to compute `fitness`. */
  samples: number;
}

/**
 * Mutation strategies for prompt variants. Each strategy asks the LLM to
 * rewrite the prompt in a different way.
 */
export type MutationType =
  | 'paraphrase'
  | 'add_examples'
  | 'add_constraints'
  | 'simplify'
  | 'expand'
  | 'reorder'
  | 'tone_shift'
  | 'persona_shift'
  | 'random';

/**
 * The metric an A/B test optimizes for.
 */
export type ABTestMetric =
  | 'pass_rate'
  | 'avg_cost'
  | 'avg_duration'
  | 'avg_quality_score';

/**
 * An A/B test definition.
 */
export interface ABTest {
  /** Stable unique id (nanoid). */
  id: string;
  /** Human-readable test name. */
  name: string;
  /** The variants under comparison (≥ 2). */
  variants: PromptVariant[];
  /** The metric being compared. */
  metric: ABTestMetric;
  /** The benchmark id to run against. */
  benchmarkId: string;
  /** How many benchmark samples to run per variant. */
  samplesPerVariant: number;
  /** Current test status. */
  status: 'running' | 'complete' | 'aborted';
  /** Result, once the test completes. */
  results?: ABTestResult;
  /** Unix ms timestamp when the test was created. */
  createdAt: number;
  /** Unix ms timestamp when the test completed. */
  completedAt?: number;
}

/**
 * The result of an A/B test, including the winner + statistical significance.
 */
export interface ABTestResult {
  /** The winning variant's id. */
  winnerId: string;
  /** Per-variant result records. */
  variantResults: Array<{
    /** The variant id. */
    variantId: string;
    /** The metric value for this variant (e.g. pass rate). */
    metricValue: number;
    /** Number of samples evaluated. */
    samples: number;
    /** Confidence [0, 1] = 1 - p-value. */
    confidence: number;
  }>;
  /** The p-value from the statistical significance test. */
  statisticalSignificance: number;
  /** Relative improvement of the winner over the baseline (0..1). */
  improvement: number;
}

/**
 * Configuration for an evolutionary run.
 */
export interface EvolutionConfig {
  /** Population size per generation. Default 8. */
  populationSize: number;
  /** Number of generations to evolve. Default 5. */
  generations: number;
  /** Mutation probability [0, 1]. Default 0.3. */
  mutationRate: number;
  /** Crossover probability [0, 1]. Default 0.2. */
  crossoverRate: number;
  /** Elite fraction [0, 1] carried over unchanged each generation. Default 0.2. */
  eliteFraction: number;
  /** Benchmark id to evaluate fitness against. */
  benchmarkId: string;
  /** How many benchmark samples to run per variant. Default 5. */
  samplesPerVariant: number;
  /** Selection algorithm. */
  selectionMethod: 'tournament' | 'roulette' | 'rank' | 'elite';
  /** Tournament size (only used when `selectionMethod='tournament'`). Default 3. */
  tournamentSize?: number;
  /** RNG seed for reproducibility. Default 0xSANIX. */
  seed?: number;
}

/**
 * The aggregate result of an evolutionary run.
 */
export interface EvolutionResult {
  /** The best variant found across all generations. */
  bestVariant: PromptVariant;
  /** Final population (after the last generation). */
  finalPopulation: PromptVariant[];
  /** Per-generation statistics. */
  history: GenerationResult[];
  /** Total benchmark evaluations performed. */
  totalEvaluations: number;
  /** Total LLM cost in USD across all evaluations + mutations. */
  totalCostUsd: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

/**
 * Statistics for a single generation.
 */
export interface GenerationResult {
  /** The generation number (0 = initial population). */
  generation: number;
  /** The population at the end of this generation. */
  population: PromptVariant[];
  /** Best fitness in the population. */
  bestFitness: number;
  /** Average fitness across the population. */
  avgFitness: number;
  /** Worst fitness in the population. */
  worstFitness: number;
  /** Diversity score [0, 1] — how different the population's prompts are. */
  diversity: number;
}

/**
 * Categories of prompts used by the {@link MetaLearner} to track which
 * mutation strategies work best for which kinds of prompts.
 */
export type PromptCategory =
  | 'coding'
  | 'reasoning'
  | 'creative'
  | 'extraction'
  | 'summarization'
  | 'classification'
  | 'general';

/** All mutation types as a stable array (used by MetaLearner). */
export const ALL_MUTATION_TYPES: MutationType[] = [
  'paraphrase',
  'add_examples',
  'add_constraints',
  'simplify',
  'expand',
  'reorder',
  'tone_shift',
  'persona_shift',
  'random',
];

/** All prompt categories as a stable array. */
export const ALL_PROMPT_CATEGORIES: PromptCategory[] = [
  'coding',
  'reasoning',
  'creative',
  'extraction',
  'summarization',
  'classification',
  'general',
];

/**
 * Default evolution config (used when callers omit fields).
 */
export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  populationSize: 8,
  generations: 5,
  mutationRate: 0.3,
  crossoverRate: 0.2,
  eliteFraction: 0.2,
  benchmarkId: 'basic-reasoning',
  samplesPerVariant: 5,
  selectionMethod: 'tournament',
  tournamentSize: 3,
  seed: 0x5a4e,
};

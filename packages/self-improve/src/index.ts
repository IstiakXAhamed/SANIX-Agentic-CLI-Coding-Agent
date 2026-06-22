/**
 * @file index.ts
 * @description Public entry point for `@sanix/self-improve`. Re-exports the
 * manager, evolution engine, A/B tester, prompt mutator, fitness evaluator,
 * selection, prompt registry, meta learner, and all shared types.
 *
 * Importing paths:
 *   import { SelfImprovementManager, EvolutionEngine, PromptMutator } from '@sanix/self-improve';
 *   import type { PromptVariant, EvolutionConfig } from '@sanix/self-improve';
 *
 * @packageDocumentation
 */

// ── Top-level facade ──────────────────────────────────────────────────────
export {
  SelfImprovementManager,
  type SelfImprovementManagerOptions,
  type SelfImprovementManagerEvents,
} from './SelfImprovementManager.js';

// ── Engines ──────────────────────────────────────────────────────────────
export {
  EvolutionEngine,
  type EvolutionEngineOptions,
  type EvolutionEngineEvents,
} from './EvolutionEngine.js';

export {
  ABTester,
  type ABTesterOptions,
  type ABTesterEvents,
} from './ABTester.js';

// ── Components ────────────────────────────────────────────────────────────
export {
  PromptMutator,
  type PromptMutatorOptions,
} from './PromptMutator.js';

export {
  FitnessEvaluator,
  type FitnessEvaluatorOptions,
  type FitnessEvaluation,
} from './FitnessEvaluator.js';

export { Selection } from './Selection.js';

export {
  PromptRegistry,
  type PromptRegistryOptions,
} from './PromptRegistry.js';

export {
  MetaLearner,
  type MetaLearnerOptions,
} from './MetaLearner.js';

// ── RNG ───────────────────────────────────────────────────────────────────
export { createRng, type Rng } from './rng.js';

// ── LLM helpers ──────────────────────────────────────────────────────────
export { chatWithRetry, chatWithSystem, type ChatOptions } from './llm.js';

// ── Shared types + constants ──────────────────────────────────────────────
export type {
  PromptVariant,
  MutationType,
  ABTest,
  ABTestMetric,
  ABTestResult,
  EvolutionConfig,
  EvolutionResult,
  GenerationResult,
  PromptCategory,
} from './types.js';

export {
  ALL_MUTATION_TYPES,
  ALL_PROMPT_CATEGORIES,
  DEFAULT_EVOLUTION_CONFIG,
} from './types.js';

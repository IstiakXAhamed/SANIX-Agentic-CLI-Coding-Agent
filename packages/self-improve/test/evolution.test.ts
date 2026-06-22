/**
 * @file evolution.test.ts
 * @description End-to-end EvolutionEngine tests with a small population
 * + few generations. Verifies best-variant selection, generation stats,
 * lineage tracking.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EvolutionEngine, PromptMutator, FitnessEvaluator } from '@sanix/self-improve';
import type { EvolutionConfig, PromptVariant } from '@sanix/self-improve';
import { BenchmarkSuite } from '@sanix/bench';
import type { Benchmark } from '@sanix/bench';
import { createMockProvider } from '../../../test/helpers/mockProvider.js';

function buildBenchmark(): Benchmark {
  return {
    id: 'test-basic',
    name: 'Test Basic',
    description: 'Tiny benchmark for evolution tests.',
    category: 'reasoning',
    prompts: [
      { id: 'p1', input: 'What is 2+2?', expected: '4' },
      { id: 'p2', input: 'What is 3+3?', expected: '6' },
      { id: 'p3', input: 'What is the capital of France?', expected: 'paris' },
      { id: 'p4', input: 'Spell "hello".', expected: 'hello' },
    ],
    scoring: { type: 'contains', threshold: 0.7 },
    timeout: 5_000,
  };
}

describe('EvolutionEngine', () => {
  let mutatorProvider: ReturnType<typeof createMockProvider>;
  let subjectProvider: ReturnType<typeof createMockProvider>;
  let suite: BenchmarkSuite;

  beforeEach(() => {
    mutatorProvider = createMockProvider({
      // Mutator returns a slightly modified prompt.
      responses: (req) => {
        const last = req.messages[req.messages.length - 1];
        const content = typeof last?.content === 'string' ? last.content : '';
        // Just append a marker so the prompt is "different".
        return content + '\n\nBe precise.';
      },
      usage: { inputTokens: 5, outputTokens: 10 },
    });
    subjectProvider = createMockProvider({
      // Subject answers every prompt correctly (contains the expected substring).
      responses: 'The answer is 4. Or 6. Or Paris. Or hello.',
      usage: { inputTokens: 10, outputTokens: 20 },
      costUsd: 0.0001,
    });
    suite = new BenchmarkSuite({ provider: subjectProvider });
    suite.register(buildBenchmark());
  });

  it('runs N generations and returns a result', async () => {
    const config: EvolutionConfig = {
      populationSize: 4,
      generations: 2,
      mutationRate: 0.5,
      crossoverRate: 0.3,
      eliteFraction: 0.25,
      benchmarkId: 'test-basic',
      samplesPerVariant: 2,
      selectionMethod: 'tournament',
      tournamentSize: 2,
      seed: 42,
    };
    const mutator = new PromptMutator({ provider: mutatorProvider });
    const evaluator = new FitnessEvaluator({
      benchmarkSuite: suite,
      provider: subjectProvider,
      samplesPerVariant: 2,
    });
    const engine = new EvolutionEngine(config, {
      mutator,
      evaluator,
      seedPrompt: 'You are a helpful assistant.',
    });

    const result = await engine.run();
    expect(result.finalPopulation.length).toBe(4);
    expect(result.history.length).toBe(3); // 0 + 2 generations.
    expect(result.totalEvaluations).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // bestVariant has a non-empty prompt.
    expect(result.bestVariant.systemPrompt.length).toBeGreaterThan(0);
    expect(result.bestVariant.fitness).toBeDefined();
  });

  it('records per-generation stats in history', async () => {
    const config: EvolutionConfig = {
      populationSize: 4,
      generations: 2,
      mutationRate: 0.3,
      crossoverRate: 0.2,
      eliteFraction: 0.25,
      benchmarkId: 'test-basic',
      samplesPerVariant: 2,
      selectionMethod: 'rank',
      seed: 7,
    };
    const mutator = new PromptMutator({ provider: mutatorProvider });
    const evaluator = new FitnessEvaluator({
      benchmarkSuite: suite,
      provider: subjectProvider,
      samplesPerVariant: 2,
    });
    const engine = new EvolutionEngine(config, {
      mutator,
      evaluator,
      seedPrompt: 'Original prompt.',
    });

    const result = await engine.run();
    expect(result.history.length).toBe(3);
    for (const gen of result.history) {
      expect(typeof gen.generation).toBe('number');
      expect(gen.population.length).toBeGreaterThan(0);
      expect(typeof gen.bestFitness).toBe('number');
      expect(typeof gen.avgFitness).toBe('number');
      expect(typeof gen.worstFitness).toBe('number');
      expect(typeof gen.diversity).toBe('number');
      expect(gen.bestFitness).toBeGreaterThanOrEqual(gen.worstFitness);
      expect(gen.avgFitness).toBeGreaterThanOrEqual(gen.worstFitness);
      expect(gen.avgFitness).toBeLessThanOrEqual(gen.bestFitness);
    }
  });

  it('best variant has the highest fitness in the final population', async () => {
    const config: EvolutionConfig = {
      populationSize: 4,
      generations: 2,
      mutationRate: 0.4,
      crossoverRate: 0.2,
      eliteFraction: 0.25,
      benchmarkId: 'test-basic',
      samplesPerVariant: 2,
      selectionMethod: 'tournament',
      tournamentSize: 2,
      seed: 99,
    };
    const mutator = new PromptMutator({ provider: mutatorProvider });
    const evaluator = new FitnessEvaluator({
      benchmarkSuite: suite,
      provider: subjectProvider,
      samplesPerVariant: 2,
    });
    const engine = new EvolutionEngine(config, {
      mutator,
      evaluator,
      seedPrompt: 'Original prompt.',
    });

    const result = await engine.run();
    const bestFitness = result.bestVariant.fitness ?? 0;
    for (const v of result.finalPopulation) {
      expect(bestFitness).toBeGreaterThanOrEqual(v.fitness ?? 0);
    }
  });

  it('lineage: every non-seed variant has a parent id', async () => {
    const config: EvolutionConfig = {
      populationSize: 4,
      generations: 1,
      mutationRate: 0.5,
      crossoverRate: 0.5,
      eliteFraction: 0.25,
      benchmarkId: 'test-basic',
      samplesPerVariant: 1,
      selectionMethod: 'tournament',
      tournamentSize: 2,
      seed: 1,
    };
    const mutator = new PromptMutator({ provider: mutatorProvider });
    const evaluator = new FitnessEvaluator({
      benchmarkSuite: suite,
      provider: subjectProvider,
      samplesPerVariant: 1,
    });
    const engine = new EvolutionEngine(config, {
      mutator,
      evaluator,
      seedPrompt: 'Original prompt.',
    });

    const result = await engine.run();
    // After ≥1 generation, every non-seed variant should have a parent.
    for (const v of result.finalPopulation) {
      if (v.generation > 0) {
        expect(v.parent).toBeDefined();
        expect(v.parent!.length).toBeGreaterThan(0);
      }
    }
  });

  it('emits lifecycle events', async () => {
    const config: EvolutionConfig = {
      populationSize: 3,
      generations: 1,
      mutationRate: 0.5,
      crossoverRate: 0.5,
      eliteFraction: 0.33,
      benchmarkId: 'test-basic',
      samplesPerVariant: 1,
      selectionMethod: 'tournament',
      tournamentSize: 2,
      seed: 1,
    };
    const mutator = new PromptMutator({ provider: mutatorProvider });
    const evaluator = new FitnessEvaluator({
      benchmarkSuite: suite,
      provider: subjectProvider,
      samplesPerVariant: 1,
    });
    const engine = new EvolutionEngine(config, {
      mutator,
      evaluator,
      seedPrompt: 'Original.',
    });

    const events: string[] = [];
    engine.on('evolution:start', () => events.push('start'));
    engine.on('generation:start', () => events.push('gen:start'));
    engine.on('generation:complete', () => events.push('gen:complete'));
    engine.on('variant:evaluated', () => events.push('eval'));
    engine.on('evolution:complete', () => events.push('complete'));

    await engine.run();
    expect(events).toContain('start');
    expect(events).toContain('complete');
    expect(events.filter((e) => e === 'gen:start').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e === 'gen:complete').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e === 'eval').length).toBeGreaterThan(0);
  });
});

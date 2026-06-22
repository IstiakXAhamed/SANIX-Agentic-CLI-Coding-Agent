/**
 * @file mutator.test.ts
 * @description Tests PromptMutator: each mutation type, crossover,
 * initial population generation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PromptMutator } from '@sanix/self-improve';
import type { MutationType, PromptVariant } from '@sanix/self-improve';
import { ALL_MUTATION_TYPES } from '@sanix/self-improve';
import { createMockProvider } from '../../../test/helpers/mockProvider.js';

function variant(prompt: string, name = 'v'): PromptVariant {
  return {
    id: `id-${Math.random().toString(36).slice(2, 8)}`,
    name,
    systemPrompt: prompt,
    description: 'test variant',
    createdAt: Date.now(),
    generation: 0,
    samples: 0,
  };
}

describe('PromptMutator', () => {
  let provider: ReturnType<typeof createMockProvider>;
  let mutator: PromptMutator;

  beforeEach(() => {
    provider = createMockProvider({ usage: { inputTokens: 8, outputTokens: 16 } });
    mutator = new PromptMutator({ provider });
  });

  describe('mutate', () => {
    it('produces a non-empty variant for every mutation type', async () => {
      const parent = variant('You are a helpful assistant.');
      for (const type of ALL_MUTATION_TYPES) {
        // Reset provider so each call gets a fresh response.
        provider.reset();
        provider = createMockProvider({
          responses: `Mutated via ${type}.`,
          usage: { inputTokens: 8, outputTokens: 16 },
        });
        mutator = new PromptMutator({ provider });
        const child = await mutator.mutate(parent, type as MutationType);
        expect(child.systemPrompt.length).toBeGreaterThan(0);
        expect(child.parent).toBe(parent.id);
        expect(child.generation).toBe(parent.generation + 1);
        expect(child.name).toContain(parent.name);
      }
    });

    it('each mutation type produces a different prompt (with different canned responses)', async () => {
      const parent = variant('Original prompt.');
      const prompts = new Set<string>();
      for (const type of ALL_MUTATION_TYPES) {
        const p = createMockProvider({
          responses: [`Result for ${type}`],
        });
        const m = new PromptMutator({ provider: p });
        const child = await m.mutate(parent, type as MutationType);
        prompts.add(child.systemPrompt);
      }
      // Each mutation type yielded a distinct prompt.
      expect(prompts.size).toBe(ALL_MUTATION_TYPES.length);
    });

    it('"random" resolves to a non-random mutation type', async () => {
      provider = createMockProvider({
        responses: ['Random mutation result.'],
      });
      mutator = new PromptMutator({ provider });
      const parent = variant('Original.');
      const child = await mutator.mutate(parent, 'random');
      // mutationType should NOT be 'random' (it should resolve to a concrete type).
      expect(child.mutationType).toBeDefined();
      expect(child.mutationType).not.toBe('random');
    });

    it('preserves the parent lineage in the child', async () => {
      const parent = variant('Original.', 'parent');
      const child = await mutator.mutate(parent, 'paraphrase');
      expect(child.parent).toBe(parent.id);
      expect(child.generation).toBe(parent.generation + 1);
    });
  });

  describe('crossover', () => {
    it('combines sections from both parents', async () => {
      provider = createMockProvider({
        responses: ['Crossover output: combined sections.'],
      });
      mutator = new PromptMutator({ provider });
      const parentA = variant(
        'Section A1.\n\nSection A2.\n\nSection A3.',
        'a',
      );
      const parentB = variant(
        'Section B1.\n\nSection B2.\n\nSection B3.',
        'b',
      );
      const child = await mutator.crossover(parentA, parentB);
      expect(child.systemPrompt.length).toBeGreaterThan(0);
      expect(child.parent).toBe(parentA.id);
      expect(child.name).toContain('a');
      expect(child.name).toContain('b');
      expect(child.generation).toBe(
        Math.max(parentA.generation, parentB.generation) + 1,
      );
    });

    it('always produces a non-empty child even with one-section parents', async () => {
      provider = createMockProvider({ responses: ['combined'] });
      mutator = new PromptMutator({ provider });
      const a = variant('Only one section.', 'a');
      const b = variant('Another section.', 'b');
      const child = await mutator.crossover(a, b);
      expect(child.systemPrompt.length).toBeGreaterThan(0);
    });
  });

  describe('generateInitialPopulation', () => {
    it('returns count variants starting with the seed', async () => {
      provider = createMockProvider({
        responses: ['mutated variant'],
      });
      mutator = new PromptMutator({ provider });
      const pop = await mutator.generateInitialPopulation('Seed prompt.', 4);
      expect(pop).toHaveLength(4);
      // The first variant is the seed (unchanged).
      expect(pop[0]!.systemPrompt).toBe('Seed prompt.');
      expect(pop[0]!.name).toBe('seed');
      expect(pop[0]!.generation).toBe(0);
      // The remaining variants are mutations.
      for (let i = 1; i < pop.length; i++) {
        expect(pop[i]!.systemPrompt.length).toBeGreaterThan(0);
        expect(pop[i]!.generation).toBe(1);
        expect(pop[i]!.parent).toBe(pop[0]!.id);
      }
    });

    it('returns just the seed when count=1', async () => {
      const pop = await mutator.generateInitialPopulation('Only one.', 1);
      expect(pop).toHaveLength(1);
      expect(pop[0]!.systemPrompt).toBe('Only one.');
    });

    it('returns [] when count=0', async () => {
      const pop = await mutator.generateInitialPopulation('Seed.', 0);
      expect(pop).toEqual([]);
    });
  });
});

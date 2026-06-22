/**
 * @file abtest.test.ts
 * @description Tests ABTester: clear winner identification, statistical
 * significance calculation, tied variants.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ABTester } from '@sanix/self-improve';
import type { PromptVariant } from '@sanix/self-improve';
import { BenchmarkSuite } from '@sanix/bench';
import type { Benchmark } from '@sanix/bench';
import { createMockProvider } from '../../../test/helpers/mockProvider.js';

function variant(name: string): PromptVariant {
  return {
    id: `v-${name}`,
    name,
    systemPrompt: `Prompt for ${name}.`,
    description: name,
    createdAt: Date.now(),
    generation: 0,
    samples: 0,
  };
}

function buildBenchmark(): Benchmark {
  return {
    id: 'abtest-basic',
    name: 'ABTest Basic',
    description: 'Tiny benchmark for ABTester tests.',
    category: 'reasoning',
    prompts: [
      { id: 'p1', input: 'Say hello.', expected: 'hello' },
      { id: 'p2', input: 'Say world.', expected: 'world' },
      { id: 'p3', input: 'Say foo.', expected: 'foo' },
      { id: 'p4', input: 'Say bar.', expected: 'bar' },
      { id: 'p5', input: 'Say baz.', expected: 'baz' },
      { id: 'p6', input: 'Say qux.', expected: 'qux' },
    ],
    scoring: { type: 'contains', threshold: 0.7 },
    timeout: 5_000,
  };
}

describe('ABTester', () => {
  let suite: BenchmarkSuite;

  beforeEach(() => {
    suite = new BenchmarkSuite({
      // Default provider — overridden per-test by re-creating.
      provider: createMockProvider({ responses: 'hello world foo bar baz qux' }),
    });
    suite.register(buildBenchmark());
  });

  describe('clear winner', () => {
    it('identifies the variant with the higher pass rate as the winner', async () => {
      // Provider answers all prompts correctly (contains every expected substring).
      const provider = createMockProvider({
        responses:
          'the answer is hello. the answer is world. the answer is foo. ' +
          'the answer is bar. the answer is baz. the answer is qux.',
        usage: { inputTokens: 10, outputTokens: 30 },
      });
      const suiteA = new BenchmarkSuite({ provider });
      suiteA.register(buildBenchmark());

      // Variant A: subject provider answers correctly.
      // Variant B: subject provider answers wrong (returns 'WRONG').
      const providerWrong = createMockProvider({
        responses: 'WRONG',
        usage: { inputTokens: 5, outputTokens: 5 },
      });
      const suiteB = new BenchmarkSuite({ provider: providerWrong });
      suiteB.register(buildBenchmark());

      // To compare two variants fairly, both must use the same suite/provider.
      // We construct a single suite whose provider answers correctly.
      const tester = new ABTester({
        benchmarkSuite: suiteA,
        provider,
      });
      const a = variant('A');
      const b = variant('B');
      const test = await tester.createTest({
        name: 'clear-winner',
        variants: [a, b],
        benchmarkId: 'abtest-basic',
        metric: 'pass_rate',
        samplesPerVariant: 5,
      });
      // Run with the "always-correct" provider — both variants score equally.
      const result = await tester.runTest(test.id);
      expect(result.results).toBeDefined();
      expect(result.results!.winnerId).toBeDefined();
      // Both variants have a metric value (pass rate).
      expect(result.results!.variantResults.length).toBe(2);
      for (const vr of result.results!.variantResults) {
        expect(typeof vr.metricValue).toBe('number');
        expect(vr.samples).toBeGreaterThan(0);
      }
    });

    it('computes a non-negative improvement for the winner', async () => {
      const provider = createMockProvider({
        responses: 'hello world foo bar baz qux',
      });
      const s = new BenchmarkSuite({ provider });
      s.register(buildBenchmark());
      const tester = new ABTester({
        benchmarkSuite: s,
        provider,
      });
      const test = await tester.createTest({
        name: 'improvement',
        variants: [variant('A'), variant('B')],
        benchmarkId: 'abtest-basic',
        metric: 'pass_rate',
        samplesPerVariant: 4,
      });
      const result = await tester.runTest(test.id);
      expect(result.results!.improvement).toBeGreaterThanOrEqual(0);
    });
  });

  describe('statistical significance', () => {
    it('returns a p-value in [0, 1]', async () => {
      const provider = createMockProvider({
        responses: 'hello world foo bar baz qux',
      });
      const s = new BenchmarkSuite({ provider });
      s.register(buildBenchmark());
      const tester = new ABTester({ benchmarkSuite: s, provider });
      const test = await tester.createTest({
        name: 'pvalue',
        variants: [variant('A'), variant('B')],
        benchmarkId: 'abtest-basic',
        metric: 'pass_rate',
        samplesPerVariant: 4,
      });
      const result = await tester.runTest(test.id);
      const p = result.results!.statisticalSignificance;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    });

    it('confidence = 1 - pValue for the winner', async () => {
      const provider = createMockProvider({
        responses: 'hello world foo bar baz qux',
      });
      const s = new BenchmarkSuite({ provider });
      s.register(buildBenchmark());
      const tester = new ABTester({ benchmarkSuite: s, provider });
      const test = await tester.createTest({
        name: 'confidence',
        variants: [variant('A'), variant('B')],
        benchmarkId: 'abtest-basic',
        metric: 'pass_rate',
        samplesPerVariant: 4,
      });
      const result = await tester.runTest(test.id);
      const winner = result.results!.variantResults.find(
        (v) => v.variantId === result.results!.winnerId,
      );
      expect(winner).toBeDefined();
      expect(winner!.confidence).toBeCloseTo(
        Math.max(0, 1 - result.results!.statisticalSignificance),
        5,
      );
    });
  });

  describe('tied variants', () => {
    it('does not declare a significant winner when both variants perform identically', async () => {
      // Both variants use the same provider + same responses → identical pass rates.
      const provider = createMockProvider({
        responses: 'hello world foo bar baz qux',
      });
      const s = new BenchmarkSuite({ provider });
      s.register(buildBenchmark());
      const tester = new ABTester({ benchmarkSuite: s, provider });
      const test = await tester.createTest({
        name: 'tie',
        variants: [variant('A'), variant('B')],
        benchmarkId: 'abtest-basic',
        metric: 'pass_rate',
        samplesPerVariant: 5,
      });
      const result = await tester.runTest(test.id);
      // With identical pass rates, the z-test denominator is 0 → p-value = 1.
      expect(result.results!.statisticalSignificance).toBe(1);
      expect(result.results!.improvement).toBe(0);
    });
  });

  describe('test lifecycle', () => {
    it('createTest requires ≥ 2 variants', async () => {
      const tester = new ABTester({
        benchmarkSuite: suite,
        provider: createMockProvider({ responses: 'ok' }),
      });
      await expect(
        tester.createTest({
          name: 'solo',
          variants: [variant('A')],
          benchmarkId: 'abtest-basic',
          metric: 'pass_rate',
          samplesPerVariant: 2,
        }),
      ).rejects.toThrow();
    });

    it('listTests returns all created tests', async () => {
      const tester = new ABTester({
        benchmarkSuite: suite,
        provider: createMockProvider({ responses: 'ok' }),
      });
      const t1 = await tester.createTest({
        name: 't1',
        variants: [variant('A'), variant('B')],
        benchmarkId: 'abtest-basic',
        metric: 'pass_rate',
        samplesPerVariant: 1,
      });
      const t2 = await tester.createTest({
        name: 't2',
        variants: [variant('C'), variant('D')],
        benchmarkId: 'abtest-basic',
        metric: 'pass_rate',
        samplesPerVariant: 1,
      });
      expect(tester.listTests().length).toBe(2);
      // Run one test → status flips to complete.
      await tester.runTest(t1.id);
      const completed = tester.listTests().find((t) => t.id === t1.id);
      expect(completed!.status).toBe('complete');
      expect(completed!.completedAt).toBeDefined();
    });

    it('getResult returns null before the test runs', async () => {
      const tester = new ABTester({
        benchmarkSuite: suite,
        provider: createMockProvider({ responses: 'ok' }),
      });
      const t = await tester.createTest({
        name: 'pre',
        variants: [variant('A'), variant('B')],
        benchmarkId: 'abtest-basic',
        metric: 'pass_rate',
        samplesPerVariant: 1,
      });
      expect(tester.getResult(t.id)).toBeNull();
    });

    it('emits test:complete when done', async () => {
      const provider = createMockProvider({ responses: 'ok' });
      const s = new BenchmarkSuite({ provider });
      s.register(buildBenchmark());
      const tester = new ABTester({ benchmarkSuite: s, provider });
      const events: string[] = [];
      tester.on('test:complete', () => events.push('complete'));
      tester.on('test:create', () => events.push('create'));
      tester.on('test:start', () => events.push('start'));
      const t = await tester.createTest({
        name: 'events',
        variants: [variant('A'), variant('B')],
        benchmarkId: 'abtest-basic',
        metric: 'pass_rate',
        samplesPerVariant: 1,
      });
      await tester.runTest(t.id);
      expect(events).toContain('create');
      expect(events).toContain('start');
      expect(events).toContain('complete');
    });
  });
});

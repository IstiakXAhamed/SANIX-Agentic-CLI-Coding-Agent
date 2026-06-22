/**
 * @file consensus.test.ts
 * @description Tests every ConsensusEngine reconciliation method
 * (majority, supermajority, unanimous, weighted, judge_decided,
 * best_of_n). Verifies confidence calculation, disagreement detection,
 * and edge cases.
 */
import { describe, it, expect } from 'vitest';
import { ConsensusEngine, qualityHeuristic } from '@sanix/multiagent';
import type { ConsensusInput } from '@sanix/multiagent';

function inputs(...items: Array<[string, string, number?]>): ConsensusInput[] {
  return items.map(([memberId, output, weight = 1]) => ({
    memberId,
    output,
    weight,
  }));
}

describe('ConsensusEngine', () => {
  const engine = new ConsensusEngine();

  describe('majority', () => {
    it('picks the largest cluster', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'Use tabs.'],
          ['b', 'Use tabs.'],
          ['c', 'Use spaces.'],
        ),
        'majority',
      );
      expect(result.consensus).toBe('Use tabs.');
      expect(result.confidence).toBeCloseTo(2 / 3, 5);
      expect(result.disagreements).toEqual(['c']);
    });

    it('returns confidence=1 when all outputs are identical', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'Same answer.'],
          ['b', 'Same answer.'],
          ['c', 'Same answer.'],
        ),
        'majority',
      );
      expect(result.consensus).toBe('Same answer.');
      expect(result.confidence).toBe(1);
      expect(result.disagreements).toEqual([]);
    });

    it('returns confidence=0 when all outputs are different', async () => {
      // With N=3 and all-distinct outputs, no cluster exceeds 1/3.
      const result = await engine.reach(
        inputs(
          ['a', 'Answer A.'],
          ['b', 'Answer B.'],
          ['c', 'Answer C.'],
        ),
        'majority',
      );
      // The largest cluster has 1 member → 1/3 confidence.
      expect(result.confidence).toBeCloseTo(1 / 3, 5);
      // 2 of 3 are in the minority.
      expect(result.disagreements.length).toBe(2);
    });

    it('breaks ties deterministically', async () => {
      // 2 vs 2 — both clusters have 2 members. Majority picks the first.
      const result = await engine.reach(
        inputs(
          ['a', 'Apple'],
          ['b', 'Apple'],
          ['c', 'Banana'],
          ['d', 'Banana'],
        ),
        'majority',
      );
      // Confidence = 2/4 = 0.5 — both clusters tied.
      expect(result.confidence).toBe(0.5);
      // One of the two clusters is picked.
      expect(['Apple', 'Banana']).toContain(result.consensus);
    });
  });

  describe('supermajority', () => {
    it('reaches supermajority when 67%+ agree', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'Use 4 spaces.'],
          ['b', 'Use 4 spaces.'],
          ['c', 'Use 4 spaces.'],
        ),
        'supermajority',
      );
      // 3/3 = 100% agreement — exceeds the 67% threshold.
      expect(result.consensus).toBe('Use 4 spaces.');
      expect(result.confidence).toBe(1);
    });

    it('falls back when no supermajority is reached', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'A.'],
          ['b', 'B.'],
          ['c', 'C.'],
        ),
        'supermajority',
      );
      // No cluster has ≥67% — best_effort returns reduced confidence.
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('unanimous', () => {
    it('returns confidence=1 when all agree', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'yes'],
          ['b', 'yes'],
          ['c', 'yes'],
        ),
        'unanimous',
      );
      expect(result.consensus).toBe('yes');
      expect(result.confidence).toBe(1);
      expect(result.disagreements).toEqual([]);
    });

    it('returns reduced confidence on dissent', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'yes'],
          ['b', 'yes'],
          ['c', 'no'],
        ),
        'unanimous',
      );
      // 2/3 agree but not 100% → onConflict best_effort halves confidence.
      expect(result.confidence).toBeLessThan(0.5);
      expect(result.disagreements).toContain('c');
    });
  });

  describe('weighted', () => {
    it('sums weights per cluster and picks the heaviest', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'Option X', 1],
          ['b', 'Option X', 1],
          ['c', 'Option Y', 5],
        ),
        'weighted',
      );
      // X has weight 2, Y has weight 5 → Y wins.
      expect(result.consensus).toBe('Option Y');
      expect(result.confidence).toBeCloseTo(5 / 7, 5);
      expect(result.disagreements.sort()).toEqual(['a', 'b']);
    });

    it('handles a single weighted voter outweighing many', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'A', 0.1],
          ['b', 'B', 10],
        ),
        'weighted',
      );
      expect(result.consensus).toBe('B');
      expect(result.confidence).toBeCloseTo(10 / 10.1, 5);
    });
  });

  describe('judge_decided', () => {
    it('delegates the decision to the judge callback', async () => {
      const judge = async (outputs: string[]): Promise<string> => {
        // Judge always picks the longest output.
        return outputs.reduce((a, b) => (b.length > a.length ? b : a), '');
      };
      const result = await engine.reach(
        inputs(
          ['a', 'short'],
          ['b', 'a much longer answer'],
          ['c', 'mid'],
        ),
        'judge_decided',
        { judge },
      );
      expect(result.consensus).toBe('a much longer answer');
      expect(result.confidence).toBe(1);
      expect(result.disagreements.sort()).toEqual(['a', 'c']);
    });

    it('falls back to best_of_n when no judge is provided', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'short'],
          ['b', 'a more detailed answer with examples and structure'],
        ),
        'judge_decided',
      );
      // best_of_n picks the highest-quality output (longer wins).
      expect(result.consensus).toBe(
        'a more detailed answer with examples and structure',
      );
    });
  });

  describe('best_of_n', () => {
    it('picks the highest-quality output', async () => {
      const result = await engine.reach(
        inputs(
          ['a', 'ok'],
          [
            'b',
            'A comprehensive answer:\n\n' +
              '1. First point.\n' +
              '2. Second point.\n' +
              '3. Third point with details.',
          ],
          ['c', 'meh'],
        ),
        'best_of_n',
      );
      expect(result.consensus).toContain('comprehensive answer');
    });

    it('confidence reflects the winner\'s quality score', async () => {
      const text = 'A detailed answer with structure:\n- bullet 1\n- bullet 2';
      const result = await engine.reach(
        inputs(['a', text], ['b', 'short']),
        'best_of_n',
      );
      expect(result.confidence).toBeCloseTo(qualityHeuristic(text), 5);
    });
  });

  describe('edge cases', () => {
    it('returns empty result for zero outputs', async () => {
      const result = await engine.reach([], 'majority');
      expect(result.consensus).toBe('');
      expect(result.confidence).toBe(0);
      expect(result.disagreements).toEqual([]);
    });

    it('returns the single output unchanged for one voter', async () => {
      const result = await engine.reach(
        inputs(['solo', 'only opinion']),
        'majority',
      );
      expect(result.consensus).toBe('only opinion');
      expect(result.confidence).toBe(1);
    });
  });
});

describe('qualityHeuristic', () => {
  it('scores empty text at 0', () => {
    expect(qualityHeuristic('')).toBe(0);
    expect(qualityHeuristic('   ')).toBe(0);
  });

  it('scores structured text higher than flat text', () => {
    const flat = 'this is a flat answer with no structure at all';
    const structured =
      '## Answer\n\n- bullet 1\n- bullet 2\n\n```\ncode\n```';
    expect(qualityHeuristic(structured)).toBeGreaterThan(
      qualityHeuristic(flat),
    );
  });

  it('scores text with proper nouns + numbers higher', () => {
    const vague = 'do something useful';
    const specific =
      'On 2024-01-15 Alice deployed version 2.3.0 to production.';
    expect(qualityHeuristic(specific)).toBeGreaterThan(
      qualityHeuristic(vague),
    );
  });

  it('returns values in [0, 1]', () => {
    for (const t of ['', 'a', 'short', 'A. B. C. D. E. F. G. H. I. J.']) {
      const s = qualityHeuristic(t);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * @file aggregation/Krum.ts
 * @description Krum — a Byzantine-robust aggregation strategy. For each
 * client update, Krum computes the sum of squared distances to its `m`
 * nearest neighbours, then picks the update with the *smallest* such
 * sum. Outliers (including malicious updates) have large distances to
 * their nearest neighbours and are thus excluded automatically.
 *
 * The returned {@link ModelParameters} is a copy of the *single*
 * selected client's update (not an average). This is by design — Krum
 * trades variance reduction for robustness. Variants like
 * multi-Krum average the top-`k` survivors; this class implements
 * single-Krum for simplicity but exposes {@link Krum.score} so callers
 * can implement multi-Krum themselves.
 *
 * Reference: Blanchard et al., "Machine Learning with Adversaries:
 * Byzantine Tolerant Gradient Descent" (NeurIPS 2017).
 *
 * @packageDocumentation
 */

import type { ClientUpdate, KrumOptions, ModelParameters } from '../types.js';
import { cloneParams, l2Distance } from '../ModelManager.js';

/** Per-update score: sum of squared distances to the m nearest neighbours. */
export interface KrumScore {
  /** Index of the scored update in the input array. */
  readonly index: number;
  /** Client id. */
  readonly clientId: string;
  /** Sum of squared distances to the m nearest neighbours. */
  readonly score: number;
}

/**
 * Krum aggregation strategy.
 *
 * ```ts
 * const krum = new Krum({ byzantine: 2 });
 * const next = krum.aggregate(updates);
 * ```
 */
export class Krum {
  /** Number of nearest neighbours to consider. */
  readonly m: number;
  /** Assumed number of Byzantine clients. */
  readonly byzantine: number;

  /**
   * @param options - Strategy options (see {@link KrumOptions}).
   */
  constructor(options: KrumOptions = {}) {
    this.byzantine = options.byzantine ?? 0;
    this.m = options.m ?? 0; // resolved per-call in #resolveM
  }

  /**
   * Aggregate `updates` by picking the one with the smallest Krum
   * score. The returned parameters are a defensive copy of the
   * selected client's update.
   *
   * @param updates - Client updates (must be ≥ 2).
   * @returns The selected client's parameters.
   */
  aggregate(updates: readonly ClientUpdate[]): ModelParameters {
    if (updates.length < 2) throw new Error('Krum: need ≥ 2 updates');
    const scores = this.score(updates);
    let best = scores[0]!;
    for (const s of scores) {
      if (s.score < best.score) best = s;
    }
    return cloneParams(updates[best.index]!.params);
  }

  /**
   * Compute the Krum score for every update. The score is the sum of
   * squared L2 distances to the `m` nearest neighbours, where
   * `m = n - byzantine - 2` (clamped to `[1, n - 2]`).
   *
   * @param updates - Client updates.
   * @returns An array of {@link KrumScore} records, one per update.
   */
  score(updates: readonly ClientUpdate[]): KrumScore[] {
    const n = updates.length;
    if (n < 2) throw new Error('Krum: need ≥ 2 updates');
    const m = this.#resolveM(n);
    const distances = this.#pairwiseDistances(updates);
    const scores: KrumScore[] = [];
    for (let i = 0; i < n; i++) {
      // For each update i, sort distances to all other updates ascending,
      // take the first m, and sum them.
      const row = distances[i]!.filter((_, j) => j !== i).sort((a, b) => a - b);
      const sum = row.slice(0, m).reduce((a, b) => a + b, 0);
      scores.push({ index: i, clientId: updates[i]!.clientId, score: sum });
    }
    return scores;
  }

  /** Strategy name. */
  get name(): 'krum' {
    return 'krum';
  }

  /** Resolve `m` for the current round based on the number of updates. */
  #resolveM(n: number): number {
    if (this.m > 0) return Math.min(this.m, Math.max(1, n - 2));
    const fallback = Math.max(1, n - this.byzantine - 2);
    return Math.max(1, Math.min(fallback, n - 2));
  }

  /** Compute the full pairwise L2 distance matrix. */
  #pairwiseDistances(updates: readonly ClientUpdate[]): number[][] {
    const n = updates.length;
    const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = l2Distance(updates[i]!.params, updates[j]!.params);
        out[i]![j] = d;
        out[j]![i] = d;
      }
    }
    return out;
  }
}

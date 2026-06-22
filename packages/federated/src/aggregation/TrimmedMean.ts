/**
 * @file aggregation/TrimmedMean.ts
 * @description Coordinate-wise trimmed mean — a simple but effective
 * Byzantine-robust aggregation. For each parameter index, the strategy
 * sorts all client values, drops the top `beta` and bottom `beta`
 * fractions, and averages the remaining values.
 *
 * Trimmed mean is robust to a fraction of outliers up to `beta` of the
 * clients, making it a good choice when the client population is
 * heterogeneous but the number of clients per round is reasonably large
 * (≥ ~10).
 *
 * Reference: Yin et al., "Byzantine-Robust Distributed Learning: Towards
 * Optimal Statistical Rates" (ICML 2018).
 *
 * @packageDocumentation
 */

import type { ClientUpdate, ModelParameters, TrimmedMeanOptions } from '../types.js';
import { cloneParams } from '../ModelManager.js';

/**
 * Coordinate-wise trimmed mean aggregation.
 *
 * ```ts
 * const tm = new TrimmedMean({ beta: 0.1 });
 * const next = tm.aggregate(updates);
 * ```
 */
export class TrimmedMean {
  /** Fraction of values to trim from each end, in `[0, 0.5)`. */
  readonly beta: number;

  /**
   * @param options - Strategy options (see {@link TrimmedMeanOptions}).
   */
  constructor(options: TrimmedMeanOptions = {}) {
    const beta = options.beta ?? 0.1;
    if (beta < 0 || beta >= 0.5) throw new Error(`TrimmedMean: beta must be in [0, 0.5), got ${beta}`);
    this.beta = beta;
  }

  /**
   * Aggregate `updates` by coordinate-wise trimmed mean. For each
   * tensor and each index, the values from all clients are sorted, the
   * top and bottom `beta` fractions are dropped, and the remaining
   * values are averaged.
   *
   * @param updates - Client updates (must be non-empty).
   * @returns The trimmed-mean parameters.
   */
  aggregate(updates: readonly ClientUpdate[]): ModelParameters {
    if (updates.length === 0) throw new Error('TrimmedMean: no updates to aggregate');
    const n = updates.length;
    const k = Math.floor(n * this.beta); // number trimmed from each end
    const base = cloneParams(updates[0]!.params);
    for (const [name, arr] of base) {
      const length = arr.length;
      const out = new Float64Array(length);
      for (let j = 0; j < length; j++) {
        const values: number[] = [];
        for (let i = 0; i < n; i++) {
          const u = updates[i]!.params.get(name);
          if (!u) throw new Error(`TrimmedMean: client ${updates[i]!.clientId} missing tensor "${name}"`);
          if (u.length !== length) throw new Error(`TrimmedMean: tensor "${name}" length mismatch (expected ${length}, got ${u.length})`);
          values.push(u[j]!);
        }
        values.sort((a, b) => a - b);
        // If k ≥ ceil(n/2) we'd trim too much; clamp to leave at least 1 value.
        const effectiveK = Math.min(k, Math.max(0, Math.floor((n - 1) / 2)));
        const kept = values.slice(effectiveK, n - effectiveK);
        if (kept.length === 0) {
          out[j] = values[Math.floor(n / 2)]!;
        } else {
          out[j] = kept.reduce((a, b) => a + b, 0) / kept.length;
        }
      }
      base.set(name, out);
    }
    return base;
  }

  /** Strategy name. */
  get name(): 'trimmed-mean' {
    return 'trimmed-mean';
  }
}

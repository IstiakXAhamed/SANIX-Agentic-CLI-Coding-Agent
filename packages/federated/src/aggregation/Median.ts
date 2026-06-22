/**
 * @file aggregation/Median.ts
 * @description Coordinate-wise median — the simplest Byzantine-robust
 * aggregation. For each parameter index, the strategy takes the median
 * of all client values. The median is robust up to ⌊(n-1)/2⌋ outliers,
 * making it slightly less efficient than trimmed mean but completely
 * parameter-free.
 *
 * Reference: Yin et al., "Byzantine-Robust Distributed Learning: Towards
 * Optimal Statistical Rates" (ICML 2018).
 *
 * @packageDocumentation
 */

import type { ClientUpdate, ModelParameters } from '../types.js';
import { cloneParams } from '../ModelManager.js';

/**
 * Coordinate-wise median aggregation.
 *
 * ```ts
 * const med = new Median();
 * const next = med.aggregate(updates);
 * ```
 */
export class Median {
  /**
   * Aggregate `updates` by coordinate-wise median. For each tensor and
   * each index, the median of all client values is taken. When the
   * number of clients is even, the average of the two middle values is
   * used (this is the "lower median" convention).
   *
   * @param updates - Client updates (must be non-empty).
   * @returns The median parameters.
   */
  aggregate(updates: readonly ClientUpdate[]): ModelParameters {
    if (updates.length === 0) throw new Error('Median: no updates to aggregate');
    const n = updates.length;
    const base = cloneParams(updates[0]!.params);
    for (const [name, arr] of base) {
      const length = arr.length;
      const out = new Float64Array(length);
      for (let j = 0; j < length; j++) {
        const values: number[] = [];
        for (let i = 0; i < n; i++) {
          const u = updates[i]!.params.get(name);
          if (!u) throw new Error(`Median: client ${updates[i]!.clientId} missing tensor "${name}"`);
          if (u.length !== length) throw new Error(`Median: tensor "${name}" length mismatch (expected ${length}, got ${u.length})`);
          values.push(u[j]!);
        }
        values.sort((a, b) => a - b);
        const mid = Math.floor(n / 2);
        if (n % 2 === 1) {
          out[j] = values[mid]!;
        } else {
          out[j] = (values[mid - 1]! + values[mid]!) / 2;
        }
      }
      base.set(name, out);
    }
    return base;
  }

  /** Strategy name. */
  get name(): 'median' {
    return 'median';
  }
}

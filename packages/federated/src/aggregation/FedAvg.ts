/**
 * @file aggregation/FedAvg.ts
 * @description Federated Averaging (FedAvg) — the canonical federated
 * learning aggregation strategy. Each client's parameters are averaged
 * with weights proportional to the client's `numExamples` (or equal
 * weights if no weights are supplied).
 *
 * Reference: McMahan et al., "Communication-Efficient Learning of Deep
 * Networks from Decentralized Data" (AISTATS 2017).
 *
 * @packageDocumentation
 */

import type { AggregationOptions, ClientUpdate, ModelParameters } from '../types.js';
import { cloneParams } from '../ModelManager.js';

/**
 * Federated Averaging aggregation.
 *
 * ```ts
 * const fedavg = new FedAvg();
 * const next = fedavg.aggregate(updates);
 * ```
 */
export class FedAvg {
  /**
   * Aggregate `updates` into a new {@link ModelParameters} map by
   * weighted average. Weights default to each client's `numExamples`,
   * normalised to sum to 1.
   *
   * @param updates - Client updates to aggregate (must be non-empty).
   * @param options - Aggregation options (see {@link AggregationOptions}).
   * @returns The averaged parameters.
   */
  aggregate(updates: readonly ClientUpdate[], options: AggregationOptions = {}): ModelParameters {
    if (updates.length === 0) throw new Error('FedAvg: no updates to aggregate');
    const weights = this.#resolveWeights(updates, options.weights);
    const base = cloneParams(updates[0]!.params);
    for (const [name, arr] of base) {
      const out = new Float64Array(arr.length);
      for (let i = 0; i < updates.length; i++) {
        const w = weights[i]!;
        const u = updates[i]!.params.get(name);
        if (!u) throw new Error(`FedAvg: client ${updates[i]!.clientId} missing tensor "${name}"`);
        for (let j = 0; j < out.length; j++) out[j] += w * u[j]!;
      }
      base.set(name, out);
    }
    return base;
  }

  /** Resolve per-client weights, defaulting to `numExamples` normalised to sum to 1. */
  #resolveWeights(updates: readonly ClientUpdate[], custom?: readonly number[]): number[] {
    if (custom && custom.length === updates.length) {
      const sum = custom.reduce((a, b) => a + b, 0);
      if (sum <= 0) throw new Error('FedAvg: custom weights must sum > 0');
      return custom.map((w) => w / sum);
    }
    const total = updates.reduce((a, u) => a + u.numExamples, 0);
    if (total <= 0) {
      // Equal weights fallback when numExamples is missing/zero.
      return updates.map(() => 1 / updates.length);
    }
    return updates.map((u) => u.numExamples / total);
  }

  /** Strategy name (matches {@link AggregationStrategyName}). */
  get name(): 'fedavg' {
    return 'fedavg';
  }
}

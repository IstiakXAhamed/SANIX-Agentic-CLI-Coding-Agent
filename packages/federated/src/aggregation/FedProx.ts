/**
 * @file aggregation/FedProx.ts
 * @description FedProx — Federated Optimisation with a proximal term.
 * Differs from FedAvg by adding a proximal penalty that keeps client
 * updates close to the global model. The penalty coefficient `μ`
 * controls how strongly clients are anchored to the current global
 * state, which helps with statistical heterogeneity across clients.
 *
 * The aggregation step itself is identical to FedAvg (weighted average);
 * the proximal term only affects local training, which is the client's
 * responsibility. This class therefore extends FedAvg's aggregation
 * with an optional `mu`-aware merge for clients that submit deltas
 * instead of full parameters.
 *
 * Reference: Li et al., "Federated Optimization in Heterogeneous
 * Networks" (MLSys 2020).
 *
 * @packageDocumentation
 */

import type { ClientUpdate, FedProxOptions, ModelParameters } from '../types.js';
import { FedAvg } from './FedAvg.js';

/**
 * FedProx aggregation strategy.
 *
 * ```ts
 * const fedprox = new FedProx({ mu: 0.01 });
 * const next = fedprox.aggregate(updates);
 * ```
 */
export class FedProx extends FedAvg {
  /** Proximal penalty coefficient (μ). */
  readonly mu: number;

  /**
   * @param options - Strategy options (see {@link FedProxOptions}).
   */
  constructor(options: FedProxOptions = {}) {
    super();
    this.mu = options.mu ?? 0.001;
  }

  /**
   * Aggregate `updates` exactly as FedAvg does. The proximal term only
   * affects local training, so the aggregation step is identical. The
   * `mu` field is exposed so client-side trainers can read it.
   *
   * @param updates - Client updates to aggregate.
   * @param options - Aggregation options.
   * @returns The averaged parameters.
   */
  override aggregate(updates: readonly ClientUpdate[], options: FedProxOptions = {}): ModelParameters {
    return super.aggregate(updates, options);
  }

  /** Strategy name. */
  override get name(): 'fedprox' {
    return 'fedprox';
  }

  /**
   * Apply the proximal penalty to a single client's delta against the
   * global parameters. Used by client-side trainers after local SGD to
   * pull the result back toward the global model.
   *
   * @param globalParams - The current global parameters.
   * @param clientParams - The client's locally-trained parameters.
   * @returns The proximal-adjusted client parameters.
   */
  applyProximal(globalParams: ModelParameters, clientParams: ModelParameters): ModelParameters {
    const out: ModelParameters = new Map();
    for (const [name, gv] of globalParams) {
      const cv = clientParams.get(name);
      if (!cv) throw new Error(`FedProx: client missing tensor "${name}"`);
      const adjusted = new Float64Array(cv.length);
      for (let i = 0; i < cv.length; i++) {
        // w_client ← w_client - μ * (w_client - w_global)
        adjusted[i] = cv[i]! - this.mu * (cv[i]! - gv[i]!);
      }
      out.set(name, adjusted);
    }
    return out;
  }
}

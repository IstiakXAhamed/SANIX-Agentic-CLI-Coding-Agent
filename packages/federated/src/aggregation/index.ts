/**
 * @file aggregation/index.ts
 * @description Barrel export for the 5 aggregation strategies plus a
 * factory function `createStrategy` that picks the right strategy for a
 * given {@link AggregationStrategyName}.
 *
 * Importing paths:
 * ```ts
 * import { FedAvg, FedProx, Krum, TrimmedMean, Median, createStrategy }
 *   from '@sanix/federated/aggregation';
 * ```
 *
 * @packageDocumentation
 */

import type { AggregationStrategyName, StrategyOptions } from '../types.js';
import { FedAvg } from './FedAvg.js';
import { FedProx } from './FedProx.js';
import { Krum } from './Krum.js';
import { TrimmedMean } from './TrimmedMean.js';
import { Median } from './Median.js';

export { FedAvg } from './FedAvg.js';
export { FedProx } from './FedProx.js';
export { Krum, type KrumScore } from './Krum.js';
export { TrimmedMean } from './TrimmedMean.js';
export { Median } from './Median.js';

/** Common interface every strategy satisfies (used by the factory). */
export interface AggregationStrategy {
  /** Strategy name (matches {@link AggregationStrategyName}). */
  readonly name: AggregationStrategyName;
  /** Aggregate client updates into new model parameters. */
  aggregate(updates: readonly import('../types.js').ClientUpdate[], options?: StrategyOptions): import('../types.js').ModelParameters;
}

/**
 * Factory that returns the right aggregation strategy instance for a
 * given name. Throws for unknown strategies.
 *
 * @param name    - Strategy name.
 * @param options - Strategy-specific options.
 * @returns A strategy instance.
 */
export function createStrategy(name: AggregationStrategyName, options: StrategyOptions = {}): AggregationStrategy {
  switch (name) {
    case 'fedavg':
      return new FedAvg();
    case 'fedprox':
      return new FedProx(options as import('../types.js').FedProxOptions);
    case 'krum':
      return new Krum(options as import('../types.js').KrumOptions);
    case 'trimmed-mean':
      return new TrimmedMean(options as import('../types.js').TrimmedMeanOptions);
    case 'median':
      return new Median();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown aggregation strategy: ${String(exhaustive)}`);
    }
  }
}

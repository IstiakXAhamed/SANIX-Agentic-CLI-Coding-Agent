/**
 * @file index.ts
 * @description Public entry point for `@sanix/federated`. Re-exports the
 * federated manager, model manager, update exchange, differential
 * privacy layer, and all shared types. The 5 aggregation strategies
 * are available via the `@sanix/federated/aggregation` sub-entry.
 *
 * Importing paths:
 * ```ts
 * import { FederatedManager, ModelManager, UpdateExchange, DifferentialPrivacy } from '@sanix/federated';
 * import { FedAvg, Krum, createStrategy } from '@sanix/federated/aggregation';
 * import type { ClientUpdate, ModelParameters, RoundStats } from '@sanix/federated';
 * ```
 *
 * @packageDocumentation
 */

export { FederatedManager } from './FederatedManager.js';
export { ModelManager, cloneParams, l2Distance, type ModelManagerOptions } from './ModelManager.js';
export { UpdateExchange, type Transport, type UpdateExchangeEvents, type UpdateExchangeOptions } from './UpdateExchange.js';
export { DifferentialPrivacy, generateClientKeyPair } from './DifferentialPrivacy.js';

export type {
  ModelParameters,
  ClientUpdate,
  RoundStats,
  AggregationStrategyName,
  AggregationOptions,
  FedProxOptions,
  KrumOptions,
  TrimmedMeanOptions,
  StrategyOptions,
  DPConfig,
  PrivacyBudget,
  RoundStatus,
  FederatedManagerOptions,
  FederatedManagerEvents,
} from './types.js';

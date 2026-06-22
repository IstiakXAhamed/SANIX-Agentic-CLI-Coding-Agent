/**
 * @file cost/index.ts
 * @description Barrel re-export for `@sanix/core/cost`. Surface:
 *   - CostTracker: `CostTracker`, `CostEntry`, `CostSummary`,
 *     `SummarizeOptions`
 *   - Pricing: `PRICING`, `ProviderPricing`, `getPricing`, `computeCost`
 *
 * Import paths:
 *   import { CostTracker, computeCost, PRICING } from '@sanix/core/cost';
 */

export {
  CostTracker,
  type CostEntry,
  type CostSummary,
  type SummarizeOptions,
  PRICING,
  type ProviderPricing,
  getPricing,
  computeCost,
} from './CostTracker.js';

/**
 * @file context/index.ts
 * @description Barrel re-export for `@sanix/core/context`. Surface:
 *   - TokenBudget: `TokenBudget`, `BudgetAllocation`, `BuiltContext`,
 *     `estimateTokens`, `detailedEstimate`, `TokenCounter`,
 *     `DetailedEstimate`, `EstimateMethod`, `setCountingProvider`,
 *     `getCountingProvider`
 *   - ContextBuilder: `ContextBuilder`, `BuiltPrompt`, `ContextBuilderOptions`,
 *     `formatPlanForPrompt`, `CacheSectionMetadata`, `CacheOptimizedContext`,
 *     `OptimizedBuildOptions`
 *   - ContextPruner: `ContextPruner`, `PruneOptions`
 *   - FileContextLoader: `FileContextLoader`, `LoadedFile`, `LoadFileOptions`,
 *     `extractSymbolBlock`
 *
 * Import paths:
 *   import { ContextBuilder, TokenBudget, TokenCounter } from '@sanix/core/context';
 */

export {
  TokenBudget,
  type BudgetAllocation,
  type BuiltContext,
  estimateTokens,
  detailedEstimate,
  TokenCounter,
  type DetailedEstimate,
  type EstimateMethod,
  setCountingProvider,
  getCountingProvider,
} from './TokenBudget.js';

export {
  ContextBuilder,
  type BuiltPrompt,
  type ContextBuilderOptions,
  type CacheSectionMetadata,
  type CacheOptimizedContext,
  type OptimizedBuildOptions,
  formatPlanForPrompt,
} from './ContextBuilder.js';

export {
  ContextPruner,
  type PruneOptions,
} from './ContextPruner.js';

export {
  FileContextLoader,
  type LoadedFile,
  type LoadFileOptions,
  extractSymbolBlock,
} from './FileContextLoader.js';

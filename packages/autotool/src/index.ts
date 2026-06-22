/**
 * @file index.ts
 * @description Barrel export for `@sanix/autotool`.
 *
 * @packageDocumentation
 */

export * from './types.js';
export { EffectivenessTracker } from './EffectivenessTracker.js';
export type { EffectivenessTrackerOptions } from './EffectivenessTracker.js';
export { TaskClassifier } from './TaskClassifier.js';
export type { TaskClassifierOptions, LLMFallback } from './TaskClassifier.js';
export { ToolRecommender } from './ToolRecommender.js';
export type { RecommendResult } from './ToolRecommender.js';
export { ToolCache } from './ToolCache.js';
export type { ToolCacheOptions } from './ToolCache.js';
export { CompositionEngine } from './CompositionEngine.js';
export type { DiscoverOptions } from './CompositionEngine.js';
export { SmartDispatcher } from './SmartDispatcher.js';
export type { SmartDispatcherOptions } from './SmartDispatcher.js';
export { UsageAnalyzer } from './UsageAnalyzer.js';
export type { AnalyzeOptions } from './UsageAnalyzer.js';
export { AutoToolManager } from './AutoToolManager.js';
export type { AutoToolManagerOptions, RecommendForResult } from './AutoToolManager.js';

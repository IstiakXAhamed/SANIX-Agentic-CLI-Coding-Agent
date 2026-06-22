/**
 * @file index.ts
 * @description Barrel export for `@sanix/perf`.
 *
 * @packageDocumentation
 */

export { WorkerPool } from './WorkerPool.js';
export type { WorkerPoolOptions } from './WorkerPool.js';
export { ConnectionPool } from './ConnectionPool.js';
export type { ConnectionPoolOptions, PoolRequestOptions, PoolResponse } from './ConnectionPool.js';
export { RequestBatcher } from './RequestBatcher.js';
export type { RequestBatcherOptions } from './RequestBatcher.js';
export { LazyLoader } from './LazyLoader.js';
export { MemoryPool } from './MemoryPool.js';
export type { MemoryPoolOptions } from './MemoryPool.js';
export { debounce, throttle, asyncDebounce } from './Debounce.js';
export type { Debounced, Throttled, AsyncDebounced } from './Debounce.js';
export { PerfMonitor } from './PerfMonitor.js';
export type { PerfMonitorOptions, MetricSnapshot } from './PerfMonitor.js';
export { WarmupManager } from './WarmupManager.js';
export type { WarmupManagerOptions, WarmupPriority, WarmupResult } from './WarmupManager.js';
export { CacheHierarchy } from './CacheHierarchy.js';
export type { CacheHierarchyOptions, CacheGetResult } from './CacheHierarchy.js';

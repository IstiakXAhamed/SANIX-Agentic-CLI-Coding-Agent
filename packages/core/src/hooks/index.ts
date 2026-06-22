/**
 * @file hooks/index.ts
 * @description Barrel re-export for `@sanix/core/hooks`. Surface:
 *   - `HookManager` (the registry + dispatcher)
 *   - Types: `HookEvent`, `HookContext`, `HookResult`, `HookRegistration`,
 *     `HookHandler`, `CostEntry`, `CostSummary`
 *
 * Import paths:
 *   import { HookManager, HookEvent } from '@sanix/core/hooks';
 */

export {
  HookManager,
  type HookContext,
  type HookEvent,
  type HookHandler,
  type HookRegistration,
  type HookResult,
  type CostEntry,
  type CostSummary,
} from './HookManager.js';

/**
 * @file checkpoint/index.ts
 * @description Barrel re-export for `@sanix/core/checkpoint`. Surface:
 *   - `CheckpointManager` (+ `CheckpointManagerOptions`)
 *   - Type: `Checkpoint`
 *
 * Import paths:
 *   import { CheckpointManager, Checkpoint } from '@sanix/core/checkpoint';
 */

export {
  CheckpointManager,
  type CheckpointManagerOptions,
  type Checkpoint,
} from './CheckpointManager.js';

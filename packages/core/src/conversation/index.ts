/**
 * @file conversation/index.ts
 * @description Barrel re-export for `@sanix/core/conversation`. Surface:
 *   - `BranchManager`
 *   - Type: `ConversationBranch`
 *
 * Import paths:
 *   import { BranchManager, ConversationBranch } from '@sanix/core/conversation';
 */

export {
  BranchManager,
  type ConversationBranch,
} from './BranchManager.js';

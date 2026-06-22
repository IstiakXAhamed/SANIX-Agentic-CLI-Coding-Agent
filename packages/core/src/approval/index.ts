/**
 * @file approval/index.ts
 * @description Barrel re-export for `@sanix/core/approval`. Surface:
 *   - `ApprovalManager` (+ `ApprovalManagerOptions`)
 *   - `InteractiveApprovalHandler`
 *   - Types: `ApprovalDecision`, `ApprovalRequest`, `ApprovalResponse`,
 *     `ApprovalHandler`, `RiskLevel`
 *
 * Import paths:
 *   import { ApprovalManager, InteractiveApprovalHandler } from '@sanix/core/approval';
 */

export {
  ApprovalManager,
  type ApprovalManagerOptions,
  InteractiveApprovalHandler,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResponse,
  type RiskLevel,
} from './ApprovalManager.js';

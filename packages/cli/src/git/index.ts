/**
 * @file git/index.ts
 * @description Barrel re-export for SANIX's git integration.
 *
 * Public surface:
 *   - {@link AutoCommit}            — per-goal branching + per-action commits.
 *   - {@link AutoCommitOptions}     — constructor options.
 *   - {@link StartGoalResult}       — return value of `startGoal`.
 *
 * @packageDocumentation
 */

export {
  AutoCommit,
  type AutoCommitOptions,
  type StartGoalResult,
} from './AutoCommit.js';

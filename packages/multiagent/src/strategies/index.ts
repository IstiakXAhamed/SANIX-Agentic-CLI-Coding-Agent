/**
 * @file strategies/index.ts
 * @description Barrel re-export for all strategy implementations plus
 * the {@link getStrategy} factory.
 *
 * @packageDocumentation
 */

import type { TeamStrategy } from '../types.js';
import type { StrategyImpl } from './types.js';
import { ParallelStrategy } from './ParallelStrategy.js';
import { SequentialStrategy } from './SequentialStrategy.js';
import { DebateStrategy } from './DebateStrategy.js';
import { VotingStrategy } from './VotingStrategy.js';
import { MoEStrategy } from './MoEStrategy.js';
import { HierarchicalStrategy } from './HierarchicalStrategy.js';
import { SwarmStrategy } from './SwarmStrategy.js';

export { ParallelStrategy } from './ParallelStrategy.js';
export { SequentialStrategy } from './SequentialStrategy.js';
export { DebateStrategy } from './DebateStrategy.js';
export { VotingStrategy } from './VotingStrategy.js';
export { MoEStrategy } from './MoEStrategy.js';
export { HierarchicalStrategy } from './HierarchicalStrategy.js';
export { SwarmStrategy } from './SwarmStrategy.js';
export type {
  StrategyImpl,
  StrategyContext,
  MemberRunResult,
} from './types.js';
export { runMember, toContribution, buildTeamResult, successfulResults } from './types.js';

/**
 * Factory: get the strategy implementation for a given strategy name.
 *
 * @param name - The strategy name (e.g. `'parallel'`, `'debate'`).
 * @returns A fresh {@link StrategyImpl} instance.
 * @throws If `name` is not a recognized strategy.
 *
 * @example
 * ```ts
 * const strategy = getStrategy('debate');
 * const result = await strategy.execute(ctx, 'Should we use tabs or spaces?');
 * ```
 */
export function getStrategy(name: TeamStrategy): StrategyImpl {
  switch (name) {
    case 'parallel':
      return new ParallelStrategy();
    case 'sequential':
      return new SequentialStrategy();
    case 'debate':
      return new DebateStrategy();
    case 'voting':
      return new VotingStrategy();
    case 'mixture_of_experts':
      return new MoEStrategy();
    case 'hierarchical':
      return new HierarchicalStrategy();
    case 'swarm':
      return new SwarmStrategy();
    default: {
      // Exhaustiveness check — if a new strategy is added to the union
      // but not handled here, TS will flag this branch.
      const _exhaustive: never = name;
      throw new Error(`Unknown strategy: ${String(_exhaustive)}`);
    }
  }
}

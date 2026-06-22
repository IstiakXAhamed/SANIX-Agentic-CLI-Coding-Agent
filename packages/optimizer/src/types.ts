/**
 * @file types.ts
 * @description Local type declarations for the optimizer package. These
 * are structurally compatible with `@sanix/core`'s context / agent
 * types but declared locally to avoid a runtime cycle (core imports
 * from optimizer; optimizer must not import from core).
 *
 * TypeScript's structural typing means callers can pass their
 * `@sanix/core`-typed objects directly into optimizer methods without
 * any adapter — the shapes line up.
 *
 * @packageDocumentation
 */

import type { LLMMessage } from '@sanix/providers';

/**
 * Per-tier budget allocation. Mirrors
 * `@sanix/core/context/BudgetAllocation` exactly.
 */
export interface BudgetAllocation {
  system: number;
  memory: number;
  plan: number;
  history: number;
  context: number;
  output: number;
}

/**
 * The assembled prompt context produced by `TokenBudget.buildContext`.
 * Mirrors `@sanix/core/context/BuiltContext` exactly.
 */
export interface BuiltContext {
  /** Compressed system prompt (cacheable prefix). */
  system: string;
  /** Selected memory items, formatted as text. */
  memory: string;
  /** Current plan, formatted as text. */
  plan: string;
  /** Compressed conversation history. */
  history: LLMMessage[];
  /** Smart file context (only relevant sections). */
  context: string;
  /** Per-tier token accounting. */
  tokens: BudgetAllocation;
  /** True if the system prompt should be flagged as cacheable. */
  systemCacheable: boolean;
}

/**
 * Per-tier token usage (actual tokens consumed). Same shape as
 * {@link BudgetAllocation}; declared separately for semantic clarity
 * (usage vs. budget).
 */
export interface TierUsage {
  system: number;
  memory: number;
  plan: number;
  history: number;
  context: number;
  output: number;
}

/**
 * @file strategies/types.ts
 * @description Shared interfaces and helpers for the strategy implementations.
 * Defines the {@link StrategyContext} (everything a strategy needs to run),
 * {@link StrategyImpl} (the strategy contract), and a {@link runMember}
 * helper that wraps a single member's run in try/catch + timing + metrics.
 *
 * @packageDocumentation
 */

import type { AgentObserver, SanixTracer, Span } from '@sanix/observe';
import type {
  AgentHandle,
  TeamContribution,
  TeamConfig,
  TeamEvents,
  TeamMember,
  TeamResult,
  TeamStrategy,
} from '../types.js';
import type { ConsensusEngine } from '../ConsensusEngine.js';
import type { QualityScorer } from '../QualityScorer.js';
import type { MoERouter } from '../MoERouter.js';

/**
 * Everything a strategy needs to execute. Built by {@link AgentTeam}
 * before dispatching to a strategy.
 */
export interface StrategyContext {
  /** The team configuration. */
  config: TeamConfig;
  /** The team's members (read-only copy). */
  members: readonly TeamMember[];
  /** Pre-built agent handles, keyed by member id. */
  handles: Map<string, AgentHandle>;
  /** Optional observer (for trace spans). */
  observer?: AgentObserver;
  /** Optional tracer (for direct span creation). */
  tracer?: SanixTracer;
  /** The consensus engine (shared across strategies). */
  consensusEngine: ConsensusEngine;
  /** The quality scorer (shared across strategies). */
  qualityScorer: QualityScorer;
  /** Optional MoE router (built if any member has specialties). */
  moeRouter?: MoERouter;
  /** Emit a team event. */
  emit<E extends keyof TeamEvents>(event: E, payload: TeamEvents[E]): void;
  /** Abort signal (fires when the team is aborted or times out). */
  signal: AbortSignal;
  /** Concurrency limiter (p-limit). */
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * The strategy contract. Each strategy implements `execute` and
 * declares its `name`.
 */
export interface StrategyImpl {
  /** The strategy name (matches a {@link TeamStrategy} value). */
  readonly name: TeamStrategy;
  /** Execute the strategy. */
  execute(
    ctx: StrategyContext,
    problem: string,
    context?: string,
  ): Promise<TeamResult>;
}

/**
 * The result of running a single member via {@link runMember}.
 */
export interface MemberRunResult {
  /** Member id. */
  memberId: string;
  /** The member's output (empty string on failure). */
  output: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Cost in USD (0 if the handle doesn't expose metrics). */
  costUsd: number;
  /** Tokens used (0 if the handle doesn't expose metrics). */
  tokensUsed: number;
  /** Error message if the run failed; undefined on success. */
  error?: string;
}

/**
 * Run a single member's agent handle on a prompt. Wraps the call in:
 *   - `member:start` / `member:complete` event emissions,
 *   - try/catch (one bad member doesn't crash the team),
 *   - wall-clock timing,
 *   - optional trace span (via `ctx.tracer`, if available),
 *   - metrics extraction from `handle.lastRun()` (if implemented).
 *
 * @param ctx       - The strategy context.
 * @param member    - The member to run.
 * @param input     - The primary prompt.
 * @param context   - Optional additional context (prior outputs, debate history).
 * @returns The member's run result (output + metrics + optional error).
 *
 * @example
 * ```ts
 * const result = await runMember(ctx, member, 'What is 2+2?');
 * if (result.error) console.warn(`Member ${member.id} failed:`, result.error);
 * else console.log(`Output: ${result.output}`);
 * ```
 */
export async function runMember(
  ctx: StrategyContext,
  member: TeamMember,
  input: string,
  context?: string,
): Promise<MemberRunResult> {
  const handle = ctx.handles.get(member.id);
  if (!handle) {
    return {
      memberId: member.id,
      output: '',
      durationMs: 0,
      costUsd: 0,
      tokensUsed: 0,
      error: `No agent handle for member ${member.id}`,
    };
  }

  ctx.emit('member:start', {
    teamName: ctx.config.name,
    memberId: member.id,
    persona: member.persona,
    role: member.role,
  });

  const start = Date.now();
  let span: Span | undefined;
  if (ctx.tracer) {
    span = ctx.tracer.startSpan(`member:${member.id}`, {
      attributes: {
        'member.id': member.id,
        'member.persona': member.persona,
        'member.role': member.role,
        'input.length': input.length,
      },
    });
  }

  let output = '';
  let error: string | undefined;
  try {
    if (ctx.signal.aborted) throw new Error('Team aborted');
    output = await handle.run(input, context);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    output = '';
  }

  const durationMs = Date.now() - start;
  let costUsd = 0;
  let tokensUsed = 0;
  if (handle.lastRun) {
    try {
      const m = handle.lastRun();
      costUsd = m.costUsd ?? 0;
      tokensUsed = m.tokensUsed ?? 0;
    } catch {
      // ignore metrics errors
    }
  }

  if (span) {
    if (error) {
      span.setStatus('error');
      span.setAttribute('error.message', error);
    } else {
      span.setAttribute('output.length', output.length);
      span.setStatus('ok');
    }
    span.end();
  }

  ctx.emit('member:complete', {
    teamName: ctx.config.name,
    memberId: member.id,
    output,
    durationMs,
    costUsd,
    tokensUsed,
    error,
  });

  return { memberId: member.id, output, durationMs, costUsd, tokensUsed, error };
}

/**
 * Build a {@link TeamContribution} from a {@link MemberRunResult}.
 */
export function toContribution(
  member: TeamMember,
  result: MemberRunResult,
  agreementScore?: number,
): TeamContribution {
  return {
    memberId: member.id,
    persona: member.persona,
    role: member.role,
    output: result.output,
    costUsd: result.costUsd,
    tokensUsed: result.tokensUsed,
    durationMs: result.durationMs,
    agreementScore,
  };
}

/**
 * Build the final {@link TeamResult} from contributions + consensus.
 */
export function buildTeamResult(
  ctx: StrategyContext,
  contributions: TeamContribution[],
  consensus: string,
  confidence: number,
  disagreements: string[],
  rounds: number,
): TeamResult {
  const totalCostUsd = contributions.reduce((s, c) => s + c.costUsd, 0);
  const totalTokens = contributions.reduce((s, c) => s + c.tokensUsed, 0);
  const totalDurationMs = contributions.reduce((s, c) => s + c.durationMs, 0);
  return {
    teamName: ctx.config.name,
    consensus,
    contributions,
    consensusConfidence: confidence,
    totalCostUsd,
    totalTokens,
    totalDurationMs,
    rounds,
    disagreements,
  };
}

/**
 * Filter out members whose runs failed (empty output + error). Useful
 * for consensus / voting strategies where failed members should be
 * excluded from the candidate set.
 */
export function successfulResults(
  results: MemberRunResult[],
): MemberRunResult[] {
  return results.filter((r) => !r.error && r.output.trim().length > 0);
}

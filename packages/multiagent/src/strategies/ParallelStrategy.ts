/**
 * @file ParallelStrategy.ts
 * @description All members solve the same problem in parallel (subject
 * to `maxConcurrent`), then synthesize the outputs.
 *
 * Synthesis: if the team's consensus method is one of the standard
 * reconciliation methods (`majority`, `weighted`, `best_of_n`, etc.),
 * the {@link ConsensusEngine} picks the winning output; otherwise the
 * strategy picks the highest-quality output via the {@link QualityScorer}.
 *
 * @packageDocumentation
 */

import type { TeamResult } from '../types.js';
import type { StrategyContext, StrategyImpl } from './types.js';
import { buildTeamResult, runMember, successfulResults, toContribution } from './types.js';

/**
 * Parallel execution strategy: all members solve in parallel, then
 * synthesize.
 *
 * @example
 * ```ts
 * const strategy = new ParallelStrategy();
 * const result = await strategy.execute(ctx, 'Design a REST API for a todo app.');
 * ```
 */
export class ParallelStrategy implements StrategyImpl {
  readonly name = 'parallel' as const;

  async execute(
    ctx: StrategyContext,
    problem: string,
    context?: string,
  ): Promise<TeamResult> {
    const members = ctx.members;
    const prompt = buildPrompt(problem, context);

    const results = await Promise.all(
      members.map((m) => ctx.limit(() => runMember(ctx, m, prompt))),
    );

    const ok = successfulResults(results);
    if (ok.length === 0) {
      // All members failed — return an empty result.
      const contributions = results.map((r, i) =>
        toContribution(members[i]!, r, 0),
      );
      return buildTeamResult(ctx, contributions, '', 0, members.map((m) => m.id), 1);
    }

    // Reach consensus via the configured method.
    const consensusInputs = ok.map((r) => {
      const member = members.find((m) => m.id === r.memberId)!;
      return {
        memberId: r.memberId,
        output: r.output,
        weight: member.weight,
      };
    });
    const consensusResult = await ctx.consensusEngine.reach(
      consensusInputs,
      ctx.config.consensus,
    );

    // Build contributions, scoring agreement with the consensus.
    const contributions = results.map((r, i) => {
      const member = members[i]!;
      const agreement = r.error
        ? 0
        : consensusResult.disagreements.includes(r.memberId)
          ? 0.3
          : 1.0;
      return toContribution(member, r, agreement);
    });

    if (consensusResult.disagreements.length > 0) {
      ctx.emit('conflict:detected', {
        teamName: ctx.config.name,
        disagreements: consensusResult.disagreements,
      });
    }
    if (consensusResult.confidence >= 0.5) {
      ctx.emit('consensus:reached', {
        teamName: ctx.config.name,
        consensus: consensusResult.consensus,
        confidence: consensusResult.confidence,
      });
    } else {
      ctx.emit('consensus:failed', {
        teamName: ctx.config.name,
        reason: `Low confidence (${consensusResult.confidence.toFixed(2)})`,
      });
    }

    return buildTeamResult(
      ctx,
      contributions,
      consensusResult.consensus,
      consensusResult.confidence,
      consensusResult.disagreements,
      1,
    );
  }
}

/**
 * Build the prompt for a parallel member. Includes the problem and any
 * additional context (e.g. prior debate history).
 */
function buildPrompt(problem: string, context?: string): string {
  if (context) {
    return `${context}\n\n---\n\nProblem: ${problem}\n\nProvide your solution.`;
  }
  return `Problem: ${problem}\n\nProvide your solution.`;
}

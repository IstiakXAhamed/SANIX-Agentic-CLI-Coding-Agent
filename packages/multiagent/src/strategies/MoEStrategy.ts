/**
 * @file MoEStrategy.ts
 * @description Mixture-of-Experts strategy. Uses the {@link MoERouter}
 * to pick the top-K most relevant experts for the query, then either:
 *   - if topK = 1 (default): the single expert answers,
 *   - if topK > 1: the top-K experts answer in parallel, and the
 *     {@link ConsensusEngine} synthesizes their outputs.
 *
 * The router's specialties are derived from the team config's members
 * (via the optional `MoESpecialty` extension stored on member.metadata).
 * Since {@link TeamMember} doesn't carry specialties directly, the
 * strategy reads them from the team's MoERouter (built by the AgentTeam
 * from member role/persona heuristics).
 *
 * @packageDocumentation
 */

import type { TeamResult } from '../types.js';
import type { StrategyContext, StrategyImpl } from './types.js';
import { buildTeamResult, runMember, toContribution } from './types.js';

/**
 * Mixture-of-Experts execution strategy.
 *
 * @example
 * ```ts
 * const strategy = new MoEStrategy();
 * const result = await strategy.execute(ctx, 'How do I implement binary search in TypeScript?');
 * // router picks the 'coder' expert; coder answers
 * ```
 */
export class MoEStrategy implements StrategyImpl {
  readonly name = 'mixture_of_experts' as const;

  async execute(
    ctx: StrategyContext,
    problem: string,
    context?: string,
  ): Promise<TeamResult> {
    const router = ctx.moeRouter;
    if (!router) {
      // No router — fall back to parallel.
      const fallback = new (await import('./ParallelStrategy.js')).ParallelStrategy();
      return fallback.execute(ctx, problem, context);
    }

    const ranked = await router.route(problem);
    if (ranked.length === 0) {
      // Router returned nothing — fall back to parallel with all members.
      const fallback = new (await import('./ParallelStrategy.js')).ParallelStrategy();
      return fallback.execute(ctx, problem, context);
    }

    const experts = ranked
      .map((r) => ctx.members.find((m) => m.id === r.memberId))
      .filter((m): m is NonNullable<typeof m> => m !== undefined);

    if (experts.length === 0) {
      const fallback = new (await import('./ParallelStrategy.js')).ParallelStrategy();
      return fallback.execute(ctx, problem, context);
    }

    // Build the prompt — includes the routing score as context.
    const prompt = buildMoEPrompt(problem, context, ranked);

    if (experts.length === 1) {
      // Single-expert MoE — the expert answers directly.
      const expert = experts[0]!;
      const result = await runMember(ctx, expert, prompt);
      const contribution = toContribution(expert, result, 1.0);
      const confidence = result.error ? 0 : 0.7 + (ranked[0]?.score ?? 0) * 0.3;
      ctx.emit('consensus:reached', {
        teamName: ctx.config.name,
        consensus: result.output,
        confidence,
      });
      // Include all other members as 0-cost non-participants.
      const contributions = ctx.members.map((m) =>
        m.id === expert.id
          ? contribution
          : toContribution(m, {
              memberId: m.id,
              output: '',
              durationMs: 0,
              costUsd: 0,
              tokensUsed: 0,
            }, 0),
      );
      return buildTeamResult(
        ctx,
        contributions,
        result.output,
        confidence,
        [],
        1,
      );
    }

    // Multi-expert MoE — experts answer in parallel, then synthesize.
    const results = await Promise.all(
      experts.map((e) => ctx.limit(() => runMember(ctx, e, prompt))),
    );

    const consensusInputs = results
      .filter((r) => !r.error && r.output.trim().length > 0)
      .map((r) => {
        const member = ctx.members.find((m) => m.id === r.memberId)!;
        return { memberId: r.memberId, output: r.output, weight: member.weight };
      });

    if (consensusInputs.length === 0) {
      const contributions = ctx.members.map((m) => {
        const r = results.find((rr) => rr.memberId === m.id);
        return toContribution(
          m,
          r ?? { memberId: m.id, output: '', durationMs: 0, costUsd: 0, tokensUsed: 0 },
          0,
        );
      });
      return buildTeamResult(
        ctx,
        contributions,
        '',
        0,
        ctx.members.map((m) => m.id),
        1,
      );
    }

    const consensusResult = await ctx.consensusEngine.reach(
      consensusInputs,
      ctx.config.consensus,
    );

    const contributions = ctx.members.map((m) => {
      const r = results.find((rr) => rr.memberId === m.id);
      if (!r) {
        return toContribution(
          m,
          { memberId: m.id, output: '', durationMs: 0, costUsd: 0, tokensUsed: 0 },
          0,
        );
      }
      const agreement = consensusResult.disagreements.includes(m.id) ? 0.3 : 1.0;
      return toContribution(m, r, agreement);
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
        reason: `Low MoE consensus (${consensusResult.confidence.toFixed(2)})`,
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
 * Build the MoE prompt. Includes the routing score so the expert knows
 * how relevant the query is to its specialty.
 */
function buildMoEPrompt(
  problem: string,
  context: string | undefined,
  ranked: Array<{ memberId: string; score: number }>,
): string {
  const lines: string[] = [];
  if (context) {
    lines.push(context);
    lines.push('');
  }
  lines.push(`Problem: ${problem}`);
  lines.push('');
  lines.push('You have been selected as the most relevant expert for this query.');
  lines.push('Routing scores (you vs. other experts):');
  for (const r of ranked) {
    lines.push(`  ${r.memberId}: ${r.score.toFixed(2)}`);
  }
  lines.push('');
  lines.push('Provide your expert solution.');
  return lines.join('\n');
}

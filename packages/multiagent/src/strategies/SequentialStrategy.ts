/**
 * @file SequentialStrategy.ts
 * @description Members solve one at a time, each building on the previous
 * member's output (relay-race style). The final member's output is the
 * consensus.
 *
 * Members are executed in the order they appear in the config. Each
 * member receives the problem + the accumulated outputs of all prior
 * members as context. Failed members are skipped (their output is
 * omitted from the accumulated context, but the chain continues).
 *
 * @packageDocumentation
 */

import type { TeamResult } from '../types.js';
import type { StrategyContext, StrategyImpl } from './types.js';
import { buildTeamResult, runMember, toContribution } from './types.js';

/**
 * Sequential execution strategy: members solve one at a time, each
 * building on the previous.
 *
 * @example
 * ```ts
 * const strategy = new SequentialStrategy();
 * const result = await strategy.execute(ctx, 'Fix the failing test.');
 * // debugger → coder → tester chain
 * ```
 */
export class SequentialStrategy implements StrategyImpl {
  readonly name = 'sequential' as const;

  async execute(
    ctx: StrategyContext,
    problem: string,
    context?: string,
  ): Promise<TeamResult> {
    const members = ctx.members;
    const contributions: ReturnType<typeof toContribution>[] = [];
    const accumulated: string[] = [];
    if (context) accumulated.push(context);

    let lastOutput = '';

    for (let i = 0; i < members.length; i++) {
      const member = members[i]!;
      const prompt = buildSequentialPrompt(problem, accumulated, i === 0);
      const result = await runMember(ctx, member, prompt);
      contributions.push(toContribution(member, result, 1.0));
      if (!result.error && result.output.trim().length > 0) {
        accumulated.push(`[${member.persona}]: ${result.output}`);
        lastOutput = result.output;
      }
    }

    // Consensus = last successful member's output.
    const consensus = lastOutput;
    // Confidence = fraction of members that succeeded.
    const successCount = contributions.filter((c) => c.output.trim().length > 0).length;
    const confidence = members.length > 0 ? successCount / members.length : 0;

    if (confidence >= 0.5) {
      ctx.emit('consensus:reached', {
        teamName: ctx.config.name,
        consensus,
        confidence,
      });
    } else {
      ctx.emit('consensus:failed', {
        teamName: ctx.config.name,
        reason: `Only ${successCount}/${members.length} members succeeded`,
      });
    }

    return buildTeamResult(
      ctx,
      contributions,
      consensus,
      confidence,
      [],
      1,
    );
  }
}

/**
 * Build the prompt for a sequential member. The first member gets just
 * the problem; subsequent members get the accumulated prior outputs.
 */
function buildSequentialPrompt(
  problem: string,
  accumulated: string[],
  isFirst: boolean,
): string {
  if (isFirst) {
    return `Problem: ${problem}\n\nProvide your solution. A subsequent agent will build on your output.`;
  }
  return [
    `Problem: ${problem}`,
    '',
    'Prior agents have produced the following outputs:',
    ...accumulated.map((s, i) => `--- Prior ${i + 1} ---\n${s}`),
    '',
    'Build on the prior outputs. Provide your refined solution.',
  ].join('\n');
}

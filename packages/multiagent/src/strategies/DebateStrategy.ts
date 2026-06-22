/**
 * @file DebateStrategy.ts
 * @description Members argue for N rounds. Each round:
 *   (1) all members state their position on the problem,
 *   (2) all members rebut the other members' positions,
 *   (3) optional judge synthesizes the final consensus.
 *
 * Tracks {@link DebateTurn[]} internally (one turn per member per round,
 * with rebuttals filled in during the rebuttal phase).
 *
 * @packageDocumentation
 */

import type { DebateTurn, TeamResult } from '../types.js';
import type { StrategyContext, StrategyImpl, MemberRunResult } from './types.js';
import { buildTeamResult, runMember, successfulResults, toContribution } from './types.js';

/**
 * Debate execution strategy: members argue for N rounds, then a judge
 * (or majority vote) synthesizes the final consensus.
 *
 * @example
 * ```ts
 * const strategy = new DebateStrategy();
 * const result = await strategy.execute(ctx, 'Should we use tabs or spaces?');
 * // 2 rounds of debate + judge synthesis
 * ```
 */
export class DebateStrategy implements StrategyImpl {
  readonly name = 'debate' as const;

  async execute(
    ctx: StrategyContext,
    problem: string,
    context?: string,
  ): Promise<TeamResult> {
    const members = ctx.members;
    const totalRounds = Math.max(1, ctx.config.rounds ?? 1);
    const turns: DebateTurn[] = [];
    // Per-member latest position, updated each round.
    const positions = new Map<string, string>();
    // Per-member accumulated run metrics.
    const memberMetrics = new Map<
      string,
      { costUsd: number; tokensUsed: number; durationMs: number; outputs: string[] }
    >();
    for (const m of members) {
      memberMetrics.set(m.id, { costUsd: 0, tokensUsed: 0, durationMs: 0, outputs: [] });
    }

    for (let round = 0; round < totalRounds; round++) {
      ctx.emit('round:start', {
        teamName: ctx.config.name,
        round,
        totalRounds,
      });

      // Phase 1: each member states their position.
      const positionResults = await Promise.all(
        members.map((m) =>
          ctx.limit(async () => {
            const prior = round > 0 ? formatPriorPositions(m.id, positions) : context;
            const prompt = buildPositionPrompt(problem, m, round, prior);
            const result = await runMember(ctx, m, prompt);
            accumulateMetrics(memberMetrics, m.id, result);
            if (!result.error && result.output.trim().length > 0) {
              positions.set(m.id, result.output);
              memberMetrics.get(m.id)!.outputs.push(result.output);
            }
            return result;
          }),
        ),
      );

      // Phase 2: each member rebuts the others' positions.
      const rebuttalResults = await Promise.all(
        members.map((m) =>
          ctx.limit(async () => {
            const others = formatOthersPositions(m.id, positions);
            if (others.length === 0) return null;
            const prompt = buildRebuttalPrompt(problem, m, round, others);
            const result = await runMember(ctx, m, prompt);
            accumulateMetrics(memberMetrics, m.id, result);
            if (!result.error && result.output.trim().length > 0) {
              memberMetrics.get(m.id)!.outputs.push(result.output);
            }
            return result;
          }),
        ),
      );

      // Record debate turns.
      for (let i = 0; i < members.length; i++) {
        const member = members[i]!;
        const position = positionResults[i]!.output;
        const rebuttal = rebuttalResults[i]?.output ?? '';
        turns.push({
          round,
          memberId: member.id,
          position,
          rebuttals: parseRebuttals(rebuttal, members, member.id),
        });
      }

      ctx.emit('round:complete', {
        teamName: ctx.config.name,
        round,
        outputs: [...positions.values()],
      });
    }

    // Phase 3: synthesize.
    const consensusInputs: Array<{ memberId: string; output: string; weight: number }> = [];
    for (const m of members) {
      const pos = positions.get(m.id);
      if (pos && pos.trim().length > 0) {
        consensusInputs.push({ memberId: m.id, output: pos, weight: m.weight });
      }
    }

    let consensus = '';
    let confidence = 0;
    let disagreements: string[] = [];

    const judgeMember = ctx.config.judgeMemberId
      ? members.find((m) => m.id === ctx.config.judgeMemberId)
      : undefined;

    if (ctx.config.consensus === 'judge_decided' && judgeMember) {
      // Use the judge member to synthesize.
      const candidates = consensusInputs.map((c) => c.output);
      const prompt = buildJudgePrompt(problem, candidates, turns);
      const result = await runMember(ctx, judgeMember, prompt);
      accumulateMetrics(memberMetrics, judgeMember.id, result);
      consensus = result.output || candidates[0] || '';
      confidence = result.error ? 0.5 : 1.0;
      disagreements = consensusInputs
        .filter((c) => c.output !== consensus)
        .map((c) => c.memberId);
    } else if (consensusInputs.length > 0) {
      const consensusResult = await ctx.consensusEngine.reach(
        consensusInputs,
        ctx.config.consensus,
      );
      consensus = consensusResult.consensus;
      confidence = consensusResult.confidence;
      disagreements = consensusResult.disagreements;
    }

    // Build contributions from accumulated metrics.
    const contributions = members.map((m) => {
      const metrics = memberMetrics.get(m.id)!;
      const isJudge = m.id === ctx.config.judgeMemberId;
      const agreement = disagreements.includes(m.id) ? 0.3 : 1.0;
      return toContribution(
        m,
        {
          memberId: m.id,
          output: positions.get(m.id) ?? metrics.outputs.join('\n\n') ?? '',
          durationMs: metrics.durationMs,
          costUsd: metrics.costUsd,
          tokensUsed: metrics.tokensUsed,
        },
        isJudge ? 1.0 : agreement,
      );
    });

    if (disagreements.length > 0) {
      ctx.emit('conflict:detected', {
        teamName: ctx.config.name,
        disagreements,
      });
    }
    if (confidence >= 0.5) {
      ctx.emit('consensus:reached', {
        teamName: ctx.config.name,
        consensus,
        confidence,
      });
    } else {
      ctx.emit('consensus:failed', {
        teamName: ctx.config.name,
        reason: `Low confidence after ${totalRounds} rounds`,
      });
    }

    return buildTeamResult(
      ctx,
      contributions,
      consensus,
      confidence,
      disagreements,
      totalRounds,
    );
  }
}

/**
 * Add a member's run result to the accumulated metrics map.
 */
function accumulateMetrics(
  map: Map<string, { costUsd: number; tokensUsed: number; durationMs: number; outputs: string[] }>,
  memberId: string,
  result: MemberRunResult,
): void {
  const entry = map.get(memberId);
  if (!entry) return;
  entry.costUsd += result.costUsd;
  entry.tokensUsed += result.tokensUsed;
  entry.durationMs += result.durationMs;
}

/**
 * Format prior positions for the position phase. Excludes the current
 * member's own prior position (so they can reconsider fresh).
 */
function formatPriorPositions(
  currentMemberId: string,
  positions: Map<string, string>,
): string | undefined {
  const lines: string[] = [];
  for (const [id, pos] of positions) {
    if (id === currentMemberId) continue;
    lines.push(`[${id}]: ${pos}`);
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

/**
 * Format other members' current positions for the rebuttal phase.
 */
function formatOthersPositions(
  currentMemberId: string,
  positions: Map<string, string>,
): Array<{ memberId: string; position: string }> {
  const out: Array<{ memberId: string; position: string }> = [];
  for (const [id, pos] of positions) {
    if (id !== currentMemberId) out.push({ memberId: id, position: pos });
  }
  return out;
}

/**
 * Build the prompt for the position phase.
 */
function buildPositionPrompt(
  problem: string,
  member: { persona: string; role: string },
  round: number,
  prior?: string,
): string {
  const lines: string[] = [];
  lines.push(`You are a ${member.persona} (${member.role}) in a structured debate.`);
  lines.push(`Problem: ${problem}`);
  lines.push('');
  if (round > 0 && prior) {
    lines.push(`Round ${round + 1}. Other debaters' prior positions:`);
    lines.push(prior);
    lines.push('');
    lines.push('Reconsider your position in light of the above. State your updated position with justification.');
  } else {
    lines.push(`Round ${round + 1}. State your initial position with justification.`);
  }
  return lines.join('\n');
}

/**
 * Build the prompt for the rebuttal phase.
 */
function buildRebuttalPrompt(
  problem: string,
  member: { persona: string; role: string },
  round: number,
  others: Array<{ memberId: string; position: string }>,
): string {
  const lines: string[] = [];
  lines.push(`You are a ${member.persona} (${member.role}) in a structured debate.`);
  lines.push(`Problem: ${problem}`);
  lines.push('');
  lines.push(`Round ${round + 1} rebuttal phase. Other debaters' positions:`);
  for (const o of others) {
    lines.push(`[${o.memberId}]: ${o.position}`);
  }
  lines.push('');
  lines.push('For each other debater, write a brief rebuttal. Format:');
  lines.push('TARGET: <memberId>');
  lines.push('ARGUMENT: <your rebuttal>');
  lines.push('');
  lines.push('Provide one rebuttal block per other debater.');
  return lines.join('\n');
}

/**
 * Build the prompt for the judge's synthesis.
 */
function buildJudgePrompt(
  problem: string,
  candidates: string[],
  turns: DebateTurn[],
): string {
  const lines: string[] = [];
  lines.push('You are the judge of a structured debate. Synthesize the final consensus.');
  lines.push(`Problem: ${problem}`);
  lines.push('');
  lines.push('Candidate positions:');
  candidates.forEach((c, i) => {
    lines.push(`--- Candidate ${i + 1} ---`);
    lines.push(c);
  });
  lines.push('');
  lines.push('Debate history (positions + rebuttals):');
  for (const turn of turns) {
    lines.push(`Round ${turn.round + 1}, ${turn.memberId}:`);
    lines.push(`  Position: ${turn.position}`);
    for (const r of turn.rebuttals) {
      lines.push(`  Rebuttal to ${r.targetMemberId}: ${r.argument}`);
    }
  }
  lines.push('');
  lines.push('Provide the final consensus answer. Consider all positions and rebuttals.');
  return lines.join('\n');
}

/**
 * Parse a rebuttal block into structured rebuttals.
 */
function parseRebuttals(
  text: string,
  members: ReadonlyArray<{ id: string }>,
  currentMemberId: string,
): Array<{ targetMemberId: string; argument: string }> {
  if (!text) return [];
  const rebuttals: Array<{ targetMemberId: string; argument: string }> = [];
  const blocks = text.split(/TARGET:\s*/i).slice(1);
  for (const block of blocks) {
    const match = /^([^\n]+)\s*\n\s*ARGUMENT:\s*([\s\S]*?)(?=(?:TARGET:|$))/i.exec(block);
    if (!match || !match[1] || !match[2]) continue;
    const targetId = match[1].trim();
    const argument = match[2].trim();
    // Validate target member exists and isn't the current member.
    const valid = members.some((m) => m.id === targetId) && targetId !== currentMemberId;
    if (valid) {
      rebuttals.push({ targetMemberId: targetId, argument });
    }
  }
  return rebuttals;
}

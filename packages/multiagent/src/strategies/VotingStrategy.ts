/**
 * @file VotingStrategy.ts
 * @description Each member proposes a solution. Then all members vote
 * on which proposed solution is best (no self-votes). Consensus via
 * the configured {@link ConsensusMethod}.
 *
 * The voting prompt asks each member to pick the best proposal by
 * index (excluding their own). Votes are tallied; the proposal with
 * the most votes (weighted by member weight, if `weighted`) wins. If
 * there's a tie, the {@link QualityScorer} breaks it.
 *
 * @packageDocumentation
 */

import type { TeamResult } from '../types.js';
import type { StrategyContext, StrategyImpl } from './types.js';
import { buildTeamResult, runMember, successfulResults, toContribution } from './types.js';

/**
 * Voting execution strategy: members propose, then vote.
 *
 * @example
 * ```ts
 * const strategy = new VotingStrategy();
 * const result = await strategy.execute(ctx, 'Pick the best library for state management.');
 * // 5 members propose, then vote on the proposals
 * ```
 */
export class VotingStrategy implements StrategyImpl {
  readonly name = 'voting' as const;

  async execute(
    ctx: StrategyContext,
    problem: string,
    context?: string,
  ): Promise<TeamResult> {
    const members = ctx.members;

    // Phase 1: each member proposes a solution.
    const proposalResults = await Promise.all(
      members.map((m) =>
        ctx.limit(() =>
          runMember(ctx, m, buildProposalPrompt(problem, context)),
        ),
      ),
    );

    const okResults = successfulResults(proposalResults);
    if (okResults.length === 0) {
      const contributions = proposalResults.map((r, i) =>
        toContribution(members[i]!, r, 0),
      );
      return buildTeamResult(
        ctx,
        contributions,
        '',
        0,
        members.map((m) => m.id),
        1,
      );
    }

    // Phase 2: each member votes on the best proposal (no self-votes).
    const proposals = okResults.map((r) => ({
      memberId: r.memberId,
      output: r.output,
    }));
    const votes = new Map<string, string>(); // voterId → candidateMemberId
    const voteResults = await Promise.all(
      members.map((m) =>
        ctx.limit(async () => {
          const others = proposals.filter((p) => p.memberId !== m.id);
          if (others.length === 0) return null;
          const result = await runMember(
            ctx,
            m,
            buildVotePrompt(problem, others),
          );
          const chosen = parseVote(result.output, others);
          if (chosen) votes.set(m.id, chosen);
          return result;
        }),
      ),
    );

    // Phase 3: tally votes.
    const tallies = new Map<string, number>(); // candidateMemberId → total weight
    for (const m of members) {
      const candidate = votes.get(m.id);
      if (!candidate) continue;
      tallies.set(candidate, (tallies.get(candidate) ?? 0) + m.weight);
    }

    // Pick the winner (highest tally; ties broken by quality scorer).
    let winnerMemberId: string | undefined;
    let winnerTally = -1;
    for (const [candidateId, tally] of tallies) {
      if (tally > winnerTally) {
        winnerTally = tally;
        winnerMemberId = candidateId;
      } else if (tally === winnerTally) {
        // Tie — use quality scorer.
        const a = proposals.find((p) => p.memberId === candidateId)!;
        const b = proposals.find((p) => p.memberId === winnerMemberId)!;
        const scoreA = (await ctx.qualityScorer.score(a.output, problem)).overall;
        const scoreB = (await ctx.qualityScorer.score(b.output, problem)).overall;
        if (scoreA > scoreB) {
          winnerMemberId = candidateId;
        }
      }
    }

    if (!winnerMemberId) {
      // No votes cast — fall back to best_of_n on proposals.
      const fallback = await ctx.consensusEngine.reach(
        proposals.map((p) => ({
          memberId: p.memberId,
          output: p.output,
          weight: members.find((m) => m.id === p.memberId)?.weight ?? 1,
        })),
        'best_of_n',
      );
      const contributions = proposalResults.map((r, i) => {
        const member = members[i]!;
        const agreement = fallback.disagreements.includes(member.id) ? 0.3 : 1.0;
        return toContribution(member, r, agreement);
      });
      return buildTeamResult(
        ctx,
        contributions,
        fallback.consensus,
        fallback.confidence,
        fallback.disagreements,
        1,
      );
    }

    const winnerProposal = proposals.find((p) => p.memberId === winnerMemberId)!;
    const totalWeight = [...votes.keys()].reduce(
      (s, voterId) => s + (members.find((m) => m.id === voterId)?.weight ?? 1),
      0,
    );
    const confidence = totalWeight > 0 ? winnerTally / totalWeight : 0;
    const disagreements = proposals
      .filter((p) => p.memberId !== winnerMemberId)
      .map((p) => p.memberId);

    // Build contributions: each member's proposal + their vote.
    const contributions = proposalResults.map((r, i) => {
      const member = members[i]!;
      const agreement = votes.get(member.id) === winnerMemberId ? 1.0 : 0.3;
      return toContribution(member, r, agreement);
    });
    // Add voting-phase metrics to the contributors who voted.
    for (let i = 0; i < voteResults.length; i++) {
      const vr = voteResults[i];
      if (!vr) continue;
      const c = contributions[i]!;
      c.costUsd += vr.costUsd;
      c.tokensUsed += vr.tokensUsed;
      c.durationMs += vr.durationMs;
    }

    if (confidence >= 0.5) {
      ctx.emit('consensus:reached', {
        teamName: ctx.config.name,
        consensus: winnerProposal.output,
        confidence,
      });
    } else {
      ctx.emit('consensus:failed', {
        teamName: ctx.config.name,
        reason: `Low vote confidence (${confidence.toFixed(2)})`,
      });
    }

    return buildTeamResult(
      ctx,
      contributions,
      winnerProposal.output,
      confidence,
      disagreements,
      1,
    );
  }
}

/**
 * Build the prompt for the proposal phase.
 */
function buildProposalPrompt(problem: string, context?: string): string {
  const lines: string[] = [];
  if (context) {
    lines.push(context);
    lines.push('');
  }
  lines.push(`Problem: ${problem}`);
  lines.push('');
  lines.push('Propose your solution. Be specific and justify your reasoning.');
  return lines.join('\n');
}

/**
 * Build the prompt for the voting phase.
 */
function buildVotePrompt(
  problem: string,
  candidates: Array<{ memberId: string; output: string }>,
): string {
  const lines: string[] = [];
  lines.push(`Problem: ${problem}`);
  lines.push('');
  lines.push('Below are candidate solutions proposed by other team members:');
  candidates.forEach((c, i) => {
    lines.push(`--- Candidate ${i + 1} (id: ${c.memberId}) ---`);
    lines.push(c.output);
  });
  lines.push('');
  lines.push('Pick the BEST candidate (you cannot vote for yourself).');
  lines.push('Respond with EXACTLY one line in the format:');
  lines.push('VOTE: <candidate id>');
  return lines.join('\n');
}

/**
 * Parse a vote from the member's response.
 */
function parseVote(
  text: string,
  candidates: Array<{ memberId: string }>,
): string | undefined {
  if (!text) return undefined;
  // Look for "VOTE: <id>" pattern first.
  const match = /VOTE:\s*([^\s\n]+)/i.exec(text);
  if (match && match[1]) {
    const id = match[1].trim();
    if (candidates.some((c) => c.memberId === id)) return id;
  }
  // Fallback: look for any candidate id in the text.
  for (const c of candidates) {
    if (text.includes(c.memberId)) return c.memberId;
  }
  return undefined;
}

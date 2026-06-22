/**
 * @file SwarmStrategy.ts
 * @description Particle Swarm Optimization strategy. Each member is a
 * "particle" with a candidate solution (its "position"). Iterate N times:
 *   1. Each particle refines its solution based on:
 *      - personal best (cognitive component),
 *      - global best (social component).
 *   2. Update personal best if the new solution scores higher.
 *   3. Update global best if any particle's new personal best beats it.
 * Returns the global best after N iterations.
 *
 * Scoring uses the {@link QualityScorer}.
 *
 * @packageDocumentation
 */

import type { SwarmParticle, TeamResult } from '../types.js';
import type { StrategyContext, StrategyImpl, MemberRunResult } from './types.js';
import { buildTeamResult, runMember, toContribution } from './types.js';

/**
 * Swarm execution strategy: particle swarm optimization across N iterations.
 *
 * @example
 * ```ts
 * const strategy = new SwarmStrategy();
 * const result = await strategy.execute(ctx, 'Find the optimal sorting algorithm for nearly-sorted data.');
 * // 8 particles, 5 iterations; each refines its candidate
 * ```
 */
export class SwarmStrategy implements StrategyImpl {
  readonly name = 'swarm' as const;

  async execute(
    ctx: StrategyContext,
    problem: string,
    context?: string,
  ): Promise<TeamResult> {
    const members = ctx.members;
    const iterations = Math.max(1, ctx.config.rounds ?? 5);
    const particles = new Map<string, SwarmParticle>();
    const memberMetrics = new Map<
      string,
      { costUsd: number; tokensUsed: number; durationMs: number; lastOutput: string }
    >();
    for (const m of members) {
      memberMetrics.set(m.id, { costUsd: 0, tokensUsed: 0, durationMs: 0, lastOutput: '' });
    }

    // Initialize: each particle generates an initial candidate.
    const initResults = await Promise.all(
      members.map((m) =>
        ctx.limit(() =>
          runMember(ctx, m, buildInitPrompt(problem, context)),
        ),
      ),
    );

    let globalBest = '';
    let globalBestScore = -1;
    let globalBestMemberId: string | undefined;

    for (let i = 0; i < members.length; i++) {
      const member = members[i]!;
      const result = initResults[i]!;
      accumulateMetrics(memberMetrics, member.id, result);
      const output = result.error ? '' : result.output;
      memberMetrics.get(member.id)!.lastOutput = output;
      const score = output.trim().length > 0
        ? (await ctx.qualityScorer.score(output, problem)).overall
        : 0;
      const particle: SwarmParticle = {
        id: member.id,
        position: output,
        velocity: 'initial',
        personalBest: output,
        personalBestScore: score,
      };
      particles.set(member.id, particle);
      if (score > globalBestScore) {
        globalBestScore = score;
        globalBest = output;
        globalBestMemberId = member.id;
      }
    }

    // Iterate.
    for (let iter = 0; iter < iterations; iter++) {
      ctx.emit('round:start', {
        teamName: ctx.config.name,
        round: iter,
        totalRounds: iterations,
      });

      const refineResults = await Promise.all(
        members.map((m) => {
          const p = particles.get(m.id)!;
          return ctx.limit(async () => {
            const prompt = buildRefinePrompt(problem, context, p, globalBest, globalBestMemberId);
            const result = await runMember(ctx, m, prompt);
            accumulateMetrics(memberMetrics, m.id, result);
            const newOutput = result.error ? p.position : result.output;
            memberMetrics.get(m.id)!.lastOutput = newOutput;
            // Score the new candidate.
            const newScore = newOutput.trim().length > 0
              ? (await ctx.qualityScorer.score(newOutput, problem)).overall
              : 0;
            // Update personal best.
            if (newScore > p.personalBestScore) {
              p.personalBest = newOutput;
              p.personalBestScore = newScore;
            }
            // Velocity = a natural-language description of how the
            // particle moved (toward personal best, global best, or
            // explored).
            p.velocity = describeVelocity(p, newOutput, globalBest);
            p.position = newOutput;
            // Update global best.
            if (newScore > globalBestScore) {
              globalBestScore = newScore;
              globalBest = newOutput;
              globalBestMemberId = m.id;
            }
            return result;
          });
        }),
      );

      ctx.emit('round:complete', {
        teamName: ctx.config.name,
        round: iter,
        outputs: members.map((m) => particles.get(m.id)!.position),
      });

      void refineResults; // metrics already accumulated
    }

    // Build contributions from each particle's personal best.
    const contributions = members.map((m) => {
      const p = particles.get(m.id)!;
      const metrics = memberMetrics.get(m.id)!;
      const isGlobalBest = m.id === globalBestMemberId;
      const agreement = isGlobalBest ? 1.0 : p.personalBestScore / Math.max(0.01, globalBestScore);
      return toContribution(
        m,
        {
          memberId: m.id,
          output: p.personalBest,
          durationMs: metrics.durationMs,
          costUsd: metrics.costUsd,
          tokensUsed: metrics.tokensUsed,
        },
        agreement,
      );
    });

    const disagreements = members
      .filter((m) => m.id !== globalBestMemberId)
      .map((m) => m.id);

    if (globalBestScore > 0) {
      ctx.emit('consensus:reached', {
        teamName: ctx.config.name,
        consensus: globalBest,
        confidence: globalBestScore,
      });
    } else {
      ctx.emit('consensus:failed', {
        teamName: ctx.config.name,
        reason: 'No valid candidate found after swarm iterations',
      });
    }

    return buildTeamResult(
      ctx,
      contributions,
      globalBest,
      globalBestScore,
      disagreements,
      iterations,
    );
  }
}

/**
 * Add a member's run result to the accumulated metrics map.
 */
function accumulateMetrics(
  map: Map<string, { costUsd: number; tokensUsed: number; durationMs: number; lastOutput: string }>,
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
 * Build the initialization prompt for a particle.
 */
function buildInitPrompt(problem: string, context?: string): string {
  const lines: string[] = [];
  lines.push('You are a particle in a swarm optimization search.');
  lines.push(`Problem: ${problem}`);
  if (context) {
    lines.push('');
    lines.push('Additional context:');
    lines.push(context);
  }
  lines.push('');
  lines.push('Propose an initial candidate solution. Be specific.');
  return lines.join('\n');
}

/**
 * Build the refinement prompt for a particle. Includes the particle's
 * personal best and the global best as guidance.
 */
function buildRefinePrompt(
  problem: string,
  context: string | undefined,
  particle: SwarmParticle,
  globalBest: string,
  globalBestMemberId: string | undefined,
): string {
  const lines: string[] = [];
  lines.push('You are a particle in a swarm optimization search.');
  lines.push(`Problem: ${problem}`);
  if (context) {
    lines.push('');
    lines.push('Additional context:');
    lines.push(context);
  }
  lines.push('');
  lines.push('=== Your personal best so far ===');
  lines.push(particle.personalBest || '(none yet)');
  lines.push(`(score: ${particle.personalBestScore.toFixed(2)})`);
  lines.push('');
  lines.push('=== Global best so far ===');
  if (globalBestMemberId && globalBestMemberId !== particle.id) {
    lines.push(globalBest || '(none yet)');
  } else {
    lines.push('(your current position is the global best — explore alternatives to escape local optima)');
  }
  lines.push('');
  lines.push('Refine your candidate solution. Consider your personal best and the global best.');
  lines.push('If your personal best is the global best, try exploring a different region.');
  lines.push('Otherwise, move toward the global best while preserving your unique strengths.');
  lines.push('');
  lines.push('Provide your refined candidate solution.');
  return lines.join('\n');
}

/**
 * Describe the particle's "velocity" (direction of movement) in natural
 * language, based on how the new position differs from the personal
 * best and global best.
 */
function describeVelocity(
  particle: SwarmParticle,
  newPosition: string,
  globalBest: string,
): string {
  if (newPosition === particle.personalBest) return 'stayed at personal best';
  if (newPosition === globalBest) return 'moved to global best';
  if (newPosition.length > particle.personalBest.length) return 'expanded exploration';
  if (newPosition.length < particle.personalBest.length) return 'contracted refinement';
  return 'explored new region';
}

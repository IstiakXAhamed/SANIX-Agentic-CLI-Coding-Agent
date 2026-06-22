/**
 * @file HierarchicalStrategy.ts
 * @description Coordinator decomposes the problem into sub-tasks,
 * assigns each sub-task to a worker, then synthesizes the worker
 * outputs into a final answer.
 *
 * Phases:
 *   1. **Decompose** — the coordinator member generates a list of
 *      sub-tasks (JSON array of strings).
 *   2. **Assign** — each sub-task is assigned to a worker (round-robin
 *      across workers, or to the worker whose persona best matches the
 *      sub-task — currently round-robin).
 *   3. **Execute** — workers run their sub-tasks in parallel (subject
 *      to `maxConcurrent`).
 *   4. **Synthesize** — the coordinator (or a designated synthesizer
 *      member) combines the worker outputs into the final answer.
 *
 * @packageDocumentation
 */

import type { TeamResult } from '../types.js';
import type { StrategyContext, StrategyImpl, MemberRunResult } from './types.js';
import { buildTeamResult, runMember, toContribution } from './types.js';

/**
 * Hierarchical execution strategy: coordinator decomposes, workers
 * execute, coordinator synthesizes.
 *
 * @example
 * ```ts
 * const strategy = new HierarchicalStrategy();
 * const result = await strategy.execute(ctx, 'Build a CRUD app with auth.');
 * // coordinator splits into: schema, API, auth, UI; workers handle each
 * ```
 */
export class HierarchicalStrategy implements StrategyImpl {
  readonly name = 'hierarchical' as const;

  async execute(
    ctx: StrategyContext,
    problem: string,
    context?: string,
  ): Promise<TeamResult> {
    const members = ctx.members;
    const coordinatorId = ctx.config.coordinatorId;
    const coordinator = coordinatorId
      ? members.find((m) => m.id === coordinatorId)
      : members.find((m) => m.role === 'coordinator');
    const workers = members.filter((m) => m.id !== coordinator?.id);
    const synthesizer =
      members.find((m) => m.role === 'synthesizer') ?? coordinator ?? members[0]!;

    if (!coordinator) {
      // No coordinator — fall back to parallel.
      const fallback = new (await import('./ParallelStrategy.js')).ParallelStrategy();
      return fallback.execute(ctx, problem, context);
    }

    // Phase 1: decompose.
    const decomposeResult = await runMember(
      ctx,
      coordinator,
      buildDecomposePrompt(problem, context, workers),
    );

    const subTasks = parseSubTasks(decomposeResult.output);
    if (subTasks.length === 0) {
      // Decomposition failed — coordinator answers directly.
      const contribution = toContribution(coordinator, decomposeResult, 1.0);
      const otherContribs = members
        .filter((m) => m.id !== coordinator.id)
        .map((m) =>
          toContribution(m, {
            memberId: m.id,
            output: '',
            durationMs: 0,
            costUsd: 0,
            tokensUsed: 0,
          }, 0),
        );
      ctx.emit('consensus:reached', {
        teamName: ctx.config.name,
        consensus: decomposeResult.output,
        confidence: decomposeResult.error ? 0.3 : 0.7,
      });
      return buildTeamResult(
        ctx,
        [contribution, ...otherContribs],
        decomposeResult.output,
        decomposeResult.error ? 0.3 : 0.7,
        [],
        1,
      );
    }

    // Phase 2: assign (round-robin across workers).
    const assignments: Array<{ worker: typeof workers[number]; subTask: string }> = [];
    if (workers.length === 0) {
      // No workers — coordinator handles all sub-tasks.
      for (const st of subTasks) {
        assignments.push({ worker: coordinator, subTask: st });
      }
    } else {
      for (let i = 0; i < subTasks.length; i++) {
        const worker = workers[i % workers.length]!;
        assignments.push({ worker, subTask: subTasks[i]! });
      }
    }

    // Phase 3: execute sub-tasks in parallel.
    const workerResults = await Promise.all(
      assignments.map((a) =>
        ctx.limit(() =>
          runMember(ctx, a.worker, buildSubTaskPrompt(problem, a.subTask, context)),
        ),
      ),
    );

    // Aggregate worker metrics per-member.
    const workerMetrics = new Map<
      string,
      { costUsd: number; tokensUsed: number; durationMs: number; outputs: string[] }
    >();
    for (const m of members) {
      workerMetrics.set(m.id, { costUsd: 0, tokensUsed: 0, durationMs: 0, outputs: [] });
    }
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i]!;
      const r = workerResults[i]!;
      const metrics = workerMetrics.get(a.worker.id)!;
      metrics.costUsd += r.costUsd;
      metrics.tokensUsed += r.tokensUsed;
      metrics.durationMs += r.durationMs;
      if (!r.error && r.output.trim().length > 0) {
        metrics.outputs.push(`[Sub-task: ${a.subTask}]\n${r.output}`);
      }
    }

    // Phase 4: synthesize.
    const workerOutputs = assignments
      .map((a, i) => ({
        workerId: a.worker.id,
        subTask: a.subTask,
        output: workerResults[i]!.output,
      }))
      .filter((w) => w.output.trim().length > 0);

    let consensus = '';
    let confidence = 0;

    if (workerOutputs.length === 0) {
      // All workers failed — coordinator's decomposition is the answer.
      consensus = decomposeResult.output;
      confidence = 0.3;
    } else if (synthesizer.id === coordinator.id && synthesizer.role === 'coordinator') {
      // Synthesizer is the coordinator — call it again with the worker outputs.
      const synthResult = await runMember(
        ctx,
        synthesizer,
        buildSynthesizePrompt(problem, workerOutputs),
      );
      const metrics = workerMetrics.get(synthesizer.id)!;
      metrics.costUsd += synthResult.costUsd;
      metrics.tokensUsed += synthResult.tokensUsed;
      metrics.durationMs += synthResult.durationMs;
      consensus = synthResult.output || decomposeResult.output;
      confidence = synthResult.error ? 0.5 : 0.9;
    } else {
      // Synthesizer is a different member.
      const synthResult = await runMember(
        ctx,
        synthesizer,
        buildSynthesizePrompt(problem, workerOutputs),
      );
      const metrics = workerMetrics.get(synthesizer.id)!;
      metrics.costUsd += synthResult.costUsd;
      metrics.tokensUsed += synthResult.tokensUsed;
      metrics.durationMs += synthResult.durationMs;
      consensus = synthResult.output || decomposeResult.output;
      confidence = synthResult.error ? 0.5 : 0.9;
    }

    // Build contributions.
    const contributions = members.map((m) => {
      const metrics = workerMetrics.get(m.id)!;
      let output: string;
      if (m.id === coordinator.id && m.id === synthesizer.id) {
        // Coordinator + synthesizer: include both decomposition + synthesis.
        output = `${decomposeResult.output}\n\n---\n\nSynthesis:\n${consensus}`;
      } else if (m.id === coordinator.id) {
        output = decomposeResult.output;
      } else if (m.id === synthesizer.id) {
        output = consensus;
      } else {
        output = metrics.outputs.join('\n\n');
      }
      return toContribution(
        m,
        {
          memberId: m.id,
          output,
          durationMs: metrics.durationMs,
          costUsd: metrics.costUsd,
          tokensUsed: metrics.tokensUsed,
        },
        1.0,
      );
    });

    ctx.emit('consensus:reached', {
      teamName: ctx.config.name,
      consensus,
      confidence,
    });

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
 * Build the decomposition prompt for the coordinator.
 */
function buildDecomposePrompt(
  problem: string,
  context: string | undefined,
  workers: ReadonlyArray<{ id: string; persona: string; role: string }>,
): string {
  const lines: string[] = [];
  lines.push('You are the coordinator of a hierarchical agent team.');
  lines.push(`Problem: ${problem}`);
  if (context) {
    lines.push('');
    lines.push('Additional context:');
    lines.push(context);
  }
  lines.push('');
  lines.push('Available workers:');
  for (const w of workers) {
    lines.push(`  - ${w.id}: ${w.persona} (${w.role})`);
  }
  lines.push('');
  lines.push('Decompose the problem into 2-6 sub-tasks that the workers can handle in parallel.');
  lines.push('Respond with a JSON array of sub-task strings. Example:');
  lines.push('["Design the database schema", "Implement the REST endpoints", "Write unit tests"]');
  return lines.join('\n');
}

/**
 * Build the sub-task prompt for a worker.
 */
function buildSubTaskPrompt(
  problem: string,
  subTask: string,
  context?: string,
): string {
  const lines: string[] = [];
  lines.push(`Parent problem: ${problem}`);
  if (context) {
    lines.push('');
    lines.push('Additional context:');
    lines.push(context);
  }
  lines.push('');
  lines.push(`Your assigned sub-task: ${subTask}`);
  lines.push('');
  lines.push('Provide your solution to this sub-task. Be specific and self-contained.');
  return lines.join('\n');
}

/**
 * Build the synthesis prompt for the synthesizer.
 */
function buildSynthesizePrompt(
  problem: string,
  workerOutputs: Array<{ workerId: string; subTask: string; output: string }>,
): string {
  const lines: string[] = [];
  lines.push('You are the synthesizer of a hierarchical agent team.');
  lines.push(`Problem: ${problem}`);
  lines.push('');
  lines.push('Worker outputs:');
  for (const w of workerOutputs) {
    lines.push(`--- ${w.workerId} (sub-task: ${w.subTask}) ---`);
    lines.push(w.output);
    lines.push('');
  }
  lines.push('Synthesize the worker outputs into a single coherent solution to the original problem.');
  return lines.join('\n');
}

/**
 * Parse the coordinator's decomposition response into a list of sub-tasks.
 */
function parseSubTasks(text: string): string[] {
  if (!text) return [];
  // Try JSON array first.
  const jsonText = extractJsonArray(text);
  if (jsonText) {
    try {
      const raw = JSON.parse(jsonText) as unknown;
      if (Array.isArray(raw)) {
        return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
      }
    } catch {
      // fall through
    }
  }
  // Fallback: split by newlines, strip bullets/numbering.
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*+\d.]+\s+/, '').trim())
    .filter((line) => line.length > 5 && !line.startsWith('You are') && !line.startsWith('Problem:'));
}

/**
 * Extract the first JSON array from a string.
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

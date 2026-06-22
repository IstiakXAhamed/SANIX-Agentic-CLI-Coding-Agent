/**
 * @file agent/Reflector.ts
 * @description Self-critique pass. Per spec §1, runs a lightweight LLM call
 * every N iterations asking "did the last 3 actions move us toward the
 * goal? what should change?".
 *
 * Returns a `ReflectionResult` with `shouldReplan` — the AgentLoop reads
 * this flag to decide whether to invoke the Planner's Phase 2.
 *
 * @packageDocumentation
 */

import type { IProvider, LLMMessage, LLMRequest } from '@sanix/providers';
import type { SanixConfig } from '@sanix/config';
import type { AgentState, ReflectionResult } from './types.js';

/**
 * Options for {@link Reflector.constructor}.
 */
export interface ReflectorOptions {
  /** The provider to use for reflection (typically a cheap/fast model). */
  provider?: IProvider;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Max tokens for the reflection LLM call. Default 1024. */
  maxTokens?: number;
  /** Number of recent actions to include in the critique. Default 3. */
  windowSize?: number;
}

/**
 * Self-critique reflector. Only invoked every N iterations (the AgentLoop
 * checks `shouldRun` before calling `assess`).
 *
 * @example
 * ```ts
 * const reflector = new Reflector(config, { provider: cheapProvider });
 * if (reflector.shouldRun(state.iterationCount, config.agent.reflectEveryN)) {
 *   const reflection = await reflector.assess(state);
 *   if (reflection.shouldReplan) {
 *     state.plan = await planner.replan(state.plan, completedIds, failures);
 *   }
 * }
 * ```
 */
export class Reflector {
  private readonly provider: IProvider | undefined;
  private readonly config: SanixConfig;
  private readonly systemPrompt: string;
  private readonly maxTokens: number;
  private readonly windowSize: number;

  constructor(config: SanixConfig, opts: ReflectorOptions = {}) {
    this.config = config;
    this.provider = opts.provider;
    this.systemPrompt =
      opts.systemPrompt ??
      `You are SANIX's reflector. Critique the agent's recent actions and decide if the plan is still viable.
Return ONLY a JSON object matching this schema:
{
  "critique": string,
  "shouldReplan": boolean,
  "suggestedAdjustments": string[],
  "progressScore": number  // 0..1
}
Be concise. Focus on whether the last few actions moved toward the goal.`;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.windowSize = opts.windowSize ?? 3;
  }

  /**
   * True if the reflector should run at the given iteration. Uses
   * `config.agent.reflectEveryN` (default 3) as the interval.
   *
   * @example
   * ```ts
   * if (reflector.shouldRun(state.iterationCount, 3)) { ... }
   * ```
   */
  shouldRun(iteration: number, everyN?: number): boolean {
    const n = everyN ?? this.config.agent.reflectEveryN;
    return iteration > 0 && iteration % n === 0;
  }

  /**
   * Run the self-critique pass. Calls the LLM with the last `windowSize`
   * actions and the current plan summary. On LLM failure or parse error,
   * returns a no-op `ReflectionResult` (shouldReplan=false, progressScore=0.5).
   *
   * @param state - The current agent state.
   * @returns A validated `ReflectionResult`.
   */
  async assess(state: AgentState): Promise<ReflectionResult> {
    if (!this.provider) {
      return this.localAssess(state);
    }

    const recentActions = state.actions.slice(-this.windowSize);
    const userPrompt = this.buildPrompt(state, recentActions);
    const messages: LLMMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const req: LLMRequest = {
      messages,
      maxTokens: this.maxTokens,
      temperature: 0.1,
      taskType: 'reasoning',
    };

    let response;
    try {
      response = await this.provider.chat(req);
    } catch {
      return this.localAssess(state);
    }

    const jsonText = extractJson(response.content);
    if (!jsonText) return this.localAssess(state);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return this.localAssess(state);
    }

    const result = ReflectionResultSchema.safeParse(parsed);
    if (!result.success) {
      return this.localAssess(state);
    }

    return {
      critique: result.data.critique,
      shouldReplan: result.data.shouldReplan,
      suggestedAdjustments: result.data.suggestedAdjustments,
      progressScore: clamp(result.data.progressScore, 0, 1),
    };
  }

  /**
   * Local (no-LLM) heuristic assessment. Used as a fallback when the
   * provider is unavailable. Examines the recent actions for failure
   * patterns and infers shouldReplan from them.
   */
  private localAssess(state: AgentState): ReflectionResult {
    const recent = state.actions.slice(-this.windowSize);
    if (recent.length === 0) {
      return {
        critique: 'No actions yet to assess.',
        shouldReplan: false,
        suggestedAdjustments: [],
        progressScore: 0.5,
      };
    }
    const failures = recent.filter((a) => a.error);
    const toolCalls = recent.filter((a) => a.decision.type === 'TOOL_CALL');
    const completedTasks = state.worldModel.completedTaskIds.length;
    const totalTasks = state.plan.tasks.length;
    const progressScore = totalTasks > 0 ? completedTasks / totalTasks : 0.5;

    const shouldReplan = failures.length >= 2;
    const adjustments: string[] = [];
    if (failures.length > 0) {
      adjustments.push(`${failures.length} of ${recent.length} recent actions failed; consider switching strategy.`);
    }
    if (toolCalls.length === recent.length && recent.length >= 3) {
      adjustments.push('All recent actions were tool calls; consider a brief reasoning step.');
    }

    return {
      critique: `Local heuristic: ${completedTasks}/${totalTasks} tasks complete, ${failures.length} recent failures.`,
      shouldReplan,
      suggestedAdjustments: adjustments,
      progressScore,
    };
  }

  /**
   * Build the user prompt for the reflection LLM call.
   */
  private buildPrompt(
    state: AgentState,
    recentActions: ReadonlyArray<AgentState['actions'][number]>,
  ): string {
    const lines: string[] = [
      `Goal: ${state.goal}`,
      '',
      'Plan progress:',
      `- Completed: ${state.worldModel.completedTaskIds.length}/${state.plan.tasks.length} tasks`,
      `- Failed: ${state.worldModel.failedTaskIds.length}`,
      '',
      `Last ${recentActions.length} actions:`,
    ];
    for (const a of recentActions) {
      const decision = a.decision;
      let desc: string;
      switch (decision.type) {
        case 'TOOL_CALL':
          desc = `TOOL_CALL ${decision.toolName}(${decision.arguments.slice(0, 80)})`;
          break;
        case 'LLM_COMPLETION':
          desc = `LLM_COMPLETION (${decision.content.length} chars)`;
          break;
        case 'SPAWN_SUBAGENT':
          desc = `SPAWN_SUBAGENT (${decision.subTask.title})`;
          break;
        case 'COMPLETE':
          desc = `COMPLETE (success=${decision.success})`;
          break;
        case 'ABORT':
          desc = `ABORT (${decision.reason})`;
          break;
        case 'ASK_USER':
          desc = `ASK_USER (${decision.question})`;
          break;
        default: {
          // Exhaustive check; the default is unreachable.
          const _exhaustive: never = decision;
          void _exhaustive;
          desc = 'UNKNOWN';
        }
      }
      const status = a.error ? `FAIL: ${a.error}` : 'ok';
      lines.push(`  [iter ${a.iteration}] ${desc} → ${status}`);
    }
    lines.push('', 'Critique these actions. Should the plan be revised?');
    return lines.join('\n');
  }
}

// ─── Internal ───────────────────────────────────────────────────────────────

import { z } from 'zod';

const ReflectionResultSchema = z.object({
  critique: z.string(),
  shouldReplan: z.boolean(),
  suggestedAdjustments: z.array(z.string()),
  progressScore: z.number(),
});

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

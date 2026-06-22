/**
 * @file agent/Planner.ts
 * @description Two-phase task planner per spec §2.
 *
 * Phase 1 — Goal Decomposition: calls the LLM with a structured-output Zod
 * schema (`PlanSchema`) to produce a `Plan` (goal understanding, task graph
 * with dependencies, success criteria, token-budget estimate, recommended
 * provider, parallelizable flag).
 *
 * Phase 2 — Dynamic Replanning: after task failures or user-injected
 * information, re-evaluates the remaining task graph and emits a new `Plan`
 * that respects what's already been completed.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { IProvider, LLMMessage, LLMRequest, LLMResponse } from '@sanix/providers';
import type { SanixConfig } from '@sanix/config';
import type { Plan, TaskNode, TaskType } from './types.js';

// ─── Zod schemas (spec §2) ──────────────────────────────────────────────────

/**
 * Zod schema for a single task in the plan graph. Mirrors spec §2's
 * `TaskSchema`. Used for structured-output LLM calls.
 */
export const TaskSchema = z.object({
  id: z.string().describe('Stable unique task id'),
  title: z.string().describe('Short human-readable task title'),
  description: z.string().describe('Detailed task description'),
  type: z.enum([
    'research',
    'code_write',
    'code_edit',
    'test',
    'shell',
    'review',
    'think',
  ]).describe('Task type'),
  dependencies: z.array(z.string()).describe('Task ids this depends on'),
  tools: z.array(z.string()).describe('Expected tool names needed'),
  tokenBudget: z.number().describe('Token budget for this task'),
  canDelegate: z.boolean().describe('Can a sub-agent handle this?'),
});

/**
 * Zod schema for a complete plan. Mirrors spec §2's `PlanSchema`.
 */
export const PlanSchema = z.object({
  goal: z.string(),
  understanding: z.string().describe("Agent's interpretation of the goal"),
  ambiguities: z.array(z.string()).describe('What is unclear (ask user if critical)'),
  tasks: z.array(TaskSchema).describe('Ordered task graph with dependencies'),
  successCriteria: z.array(z.string()),
  estimatedTokenBudget: z.number(),
  recommendedProvider: z.string().describe('Which LLM suits this task'),
  parallelizable: z.boolean().describe('Can sub-agents run concurrently?'),
});

/** Inferred type from {@link PlanSchema} (mirrors the `Plan` interface in types.ts). */
export type PlanSchemaT = z.infer<typeof PlanSchema>;
/** Inferred type from {@link TaskSchema}. */
export type TaskSchemaT = z.infer<typeof TaskSchema>;

// ─── Planner ────────────────────────────────────────────────────────────────

/**
 * Options for {@link Planner.constructor}.
 */
export interface PlannerOptions {
  /** The provider to use for plan generation (typically a strong reasoning model). */
  provider?: IProvider;
  /** Override the system prompt used for planning. */
  systemPrompt?: string;
  /** Max tokens for the plan-generation LLM call. Default 4096. */
  maxTokens?: number;
}

/**
 * Two-phase task planner.
 *
 * @example
 * ```ts
 * const planner = new Planner(provider, config);
 * const plan = await planner.decompose('Refactor the auth module', { cwd: '/repo' });
 * // ... agent runs some tasks, one fails twice ...
 * const newPlan = await planner.replan(plan, ['t1', 't2'], [{ taskId: 't3', error: 'tests failed' }]);
 * ```
 */
export class Planner {
  private readonly provider: IProvider | undefined;
  private readonly config: SanixConfig;
  private readonly systemPrompt: string;
  private readonly maxTokens: number;

  constructor(config: SanixConfig, opts: PlannerOptions = {}) {
    this.config = config;
    this.provider = opts.provider;
    this.systemPrompt =
      opts.systemPrompt ??
      `You are SANIX's planner. Decompose the user's goal into an ordered task graph.
Return ONLY a JSON object matching this schema:
${JSON.stringify(zodToJsonSchema(PlanSchema), null, 2)}

Rules:
- Tasks must have stable ids (t1, t2, ...).
- dependencies must reference existing task ids.
- Be conservative with token budgets (sum <= estimatedTokenBudget).
- canDelegate=true only for self-contained, parallelizable sub-tasks.`;
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  /**
   * Phase 1 — decompose a goal into a plan. Calls the LLM with the
   * PlanSchema; on parse failure, falls back to a single-task plan that
   * just asks the agent to accomplish the goal directly.
   *
   * @param goal - The high-level user goal.
   * @param context - Run context (cwd, project, ...) — surfaced to the LLM.
   * @returns A validated `Plan`.
   */
  async decompose(
    goal: string,
    context: { cwd?: string; project?: string; availableTools?: string[] } = {},
  ): Promise<Plan> {
    if (!this.provider) {
      return this.fallbackPlan(goal);
    }

    const userPrompt = this.buildDecomposePrompt(goal, context);
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

    let response: LLMResponse;
    try {
      response = await this.provider.chat(req);
    } catch {
      return this.fallbackPlan(goal);
    }

    // Parse the response as JSON, then validate against PlanSchema.
    const jsonText = extractJson(response.content);
    if (!jsonText) return this.fallbackPlan(goal);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return this.fallbackPlan(goal);
    }

    const result = PlanSchema.safeParse(parsed);
    if (!result.success) {
      return this.fallbackPlan(goal);
    }

    return this.normalizePlan(result.data);
  }

  /**
   * Phase 2 — dynamic replanning. Re-evaluates the remaining task graph
   * after some tasks have completed and/or some have failed. Preserves
   * completed tasks; replaces failed ones with new strategies.
   *
   * @param currentPlan - The plan being revised.
   * @param completedTaskIds - Task ids that have completed successfully.
   * @param failures - Failed tasks with their error messages.
   * @returns A new `Plan` (the old one is not mutated).
   */
  async replan(
    currentPlan: Plan,
    completedTaskIds: ReadonlyArray<string>,
    failures: ReadonlyArray<{ taskId: string; error: string }>,
  ): Promise<Plan> {
    if (!this.provider) {
      // Fallback: mark failed tasks as retriable, drop completed ones.
      return this.fallbackReplan(currentPlan, completedTaskIds, failures);
    }

    const completedSet = new Set(completedTaskIds);
    const failureMap = new Map(failures.map((f) => [f.taskId, f.error]));

    const userPrompt = this.buildReplanPrompt(currentPlan, completedTaskIds, failures);
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

    let response: LLMResponse;
    try {
      response = await this.provider.chat(req);
    } catch {
      return this.fallbackReplan(currentPlan, completedTaskIds, failures);
    }

    const jsonText = extractJson(response.content);
    if (!jsonText) return this.fallbackReplan(currentPlan, completedTaskIds, failures);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return this.fallbackReplan(currentPlan, completedTaskIds, failures);
    }

    const result = PlanSchema.safeParse(parsed);
    if (!result.success) {
      return this.fallbackReplan(currentPlan, completedTaskIds, failures);
    }

    // Merge: keep completed tasks from the old plan; replace the rest with
    // the new plan's tasks (renumbered to avoid id collisions).
    const newPlan = this.normalizePlan(result.data);
    const keptTasks = currentPlan.tasks.filter((t) => completedSet.has(t.id));
    const newTasks: TaskNode[] = [];
    const usedIds = new Set(keptTasks.map((t) => t.id));
    for (const t of newPlan.tasks) {
      if (completedSet.has(t.id)) continue; // don't re-add completed
      let id = t.id;
      let i = 1;
      while (usedIds.has(id)) {
        id = `${t.id}_r${i++}`;
      }
      usedIds.add(id);
      newTasks.push({ ...t, id, status: 'pending', attempts: 0 });
    }
    // Preserve failure history on tasks that failed before.
    for (const t of newTasks) {
      if (failureMap.has(t.id)) {
        t.lastError = failureMap.get(t.id);
        t.attempts = 1;
      }
    }

    return {
      ...newPlan,
      goal: currentPlan.goal, // goal never changes on replan
      tasks: [...keptTasks, ...newTasks],
      createdAt: new Date().toISOString(),
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Build the user prompt for Phase 1 (decompose).
   */
  private buildDecomposePrompt(
    goal: string,
    context: { cwd?: string; project?: string; availableTools?: string[] },
  ): string {
    const lines: string[] = [
      `Goal: ${goal}`,
    ];
    if (context.cwd) lines.push(`Working directory: ${context.cwd}`);
    if (context.project) lines.push(`Project: ${context.project}`);
    if (context.availableTools && context.availableTools.length > 0) {
      lines.push(`Available tools: ${context.availableTools.join(', ')}`);
    }
    lines.push('', 'Decompose this goal into a task graph. Return only the JSON plan.');
    return lines.join('\n');
  }

  /**
   * Build the user prompt for Phase 2 (replan).
   */
  private buildReplanPrompt(
    currentPlan: Plan,
    completedTaskIds: ReadonlyArray<string>,
    failures: ReadonlyArray<{ taskId: string; error: string }>,
  ): string {
    const lines: string[] = [
      `Original goal: ${currentPlan.goal}`,
      '',
      'Current plan:',
      JSON.stringify(
        {
          understanding: currentPlan.understanding,
          tasks: currentPlan.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            type: t.type,
            status: t.status,
            dependencies: t.dependencies,
          })),
        },
        null,
        2,
      ),
      '',
      `Completed task ids: ${completedTaskIds.join(', ') || '(none)'}`,
      'Failures:',
      failures.length > 0
        ? failures.map((f) => `  - ${f.taskId}: ${f.error}`).join('\n')
        : '  (none)',
      '',
      'Produce a revised plan. Keep completed tasks. Replace failed tasks with new strategies. Return only the JSON plan.',
    ];
    return lines.join('\n');
  }

  /**
   * Normalize a parsed PlanSchemaT into a full Plan (with TaskNode status
   * fields, createdAt timestamp, etc.).
   */
  private normalizePlan(parsed: PlanSchemaT): Plan {
    const tasks: TaskNode[] = parsed.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      type: t.type as TaskType,
      dependencies: t.dependencies,
      tools: t.tools,
      tokenBudget: t.tokenBudget,
      canDelegate: t.canDelegate,
      status: 'pending' as const,
      attempts: 0,
    }));
    return {
      goal: parsed.goal,
      understanding: parsed.understanding,
      ambiguities: parsed.ambiguities,
      tasks,
      successCriteria: parsed.successCriteria,
      estimatedTokenBudget: parsed.estimatedTokenBudget,
      recommendedProvider: parsed.recommendedProvider,
      parallelizable: parsed.parallelizable,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Fallback plan when the LLM is unavailable or returns garbage: a single
   * 'think' task that just asks the agent to accomplish the goal directly.
   */
  private fallbackPlan(goal: string): Plan {
    return {
      goal,
      understanding: `Direct execution of: ${goal}`,
      ambiguities: [],
      tasks: [
        {
          id: 't1',
          title: `Accomplish: ${goal.slice(0, 80)}`,
          description: goal,
          type: 'think',
          dependencies: [],
          tools: [],
          tokenBudget: this.config.agent.defaultTokenBudget,
          canDelegate: false,
          status: 'pending',
          attempts: 0,
        },
      ],
      successCriteria: ['Goal accomplished to user satisfaction.'],
      estimatedTokenBudget: this.config.agent.defaultTokenBudget,
      recommendedProvider: this.config.providers.default,
      parallelizable: false,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Fallback replan when the LLM is unavailable: drop completed tasks,
   * bump failed task attempt counts (so they get retried with their
   * lastError populated).
   */
  private fallbackReplan(
    currentPlan: Plan,
    completedTaskIds: ReadonlyArray<string>,
    failures: ReadonlyArray<{ taskId: string; error: string }>,
  ): Plan {
    const completedSet = new Set(completedTaskIds);
    const failureMap = new Map(failures.map((f) => [f.taskId, f.error]));
    const tasks: TaskNode[] = currentPlan.tasks
      .filter((t) => !completedSet.has(t.id))
      .map((t) => {
        const err = failureMap.get(t.id);
        return {
          ...t,
          status: 'pending' as const,
          attempts: t.attempts + (err ? 1 : 0),
          lastError: err ?? t.lastError,
        };
      });
    return {
      ...currentPlan,
      tasks,
      createdAt: new Date().toISOString(),
    };
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Extract the first JSON object from a model response. Models sometimes
 * wrap JSON in ``` fences or prefix it with prose; this strips all that.
 *
 * @example
 * ```ts
 * extractJson('Here is the plan:\n```json\n{"goal":"x"}\n```\nThanks!');
 * // => '{"goal":"x"}'
 * ```
 */
export function extractJson(text: string): string | null {
  // Strip ```json ... ``` fences.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  // Find the first { ... } block (greedy, brace-matched).
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

/**
 * Minimal Zod-to-JSON-Schema converter for the planner's system prompt.
 * Avoids pulling in `zod-to-json-schema` as a dependency. Handles only the
 * subset of Zod features used in PlanSchema (object, string, number,
 * boolean, array, enum, describe).
 */
export function zodToJsonSchema(schema: z.ZodSchema<unknown>): Record<string, unknown> {
  // z.ZodSchema doesn't expose its kind via public API; we use the internal
  // `_def` shape (stable across zod 3.x). This is the same approach
  // `zod-to-json-schema` uses internally.
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  return convertDef(def);
}

function convertDef(def: Record<string, unknown>): Record<string, unknown> {
  const typeName = def.typeName as string | undefined;
  switch (typeName) {
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, z.ZodSchema<unknown>>)(); 
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = convertDef(
          (v as unknown as { _def: Record<string, unknown> })._def,
        );
        // All fields are required unless explicitly .optional().
        required.push(k);
      }
      return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      };
    }
    case 'ZodString':
      return { type: 'string', description: def.description ?? '' };
    case 'ZodNumber':
      return { type: 'number', description: def.description ?? '' };
    case 'ZodBoolean':
      return { type: 'boolean', description: def.description ?? '' };
    case 'ZodArray': {
      const element = (def.element as z.ZodSchema<unknown>) ?? null;
      return {
        type: 'array',
        items: element
          ? convertDef((element as unknown as { _def: Record<string, unknown> })._def)
          : {},
        description: def.description ?? '',
      };
    }
    case 'ZodEnum': {
      const values = (def.values as string[]) ?? [];
      return {
        type: 'string',
        enum: values,
        description: def.description ?? '',
      };
    }
    case 'ZodOptional': {
      const inner = (def.innerType as z.ZodSchema<unknown>) ?? null;
      return inner
        ? convertDef((inner as unknown as { _def: Record<string, unknown> })._def)
        : {};
    }
    default:
      return { description: def.description ?? '' };
  }
}

// Re-export nanoid so callers constructing plans by hand don't need a
// separate import.
export { nanoid };

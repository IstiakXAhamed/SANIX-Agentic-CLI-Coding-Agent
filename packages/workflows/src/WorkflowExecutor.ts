/**
 * @file WorkflowExecutor.ts
 * @description The workflow runtime — turns a validated {@link Workflow}
 * into a sequence of side effects (tool calls, agent runs, transforms)
 * with retry, timeout, parallelism, conditional branching, and loop
 * iteration.
 *
 * The executor is an `EventEmitter3` so the CLI / TUI / telemetry can
 * subscribe to lifecycle events without coupling to the executor's
 * internals. Events (all prefixed with `workflow:` or `step:`):
 *
 *   - `workflow:start`  — `{ workflow, inputs }`
 *   - `workflow:complete` — `{ result }`
 *   - `step:start`     — `{ step, ctx }`
 *   - `step:complete`  — `{ step, result, durationMs }`
 *   - `step:failed`    — `{ step, error }`
 *   - `step:skipped`   — `{ step, reason }`
 *   - `error`          — `{ message, cause? }` (executor-level fatal errors)
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import type { ToolRegistry, ToolContext } from '@sanix/core';
import type {
  Workflow,
  WorkflowStep,
  WorkflowValue,
  WorkflowCondition,
  WorkflowContext,
  WorkflowResult,
  StepStatus,
} from './types.js';

// ─── Events ────────────────────────────────────────────────────────────────

/**
 * Event payloads emitted by {@link WorkflowExecutor}. All events are
 * also surfaced via {@link WorkflowContext.emit} to steps that need to
 * forward progress (e.g. for the TUI).
 */
export interface WorkflowExecutorEvents {
  /** Fired once at the start of `execute()`. */
  'workflow:start': { workflow: Workflow; inputs: Record<string, unknown> };
  /** Fired once at the end of `execute()`, regardless of status. */
  'workflow:complete': { result: WorkflowResult };
  /** Fired when a step begins running. */
  'step:start': { step: WorkflowStep; ctx: WorkflowContext };
  /** Fired when a step succeeds. */
  'step:complete': {
    step: WorkflowStep;
    result: unknown;
    durationMs: number;
    ctx: WorkflowContext;
  };
  /** Fired when a step fails (after retries exhausted). */
  'step:failed': { step: WorkflowStep; error: string; ctx: WorkflowContext };
  /** Fired when a step is skipped (e.g. conditional with no match). */
  'step:skipped': { step: WorkflowStep; reason: string; ctx: WorkflowContext };
  /** Fired on executor-level fatal errors (invalid step, panic). */
  error: { message: string; cause?: unknown };
}

// ─── Constructor options ───────────────────────────────────────────────────

/**
 * Factory for an agent run. Used by `type: 'agent'` steps — the
 * workflow executor calls it with a goal string derived from the
 * step's evaluated inputs and stores the resolved value as the step's
 * `result`.
 *
 * The factory can be a thin wrapper around `AgentLoop.run(goal)` or
 * anything else that satisfies the signature.
 */
export type AgentLoopFactory = (goal: string) => Promise<unknown>;

/**
 * Constructor options for {@link WorkflowExecutor}.
 */
export interface WorkflowExecutorOptions {
  /** Tool registry used for `type: 'tool'` steps. Required. */
  toolRegistry: ToolRegistry;
  /**
   * Optional factory for `type: 'agent'` steps. If absent, `agent`
   * steps throw at execution time.
   */
  agentLoopFactory?: AgentLoopFactory;
  /**
   * Default max concurrency for `parallel` blocks (overridable per-step
   * via `parallelism`). Default 4.
   */
  maxConcurrency?: number;
  /**
   * Default {@link ToolContext} passed to `toolRegistry.execute()` for
   * every `tool` step. If absent, a minimal context is synthesized
   * with `cwd: process.cwd()`, an empty config, and no permissions.
   * Individual steps may override fields via the `inputs.$ctx` map
   * (only `cwd`, `metadata`, `project` are overridable for safety).
   */
  toolContext?: Partial<ToolContext>;
}

// ─── Executor ──────────────────────────────────────────────────────────────

/**
 * Executes a validated {@link Workflow}. Single-instance — construct
 * once, run many workflows. The executor is stateless between runs
 * (each `execute()` call creates a fresh {@link WorkflowContext}).
 *
 * @example
 * ```ts
 * import { WorkflowExecutor } from '@sanix/workflows';
 * import { ToolRegistry } from '@sanix/core';
 * import { allTools } from '@sanix/tools';
 *
 * const registry = new ToolRegistry();
 * for (const t of allTools()) registry.register(t);
 *
 * const executor = new WorkflowExecutor({
 *   toolRegistry: registry,
 *   agentLoopFactory: async (goal) => `goal: ${goal}`,
 * });
 *
 * executor.on('step:start', ({ step }) => console.log(`▶ ${step.name}`));
 * executor.on('step:complete', ({ step, durationMs }) =>
 *   console.log(`✓ ${step.name} (${durationMs}ms)`),
 * );
 *
 * const result = await executor.execute(workflow, { filename: 'src/app.ts' });
 * console.log(result.status, result.outputs);
 * ```
 */
export class WorkflowExecutor extends EventEmitter<WorkflowExecutorEvents> {
  private readonly toolRegistry: ToolRegistry;
  private readonly agentLoopFactory: AgentLoopFactory | undefined;
  private readonly maxConcurrency: number;
  private readonly defaultToolContext: Partial<ToolContext>;

  constructor(opts: WorkflowExecutorOptions) {
    super();
    this.toolRegistry = opts.toolRegistry;
    this.agentLoopFactory = opts.agentLoopFactory;
    this.maxConcurrency = opts.maxConcurrency ?? 4;
    this.defaultToolContext = opts.toolContext ?? {};
  }

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Execute a workflow end-to-end.
   *
   * @param workflow - A validated {@link Workflow} object.
   * @param inputs - Input values (must include all `required: true`
   *   inputs; defaults are applied for the rest).
   * @returns The final {@link WorkflowResult} with status, outputs,
   *   per-step summary, and total duration.
   *
   * @example
   * ```ts
   * const result = await executor.execute(wf, { file: 'src/app.ts' });
   * if (result.status === 'success') console.log(result.outputs);
   * ```
   */
  async execute(
    workflow: Workflow,
    inputs: Record<string, unknown>,
  ): Promise<WorkflowResult> {
    const resolvedInputs = this.resolveInputs(workflow, inputs);
    const ctx: WorkflowContext = {
      inputs: resolvedInputs,
      steps: new Map(),
      variables: new Map(),
      // Forward context-level emits to the executor's EventEmitter.
      // Cast through the EventEmitter3 emit signature (which is per-event
      // typed in the generic) — at this layer we accept arbitrary strings.
      emit: (event, payload) => {
        (this.emit as (event: string, ...args: unknown[]) => void)(event, payload);
      },
    };

    // Pre-register all top-level step IDs as pending so step:start
    // listeners can see them.
    for (const step of workflow.steps) {
      ctx.steps.set(step.id, { status: 'pending' });
    }

    const startedAt = Date.now();
    this.emit('workflow:start', { workflow, inputs: resolvedInputs });

    let status: WorkflowResult['status'] = 'success';
    const stepSummary: WorkflowResult['steps'] = [];

    try {
      for (const step of workflow.steps) {
        const before = Date.now();
        try {
          await this.executeStep(step, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const entry = ctx.steps.get(step.id);
          const dur = Date.now() - before;
          stepSummary.push({
            id: step.id,
            name: step.name,
            status: entry?.status ?? 'failed',
            durationMs: dur,
            error: msg,
          });
          if (workflow.onError === 'abort') {
            this.emit('error', { message: `Step '${step.id}' failed: ${msg}`, cause: err });
            status = 'aborted';
            break;
          } else if (workflow.onError === 'rollback') {
            // Run onFailure on all previously-successful steps (best-effort).
            await this.rollback(workflow.steps, step, ctx);
            status = 'failed';
            break;
          }
          // onError === 'continue' (or undefined) — keep going.
          status = 'failed';
          continue;
        }
        const entry = ctx.steps.get(step.id);
        stepSummary.push({
          id: step.id,
          name: step.name,
          status: entry?.status ?? 'success',
          durationMs: (entry?.endedAt ?? Date.now()) - (entry?.startedAt ?? before),
          error: entry?.error,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('error', { message: `Workflow crashed: ${msg}`, cause: err });
      status = 'failed';
    }

    // Evaluate outputs against the final context.
    const outputs: Record<string, unknown> = {};
    for (const out of workflow.outputs) {
      try {
        outputs[out.name] = this.evaluateValue(out.value, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('error', { message: `Failed to evaluate output '${out.name}': ${msg}`, cause: err });
      }
    }

    const result: WorkflowResult = {
      workflowName: workflow.name,
      status,
      outputs,
      steps: stepSummary,
      totalDurationMs: Date.now() - startedAt,
    };

    this.emit('workflow:complete', { result });
    return result;
  }

  /**
   * Execute a single step (recursively handles nested body / branches
   * / onSuccess / onFailure). Stores the result in
   * `ctx.steps.get(step.id)` and returns it.
   *
   * Public so callers can run individual steps (e.g. for testing or
   * interactive stepping in the TUI).
   *
   * @param step - The step to execute.
   * @param ctx - The current workflow context.
   * @returns The step's result value (or `undefined` for `wait`).
   */
  async executeStep(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    const entry: StepStatus = ctx.steps.get(step.id) ?? { status: 'pending' };
    entry.status = 'running';
    entry.startedAt = Date.now();
    ctx.steps.set(step.id, entry);
    this.emit('step:start', { step, ctx });

    let result: unknown;
    try {
      result = await this.runWithRetryAndTimeout(step, ctx);
      entry.status = 'success';
      entry.result = result;
      entry.endedAt = Date.now();
      ctx.steps.set(step.id, entry);
      this.emit('step:complete', { step, result, durationMs: entry.endedAt - entry.startedAt, ctx });

      // Run onSuccess sub-steps.
      if (step.onSuccess && step.onSuccess.length > 0) {
        for (const sub of step.onSuccess) {
          await this.executeStep(sub, ctx);
        }
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.status = 'failed';
      entry.error = msg;
      entry.endedAt = Date.now();
      ctx.steps.set(step.id, entry);
      this.emit('step:failed', { step, error: msg, ctx });

      // Run onFailure sub-steps (best-effort — failures here are logged
      // but don't replace the original error).
      if (step.onFailure && step.onFailure.length > 0) {
        try {
          for (const sub of step.onFailure) {
            await this.executeStep(sub, ctx);
          }
        } catch (subErr) {
          const subMsg = subErr instanceof Error ? subErr.message : String(subErr);
          this.emit('error', { message: `onFailure sub-step of '${step.id}' failed: ${subMsg}`, cause: subErr });
        }
      }
      throw err;
    }
  }

  /**
   * Resolve a {@link WorkflowValue} against the current context.
   *
   * - `literal` → the literal value (returned as-is).
   * - `ref` → a path like `'steps.greet.result.name'` walked against
   *   the context. Missing paths throw with a descriptive message.
   * - `input` → the named input from `ctx.inputs`.
   * - `template` → a string with `${...}` interpolation where each
   *   `${expr}` is evaluated as a path reference (same as `ref`).
   *
   * @example
   * ```ts
   * const val = executor.evaluateValue({ ref: 'steps.build.result.exitCode' }, ctx);
   * const msg = executor.evaluateValue({ template: 'Hello, ${inputs.name}!' }, ctx);
   * ```
   */
  evaluateValue(value: WorkflowValue, ctx: WorkflowContext): unknown {
    if ('literal' in value) return value.literal;
    if ('input' in value) {
      if (!(value.input in ctx.inputs)) {
        throw new Error(`Input '${value.input}' not provided`);
      }
      return ctx.inputs[value.input];
    }
    if ('ref' in value) {
      return this.resolvePath(value.ref, ctx);
    }
    if ('template' in value) {
      return value.template.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
        const v = this.resolvePath(expr.trim(), ctx);
        if (v === undefined || v === null) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
      });
    }
    // Exhaustive — should be unreachable.
    const _exhaustive: never = value;
    throw new Error(`Unknown WorkflowValue variant: ${JSON.stringify(_exhaustive)}`);
  }

  /**
   * Evaluate a {@link WorkflowCondition} to a boolean. Supports all
   * comparison operators (eq/ne/gt/lt/gte/lte/contains/startsWith/
   * endsWith/matches/exists/notExists) and logical combinators
   * (and/or/not).
   *
   * `eq` uses deep equality; `matches` treats `right` as a regex
   * source.
   *
   * @example
   * ```ts
   * const ok = executor.evaluateCondition({
   *   op: 'gte',
   *   left: { ref: 'steps.build.result.exitCode' },
   *   right: { literal: 0 },
   * }, ctx);
   * ```
   */
  evaluateCondition(cond: WorkflowCondition, ctx: WorkflowContext): boolean {
    switch (cond.op) {
      case 'and':
        return (cond.operands ?? []).every((c) => this.evaluateCondition(c, ctx));
      case 'or':
        return (cond.operands ?? []).some((c) => this.evaluateCondition(c, ctx));
      case 'not':
        return !this.evaluateCondition(cond.operand ?? { op: 'exists', left: { literal: undefined } }, ctx);
      case 'exists': {
        try {
          const v = cond.left ? this.evaluateValue(cond.left, ctx) : undefined;
          return v !== undefined && v !== null;
        } catch {
          return false;
        }
      }
      case 'notExists': {
        try {
          const v = cond.left ? this.evaluateValue(cond.left, ctx) : undefined;
          return v === undefined || v === null;
        } catch {
          return true;
        }
      }
      case 'eq':
        return deepEqual(
          cond.left ? this.evaluateValue(cond.left, ctx) : undefined,
          cond.right ? this.evaluateValue(cond.right, ctx) : undefined,
        );
      case 'ne':
        return !deepEqual(
          cond.left ? this.evaluateValue(cond.left, ctx) : undefined,
          cond.right ? this.evaluateValue(cond.right, ctx) : undefined,
        );
      case 'gt':
      case 'lt':
      case 'gte':
      case 'lte': {
        const l = cond.left ? this.evaluateValue(cond.left, ctx) : undefined;
        const r = cond.right ? this.evaluateValue(cond.right, ctx) : undefined;
        if (typeof l !== 'number' || typeof r !== 'number') {
          throw new Error(`Operator '${cond.op}' requires numeric operands (got ${typeof l}, ${typeof r})`);
        }
        switch (cond.op) {
          case 'gt': return l > r;
          case 'lt': return l < r;
          case 'gte': return l >= r;
          case 'lte': return l <= r;
        }
        return false; // unreachable
      }
      case 'contains':
      case 'startsWith':
      case 'endsWith': {
        const l = cond.left ? this.evaluateValue(cond.left, ctx) : undefined;
        const r = cond.right ? this.evaluateValue(cond.right, ctx) : undefined;
        if (typeof l !== 'string' || typeof r !== 'string') {
          // Array `contains` semantics.
          if (Array.isArray(l)) return l.includes(r);
          throw new Error(`Operator '${cond.op}' requires string or array left operand`);
        }
        switch (cond.op) {
          case 'contains': return l.includes(r);
          case 'startsWith': return l.startsWith(r);
          case 'endsWith': return l.endsWith(r);
        }
        return false;
      }
      case 'matches': {
        const l = cond.left ? this.evaluateValue(cond.left, ctx) : undefined;
        const r = cond.right ? this.evaluateValue(cond.right, ctx) : undefined;
        if (typeof l !== 'string' || typeof r !== 'string') {
          throw new Error(`Operator 'matches' requires string operands`);
        }
        return new RegExp(r).test(l);
      }
      default: {
        const _exhaustive: never = cond.op;
        throw new Error(`Unknown condition operator: ${String(_exhaustive)}`);
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Run a step's main body with retry + timeout. The retry/timeout
   * wrappers are applied to ALL step types uniformly (including nested
   * parallel/conditional/loop) — a retry on a `parallel` block re-runs
   * the whole block.
   */
  private async runWithRetryAndTimeout(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    const max = step.retry?.max ?? 0;
    const backoff = step.retry?.backoffMs ?? 0;
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= max) {
      try {
        if (step.timeout) {
          return await this.withTimeout(step, ctx);
        }
        return await this.dispatch(step, ctx);
      } catch (err) {
        lastErr = err;
        attempt++;
        if (attempt > max) break;
        // Exponential backoff: backoff * 2^(attempt-1).
        const wait = backoff * Math.pow(2, attempt - 1);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * Run a step with a hard timeout. Uses `Promise.race` + a never-
   * resolved promise tied to a `setTimeout` — the step's actual
   * promises are not cancelled (Node doesn't support that), but the
   * executor moves on and surfaces the timeout as a failure.
   */
  private withTimeout(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Step '${step.id}' timed out after ${step.timeout}ms`));
      }, step.timeout);
      this.dispatch(step, ctx).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Dispatch a step to its type-specific handler. Each handler returns
   * the step's result (or throws on failure).
   */
  private async dispatch(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    switch (step.type) {
      case 'tool':
        return this.runToolStep(step, ctx);
      case 'agent':
        return this.runAgentStep(step, ctx);
      case 'parallel':
        return this.runParallelStep(step, ctx);
      case 'conditional':
        return this.runConditionalStep(step, ctx);
      case 'loop':
        return this.runLoopStep(step, ctx);
      case 'transform':
        return this.runTransformStep(step, ctx);
      case 'wait':
        return this.runWaitStep(step, ctx);
      default: {
        const _exhaustive: never = step.type;
        throw new Error(`Unknown step type: ${String(_exhaustive)}`);
      }
    }
  }

  /**
   * `type: 'tool'` — evaluate inputs, call `toolRegistry.execute()`,
   * return the tool's `output` (or throw on `success: false`).
   */
  private async runToolStep(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    if (!step.tool) throw new Error(`Step '${step.id}' is type 'tool' but has no 'tool' field`);
    const evaluated = this.evaluateInputs(step.inputs, ctx);
    const toolCtx = this.buildToolContext(evaluated);
    const result = await this.toolRegistry.execute(step.tool, evaluated, toolCtx);
    if (!result.success) {
      throw new Error(result.error ?? `Tool '${step.tool}' returned success=false`);
    }
    return result.output;
  }

  /**
   * `type: 'agent'` — derive a goal string from the step's inputs
   * (each input rendered as `key: value`), call `agentLoopFactory`,
   * return its result.
   */
  private async runAgentStep(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    if (!this.agentLoopFactory) {
      throw new Error(`Step '${step.id}' is type 'agent' but no agentLoopFactory was provided`);
    }
    const evaluated = this.evaluateInputs(step.inputs, ctx);
    const goal = this.buildGoalFromInputs(evaluated, step);
    return this.agentLoopFactory(goal);
  }

  /**
   * `type: 'parallel'` — run all `body` steps concurrently with a
   * concurrency limit (default `maxConcurrency` from the executor;
   * overridable per-step via `parallelism`).
   *
   * Returns an object mapping each child step's `id` → `result`.
   */
  private async runParallelStep(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    const body = step.body ?? [];
    const limit = step.parallelism ?? this.maxConcurrency;
    const results: Record<string, unknown> = {};
    const queue = [...body];
    const workers: Promise<void>[] = [];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) return;
        const r = await this.executeStep(next, ctx);
        results[next.id] = r;
      }
    };
    for (let i = 0; i < Math.min(limit, body.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  /**
   * `type: 'conditional'` — evaluate each branch's `when` in order;
   * run the first matching branch's `then` steps. If no branch
   * matches, the step is skipped (returns `undefined`).
   */
  private async runConditionalStep(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    const branches = step.branches ?? [];
    // Top-level `condition` (legacy / shorthand) — if present and false, skip.
    if (step.condition && !this.evaluateCondition(step.condition, ctx)) {
      this.emit('step:skipped', { step, reason: 'top-level condition false', ctx });
      return undefined;
    }
    for (const branch of branches) {
      if (this.evaluateCondition(branch.when, ctx)) {
        const results: Record<string, unknown> = {};
        for (const sub of branch.then) {
          results[sub.id] = await this.executeStep(sub, ctx);
        }
        return results;
      }
    }
    this.emit('step:skipped', { step, reason: 'no branch matched', ctx });
    return undefined;
  }

  /**
   * `type: 'loop'` — evaluate `forEach` (must be an array), then run
   * `body` once per item. The current item is exposed to body steps
   * via `ctx.variables.get('<step.id>.item')` and via the special
   * `${vars.<step.id>.item}` ref.
   *
   * Returns an array of body-result objects (one per iteration).
   */
  private async runLoopStep(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    if (!step.forEach) throw new Error(`Step '${step.id}' is type 'loop' but has no 'forEach'`);
    const items = this.evaluateValue(step.forEach, ctx);
    if (!Array.isArray(items)) {
      throw new Error(
        `Step '${step.id}' forEach must evaluate to an array (got ${typeof items})`,
      );
    }
    const body = step.body ?? [];
    const results: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      ctx.variables.set(`${step.id}.item`, items[i]);
      ctx.variables.set(`${step.id}.index`, i);
      const iterResults: Record<string, unknown> = {};
      for (const sub of body) {
        iterResults[sub.id] = await this.executeStep(sub, ctx);
      }
      results.push(iterResults);
    }
    return results;
  }

  /**
   * `type: 'transform'` — evaluate a JS expression in a sandboxed
   * `new Function()` scope. The expression has access to:
   *   - `inputs` — the workflow's input map
   *   - `steps` — a plain object view of `ctx.steps` (each entry is
   *     `{ status, result, error }`)
   *   - `vars` — `ctx.variables` as a plain object
   *
   * Never uses `eval()` — the expression is wrapped as `return (expr);`
   * and called with explicit args.
   */
  private async runTransformStep(step: WorkflowStep, ctx: WorkflowContext): Promise<unknown> {
    if (!step.transform) throw new Error(`Step '${step.id}' is type 'transform' but has no 'transform'`);
    const inputs = ctx.inputs;
    const stepsObj: Record<string, { status: string; result?: unknown; error?: string }> = {};
    for (const [k, v] of ctx.steps) {
      stepsObj[k] = { status: v.status, result: v.result, error: v.error };
    }
    const varsObj: Record<string, unknown> = {};
    for (const [k, v] of ctx.variables) {
      varsObj[k] = v;
    }
    // Wrap in parens so both expression (`a + b`) and arrow bodies
    // (`x => x + 1`) work. Strict mode + no global `this` access.
    const fn = new Function(
      'inputs', 'steps', 'vars',
      `"use strict";\nreturn (${step.transform});`,
    ) as (i: unknown, s: unknown, v: unknown) => unknown;
    try {
      return fn(inputs, stepsObj, varsObj);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Transform expression failed in step '${step.id}': ${msg}`);
    }
  }

  /**
   * `type: 'wait'` — sleep for `waitMs` milliseconds. Returns `undefined`.
   */
  private async runWaitStep(step: WorkflowStep, _ctx: WorkflowContext): Promise<unknown> {
    const ms = step.waitMs ?? 0;
    if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms));
    return undefined;
  }

  /**
   * Evaluate every entry in a step's `inputs` map against the context.
   * Returns a plain object suitable for passing to a tool or agent.
   */
  private evaluateInputs(
    inputs: Record<string, WorkflowValue> | undefined,
    ctx: WorkflowContext,
  ): Record<string, unknown> {
    if (!inputs) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inputs)) {
      out[k] = this.evaluateValue(v, ctx);
    }
    return out;
  }

  /**
   * Walk a dotted path against the context. Supported root namespaces:
   *   - `steps.<id>.result`           — a step's result
   *   - `steps.<id>.status`           — a step's lifecycle status
   *   - `steps.<id>.error`            — a step's error message
   *   - `inputs.<name>`               — a workflow input
   *   - `vars.<key>`                  — a context variable (set by loops)
   *
   * Throws a clear error if any segment is missing — including when a
   * step references itself (cycle) or references a step that hasn't
   * run yet (forward reference).
   */
  private resolvePath(ref: string, ctx: WorkflowContext): unknown {
    const parts = ref.split('.').map((p) => p.trim());
    if (parts.length === 0) throw new Error(`Empty ref path: '${ref}'`);
    const [root, ...rest] = parts;
    if (root === 'steps') {
      const stepId = rest.shift();
      if (!stepId) throw new Error(`Ref '${ref}' is missing step id`);
      const entry = ctx.steps.get(stepId);
      if (!entry) {
        throw new Error(
          `Ref '${ref}' references unknown step '${stepId}' — ` +
          `available: ${[...ctx.steps.keys()].join(', ') || '(none)'}`,
        );
      }
      // Cycle / forward-reference guard.
      if (entry.status === 'pending' || entry.status === 'running') {
        throw new Error(
          `Ref '${ref}' references step '${stepId}' which is still ` +
          `${entry.status} — circular or forward references are not allowed`,
        );
      }
      const field = rest.shift();
      // No field → return the step's result.
      if (!field) return entry.result;
      // `status` / `error` are special non-result fields.
      if (field === 'status' && rest.length === 0) return entry.status;
      if (field === 'error' && rest.length === 0) return entry.error;
      // `result` is an optional prefix — `steps.<id>.result.foo.bar`
      // is equivalent to `steps.<id>.foo.bar` (both walk into the
      // step's result). Bare `steps.<id>.result` returns the whole
      // result object.
      let cur: unknown;
      let segments: string[];
      if (field === 'result') {
        cur = entry.result;
        segments = rest;
      } else {
        // Shorthand: `steps.<id>.foo` means `steps.<id>.result.foo`.
        cur = entry.result;
        segments = [field, ...rest];
      }
      for (const seg of segments) {
        if (cur === null || cur === undefined) {
          throw new Error(`Ref '${ref}' cannot read '.${seg}' of ${cur}`);
        }
        if (Array.isArray(cur)) {
          const idx = Number(seg);
          cur = Number.isInteger(idx) ? cur[idx] : (cur as unknown as Record<string, unknown>)[seg];
        } else if (typeof cur === 'object') {
          cur = (cur as Record<string, unknown>)[seg];
        } else {
          throw new Error(`Ref '${ref}' cannot read '.${seg}' of ${typeof cur}`);
        }
      }
      return cur;
    }
    if (root === 'inputs') {
      const name = rest.shift();
      if (!name) throw new Error(`Ref '${ref}' is missing input name`);
      if (!(name in ctx.inputs)) {
        throw new Error(
          `Ref '${ref}' references unknown input '${name}' — ` +
          `available: ${Object.keys(ctx.inputs).join(', ') || '(none)'}`,
        );
      }
      let cur: unknown = ctx.inputs[name];
      for (const seg of rest) {
        if (cur === null || cur === undefined) {
          throw new Error(`Ref '${ref}' cannot read '.${seg}' of ${cur}`);
        }
        if (Array.isArray(cur)) {
          const idx = Number(seg);
          cur = Number.isInteger(idx) ? cur[idx] : (cur as unknown as Record<string, unknown>)[seg];
        } else if (typeof cur === 'object') {
          cur = (cur as Record<string, unknown>)[seg];
        } else {
          throw new Error(`Ref '${ref}' cannot read '.${seg}' of ${typeof cur}`);
        }
      }
      return cur;
    }
    if (root === 'vars') {
      const key = rest.join('.');
      if (!ctx.variables.has(key)) {
        throw new Error(
          `Ref '${ref}' references unknown variable '${key}' — ` +
          `available: ${[...ctx.variables.keys()].join(', ') || '(none)'}`,
        );
      }
      return ctx.variables.get(key);
    }
    throw new Error(
      `Ref '${ref}' has unknown root '${root}' — ` +
      `supported roots: 'steps', 'inputs', 'vars'`,
    );
  }

  /**
   * Build a {@link ToolContext} for a `tool` step. Merges the
   * executor's default context with any per-step overrides from the
   * `inputs.$ctx` map (only `cwd`, `metadata`, `project` are
   * overridable for safety — permissions and config are NOT).
   */
  private buildToolContext(evaluatedInputs: Record<string, unknown>): ToolContext {
    const override = (evaluatedInputs.$ctx ?? {}) as {
      cwd?: string;
      metadata?: Record<string, unknown>;
      project?: string;
    };
    const base = this.defaultToolContext;
    const ctx: ToolContext = {
      // Required fields — provide sensible defaults if the executor
      // was constructed without a `toolContext`.
      config: (base.config ?? {}) as ToolContext['config'],
      cwd: override.cwd ?? base.cwd ?? process.cwd(),
      allowedPermissions: base.allowedPermissions ?? [],
      // Optional fields — pass through.
      signal: base.signal,
      project: override.project ?? base.project,
      log: base.log,
      metadata: override.metadata ?? base.metadata,
      approvalManager: base.approvalManager,
    };
    // Strip the internal `$ctx` key so the tool doesn't see it.
    if ('$ctx' in evaluatedInputs) delete evaluatedInputs.$ctx;
    return ctx;
  }

  /**
   * Derive a goal string for an `agent` step from its evaluated inputs.
   * Renders each input as `key: value` (objects are JSON-stringified).
   * If the step has an `inputs.goal` field, that's used verbatim.
   */
  private buildGoalFromInputs(
    evaluated: Record<string, unknown>,
    step: WorkflowStep,
  ): string {
    if (typeof evaluated.goal === 'string') return evaluated.goal;
    const lines = Object.entries(evaluated)
      .filter(([k]) => k !== '$ctx')
      .map(([k, v]) => {
        if (v === null || v === undefined) return `${k}: <none>`;
        if (typeof v === 'string') return `${k}: ${v}`;
        try {
          return `${k}: ${JSON.stringify(v)}`;
        } catch {
          return `${k}: <unserializable>`;
        }
      });
    return `${step.name}\n${lines.join('\n')}`;
  }

  /**
   * Resolve workflow inputs against the caller-supplied map. For each
   * declared input:
   *   - If the caller supplied a value, use it (coerced to the
   *     declared type where possible).
   *   - Else if `default` is set, use that.
   *   - Else if `required`, throw.
   *
   * File / directory inputs are validated for existence (best-effort —
   * failure is logged but doesn't block, since the workflow may be
   * creating them).
   */
  private resolveInputs(
    workflow: Workflow,
    callerInputs: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    // Apply `defaults` block first (lowest priority).
    if (workflow.defaults) {
      for (const [k, v] of Object.entries(workflow.defaults)) out[k] = v;
    }
    // Then caller inputs.
    for (const [k, v] of Object.entries(callerInputs)) out[k] = v;
    // Then validate against declared inputs.
    for (const decl of workflow.inputs) {
      if (!(decl.name in out)) {
        if (decl.default !== undefined) {
          out[decl.name] = decl.default;
        } else if (decl.required) {
          throw new Error(
            `Workflow '${workflow.name}' requires input '${decl.name}' ` +
            `(${decl.type}) — ${decl.description}`,
          );
        } else {
          continue; // optional, no default — leave undefined.
        }
      }
      // Type coercion (best-effort).
      out[decl.name] = this.coerceType(out[decl.name], decl.type, decl.name);
    }
    return out;
  }

  /**
   * Coerce a value to the declared type. Strings/numbers/booleans are
   * coerced leniently (e.g. `"3"` → `3` for type `number`); file /
   * directory types are returned as-is.
   */
  private coerceType(value: unknown, type: WorkflowInputType, name: string): unknown {
    if (value === undefined || value === null) return value;
    switch (type) {
      case 'string':
        return typeof value === 'string' ? value : String(value);
      case 'number': {
        if (typeof value === 'number') return value;
        const n = Number(value);
        if (Number.isNaN(n)) throw new Error(`Input '${name}' must be a number (got ${JSON.stringify(value)})`);
        return n;
      }
      case 'boolean':
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
          if (value === 'true') return true;
          if (value === 'false') return false;
        }
        return Boolean(value);
      case 'file':
      case 'directory':
        return value;
      default: {
        const _exhaustive: never = type;
        throw new Error(`Unknown input type: ${String(_exhaustive)}`);
      }
    }
  }

  /**
   * Best-effort rollback — run `onFailure` sub-steps on every
   * previously-successful step before the failure point. Errors are
   * logged but don't propagate.
   */
  private async rollback(
    steps: WorkflowStep[],
    failedStep: WorkflowStep,
    ctx: WorkflowContext,
  ): Promise<void> {
    for (const s of steps) {
      if (s.id === failedStep.id) break;
      const entry = ctx.steps.get(s.id);
      if (entry?.status === 'success' && s.onFailure && s.onFailure.length > 0) {
        try {
          for (const sub of s.onFailure) {
            await this.executeStep(sub, ctx);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.emit('error', { message: `Rollback of '${s.id}' failed: ${msg}`, cause: err });
        }
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Input type alias (avoid importing the full WorkflowInput just for the type tag). */
type WorkflowInputType = 'string' | 'number' | 'boolean' | 'file' | 'directory';

/**
 * Deep equality — used by `eq`/`ne` condition operators. Falls back to
 * `JSON.stringify` comparison for objects/arrays (good enough for
 * workflow values, which are JSON-serializable by construction).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

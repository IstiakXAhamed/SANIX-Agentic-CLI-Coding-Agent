/**
 * @file cli.ts
 * @description High-level workflow helpers the SANIX CLI calls into.
 * These functions wrap the loader + executor with the standard search
 * path (`./.sanix/workflows/` + `~/.sanix/workflows/` + built-ins) so
 * the CLI doesn't need to replicate that logic.
 *
 * @packageDocumentation
 */

import type { ToolRegistry } from '@sanix/core';
import type { Workflow, WorkflowResult } from './types.js';
import { WorkflowLoader } from './WorkflowLoader.js';
import {
  WorkflowExecutor,
  type AgentLoopFactory,
  type WorkflowExecutorOptions,
} from './WorkflowExecutor.js';

// ─── Context ───────────────────────────────────────────────────────────────

/**
 * Runtime context the CLI passes to {@link runWorkflow}. Carries the
 * tool registry (required) and an optional agent factory (required for
 * workflows with `agent` steps).
 */
export interface WorkflowCliContext {
  /** Tool registry used for `tool` steps. */
  toolRegistry: ToolRegistry;
  /** Agent factory used for `agent` steps. Required if the workflow
   * has any `agent` steps. */
  agentLoopFactory?: AgentLoopFactory;
  /** Default parallelism for `parallel` blocks. Default 4. */
  maxConcurrency?: number;
  /** Default tool context (forwarded to the executor). */
  toolContext?: WorkflowExecutorOptions['toolContext'];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Shared loader (stateless — safe to reuse). */
const loader = new WorkflowLoader();

/**
 * List all known workflows (project-local, user-global, and built-in,
 * de-duplicated by name with project-local taking priority).
 *
 * @returns Array of `{ name, description, builtin }`.
 *
 * @example
 * ```ts
 * import { listWorkflows } from '@sanix/workflows';
 * for (const w of await listWorkflows()) {
 *   console.log(`${w.builtin ? '[builtin]' : '[custom]'} ${w.name} — ${w.description}`);
 * }
 * ```
 */
export async function listWorkflows(): Promise<
  Array<{ name: string; description: string; builtin: boolean }>
> {
  return loader.listAll();
}

/**
 * Look up a workflow by name. Searches project-local, user-global,
 * and built-in (in that priority order).
 *
 * @param name - Workflow name.
 * @returns The workflow, or `null` if not found.
 *
 * @example
 * ```ts
 * const wf = await getWorkflow('code-review');
 * if (!wf) { console.error('Unknown workflow'); process.exit(1); }
 * ```
 */
export async function getWorkflow(name: string): Promise<Workflow | null> {
  return loader.find(name);
}

/**
 * Run a workflow by name with the given inputs.
 *
 * Convenience wrapper around `getWorkflow` + `WorkflowExecutor.execute`.
 *
 * @param name - Workflow name.
 * @param inputs - Workflow inputs (must include all `required: true` ones).
 * @param ctx - Runtime context (tool registry + optional agent factory).
 * @returns The {@link WorkflowResult} (status, outputs, per-step summary).
 * @throws {Error} if the workflow is not found.
 *
 * @example
 * ```ts
 * import { runWorkflow } from '@sanix/workflows';
 * const result = await runWorkflow('code-review', { file: 'src/app.ts' }, {
 *   toolRegistry: registry,
 *   agentLoopFactory: async (goal) => myAgent.run(goal),
 * });
 * console.log(result.status, result.outputs);
 * ```
 */
export async function runWorkflow(
  name: string,
  inputs: Record<string, unknown>,
  ctx: WorkflowCliContext,
): Promise<WorkflowResult> {
  const workflow = await loader.find(name);
  if (!workflow) {
    const known = (await loader.listAll()).map((w) => w.name).join(', ');
    throw new Error(
      `Workflow '${name}' not found. Known workflows: ${known || '(none)'}`,
    );
  }
  const executor = new WorkflowExecutor({
    toolRegistry: ctx.toolRegistry,
    agentLoopFactory: ctx.agentLoopFactory,
    maxConcurrency: ctx.maxConcurrency,
    toolContext: ctx.toolContext,
  });
  return executor.execute(workflow, inputs);
}

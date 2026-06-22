/**
 * @file ToolComposer.ts
 * @description Declarative tool composition — chain existing tools
 * (and agent calls) into a new composite tool that can be registered
 * in a `ToolRegistry` like any built-in tool.
 *
 * A {@link CompositeTool} spec is essentially a single-purpose
 * workflow: a name, a description, an ordered list of
 * {@link WorkflowStep}s, default inputs, and an output expression.
 * `ToolComposer.compose()` compiles the spec into a real
 * `SanixTool` whose `execute()` runs the workflow and returns the
 * evaluated output.
 *
 * @example
 * ```ts
 * import { ToolComposer } from '@sanix/workflows';
 * import { ToolRegistry } from '@sanix/core';
 *
 * const composer = new ToolComposer({
 *   toolRegistry: registry,
 *   agentLoopFactory: async (goal) => myAgent.run(goal),
 * });
 *
 * // Register a composite tool that reads a file and summarizes it.
 * composer.registerComposite({
 *   name: 'read_and_summarize',
 *   description: 'Read a file then summarize it via the agent loop.',
 *   inputs: {},
 *   steps: [
 *     { id: 'read', name: 'Read file', type: 'tool', tool: 'read_file',
 *       inputs: { path: { input: 'path' } } },
 *     { id: 'summarize', name: 'Summarize', type: 'agent',
 *       inputs: { goal: { template: 'Summarize: ${steps.read.result}' } } },
 *   ],
 *   output: { ref: 'steps.summarize.result' },
 * }, registry);
 *
 * const result = await registry.execute('read_and_summarize', { path: 'README.md' }, ctx);
 * ```
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SanixTool, ToolRegistry, ToolContext, ToolResult } from '@sanix/core';
import type {
  Workflow,
  WorkflowStep,
  WorkflowValue,
} from './types.js';
import {
  WorkflowExecutor,
  type WorkflowExecutorOptions,
} from './WorkflowExecutor.js';

// ─── Spec ──────────────────────────────────────────────────────────────────

/**
 * A declarative composite tool spec. `steps` form a single-purpose
 * workflow; `inputs` are default values merged with caller-supplied
 * inputs at execute time; `output` is a {@link WorkflowValue}
 * evaluated against the resulting context and returned as the tool's
 * output.
 */
export interface CompositeTool {
  /** Composite tool name (must be unique in the target registry). */
  name: string;
  /** Human-readable description (surfaced to the LLM via tool defs). */
  description: string;
  /** Ordered list of workflow steps. Each step's `id` must be unique. */
  steps: WorkflowStep[];
  /** Default input values (caller inputs override these). */
  inputs?: Record<string, unknown>;
  /** Output expression — evaluated against the final workflow context. */
  output: WorkflowValue;
  /**
   * Optional max tokens for the composite tool's input. Default 8192.
   */
  maxTokensInput?: number;
  /**
   * Optional max tokens for the composite tool's output. Default 8192.
   */
  maxTokensOutput?: number;
}

// ─── Composer ──────────────────────────────────────────────────────────────

/**
 * Constructor options for {@link ToolComposer}. Mirrors
 * {@link WorkflowExecutorOptions} minus the `toolContext` (the
 * composer uses a minimal default — composites shouldn't make
 * assumptions about the runtime context they're called from).
 */
export interface ToolComposerOptions {
  /** Tool registry used by inner `tool` steps. */
  toolRegistry: ToolRegistry;
  /** Optional agent factory for inner `agent` steps. */
  agentLoopFactory?: WorkflowExecutorOptions['agentLoopFactory'];
  /** Default parallelism for inner `parallel` blocks. */
  maxConcurrency?: number;
}

/**
 * Compiles {@link CompositeTool} specs into real `SanixTool` instances
 * that can be registered in a `ToolRegistry`.
 *
 * @example
 * ```ts
 * const composer = new ToolComposer({ toolRegistry: registry });
 * const tool = composer.compose(spec);
 * registry.register(tool);
 * ```
 */
export class ToolComposer {
  private readonly executor: WorkflowExecutor;

  constructor(opts: ToolComposerOptions) {
    this.executor = new WorkflowExecutor({
      toolRegistry: opts.toolRegistry,
      agentLoopFactory: opts.agentLoopFactory,
      maxConcurrency: opts.maxConcurrency,
    });
  }

  /**
   * Compile a composite tool spec into a `SanixTool`. The returned
   * tool runs the spec's steps as a workflow on every `execute()`
   * call and returns the evaluated `output` value.
   *
   * @param spec - The composite tool specification.
   * @returns A `SanixTool` ready for registration.
   *
   * @example
   * ```ts
   * const tool = composer.compose({
   *   name: 'file_summary',
   *   description: 'Read a file and return its first line.',
   *   steps: [
   *     { id: 'read', name: 'Read', type: 'tool', tool: 'read_file',
   *       inputs: { path: { input: 'path' } } },
   *   ],
   *   output: { template: '${steps.read.result}' },
   * });
   * ```
   */
  compose(spec: CompositeTool): SanixTool<unknown, unknown> {
    // Pre-build the workflow template once — clone per execute() call
    // so concurrent invocations don't share state.
    const workflowTemplate: Workflow = {
      name: spec.name,
      description: spec.description,
      version: '1.0.0',
      inputs: [],
      steps: spec.steps,
      outputs: [{ name: 'result', value: spec.output }],
      onError: 'abort',
      defaults: spec.inputs,
    };

    const self = this;
    const tool: SanixTool<unknown, unknown> = {
      name: spec.name,
      description: spec.description,
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.unknown(),
      permissions: [],
      maxTokensInput: spec.maxTokensInput ?? 8192,
      maxTokensOutput: spec.maxTokensOutput ?? 8192,

      async execute(
        input: unknown,
        _ctx: ToolContext,
      ): Promise<ToolResult<unknown>> {
        const start = Date.now();
        // Merge spec defaults with caller inputs (caller wins).
        const callerInputs = (input && typeof input === 'object')
          ? (input as Record<string, unknown>)
          : {};
        const merged = { ...(spec.inputs ?? {}), ...callerInputs };

        try {
          const result = await self.executor.execute(workflowTemplate, merged);
          if (result.status === 'aborted' || result.status === 'failed') {
            const errMsg = result.steps
              .filter((s) => s.error)
              .map((s) => `${s.id}: ${s.error}`)
              .join('; ') || `Composite tool '${spec.name}' failed`;
            return {
              success: false,
              error: errMsg,
              tokensUsed: 0,
              durationMs: Date.now() - start,
            };
          }
          return {
            success: true,
            output: result.outputs.result,
            tokensUsed: 0,
            durationMs: Date.now() - start,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: msg,
            tokensUsed: 0,
            durationMs: Date.now() - start,
          };
        }
      },

      formatForContext(output: unknown): string {
        if (output === undefined) return `<${spec.name}: undefined>`;
        if (typeof output === 'string') return output;
        try {
          return JSON.stringify(output);
        } catch {
          return `<${spec.name}: unserializable>`;
        }
      },
    };
    return tool;
  }

  /**
   * Compose a spec and register it in a `ToolRegistry` in one call.
   *
   * @param spec - The composite tool specification.
   * @param registry - The target registry.
   * @param source - Optional source label (defaults to `'composite'`).
   *
   * @example
   * ```ts
   * composer.registerComposite(spec, registry, 'composite');
   * const result = await registry.execute(spec.name, {...}, ctx);
   * ```
   */
  registerComposite(
    spec: CompositeTool,
    registry: ToolRegistry,
    source = 'composite',
  ): void {
    const tool = this.compose(spec);
    registry.register(tool, { source });
  }
}

// ─── Example composite ─────────────────────────────────────────────────────

/**
 * Example composite tool spec: read a file then ask the agent loop to
 * summarize it. Useful as a reference and for smoke tests.
 *
 * @example
 * ```ts
 * import { ToolComposer, READ_AND_SUMMARIZE_SPEC } from '@sanix/workflows';
 * const composer = new ToolComposer({ toolRegistry, agentLoopFactory });
 * composer.registerComposite(READ_AND_SUMMARIZE_SPEC, toolRegistry);
 * ```
 */
export const READ_AND_SUMMARIZE_SPEC: CompositeTool = {
  name: 'read_and_summarize',
  description:
    'Read a file from disk and produce a concise summary of its contents via the agent loop. Accepts `{ path: string }` and returns the summary string.',
  inputs: {},
  maxTokensInput: 8192,
  maxTokensOutput: 2048,
  steps: [
    {
      id: 'read',
      name: 'Read file',
      type: 'tool',
      tool: 'read_file',
      inputs: {
        path: { input: 'path' },
      },
    },
    {
      id: 'summarize',
      name: 'Summarize',
      type: 'agent',
      inputs: {
        goal: {
          template:
            'Summarize the following file contents in 5 bullet points or fewer.\n\nFile: ${inputs.path}\nContents:\n${steps.read.result}',
        },
      },
    },
  ],
  output: { ref: 'steps.summarize.result' },
};

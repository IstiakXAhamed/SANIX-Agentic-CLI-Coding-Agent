/**
 * @file SandboxTool.ts
 * @description SANIX tool wrapper around the sandbox. Implements the
 * `SanixTool` interface structurally (no hard dep on `@sanix/core`) so it
 * can be registered with any SANIX `ToolRegistry`.
 *
 * @packageDocumentation
 */

import { z, type ZodTypeAny } from 'zod';
import type { ExecutionResult, Isolation, Runtime } from './types.js';
import { SandboxManager } from './SandboxManager.js';

/**
 * Minimal local re-declaration of the SANIX tool contract (mirrors
 * `@sanix/tools` / `@sanix/core`'s `SanixTool`). Re-declared to avoid a
 * hard runtime dependency on `@sanix/tools`.
 */
export interface SanixToolLike {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodTypeAny;
  readonly outputSchema: ZodTypeAny;
  readonly permissions: string[];
  readonly maxTokensInput: number;
  readonly maxTokensOutput: number;
  execute(input: unknown, context: unknown): Promise<ToolResultLike>;
  formatForContext(result: unknown): string;
}

export interface ToolResultLike {
  success: boolean;
  output?: unknown;
  error?: string;
  tokensUsed: number;
  durationMs: number;
}

export interface ToolContextLike {
  cwd: string;
  config?: unknown;
  signal?: AbortSignal;
  requireApproval?: (perm: string, details: unknown) => Promise<boolean>;
  emit?: (event: string, payload: unknown) => void;
}

/**
 * Input schema for the `sandbox_execute` tool.
 */
export const SandboxToolInputSchema = z.object({
  code: z.string().min(1).describe('The code to execute.'),
  runtime: z.enum(['node', 'python', 'deno', 'bun', 'go', 'rust', 'bash', 'custom'])
    .optional().describe('Code runtime. Default: node.'),
  isolation: z.enum(['none', 'process', 'docker', 'firecracker', 'webassembly'])
    .optional().describe('Isolation strategy. Default: docker (or process if unavailable).'),
  image: z.string().optional().describe('Docker image override.'),
  timeoutMs: z.number().int().positive().max(300_000).optional()
    .describe('Wall-clock timeout per execution (ms). Default: 30_000.'),
  memoryLimitMb: z.number().int().positive().optional().describe('Memory limit (MB).'),
  cpuQuota: z.number().int().min(1).max(1024).optional().describe('CPU quota (Docker shares 1-1024).'),
  networkEnabled: z.boolean().optional().describe('Allow outbound network. Default: false.'),
  persistent: z.boolean().optional().describe('Create / reuse a persistent REPL session.'),
  replId: z.string().optional().describe('Existing REPL session id to execute in.'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables.'),
});

/**
 * Output schema for the `sandbox_execute` tool.
 */
export const SandboxToolOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  durationMs: z.number(),
  replId: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
});

/**
 * SandboxExecuteTool constructor options.
 */
export interface SandboxExecuteToolOptions {
  /** Pre-configured SandboxManager to use. If omitted, a default one is created. */
  manager?: SandboxManager;
  /** Default runtime. Default: `'node'`. */
  defaultRuntime?: Runtime;
  /** Default isolation. Default: `'docker'`. */
  defaultIsolation?: Isolation;
  /** Default timeout (ms). Default: 30_000. */
  defaultTimeoutMs?: number;
}

/**
 * SANIX tool that executes arbitrary code in a sandbox. Tool name:
 * `sandbox_execute`. Permissions: `['shell:exec']`.
 *
 * Behavior:
 *   - If `replId` is provided → execute in that existing REPL session.
 *   - Else if `persistent: true` → create a new REPL session and return its id.
 *   - Else → one-shot execution.
 *
 * @example
 * ```ts
 * import { SandboxExecuteTool } from '@sanix/sandbox';
 * import { ToolRegistry } from '@sanix/core';
 *
 * const registry = new ToolRegistry();
 * // (registerStructurally accepts any SanixTool-shaped object)
 * const tool = new SandboxExecuteTool();
 * // ...call tool.execute({ code: 'print(1+1)', runtime: 'python' }, ctx)
 * ```
 */
export class SandboxExecuteTool implements SanixToolLike {
  readonly name = 'sandbox_execute';
  readonly description =
    'Execute arbitrary code in a Docker-isolated (or process-isolated) sandbox. ' +
    'Supports node/python/deno/bun/go/rust/bash runtimes. Pass `persistent: true` ' +
    'to start a REPL session whose state persists across calls (returns a `replId`).';
  readonly inputSchema: ZodTypeAny = SandboxToolInputSchema;
  readonly outputSchema: ZodTypeAny = SandboxToolOutputSchema;
  readonly permissions = ['shell:exec'];
  readonly maxTokensInput = 64_000;
  readonly maxTokensOutput = 64_000;

  private readonly manager: SandboxManager;
  private readonly defaultRuntime: Runtime;
  private readonly defaultIsolation: Isolation;
  private readonly defaultTimeoutMs: number;

  constructor(opts: SandboxExecuteToolOptions = {}) {
    this.manager = opts.manager ?? new SandboxManager();
    this.defaultRuntime = opts.defaultRuntime ?? 'node';
    this.defaultIsolation = opts.defaultIsolation ?? 'docker';
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  async execute(input: unknown, context: unknown): Promise<ToolResultLike> {
    const start = Date.now();
    const parsed = SandboxToolInputSchema.parse(input ?? {});
    const ctx = context as ToolContextLike;

    // Approval gate.
    if (ctx?.requireApproval) {
      const ok = await ctx.requireApproval('shell:exec', { code: parsed.code, runtime: parsed.runtime });
      if (!ok) {
        return {
          success: false,
          error: 'Permission denied: shell:exec',
          tokensUsed: 0,
          durationMs: Date.now() - start,
        };
      }
    }

    try {
      let result: ExecutionResult;
      let replId: string | undefined;

      if (parsed.replId) {
        // Execute in existing REPL.
        const repl = this.manager.listREPLs().find((r) => r.id === parsed.replId);
        if (!repl) {
          return {
            success: false,
            error: `Unknown replId: ${parsed.replId}`,
            tokensUsed: 0,
            durationMs: Date.now() - start,
          };
        }
        result = await repl.execute(parsed.code);
        replId = repl.id;
      } else if (parsed.persistent) {
        // Create new REPL and execute.
        const repl = await this.manager.createREPL({
          runtime: parsed.runtime ?? this.defaultRuntime,
          isolation: parsed.isolation ?? this.defaultIsolation,
          image: parsed.image,
          timeoutMs: parsed.timeoutMs ?? this.defaultTimeoutMs,
          memoryLimitMb: parsed.memoryLimitMb,
          cpuQuota: parsed.cpuQuota,
          networkEnabled: parsed.networkEnabled,
          env: parsed.env,
          persistent: true,
        });
        result = await repl.execute(parsed.code);
        replId = repl.id;
      } else {
        // One-shot.
        result = await this.manager.execute(parsed.code, {
          runtime: parsed.runtime ?? this.defaultRuntime,
          isolation: parsed.isolation ?? this.defaultIsolation,
          image: parsed.image,
          timeoutMs: parsed.timeoutMs ?? this.defaultTimeoutMs,
          memoryLimitMb: parsed.memoryLimitMb,
          cpuQuota: parsed.cpuQuota,
          networkEnabled: parsed.networkEnabled,
          env: parsed.env,
        });
      }

      const out = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        replId,
        artifacts: result.artifacts?.map((a) => a.path),
      };

      return {
        success: result.exitCode === 0,
        output: out,
        tokensUsed: Math.ceil((result.stdout.length + result.stderr.length) / 4),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        tokensUsed: 0,
        durationMs: Date.now() - start,
      };
    }
  }

  formatForContext(result: unknown): string {
    if (typeof result !== 'object' || result === null) return String(result);
    const r = result as { stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; replId?: string };
    const lines: string[] = [];
    if (r.replId) lines.push(`[repl: ${r.replId}]`);
    lines.push(`exit=${r.exitCode ?? '?'} (${r.durationMs ?? 0}ms)`);
    if (r.stdout) lines.push(`stdout:\n${r.stdout.slice(0, 4_000)}`);
    if (r.stderr) lines.push(`stderr:\n${r.stderr.slice(0, 4_000)}`);
    return lines.join('\n');
  }
}

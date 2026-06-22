/**
 * @file tools/interfaces.ts
 * @description Public contracts every SANIX tool implements. Tools live in
 * `@sanix/tools` (filesystem, shell, code, web, memory, mcp) but the
 * registry, validator, and result types live here in `@sanix/core`.
 *
 * A `SanixTool` is a strongly-typed, schema-validated, permission-gated unit
 * of agent capability. The AgentLoop's Executor dispatches `TOOL_CALL`
 * decisions to a `ToolRegistry`, which looks up the tool, validates its
 * input via `ToolValidator`, and invokes `execute()`.
 *
 * @packageDocumentation
 */

import type { z } from 'zod';
import type { SanixConfig } from '@sanix/config';
import type { TokenUsage } from '@sanix/providers';
// Type-only import to avoid a runtime cycle: ApprovalManager imports
// ToolPermission from this file, and ToolContext references ApprovalManager.
// Type-only imports are erased at compile time so no cycle exists at runtime.
import type { ApprovalManager } from '../approval/ApprovalManager.js';

// ─── Tool context ───────────────────────────────────────────────────────────

/**
 * Permissions a tool may require. The `ToolValidator` checks these against
 * `ToolContext.allowedPermissions` (which derives from config.agent.
 * requireApprovalFor and the active profile). Tools that touch the filesystem
 * or shell must declare the matching permission.
 */
export type ToolPermission =
  | 'file_read'
  | 'file_write'
  | 'shell_exec'
  | 'web_request'
  | 'memory_write'
  | 'memory_read'
  | 'subprocess_long'
  | 'mcp_call'
  | 'ask_user';

/**
 * The runtime context handed to every tool `execute()` call. Carries the
 * config, working directory, abort signal, and a permission snapshot so
 * tools can make safe, configurable decisions without re-reading config.
 */
export interface ToolContext {
  /** Fully-resolved SANIX config. */
  config: SanixConfig;
  /** Working directory the tool should resolve relative paths against. */
  cwd: string;
  /** Abort signal — tools MUST respect this for cancellation. */
  signal?: AbortSignal;
  /** Permissions granted for this run (subset of ToolPermission). */
  allowedPermissions: ToolPermission[];
  /** Project identifier (for memory tool scoping). */
  project?: string;
  /** Optional logger the tool may use for diagnostics. */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** Free-form metadata bag for tools to pass context to nested calls. */
  metadata?: Record<string, unknown>;
  /**
   * Optional approval manager. When set, the {@link ToolRegistry} consults
   * it before executing any tool whose permissions intersect the manager's
   * `requireFor` set. If the user denies the request, the call is skipped
   * and a denied `ToolResult` is returned. Opt-in — `undefined` by default.
   */
  approvalManager?: ApprovalManager;
}

// ─── Tool result ────────────────────────────────────────────────────────────

/**
 * Standardized result envelope returned by every tool. The `success` flag is
 * authoritative — tools should NOT throw on expected failures (e.g. file not
 * found); they should return `{ success: false, error }`. Exceptions are
 * reserved for programmer errors (schema mismatches, assertion failures).
 */
export interface ToolResult<TOutput> {
  /** True if the tool accomplished its objective. */
  success: boolean;
  /** The tool's output payload (present on success). */
  output?: TOutput;
  /** Human-readable error message (present on failure). */
  error?: string;
  /** Token accounting for this call (input + output, as relevant). */
  tokensUsed: number;
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
}

// ─── The tool contract ──────────────────────────────────────────────────────

/**
 * The contract every SANIX tool implements. Generic in both input (`TInput`)
 * and output (`TOutput`) so callers get end-to-end type safety.
 *
 * Implementations live in `@sanix/tools` (e.g. `ReadFileTool`,
 * `BashTool`). The registry, validator, and result envelope live in this
 * package so the agent can depend on tool *infrastructure* without pulling
 * in every concrete tool implementation.
 *
 * @example
 * ```ts
 * class EchoTool implements SanixTool<{ msg: string }, { echo: string }> {
 *   name = 'echo';
 *   description = 'Echo a message back.';
 *   inputSchema = z.object({ msg: z.string() });
 *   outputSchema = z.object({ echo: z.string() });
 *   permissions = [];
 *   maxTokensInput = 1024;
 *   maxTokensOutput = 1024;
 *
 *   async execute(input, ctx) {
 *     return { success: true, output: { echo: input.msg }, tokensUsed: 0, durationMs: 0 };
 *   }
 *
 *   formatForContext(output) {
 *     return `echo: ${output.echo}`;
 *   }
 * }
 * ```
 */
export interface SanixTool<TInput = unknown, TOutput = unknown> {
  /** Stable unique tool name (e.g. 'read_file', 'bash'). */
  readonly name: string;
  /** Human-readable description — surfaced to the LLM in the tool definition. */
  readonly description: string;
  /** Zod schema for validating input parsed from the LLM's JSON arguments. */
  readonly inputSchema: z.ZodSchema<TInput>;
  /** Zod schema for validating the tool's own output before returning. */
  readonly outputSchema: z.ZodSchema<TOutput>;
  /** Permissions required to invoke this tool. */
  readonly permissions: ToolPermission[];
  /** Maximum input tokens the tool will accept (advisory; checked by Validator). */
  readonly maxTokensInput: number;
  /** Maximum output tokens the tool will produce (advisory). */
  readonly maxTokensOutput: number;

  /**
   * Execute the tool. MUST NOT throw on expected failures — return a
   * `ToolResult` with `success: false` and an `error` string instead.
   *
   * @param input - Schema-validated input.
   * @param context - Runtime context (cwd, config, permissions, signal).
   */
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;

  /**
   * Render the tool's output as a compact string for inclusion in the LLM's
   * next-turn context. Should be terse — full output is kept in the
   * structured ToolResult for the agent's own audit trail.
   *
   * @param output - The successful output payload.
   */
  formatForContext(output: TOutput): string;
}

/**
 * Convenience alias: a tool with unknown input/output (used by the registry's
 * internal storage where the generic parameters are erased).
 */
export type AnySanixTool = SanixTool<unknown, unknown>;

/**
 * A tool entry in the registry. Carries the tool plus registration metadata
 * (when it was registered, whether it's enabled).
 */
export interface RegisteredTool {
  /** The tool itself. */
  tool: AnySanixTool;
  /** ISO timestamp of registration. */
  registeredAt: string;
  /** When false, the registry refuses to dispatch calls to this tool. */
  enabled: boolean;
  /** Optional source label (e.g. 'builtin', 'mcp:myserver', 'plugin:foo'). */
  source?: string;
}

// ─── Registry events ────────────────────────────────────────────────────────

/**
 * Event payloads emitted by the ToolRegistry's EventEmitter3.
 */
export interface ToolRegistryEvents {
  /** Fired before a tool's execute() is invoked. */
  'tool:before': {
    name: string;
    input: unknown;
    timestamp: string;
  };
  /** Fired after a tool's execute() resolves. */
  'tool:after': {
    name: string;
    result: ToolResult<unknown>;
    durationMs: number;
  };
  /** Fired when a tool throws or returns success: false. */
  'tool:error': {
    name: string;
    error: string;
    input: unknown;
  };
  /** Fired when a tool is registered. */
  'tool:registered': { name: string; source?: string };
  /** Fired when a tool is unregistered. */
  'tool:unregistered': { name: string };
}

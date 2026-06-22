/**
 * @file Shared tool types and helpers for @sanix/tools.
 *
 * These interfaces mirror the canonical `SanixTool` / `ToolContext` /
 * `ToolResult` / `ToolPermission` definitions exported by `@sanix/core`.
 * They are re-declared locally to avoid a hard runtime dependency on
 * `@sanix/core` (which is being built in parallel). At monorepo build time
 * TypeScript structural typing dedupes these with the canonical definitions,
 * so consumers can pass instances of these tools directly into a core
 * `ToolRegistry` that expects the core-declared interface.
 */
import path from 'node:path';
import os from 'node:os';
import { z, type ZodTypeAny } from 'zod';

/**
 * Permission tags attached to every tool. The `ToolContext.requireApproval`
 * callback (when present) consults these tags before allowing the tool to
 * execute privileged actions.
 */
export type ToolPermission =
  | 'filesystem:read'
  | 'filesystem:write'
  | 'shell:exec'
  | 'web:fetch'
  | 'web:search'
  | 'memory:read'
  | 'memory:write'
  | 'subagent:spawn'
  | 'mcp:call';

/**
 * Runtime context handed to every tool execution. The `config` field is
 * typed as `unknown` here to prevent a circular dependency on
 * `@sanix/config`; consumers should narrow it on their end.
 *
 * In addition to the core-defined fields, tools MAY consult the following
 * optional callbacks attached to the context object:
 *   - `memoryStore(item)`        — used by the `remember` tool
 *   - `memoryRecall(query)`      — used by the `recall` tool
 *   - `memoryForget(id)`         — used by the `forget` tool
 *   - `memorySummarize(sessionId)` — used by the `summarize_session` tool
 *
 * They are intentionally not part of the core interface signature (core
 * owns storage) but are read via a narrow `as` cast inside the memory tools.
 */
export interface ToolContext {
  /** Absolute working directory the agent is operating within. */
  cwd: string;
  /** Resolved SANIX config (typed as `unknown` to avoid circular deps). */
  config: unknown;
  /** Optional abort signal propagated from the agent loop. */
  signal?: AbortSignal;
  /**
   * Optional approval hook. Tools call this with their `ToolPermission`
   * tag (and arbitrary details) before performing privileged work; if it
   * returns `false` the tool aborts with a permission-denied error.
   */
  requireApproval?: (perm: ToolPermission, details: unknown) => Promise<boolean>;
  /** Optional event emitter hook for streaming progress / output. */
  emit?: (event: string, payload: unknown) => void;
}

/**
 * Standardized tool execution result.
 */
export interface ToolResult<TOutput> {
  success: boolean;
  output?: TOutput;
  error?: string;
  /** Estimated tokens consumed (char-based: ceil(jsonLen / 4)). */
  tokensUsed: number;
  /** Wall-clock duration of the execution in milliseconds. */
  durationMs: number;
}

/**
 * Contract every SANIX tool satisfies. Mirrors `@sanix/core`'s
 * `SanixTool<TInput, TOutput>` exactly (structurally).
 */
export interface SanixTool<TInput, TOutput> {
  /** Stable tool name used in LLM tool definitions, e.g. `read_file`. */
  readonly name: string;
  /** Human/LLM-readable description. */
  readonly description: string;
  /** Zod schema describing the input shape. */
  readonly inputSchema: ZodTypeAny;
  /** Zod schema describing the output shape. */
  readonly outputSchema: ZodTypeAny;
  /** Permission tags required to run this tool. */
  readonly permissions: ToolPermission[];
  /** Max tokens the tool is willing to accept as input. */
  readonly maxTokensInput: number;
  /** Max tokens the tool is willing to produce as output. */
  readonly maxTokensOutput: number;
  /** Execute the tool. */
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
  /** Render the output as a compact string for prompt injection. */
  formatForContext(result: TOutput): string;
}

/**
 * Estimate the token cost of an arbitrary value by JSON-serializing it
 * and dividing the character length by 4 (a standard heuristic).
 */
export function estimateTokens(value: unknown): number {
  try {
    const json = JSON.stringify(value ?? {});
    return Math.ceil(json.length / 4);
  } catch {
    return 0;
  }
}

/**
 * Build a `ToolResult` for a successful execution, populating the
 * `tokensUsed` and `durationMs` fields automatically.
 */
export function okResult<TOutput>(
  output: TOutput,
  durationMs: number,
): ToolResult<TOutput> {
  return {
    success: true,
    output,
    tokensUsed: estimateTokens(output),
    durationMs,
  };
}

/**
 * Build a `ToolResult` for a failed execution.
 */
export function errResult<TOutput>(
  error: string,
  durationMs: number,
  partialOutput?: TOutput,
): ToolResult<TOutput> {
  return {
    success: false,
    error,
    output: partialOutput,
    tokensUsed: estimateTokens(partialOutput ?? { error }),
    durationMs,
  };
}

/**
 * Ergonomic helper for declaring a tool with full type inference.
 *
 * @example
 * ```ts
 * export const PingTool = defineTool({
 *   name: 'ping',
 *   description: 'Returns pong',
 *   inputSchema: z.object({}).strict(),
 *   outputSchema: z.object({ msg: z.string() }),
 *   permissions: [],
 *   maxTokensInput: 16,
 *   maxTokensOutput: 16,
 *   async execute(_input, _ctx) {
 *     const start = Date.now();
 *     return okResult({ msg: 'pong' }, Date.now() - start);
 *   },
 *   formatForContext(r) { return r.msg; },
 * });
 * ```
 */
export function defineTool<TInput, TOutput>(
  spec: SanixTool<TInput, TOutput>,
): SanixTool<TInput, TOutput> {
  return spec;
}

/**
 * Resolve a possibly-relative path against the tool context's `cwd`.
 * Already-absolute paths and `~`-prefixed paths are returned expanded.
 */
export function resolvePath(input: string, cwd: string): string {
  if (!input) return cwd;
  const home = os.homedir();
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  if (path.isAbsolute(input)) return input;
  return path.resolve(cwd, input);
}

/** Re-export Zod so tool files don't need a separate import line. */
export { z };

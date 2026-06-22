/**
 * @file tools/ToolResult.ts
 * @description Factory helpers and result constructors for the standardized
 * `ToolResult<T>` envelope. Tools typically don't construct results by hand
 * — they call `ok(output, opts?)` or `fail(error, opts?)` so token and
 * duration accounting is consistent.
 *
 * @packageDocumentation
 */

import type { ToolResult } from './interfaces.js';

/**
 * Construct a successful `ToolResult`. `tokensUsed` and `durationMs` default
 * to 0; tools that can measure them (e.g. shell tools via `process.hrtime`)
 * should pass them explicitly.
 *
 * @example
 * ```ts
 * const res = ok({ path: '/tmp/x' });
 * // => { success: true, output: { path: '/tmp/x' }, tokensUsed: 0, durationMs: 0 }
 * ```
 */
export function ok<TOutput>(
  output: TOutput,
  opts: { tokensUsed?: number; durationMs?: number } = {},
): ToolResult<TOutput> {
  return {
    success: true,
    output,
    tokensUsed: opts.tokensUsed ?? 0,
    durationMs: opts.durationMs ?? 0,
  };
}

/**
 * Construct a failed `ToolResult`. The `error` string is surfaced to the LLM
 * in the next turn so the agent can react (retry, switch tool, replan).
 *
 * @example
 * ```ts
 * const res = fail('File not found: /tmp/missing.txt');
 * // => { success: false, error: 'File not found: /tmp/missing.txt', tokensUsed: 0, durationMs: 0 }
 * ```
 */
export function fail<TOutput = never>(
  error: string,
  opts: { tokensUsed?: number; durationMs?: number } = {},
): ToolResult<TOutput> {
  return {
    success: false,
    error,
    tokensUsed: opts.tokensUsed ?? 0,
    durationMs: opts.durationMs ?? 0,
  };
}

/**
 * Wrap an async tool body in standard timing + error handling. The body
 * should return either a value (auto-wrapped via {@link ok}) or a full
 * `ToolResult`. Exceptions are caught and converted to `fail()` results.
 *
 * @example
 * ```ts
 * const result = await withTiming(async () => {
 *   const text = await fs.readFile(path, 'utf-8');
 *   return { content: text };
 * });
 * ```
 */
export async function withTiming<TOutput>(
  body: () => Promise<TOutput | ToolResult<TOutput>>,
  opts: { tokensUsed?: number } = {},
): Promise<ToolResult<TOutput>> {
  const start = Date.now();
  try {
    const out = await body();
    const durationMs = Date.now() - start;
    if (
      typeof out === 'object' &&
      out !== null &&
      'success' in out &&
      typeof (out as { success: unknown }).success === 'boolean'
    ) {
      // Already a ToolResult — patch durationMs if unset.
      const r = out as ToolResult<TOutput>;
      return { ...r, durationMs: r.durationMs || durationMs };
    }
    return ok(out as TOutput, { ...opts, durationMs });
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return fail<TOutput>(msg, { ...opts, durationMs });
  }
}

/**
 * Sum the `tokensUsed` field across multiple results. Used by the Executor
 * to aggregate per-task token accounting.
 *
 * @example
 * ```ts
 * const total = sumTokens([res1, res2, res3]);
 * ```
 */
export function sumTokens(results: ReadonlyArray<ToolResult<unknown>>): number {
  return results.reduce((acc, r) => acc + (r.tokensUsed ?? 0), 0);
}

/**
 * Sum the `durationMs` field across multiple results.
 */
export function sumDuration(results: ReadonlyArray<ToolResult<unknown>>): number {
  return results.reduce((acc, r) => acc + (r.durationMs ?? 0), 0);
}

/**
 * Pick the first failure from a list of results, or null if all succeeded.
 * Useful for short-circuit dispatch when any tool failure should abort a task.
 */
export function firstFailure<T>(
  results: ReadonlyArray<ToolResult<T>>,
): ToolResult<T> | null {
  for (const r of results) {
    if (!r.success) return r;
  }
  return null;
}

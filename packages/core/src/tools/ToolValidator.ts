/**
 * @file tools/ToolValidator.ts
 * @description Schema + permission validation for tool invocations. Sits
 * between the AgentLoop's `decide()` (which produces a raw `TOOL_CALL`
 * decision with a JSON arguments string from the LLM) and the tool's
 * `execute()` (which expects a schema-validated, type-safe input object).
 *
 * The validator performs three checks:
 *   1. **Schema validation** — parse the JSON arguments string, then run
 *      the tool's `inputSchema` (Zod). On failure, returns a structured
 *      `ValidationFailure` so the agent can feed the error back to the LLM.
 *   2. **Permission check** — verify every permission in `tool.permissions`
 *      is in `ctx.allowedPermissions`. Returns a `PermissionDenied` failure
 *      otherwise (never throws — the agent decides whether to ask the user).
 *   3. **Token budget check** — rough char-based estimate of the input;
 *      rejects oversized inputs to protect the LLM context window.
 *
 * @packageDocumentation
 */

import type { z } from 'zod';
import type {
  AnySanixTool,
  ToolContext,
  ToolPermission,
} from './interfaces.js';

/**
 * Discriminated result of {@link ToolValidator.validate}. Successful
 * validations carry the parsed, type-safe input; failures carry a structured
 * error for the agent to act on.
 */
export type ValidationResult<TInput = unknown> =
  | { ok: true; input: TInput }
  | { ok: false; kind: 'invalid_json' | 'schema_error' | 'permission_denied' | 'input_too_large'; error: string };

/**
 * Rough char-based token estimate. The spec mandates installing no extra
 * tokenizer; this `length / 4` heuristic is the standard approximation used
 * by OpenAI's `tiktoken` quick-estimator and is accurate within ~10% for
 * English text.
 */
export function estimateToolTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Validates tool inputs and permissions before execution.
 *
 * Stateless (one instance can validate unlimited calls); constructed once
 * per agent run and shared by the Executor.
 *
 * @example
 * ```ts
 * const validator = new ToolValidator();
 * const result = validator.validate(readFileTool, '{"path":"/etc/hosts"}', ctx);
 * if (result.ok) {
 *   const output = await readFileTool.execute(result.input, ctx);
 * } else {
 *   // feed result.error back to the LLM
 * }
 * ```
 */
export class ToolValidator {
  /**
   * Validate a raw JSON arguments string against the tool's input schema and
   * the runtime context's permissions.
   *
   * @param tool - The target tool (looked up from the registry by the caller).
   * @param argsJson - Raw JSON arguments string from the LLM.
   * @param ctx - The runtime tool context (carries allowed permissions).
   * @returns A discriminated `ValidationResult`; never throws.
   */
  validate(
    tool: AnySanixTool,
    argsJson: string,
    ctx: ToolContext,
  ): ValidationResult {
    // ── 1. Permission check (do this first — it's cheap and most decisive). ──
    const missing = this.missingPermissions(tool.permissions, ctx.allowedPermissions);
    if (missing.length > 0) {
      return {
        ok: false,
        kind: 'permission_denied',
        error: `Tool '${tool.name}' requires permissions not granted: ${missing.join(', ')}`,
      };
    }

    // ── 2. Parse JSON. ──
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        kind: 'invalid_json',
        error: `Tool '${tool.name}' received non-JSON arguments: ${msg}`,
      };
    }

    // ── 3. Token budget check (rough). ──
    const inputTokens = estimateToolTokens(argsJson);
    if (inputTokens > tool.maxTokensInput) {
      return {
        ok: false,
        kind: 'input_too_large',
        error: `Tool '${tool.name}' input ~${inputTokens} tokens exceeds limit ${tool.maxTokensInput}`,
      };
    }

    // ── 4. Schema validation. ──
    const schema = tool.inputSchema as z.ZodSchema<unknown>;
    const parseResult = schema.safeParse(parsed);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return {
        ok: false,
        kind: 'schema_error',
        error: `Tool '${tool.name}' input failed schema validation: ${issues}`,
      };
    }

    return { ok: true, input: parseResult.data };
  }

  /**
   * Compute the set of permissions the tool requires that are NOT granted by
   * the context. Returns an empty array if all permissions are satisfied.
   *
   * @example
   * ```ts
   * missingPermissions(['file_write', 'shell_exec'], ['file_write']);
   * // => ['shell_exec']
   * ```
   */
  missingPermissions(
    required: ReadonlyArray<ToolPermission>,
    granted: ReadonlyArray<ToolPermission>,
  ): ToolPermission[] {
    const grantedSet = new Set(granted);
    return required.filter((p) => !grantedSet.has(p));
  }

  /**
   * Validate only the permission aspect (skip schema). Useful for
   * pre-flight checks before the LLM has even decided which tool to call.
   */
  hasPermissions(
    tool: AnySanixTool,
    ctx: ToolContext,
  ): boolean {
    return this.missingPermissions(tool.permissions, ctx.allowedPermissions).length === 0;
  }
}

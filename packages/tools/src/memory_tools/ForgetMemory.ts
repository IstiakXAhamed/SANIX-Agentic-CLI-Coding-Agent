/**
 * @file ForgetMemory — delete a memory item by id via the `memoryForget`
 * context callback.
 */
import {
  type SanixTool,
  type ToolResult,
  type ToolPermission,
  z,
  okResult,
  errResult,
} from '../types.js';
import type { MemoryToolContext } from './_types.js';

/** Input schema for `forget`. */
export const ForgetInputSchema = z.object({
  id: z.string().min(1),
});

/** Output schema for `forget`. */
export const ForgetOutputSchema = z.object({
  deleted: z.boolean(),
});

export type ForgetInput = z.infer<typeof ForgetInputSchema>;
export type ForgetOutput = z.infer<typeof ForgetOutputSchema>;

/**
 * ForgetMemoryTool — delete a memory item by id.
 *
 * @example
 * ```ts
 * await new ForgetMemoryTool().execute({ id: 'abc123' }, ctx);
 * ```
 */
export class ForgetMemoryTool implements SanixTool<ForgetInput, ForgetOutput> {
  readonly name = 'forget';
  readonly description =
    'Delete a memory item by id. Requires a memoryForget callback in the ToolContext; returns deleted=false if absent.';
  readonly inputSchema = ForgetInputSchema;
  readonly outputSchema = ForgetOutputSchema;
  readonly permissions: ToolPermission[] = ['memory:write'];
  readonly maxTokensInput = 64;
  readonly maxTokensOutput = 32;

  async execute(
    input: ForgetInput,
    context: MemoryToolContext,
  ): Promise<ToolResult<ForgetOutput>> {
    const start = Date.now();
    const forget = context.memoryForget;
    if (!forget) {
      return okResult<ForgetOutput>({ deleted: false }, Date.now() - start);
    }
    try {
      const deleted = await forget(input.id);
      return okResult<ForgetOutput>({ deleted }, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<ForgetOutput>(`forget failed: ${msg}`, Date.now() - start);
    }
  }

  formatForContext(result: ForgetOutput): string {
    return result.deleted ? 'memory forgotten' : 'memory not forgotten (absent or not found)';
  }
}

/**
 * @file RememberFact — store a fact / event / procedure into memory via the
 * `memoryStore` context callback. No-op (returns stored=false) if the
 * callback is missing.
 */
import { nanoid } from 'nanoid';
import {
  type SanixTool,
  type ToolResult,
  type ToolPermission,
  z,
  okResult,
  errResult,
} from '../types.js';
import type { MemoryToolContext, MemoryType } from './_types.js';

/** Input schema for `remember`. */
export const RememberInputSchema = z.object({
  content: z.string().min(1),
  type: z.enum(['episodic', 'semantic', 'procedural']),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Output schema for `remember`. */
export const RememberOutputSchema = z.object({
  id: z.string(),
  stored: z.boolean(),
});

export type RememberInput = z.infer<typeof RememberInputSchema>;
export type RememberOutput = z.infer<typeof RememberOutputSchema>;

/**
 * RememberFactTool — persist a memory item via the context callback.
 *
 * @example
 * ```ts
 * await new RememberFactTool().execute(
 *   { content: 'User prefers TypeScript strict mode', type: 'semantic' },
 *   ctx,
 * );
 * ```
 */
export class RememberFactTool implements SanixTool<RememberInput, RememberOutput> {
  readonly name = 'remember';
  readonly description =
    'Store a fact, event, or procedure in long-term memory. Requires a memoryStore callback in the ToolContext.';
  readonly inputSchema = RememberInputSchema;
  readonly outputSchema = RememberOutputSchema;
  readonly permissions: ToolPermission[] = ['memory:write'];
  readonly maxTokensInput = 4_000;
  readonly maxTokensOutput = 64;

  async execute(
    input: RememberInput,
    context: MemoryToolContext,
  ): Promise<ToolResult<RememberOutput>> {
    const start = Date.now();
    const store = context.memoryStore;
    if (!store) {
      // No memory backend wired — generate a local id and return stored=false.
      return okResult<RememberOutput>(
        { id: nanoid(), stored: false },
        Date.now() - start,
      );
    }
    try {
      const id = await store({
        content: input.content,
        type: input.type as MemoryType,
        metadata: input.metadata,
      });
      return okResult<RememberOutput>({ id, stored: true }, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<RememberOutput>(`remember failed: ${msg}`, Date.now() - start);
    }
  }

  formatForContext(result: RememberOutput): string {
    return result.stored
      ? `stored memory id=${result.id}`
      : `memory store unavailable (id=${result.id} reserved)`;
  }
}

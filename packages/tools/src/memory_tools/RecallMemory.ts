/**
 * @file RecallMemory — query long-term memory via the `memoryRecall` context
 * callback.
 */
import {
  type SanixTool,
  type ToolResult,
  type ToolPermission,
  z,
  okResult,
  errResult,
} from '../types.js';
import type { MemoryToolContext, MemoryType } from './_types.js';

/** Input schema for `recall`. */
export const RecallInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(5),
  type: z.enum(['episodic', 'semantic', 'procedural']).optional(),
});

/** Output schema for `recall`. */
export const RecallOutputSchema = z.object({
  memories: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      score: z.number(),
      type: z.string(),
    }),
  ),
});

export type RecallInput = z.infer<typeof RecallInputSchema>;
export type RecallOutput = z.infer<typeof RecallOutputSchema>;

/**
 * RecallMemoryTool — retrieve memories by semantic similarity.
 *
 * @example
 * ```ts
 * const res = await new RecallMemoryTool().execute(
 *   { query: 'JWT auth', limit: 5 },
 *   ctx,
 * );
 * ```
 */
export class RecallMemoryTool implements SanixTool<RecallInput, RecallOutput> {
  readonly name = 'recall';
  readonly description =
    'Recall memories matching a query. Requires a memoryRecall callback in the ToolContext; returns an empty list if absent.';
  readonly inputSchema = RecallInputSchema;
  readonly outputSchema = RecallOutputSchema;
  readonly permissions: ToolPermission[] = ['memory:read'];
  readonly maxTokensInput = 1_000;
  readonly maxTokensOutput = 8_000;

  async execute(
    input: RecallInput,
    context: MemoryToolContext,
  ): Promise<ToolResult<RecallOutput>> {
    const start = Date.now();
    const recall = context.memoryRecall;
    if (!recall) {
      return okResult<RecallOutput>({ memories: [] }, Date.now() - start);
    }
    try {
      const results = await recall({
        query: input.query,
        limit: input.limit,
        type: input.type as MemoryType | undefined,
      });
      return okResult<RecallOutput>(
        {
          memories: results.map((r) => ({
            id: r.id,
            content: r.content,
            score: r.score,
            type: r.type,
          })),
        },
        Date.now() - start,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<RecallOutput>(`recall failed: ${msg}`, Date.now() - start);
    }
  }

  formatForContext(result: RecallOutput): string {
    if (result.memories.length === 0) return 'no memories recalled';
    return result.memories
      .map(
        (m, i) =>
          `${i + 1}. [${m.type}|score=${m.score.toFixed(2)}] ${m.content}`,
      )
      .join('\n');
  }
}

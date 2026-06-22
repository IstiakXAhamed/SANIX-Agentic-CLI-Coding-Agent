/**
 * @file SummarizeSession — request a session summary from the memory backend
 * via the `memorySummarize` context callback.
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

/** Input schema for `summarize_session`. */
export const SummarizeInputSchema = z.object({
  sessionId: z.string().optional(),
});

/** Output schema for `summarize_session`. */
export const SummarizeOutputSchema = z.object({
  summary: z.string(),
  lessonsLearned: z.array(z.string()),
});

export type SummarizeInput = z.infer<typeof SummarizeInputSchema>;
export type SummarizeOutput = z.infer<typeof SummarizeOutputSchema>;

/**
 * SummarizeSessionTool — produce a summary of the current (or named) session.
 *
 * @example
 * ```ts
 * const res = await new SummarizeSessionTool().execute({}, ctx);
 * ```
 */
export class SummarizeSessionTool
  implements SanixTool<SummarizeInput, SummarizeOutput>
{
  readonly name = 'summarize_session';
  readonly description =
    'Summarize the current session and extract lessons learned. Requires a memorySummarize callback in the ToolContext.';
  readonly inputSchema = SummarizeInputSchema;
  readonly outputSchema = SummarizeOutputSchema;
  readonly permissions: ToolPermission[] = ['memory:read', 'memory:write'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 4_000;

  async execute(
    input: SummarizeInput,
    context: MemoryToolContext,
  ): Promise<ToolResult<SummarizeOutput>> {
    const start = Date.now();
    const summarize = context.memorySummarize;
    if (!summarize) {
      return okResult<SummarizeOutput>(
        { summary: '(memory summarize unavailable)', lessonsLearned: [] },
        Date.now() - start,
      );
    }
    try {
      const result = await summarize(input.sessionId);
      return okResult<SummarizeOutput>(
        { summary: result.summary, lessonsLearned: result.lessonsLearned },
        Date.now() - start,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<SummarizeOutput>(`summarize_session failed: ${msg}`, Date.now() - start);
    }
  }

  formatForContext(result: SummarizeOutput): string {
    const lessons =
      result.lessonsLearned.length > 0
        ? `\nLessons:\n${result.lessonsLearned.map((l) => `  - ${l}`).join('\n')}`
        : '';
    return `Session summary:\n${result.summary}${lessons}`;
  }
}

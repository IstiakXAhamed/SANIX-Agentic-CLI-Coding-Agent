/**
 * @file BrowserTypeTool — type text into an element keystroke-by-keystroke.
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserTypeInputSchema = z.object({
  pageId: z.string(),
  selector: z.string().min(1),
  text: z.string(),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe('Delay (ms) between keystrokes (more human-like).'),
  clearFirst: z
    .boolean()
    .default(true)
    .describe('Clear the field before typing (default true).'),
});

export const BrowserTypeOutputSchema = z.object({
  typed: z.boolean(),
});

export type BrowserTypeInput = z.infer<typeof BrowserTypeInputSchema>;
export type BrowserTypeOutput = z.infer<typeof BrowserTypeOutputSchema>;

/**
 * `browser_type` — type text into an element matching a CSS selector.
 */
export class BrowserTypeTool
  implements BrowserSanixTool<BrowserTypeInput, BrowserTypeOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_type';
  readonly description =
    'Type text into an element matching a CSS selector, keystroke-by-keystroke. Optionally clears the field first.';
  readonly inputSchema = BrowserTypeInputSchema;
  readonly outputSchema = BrowserTypeOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 4_000;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserTypeInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserTypeOutput>> {
    const start = Date.now();
    return withErrors<BrowserTypeOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      if (input.clearFirst) {
        await page.fill(input.selector, '').catch(() => {
          /* fill may fail on non-input elements; ignore and try type */
        });
      }
      await page.type(input.selector, input.text, { delay: input.delayMs });
      return { typed: true };
    });
  }

  formatForContext(r: BrowserTypeOutput): string {
    return r.typed ? 'typed: true' : 'typed: false';
  }
}

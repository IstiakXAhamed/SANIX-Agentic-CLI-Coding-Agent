/**
 * @file BrowserFillTool — fill a form field with a value (faster than type).
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserFillInputSchema = z.object({
  pageId: z.string(),
  selector: z.string().min(1),
  value: z.string(),
});

export const BrowserFillOutputSchema = z.object({
  filled: z.boolean(),
});

export type BrowserFillInput = z.infer<typeof BrowserFillInputSchema>;
export type BrowserFillOutput = z.infer<typeof BrowserFillOutputSchema>;

/**
 * `browser_fill` — fill a form field with a value atomically. Faster than
 * `browser_type` for forms because it does not emit per-keystroke events.
 */
export class BrowserFillTool
  implements BrowserSanixTool<BrowserFillInput, BrowserFillOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_fill';
  readonly description =
    'Fill a form field (input/textarea) with a value atomically. Faster than browser_type — does not emit per-keystroke events.';
  readonly inputSchema = BrowserFillInputSchema;
  readonly outputSchema = BrowserFillOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 4_000;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserFillInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserFillOutput>> {
    const start = Date.now();
    return withErrors<BrowserFillOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      await page.fill(input.selector, input.value);
      return { filled: true };
    });
  }

  formatForContext(r: BrowserFillOutput): string {
    return r.filled ? 'filled: true' : 'filled: false';
  }
}

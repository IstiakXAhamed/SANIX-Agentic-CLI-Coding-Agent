/**
 * @file BrowserClickTool — click an element by CSS selector.
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserClickInputSchema = z.object({
  pageId: z.string(),
  selector: z.string().min(1).describe('CSS selector of the element to click.'),
  button: z.enum(['left', 'right', 'middle']).default('left'),
  clickCount: z.number().int().positive().max(10).default(1),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe('Delay (ms) between mousedown and mouseup.'),
});

export const BrowserClickOutputSchema = z.object({
  clicked: z.boolean(),
});

export type BrowserClickInput = z.infer<typeof BrowserClickInputSchema>;
export type BrowserClickOutput = z.infer<typeof BrowserClickOutputSchema>;

/**
 * `browser_click` — click an element matching a CSS selector using
 * Playwright's selector engine.
 */
export class BrowserClickTool
  implements BrowserSanixTool<BrowserClickInput, BrowserClickOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_click';
  readonly description =
    'Click an element matching a CSS selector. Supports left/right/middle button, multi-click, and a delay between mousedown/mouseup.';
  readonly inputSchema = BrowserClickInputSchema;
  readonly outputSchema = BrowserClickOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserClickInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserClickOutput>> {
    const start = Date.now();
    return withErrors<BrowserClickOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      await page.click(input.selector, {
        button: input.button,
        clickCount: input.clickCount,
        delay: input.delayMs,
      });
      return { clicked: true };
    });
  }

  formatForContext(r: BrowserClickOutput): string {
    return r.clicked ? 'clicked: true' : 'clicked: false';
  }
}

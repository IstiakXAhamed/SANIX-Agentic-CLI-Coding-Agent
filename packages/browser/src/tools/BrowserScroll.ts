/**
 * @file BrowserScrollTool — scroll the page (or a specific element).
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserScrollInputSchema = z.object({
  pageId: z.string(),
  x: z.number().int().default(0).describe('Horizontal scroll delta (px).'),
  y: z.number().int().default(0).describe('Vertical scroll delta (px).'),
  selector: z
    .string()
    .optional()
    .describe('If set, scroll the matching element instead of the page.'),
});

export const BrowserScrollOutputSchema = z.object({
  scrolled: z.boolean(),
});

export type BrowserScrollInput = z.infer<typeof BrowserScrollInputSchema>;
export type BrowserScrollOutput = z.infer<typeof BrowserScrollOutputSchema>;

/**
 * `browser_scroll` — scroll the page (or a specific element) by `x`/`y`.
 */
export class BrowserScrollTool
  implements BrowserSanixTool<BrowserScrollInput, BrowserScrollOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_scroll';
  readonly description =
    'Scroll the page by (x, y) pixels. If `selector` is provided, scrolls that element instead.';
  readonly inputSchema = BrowserScrollInputSchema;
  readonly outputSchema = BrowserScrollOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserScrollInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserScrollOutput>> {
    const start = Date.now();
    return withErrors<BrowserScrollOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      if (input.selector) {
        const dx = input.x;
        const dy = input.y;
        await page.$eval(
          input.selector,
          (el: Element, [dx, dy]: [number, number]) => {
            el.scrollBy(dx, dy);
          },
          [dx, dy] as [number, number],
        );
      } else {
        await page.mouse.wheel(input.x, input.y);
      }
      return { scrolled: true };
    });
  }

  formatForContext(r: BrowserScrollOutput): string {
    return r.scrolled ? 'scrolled: true' : 'scrolled: false';
  }
}

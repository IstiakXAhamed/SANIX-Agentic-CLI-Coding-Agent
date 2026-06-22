/**
 * @file BrowserHoverTool — hover an element by CSS selector.
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserHoverInputSchema = z.object({
  pageId: z.string(),
  selector: z.string().min(1),
});

export const BrowserHoverOutputSchema = z.object({
  hovered: z.boolean(),
});

export type BrowserHoverInput = z.infer<typeof BrowserHoverInputSchema>;
export type BrowserHoverOutput = z.infer<typeof BrowserHoverOutputSchema>;

/**
 * `browser_hover` — hover an element matching a CSS selector. Useful for
 * triggering JS-driven tooltips, dropdowns, and hover states.
 */
export class BrowserHoverTool
  implements BrowserSanixTool<BrowserHoverInput, BrowserHoverOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_hover';
  readonly description =
    'Hover an element matching a CSS selector. Triggers mouseenter/mouseover JS events.';
  readonly inputSchema = BrowserHoverInputSchema;
  readonly outputSchema = BrowserHoverOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserHoverInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserHoverOutput>> {
    const start = Date.now();
    return withErrors<BrowserHoverOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      await page.hover(input.selector);
      return { hovered: true };
    });
  }

  formatForContext(r: BrowserHoverOutput): string {
    return r.hovered ? 'hovered: true' : 'hovered: false';
  }
}

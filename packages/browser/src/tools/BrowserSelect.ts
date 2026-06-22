/**
 * @file BrowserSelectTool — select an `<option>` in a `<select>` by value.
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserSelectInputSchema = z.object({
  pageId: z.string(),
  selector: z.string().min(1).describe('CSS selector of the <select> element.'),
  value: z.string().describe('Value of the <option> to select.'),
});

export const BrowserSelectOutputSchema = z.object({
  selected: z.boolean(),
});

export type BrowserSelectInput = z.infer<typeof BrowserSelectInputSchema>;
export type BrowserSelectOutput = z.infer<typeof BrowserSelectOutputSchema>;

/**
 * `browser_select` — select an `<option>` in a `<select>` element by value.
 */
export class BrowserSelectTool
  implements BrowserSanixTool<BrowserSelectInput, BrowserSelectOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_select';
  readonly description =
    'Select an <option> in a <select> element by value. Triggers the change event.';
  readonly inputSchema = BrowserSelectInputSchema;
  readonly outputSchema = BrowserSelectOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserSelectInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserSelectOutput>> {
    const start = Date.now();
    return withErrors<BrowserSelectOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      await page.selectOption(input.selector, input.value);
      return { selected: true };
    });
  }

  formatForContext(r: BrowserSelectOutput): string {
    return r.selected ? 'selected: true' : 'selected: false';
  }
}

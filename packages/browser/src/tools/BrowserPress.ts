/**
 * @file BrowserPressTool — press a keyboard key (Enter, Tab, ArrowDown, etc.).
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserPressInputSchema = z.object({
  pageId: z.string(),
  key: z
    .string()
    .min(1)
    .describe(
      'Key name: "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Control+a", etc.',
    ),
});

export const BrowserPressOutputSchema = z.object({
  pressed: z.boolean(),
});

export type BrowserPressInput = z.infer<typeof BrowserPressInputSchema>;
export type BrowserPressOutput = z.infer<typeof BrowserPressOutputSchema>;

/**
 * `browser_press` — press a keyboard key on the page. Use key names from
 * Playwright's keyboard key set: 'Enter', 'Tab', 'Escape', 'ArrowDown',
 * 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', plus
 * modifier combinations like 'Control+a' or 'Shift+ArrowRight'.
 */
export class BrowserPressTool
  implements BrowserSanixTool<BrowserPressInput, BrowserPressOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_press';
  readonly description =
    'Press a keyboard key (Enter, Tab, Escape, ArrowDown, Control+a, etc.) on the page.';
  readonly inputSchema = BrowserPressInputSchema;
  readonly outputSchema = BrowserPressOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 64;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserPressInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserPressOutput>> {
    const start = Date.now();
    return withErrors<BrowserPressOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      await page.keyboard.press(input.key);
      return { pressed: true };
    });
  }

  formatForContext(r: BrowserPressOutput): string {
    return r.pressed ? 'pressed: true' : 'pressed: false';
  }
}

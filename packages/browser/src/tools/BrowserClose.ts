/**
 * @file BrowserCloseTool — close a browser page by id.
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { withErrors } from './_shared.js';

export const BrowserCloseInputSchema = z.object({
  pageId: z.string(),
});

export const BrowserCloseOutputSchema = z.object({
  closed: z.boolean(),
});

export type BrowserCloseInput = z.infer<typeof BrowserCloseInputSchema>;
export type BrowserCloseOutput = z.infer<typeof BrowserCloseOutputSchema>;

/**
 * `browser_close` — close a browser page by id. No-op (returns
 * `closed: true`) if the page is already gone.
 */
export class BrowserCloseTool
  implements BrowserSanixTool<BrowserCloseInput, BrowserCloseOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_close';
  readonly description = 'Close a browser page by id. Safe to call on already-closed pages.';
  readonly inputSchema = BrowserCloseInputSchema;
  readonly outputSchema = BrowserCloseOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 64;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserCloseInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserCloseOutput>> {
    const start = Date.now();
    return withErrors<BrowserCloseOutput>(start, async () => {
      await this.manager.closePage(input.pageId);
      return { closed: true };
    });
  }

  formatForContext(r: BrowserCloseOutput): string {
    return r.closed ? 'closed: true' : 'closed: false';
  }
}

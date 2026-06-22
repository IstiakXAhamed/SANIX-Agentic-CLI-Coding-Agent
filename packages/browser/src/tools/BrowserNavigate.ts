/**
 * @file BrowserNavigateTool — open a URL in a new (or existing) page.
 * Permission: `browser:write`.
 *
 * @example
 * ```ts
 * const tool = new BrowserNavigateTool(manager);
 * const res = await tool.execute({ url: 'https://example.com' }, ctx);
 * console.log(res.output?.pageId);  // "abc123..."
 * ```
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { withErrors } from './_shared.js';

export const BrowserNavigateInputSchema = z.object({
  url: z.string().url(),
  pageId: z
    .string()
    .optional()
    .describe('Reuse an existing page; if omitted, a new page is created.'),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle'])
    .default('load')
    .describe('Playwright navigation wait condition.'),
});

export const BrowserNavigateOutputSchema = z.object({
  pageId: z.string(),
  url: z.string(),
  title: z.string(),
  statusCode: z.number().int(),
});

export type BrowserNavigateInput = z.infer<typeof BrowserNavigateInputSchema>;
export type BrowserNavigateOutput = z.infer<typeof BrowserNavigateOutputSchema>;

/**
 * `browser_navigate` — navigate to a URL on a browser page.
 */
export class BrowserNavigateTool
  implements BrowserSanixTool<BrowserNavigateInput, BrowserNavigateOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_navigate';
  readonly description =
    'Open a URL in a new browser page (or reuse an existing page via pageId). Returns pageId, url, title, HTTP status code.';
  readonly inputSchema = BrowserNavigateInputSchema;
  readonly outputSchema = BrowserNavigateOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 256;

  async execute(
    input: BrowserNavigateInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserNavigateOutput>> {
    const start = Date.now();
    return withErrors<BrowserNavigateOutput>(start, async () => {
      let pageId = input.pageId;
      let page = pageId ? this.manager.getPlaywrightPage(pageId) : null;

      if (!page) {
        const handle = await this.manager.newPage();
        pageId = handle.id;
        page = this.manager.getPlaywrightPage(pageId);
        if (!page) throw new Error('failed to create a new page');
      }

      this.manager.touchPage(pageId!);
      const res = await page.goto(input.url, { waitUntil: input.waitUntil });
      const title = await page.title().catch(() => '');
      const statusCode = res?.status() ?? 0;
      return { pageId: pageId!, url: page.url(), title, statusCode };
    });
  }

  formatForContext(r: BrowserNavigateOutput): string {
    return `[page ${r.pageId}] HTTP ${r.statusCode} — ${r.title}\n${r.url}`;
  }
}

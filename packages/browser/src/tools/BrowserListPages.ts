/**
 * @file BrowserListPagesTool — list all open browser pages.
 * Permission: `browser:read`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { withErrors } from './_shared.js';

export const BrowserListPagesInputSchema = z.object({}).strict();

export const BrowserListPagesOutputSchema = z.object({
  pages: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      title: z.string(),
      createdAt: z.number().int(),
    }),
  ),
});

export type BrowserListPagesInput = z.infer<typeof BrowserListPagesInputSchema>;
export type BrowserListPagesOutput = z.infer<typeof BrowserListPagesOutputSchema>;

/**
 * `browser_list_pages` — list all currently-open browser pages managed by
 * this `BrowserManager`.
 */
export class BrowserListPagesTool
  implements BrowserSanixTool<BrowserListPagesInput, BrowserListPagesOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_list_pages';
  readonly description = 'List all currently-open browser pages with their id, url, title, and createdAt timestamp.';
  readonly inputSchema = BrowserListPagesInputSchema;
  readonly outputSchema = BrowserListPagesOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:read'];
  readonly maxTokensInput = 16;
  readonly maxTokensOutput = 4_000;

  async execute(
    _input: BrowserListPagesInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserListPagesOutput>> {
    const start = Date.now();
    return withErrors<BrowserListPagesOutput>(start, async () => {
      const handles = this.manager.listPages();
      const pages = handles.map((h) => ({
        id: h.id,
        url: h.url,
        title: h.title,
        createdAt: h.createdAt,
      }));
      return { pages };
    });
  }

  formatForContext(r: BrowserListPagesOutput): string {
    if (!r.pages.length) return '(no open pages)';
    const lines = r.pages.map(
      (p) => `• [${p.id}] ${p.title || '(no title)'} — ${p.url}`,
    );
    return `${r.pages.length} page(s):\n${lines.join('\n')}`;
  }
}

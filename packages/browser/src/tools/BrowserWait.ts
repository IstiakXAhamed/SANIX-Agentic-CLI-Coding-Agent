/**
 * @file BrowserWaitTool — wait for a selector, URL, or state on the page.
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserWaitInputSchema = z
  .object({
    pageId: z.string(),
    selector: z.string().optional().describe('Wait for this CSS selector to satisfy `state`.'),
    url: z
      .string()
      .optional()
      .describe('Wait for the page URL to match this string/glob/regex.'),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
    state: z
      .enum(['attached', 'detached', 'visible', 'hidden'])
      .default('visible')
      .describe('Selector wait state (ignored when waiting for a URL).'),
  })
  .refine((v) => !!v.selector || !!v.url, {
    message: 'browser_wait: either `selector` or `url` must be provided',
  });

export const BrowserWaitOutputSchema = z.object({
  waited: z.boolean(),
});

export type BrowserWaitInput = z.infer<typeof BrowserWaitInputSchema>;
export type BrowserWaitOutput = z.infer<typeof BrowserWaitOutputSchema>;

/**
 * `browser_wait` — wait for a selector (with state) or a URL navigation
 * to complete. Resolves `waited: true` on success, throws on timeout.
 */
export class BrowserWaitTool
  implements BrowserSanixTool<BrowserWaitInput, BrowserWaitOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_wait';
  readonly description =
    'Wait for a CSS selector to reach a given state (attached/detached/visible/hidden), or for the page URL to match a string/glob/regex.';
  readonly inputSchema = BrowserWaitInputSchema;
  readonly outputSchema = BrowserWaitOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserWaitInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserWaitOutput>> {
    const start = Date.now();
    return withErrors<BrowserWaitOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      if (input.url) {
        if (input.url.startsWith('/') && input.url.endsWith('/')) {
          // Regex pattern.
          const pattern = input.url.slice(1, -1);
          await page.waitForURL(new RegExp(pattern), { timeout: input.timeoutMs });
        } else if (/[*?]/.test(input.url)) {
          await page.waitForURL(input.url, { timeout: input.timeoutMs });
        } else {
          await page.waitForURL(input.url, { timeout: input.timeoutMs });
        }
      } else if (input.selector) {
        await page.waitForSelector(input.selector, {
          state: input.state,
          timeout: input.timeoutMs,
        });
      } else {
        throw new Error('browser_wait: either `selector` or `url` must be provided');
      }
      return { waited: true };
    });
  }

  formatForContext(r: BrowserWaitOutput): string {
    return r.waited ? 'waited: true' : 'waited: false';
  }
}

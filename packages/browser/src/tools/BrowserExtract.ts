/**
 * @file BrowserExtractTool — extract content from a page as text/html/attribute/markdown.
 * Permission: `browser:read`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors, trimForContext } from './_shared.js';
import { htmlToMarkdown, htmlToText } from '../html-to-markdown.js';

export const BrowserExtractInputSchema = z.object({
  pageId: z.string(),
  selector: z
    .string()
    .optional()
    .describe('CSS selector. Defaults to "body" for text/html/markdown modes.'),
  attribute: z
    .string()
    .optional()
    .describe('Attribute name (only used when mode === "attribute").'),
  mode: z
    .enum(['text', 'html', 'attribute', 'markdown'])
    .default('text')
    .describe('Extraction mode: text | html | attribute | markdown.'),
});

export const BrowserExtractOutputSchema = z.object({
  content: z.string(),
  elements: z.number().int(),
});

export type BrowserExtractInput = z.infer<typeof BrowserExtractInputSchema>;
export type BrowserExtractOutput = z.infer<typeof BrowserExtractOutputSchema>;

/**
 * `browser_extract` — extract content from a page in one of four modes:
 *   - `text`      — innerText of all matching elements, joined by newline.
 *   - `html`      — outerHTML of all matching elements.
 *   - `attribute` — value of the named attribute for all matching elements.
 *   - `markdown`  — convert the page (or matching element) to Markdown.
 */
export class BrowserExtractTool
  implements BrowserSanixTool<BrowserExtractInput, BrowserExtractOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_extract';
  readonly description =
    'Extract content from a page as text, HTML, attribute values, or Markdown. Markdown mode strips nav/ads and keeps article content.';
  readonly inputSchema = BrowserExtractInputSchema;
  readonly outputSchema = BrowserExtractOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:read'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 64_000;

  async execute(
    input: BrowserExtractInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserExtractOutput>> {
    const start = Date.now();
    return withErrors<BrowserExtractOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      const selector = input.selector ?? 'body';

      if (input.mode === 'markdown') {
        // Prefer the first matching element; fall back to full document.
        const html = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) return el.outerHTML;
          return document.documentElement.outerHTML;
        }, selector);
        const content = htmlToMarkdown(html ?? '');
        return { content, elements: 1 };
      }

      if (input.mode === 'text') {
        const texts = await page.$$eval(selector, (els: Element[]) =>
          els.map((e) => (e as HTMLElement).innerText ?? e.textContent ?? ''),
        );
        return { content: texts.join('\n'), elements: texts.length };
      }

      if (input.mode === 'html') {
        const htmls = await page.$$eval(selector, (els: Element[]) =>
          els.map((e) => (e as HTMLElement).outerHTML),
        );
        return { content: htmls.join('\n'), elements: htmls.length };
      }

      // mode === 'attribute'
      if (!input.attribute) {
        throw new Error('browser_extract: "attribute" is required when mode === "attribute"');
      }
      const attr = input.attribute;
      const vals = await page.$$eval(
        selector,
        (els: Element[], a: string) => els.map((e) => e.getAttribute(a) ?? ''),
        attr,
      );
      return { content: vals.join('\n'), elements: vals.length };
    });
  }

  formatForContext(r: BrowserExtractOutput): string {
    return `${r.elements} element(s)\n${trimForContext(r.content, 8000)}`;
  }
}

// `htmlToText` is exported for downstream consumers (e.g. WebAgent).
export { htmlToText };

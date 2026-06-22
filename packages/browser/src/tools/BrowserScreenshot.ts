/**
 * @file BrowserScreenshotTool — capture a screenshot as base64 (multi-modal LLM compatible).
 * Permission: `browser:read`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserScreenshotInputSchema = z.object({
  pageId: z.string(),
  fullPage: z.boolean().default(false).describe('Capture the full scrollable page.'),
  type: z.enum(['png', 'jpeg']).default('png'),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('JPEG quality 1–100 (ignored for PNG).'),
  selector: z
    .string()
    .optional()
    .describe('If set, screenshot only the matching element.'),
});

export const BrowserScreenshotOutputSchema = z.object({
  imageBase64: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
});

export type BrowserScreenshotInput = z.infer<typeof BrowserScreenshotInputSchema>;
export type BrowserScreenshotOutput = z.infer<typeof BrowserScreenshotOutputSchema>;

/**
 * `browser_screenshot` — capture a screenshot of the page and return it
 * base64-encoded (suitable for vision-capable LLMs).
 */
export class BrowserScreenshotTool
  implements BrowserSanixTool<BrowserScreenshotInput, BrowserScreenshotOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_screenshot';
  readonly description =
    'Take a screenshot of the page (or an element) and return it base64-encoded. Output is multi-modal LLM compatible.';
  readonly inputSchema = BrowserScreenshotInputSchema;
  readonly outputSchema = BrowserScreenshotOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:read'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 64_000;

  async execute(
    input: BrowserScreenshotInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserScreenshotOutput>> {
    const start = Date.now();
    return withErrors<BrowserScreenshotOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      let buf: Buffer;
      let width = 0;
      let height = 0;
      if (input.selector) {
        const el = await page.$(input.selector);
        if (!el) throw new Error(`element not found: ${input.selector}`);
        const raw = await el.screenshot({
          type: input.type,
          quality: input.type === 'jpeg' ? input.quality : undefined,
        });
        buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const box = await el.boundingBox();
        width = box ? Math.round(box.width) : 0;
        height = box ? Math.round(box.height) : 0;
      } else {
        const raw = await page.screenshot({
          fullPage: input.fullPage,
          type: input.type,
          quality: input.type === 'jpeg' ? input.quality : undefined,
        });
        buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const vp = page.viewportSize();
        width = vp?.width ?? 0;
        height = vp?.height ?? 0;
      }
      const imageBase64 = buf.toString('base64');
      return {
        imageBase64,
        width,
        height,
        bytes: buf.byteLength,
      };
    });
  }

  formatForContext(r: BrowserScreenshotOutput): string {
    return `[screenshot ${r.width}x${r.height}, ${r.bytes} bytes base64]`;
  }
}

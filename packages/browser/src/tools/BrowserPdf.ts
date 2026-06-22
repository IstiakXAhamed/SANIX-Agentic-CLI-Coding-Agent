/**
 * @file BrowserPdfTool — generate a PDF of the page (Chromium only).
 * Permission: `browser:read`.
 */
import { z } from 'zod';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserPdfInputSchema = z.object({
  pageId: z.string(),
  format: z.enum(['A4', 'Letter', 'Legal']).default('A4'),
  landscape: z.boolean().default(false),
  printBackground: z.boolean().default(true),
  saveToPath: z
    .string()
    .optional()
    .describe(
      'Absolute path to save the PDF. If omitted, saves to a temp file under the cwd.',
    ),
});

export const BrowserPdfOutputSchema = z.object({
  bytes: z.number().int(),
  path: z.string(),
});

export type BrowserPdfInput = z.infer<typeof BrowserPdfInputSchema>;
export type BrowserPdfOutput = z.infer<typeof BrowserPdfOutputSchema>;

/**
 * `browser_pdf` — generate a PDF of the page.
 *
 * **Note**: PDF generation is only supported by Chromium-based browsers
 * (Playwright's `chromium` driver). Calling this on a Firefox/WebKit page
 * will throw.
 */
export class BrowserPdfTool
  implements BrowserSanixTool<BrowserPdfInput, BrowserPdfOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_pdf';
  readonly description =
    'Generate a PDF of the page (Chromium only). Supports A4/Letter/Legal, landscape, and background-printing options. Saves to `saveToPath` or a temp file.';
  readonly inputSchema = BrowserPdfInputSchema;
  readonly outputSchema = BrowserPdfOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:read'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 256;

  async execute(
    input: BrowserPdfInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserPdfOutput>> {
    const start = Date.now();
    return withErrors<BrowserPdfOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      const raw = await page.pdf({
        format: input.format,
        landscape: input.landscape,
        printBackground: input.printBackground,
      });
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

      const savePath =
        input.saveToPath ??
        path.join(
          await fs.mkdtemp(path.join(process.cwd(), '.sanix-pdf-')),
          `page-${Date.now()}.pdf`,
        );
      await fs.mkdir(path.dirname(savePath), { recursive: true });
      await fs.writeFile(savePath, buf);
      return { bytes: buf.byteLength, path: savePath };
    });
  }

  formatForContext(r: BrowserPdfOutput): string {
    return `pdf ${r.bytes} bytes → ${r.path}`;
  }
}

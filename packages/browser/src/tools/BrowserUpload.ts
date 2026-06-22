/**
 * @file BrowserUploadTool — upload a file to an `<input type="file">`.
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserUploadInputSchema = z.object({
  pageId: z.string(),
  selector: z.string().min(1).describe('CSS selector of the <input type="file"> element.'),
  filePath: z.string().min(1).describe('Absolute path to the file to upload.'),
});

export const BrowserUploadOutputSchema = z.object({
  uploaded: z.boolean(),
});

export type BrowserUploadInput = z.infer<typeof BrowserUploadInputSchema>;
export type BrowserUploadOutput = z.infer<typeof BrowserUploadOutputSchema>;

/**
 * `browser_upload` — upload a file to an `<input type="file">` element.
 *
 * Uses Playwright's `setInputFiles` which triggers the `change` event
 * automatically.
 */
export class BrowserUploadTool
  implements BrowserSanixTool<BrowserUploadInput, BrowserUploadOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_upload';
  readonly description =
    'Upload a file to an <input type="file"> element. Uses Playwright setInputFiles which triggers the change event.';
  readonly inputSchema = BrowserUploadInputSchema;
  readonly outputSchema = BrowserUploadOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 512;
  readonly maxTokensOutput = 16;

  async execute(
    input: BrowserUploadInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserUploadOutput>> {
    const start = Date.now();
    return withErrors<BrowserUploadOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      await page.setInputFiles(input.selector, input.filePath);
      return { uploaded: true };
    });
  }

  formatForContext(r: BrowserUploadOutput): string {
    return r.uploaded ? 'uploaded: true' : 'uploaded: false';
  }
}

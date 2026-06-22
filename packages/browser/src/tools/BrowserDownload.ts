/**
 * @file BrowserDownloadTool — trigger a download and save the file to disk.
 * Permission: `browser:write`.
 */
import { z } from 'zod';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors } from './_shared.js';

export const BrowserDownloadInputSchema = z
  .object({
    pageId: z.string(),
    url: z
      .string()
      .optional()
      .describe('If set, navigate to this URL to trigger a download.'),
    selector: z
      .string()
      .optional()
      .describe('If set, click this element to trigger a download.'),
    saveToPath: z
      .string()
      .optional()
      .describe(
        'Absolute path to save the downloaded file. If omitted, uses the download\'s suggested name in the OS temp dir.',
      ),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  })
  .refine((v) => !!v.url || !!v.selector, {
    message: 'browser_download: either `url` or `selector` must be provided',
  });

export const BrowserDownloadOutputSchema = z.object({
  downloaded: z.boolean(),
  bytes: z.number().int(),
  path: z.string(),
  mimeType: z.string(),
});

export type BrowserDownloadInput = z.infer<typeof BrowserDownloadInputSchema>;
export type BrowserDownloadOutput = z.infer<typeof BrowserDownloadOutputSchema>;

/** Tiny extension → MIME-type table for download MIME guessing. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wav: 'audio/wav',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
};

/**
 * `browser_download` — trigger a download (by clicking a selector or by
 * navigating to a URL) and save the file to `saveToPath`.
 */
export class BrowserDownloadTool
  implements BrowserSanixTool<BrowserDownloadInput, BrowserDownloadOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_download';
  readonly description =
    'Trigger a download (by clicking a selector or by navigating to a URL) and save the file to disk. Returns the saved path, byte count, and MIME type.';
  readonly inputSchema = BrowserDownloadInputSchema;
  readonly outputSchema = BrowserDownloadOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 512;
  readonly maxTokensOutput = 256;

  async execute(
    input: BrowserDownloadInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserDownloadOutput>> {
    const start = Date.now();
    return withErrors<BrowserDownloadOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);

      // Wire up the download handler BEFORE the trigger.
      const downloadPromise = page.waitForEvent('download', { timeout: input.timeoutMs });
      if (input.selector) {
        await page.click(input.selector).catch((err) => {
          throw new Error(`click trigger failed: ${err instanceof Error ? err.message : err}`);
        });
      } else if (input.url) {
        await page.goto(input.url).catch((err) => {
          throw new Error(`navigation trigger failed: ${err instanceof Error ? err.message : err}`);
        });
      } else {
        throw new Error('browser_download: either `url` or `selector` must be provided');
      }

      const download = await downloadPromise;
      const suggested = download.suggestedFilename();
      const savePath = input.saveToPath ?? path.join(
        await fs.mkdtemp(path.join(process.cwd(), '.sanix-dl-')),
        suggested,
      );

      // Ensure parent dir exists.
      await fs.mkdir(path.dirname(savePath), { recursive: true });
      await download.saveAs(savePath);
      const stat = await fs.stat(savePath);

      // Best-effort MIME-type guess from the file extension.
      const ext = path.extname(suggested).toLowerCase().slice(1);
      const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';

      return {
        downloaded: true,
        bytes: stat.size,
        path: savePath,
        mimeType,
      };
    });
  }

  formatForContext(r: BrowserDownloadOutput): string {
    return `downloaded ${r.bytes} bytes → ${r.path} (${r.mimeType})`;
  }
}

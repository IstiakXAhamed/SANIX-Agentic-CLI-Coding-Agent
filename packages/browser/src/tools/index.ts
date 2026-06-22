/**
 * @file tools/index.ts — barrel for all 17 browser tools + the
 * `allBrowserTools(manager)` factory.
 *
 * Tools are NOT added to `@sanix/tools`'s `allTools()` — they live in
 * `@sanix/browser` and are registered separately with the core
 * `ToolRegistry`.
 */
import type { SanixTool } from '@sanix/tools';

import type { BrowserManager } from '../BrowserManager.js';

import { BrowserNavigateTool } from './BrowserNavigate.js';
import { BrowserClickTool } from './BrowserClick.js';
import { BrowserTypeTool } from './BrowserType.js';
import { BrowserFillTool } from './BrowserFill.js';
import { BrowserScrollTool } from './BrowserScroll.js';
import { BrowserScreenshotTool } from './BrowserScreenshot.js';
import { BrowserExtractTool } from './BrowserExtract.js';
import { BrowserWaitTool } from './BrowserWait.js';
import { BrowserEvaluateTool } from './BrowserEvaluate.js';
import { BrowserSelectTool } from './BrowserSelect.js';
import { BrowserHoverTool } from './BrowserHover.js';
import { BrowserPressTool } from './BrowserPress.js';
import { BrowserUploadTool } from './BrowserUpload.js';
import { BrowserDownloadTool } from './BrowserDownload.js';
import { BrowserPdfTool } from './BrowserPdf.js';
import { BrowserCloseTool } from './BrowserClose.js';
import { BrowserListPagesTool } from './BrowserListPages.js';

export { BrowserNavigateTool } from './BrowserNavigate.js';
export { BrowserClickTool } from './BrowserClick.js';
export { BrowserTypeTool } from './BrowserType.js';
export { BrowserFillTool } from './BrowserFill.js';
export { BrowserScrollTool } from './BrowserScroll.js';
export { BrowserScreenshotTool } from './BrowserScreenshot.js';
export { BrowserExtractTool, htmlToText } from './BrowserExtract.js';
export { BrowserWaitTool } from './BrowserWait.js';
export { BrowserEvaluateTool } from './BrowserEvaluate.js';
export { BrowserSelectTool } from './BrowserSelect.js';
export { BrowserHoverTool } from './BrowserHover.js';
export { BrowserPressTool } from './BrowserPress.js';
export { BrowserUploadTool } from './BrowserUpload.js';
export { BrowserDownloadTool } from './BrowserDownload.js';
export { BrowserPdfTool } from './BrowserPdf.js';
export { BrowserCloseTool } from './BrowserClose.js';
export { BrowserListPagesTool } from './BrowserListPages.js';

export {
  BrowserNavigateInputSchema,
  BrowserNavigateOutputSchema,
  type BrowserNavigateInput,
  type BrowserNavigateOutput,
} from './BrowserNavigate.js';
export {
  BrowserClickInputSchema,
  BrowserClickOutputSchema,
  type BrowserClickInput,
  type BrowserClickOutput,
} from './BrowserClick.js';
export {
  BrowserTypeInputSchema,
  BrowserTypeOutputSchema,
  type BrowserTypeInput,
  type BrowserTypeOutput,
} from './BrowserType.js';
export {
  BrowserFillInputSchema,
  BrowserFillOutputSchema,
  type BrowserFillInput,
  type BrowserFillOutput,
} from './BrowserFill.js';
export {
  BrowserScrollInputSchema,
  BrowserScrollOutputSchema,
  type BrowserScrollInput,
  type BrowserScrollOutput,
} from './BrowserScroll.js';
export {
  BrowserScreenshotInputSchema,
  BrowserScreenshotOutputSchema,
  type BrowserScreenshotInput,
  type BrowserScreenshotOutput,
} from './BrowserScreenshot.js';
export {
  BrowserExtractInputSchema,
  BrowserExtractOutputSchema,
  type BrowserExtractInput,
  type BrowserExtractOutput,
} from './BrowserExtract.js';
export {
  BrowserWaitInputSchema,
  BrowserWaitOutputSchema,
  type BrowserWaitInput,
  type BrowserWaitOutput,
} from './BrowserWait.js';
export {
  BrowserEvaluateInputSchema,
  BrowserEvaluateOutputSchema,
  type BrowserEvaluateInput,
  type BrowserEvaluateOutput,
} from './BrowserEvaluate.js';
export {
  BrowserSelectInputSchema,
  BrowserSelectOutputSchema,
  type BrowserSelectInput,
  type BrowserSelectOutput,
} from './BrowserSelect.js';
export {
  BrowserHoverInputSchema,
  BrowserHoverOutputSchema,
  type BrowserHoverInput,
  type BrowserHoverOutput,
} from './BrowserHover.js';
export {
  BrowserPressInputSchema,
  BrowserPressOutputSchema,
  type BrowserPressInput,
  type BrowserPressOutput,
} from './BrowserPress.js';
export {
  BrowserUploadInputSchema,
  BrowserUploadOutputSchema,
  type BrowserUploadInput,
  type BrowserUploadOutput,
} from './BrowserUpload.js';
export {
  BrowserDownloadInputSchema,
  BrowserDownloadOutputSchema,
  type BrowserDownloadInput,
  type BrowserDownloadOutput,
} from './BrowserDownload.js';
export {
  BrowserPdfInputSchema,
  BrowserPdfOutputSchema,
  type BrowserPdfInput,
  type BrowserPdfOutput,
} from './BrowserPdf.js';
export {
  BrowserCloseInputSchema,
  BrowserCloseOutputSchema,
  type BrowserCloseInput,
  type BrowserCloseOutput,
} from './BrowserClose.js';
export {
  BrowserListPagesInputSchema,
  BrowserListPagesOutputSchema,
  type BrowserListPagesInput,
  type BrowserListPagesOutput,
} from './BrowserListPages.js';

/**
 * Instantiate all 17 browser tools against the supplied
 * {@link BrowserManager}. All tools share the same manager (and therefore
 * the same Playwright browser + open pages).
 *
 * The returned array is typed as `SanixTool<unknown, unknown>[]` (the
 * canonical core interface) so it can be passed directly to
 * `@sanix/core`'s `ToolRegistry.register(...)`.
 *
 * @example
 * ```ts
 * import { BrowserManager, allBrowserTools } from '@sanix/browser';
 * import { ToolRegistry } from '@sanix/core';
 *
 * const mgr = new BrowserManager();
 * await mgr.launch();
 * const registry = new ToolRegistry();
 * for (const tool of allBrowserTools(mgr)) registry.register(tool);
 * ```
 */
export function allBrowserTools(manager: BrowserManager): SanixTool<unknown, unknown>[] {
  return [
    new BrowserNavigateTool(manager),
    new BrowserClickTool(manager),
    new BrowserTypeTool(manager),
    new BrowserFillTool(manager),
    new BrowserScrollTool(manager),
    new BrowserScreenshotTool(manager),
    new BrowserExtractTool(manager),
    new BrowserWaitTool(manager),
    new BrowserEvaluateTool(manager),
    new BrowserSelectTool(manager),
    new BrowserHoverTool(manager),
    new BrowserPressTool(manager),
    new BrowserUploadTool(manager),
    new BrowserDownloadTool(manager),
    new BrowserPdfTool(manager),
    new BrowserCloseTool(manager),
    new BrowserListPagesTool(manager),
  ] as unknown as SanixTool<unknown, unknown>[];
}

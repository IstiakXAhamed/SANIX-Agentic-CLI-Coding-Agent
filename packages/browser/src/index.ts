/**
 * @file @sanix/browser — public barrel.
 *
 * Re-exports the full public API of the package:
 *   - `BrowserManager` + `PageHandle` + lifecycle types.
 *   - `BrowserSession` + `BrowserAction` / `BrowserActionResult`.
 *   - `WebAgent` + `WebAgentResult`.
 *   - All 17 browser tools + the `allBrowserTools(manager)` factory.
 *   - Extended `ToolPermission` union (with `browser:read` / `browser:write`).
 *
 * Usage:
 * ```ts
 * import {
 *   BrowserManager,
 *   BrowserSession,
 *   WebAgent,
 *   allBrowserTools,
 * } from '@sanix/browser';
 * ```
 */

// ── Types (extended permission union + BrowserAction + WebAgentResult) ────
export {
  type ToolPermission,
  type BrowserPermission,
  type BrowserSanixTool,
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type BrowserAction,
  type NavigateAction,
  type ClickAction,
  type TypeAction,
  type FillAction,
  type ScrollAction,
  type ScreenshotAction,
  type ExtractAction,
  type WaitAction,
  type EvaluateAction,
  type SelectAction,
  type HoverAction,
  type PressAction,
  type UploadAction,
  type DownloadAction,
  type PdfAction,
  type GoBackAction,
  type GoForwardAction,
  type ReloadAction,
  type BrowserActionResult,
  type WebAgentResult,
} from './types.js';

// ── BrowserManager ────────────────────────────────────────────────────────
export {
  BrowserManager,
  type BrowserManagerOptions,
  type BrowserManagerEventMap,
  type NewPageOptions,
  type PageHandle,
  type ScreenshotOptions,
} from './BrowserManager.js';

// ── BrowserSession ────────────────────────────────────────────────────────
export {
  BrowserSession,
  type BrowserSessionStartOptions,
} from './BrowserSession.js';

// ── WebAgent ──────────────────────────────────────────────────────────────
export {
  WebAgent,
  type WebAgentOptions,
  type WebAgentEventMap,
} from './WebAgent.js';

// ── HTML → Markdown helper (exported for downstream re-use) ──────────────
export { htmlToMarkdown, htmlToText } from './html-to-markdown.js';

// ── All 17 tools + the allBrowserTools(manager) factory ───────────────────
export {
  // Tool classes.
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserFillTool,
  BrowserScrollTool,
  BrowserScreenshotTool,
  BrowserExtractTool,
  BrowserWaitTool,
  BrowserEvaluateTool,
  BrowserSelectTool,
  BrowserHoverTool,
  BrowserPressTool,
  BrowserUploadTool,
  BrowserDownloadTool,
  BrowserPdfTool,
  BrowserCloseTool,
  BrowserListPagesTool,
  // Schemas + I/O types.
  BrowserNavigateInputSchema,
  type BrowserNavigateInput,
  type BrowserNavigateOutput,
  BrowserClickInputSchema,
  type BrowserClickInput,
  type BrowserClickOutput,
  BrowserTypeInputSchema,
  type BrowserTypeInput,
  type BrowserTypeOutput,
  BrowserFillInputSchema,
  type BrowserFillInput,
  type BrowserFillOutput,
  BrowserScrollInputSchema,
  type BrowserScrollInput,
  type BrowserScrollOutput,
  BrowserScreenshotInputSchema,
  type BrowserScreenshotInput,
  type BrowserScreenshotOutput,
  BrowserExtractInputSchema,
  type BrowserExtractInput,
  type BrowserExtractOutput,
  BrowserWaitInputSchema,
  type BrowserWaitInput,
  type BrowserWaitOutput,
  BrowserEvaluateInputSchema,
  type BrowserEvaluateInput,
  type BrowserEvaluateOutput,
  BrowserSelectInputSchema,
  type BrowserSelectInput,
  type BrowserSelectOutput,
  BrowserHoverInputSchema,
  type BrowserHoverInput,
  type BrowserHoverOutput,
  BrowserPressInputSchema,
  type BrowserPressInput,
  type BrowserPressOutput,
  BrowserUploadInputSchema,
  type BrowserUploadInput,
  type BrowserUploadOutput,
  BrowserDownloadInputSchema,
  type BrowserDownloadInput,
  type BrowserDownloadOutput,
  BrowserPdfInputSchema,
  type BrowserPdfInput,
  type BrowserPdfOutput,
  BrowserCloseInputSchema,
  type BrowserCloseInput,
  type BrowserCloseOutput,
  BrowserListPagesInputSchema,
  type BrowserListPagesInput,
  type BrowserListPagesOutput,
  // Factory.
  allBrowserTools,
} from './tools/index.js';

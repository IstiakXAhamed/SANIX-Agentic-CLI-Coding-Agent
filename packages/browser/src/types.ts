/**
 * @file Shared types for `@sanix/browser`.
 *
 * Re-exports the canonical `SanixTool` / `ToolContext` / `ToolResult` /
 * `ToolPermission` shapes from `@sanix/tools` so consumers can import them
 * from a single place, and extends the permission union with the two new
 * browser tags `browser:read` and `browser:write`.
 *
 * Also defines the `BrowserAction` discriminated-union used by
 * {@link BrowserSession.flow}, the `PageHandle` contract surfaced by
 * {@link BrowserManager}, and the `BrowserSanixTool` interface that every
 * browser tool implements (structurally compatible with `SanixTool` from
 * `@sanix/tools` but with the broader permission union).
 */
import type { ZodTypeAny } from 'zod';
import type {
  SanixTool as CoreSanixTool,
  ToolContext,
  ToolPermission as CoreToolPermission,
  ToolResult,
} from '@sanix/tools';

export type { ToolContext, ToolResult } from '@sanix/tools';

/**
 * The two permission tags added by `@sanix/browser` on top of the canonical
 * `ToolPermission` union from `@sanix/tools`.
 *
 * - `browser:read`  — read-only actions: screenshot, extract, list_pages, pdf.
 * - `browser:write` — actions that mutate the page or trigger side effects:
 *   click, type, fill, scroll, navigate, evaluate, etc.
 */
export type BrowserPermission = 'browser:read' | 'browser:write';

/**
 * Extended permission union: every existing tag plus the two browser tags.
 * Re-exported so callers can refer to a single `ToolPermission` type that
 * covers all known permissions across the SANIX ecosystem.
 */
export type ToolPermission = CoreToolPermission | BrowserPermission;

/**
 * A `SanixTool`-compatible contract that allows the broader browser
 * permission tags. Every browser tool implements this interface; the
 * {@link allBrowserTools} factory casts the result back to
 * `SanixTool<unknown, unknown>[]` for compatibility with `@sanix/core`'s
 * `ToolRegistry` (the cast is structurally safe — permissions are just
 * string tags compared at runtime).
 */
export interface BrowserSanixTool<TInput, TOutput> {
  /** Stable tool name used in LLM tool definitions, e.g. `browser_navigate`. */
  readonly name: string;
  /** Human/LLM-readable description. */
  readonly description: string;
  /** Zod schema describing the input shape. */
  readonly inputSchema: ZodTypeAny;
  /** Zod schema describing the output shape. */
  readonly outputSchema: ZodTypeAny;
  /** Permission tags required to run this tool (includes browser:* tags). */
  readonly permissions: ToolPermission[];
  /** Max tokens the tool is willing to accept as input. */
  readonly maxTokensInput: number;
  /** Max tokens the tool is willing to produce as output. */
  readonly maxTokensOutput: number;
  /** Execute the tool. */
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
  /** Render the output as a compact string for prompt injection. */
  formatForContext(result: TOutput): string;
}

/**
 * Alias kept for source symmetry with `@sanix/tools` — when consumers need
 * the narrower core interface they can import `CoreSanixTool` from here.
 */
export type SanixTool<TInput, TOutput> = CoreSanixTool<TInput, TOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// BrowserAction discriminated union — used by BrowserSession.flow
// ─────────────────────────────────────────────────────────────────────────────

/** Navigate to a URL on the session's page. */
export interface NavigateAction {
  type: 'navigate';
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

/** Click an element matching a CSS selector. */
export interface ClickAction {
  type: 'click';
  selector: string;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delayMs?: number;
}

/** Type text into an element matching a CSS selector (keystroke-by-keystroke). */
export interface TypeAction {
  type: 'type';
  selector: string;
  text: string;
  delayMs?: number;
  clearFirst?: boolean;
}

/** Fill a form field with a value (faster than type for forms). */
export interface FillAction {
  type: 'fill';
  selector: string;
  value: string;
}

/** Scroll the page (or a specific element) by x/y offset. */
export interface ScrollAction {
  type: 'scroll';
  x?: number;
  y?: number;
  selector?: string;
}

/** Take a screenshot, returning a base64-encoded image. */
export interface ScreenshotAction {
  type: 'screenshot';
  fullPage?: boolean;
  type_?: 'png' | 'jpeg';
  quality?: number;
  selector?: string;
}

/** Extract content from the page as text / html / attribute / markdown. */
export interface ExtractAction {
  type: 'extract';
  selector?: string;
  attribute?: string;
  mode?: 'text' | 'html' | 'attribute' | 'markdown';
}

/** Wait for a selector, URL, or state to appear. */
export interface WaitAction {
  type: 'wait';
  selector?: string;
  url?: string;
  timeoutMs?: number;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
}

/** Evaluate arbitrary JavaScript in the page context. */
export interface EvaluateAction {
  type: 'evaluate';
  script: string;
  args?: unknown[];
}

/** Select an `<option>` in a `<select>` element by value. */
export interface SelectAction {
  type: 'select';
  selector: string;
  value: string;
}

/** Hover an element matching a CSS selector. */
export interface HoverAction {
  type: 'hover';
  selector: string;
}

/** Press a keyboard key (Enter, Tab, ArrowDown, etc.). */
export interface PressAction {
  type: 'press';
  key: string;
}

/** Upload a file to an `<input type="file">` element. */
export interface UploadAction {
  type: 'upload';
  selector: string;
  filePath: string;
}

/** Trigger a download and save the file to disk. */
export interface DownloadAction {
  type: 'download';
  url?: string;
  selector?: string;
  saveToPath?: string;
  timeoutMs?: number;
}

/** Generate a PDF of the page (Chromium only). */
export interface PdfAction {
  type: 'pdf';
  format?: 'A4' | 'Letter' | 'Legal';
  landscape?: boolean;
  printBackground?: boolean;
  saveToPath?: string;
}

/** Navigate the session's page back in history. */
export interface GoBackAction {
  type: 'go_back';
}

/** Navigate the session's page forward in history. */
export interface GoForwardAction {
  type: 'go_forward';
}

/** Reload the current page. */
export interface ReloadAction {
  type: 'reload';
}

/**
 * Discriminated union of every action a {@link BrowserSession.flow} chain
 * can execute. The `type` field selects the action; the remaining fields
 * are type-narrowed accordingly.
 */
export type BrowserAction =
  | NavigateAction
  | ClickAction
  | TypeAction
  | FillAction
  | ScrollAction
  | ScreenshotAction
  | ExtractAction
  | WaitAction
  | EvaluateAction
  | SelectAction
  | HoverAction
  | PressAction
  | UploadAction
  | DownloadAction
  | PdfAction
  | GoBackAction
  | GoForwardAction
  | ReloadAction;

/**
 * Result of executing a single {@link BrowserAction} inside a session flow.
 * The `output` field is type-erased to `unknown` because different actions
 * produce different shapes — callers narrow at the use-site.
 */
export interface BrowserActionResult {
  /** The action that was executed. */
  action: BrowserAction;
  /** Whether the action completed without throwing. */
  success: boolean;
  /** Action-specific output payload (or `undefined` on failure). */
  output?: unknown;
  /** Error message when `success` is false. */
  error?: string;
  /** Wall-clock duration of the action in milliseconds. */
  durationMs: number;
}

/**
 * Result returned by {@link WebAgent.browse}.
 */
export interface WebAgentResult {
  /** The goal the agent was trying to achieve. */
  goal: string;
  /** Ordered log of every step the agent took. */
  steps: Array<{
    /** The action the LLM chose. */
    action: BrowserAction;
    /** The action's execution result. */
    result: unknown;
    /** The LLM's reasoning for the action (raw model text). */
    reasoning: string;
  }>;
  /** Final URL the browser landed on. */
  finalUrl: string;
  /** Final extracted content from the page (markdown). */
  finalContent: string;
  /** End-to-end wall-clock duration of the browse loop in milliseconds. */
  durationMs: number;
  /** Number of steps actually executed. */
  stepsTaken: number;
  /** True if the LLM emitted a `done` action. */
  success: boolean;
}

/**
 * @file Shared helpers for the browser tool implementations.
 *
 * Each browser tool follows the same shape:
 *   - Constructor takes a {@link BrowserManager}.
 *   - `execute()` resolves the referenced page via the manager and
 *     delegates to a Playwright method.
 *   - `formatForContext()` renders the output as a compact string.
 *
 * The helpers here centralize (1) the page lookup with a clear error
 * message and (2) the standard try/catch → `errResult` pattern so each
 * tool body stays focused on the Playwright call itself.
 */
import type { Page } from 'playwright';
import {
  type ToolContext,
  type ToolResult,
  errResult,
} from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';

/**
 * Look up a Playwright `Page` by id, touching its idle timer.
 * Throws a descriptive error if the page is unknown — the caller is
 * expected to catch it and convert into an `errResult`.
 */
export function requirePage(manager: BrowserManager, pageId: string): Page {
  const page = manager.getPlaywrightPage(pageId);
  if (!page) {
    throw new Error(
      `browser: page not found (pageId=${pageId}). Open one with browser_navigate first.`,
    );
  }
  manager.touchPage(pageId);
  return page;
}

/**
 * Wrap an async tool body in a standard try/catch that converts thrown
 * errors into `errResult` payloads (with timing).
 *
 * @example
 * ```ts
 * return withErrors<BrowserClickOutput>(start, async () => {
 *   const page = requirePage(this.manager, input.pageId);
 *   await page.click(input.selector, { button: input.button });
 *   return { clicked: true };
 * });
 * ```
 */
export async function withErrors<TOutput>(
  start: number,
  body: () => Promise<TOutput>,
): Promise<ToolResult<TOutput>> {
  try {
    const output = await body();
    const tokens = Math.ceil(JSON.stringify(output ?? {}).length / 4);
    return {
      success: true,
      output,
      tokensUsed: tokens,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errResult<TOutput>(`browser: ${msg}`, Date.now() - start);
  }
}

/**
 * Trim a string to a maximum length, inserting an ellipsis marker in the
 * middle. Used by `formatForContext` implementations to keep prompt
 * injections under budget.
 */
export function trimForContext(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…[truncated ${s.length - max} bytes]…\n${s.slice(-half)}`;
}

/** Type-only re-export so tool files don't need a separate import line. */
export type { ToolContext, ToolResult };

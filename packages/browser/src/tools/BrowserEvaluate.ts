/**
 * @file BrowserEvaluateTool — run arbitrary JavaScript in the page context.
 * Permission: `browser:write`. WARNING: powerful — can be dangerous.
 */
import { z } from 'zod';
import type { BrowserSanixTool, ToolPermission } from '../types.js';
import type { ToolContext, ToolResult } from '@sanix/tools';
import type { BrowserManager } from '../BrowserManager.js';
import { requirePage, withErrors, trimForContext } from './_shared.js';

export const BrowserEvaluateInputSchema = z.object({
  pageId: z.string(),
  script: z
    .string()
    .min(1)
    .describe(
      'JavaScript to evaluate in the page context. May be an expression or an async function body.',
    ),
  args: z
    .array(z.unknown())
    .optional()
    .describe('Arguments passed to the evaluated function (if `script` is a function).'),
});

export const BrowserEvaluateOutputSchema = z.object({
  result: z.unknown(),
});

export type BrowserEvaluateInput = z.infer<typeof BrowserEvaluateInputSchema>;
export type BrowserEvaluateOutput = z.infer<typeof BrowserEvaluateOutputSchema>;

/**
 * `browser_evaluate` — run arbitrary JavaScript in the page context.
 *
 * The `script` is wrapped so it may be either an expression or an async
 * function body. Arguments in `args` are passed in positionally.
 *
 * **Warning**: this is the most powerful browser tool — it can read/write
 * any page state, exfiltrate cookies, trigger network requests, etc.
 * Wire it through `ToolContext.requireApproval` before exposing it to
 * untrusted agents.
 */
export class BrowserEvaluateTool
  implements BrowserSanixTool<BrowserEvaluateInput, BrowserEvaluateOutput>
{
  constructor(private readonly manager: BrowserManager) {}
  readonly name = 'browser_evaluate';
  readonly description =
    'Evaluate arbitrary JavaScript in the page context. WARNING: powerful — can read/modify any page state, exfiltrate cookies, etc. Wire through requireApproval before exposing to untrusted agents.';
  readonly inputSchema = BrowserEvaluateInputSchema;
  readonly outputSchema = BrowserEvaluateOutputSchema;
  readonly permissions: ToolPermission[] = ['browser:write'];
  readonly maxTokensInput = 16_000;
  readonly maxTokensOutput = 32_000;

  async execute(
    input: BrowserEvaluateInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<BrowserEvaluateOutput>> {
    const start = Date.now();
    return withErrors<BrowserEvaluateOutput>(start, async () => {
      const page = requirePage(this.manager, input.pageId);
      const result = await page.evaluate(input.script, input.args ?? []);
      return { result };
    });
  }

  formatForContext(r: BrowserEvaluateOutput): string {
    let json: string;
    try {
      json = JSON.stringify(r.result, null, 2);
    } catch {
      json = String(r.result);
    }
    return trimForContext(json, 8000);
  }
}

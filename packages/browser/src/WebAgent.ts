/**
 * @file WebAgent — autonomous web-browsing agent.
 *
 * Combines a {@link BrowserManager} with an LLM {@link IProvider} to form
 * a simple ReAct-style loop:
 *   1. Open the `startUrl`.
 *   2. Take a screenshot + extract visible text.
 *   3. Send both to the LLM with a goal prompt.
 *   4. Parse the LLM's chosen action from its JSON response.
 *   5. Execute the action via {@link BrowserSession}.
 *   6. Repeat until the LLM says `done` or `maxSteps` is reached.
 *
 * The agent is intentionally minimal — it does NOT do tool-use function
 * calling, multi-modal image input, or recovery heuristics. It is meant
 * as a starting point that callers can extend (override
 * `goalPrompt` / `buildUserMessage` / `parseAction`) for their domain.
 */
import { EventEmitter } from 'eventemitter3';
import type { IProvider, LLMMessage } from '@sanix/providers';
import type { BrowserManager } from './BrowserManager.js';
import { BrowserSession } from './BrowserSession.js';
import type {
  BrowserAction,
  WebAgentResult,
} from './types.js';

/**
 * Constructor options for {@link WebAgent}.
 */
export interface WebAgentOptions {
  /** The browser manager to drive. */
  manager: BrowserManager;
  /** The LLM provider to query for the next action. */
  provider: IProvider;
  /** Maximum number of agent steps before giving up (default 10). */
  maxSteps?: number;
  /** Override the default goal prompt template. */
  goalPrompt?: string;
  /** Max tokens for each LLM response (default 1024). */
  maxTokens?: number;
  /** Temperature for LLM calls (default 0). */
  temperature?: number;
}

/** Event map for {@link WebAgent}. */
export interface WebAgentEventMap {
  'step:start': { step: number; reasoning: string };
  'step:complete': {
    step: number;
    action: BrowserAction;
    success: boolean;
    durationMs: number;
  };
  'agent:complete': { result: WebAgentResult };
}

/**
 * Shape the LLM is asked to return:
 *   { action: 'click|type|scroll|navigate|extract|done',
 *     selector?: string, text?: string, url?: string }
 */
interface LlmActionResponse {
  action: 'click' | 'type' | 'scroll' | 'navigate' | 'extract' | 'done';
  selector?: string;
  text?: string;
  url?: string;
  reasoning?: string;
}

/** Default goal prompt template (the `{goal}` placeholder is substituted). */
const DEFAULT_GOAL_PROMPT = `You are an autonomous web-browsing agent. Your goal:

{goal}

You are given the current page URL, the visible text on the page, and (when available) a screenshot. Decide the single next action to take to make progress toward the goal.

Respond with ONLY a JSON object (no markdown fences, no commentary) of the form:
{
  "action": "click" | "type" | "scroll" | "navigate" | "extract" | "done",
  "selector": "<CSS selector>",   // for click / type
  "text": "<text to type>",        // for type
  "url": "<url>",                  // for navigate
  "reasoning": "<one-sentence justification>"
}

Rules:
- Use "done" when the goal has been achieved.
- Use "extract" to capture the page's main content as Markdown.
- Use "navigate" only when the current page cannot achieve the goal.
- Keep selectors simple and specific (id, role, text-based).
- Respond with raw JSON only.`;

/**
 * WebAgent — autonomous web-browsing agent.
 *
 * @example
 * ```ts
 * const mgr = new BrowserManager({ headless: true });
 * await mgr.launch();
 * const agent = new WebAgent({
 *   manager: mgr,
 *   provider: new AnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }),
 *   maxSteps: 15,
 * });
 * agent.on('step:complete', ({ step, action, success }) =>
 *   console.log(`step ${step}: ${action.type} ${success ? '✓' : '✗'}`),
 * );
 * const result = await agent.browse(
 *   'Find the price of the iPhone 15 Pro on apple.com',
 *   'https://www.apple.com/shop',
 * );
 * console.log(result.success, result.stepsTaken, result.finalUrl);
 * await mgr.close();
 * ```
 */
export class WebAgent extends EventEmitter<WebAgentEventMap> {
  private readonly manager: BrowserManager;
  private readonly provider: IProvider;
  private readonly maxSteps: number;
  private readonly goalPrompt: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(opts: WebAgentOptions) {
    super();
    this.manager = opts.manager;
    this.provider = opts.provider;
    this.maxSteps = opts.maxSteps ?? 10;
    this.goalPrompt = opts.goalPrompt ?? DEFAULT_GOAL_PROMPT;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.temperature = opts.temperature ?? 0;
  }

  /**
   * Browse from `startUrl` toward `goal`. Returns a structured result
   * including every step taken, the final URL, the final extracted
   * content, and a `success` flag (true iff the LLM emitted `done`).
   */
  async browse(goal: string, startUrl: string): Promise<WebAgentResult> {
    const start = Date.now();
    const session = new BrowserSession(this.manager);
    const steps: WebAgentResult['steps'] = [];
    let success = false;
    let finalUrl = startUrl;
    let finalContent = '';

    try {
      await session.start(startUrl);
      const systemPrompt = this.goalPrompt.replace('{goal}', goal);

      for (let step = 1; step <= this.maxSteps; step++) {
        // Gather page state.
        const state = await this.gatherState(session);
        finalUrl = state.url;
        const userMsg = this.buildUserMessage(state);

        this.emit('step:start', { step, reasoning: `step ${step}` });

        // Ask the LLM for the next action.
        let llmText = '';
        let reasoning = '';
        let chosen: LlmActionResponse | null = null;
        try {
          const res = await this.provider.chat({
            systemPrompt,
            maxTokens: this.maxTokens,
            temperature: this.temperature,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMsg },
            ],
          });
          llmText = res.content;
          chosen = this.parseAction(llmText);
          reasoning = chosen?.reasoning ?? llmText.slice(0, 240);
        } catch (err) {
          reasoning = `LLM error: ${err instanceof Error ? err.message : String(err)}`;
          steps.push({
            action: { type: 'extract', mode: 'markdown' },
            result: { error: reasoning },
            reasoning,
          });
          break;
        }

        if (!chosen) {
          steps.push({
            action: { type: 'extract', mode: 'markdown' },
            result: { error: 'LLM response was not parseable JSON' },
            reasoning: llmText.slice(0, 240),
          });
          break;
        }

        if (chosen.action === 'done') {
          success = true;
          // Capture final content before exiting.
          try {
            finalContent = await session.extractMainContent();
          } catch {
            /* ignore */
          }
          steps.push({
            action: { type: 'extract', mode: 'markdown' },
            result: { done: true },
            reasoning,
          });
          break;
        }

        const action = this.toBrowserAction(chosen);
        const actionStart = Date.now();
        let result: unknown;
        let ok = true;
        try {
          result = await this.runAction(session, action);
          if (chosen.action === 'extract') {
            finalContent =
              (result as { content?: string } | undefined)?.content ?? '';
          }
        } catch (err) {
          ok = false;
          result = {
            error: err instanceof Error ? err.message : String(err),
          };
        }
        steps.push({ action, result, reasoning });
        this.emit('step:complete', {
          step,
          action,
          success: ok,
          durationMs: Date.now() - actionStart,
        });
      }

      // If the loop ended without `done`, still capture final state.
      if (!finalContent) {
        try {
          finalContent = await session.extractMainContent();
        } catch {
          /* ignore */
        }
      }
    } finally {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
    }

    const result: WebAgentResult = {
      goal,
      steps,
      finalUrl,
      finalContent,
      durationMs: Date.now() - start,
      stepsTaken: steps.length,
      success,
    };
    this.emit('agent:complete', { result });
    return result;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** Gather the current page state (URL, title, visible text, screenshot b64). */
  private async gatherState(session: BrowserSession): Promise<{
    url: string;
    title: string;
    visibleText: string;
    screenshotBase64?: string;
  }> {
    const pageId = session.currentPageId;
    if (!pageId) throw new Error('WebAgent: no active session page');
    const handle = this.manager.getPage(pageId);
    if (!handle) throw new Error('WebAgent: page handle lost');
    const page = this.manager.getPlaywrightPage(pageId);
    if (!page) throw new Error('WebAgent: page closed');

    const url = handle.url;
    const title = handle.title;
    let visibleText = '';
    try {
      visibleText = await page.evaluate(() => {
        // Crude visible-text extractor: take body innerText, truncate.
        const t = document.body.innerText ?? '';
        return t.length > 8000 ? t.slice(0, 8000) + '\n…[truncated]' : t;
      });
    } catch {
      /* ignore */
    }

    let screenshotBase64: string | undefined;
    try {
      const buf = await this.manager.screenshot(pageId, {
        fullPage: false,
        type: 'png',
      });
      screenshotBase64 = buf.toString('base64');
    } catch {
      /* ignore — screenshots are best-effort */
    }

    return { url, title, visibleText, screenshotBase64 };
  }

  /** Build the user-message text sent to the LLM. */
  private buildUserMessage(state: {
    url: string;
    title: string;
    visibleText: string;
    screenshotBase64?: string;
  }): string {
    return [
      `Current page: ${state.title || '(no title)'}`,
      `URL: ${state.url}`,
      '',
      'Visible text on the page:',
      '----------------------------------------',
      state.visibleText || '(empty)',
      '----------------------------------------',
      '',
      state.screenshotBase64
        ? 'A screenshot was also captured (not shown as text).'
        : 'No screenshot available.',
      '',
      'What action should I take next?',
    ].join('\n');
  }

  /**
   * Parse the LLM's raw response text into an {@link LlmActionResponse}.
   * Tolerates markdown fences and leading/trailing prose.
   */
  private parseAction(raw: string): LlmActionResponse | null {
    let s = raw.trim();
    // Strip markdown code fences if present.
    if (s.startsWith('```')) {
      s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    }
    // Find the first `{` and the matching last `}`.
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    const jsonSlice = s.slice(first, last + 1);
    try {
      const obj = JSON.parse(jsonSlice) as Record<string, unknown>;
      const action = obj['action'];
      if (
        action !== 'click' &&
        action !== 'type' &&
        action !== 'scroll' &&
        action !== 'navigate' &&
        action !== 'extract' &&
        action !== 'done'
      ) {
        return null;
      }
      return {
        action,
        selector: typeof obj['selector'] === 'string' ? obj['selector'] : undefined,
        text: typeof obj['text'] === 'string' ? obj['text'] : undefined,
        url: typeof obj['url'] === 'string' ? obj['url'] : undefined,
        reasoning: typeof obj['reasoning'] === 'string' ? obj['reasoning'] : undefined,
      };
    } catch {
      return null;
    }
  }

  /** Convert an {@link LlmActionResponse} into a {@link BrowserAction}. */
  private toBrowserAction(r: LlmActionResponse): BrowserAction {
    switch (r.action) {
      case 'click':
        return {
          type: 'click',
          selector: r.selector ?? 'body',
        };
      case 'type':
        return {
          type: 'type',
          selector: r.selector ?? 'body',
          text: r.text ?? '',
        };
      case 'scroll':
        return { type: 'scroll', y: 600 };
      case 'navigate':
        return { type: 'navigate', url: r.url ?? 'about:blank' };
      case 'extract':
        return { type: 'extract', mode: 'markdown' };
      case 'done':
        return { type: 'extract', mode: 'markdown' };
    }
  }

  /** Execute one action via the session and return its output. */
  private async runAction(
    session: BrowserSession,
    action: BrowserAction,
  ): Promise<unknown> {
    const results = await session.flow([action]);
    const r = results[0];
    if (!r) throw new Error('WebAgent: action produced no result');
    if (!r.success) throw new Error(r.error ?? 'action failed');
    return r.output;
  }
}

// Re-export LLMMessage type for callers building custom prompts.
export type { LLMMessage };

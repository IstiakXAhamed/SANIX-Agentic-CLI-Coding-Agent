/**
 * @file TokenBudgetEnforcer.ts
 * @description Hard-cap a list of messages at a token budget by iteratively
 * truncating the oldest / least-relevant messages. Two strategies:
 *
 * 1. `drop-oldest` — drop messages from the front (oldest first) until under
 *    budget. Conversation recency is preserved.
 * 2. `truncate-tail` — keep all messages but truncate the longest one's tail
 *    until under budget.
 *
 * Always keeps the system message (index 0 if role === 'system').
 *
 * @packageDocumentation
 */

import type { SlimMessage, TokenProvider } from './types.js';
import { ProviderTokenizer } from './ProviderTokenizer.js';

/** Strategy for fitting messages into a budget. */
export type EnforceStrategy = 'drop-oldest' | 'truncate-tail';

/** Result of {@link TokenBudgetEnforcer.enforce}. */
export interface EnforceResult {
  /** The trimmed message list. */
  messages: SlimMessage[];
  /** Final token count. */
  finalTokens: number;
  /** Original token count. */
  originalTokens: number;
  /** Number of messages dropped (drop-oldest only). */
  droppedCount: number;
  /** Number of characters truncated from message tails (truncate-tail only). */
  truncatedChars: number;
}

/**
 * Hard-cap a message list at a token budget.
 *
 * @example
 * ```ts
 * const r = TokenBudgetEnforcer.enforce(messages, { budget: 4096,
 *   strategy: 'drop-oldest' });
 * r.messages; // fits in 4096 tokens
 * ```
 */
export const TokenBudgetEnforcer = {
  /**
   * @param messages The input messages.
   * @param opts.budget Token budget.
   * @param opts.provider Tokenizer provider. Default `openai`.
   * @param opts.strategy See {@link EnforceStrategy}. Default `drop-oldest`.
   * @param opts.preserveSystem If true (default), system messages are never dropped.
   */
  enforce(
    messages: readonly SlimMessage[],
    opts: { budget: number; provider?: TokenProvider; strategy?: EnforceStrategy; preserveSystem?: boolean },
  ): EnforceResult {
    const tz = new ProviderTokenizer(opts.provider ?? 'openai');
    const strategy = opts.strategy ?? 'drop-oldest';
    const preserveSystem = opts.preserveSystem ?? true;
    const originalTokens = tz.countMessages(messages);
    if (originalTokens <= opts.budget) {
      return { messages: [...messages], finalTokens: originalTokens, originalTokens, droppedCount: 0, truncatedChars: 0 };
    }

    if (strategy === 'drop-oldest') {
      // Start from the back (most recent) and walk backward, accumulating
      // until adding the next message would exceed budget. Always include
      // system messages at the front regardless.
      const systemMsgs = preserveSystem ? messages.filter((m) => m.role === 'system') : [];
      const nonSystem = messages.filter((m) => !(preserveSystem && m.role === 'system'));
      const kept: SlimMessage[] = [];
      let tokens = tz.countMessages(systemMsgs);
      let droppedCount = 0;
      for (let i = nonSystem.length - 1; i >= 0; i--) {
        const cost = tz.countMessage(nonSystem[i]).total;
        if (tokens + cost > opts.budget) {
          droppedCount = nonSystem.length - kept.length;
          break;
        }
        tokens += cost;
        kept.unshift(nonSystem[i]);
      }
      const result = [...systemMsgs, ...kept];
      return { messages: result, finalTokens: tokens, originalTokens, droppedCount, truncatedChars: 0 };
    }

    // truncate-tail: keep all messages; repeatedly truncate the longest
    // content until under budget.
    const working: SlimMessage[] = messages.map((m) => ({ ...m }));
    let truncatedChars = 0;
    let tokens = tz.countMessages(working);
    let guard = 0;
    while (tokens > opts.budget && guard < 10000) {
      // Find the non-system message with the longest content.
      let longestIdx = -1;
      let longestLen = -1;
      for (let i = 0; i < working.length; i++) {
        if (preserveSystem && working[i].role === 'system') continue;
        if (working[i].content.length > longestLen) {
          longestLen = working[i].content.length;
          longestIdx = i;
        }
      }
      if (longestIdx < 0 || longestLen <= 1) break;
      // Trim ~5% of the longest message's content from the tail.
      const trim = Math.max(1, Math.floor(longestLen * 0.05));
      working[longestIdx].content = working[longestIdx].content.slice(0, longestLen - trim);
      truncatedChars += trim;
      tokens = tz.countMessages(working);
      guard++;
    }
    return { messages: working, finalTokens: tokens, originalTokens, droppedCount: 0, truncatedChars };
  },
};

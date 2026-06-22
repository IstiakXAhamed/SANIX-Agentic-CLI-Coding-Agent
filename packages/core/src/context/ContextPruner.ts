/**
 * @file context/ContextPruner.ts
 * @description Intelligent context window management. When conversation
 * history exceeds the budget, the pruner keeps:
 *   - The first user message (sets the goal context).
 *   - The last N messages (most-recent activity).
 *   - "Important milestones" — tool calls with errors, user feedback, and
 *     COMPLETE / ABORT decisions (detected via content heuristics).
 *
 * Token estimation is char-based (`Math.ceil(length / 4)`) per the project
 * rules: install nothing extra.
 *
 * @packageDocumentation
 */

import type { LLMMessage } from '@sanix/providers';
import { estimateTokens } from './TokenBudget.js';

/**
 * Coerce message content (string or ContentBlock[]) to plain text.
 * Image / file blocks are skipped. Used wherever we need to do string
 * operations on a message's content (token estimation, milestone detection,
 * emptiness checks, etc.).
 */
function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}

/**
 * Options for {@link ContextPruner.prune}.
 */
export interface PruneOptions {
  /** Always keep the first user message. Default true. */
  keepFirstUser?: boolean;
  /** Number of most-recent messages to always keep. Default 8. */
  keepLastN?: number;
  /** Keep tool-call messages whose result mentions 'error' or 'fail'. Default true. */
  keepErrorMilestones?: boolean;
  /** Drop assistant messages that are pure tool-call wrappers (no text). Default false. */
  dropEmptyAssistant?: boolean;
}

/**
 * Intelligent conversation-history pruner.
 *
 * @example
 * ```ts
 * const pruner = new ContextPruner();
 * const pruned = pruner.prune(messages, 4000);
 * // pruned has the first user msg + last 8 + any error milestones
 * ```
 */
export class ContextPruner {
  /**
   * Prune a message list to fit `maxTokens`. Returns a new array (the input
   * is not mutated). When the messages already fit, returns the input as-is.
   *
   * @param messages - The full conversation history.
   * @param maxTokens - Maximum tokens the pruned list may occupy.
   * @param opts - Pruning options.
   */
  prune(
    messages: ReadonlyArray<LLMMessage>,
    maxTokens: number,
    opts: PruneOptions = {},
  ): LLMMessage[] {
    if (messages.length === 0) return [];
    const totalTokens = this.estimateListTokens(messages);
    if (totalTokens <= maxTokens) return [...messages];

    const keepFirstUser = opts.keepFirstUser ?? true;
    const keepLastN = opts.keepLastN ?? 8;
    const keepErrorMilestones = opts.keepErrorMilestones ?? true;
    const dropEmptyAssistant = opts.dropEmptyAssistant ?? false;

    // Step 1: Identify the indices to definitely keep.
    const keepIdx = new Set<number>();

    // First user message.
    if (keepFirstUser) {
      const firstUser = messages.findIndex((m) => m.role === 'user');
      if (firstUser >= 0) keepIdx.add(firstUser);
    }

    // Last N messages.
    const lastStart = Math.max(0, messages.length - keepLastN);
    for (let i = lastStart; i < messages.length; i++) keepIdx.add(i);

    // Important milestones.
    if (keepErrorMilestones) {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        if (this.isMilestone(m)) keepIdx.add(i);
      }
    }

    // Step 2: Build the kept list in original order, applying the
    // dropEmptyAssistant filter.
    const kept: LLMMessage[] = [];
    let tokens = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (dropEmptyAssistant && this.isEmptyAssistant(m)) continue;
      if (!keepIdx.has(i)) continue;
      const t = this.estimateMessageTokens(m);
      if (tokens + t > maxTokens) {
        // If this is a "must-keep" milestone, we still try — but if even
        // the milestone alone exceeds the budget, skip it (can't help).
        if (i < lastStart && !this.isMilestone(m)) continue;
        if (tokens + t > maxTokens) continue;
      }
      kept.push(m);
      tokens += t;
    }

    // Step 3: If still over budget (shouldn't happen, but defensive), drop
    // from the middle (keep first + last).
    if (tokens > maxTokens && kept.length > 2) {
      const first = kept[0]!;
      const last = kept[kept.length - 1]!;
      let middle = kept.slice(1, -1);
      while (middle.length > 0 && this.estimateListTokens([first, ...middle, last]) > maxTokens) {
        middle = middle.slice(1);
      }
      return [first, ...middle, last];
    }

    return kept;
  }

  /**
   * Estimate the total token cost of a message list.
   */
  estimateListTokens(messages: ReadonlyArray<LLMMessage>): number {
    return messages.reduce((acc, m) => acc + this.estimateMessageTokens(m), 0);
  }

  /**
   * Estimate the token cost of a single message (content + tool_calls).
   */
  estimateMessageTokens(m: LLMMessage): number {
    let t = estimateTokens(toText(m.content));
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        t += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
      }
    }
    // Small overhead per message for role/tags.
    return t + 4;
  }

  /**
   * Heuristic: is this message an "important milestone" that should survive
   * pruning? True for:
   *   - User messages (feedback).
   *   - Tool messages whose content mentions error/fail/exception.
   *   - Assistant messages whose content mentions COMPLETE/ABORT.
   */
  private isMilestone(m: LLMMessage): boolean {
    if (m.role === 'user') return true;
    const text = toText(m.content).toLowerCase();
    if (/error|fail|exception|traceback|denied|invalid/.test(text)) return true;
    if (/\b(complete|abort|done|finished)\b/.test(text)) return true;
    return false;
  }

  /**
   * Heuristic: is this an assistant message with no text content (only
   * tool_calls)? Such messages can be dropped when their corresponding
   * tool-result messages are also dropped.
   */
  private isEmptyAssistant(m: LLMMessage): boolean {
    return (
      m.role === 'assistant' &&
      toText(m.content).trim().length === 0 &&
      (!m.tool_calls || m.tool_calls.length === 0)
    );
  }
}

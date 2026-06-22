/**
 * @file MessageConsolidator.ts
 * @description Compresses a sequence of LLM messages by merging adjacent
 * low-value messages and summarizing old ones. The four strategies:
 *
 *   1. **Tool call + result pairs** — when an assistant message contains
 *      only tool_calls (no text) and is immediately followed by the
 *      tool result, compress to a single synthetic message:
 *      `tool: <name> → <first 100 chars of result>`.
 *   2. **Consecutive assistant reasoning** — when two adjacent assistant
 *      messages both have text content (no tool calls), merge them into
 *      one (the second is usually a continuation / correction).
 *   3. **Old user messages beyond window** — user messages older than
 *      `windowSize` iterations get summarized (via an optional
 *      `summarizer` callback; if absent, truncated to the first line).
 *   4. **System reminders** — duplicate system messages (same content
 *      modulo whitespace) are de-duplicated to the first occurrence.
 *
 * The consolidator is a pure function over messages — no LLM calls (the
 * summarizer callback is the caller's responsibility, and is optional).
 *
 * @packageDocumentation
 */

import type { LLMMessage } from '@sanix/providers';
import type { ExactTokenizer } from './ExactTokenizer.js';
import { tokenizer as defaultTokenizer } from './ExactTokenizer.js';

/**
 * Coerce a message's content (string or ContentBlock[]) to plain text.
 * Image / file blocks are skipped. Returns '' for empty content.
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
 * Options for {@link MessageConsolidator.consolidate}.
 */
export interface ConsolidateOptions {
  /**
   * Maximum total tokens the consolidated message list may occupy. The
   * consolidator applies strategies in order until the list fits, then
   * returns. If still over after all strategies, the list is returned
   * as-is (the caller's ContextPruner handles the final truncation).
   * Default `Infinity` (consolidate, don't truncate).
   */
  maxTokens?: number;
  /**
   * Optional summarizer callback for old user messages. Receives the
   * text of all messages to summarize; returns a single summary
   * string. When absent, old user messages are truncated to their
   * first line + a `[N more messages summarized]` marker.
   */
  summarizer?: (texts: string[]) => Promise<string>;
  /**
   * Number of recent messages to always preserve verbatim (never
   * summarized). Default 6.
   */
  windowSize?: number;
  /**
   * Whether to apply the tool-call-pair compression. Default true.
   */
  compressToolPairs?: boolean;
  /**
   * Whether to merge consecutive assistant reasoning. Default true.
   */
  mergeAssistantReasoning?: boolean;
  /**
   * Whether to summarize old user messages. Default true.
   */
  summarizeOldUser?: boolean;
  /**
   * Whether to dedupe system reminders. Default true.
   */
  dedupeSystemReminders?: boolean;
}

/**
 * Defaults for {@link ConsolidateOptions}.
 */
const DEFAULTS = {
  maxTokens: Number.POSITIVE_INFINITY,
  windowSize: 6,
  compressToolPairs: true,
  mergeAssistantReasoning: true,
  summarizeOldUser: true,
  dedupeSystemReminders: true,
} as const;

/**
 * The marker inserted when old user messages are summarized without a
 * `summarizer` callback.
 */
const TRUNCATION_MARKER = (n: number): string => `[+${n} earlier messages summarized]`;

/**
 * The marker inserted for compressed tool-call pairs.
 */
const TOOL_PAIR_TEMPLATE = (name: string, preview: string): string =>
  `tool: ${name} → ${preview}`;

/**
 * Length of the result preview in compressed tool-call pairs.
 */
const TOOL_RESULT_PREVIEW_LEN = 100;

/**
 * Helper: total token count of a message list (per the configured
 * tokenizer). Re-computed each call — the consolidator doesn't cache
 * because it's called infrequently (once per context build).
 */
function totalTokens(
  messages: ReadonlyArray<LLMMessage>,
  tok: ExactTokenizer,
): number {
  return tok.countMessages(messages);
}

/**
 * Helper: does this assistant message have only tool_calls (no text)?
 */
function isEmptyAssistantToolCall(m: LLMMessage): boolean {
  return (
    m.role === 'assistant' &&
    toText(m.content).trim().length === 0 &&
    Array.isArray(m.tool_calls) &&
    m.tool_calls.length > 0
  );
}

/**
 * Helper: does this assistant message have text content (reasoning)?
 */
function isReasoningAssistant(m: LLMMessage): boolean {
  return m.role === 'assistant' && toText(m.content).trim().length > 0;
}

/**
 * Helper: truncate a string to its first line + a marker.
 */
function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl < 0 ? text : text.slice(0, nl);
}

/**
 * Message consolidator. Stateless — safe to share across agent loops.
 *
 * @example
 * ```ts
 * const c = new MessageConsolidator();
 * const compact = await c.consolidate(messages, {
 *   maxTokens: 8000,
 *   summarizer: async (texts) => myLLM.summarize(texts),
 * });
 * ```
 */
export class MessageConsolidator {
  private readonly tokenizer: ExactTokenizer;

  /**
   * @param tokenizer Tokenizer for budget tracking. Defaults to the
   *   shared singleton.
   */
  constructor(tokenizer: ExactTokenizer = defaultTokenizer) {
    this.tokenizer = tokenizer;
  }

  /**
   * Consolidate a message list. Returns a new array (the input is not
   * mutated). Strategies are applied in order until `maxTokens` is met
   * or all strategies are exhausted.
   *
   * @param messages The full conversation history.
   * @param opts Consolidation options.
   * @returns A new, possibly-shorter message array.
   */
  async consolidate(
    messages: ReadonlyArray<LLMMessage>,
    opts: ConsolidateOptions = {},
  ): Promise<LLMMessage[]> {
    const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
    const windowSize = opts.windowSize ?? DEFAULTS.windowSize;
    const compressToolPairs = opts.compressToolPairs ?? DEFAULTS.compressToolPairs;
    const mergeAssistantReasoning =
      opts.mergeAssistantReasoning ?? DEFAULTS.mergeAssistantReasoning;
    const summarizeOldUser = opts.summarizeOldUser ?? DEFAULTS.summarizeOldUser;
    const dedupeSystemReminders =
      opts.dedupeSystemReminders ?? DEFAULTS.dedupeSystemReminders;

    let out: LLMMessage[] = [...messages];

    // Strategy 4 (cheapest, applied first): dedupe system reminders.
    if (dedupeSystemReminders) {
      out = this.dedupeSystem(out);
      if (totalTokens(out, this.tokenizer) <= maxTokens) return out;
    }

    // Strategy 1: compress tool-call + result pairs.
    if (compressToolPairs) {
      out = this.compressToolPairsList(out);
      if (totalTokens(out, this.tokenizer) <= maxTokens) return out;
    }

    // Strategy 2: merge consecutive assistant reasoning.
    if (mergeAssistantReasoning) {
      out = this.mergeReasoning(out);
      if (totalTokens(out, this.tokenizer) <= maxTokens) return out;
    }

    // Strategy 3: summarize old user messages.
    if (summarizeOldUser) {
      out = await this.summarizeOld(out, windowSize, opts.summarizer);
      if (totalTokens(out, this.tokenizer) <= maxTokens) return out;
    }

    return out;
  }

  /**
   * Strategy 4: dedupe system messages that are identical modulo
   * whitespace. Keeps the first occurrence; drops the rest.
   */
  private dedupeSystem(messages: ReadonlyArray<LLMMessage>): LLMMessage[] {
    const seen = new Set<string>();
    const out: LLMMessage[] = [];
    for (const m of messages) {
      if (m.role !== 'system') {
        out.push(m);
        continue;
      }
      const key = toText(m.content).replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }

  /**
   * Strategy 1: compress assistant+tool pairs where the assistant
   * message has only tool_calls (no text) and the next message is the
   * matching tool result. Replaces both with a single synthetic
   * `tool`-role message containing a one-line summary.
   *
   * Pairs where the assistant message *also* has reasoning text are
   * preserved (the reasoning is valuable).
   */
  private compressToolPairsList(messages: ReadonlyArray<LLMMessage>): LLMMessage[] {
    const out: LLMMessage[] = [];
    let i = 0;
    while (i < messages.length) {
      const m = messages[i]!;
      const next = messages[i + 1];
      if (
        isEmptyAssistantToolCall(m) &&
        next &&
        next.role === 'tool' &&
        next.tool_call_id === m.tool_calls?.[0]?.id
      ) {
        const toolName = m.tool_calls![0]!.function.name;
        const preview = toText(next.content).slice(0, TOOL_RESULT_PREVIEW_LEN).replace(/\s+/g, ' ');
        out.push({
          role: 'tool',
          content: TOOL_PAIR_TEMPLATE(toolName, preview),
          tool_call_id: next.tool_call_id,
        });
        i += 2;
      } else {
        out.push(m);
        i++;
      }
    }
    return out;
  }

  /**
   * Strategy 2: merge consecutive assistant reasoning messages into
   * one. The merged content is `text1 + "\n\n" + text2`. Tool calls
   * from the second message are dropped (the model already retried).
   */
  private mergeReasoning(messages: ReadonlyArray<LLMMessage>): LLMMessage[] {
    const out: LLMMessage[] = [];
    for (const m of messages) {
      const prev = out[out.length - 1];
      if (
        prev &&
        isReasoningAssistant(prev) &&
        isReasoningAssistant(m) &&
        !m.tool_calls?.length
      ) {
        out[out.length - 1] = {
          ...prev,
          content: `${toText(prev.content)}\n\n${toText(m.content)}`,
        };
      } else {
        out.push(m);
      }
    }
    return out;
  }

  /**
   * Strategy 3: summarize old user messages. Keeps the most recent
   * `windowSize` messages verbatim; replaces older user messages with
   * a single summary message (or a truncation marker if no summarizer
   * was supplied).
   *
   * Non-user messages in the "old" region are kept as-is (assistant
   * reasoning in old history is still valuable; the ContextPruner
   * handles dropping tool-result chaff).
   */
  private async summarizeOld(
    messages: ReadonlyArray<LLMMessage>,
    windowSize: number,
    summarizer: ((texts: string[]) => Promise<string>) | undefined,
  ): Promise<LLMMessage[]> {
    if (messages.length <= windowSize) return [...messages];
    const oldMessages = messages.slice(0, messages.length - windowSize);
    const recent = messages.slice(messages.length - windowSize);

    const oldUserTexts: string[] = oldMessages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''));
    if (oldUserTexts.length === 0) return [...messages];

    let summary: string;
    if (summarizer) {
      try {
        summary = await summarizer(oldUserTexts);
      } catch {
        summary = oldUserTexts.map(firstLine).join('\n');
      }
    } else {
      // No summarizer — truncate each user message to its first line,
      // join, and append a marker.
      const lines = oldUserTexts.map(firstLine);
      summary = `${lines.join('\n')}\n${TRUNCATION_MARKER(oldUserTexts.length - lines.length)}`;
    }

    // Build the new old-region: drop the summarized user messages,
    // keep everything else, prepend the summary as a single user
    // message.
    const kept = oldMessages.filter((m) => m.role !== 'user');
    const summaryMsg: LLMMessage = {
      role: 'user',
      content: `[Summary of earlier conversation]\n${summary}`,
    };
    return [summaryMsg, ...kept, ...recent];
  }
}

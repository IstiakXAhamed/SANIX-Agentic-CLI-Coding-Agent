/**
 * @file ContextCompressor.ts
 * @description Mid-run context compression. When the assembled context
 * approaches the token budget, the compressor applies a sequence of
 * increasingly-aggressive strategies until the context fits:
 *
 *   1. **Truncate tool results** to first/last N lines + a
 *      `[N lines truncated]` marker.
 *   2. **Replace old file contents** with `[file: path, N lines, omitted]`
 *      placeholders (keeps the file's presence visible without the
 *      bytes).
 *   3. **Consolidate messages** via {@link MessageConsolidator} (merges
 *      adjacent tool-call pairs, dedupes system reminders, summarizes
 *      old user messages).
 *   4. **Summarize the oldest N messages** into one (via an optional
 *      callback; if absent, drops them with a marker).
 *   5. **Drop lowest-importance memories** — removes memories whose
 *      `importance` field (in metadata) is below a threshold.
 *
 * Each strategy is tried in order; the compressor stops as soon as the
 * context fits. This guarantees minimal information loss — the most
 * aggressive strategies only fire when the cheaper ones weren't enough.
 *
 * @packageDocumentation
 */

import type { LLMMessage } from '@sanix/providers';
import { tokenizer as defaultTokenizer } from './ExactTokenizer.js';
import type { ExactTokenizer } from './ExactTokenizer.js';
import { MessageConsolidator } from './MessageConsolidator.js';
import type { BuiltContext } from './types.js';

/**
 * Coerce message content (string or ContentBlock[]) to plain text.
 * Image / file blocks are skipped.
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
 * Options for {@link ContextCompressor.compress}.
 */
export interface CompressOptions {
  /**
   * Optional summarizer callback for strategy 4 (summarize oldest
   * messages). When absent, the oldest messages are dropped with a
   * marker.
   */
  summarizer?: (texts: string[]) => Promise<string>;
  /**
   * Number of lines to keep at the head and tail when truncating tool
   * results (strategy 1). Default 10 each.
   */
  toolResultHeadTailLines?: number;
  /**
   * Number of oldest messages to summarize in strategy 4. Default 4.
   */
  summarizeOldestN?: number;
  /**
   * Importance threshold for strategy 5 — memories with `importance`
   * below this are dropped. Default 0.3.
   */
  memoryImportanceFloor?: number;
  /**
   * Whether to apply each strategy. All default to true.
   */
  truncateToolResults?: boolean;
  omitOldFiles?: boolean;
  consolidateMessages?: boolean;
  summarizeOldest?: boolean;
  dropLowImportanceMemories?: boolean;
}

/**
 * Defaults for {@link CompressOptions}.
 */
const DEFAULTS = {
  toolResultHeadTailLines: 10,
  summarizeOldestN: 4,
  memoryImportanceFloor: 0.3,
  truncateToolResults: true,
  omitOldFiles: true,
  consolidateMessages: true,
  summarizeOldest: true,
  dropLowImportanceMemories: true,
} as const;

/**
 * Marker for truncated tool results.
 */
const TOOL_TRUNC_MARKER = (n: number): string => `[${n} lines truncated]`;

/**
 * Marker for omitted file contents.
 */
const FILE_OMIT_MARKER = (path: string, lines: number): string =>
  `[file: ${path}, ${lines} lines, omitted]`;

/**
 * Marker for summarized oldest messages.
 */
const SUMMARY_MARKER = (n: number): string =>
  `[${n} oldest messages summarized]`;

/**
 * Detect whether a message looks like a tool result (role === 'tool'
 * OR content starts with `tool:` from a prior consolidation pass).
 */
function isToolResultMessage(m: LLMMessage): boolean {
  if (m.role === 'tool') return true;
  return m.role === 'user' && /^tool:\s+\S+\s+→/.test(toText(m.content));
}

/**
 * Count the lines in `text`.
 */
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/**
 * Truncate a multi-line string to its first `head` + last `tail` lines,
 * inserting a `[N lines truncated]` marker in the middle.
 */
function headTailTruncate(text: string, head: number, tail: number): string {
  const lines = text.split('\n');
  if (lines.length <= head + tail) return text;
  const headLines = lines.slice(0, head);
  const tailLines = lines.slice(lines.length - tail);
  const omitted = lines.length - head - tail;
  return `${headLines.join('\n')}\n${TOOL_TRUNC_MARKER(omitted)}\n${tailLines.join('\n')}`;
}

/**
 * Compute the total token cost of a {@link BuiltContext}.
 */
function contextTokens(ctx: BuiltContext, tok: ExactTokenizer): number {
  return (
    tok.count(ctx.system) +
    tok.count(ctx.memory) +
    tok.count(ctx.plan) +
    tok.count(ctx.context) +
    tok.countMessages(ctx.history)
  );
}

/**
 * Mid-run context compressor.
 *
 * @example
 * ```ts
 * const c = new ContextCompressor();
 * const compact = await c.compress(ctx, 8000);
 * // ctx is unchanged; compact is a new (possibly-smaller) BuiltContext
 * ```
 */
export class ContextCompressor {
  private readonly tokenizer: ExactTokenizer;
  private readonly consolidator: MessageConsolidator;

  /**
   * @param tokenizer Tokenizer for budget tracking. Defaults to the
   *   shared singleton.
   */
  constructor(tokenizer: ExactTokenizer = defaultTokenizer) {
    this.tokenizer = tokenizer;
    this.consolidator = new MessageConsolidator(tokenizer);
  }

  /**
   * Compress `ctx` until it fits in `targetTokens`. Returns a new
   * context (the input is not mutated). Strategies are applied in
   * order; the compressor stops as soon as the context fits.
   *
   * @param ctx The current built context.
   * @param targetTokens Maximum tokens the compressed context may occupy.
   * @param opts Strategy options.
   * @returns A new, possibly-smaller {@link BuiltContext}.
   */
  async compress(
    ctx: BuiltContext,
    targetTokens: number,
    opts: CompressOptions = {},
  ): Promise<BuiltContext> {
    let out: BuiltContext = { ...ctx, history: [...ctx.history] };
    if (contextTokens(out, this.tokenizer) <= targetTokens) return out;

    // Strategy 1: truncate tool results.
    if (opts.truncateToolResults ?? DEFAULTS.truncateToolResults) {
      out = this.truncateToolResultsStrategy(
        out,
        opts.toolResultHeadTailLines ?? DEFAULTS.toolResultHeadTailLines,
      );
      if (contextTokens(out, this.tokenizer) <= targetTokens) return out;
    }

    // Strategy 2: omit old file contents.
    if (opts.omitOldFiles ?? DEFAULTS.omitOldFiles) {
      out = this.omitOldFilesStrategy(out);
      if (contextTokens(out, this.tokenizer) <= targetTokens) return out;
    }

    // Strategy 3: consolidate messages.
    if (opts.consolidateMessages ?? DEFAULTS.consolidateMessages) {
      out = {
        ...out,
        history: await this.consolidator.consolidate(out.history, {
          maxTokens: Math.floor(out.tokens.history * 0.8),
          summarizer: opts.summarizer,
        }),
      };
      if (contextTokens(out, this.tokenizer) <= targetTokens) return out;
    }

    // Strategy 4: summarize oldest N messages.
    if (opts.summarizeOldest ?? DEFAULTS.summarizeOldest) {
      out = await this.summarizeOldestStrategy(
        out,
        opts.summarizeOldestN ?? DEFAULTS.summarizeOldestN,
        opts.summarizer,
      );
      if (contextTokens(out, this.tokenizer) <= targetTokens) return out;
    }

    // Strategy 5: drop low-importance memories.
    if (opts.dropLowImportanceMemories ?? DEFAULTS.dropLowImportanceMemories) {
      out = this.dropLowImportanceMemoriesStrategy(
        out,
        opts.memoryImportanceFloor ?? DEFAULTS.memoryImportanceFloor,
      );
      // Last strategy — return whatever we have.
    }

    return out;
  }

  /**
   * Strategy 1: truncate tool-result messages to head/tail lines.
   */
  private truncateToolResultsStrategy(
    ctx: BuiltContext,
    headTail: number,
  ): BuiltContext {
    const history = ctx.history.map((m) => {
      if (!isToolResultMessage(m)) return m;
      const text = toText(m.content);
      if (lineCount(text) <= headTail * 2) return m;
      return {
        ...m,
        content: headTailTruncate(text, headTail, headTail),
      };
    });
    return { ...ctx, history };
  }

  /**
   * Strategy 2: replace file-content blocks in `ctx.context` with
   * omission markers. A "file block" is a section starting with the
   * `── <path> ──` delimiter (the format used by
   * `TokenBudget.smartFileContext`).
   */
  private omitOldFilesStrategy(ctx: BuiltContext): BuiltContext {
    if (!ctx.context) return ctx;
    // Split on the `── <path> ──` delimiter, keeping the delimiter.
    const blocks = ctx.context.split(/(?=── .+ ──)/);
    if (blocks.length <= 1) return ctx;
    const out: string[] = [];
    for (const block of blocks) {
      const match = /^── (.+) ──/.exec(block);
      if (!match) {
        out.push(block);
        continue;
      }
      const path = match[1]!;
      const lines = lineCount(block);
      // Keep the first block fully (it's the most-recently-loaded
      // file); omit the rest.
      if (out.length === 0) {
        out.push(block);
      } else {
        out.push(FILE_OMIT_MARKER(path, lines));
      }
    }
    return { ...ctx, context: out.join('\n') };
  }

  /**
   * Strategy 4: summarize the oldest N messages into one. If a
   * summarizer is supplied, it receives the text of those messages and
   * returns a single summary. If absent, the messages are dropped and
   * replaced with a marker.
   */
  private async summarizeOldestStrategy(
    ctx: BuiltContext,
    n: number,
    summarizer: ((texts: string[]) => Promise<string>) | undefined,
  ): Promise<BuiltContext> {
    if (ctx.history.length <= n) return ctx;
    const oldest = ctx.history.slice(0, n);
    const rest = ctx.history.slice(n);

    const texts: string[] = oldest.map((m) => toText(m.content));
    let summaryContent: string;
    if (summarizer) {
      try {
        summaryContent = await summarizer(texts);
      } catch {
        summaryContent = SUMMARY_MARKER(n);
      }
    } else {
      summaryContent = SUMMARY_MARKER(n);
    }

    const summaryMsg: LLMMessage = {
      role: 'user',
      content: `[Summary of oldest ${n} messages]\n${summaryContent}`,
    };
    return { ...ctx, history: [summaryMsg, ...rest] };
  }

  /**
   * Strategy 5: drop memories whose `importance` metadata is below the
   * floor. The memory section is line-based (`[tier] content`); each
   * line is examined. Lines without an explicit importance marker are
   * kept (we can't judge them).
   *
   * The importance is parsed from a trailing `[importance=0.X]` marker
   * if present (the `MemoryRouter` doesn't currently emit this, but
   * callers can add it when formatting).
   */
  private dropLowImportanceMemoriesStrategy(
    ctx: BuiltContext,
    floor: number,
  ): BuiltContext {
    if (!ctx.memory) return ctx;
    const lines = ctx.memory.split('\n');
    const kept = lines.filter((line) => {
      const m = /\[importance=([0-9.]+)\]/.exec(line);
      if (!m) return true; // keep lines without an importance marker
      const imp = parseFloat(m[1]!);
      return !Number.isNaN(imp) && imp >= floor;
    });
    return { ...ctx, memory: kept.join('\n') };
  }
}

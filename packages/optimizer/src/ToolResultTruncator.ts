/**
 * @file ToolResultTruncator.ts
 * @description Smart truncation of tool results *before* they enter the
 * agent's context. Type-aware: detects whether the result is JSON,
 * code, logs, markdown, or generic text and applies a content-
 * appropriate truncation strategy.
 *
 * Strategies:
 *   - **JSON**: keep the object structure, omit large array elements
 *     (replace with `[N items omitted]`).
 *   - **Code**: keep imports + the first signature + first/last N lines.
 *   - **Logs**: keep the first line + last N lines + any line matching
 *     `error|warn|fail|exception|traceback`.
 *   - **Markdown**: keep all headers + the first paragraph per section.
 *   - **Generic text**: keep the first/last N lines.
 *
 * Auto-detection uses heuristics on the first 500 chars (parses as
 * JSON, looks for code signals, looks for log patterns, looks for
 * markdown headers).
 *
 * @packageDocumentation
 */

import { tokenizer as defaultTokenizer } from './ExactTokenizer.js';
import type { ExactTokenizer } from './ExactTokenizer.js';

/**
 * The kind of tool result, used to pick the truncation strategy.
 */
export type ToolResultType = 'json' | 'code' | 'logs' | 'markdown' | 'text';

/**
 * Options for {@link ToolResultTruncator.truncate}.
 */
export interface TruncateOptions {
  /** Maximum tokens the truncated result may occupy. Default 4000. */
  maxTokens?: number;
  /**
   * Force a specific type. Default `'auto'` (auto-detect). When
   * auto-detecting, the truncator inspects the first 500 chars.
   */
  type?: ToolResultType | 'auto';
  /**
   * Number of lines to keep at the head and tail for code/log/text
   * truncation. Default 15 each.
   */
  headTailLines?: number;
  /**
   * Maximum number of array elements to keep per JSON array before
   * collapsing the rest. Default 5.
   */
  maxJsonArrayElements?: number;
}

/**
 * Defaults for {@link TruncateOptions}.
 */
const DEFAULTS = {
  maxTokens: 4000,
  headTailLines: 15,
  maxJsonArrayElements: 5,
} as const;

/**
 * Regex matching common source-code structural signals — used by
 * {@link detectType} to decide whether a string is "code". Mirrors the
 * heuristic in `@sanix/core`'s TokenBudget.
 */
const CODE_SIGNAL =
  /(?:^|\n)\s*(?:import\s|export\s|const\s|let\s|var\s|function\s|class\s|def\s|return\s|if\s*\(|for\s*\(|while\s*\()/;

/**
 * Regex matching markdown headers.
 */
const MARKDOWN_HEADER = /(?:^|\n)\s{0,3}#{1,6}\s+\S/;

/**
 * Regex matching log-like lines (timestamp + level + message).
 */
const LOG_LINE =
  /^\s*(?:\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|\[[A-Z]+\])\s+/m;

/**
 * Regex matching error/warn lines (case-insensitive).
 */
const ERROR_LINE = /\b(error|warn(ing)?|fail(ed)?|exception|traceback|fatal)\b/i;

/**
 * Auto-detect the type of a tool result by inspecting the first 500
 * chars.
 */
function detectType(text: string): ToolResultType {
  const sample = text.slice(0, 500);
  if (sample.trim().length === 0) return 'text';

  // JSON: parses as JSON (object or array).
  try {
    const parsed = JSON.parse(sample);
    if (typeof parsed === 'object' && parsed !== null) return 'json';
  } catch {
    // Partial-JSON heuristic: starts with `{`/`[` and has dense `":`.
    const trimmed = sample.trim();
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      const markers = (trimmed.match(/"\s*:/g) ?? []).length;
      if (markers >= 2) return 'json';
    }
  }

  // Logs: looks like a timestamped log.
  if (LOG_LINE.test(sample) || ERROR_LINE.test(sample)) return 'logs';

  // Markdown: starts with or contains a header.
  if (MARKDOWN_HEADER.test(sample)) return 'markdown';

  // Code: structural signals.
  if (CODE_SIGNAL.test(sample)) return 'code';

  return 'text';
}

/**
 * Count the lines in `text`.
 */
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/**
 * Keep the first `head` + last `tail` lines of `text`, with a marker.
 */
function headTail(text: string, head: number, tail: number): string {
  const lines = text.split('\n');
  if (lines.length <= head + tail) return text;
  const omitted = lines.length - head - tail;
  return `${lines.slice(0, head).join('\n')}\n... (${omitted} lines truncated) ...\n${lines.slice(lines.length - tail).join('\n')}`;
}

/**
 * JSON-aware truncation. Walks the parsed structure and replaces any
 * array with more than `maxArrayElements` items with the first N +
 * a `[N items omitted]` placeholder. Recurses into nested objects.
 *
 * If the JSON can't be parsed (the input was only JSON-ish), falls
 * back to text truncation.
 */
function truncateJson(
  text: string,
  maxArrayElements: number,
  maxTokens: number,
  tok: ExactTokenizer,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not valid JSON — fall back to text truncation.
    return truncateText(text, maxTokens, DEFAULTS.headTailLines, tok);
  }

  const collapsed = collapseArrays(parsed, maxArrayElements);
  let out = JSON.stringify(collapsed, null, 2);
  if (tok.count(out) <= maxTokens) return out;

  // Still too big — fall back to head/tail truncation of the
  // re-serialized JSON.
  out = headTail(out, DEFAULTS.headTailLines, DEFAULTS.headTailLines);
  return out;
}

/**
 * Recursively collapse arrays with more than `max` elements. Returns a
 * new structure (the input is not mutated).
 */
function collapseArrays(node: unknown, max: number): unknown {
  if (Array.isArray(node)) {
    if (node.length > max) {
      const head = node.slice(0, max).map((n) => collapseArrays(n, max));
      return [...head, `[${node.length - max} items omitted]`];
    }
    return node.map((n) => collapseArrays(n, max));
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = collapseArrays(v, max);
    }
    return out;
  }
  return node;
}

/**
 * Code-aware truncation. Keeps:
 *   - All `import` / `require` lines.
 *   - The first function/class/def signature.
 *   - The first N + last N lines of the rest.
 */
function truncateCode(
  text: string,
  lineCount: number,
  maxTokens: number,
  tok: ExactTokenizer,
): string {
  const lines = text.split('\n');
  const imports: string[] = [];
  const signatures: string[] = [];
  const body: string[] = [];

  for (const line of lines) {
    if (/^\s*(?:import\s|export\s.+from\s|const\s+\w+\s*=\s*require\()/.test(line)) {
      imports.push(line);
    } else if (
      signatures.length < 3 &&
      /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|interface|type)\s+\w+/.test(line)
    ) {
      signatures.push(line);
    } else {
      body.push(line);
    }
  }

  const header = [...imports, '', ...signatures].join('\n');
  const bodyTruncated = headTail(body.join('\n'), lineCount, lineCount);
  const out = `${header}\n\n${bodyTruncated}`;
  if (tok.count(out) <= maxTokens) return out;
  // Still too big — keep just the header.
  return header;
}

/**
 * Log-aware truncation. Keeps:
 *   - The first line (often a header / startup banner).
 *   - The last N lines (the most recent activity).
 *   - Any line matching `error|warn|fail|exception|traceback`.
 */
function truncateLogs(
  text: string,
  tail: number,
  maxTokens: number,
  tok: ExactTokenizer,
): string {
  const lines = text.split('\n');
  if (lines.length === 0) return text;
  const first = lines[0]!;
  const last = lines.slice(Math.max(0, lines.length - tail));
  const errors = lines.filter((l) => ERROR_LINE.test(l));

  const sections = [
    first,
    errors.length > 0 ? `\n--- Errors/Warnings (${errors.length}) ---\n${errors.join('\n')}` : '',
    `\n--- Last ${last.length} lines ---\n${last.join('\n')}`,
  ];
  const out = sections.join('');
  if (tok.count(out) <= maxTokens) return out;
  // Still too big — drop the errors section.
  return `${first}\n--- Last ${last.length} lines ---\n${last.join('\n')}`;
}

/**
 * Markdown-aware truncation. Keeps all headers + the first paragraph
 * (text up to the next blank line) per section.
 */
function truncateMarkdown(
  text: string,
  maxTokens: number,
  tok: ExactTokenizer,
): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inParagraph = false;
  let paraLines: string[] = [];

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      // Header — always keep.
      if (paraLines.length > 0) {
        out.push(paraLines[0]!); // first line of the previous paragraph
        paraLines = [];
      }
      out.push(line);
      inParagraph = false;
    } else if (line.trim() === '') {
      // Blank line — paragraph boundary.
      if (paraLines.length > 0) {
        out.push(paraLines[0]!);
        paraLines = [];
      }
      inParagraph = false;
    } else {
      // Body line — keep only the first of each paragraph.
      if (!inParagraph) {
        paraLines.push(line);
        inParagraph = true;
      }
    }
  }
  if (paraLines.length > 0) out.push(paraLines[0]!);

  const result = out.join('\n');
  if (tok.count(result) <= maxTokens) return result;
  // Still too big — fall back to head/tail.
  return headTail(result, DEFAULTS.headTailLines, DEFAULTS.headTailLines);
}

/**
 * Generic text truncation: head/tail lines.
 */
function truncateText(
  text: string,
  maxTokens: number,
  lineCount: number,
  tok: ExactTokenizer,
): string {
  if (tok.count(text) <= maxTokens) return text;
  return headTail(text, lineCount, lineCount);
}

/**
 * Smart tool-result truncator.
 *
 * @example
 * ```ts
 * const t = new ToolResultTruncator();
 * const longJson = JSON.stringify(hugeArray);
 * const compact = t.truncate(longJson, { maxTokens: 2000, type: 'json' });
 * // compact has the first 5 array elements + "[N items omitted]"
 * ```
 */
export class ToolResultTruncator {
  private readonly tokenizer: ExactTokenizer;

  /**
   * @param tokenizer Tokenizer for budget tracking. Defaults to the
   *   shared singleton.
   */
  constructor(tokenizer: ExactTokenizer = defaultTokenizer) {
    this.tokenizer = tokenizer;
  }

  /**
   * Truncate a tool result. The result is examined (or the caller-
   * supplied `type` is used), the appropriate strategy is applied,
   * and the truncated string is returned.
   *
   * @param result The raw tool result string.
   * @param opts Truncation options.
   * @returns A possibly-shorter string. If `result` is already within
   *   `maxTokens`, it's returned unchanged.
   */
  truncate(result: string, opts: TruncateOptions = {}): string {
    const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
    const headTailLines = opts.headTailLines ?? DEFAULTS.headTailLines;
    const maxJsonArray = opts.maxJsonArrayElements ?? DEFAULTS.maxJsonArrayElements;
    const type = opts.type ?? 'auto';

    if (this.tokenizer.count(result) <= maxTokens) return result;

    const detected = type === 'auto' ? detectType(result) : type;
    switch (detected) {
      case 'json':
        return truncateJson(result, maxJsonArray, maxTokens, this.tokenizer);
      case 'code':
        return truncateCode(result, headTailLines, maxTokens, this.tokenizer);
      case 'logs':
        return truncateLogs(result, headTailLines, maxTokens, this.tokenizer);
      case 'markdown':
        return truncateMarkdown(result, maxTokens, this.tokenizer);
      case 'text':
      default:
        return truncateText(result, maxTokens, headTailLines, this.tokenizer);
    }
  }

  /**
   * Detect the type of a tool result (exposed publicly so callers can
   * inspect what the truncator would do without actually truncating).
   */
  detect(result: string): ToolResultType {
    return detectType(result);
  }

  /**
   * Estimate the token cost of a tool result. Convenience wrapper
   * around the configured tokenizer.
   */
  tokens(result: string): number {
    return this.tokenizer.count(result);
  }
}

/**
 * Re-export lineCount for tests / TUI rendering.
 */
export { lineCount };

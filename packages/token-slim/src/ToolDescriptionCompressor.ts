/**
 * @file ToolDescriptionCompressor.ts
 * @description Shorten tool descriptions for inclusion in the system prompt.
 * Many tools ship with multi-paragraph descriptions intended for humans;
 * the LLM only needs the verb + object + key constraints. This module
 * extracts the first sentence, drops examples / "see also" lines, and
 * truncates to a max length.
 *
 * @packageDocumentation
 */

import type { ToolDescription } from './types.js';

/**
 * Options for {@link ToolDescriptionCompressor.compress} and
 * {@link ToolDescriptionCompressor.compressMany}.
 */
export interface ToolCompressOptions {
  /** Max characters per description. Default 200. */
  maxLength?: number;
  /** If true, drop "Example:" / "Examples:" / "See also:" lines. Default true. */
  dropExamples?: boolean;
  /** If true, keep only the first sentence. Default true. */
  firstSentenceOnly?: boolean;
}

/** Result of compressing one tool description. */
export interface CompressedTool {
  /** Original tool name. */
  name: string;
  /** Compressed description. */
  description: string;
  /** Original character count. */
  originalChars: number;
  /** Compressed character count. */
  compressedChars: number;
  /** Optional parameters schema, passed through unchanged. */
  parametersSchema?: Record<string, unknown>;
}

/**
 * Compress tool descriptions to fit more tools in the prompt budget.
 *
 * @example
 * ```ts
 * const slim = ToolDescriptionCompressor.compressMany(tools, { maxLength: 160 });
 * ```
 */
export const ToolDescriptionCompressor = {
  /**
   * Compress a single tool description.
   *
   * @param tool The tool.
   * @param opts See {@link ToolCompressOptions}.
   */
  compress(tool: ToolDescription, opts: ToolCompressOptions = {}): CompressedTool {
    const maxLength = opts.maxLength ?? 200;
    const dropExamples = opts.dropExamples ?? true;
    const firstSentenceOnly = opts.firstSentenceOnly ?? true;
    const originalChars = tool.description.length;
    let desc = tool.description;

    if (dropExamples) {
      // Drop lines starting with "Example:" / "Examples:" / "See also:" through end-of-line.
      desc = desc.replace(/^(example[s]?|see also|note[s]?|warning[s]?)\s*:.*$/gim, '');
    }
    if (firstSentenceOnly) {
      const m = desc.match(/^[^.!?]*[.!?]/);
      if (m) desc = m[0];
    }
    desc = desc.replace(/\s+/g, ' ').trim();
    if (desc.length > maxLength) {
      desc = desc.slice(0, maxLength - 1).trimEnd() + '…';
    }
    return {
      name: tool.name,
      description: desc,
      originalChars,
      compressedChars: desc.length,
      parametersSchema: tool.parametersSchema,
    };
  },

  /**
   * Compress a list of tool descriptions.
   *
   * @param tools The tools.
   * @param opts See {@link ToolCompressOptions}.
   */
  compressMany(tools: readonly ToolDescription[], opts: ToolCompressOptions = {}): CompressedTool[] {
    return tools.map((t) => this.compress(t, opts));
  },
};

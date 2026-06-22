/**
 * @file CommentFormatter.ts
 * @description Formats {@link ReviewComment}s and {@link ReviewResult}s
 * for different output targets: GitHub/GitLab/Bitbucket/Gitea Markdown
 * (the native PR comment format), plain text (for CLI output), JSON
 * (for machine consumption), and SARIF (for security tooling
 * integration).
 *
 * The formatter is stateless and pure — given the same input it always
 * produces the same output. This makes it easy to snapshot-test.
 *
 * @packageDocumentation
 */

import type { ReviewComment, ReviewResult } from './types.js';

/** Output formats supported by {@link CommentFormatter}. */
export type CommentFormat = 'markdown' | 'text' | 'json' | 'sarif';

/** Options accepted by {@link CommentFormatter.formatReview}. */
export interface FormatOptions {
  /** Output format. Default `'markdown'`. */
  readonly format?: CommentFormat;
  /** Whether to include the per-comment suggestion block. Default `true`. */
  readonly includeSuggestions?: boolean;
  /** Maximum number of comments to include (`0` = all). Default `0`. */
  readonly maxComments?: number;
}

/**
 * Formats reviews and comments for different output targets.
 *
 * ```ts
 * const fmt = new CommentFormatter();
 * console.log(fmt.formatReview(result, { format: 'markdown' }));
 * ```
 */
export class CommentFormatter {
  /**
   * Format a single comment in the requested format.
   *
   * @param c       - The comment to format.
   * @param format  - Output format. Default `'markdown'`.
   */
  formatComment(c: ReviewComment, format: CommentFormat = 'markdown'): string {
    switch (format) {
      case 'json':
        return JSON.stringify(c);
      case 'text':
        return `${c.severity.toUpperCase()} ${c.path}:${c.line} [${c.ruleId}] ${c.body}`;
      case 'sarif':
        return JSON.stringify(this.#toSarif(c));
      case 'markdown':
      default: {
        const lines = [
          `**${c.severity.toUpperCase()}** — \`${c.ruleId}\``,
          '',
          `${c.path}:${c.line}`,
          '',
          c.body,
        ];
        if (c.suggestion) lines.push('', '```suggestion', c.suggestion, '```');
        return lines.join('\n');
      }
    }
  }

  /**
   * Format an entire review (summary + all comments) in the requested
   * format.
   *
   * @param result  - The review to format.
   * @param options - Format options (see {@link FormatOptions}).
   */
  formatReview(result: ReviewResult, options: FormatOptions = {}): string {
    const format = options.format ?? 'markdown';
    const includeSuggestions = options.includeSuggestions ?? true;
    const max = options.maxComments ?? 0;
    const comments = max > 0 ? result.comments.slice(0, max) : result.comments;
    switch (format) {
      case 'json':
        return JSON.stringify({ ...result, comments }, null, 2);
      case 'sarif':
        return JSON.stringify(this.#reviewToSarif(result), null, 2);
      case 'text': {
        const lines: string[] = [
          `=== SANIX Review: ${result.state.toUpperCase()} (${result.durationMs}ms) ===`,
          result.summary,
          '',
        ];
        for (const c of comments) {
          lines.push(this.formatComment(c, 'text'));
        }
        if (result.comments.length > comments.length) {
          lines.push(`... and ${result.comments.length - comments.length} more`);
        }
        return lines.join('\n');
      }
      case 'markdown':
      default: {
        const lines: string[] = [result.summary, ''];
        const byRule = this.#groupByRule(comments);
        for (const [ruleId, cs] of byRule) {
          lines.push(`### \`${ruleId}\` (${cs.length})`);
          for (const c of cs) {
            lines.push(`- \`${c.path}:${c.line}\` — **${c.severity}** ${c.body}`);
            if (includeSuggestions && c.suggestion) {
              lines.push('  ```suggestion', `  ${c.suggestion}`, '  ```');
            }
          }
          lines.push('');
        }
        if (result.comments.length > comments.length) {
          lines.push(`_… and ${result.comments.length - comments.length} more findings omitted._`);
        }
        return lines.join('\n');
      }
    }
  }

  /** Group comments by rule id, preserving first-seen order. */
  #groupByRule(comments: readonly ReviewComment[]): Map<string, ReviewComment[]> {
    const out = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const arr = out.get(c.ruleId) ?? [];
      arr.push(c);
      out.set(c.ruleId, arr);
    }
    return out;
  }

  /** Convert a comment to a SARIF result object. */
  #toSarif(c: ReviewComment): Record<string, unknown> {
    return {
      ruleId: c.ruleId,
      level: this.#sarifLevel(c.severity),
      message: { text: c.body },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: c.path },
            region: { startLine: c.line, endLine: c.endLine ?? c.line },
          },
        },
      ],
    };
  }

  /** Convert a review to a SARIF report object. */
  #reviewToSarif(result: ReviewResult): Record<string, unknown> {
    return {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: '@sanix/prbot', version: '1.0.0' } },
          results: result.comments.map((c) => this.#toSarif(c)),
        },
      ],
    };
  }

  /** Map our severity to SARIF's `level` enum. */
  #sarifLevel(severity: ReviewComment['severity']): 'none' | 'note' | 'warning' | 'error' {
    switch (severity) {
      case 'blocker':
      case 'error':
        return 'error';
      case 'warning':
        return 'warning';
      case 'suggestion':
      case 'nit':
      case 'info':
        return 'note';
      default:
        return 'none';
    }
  }
}

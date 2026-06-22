/**
 * @file PRBot.ts
 * @description Top-level orchestrator that wires together a
 * {@link PlatformClient}, a {@link PRFetcher}, a {@link ReviewEngine},
 * and a {@link CommentFormatter}. Consumers create a bot with a
 * {@link PRBotConfig} and call {@link PRBot.review} to fetch a PR, run
 * the rules, optionally post the review, and return the structured
 * {@link ReviewResult}.
 *
 * The bot is the only class most consumers need to import directly:
 *
 * ```ts
 * const bot = new PRBot({
 *   platform: 'github',
 *   client: { credentials: { token: process.env.GITHUB_TOKEN! }, owner: 'sanix-ahmed', repo: 'sanix' },
 * });
 * const result = await bot.review(42);
 * console.log(result.state, result.comments.length);
 * ```
 *
 * @packageDocumentation
 */

import { CommentFormatter } from './CommentFormatter.js';
import { PRFetcher } from './PRFetcher.js';
import { ReviewEngine } from './ReviewEngine.js';
import { createPlatformClient } from './platforms/index.js';
import type {
  PlatformClient,
  PRBotConfig,
  PullRequest,
  ReviewResult,
} from './types.js';

/**
 * Top-level PR review orchestrator.
 */
export class PRBot {
  /** Platform client used to fetch PRs and post reviews. */
  readonly client: PlatformClient;
  /** PR fetcher (with caching + filters). */
  readonly fetcher: PRFetcher;
  /** Review engine (with 52 built-in rules). */
  readonly engine: ReviewEngine;
  /** Comment / review formatter. */
  readonly formatter: CommentFormatter;
  /** Whether to actually post the review to the platform. */
  readonly #postReview: boolean;

  /**
   * @param config - Bot configuration (see {@link PRBotConfig}).
   */
  constructor(config: PRBotConfig) {
    this.client = createPlatformClient(config.platform, config.client);
    this.fetcher = new PRFetcher(this.client);
    this.engine = new ReviewEngine();
    this.formatter = new CommentFormatter();
    this.#postReview = config.postReview ?? true;
  }

  /**
   * Review a PR by id. Fetches the PR, runs all enabled rules, optionally
   * posts the review, and returns the structured result.
   *
   * @param prId - PR id (platform-specific).
   * @returns The review result.
   */
  async review(prId: number | string): Promise<ReviewResult> {
    const pr: PullRequest = await this.fetcher.fetch(prId);
    const result = this.engine.review(pr);
    if (this.#postReview) {
      await this.client.postReview(prId, result);
    }
    return result;
  }

  /**
   * Dry-run review: fetch and review a PR without posting anything to
   * the platform. Useful for local testing or CI checks that should not
   * leave comments.
   *
   * @param prId - PR id.
   * @returns The review result (never posted).
   */
  async dryRun(prId: number | string): Promise<ReviewResult> {
    const pr = await this.fetcher.fetch(prId);
    return this.engine.review(pr, { dryRun: true });
  }

  /**
   * Format a review for human consumption using the configured formatter.
   *
   * @param result  - The review to format.
   * @param format  - Output format. Default `'markdown'`.
   */
  format(result: ReviewResult, format: 'markdown' | 'text' | 'json' | 'sarif' = 'markdown'): string {
    return this.formatter.formatReview(result, { format });
  }
}

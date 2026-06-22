/**
 * @file index.ts
 * @description Public entry point for `@sanix/prbot`. Re-exports the
 * bot, fetcher, review engine, comment formatter, webhook handler, and
 * all shared types. Platform clients are available via the
 * `@sanix/prbot/platforms` sub-entry.
 *
 * Importing paths:
 * ```ts
 * import { PRBot, ReviewEngine, CommentFormatter, WebhookHandler } from '@sanix/prbot';
 * import { GitHubClient, GitLabClient } from '@sanix/prbot/platforms';
 * import type { PullRequest, ReviewResult, ReviewComment } from '@sanix/prbot';
 * ```
 *
 * @packageDocumentation
 */

export { PRBot } from './PRBot.js';
export { PRFetcher, type PRFetcherOptions } from './PRFetcher.js';
export { ReviewEngine } from './ReviewEngine.js';
export { CommentFormatter, type CommentFormat, type FormatOptions } from './CommentFormatter.js';
export {
  WebhookHandler,
  type WebhookHandlerFn,
  type WebhookHandlerOptions,
} from './WebhookHandler.js';
export { BUILTIN_RULES } from './rules.js';

export type {
  Platform,
  DiffHunk,
  ReviewComment,
  CommentSeverity,
  PullRequest,
  ReviewResult,
  ReviewState,
  ReviewRule,
  RuleCategory,
  PlatformCredentials,
  PlatformClientOptions,
  PlatformClient,
  WebhookPayload,
  ReviewEngineOptions,
  PRBotConfig,
} from './types.js';

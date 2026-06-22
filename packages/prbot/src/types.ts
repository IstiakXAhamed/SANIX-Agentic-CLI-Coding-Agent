/**
 * @file types.ts
 * @description Shared types for `@sanix/prbot`. Covers the PR model, the
 * platform client interface, review findings, and webhook payloads.
 *
 * @packageDocumentation
 */

/** The set of supported code-hosting platforms. */
export type Platform = 'github' | 'gitlab' | 'bitbucket' | 'gitea';

/** A unified diff hunk extracted from a PR. */
export interface DiffHunk {
  /** Path to the file the hunk belongs to. */
  readonly path: string;
  /** Starting line number in the old version (1-based). */
  readonly oldStart: number;
  /** Starting line number in the new version (1-based). */
  readonly newStart: number;
  /** Number of lines in the old version. */
  readonly oldLines: number;
  /** Number of lines in the new version. */
  readonly newLines: number;
  /** Raw hunk body (lines starting with ` `, `+`, or `-`). */
  readonly body: string;
  /** Whether the file was added (`true`), deleted (`false`), or modified (`undefined`). */
  readonly status?: 'added' | 'removed' | 'modified';
}

/** A code review comment anchored to a line range. */
export interface ReviewComment {
  /** Path to the file the comment is on. */
  readonly path: string;
  /** Starting line in the new version (1-based). */
  readonly line: number;
  /** Ending line in the new version (inclusive). Defaults to `line`. */
  readonly endLine?: number;
  /** Comment body (Markdown). */
  readonly body: string;
  /** Severity of the finding. */
  readonly severity: CommentSeverity;
  /** Rule id that produced this comment (e.g. `"no-console"`). */
  readonly ruleId: string;
  /** Optional suggestion (Markdown code block) the author can apply. */
  readonly suggestion?: string;
}

/** The severity of a {@link ReviewComment}. */
export type CommentSeverity = 'info' | 'nit' | 'suggestion' | 'warning' | 'error' | 'blocker';

/** A unified PR model used by the review engine. */
export interface PullRequest {
  /** Platform-specific PR id (number for GitHub, iid for GitLab, etc.). */
  readonly id: number | string;
  /** PR title. */
  readonly title: string;
  /** PR description (Markdown). */
  readonly body: string;
  /** Source branch name. */
  readonly sourceBranch: string;
  /** Target branch name. */
  readonly targetBranch: string;
  /** Author login. */
  readonly author: string;
  /** Diff hunks (already parsed). */
  readonly hunks: readonly DiffHunk[];
  /** Files touched by the PR (paths). */
  readonly files: readonly string[];
  /** Number of additions and deletions. */
  readonly additions: number;
  readonly deletions: number;
  /** Optional commit messages. */
  readonly commits?: readonly string[];
}

/** A review produced by the {@link ReviewEngine}. */
export interface ReviewResult {
  /** PR the review applies to. */
  readonly pullRequest: PullRequest;
  /** All comments produced by the rules. */
  readonly comments: readonly ReviewComment[];
  /** Aggregate review state (GitHub-style). */
  readonly state: ReviewState;
  /** Summary message (Markdown). */
  readonly summary: string;
  /** Per-rule counts. */
  readonly ruleCounts: Readonly<Record<string, number>>;
  /** Wall-clock duration of the review in milliseconds. */
  readonly durationMs: number;
}

/** Aggregate review state. */
export type ReviewState = 'approved' | 'commented' | 'changes_requested' | 'blocked';

/** A single review rule. */
export interface ReviewRule {
  /** Stable rule id (kebab-case). */
  readonly id: string;
  /** Human-readable rule name. */
  readonly name: string;
  /** Default severity when the rule fires. */
  readonly severity: CommentSeverity;
  /** Rule category for documentation grouping. */
  readonly category: RuleCategory;
  /** Whether the rule is enabled by default. */
  readonly enabled: boolean;
  /** Whether the rule blocks approval when it fires. */
  readonly blocksApproval: boolean;
  /** Function that evaluates the rule against a PR. */
  readonly evaluate: (pr: PullRequest) => ReviewComment[];
}

/** Categories used to group the 52 rules. */
export type RuleCategory =
  | 'style'
  | 'correctness'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'documentation'
  | 'testing'
  | 'accessibility'
  | 'compatibility'
  | 'metadata';

/** Credentials supplied to a platform client. */
export interface PlatformCredentials {
  /** Bearer token / personal access token. */
  readonly token: string;
  /** Optional username (Bitbucket needs this alongside the token). */
  readonly username?: string;
}

/** Options for constructing a platform client. */
export interface PlatformClientOptions {
  /** Platform-specific base URL (e.g. `https://gitea.example.com`). */
  readonly baseUrl?: string;
  /** Credentials. */
  readonly credentials: PlatformCredentials;
  /** Owner / namespace / project key. */
  readonly owner: string;
  /** Repository name. */
  readonly repo: string;
  /** Optional fetch implementation (defaults to global `fetch`). */
  readonly fetchImpl?: typeof fetch;
}

/** The platform client interface every platform must implement. */
export interface PlatformClient {
  /** The platform this client targets. */
  readonly platform: Platform;
  /** Fetch a PR by id. */
  fetchPR(prId: number | string): Promise<PullRequest>;
  /** Post a review (comments + state) to a PR. */
  postReview(prId: number | string, result: ReviewResult): Promise<void>;
  /** Resolve raw diff text for a PR. */
  fetchRawDiff(prId: number | string): Promise<string>;
}

/** A normalized webhook payload. */
export interface WebhookPayload {
  /** Platform the webhook originated from. */
  readonly platform: Platform;
  /** Event type (e.g. `"pull_request.opened"`). */
  readonly event: string;
  /** PR id the webhook refers to (if any). */
  readonly prId?: number | string;
  /** Repository identifier (`owner/repo`). */
  readonly repo: string;
  /** Raw payload (platform-specific). */
  readonly raw: unknown;
}

/** Options accepted by {@link ReviewEngine.review}. */
export interface ReviewEngineOptions {
  /** Subset of rule ids to run (defaults to all enabled rules). */
  readonly onlyRules?: readonly string[];
  /** Rule ids to disable even if their `enabled` flag is `true`. */
  readonly disableRules?: readonly string[];
  /** Whether to skip rules that block approval (e.g. for dry-run). */
  readonly dryRun?: boolean;
}

/** Configuration for {@link PRBot}. */
export interface PRBotConfig {
  /** Platform to review on. */
  readonly platform: Platform;
  /** Platform client options. */
  readonly client: PlatformClientOptions;
  /** Review engine options. */
  readonly engine?: ReviewEngineOptions;
  /** Whether to actually post the review (`false` = dry-run, no API calls). */
  readonly postReview?: boolean;
}

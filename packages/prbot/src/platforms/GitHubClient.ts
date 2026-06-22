/**
 * @file platforms/GitHubClient.ts
 * @description GitHub platform client. Uses GitHub's REST API v3 to fetch
 * PR metadata + diff and to post reviews via the
 * `POST /repos/{owner}/{repo}/pulls/{pr}/reviews` endpoint.
 *
 * Authentication is via a Bearer token (personal access token or GitHub
 * App installation token). The client supports GitHub Enterprise by
 * overriding `baseUrl` (e.g. `https://github.example.com/api/v3`).
 *
 * @packageDocumentation
 */

import type {
  DiffHunk,
  PlatformClient,
  PlatformClientOptions,
  PullRequest,
  ReviewResult,
} from '../types.js';

/** GitHub-specific default API base. */
const DEFAULT_GITHUB_API = 'https://api.github.com';

/**
 * GitHub platform client.
 *
 * ```ts
 * const client = new GitHubClient({
 *   credentials: { token: process.env.GITHUB_TOKEN! },
 *   owner: 'sanix-ahmed', repo: 'sanix',
 * });
 * const pr = await client.fetchPR(42);
 * ```
 */
export class GitHubClient implements PlatformClient {
  readonly platform = 'github' as const;
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #owner: string;
  readonly #repo: string;
  readonly #fetchImpl: typeof fetch;

  /**
   * @param options - Client configuration (see {@link PlatformClientOptions}).
   */
  constructor(options: PlatformClientOptions) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_GITHUB_API).replace(/\/$/, '');
    this.#token = options.credentials.token;
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch a PR by number. Returns a unified {@link PullRequest} with
   * hunks already parsed from the unified diff.
   *
   * @param prId - PR number.
   */
  async fetchPR(prId: number | string): Promise<PullRequest> {
    const [meta, diffText] = await Promise.all([
      this.#requestJson<GitHubPRMeta>(`/repos/${this.#owner}/${this.#repo}/pulls/${prId}`),
      this.fetchRawDiff(prId),
    ]);
    const hunks = parseUnifiedDiff(diffText);
    return {
      id: meta.number,
      title: meta.title,
      body: meta.body ?? '',
      sourceBranch: meta.head.ref,
      targetBranch: meta.base.ref,
      author: meta.user?.login ?? 'unknown',
      hunks,
      files: meta.files?.map((f) => f.filename) ?? hunks.map((h) => h.path),
      additions: meta.additions,
      deletions: meta.deletions,
      commits: meta.commits ? [String(meta.commits)] : undefined,
    };
  }

  /**
   * Fetch the raw unified diff text for a PR.
   *
   * @param prId - PR number.
   */
  async fetchRawDiff(prId: number | string): Promise<string> {
    return this.#requestText(`/repos/${this.#owner}/${this.#repo}/pulls/${prId}`, 'application/vnd.github.v3.diff');
  }

  /**
   * Post a review to GitHub. Maps the engine's {@link ReviewState} to
   * GitHub's review event types:
   *
   *   - `approved`            → `APPROVE`
   *   - `commented`           → `COMMENT`
   *   - `changes_requested`   → `REQUEST_CHANGES`
   *   - `blocked`             → `COMMENT` (with a blocker summary)
   *
   * @param prId   - PR number.
   * @param result - The review to post.
   */
  async postReview(prId: number | string, result: ReviewResult): Promise<void> {
    const event = result.state === 'approved'
      ? 'APPROVE'
      : result.state === 'changes_requested'
        ? 'REQUEST_CHANGES'
        : 'COMMENT';
    const body = {
      event,
      body: result.summary,
      comments: result.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: 'RIGHT' as const,
        body: formatCommentBody(c),
      })),
    };
    await this.#requestJson(`/repos/${this.#owner}/${this.#repo}/pulls/${prId}/reviews`, 'POST', body);
  }

  /**
   * Internal: perform a JSON GET request with auth + JSON accept headers.
   */
  async #requestJson<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
    const res = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
      method,
      headers: this.#headers('application/vnd.github+json'),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /**
   * Internal: perform a text GET request with a specific Accept header
   * (used for the raw diff endpoint).
   */
  async #requestText(path: string, accept: string): Promise<string> {
    const res = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers: this.#headers(accept),
    });
    if (!res.ok) throw new Error(`GitHub API GET ${path} → ${res.status}: ${await res.text()}`);
    return res.text();
  }

  /** Build the standard header set with auth + accept. */
  #headers(accept: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#token}`,
      Accept: accept,
      'User-Agent': '@sanix/prbot',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
}

/** Subset of the GitHub PR metadata response that we consume. */
interface GitHubPRMeta {
  number: number;
  title: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
  user?: { login: string };
  additions: number;
  deletions: number;
  commits?: number;
  files?: { filename: string }[];
}

/**
 * Parse a unified diff text into a list of {@link DiffHunk} records.
 * Exported so other platform clients can reuse it.
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split('\n');
  let i = 0;
  let currentPath = '';
  let currentStatus: DiffHunk['status'];
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.+?) b\/(.+)$/);
      if (match) currentPath = match[2];
    } else if (line.startsWith('new file mode')) {
      currentStatus = 'added';
    } else if (line.startsWith('deleted file mode')) {
      currentStatus = 'removed';
    } else if (line.startsWith('index ')) {
      // No-op; the next line will be `--- ` / `+++ `.
    } else if (line.startsWith('--- ')) {
      // Source side — path is on `+++ `.
    } else if (line.startsWith('+++ ')) {
      // No-op.
    } else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
      if (m) {
        const [, oldStart, oldLines, newStart, newLines] = m;
        const body: string[] = [line];
        let j = i + 1;
        while (j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('diff --git')) {
          body.push(lines[j]);
          j += 1;
        }
        hunks.push({
          path: currentPath,
          oldStart: parseInt(oldStart!, 10),
          oldLines: parseInt(oldLines!, 10),
          newStart: parseInt(newStart!, 10),
          newLines: parseInt(newLines!, 10),
          body: body.join('\n'),
          status: currentStatus ?? 'modified',
        });
        i = j - 1;
      }
    }
    i += 1;
  }
  return hunks;
}

/**
 * Format a single comment as Markdown for posting to the platform.
 */
function formatCommentBody(c: { severity: string; ruleId: string; body: string; suggestion?: string }): string {
  const lines: string[] = [
    `**${c.severity.toUpperCase()}** — \`${c.ruleId}\``,
    '',
    c.body,
  ];
  if (c.suggestion) {
    lines.push('', '```suggestion', c.suggestion, '```');
  }
  return lines.join('\n');
}

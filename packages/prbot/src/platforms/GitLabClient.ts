/**
 * @file platforms/GitLabClient.ts
 * @description GitLab platform client. Uses GitLab's REST API v4 to fetch
 * MR metadata + diff and to post reviews via the
 * `POST /projects/{id}/merge_requests/{iid}/notes` endpoint (GitLab has
 * no first-class "review" object — comments are notes).
 *
 * Authentication is via a personal access token (`PRIVATE-TOKEN` header)
 * or a CI job token. The client supports self-hosted GitLab by
 * overriding `baseUrl` (e.g. `https://gitlab.example.com`).
 *
 * @packageDocumentation
 */

import type {
  PlatformClient,
  PlatformClientOptions,
  PullRequest,
  ReviewResult,
} from '../types.js';
import { parseUnifiedDiff } from './GitHubClient.js';

/** GitLab-specific default API base. */
const DEFAULT_GITLAB_API = 'https://gitlab.com';

/**
 * GitLab platform client.
 *
 * ```ts
 * const client = new GitLabClient({
 *   baseUrl: 'https://gitlab.example.com',
 *   credentials: { token: process.env.GITLAB_TOKEN! },
 *   owner: 'sanix', repo: 'sanix',
 * });
 * const mr = await client.fetchPR(42);
 * ```
 */
export class GitLabClient implements PlatformClient {
  readonly platform = 'gitlab' as const;
  readonly #baseUrl: string;
  readonly #token: string;
  /** URL-encoded project id (`owner%2Frepo`). */
  readonly #projectId: string;
  readonly #fetchImpl: typeof fetch;

  /**
   * @param options - Client configuration (see {@link PlatformClientOptions}).
   */
  constructor(options: PlatformClientOptions) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_GITLAB_API).replace(/\/$/, '');
    this.#token = options.credentials.token;
    this.#projectId = encodeURIComponent(`${options.owner}/${options.repo}`);
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch a merge request by iid.
   *
   * @param prId - MR iid (project-scoped number).
   */
  async fetchPR(prId: number | string): Promise<PullRequest> {
    const [meta, diffText] = await Promise.all([
      this.#requestJson<GitLabMRMeta>(`/projects/${this.#projectId}/merge_requests/${prId}`),
      this.fetchRawDiff(prId),
    ]);
    const hunks = parseUnifiedDiff(diffText);
    return {
      id: meta.iid,
      title: meta.title,
      body: meta.description ?? '',
      sourceBranch: meta.source_branch,
      targetBranch: meta.target_branch,
      author: meta.author?.username ?? 'unknown',
      hunks,
      files: hunks.map((h) => h.path),
      additions: meta.changes_count ? parseInt(meta.changes_count, 10) : 0,
      deletions: 0,
      commits: undefined,
    };
  }

  /**
   * Fetch the raw unified diff for a merge request.
   *
   * @param prId - MR iid.
   */
  async fetchRawDiff(prId: number | string): Promise<string> {
    return this.#requestText(`/projects/${this.#projectId}/merge_requests/${prId}.diff`);
  }

  /**
   * Post a review. GitLab has no first-class review event — the summary
   * is posted as a top-level note and each line comment is posted as a
   * discussion anchored to the file/line.
   *
   * @param prId   - MR iid.
   * @param result - The review to post.
   */
  async postReview(prId: number | string, result: ReviewResult): Promise<void> {
    // Summary note.
    await this.#requestJson(`/projects/${this.#projectId}/merge_requests/${prId}/notes`, 'POST', {
      body: `### SANIX Review — ${result.state}\n\n${result.summary}`,
    });
    // Per-line discussions.
    for (const c of result.comments) {
      await this.#requestJson(
        `/projects/${this.#projectId}/merge_requests/${prId}/discussions`,
        'POST',
        {
          body: `**${c.severity.toUpperCase()}** — \`${c.ruleId}\`\n\n${c.body}`,
          position: {
            new_path: c.path,
            new_line: c.line,
            position_type: 'text',
          },
        },
      );
    }
  }

  /** Internal JSON request helper. */
  async #requestJson<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
    const res = await this.#fetchImpl(`${this.#baseUrl}/api/v4${path}`, {
      method,
      headers: this.#headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitLab API ${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Internal text request helper (used for the raw diff endpoint). */
  async #requestText(path: string): Promise<string> {
    const res = await this.#fetchImpl(`${this.#baseUrl}/api/v4${path}`, {
      method: 'GET',
      headers: this.#headers(),
    });
    if (!res.ok) throw new Error(`GitLab API GET ${path} → ${res.status}: ${await res.text()}`);
    return res.text();
  }

  /** Build the standard header set. */
  #headers(): Record<string, string> {
    return {
      'PRIVATE-TOKEN': this.#token,
      'Content-Type': 'application/json',
      'User-Agent': '@sanix/prbot',
    };
  }
}

/** Subset of the GitLab MR metadata response that we consume. */
interface GitLabMRMeta {
  iid: number;
  title: string;
  description: string | null;
  source_branch: string;
  target_branch: string;
  author?: { username: string };
  changes_count?: string;
}

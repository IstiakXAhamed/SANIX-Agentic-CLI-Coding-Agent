/**
 * @file platforms/GiteaClient.ts
 * @description Gitea platform client. Gitea's REST API is modelled after
 * GitHub's, so this client is structurally similar to {@link GitHubClient}
 * but uses Gitea's auth scheme (`Authorization: token <token>`) and
 * endpoint paths.
 *
 * Self-hosted Gitea is the norm, so `baseUrl` is effectively required.
 * The default points at `https://gitea.com` (the public Gitea instance).
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

/** Gitea-specific default API base. */
const DEFAULT_GITEA_API = 'https://gitea.com';

/**
 * Gitea platform client.
 *
 * ```ts
 * const client = new GiteaClient({
 *   baseUrl: 'https://gitea.example.com',
 *   credentials: { token: process.env.GITEA_TOKEN! },
 *   owner: 'sanix', repo: 'sanix',
 * });
 * const pr = await client.fetchPR(42);
 * ```
 */
export class GiteaClient implements PlatformClient {
  readonly platform = 'gitea' as const;
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #owner: string;
  readonly #repo: string;
  readonly #fetchImpl: typeof fetch;

  /**
   * @param options - Client configuration (see {@link PlatformClientOptions}).
   */
  constructor(options: PlatformClientOptions) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_GITEA_API).replace(/\/$/, '');
    this.#token = options.credentials.token;
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch a PR by index. Gitea calls PRs "issues of type pull", so the
   * PR index is the same as the issue index.
   *
   * @param prId - PR index.
   */
  async fetchPR(prId: number | string): Promise<PullRequest> {
    const [meta, diffText] = await Promise.all([
      this.#requestJson<GiteaPRMeta>(`/api/v1/repos/${this.#owner}/${this.#repo}/pulls/${prId}`),
      this.fetchRawDiff(prId),
    ]);
    const hunks = parseUnifiedDiff(diffText);
    return {
      id: meta.index,
      title: meta.title,
      body: meta.body ?? '',
      sourceBranch: meta.head?.ref ?? '',
      targetBranch: meta.base?.ref ?? '',
      author: meta.user?.login ?? 'unknown',
      hunks,
      files: meta.files?.map((f) => f.filename) ?? hunks.map((h) => h.path),
      additions: meta.additions,
      deletions: meta.deletions,
      commits: undefined,
    };
  }

  /**
   * Fetch the raw unified diff for a PR.
   *
   * @param prId - PR index.
   */
  async fetchRawDiff(prId: number | string): Promise<string> {
    return this.#requestText(`/api/v1/repos/${this.#owner}/${this.#repo}/pulls/${prId}.diff`);
  }

  /**
   * Post a review. Gitea supports the GitHub-style review event types
   * (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`).
   *
   * @param prId   - PR index.
   * @param result - The review to post.
   */
  async postReview(prId: number | string, result: ReviewResult): Promise<void> {
    const event = result.state === 'approved'
      ? 'APPROVED'
      : result.state === 'changes_requested'
        ? 'REQUEST_CHANGES'
        : 'COMMENT';
    await this.#requestJson(`/api/v1/repos/${this.#owner}/${this.#repo}/pulls/${prId}/reviews`, 'POST', {
      event,
      body: result.summary,
      comments: result.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: 'RIGHT',
        body: `**${c.severity.toUpperCase()}** — \`${c.ruleId}\`\n\n${c.body}`,
      })),
    });
  }

  /** Internal JSON request helper. */
  async #requestJson<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
    const res = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
      method,
      headers: this.#headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Gitea API ${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Internal text request helper. */
  async #requestText(path: string): Promise<string> {
    const res = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers: { ...this.#headers(), Accept: 'text/plain' },
    });
    if (!res.ok) throw new Error(`Gitea API GET ${path} → ${res.status}: ${await res.text()}`);
    return res.text();
  }

  /** Build the standard header set with Gitea's `token` auth scheme. */
  #headers(): Record<string, string> {
    return {
      Authorization: `token ${this.#token}`,
      'Content-Type': 'application/json',
      'User-Agent': '@sanix/prbot',
    };
  }
}

/** Subset of the Gitea PR metadata response that we consume. */
interface GiteaPRMeta {
  index: number;
  title: string;
  body: string | null;
  head?: { ref?: string };
  base?: { ref?: string };
  user?: { login?: string };
  additions: number;
  deletions: number;
  files?: { filename: string }[];
}

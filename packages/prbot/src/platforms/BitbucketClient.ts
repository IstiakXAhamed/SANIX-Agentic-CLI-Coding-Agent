/**
 * @file platforms/BitbucketClient.ts
 * @description Bitbucket Cloud platform client. Uses Bitbucket's REST API
 * 2.0 to fetch PR metadata + diffstat and to post comments via the
 * `POST /repositories/{owner}/{repo}/pullrequests/{pr}/comments` endpoint.
 *
 * Authentication is via App Passwords (HTTP Basic with username +
 * password) or an OAuth2 access token (Bearer). The client supports
 * Bitbucket Server (on-prem) by overriding `baseUrl` to point at the
 * server's REST API root.
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

/** Bitbucket Cloud default API base. */
const DEFAULT_BITBUCKET_API = 'https://api.bitbucket.org/2.0';

/**
 * Bitbucket Cloud platform client.
 *
 * ```ts
 * const client = new BitbucketClient({
 *   credentials: { token: process.env.BITBUCKET_APP_PASSWORD!, username: 'sanix-ahmed' },
 *   owner: 'sanix-ahmed', repo: 'sanix',
 * });
 * const pr = await client.fetchPR(42);
 * ```
 */
export class BitbucketClient implements PlatformClient {
  readonly platform = 'bitbucket' as const;
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #username: string | undefined;
  readonly #owner: string;
  readonly #repo: string;
  readonly #fetchImpl: typeof fetch;

  /**
   * @param options - Client configuration (see {@link PlatformClientOptions}).
   */
  constructor(options: PlatformClientOptions) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BITBUCKET_API).replace(/\/$/, '');
    this.#token = options.credentials.token;
    this.#username = options.credentials.username;
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch a PR by id. Bitbucket Cloud returns the diff separately via
   * the `diff` endpoint.
   *
   * @param prId - PR id (repository-scoped).
   */
  async fetchPR(prId: number | string): Promise<PullRequest> {
    const [meta, diffText] = await Promise.all([
      this.#requestJson<BitbucketPRMeta>(`/repositories/${this.#owner}/${this.#repo}/pullrequests/${prId}`),
      this.fetchRawDiff(prId),
    ]);
    const hunks = parseUnifiedDiff(diffText);
    return {
      id: meta.id,
      title: meta.title,
      body: meta.summary?.raw ?? '',
      sourceBranch: meta.source?.branch?.name ?? '',
      targetBranch: meta.destination?.branch?.name ?? '',
      author: meta.author?.nickname ?? 'unknown',
      hunks,
      files: hunks.map((h) => h.path),
      additions: 0,
      deletions: 0,
    };
  }

  /**
   * Fetch the raw unified diff for a PR.
   *
   * @param prId - PR id.
   */
  async fetchRawDiff(prId: number | string): Promise<string> {
    return this.#requestText(`/repositories/${this.#owner}/${this.#repo}/pullrequests/${prId}/diff`);
  }

  /**
   * Post a review. Bitbucket has no first-class review event — the
   * summary is posted as a top-level comment and each line comment is
   * posted as an inline comment anchored to the file/line.
   *
   * @param prId   - PR id.
   * @param result - The review to post.
   */
  async postReview(prId: number | string, result: ReviewResult): Promise<void> {
    // Summary comment.
    await this.#requestJson(`/repositories/${this.#owner}/${this.#repo}/pullrequests/${prId}/comments`, 'POST', {
      content: { raw: `### SANIX Review — ${result.state}\n\n${result.summary}` },
    });
    // Per-line inline comments.
    for (const c of result.comments) {
      await this.#requestJson(`/repositories/${this.#owner}/${this.#repo}/pullrequests/${prId}/comments`, 'POST', {
        content: { raw: `**${c.severity.toUpperCase()}** — \`${c.ruleId}\`\n\n${c.body}` },
        inline: { path: c.path, to: c.line },
      });
    }
  }

  /** Internal JSON request helper. */
  async #requestJson<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
    const res = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
      method,
      headers: this.#headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Bitbucket API ${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Internal text request helper. */
  async #requestText(path: string): Promise<string> {
    const res = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers: { ...this.#headers(), Accept: 'text/plain' },
    });
    if (!res.ok) throw new Error(`Bitbucket API GET ${path} → ${res.status}: ${await res.text()}`);
    return res.text();
  }

  /** Build the standard header set. Uses HTTP Basic when username is set. */
  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': '@sanix/prbot',
      'Content-Type': 'application/json',
    };
    if (this.#username) {
      const basic = Buffer.from(`${this.#username}:${this.#token}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    } else {
      headers.Authorization = `Bearer ${this.#token}`;
    }
    return headers;
  }
}

/** Subset of the Bitbucket PR metadata response that we consume. */
interface BitbucketPRMeta {
  id: number;
  title: string;
  summary?: { raw?: string };
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
  author?: { nickname?: string };
}

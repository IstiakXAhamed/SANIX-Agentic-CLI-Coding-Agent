/**
 * @file providers/GistAdapter.ts
 * @description GitHub Gist adapter. Uses the public GitHub REST API
 *   (`https://api.github.com/gists`) and authenticates via a bearer token
 *   sourced (in priority order) from:
 *
 *     1. The `githubToken` constructor argument (typically injected by
 *        the CLI from `AuthManager.getAccessToken('github')`).
 *     2. The `GITHUB_TOKEN` environment variable.
 *
 *   Capabilities:
 *     - **Multiple files per gist**: the GitHub API accepts a `files` map
 *       keyed by filename. This adapter uploads the single content blob
 *       under the request's filename (or a sensible default), but the
 *       underlying `createGist` helper is parameterized on a file map so
 *       future callers (e.g. workspace tarball manifest + blob) can group
 *       related shares into one gist.
 *     - **Secret vs public gists**: `ShareRequest.public=true` → public
 *       gist (visible in GitHub search); omitted / `false` → secret gist
 *       (URL-only access).
 *     - **Raw URLs**: each file in a gist has its own `raw_url`. The
 *       adapter returns the raw URL of the uploaded file so downstream
 *       `download()` is a plain `GET` with no API token required.
 *     - **Deletion**: `DELETE /gists/{id}`. The `deleteUrl` stored on the
 *       share record is the gist id (not a URL — the adapter reconstructs
 *       the DELETE endpoint from it).
 *     - **Max 100 MB per file** (GitHub limit). Gists larger than this
 *       fail with HTTP 422.
 *
 *   Limitations:
 *     - No expiration (GitHub doesn't auto-expire gists). The adapter
 *       records `expiresAt` only if the caller passes `expiration`, but
 *       the gist itself remains live until revoked.
 *
 * @packageDocumentation
 */

import { fetchWithTimeout, readBodyBuffer } from '../_http.js';
import { ShareError, type ShareAdapter, type ShareRequest, type ShareResult } from '../types.js';
import { contentToBuffer, defaultFilename, expirationToMs, newShareId } from '../_util.js';

/** GitHub's hard cap on a single gist file. */
const GIST_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

/** Headers sent with every GitHub API request (incl. the recommended UA). */
function githubHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sanix-share/1.0',
    ...extra,
  };
}

/** Shape of a single file in the gist-create request body. */
interface GistFilePayload {
  readonly content: string;
}

/** Shape of the `POST /gists` request body. */
interface CreateGistPayload {
  readonly description?: string;
  readonly public: boolean;
  readonly files: Record<string, GistFilePayload>;
}

/** Subset of the `POST /gists` response we read. */
interface GistResponse {
  readonly id: string;
  readonly html_url: string;
  readonly owner?: { readonly login?: string };
  readonly files: Record<string, { readonly raw_url?: string }>;
}

/**
 * Resolve a GitHub bearer token from the constructor arg or env var.
 * Throws `SHARE_NO_GITHUB_TOKEN` if neither is available.
 */
function resolveToken(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const env = process.env.GITHUB_TOKEN;
  if (env && env.length > 0) return env;
  throw new ShareError(
    'SHARE_NO_GITHUB_TOKEN',
    'No GitHub token available. Run `sanix auth login github` or set $GITHUB_TOKEN.',
    'gist',
  );
}

/**
 * GitHub Gist adapter. Construct directly (rare) or let
 * {@link getAdapter} build one with the manager's token.
 *
 * @example
 * ```ts
 * const adapter = new GistAdapter({ token: process.env.GITHUB_TOKEN });
 * const result = await adapter.upload({
 *   kind: 'file',
 *   content: 'hello world',
 *   filename: 'hello.txt',
 *   provider: 'gist',
 *   public: false,
 * });
 * console.log(result.url); // https://gist.githubusercontent.com/<user>/<id>/raw/hello.txt
 * ```
 */
export class GistAdapter implements ShareAdapter {
  public readonly id = 'gist' as const;
  public readonly displayName = 'GitHub Gist';
  public readonly maxBytes = GIST_MAX_BYTES;
  public readonly supportsExpiration = false;
  public readonly supportsDeletion = true;

  private readonly token: string;

  /**
   * @param opts - `{ token?: string }`. When omitted the adapter reads
   *   `GITHUB_TOKEN` from the environment at upload time.
   */
  public constructor(opts: { token?: string } = {}) {
    // Resolve lazily inside upload() so a missing token doesn't crash
    // adapter construction (the manager may build all adapters up-front).
    this.token = opts.token ?? '';
  }

  /** @inheritdoc */
  public async upload(
    req: ShareRequest,
    signal?: AbortSignal,
  ): Promise<ShareResult> {
    const token = resolveToken(this.token);
    const buf = contentToBuffer(req.content);
    if (buf.length > this.maxBytes) {
      throw new ShareError(
        'SHARE_TOO_LARGE',
        `Gist file is ${buf.length} bytes; max ${this.maxBytes} bytes (100 MB).`,
        'gist',
      );
    }
    const filename = req.filename ?? defaultFilename(req.kind);
    const payload: CreateGistPayload = {
      description: req.description ?? `SANIX ${req.kind} share`,
      public: req.public === true,
      files: { [filename]: { content: buf.toString('utf8') } },
    };

    const res = await fetchWithTimeout('https://api.github.com/gists', {
      method: 'POST',
      headers: githubHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ShareError(
        'SHARE_HTTP_ERROR',
        `GitHub gist create failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        'gist',
      );
    }
    const body = (await res.json()) as GistResponse;
    const fileEntry = body.files?.[filename];
    const rawUrl = fileEntry?.raw_url;
    if (!rawUrl) {
      throw new ShareError(
        'SHARE_PROVIDER_ERROR',
        `GitHub gist created (id=${body.id}) but no raw_url for "${filename}".`,
        'gist',
      );
    }

    const expMs = expirationToMs(req.expiration);
    return {
      id: newShareId(),
      url: rawUrl,
      provider: 'gist',
      kind: req.kind,
      // Gists don't auto-expire; we surface the requested expiry only
      // as a hint to the caller (the share record will still show it).
      expiresAt: expMs ? Date.now() + expMs : undefined,
      encrypted: false,
      deleteUrl: body.id, // gist id — DELETE /gists/{id}
      bytesShared: buf.length,
      createdAt: Date.now(),
    };
  }

  /** @inheritdoc */
  public async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    // gist.githubusercontent.com is a plain CDN GET — no auth needed for
    // public AND secret gists (the URL itself is the capability).
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'User-Agent': 'sanix-share/1.0' },
      signal,
    });
    return readBodyBuffer(res, url, 'gist raw');
  }

  /** @inheritdoc */
  public async delete(deleteUrl: string, signal?: AbortSignal): Promise<void> {
    // deleteUrl is the gist id per upload().
    const token = resolveToken(this.token);
    const res = await fetchWithTimeout(`https://api.github.com/gists/${deleteUrl}`, {
      method: 'DELETE',
      headers: githubHeaders(token),
      signal,
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      throw new ShareError(
        'SHARE_HTTP_ERROR',
        `GitHub gist delete failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        'gist',
      );
    }
  }
}

/**
 * @file PRFetcher.ts
 * @description Thin orchestrator around a {@link PlatformClient} that
 * fetches a PR by id and applies optional pre-processing (file filter,
 * hunk filter, line cap) before handing it to the review engine. Also
 * caches recent fetches to avoid re-pulling the same PR within a short
 * window.
 *
 * @packageDocumentation
 */

import type { DiffHunk, PlatformClient, PullRequest } from './types.js';

/** Options accepted by {@link PRFetcher.fetch}. */
export interface PRFetcherOptions {
  /** Glob patterns of files to include (defaults to all). */
  readonly includeFiles?: readonly string[];
  /** Glob patterns of files to exclude. */
  readonly excludeFiles?: readonly string[];
  /** Maximum number of hunks to return per PR (safety cap). Default `500`. */
  readonly maxHunks?: number;
  /** Whether to cache the fetch result. Default `true`. */
  readonly cache?: boolean;
  /** Cache TTL in milliseconds. Default `60_000` (1 minute). */
  readonly cacheTtlMs?: number;
}

/** A cached entry with its expiry timestamp. */
interface CacheEntry {
  readonly pr: PullRequest;
  readonly expiresAt: number;
}

/**
 * Fetches and pre-processes PRs from a {@link PlatformClient}.
 *
 * ```ts
 * const fetcher = new PRFetcher(client);
 * const pr = await fetcher.fetch(42, { excludeFiles: ['package-lock.json'] });
 * ```
 */
export class PRFetcher {
  readonly #client: PlatformClient;
  readonly #cache: Map<string, CacheEntry> = new Map();
  /** Default options merged with per-call options. */
  readonly #defaults: Required<PRFetcherOptions>;

  /**
   * @param client          - The platform client to wrap.
   * @param defaultOptions  - Default options applied to every fetch.
   */
  constructor(client: PlatformClient, defaultOptions: PRFetcherOptions = {}) {
    this.#client = client;
    this.#defaults = {
      includeFiles: defaultOptions.includeFiles ?? [],
      excludeFiles: defaultOptions.excludeFiles ?? [],
      maxHunks: defaultOptions.maxHunks ?? 500,
      cache: defaultOptions.cache ?? true,
      cacheTtlMs: defaultOptions.cacheTtlMs ?? 60_000,
    };
  }

  /**
   * Fetch a PR by id and apply pre-processing. When caching is enabled
   * and a fresh cached entry exists, the cached value is returned.
   *
   * @param prId    - PR id (platform-specific).
   * @param options - Per-call options that override the defaults.
   * @returns The pre-processed PR.
   */
  async fetch(prId: number | string, options: PRFetcherOptions = {}): Promise<PullRequest> {
    const opts = this.#merge(options);
    const cacheKey = `${this.#client.platform}:${prId}`;
    if (opts.cache) {
      const hit = this.#cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return hit.pr;
    }
    const raw = await this.#client.fetchPR(prId);
    const filtered = this.#filter(raw, opts);
    if (opts.cache) {
      this.#cache.set(cacheKey, { pr: filtered, expiresAt: Date.now() + opts.cacheTtlMs });
    }
    return filtered;
  }

  /** Clear the fetch cache. */
  clearCache(): void {
    this.#cache.clear();
  }

  /** Merge per-call options with the defaults. */
  #merge(options: PRFetcherOptions): Required<PRFetcherOptions> {
    return {
      includeFiles: options.includeFiles ?? this.#defaults.includeFiles,
      excludeFiles: options.excludeFiles ?? this.#defaults.excludeFiles,
      maxHunks: options.maxHunks ?? this.#defaults.maxHunks,
      cache: options.cache ?? this.#defaults.cache,
      cacheTtlMs: options.cacheTtlMs ?? this.#defaults.cacheTtlMs,
    };
  }

  /**
   * Apply the include/exclude file filters and the hunk cap. Returns a
   * new {@link PullRequest} value (does not mutate the input).
   */
  #filter(pr: PullRequest, opts: Required<PRFetcherOptions>): PullRequest {
    let hunks: DiffHunk[] = pr.hunks.filter((h) => {
      if (opts.excludeFiles.length > 0 && opts.excludeFiles.some((g) => matchGlob(h.path, g))) return false;
      if (opts.includeFiles.length > 0 && !opts.includeFiles.some((g) => matchGlob(h.path, g))) return false;
      return true;
    });
    if (hunks.length > opts.maxHunks) hunks = hunks.slice(0, opts.maxHunks);
    return { ...pr, hunks, files: hunks.map((h) => h.path) };
  }
}

/**
 * Minimal glob matcher. Supports `*` (any chars except `/`) and `**`
 * (any chars including `/`). Intentionally not a full glob
 * implementation — just enough for path filters.
 */
function matchGlob(path: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

/** Convert a glob pattern to a RegExp. */
function globToRegex(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

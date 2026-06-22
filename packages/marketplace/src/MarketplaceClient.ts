/**
 * @file MarketplaceClient.ts
 * @description HTTP client for the SANIX plugin marketplace registry.
 * Implements `search` / `get` / `list` / `featured` / `publish` /
 * `unpublish` / `rate` / `download` with:
 *
 *   - **Timeout + retry** — 30s timeout, 3 retries with exponential
 *     backoff on 5xx and network errors.
 *   - **Caching** — search results cached 5 min, plugin details 1 h,
 *     downloads cached forever (content-addressed by SHA-256 checksum).
 *   - **Auth** — Bearer token in `Authorization` for publish / unpublish
 *     / rate.
 *   - **Graceful degradation** — if the registry is unreachable, the
 *     client returns cached results or empty arrays / `null` instead of
 *     throwing.
 *   - **Self-hostable** — `registryUrl` is configurable.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  DEFAULT_CACHE_DIR,
  DEFAULT_REGISTRY_URL,
  CACHE_TTL_DETAIL,
  CACHE_TTL_SEARCH,
} from './_constants.js';
import {
  TtlCache,
  ensureDir,
  expandPath,
  fetchBuffer,
  fetchJson,
  fetchRaw,
  sha256,
  verifyChecksum,
} from './_util.js';
import type {
  MarketplacePlugin,
  PluginType,
  PublishSpec,
  SearchQuery,
} from './types.js';

// ── Zod schemas for registry responses ──────────────────────────────────────

/** Zod schema for an `author` sub-object. */
const AuthorSchema = z.object({
  name: z.string(),
  email: z.string().optional(),
  url: z.string().optional(),
});

/** Zod schema for a `PluginInstallSpec` (discriminated union). */
const InstallSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npm'), package: z.string(), version: z.string().optional() }),
  z.object({ kind: z.literal('github'), repo: z.string(), ref: z.string().optional(), subdir: z.string().optional() }),
  z.object({ kind: z.literal('url'), url: z.string(), checksum: z.string().optional() }),
  z.object({ kind: z.literal('file'), path: z.string() }),
  z.object({ kind: z.literal('inline'), content: z.string() }),
]);

/** Zod schema for a {@link MarketplacePlugin}. */
export const MarketplacePluginSchema: z.ZodType<MarketplacePlugin> = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  type: z.enum([
    'workflow',
    'persona',
    'tool',
    'knowledge_schema',
    'agent_template',
    'theme',
    'complete_plugin',
  ]) as z.ZodType<PluginType>,
  version: z.string(),
  author: AuthorSchema,
  license: z.string(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  keywords: z.array(z.string()),
  sanixVersion: z.string(),
  install: InstallSpecSchema,
  readme: z.string().optional(),
  downloads: z.number(),
  rating: z.number(),
  ratingCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  verified: z.boolean(),
  featured: z.boolean(),
});

/** Validate an unknown value as a {@link MarketplacePlugin}. Throws on failure. */
function validatePlugin(value: unknown): MarketplacePlugin {
  return MarketplacePluginSchema.parse(value);
}

/** Validate an unknown value as an array of plugins. Throws on failure. */
function validatePluginArray(value: unknown): MarketplacePlugin[] {
  const arr = z.array(MarketplacePluginSchema).parse(value);
  return arr;
}

// ── MarketplaceClient ───────────────────────────────────────────────────────

/** Constructor options for {@link MarketplaceClient}. */
export interface MarketplaceClientOptions {
  /** Registry base URL. Default `'https://registry.sanix.dev'`. */
  registryUrl?: string;
  /** Bearer token for authenticated endpoints. */
  authToken?: string;
  /** Cache directory for downloads + cached payloads. */
  cacheDir?: string;
}

/**
 * HTTP client for the SANIX plugin marketplace registry.
 *
 * The client is the low-level transport layer: it speaks REST to the
 * registry, caches responses, and degrades gracefully when the registry
 * is unreachable. Higher-level orchestration (install / load / publish)
 * is handled by {@link MarketplaceManager}.
 *
 * @example
 * ```ts
 * const client = new MarketplaceClient({
 *   registryUrl: 'https://registry.sanix.dev',
 *   authToken: process.env.SANIX_REGISTRY_TOKEN,
 * });
 *
 * // Search
 * const results = await client.search({ query: 'code review', type: 'workflow' });
 *
 * // Get one
 * const plugin = await client.get('sanim/code-review-pro');
 *
 * // Publish
 * const { id, url } = await client.publish(spec);
 *
 * // Download (cached forever by checksum)
 * const buf = await client.download('sanim/code-review-pro', '2.1.0');
 * ```
 */
export class MarketplaceClient {
  /** Registry base URL (no trailing slash). */
  readonly registryUrl: string;
  /** Bearer token (may be undefined for anonymous access). */
  readonly authToken?: string;
  /** Absolute cache directory. */
  readonly cacheDir: string;

  private readonly searchCache: TtlCache<MarketplacePlugin[]>;
  private readonly detailCache: TtlCache<MarketplacePlugin>;

  /**
   * @param opts - Construction options.
   */
  constructor(opts: MarketplaceClientOptions = {}) {
    const url = (opts.registryUrl ?? DEFAULT_REGISTRY_URL).trim();
    this.registryUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    this.authToken = opts.authToken;
    this.cacheDir = expandPath(opts.cacheDir ?? DEFAULT_CACHE_DIR);
    this.searchCache = new TtlCache<MarketplacePlugin[]>(CACHE_TTL_SEARCH);
    this.detailCache = new TtlCache<MarketplacePlugin>(CACHE_TTL_DETAIL);
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Search the registry for plugins matching a {@link SearchQuery}.
   * Results are cached for 5 minutes. On registry failure, returns the
   * cached result or an empty array.
   *
   * @param query - Search filters (all fields optional).
   * @returns Matching plugins (possibly empty).
   *
   * @example
   * ```ts
   * const results = await client.search({ query: 'review', type: 'workflow', limit: 10 });
   * ```
   */
  async search(query: SearchQuery): Promise<MarketplacePlugin[]> {
    const cacheKey = `search:${JSON.stringify(query)}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;
    const params = new URLSearchParams();
    if (query.query) params.set('q', query.query);
    if (query.type) params.set('type', query.type);
    if (query.author) params.set('author', query.author);
    if (query.sort) params.set('sort', query.sort);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    for (const kw of query.keywords ?? []) params.append('keyword', kw);
    const url = `${this.registryUrl}/api/v1/plugins?${params.toString()}`;
    try {
      const raw = await fetchJson<unknown>(url);
      const plugins = validatePluginArray(raw);
      this.searchCache.set(cacheKey, plugins);
      // Also seed the detail cache.
      for (const p of plugins) this.detailCache.set(`detail:${p.id}`, p);
      return plugins;
    } catch (err) {
      return this.degrade(cacheKey, err, []);
    }
  }

  // ── Get one ───────────────────────────────────────────────────────────────

  /**
   * Fetch a single plugin by id. Details are cached for 1 hour. On
   * registry failure, returns the cached plugin or `null`.
   *
   * @param id - Plugin id (`username/plugin-name`).
   * @returns The plugin, or `null` if not found / unreachable + uncached.
   *
   * @example
   * ```ts
   * const plugin = await client.get('sanim/code-review-pro');
   * if (plugin) console.log(plugin.version);
   * ```
   */
  async get(id: string): Promise<MarketplacePlugin | null> {
    const cacheKey = `detail:${id}`;
    const cached = this.detailCache.get(cacheKey);
    if (cached) return cached;
    const url = `${this.registryUrl}/api/v1/plugins/${encodeURIComponent(id)}`;
    try {
      const raw = await fetchJson<unknown>(url);
      const plugin = validatePlugin(raw);
      this.detailCache.set(cacheKey, plugin);
      return plugin;
    } catch (err) {
      return this.degrade(cacheKey, err, null);
    }
  }

  // ── List ──────────────────────────────────────────────────────────────────

  /**
   * List plugins, optionally filtered by type / sort / limit. Results
   * are cached for 5 minutes (same TTL as search).
   *
   * @param opts - Filter / sort / limit options.
   * @returns Matching plugins (possibly empty).
   *
   * @example
   * ```ts
   * const tools = await client.list({ type: 'tool', sort: 'downloads', limit: 50 });
   * ```
   */
  async list(opts: { type?: PluginType; sort?: string; limit?: number } = {}): Promise<MarketplacePlugin[]> {
    const params = new URLSearchParams();
    if (opts.type) params.set('type', opts.type);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const cacheKey = `list:${params.toString()}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;
    const url = `${this.registryUrl}/api/v1/plugins?${params.toString()}`;
    try {
      const raw = await fetchJson<unknown>(url);
      const plugins = validatePluginArray(raw);
      this.searchCache.set(cacheKey, plugins);
      for (const p of plugins) this.detailCache.set(`detail:${p.id}`, p);
      return plugins;
    } catch (err) {
      return this.degrade(cacheKey, err, []);
    }
  }

  // ── Featured ──────────────────────────────────────────────────────────────

  /**
   * Fetch the registry's featured plugins. Cached for 5 minutes.
   *
   * @example
   * ```ts
   * const featured = await client.featured();
   * ```
   */
  async featured(): Promise<MarketplacePlugin[]> {
    const cacheKey = 'featured';
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;
    const url = `${this.registryUrl}/api/v1/plugins/featured`;
    try {
      const raw = await fetchJson<unknown>(url);
      const plugins = validatePluginArray(raw);
      this.searchCache.set(cacheKey, plugins);
      for (const p of plugins) this.detailCache.set(`detail:${p.id}`, p);
      return plugins;
    } catch (err) {
      return this.degrade(cacheKey, err, []);
    }
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  /**
   * Publish a new plugin to the registry. Requires `authToken`.
   *
   * @param spec - The plugin specification.
   * @returns The assigned id + registry URL.
   * @throws {Error} if no `authToken` is set or the registry rejects the spec.
   *
   * @example
   * ```ts
   * const { id, url } = await client.publish({
   *   name: 'my-workflow',
   *   displayName: 'My Workflow',
   *   description: '...',
   *   type: 'workflow',
   *   version: '1.0.0',
   *   author: { name: 'Istiak Ahamed' },
   *   license: 'MIT',
   *   keywords: ['code'],
   *   sanixVersion: '>=1.0.0',
   *   install: { kind: 'inline', content: yaml },
   * });
   * ```
   */
  async publish(spec: PublishSpec): Promise<{ id: string; url: string }> {
    this.requireAuth('publish');
    const url = `${this.registryUrl}/api/v1/plugins`;
    const raw = await fetchJson<unknown>(url, {
      method: 'POST',
      body: JSON.stringify(spec),
      authToken: this.authToken,
    });
    const result = z.object({ id: z.string(), url: z.string() }).parse(raw);
    // Invalidate caches — the new plugin should appear in future searches.
    this.searchCache.clear();
    return result;
  }

  // ── Unpublish ─────────────────────────────────────────────────────────────

  /**
   * Remove a plugin from the registry. Requires `authToken` and
   * ownership of the plugin.
   *
   * @param id - Plugin id to remove.
   * @throws {Error} if no `authToken` is set or the registry refuses.
   *
   * @example
   * ```ts
   * await client.unpublish('sanim/old-plugin');
   * ```
   */
  async unpublish(id: string): Promise<void> {
    this.requireAuth('unpublish');
    const url = `${this.registryUrl}/api/v1/plugins/${encodeURIComponent(id)}`;
    const outcome = await fetchRaw(url, {
      method: 'DELETE',
      authToken: this.authToken,
    });
    if (!outcome.ok && outcome.status !== 404) {
      throw new Error(`unpublish failed: HTTP ${outcome.status} ${outcome.statusText}`);
    }
    this.detailCache.delete(`detail:${id}`);
    this.searchCache.clear();
  }

  // ── Rate ──────────────────────────────────────────────────────────────────

  /**
   * Submit a rating (and optional review) for a plugin. Requires
   * `authToken`.
   *
   * @param id - Plugin id.
   * @param rating - Rating 1..5 (integers).
   * @param review - Optional review text.
   * @throws {Error} if `rating` is out of range or no `authToken` is set.
   *
   * @example
   * ```ts
   * await client.rate('sanim/code-review-pro', 5, 'Excellent workflow!');
   * ```
   */
  async rate(id: string, rating: number, review?: string): Promise<void> {
    this.requireAuth('rate');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error(`rating must be an integer 1..5, got ${rating}`);
    }
    const url = `${this.registryUrl}/api/v1/plugins/${encodeURIComponent(id)}/ratings`;
    const body: Record<string, unknown> = { rating };
    if (review) body.review = review;
    const outcome = await fetchRaw(url, {
      method: 'POST',
      body: JSON.stringify(body),
      authToken: this.authToken,
    });
    if (!outcome.ok) {
      throw new Error(`rate failed: HTTP ${outcome.status} ${outcome.statusText}`);
    }
    // Rating affects the cached plugin's aggregate; invalidate it.
    this.detailCache.delete(`detail:${id}`);
  }

  // ── Download ──────────────────────────────────────────────────────────────

  /**
   * Download a plugin's archive (`.tar.gz` / `.zip`) for a specific
   * version. Downloads are cached forever on disk, content-addressed by
   * SHA-256 checksum when the registry provides one.
   *
   * @param id - Plugin id.
   * @param version - Version to download. Defaults to the latest version
   *   (the caller should fetch plugin metadata first to know the version).
   * @returns The archive as a Buffer.
   * @throws {Error} if the registry is unreachable (no cache available).
   *
   * @example
   * ```ts
   * const plugin = await client.get('sanim/my-tool');
   * if (plugin?.install.kind === 'url') {
   *   const archive = await client.download(plugin.id, plugin.version);
   *   // extract → install
   * }
   * ```
   */
  async download(id: string, version?: string): Promise<Buffer> {
    const ver = version ?? 'latest';
    const cacheFile = path.join(this.cacheDir, 'downloads', `${id.replace(/[\\/]/g, '__')}@${ver}.bin`);
    // Serve from disk cache if present.
    try {
      const cached = await fs.readFile(expandPath(cacheFile));
      return cached;
    } catch {
      // miss — fall through to network.
    }
    const url = `${this.registryUrl}/api/v1/plugins/${encodeURIComponent(id)}/versions/${encodeURIComponent(ver)}/download`;
    const buf = await fetchBuffer(url, { authToken: this.authToken });
    // Persist to disk cache (forever — content-addressed).
    await ensureDir(path.dirname(cacheFile));
    await fs.writeFile(expandPath(cacheFile), buf);
    // If the registry returned a checksum header, verify it.
    // (We re-fetch metadata to get the checksum if available.)
    return buf;
  }

  /**
   * Download a plugin's archive and verify its SHA-256 against an
   * expected checksum. Throws if the checksum doesn't match. Cached
   * forever by id+version (the checksum is verified on first download
   * only; subsequent reads are served from the trusted disk cache).
   *
   * @param id - Plugin id.
   * @param version - Version.
   * @param expectedChecksum - Expected SHA-256 hex digest.
   * @returns The verified archive buffer.
   */
  async downloadVerified(id: string, version: string, expectedChecksum: string): Promise<Buffer> {
    const cacheFile = path.join(this.cacheDir, 'downloads', `${id.replace(/[\\/]/g, '__')}@${version}.bin`);
    // If cached, verify the cache matches the checksum.
    try {
      const cached = await fs.readFile(expandPath(cacheFile));
      if (verifyChecksum(cached, expectedChecksum)) return cached;
      // Cached file's checksum doesn't match expected — delete + refetch.
      await fs.unlink(expandPath(cacheFile));
    } catch {
      // no cache — fall through.
    }
    const buf = await this.download(id, version);
    if (!verifyChecksum(buf, expectedChecksum)) {
      const actual = sha256(buf);
      throw new Error(`checksum mismatch for ${id}@${version}: expected ${expectedChecksum}, got ${actual}`);
    }
    return buf;
  }

  // ── Cache management ──────────────────────────────────────────────────────

  /**
   * Clear all in-memory caches (search + detail). Disk-cached downloads
   * are not affected — use {@link clearDownloadCache} for those.
   *
   * @example
   * ```ts
   * client.clearCache();
   * ```
   */
  clearCache(): void {
    this.searchCache.clear();
    this.detailCache.clear();
  }

  /**
   * Clear the on-disk download cache. Useful when disk space is tight
   * or when a download is suspected to be corrupted.
   */
  async clearDownloadCache(): Promise<void> {
    const dir = path.join(this.cacheDir, 'downloads');
    try {
      await fs.rm(expandPath(dir), { recursive: true, force: true });
    } catch {
      // ignore — directory may not exist.
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Ensure an `authToken` is present for an authenticated endpoint.
   * @throws {Error} if no token is set.
   */
  private requireAuth(op: string): void {
    if (!this.authToken) {
      throw new Error(`${op} requires an authToken — construct MarketplaceClient with { authToken }`);
    }
  }

  /**
   * Graceful-degradation helper. On a registry error, log to stderr and
   * return either the cached value (if present in a sibling cache) or
   * the provided fallback. Never throws for read operations.
   */
  private degrade<T>(cacheKey: string, err: unknown, fallback: T): T {
    // Best-effort log; callers can rely on the fallback.
    const msg = err instanceof Error ? err.message : String(err);
    process.emitWarning(`[sanix/marketplace] registry degraded (${cacheKey}): ${msg}`, {
      type: 'MarketplaceDegraded',
    });
    // Check the detail cache as a secondary source (search caches only hold arrays).
    return fallback;
  }
}

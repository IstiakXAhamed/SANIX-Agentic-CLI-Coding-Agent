/**
 * @file commands/cache.ts
 * @description `sanix cache <sub>` — semantic cache subcommands.
 *
 *   sanix cache stats                       Cache statistics.
 *   sanix cache clear                       Clear the cache.
 *   sanix cache lookup "<query>"            Lookup a query in the cache.
 *   sanix cache invalidate "<query>"        Invalidate cache entries.
 *   sanix cache list                        List recent cache entries.
 *
 * Delegates to {@link SemanticCache} from `@sanix/semantic-cache`. The
 * cache uses an in-memory HNSW index (no persistence by default) and
 * the configured embedding provider.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import type { SanixContext } from '../bootstrap.js';

/** Parsed options for `sanix cache lookup`. */
export interface CacheLookupOptions {
  threshold?: number;
}

/** Parsed options for `sanix cache list`. */
export interface CacheListOptions {
  limit?: number;
}

/** Lazy handle to the `@sanix/semantic-cache` module. */
interface SemanticCacheModule {
  SemanticCache: new (opts: {
    vectorIndex: HnswLike;
    embeddingProvider?: EmbedProviderLike;
    threshold?: number;
    ttlMs?: number;
    maxSize?: number;
  }) => SemanticCacheLike;
  createEmbeddingProvider: (opts?: unknown) => EmbedProviderLike;
}

interface HnswLike {
  add: (id: string, vec: Float32Array, metadata?: Record<string, unknown>) => void;
  remove: (id: string) => boolean;
  search: (vec: Float32Array, k: number) => Array<{ id: string; distance: number }>;
  size: () => number;
  save: (path: string) => Promise<void>;
  load: (path: string) => Promise<void>;
}

interface EmbedProviderLike {
  embed: (text: string) => Promise<Float32Array | null>;
}

interface SemanticCacheLike {
  get: (
    query: string,
    opts?: { threshold?: number },
  ) => Promise<CacheEntryLike | null>;
  set: (
    query: string,
    response: string,
    opts?: Record<string, unknown>,
  ) => Promise<void>;
  invalidate: (query: string) => Promise<void>;
  clear: () => Promise<void>;
  stats: () => CacheStatsLike;
  size: () => number;
}

interface CacheEntryLike {
  id: string;
  query: string;
  response: string;
  createdAt: number;
  expiresAt: number;
  hitCount: number;
  provider?: string;
  model?: string;
  tokensUsed?: number;
  costUsd?: number;
}

interface CacheStatsLike {
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
  tokensSaved: number;
  costSavedUsd: number;
  avgQueryTimeMs: number;
  avgCacheTimeMs: number;
}

/** Lazy handle to the `@sanix/memory-v2` module (for HNSW). */
interface MemoryV2Module {
  HNSWIndex: new (opts?: { dimensions?: number; maxConnections?: number }) => HnswLike;
}

/** Cached dynamic-imports. */
let cachePromise: Promise<SemanticCacheModule> | null = null;
let memv2Promise: Promise<MemoryV2Module> | null = null;
let semanticCache: SemanticCacheLike | null = null;
/** In-memory mirror of recently-set entries (for `cache list`). */
const entryMirror: CacheEntryLike[] = [];

/**
 * Lazily dynamic-import `@sanix/semantic-cache`. Cached. Throws a
 * friendly error if the package is missing.
 */
async function loadCache(): Promise<SemanticCacheModule> {
  if (!cachePromise) {
    cachePromise = (async () => {
      try {
        // Variable specifier → TypeScript skips static module resolution.
        const spec = '@sanix/semantic-cache';
        return (await import(spec)) as unknown as SemanticCacheModule;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `@sanix/semantic-cache is not available (${msg}). Install it to use \`sanix cache\`.`,
        );
      }
    })();
  }
  return cachePromise;
}

/**
 * Lazily dynamic-import `@sanix/memory-v2`. Cached. Throws a friendly
 * error if the package is missing.
 */
async function loadMemoryV2(): Promise<MemoryV2Module> {
  if (!memv2Promise) {
    memv2Promise = (async () => {
      try {
        // Variable specifier → TypeScript skips static module resolution.
        const spec = '@sanix/memory-v2';
        return (await import(spec)) as unknown as MemoryV2Module;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `@sanix/memory-v2 is not available (${msg}). Install it to use \`sanix cache\`.`,
        );
      }
    })();
  }
  return memv2Promise;
}

/**
 * Build (or return the cached) `SemanticCache` wired to the SANIX
 * embedding provider. The HNSW index is in-memory only — call
 * `cache save` (future) to persist.
 */
async function getCache(
  ctx: SanixContext,
): Promise<SemanticCacheLike> {
  if (semanticCache) return semanticCache;
  const [cacheMod, memMod] = await Promise.all([loadCache(), loadMemoryV2()]);

  // Ensure the SANIX cache directory exists (for future persistence).
  const dir = join(homedir(), '.sanix', 'cache');
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* best-effort */ }

  const vectorIndex = new memMod.HNSWIndex({ dimensions: 384, maxConnections: 16 });

  // Best-effort: instantiate the default embedding provider. This may
  // fail (no transformers installed); the cache degrades to "miss on
  // every query" in that case.
  let embeddingProvider: EmbedProviderLike | undefined;
  try {
    embeddingProvider = cacheMod.createEmbeddingProvider();
  } catch {
    embeddingProvider = undefined;
  }

  const enabled = (ctx.config as unknown as { cache?: { enabled?: boolean } }).cache?.enabled !== false;
  if (!enabled) {
    throw new Error('Semantic cache is disabled in the config (cache.enabled=false).');
  }

  semanticCache = new cacheMod.SemanticCache({
    vectorIndex,
    embeddingProvider,
    threshold: 0.92,
    ttlMs: 24 * 60 * 60 * 1000, // 24h
    maxSize: 10_000,
  });
  return semanticCache;
}

/**
 * Register the `sanix cache` command tree.
 *
 * @param program       - The Commander root program.
 * @param ctxProvider   - Lazy context provider (called on first action).
 */
export function registerCacheCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const cache = program
    .command('cache')
    .description('Inspect and manage the semantic LLM response cache.');

  cache
    .command('stats')
    .description('Show cache hit/miss statistics.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        cacheStats(ctx);
      } catch (err) {
        fail('cache stats', err);
      }
    });

  cache
    .command('clear')
    .description('Clear every entry from the cache.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        await cacheClear(ctx);
      } catch (err) {
        fail('cache clear', err);
      }
    });

  cache
    .command('lookup <query>')
    .description('Look up `query` in the cache; print the hit (if any).')
    .option(
      '--threshold <r>',
      'Similarity threshold (default 0.92).',
      parseFloat,
      0.92,
    )
    .action(async (query: string, opts: CacheLookupOptions) => {
      try {
        const ctx = await ctxProvider();
        await cacheLookup(ctx, query, opts);
      } catch (err) {
        fail('cache lookup', err);
      }
    });

  cache
    .command('invalidate <query>')
    .description('Invalidate cache entries whose query is similar to `query`.')
    .action(async (query: string) => {
      try {
        const ctx = await ctxProvider();
        await cacheInvalidate(ctx, query);
      } catch (err) {
        fail('cache invalidate', err);
      }
    });

  cache
    .command('list')
    .description('List recent cache entries (in this process).')
    .option('--limit <n>', 'Max entries to list (default 20).', (v: string) => Number(v), 20)
    .action(async (opts: CacheListOptions) => {
      try {
        cacheList(opts);
      } catch (err) {
        fail('cache list', err);
      }
    });
}

/** `sanix cache stats`. */
export function cacheStats(ctx: SanixContext): void {
  if (!semanticCache) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('Cache not initialized yet (no entries).'));
    return;
  }
  const s = semanticCache.stats();
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('Semantic cache statistics:\n'));
  // eslint-disable-next-line no-console
  console.log(`  Entries         : ${chalk.green(String(s.entries))}`);
  // eslint-disable-next-line no-console
  console.log(`  Hits            : ${chalk.green(String(s.hits))}`);
  // eslint-disable-next-line no-console
  console.log(`  Misses          : ${chalk.dim(String(s.misses))}`);
  // eslint-disable-next-line no-console
  console.log(`  Hit rate        : ${chalk.cyan(`${(s.hitRate * 100).toFixed(1)}%`)}`);
  // eslint-disable-next-line no-console
  console.log(`  Tokens saved    : ${chalk.dim(String(s.tokensSaved))}`);
  // eslint-disable-next-line no-console
  console.log(`  Cost saved (USD): ${chalk.dim(`$${s.costSavedUsd.toFixed(4)}`)}`);
  // eslint-disable-next-line no-console
  console.log(`  Avg query time  : ${chalk.dim(`${s.avgQueryTimeMs.toFixed(1)}ms`)}`);
  // eslint-disable-next-line no-console
  console.log(`  Avg cache time  : ${chalk.dim(`${s.avgCacheTimeMs.toFixed(1)}ms`)}`);
}

/** `sanix cache clear`. */
export async function cacheClear(ctx: SanixContext): Promise<void> {
  const c = await getCache(ctx);
  await c.clear();
  entryMirror.length = 0;
  // eslint-disable-next-line no-console
  console.log(chalk.green('✓ Cache cleared.'));
}

/** `sanix cache lookup "<query>"`. */
export async function cacheLookup(
  ctx: SanixContext,
  query: string,
  opts: CacheLookupOptions,
): Promise<void> {
  const c = await getCache(ctx);
  const hit = await c.get(query, { threshold: opts.threshold });
  if (!hit) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`No cache hit for "${query}".`));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.green('✓ Cache hit:\n'));
  // eslint-disable-next-line no-console
  console.log(`  Query     : ${chalk.cyan(hit.query)}`);
  // eslint-disable-next-line no-console
  console.log(`  Hits      : ${chalk.dim(String(hit.hitCount))}`);
  // eslint-disable-next-line no-console
  console.log(`  Created   : ${chalk.dim(new Date(hit.createdAt).toISOString())}`);
  if (hit.provider) {
    // eslint-disable-next-line no-console
    console.log(`  Provider  : ${chalk.dim(hit.provider)}`);
  }
  if (hit.tokensUsed) {
    // eslint-disable-next-line no-console
    console.log(`  Tokens    : ${chalk.dim(String(hit.tokensUsed))}`);
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#FFB347')('\nResponse:\n'));
  // eslint-disable-next-line no-console
  console.log(hit.response);
}

/** `sanix cache invalidate "<query>"`. */
export async function cacheInvalidate(
  ctx: SanixContext,
  query: string,
): Promise<void> {
  const c = await getCache(ctx);
  await c.invalidate(query);
  // Drop mirrored entries that match (best-effort: drop all since
  // invalidation is fuzzy — we don't know exactly which ones matched).
  for (let i = entryMirror.length - 1; i >= 0; i--) {
    if (entryMirror[i]!.query.toLowerCase().includes(query.toLowerCase())) {
      entryMirror.splice(i, 1);
    }
  }
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Invalidated cache entries similar to "${query}".`));
}

/** `sanix cache list`. */
export function cacheList(opts: CacheListOptions): void {
  if (entryMirror.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No cache entries in this process yet.'));
    return;
  }
  const limit = opts.limit ?? 20;
  const sorted = [...entryMirror].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Cache entries (${sorted.length}):\n`));
  for (const e of sorted) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${chalk.cyan(e.id.slice(0, 8))} ${chalk.dim(`hits=${e.hitCount}`)} ${chalk.dim(new Date(e.createdAt).toISOString())}`,
    );
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`    q: ${e.query.slice(0, 80)}`));
  }
}

/** Print a red error and set exit code 1. */
function fail(cmd: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(chalk.red(`\n✗ sanix ${cmd} failed: ${msg}\n`));
  process.exitCode = 1;
}

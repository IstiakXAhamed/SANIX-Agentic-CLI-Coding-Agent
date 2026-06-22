/**
 * @file CacheMetadataStore.ts
 * @description SQLite-backed persistence for {@link CacheEntry}
 * records. Stores everything **except** the HNSW vector graph (which
 * is persisted separately via `HNSWIndex.save()`).
 *
 * ## Schema
 *
 * ```sql
 * CREATE TABLE entries (
 *   id            TEXT PRIMARY KEY,
 *   query         TEXT NOT NULL,
 *   query_embedding BLOB NOT NULL,   -- raw Float32 bytes
 *   response      TEXT NOT NULL,
 *   metadata      TEXT NOT NULL,     -- JSON
 *   created_at    INTEGER NOT NULL,
 *   expires_at    INTEGER NOT NULL,
 *   hit_count     INTEGER NOT NULL DEFAULT 0,
 *   provider      TEXT,
 *   model         TEXT,
 *   tokens_used   INTEGER,
 *   cost_usd      REAL
 * );
 * ```
 *
 * ## Atomic writes
 *
 * All writes happen inside a SQLite transaction (WAL mode). For
 * filesystem-style operations the store uses temp-file-then-rename
 * via SQLite's own atomic-commit mechanism; callers do not need to
 * manage this.
 *
 * ## Concurrency
 *
 * SQLite (in WAL mode) supports concurrent readers with a single
 * writer. The store sequences writes through a promise-chain mutex
 * (in-process) so concurrent `set` / `delete` calls do not race on
 * the database handle.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { CacheEntry } from './types.js';

const nodeRequire = createRequire(import.meta.url);

/** Constructor options. */
export interface CacheMetadataStoreOptions {
  /** Path to the SQLite database file. Required. */
  path: string;
  /**
   * If false, do not create the table on construction (useful for
   * tests that pre-create the schema). Default true.
   */
  createTable?: boolean;
}

/** Row shape returned by SQLite queries (before normalization). */
interface EntryRow {
  id: string;
  query: string;
  query_embedding: Buffer;
  response: string;
  metadata: string;
  created_at: number;
  expires_at: number;
  hit_count: number;
  provider: string | null;
  model: string | null;
  tokens_used: number | null;
  cost_usd: number | null;
}

/**
 * SQLite-backed cache metadata store.
 *
 * @example
 * ```ts
 * const store = new CacheMetadataStore({ path: './cache.db' });
 * await store.set(entry);
 * const hit = await store.get(entry.id);
 * await store.deleteExpired(Date.now());
 * ```
 */
export class CacheMetadataStore {
  private readonly db: BetterSqlite3Database;
  /** Promise chain used as a mutex for write operations. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: CacheMetadataStoreOptions) {
    if (!opts.path) throw new Error('CacheMetadataStore: `path` is required');
    const dir = dirname(opts.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const Database = nodeRequire('better-sqlite3') as typeof import('better-sqlite3');
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    if (opts.createTable !== false) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          id              TEXT PRIMARY KEY,
          query           TEXT NOT NULL,
          query_embedding BLOB NOT NULL,
          response        TEXT NOT NULL,
          metadata        TEXT NOT NULL,
          created_at      INTEGER NOT NULL,
          expires_at      INTEGER NOT NULL,
          hit_count       INTEGER NOT NULL DEFAULT 0,
          provider        TEXT,
          model           TEXT,
          tokens_used     INTEGER,
          cost_usd        REAL
        );
        CREATE INDEX IF NOT EXISTS idx_entries_expires
          ON entries (expires_at);
        CREATE INDEX IF NOT EXISTS idx_entries_created
          ON entries (created_at);
      `);
    }
  }

  /**
   * Get a single entry by id. Returns `undefined` if not found.
   */
  get(id: string): CacheEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM entries WHERE id = ?')
      .get(id) as EntryRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /**
   * Get all entries whose query text matches `query` exactly (case-
   * sensitive). Used for text-based invalidation; similarity-based
   * lookup is handled by the cache itself (via the HNSW index).
   */
  getByQuery(query: string): CacheEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM entries WHERE query = ?')
      .all(query) as EntryRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Insert (or replace) an entry. Sequenced through the write mutex
   * so concurrent writes do not race.
   */
  set(entry: CacheEntry): Promise<void> {
    return this.serialize(() => {
      const emb = Buffer.from(
        entry.queryEmbedding.buffer,
        entry.queryEmbedding.byteOffset,
        entry.queryEmbedding.byteLength,
      );
      this.db
        .prepare(
          `INSERT INTO entries
             (id, query, query_embedding, response, metadata,
              created_at, expires_at, hit_count, provider, model,
              tokens_used, cost_usd)
           VALUES
             (@id, @query, @emb, @response, @metadata,
              @created_at, @expires_at, @hit_count, @provider, @model,
              @tokens_used, @cost_usd)
           ON CONFLICT(id) DO UPDATE SET
             query = @query,
             query_embedding = @emb,
             response = @response,
             metadata = @metadata,
             created_at = @created_at,
             expires_at = @expires_at,
             hit_count = @hit_count,
             provider = @provider,
             model = @model,
             tokens_used = @tokens_used,
             cost_usd = @cost_usd`,
        )
        .run({
          id: entry.id,
          query: entry.query,
          emb,
          response: entry.response,
          metadata: JSON.stringify(entry.metadata),
          created_at: entry.createdAt,
          expires_at: entry.expiresAt,
          hit_count: entry.hitCount,
          provider: entry.provider ?? null,
          model: entry.model ?? null,
          tokens_used: entry.tokensUsed ?? null,
          cost_usd: entry.costUsd ?? null,
        });
    });
  }

  /**
   * Delete an entry by id. Returns `true` if it existed.
   */
  delete(id: string): Promise<boolean> {
    return this.serialize(() => {
      const info = this.db
        .prepare('DELETE FROM entries WHERE id = ?')
        .run(id);
      return info.changes > 0;
    });
  }

  /**
   * Delete all entries whose `expires_at` is ≤ `now` (and any entries
   * with `expires_at = 0`, which are treated as "never expire" and
   * are NOT deleted). Returns the number of deleted entries.
   */
  deleteExpired(now: number): Promise<number> {
    return this.serialize(() => {
      const info = this.db
        .prepare('DELETE FROM entries WHERE expires_at > 0 AND expires_at <= ?')
        .run(now);
      return info.changes;
    });
  }

  /**
   * Number of entries in the store.
   */
  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM entries')
      .get() as { n: number };
    return row.n;
  }

  /**
   * Return all entries, ordered by `created_at` ascending. Used by
   * the cache for LRU eviction (oldest-first).
   */
  listOldestFirst(): CacheEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM entries ORDER BY created_at ASC')
      .all() as EntryRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Remove all entries. Returns nothing.
   */
  clear(): Promise<void> {
    return this.serialize(() => {
      this.db.prepare('DELETE FROM entries').run();
    });
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }

  // ─── Internal ───────────────────────────────────────────────────────

  /**
   * Run `fn` under the write mutex. Reads do not need to lock because
   * SQLite handles concurrent reads natively (WAL mode).
   */
  private serialize<T>(fn: () => T): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return Promise.resolve(next);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Convert a raw SQLite row into a {@link CacheEntry}. */
function rowToEntry(row: EntryRow): CacheEntry {
  const embedding = new Float32Array(
    row.query_embedding.buffer,
    row.query_embedding.byteOffset,
    row.query_embedding.byteLength / 4,
  );
  // Detach from the underlying buffer so downstream mutation does
  // not corrupt the SQLite row's memory.
  const detached = new Float32Array(embedding);
  return {
    id: row.id,
    query: row.query,
    queryEmbedding: detached,
    response: row.response,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    hitCount: row.hit_count,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    tokensUsed: row.tokens_used ?? undefined,
    costUsd: row.cost_usd ?? undefined,
  };
}

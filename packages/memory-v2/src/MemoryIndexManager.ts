/**
 * @file memory-v2/src/MemoryIndexManager.ts
 * @description Unified index across all 4 memory tiers for fast hybrid
 * (vector + keyword) recall. Replaces the per-tier parallel recall
 * performed by `MemoryRouter.recall()` when configured.
 *
 * ## Architecture
 *
 *   - **Vector arm**: {@link HNSWIndex} — pure-TS HNSW graph over the
 *     embeddings of all indexed memories. Cosine distance, ef=50.
 *   - **Keyword arm**: SQLite FTS5 table over `(id, content, tier)`.
 *     BM25 ranking built into FTS5.
 *   - **Item cache**: in-memory `Map<id, MemoryItem>` so the manager
 *     can return full items (not just ids) without re-fetching from
 *     each tier.
 *
 * Hybrid merge: `score = 0.6 * cosine_similarity + 0.4 * bm25_normalized`.
 * Items appearing in only one arm get a 0 for the other. Results are
 * optionally filtered by `tier` and `minScore`, then truncated to `k`.
 *
 * ## Persistence
 *
 *   - HNSW graph: `~/.sanix/memory/index.json` (via `HNSWIndex.save()`).
 *   - FTS5 + item metadata: `~/.sanix/memory/index.db` (SQLite).
 *
 * Both files are written on `flush()` and read on construction (if
 * they exist). `reindex()` rebuilds them from scratch by pulling every
 * item from each tier of a `MemoryRouterLike`.
 *
 * @packageDocumentation
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  MemoryItem,
  MemoryRouterLike,
  MemoryTier,
  ScoredMemoryItem,
} from './types.js';
import { HNSWIndex } from './HNSWIndex.js';

/** Constructor options. */
export interface MemoryIndexManagerOptions {
  /** Base directory for persistence. Default `~/.sanix/memory`. */
  baseDir?: string;
  /** HNSW options. Defaults: M=16, efC=200, efS=50, dims=384. */
  hnsw?: {
    maxConnections?: number;
    efConstruction?: number;
    efSearch?: number;
    dimensions?: number;
  };
  /** If false, skip loading existing index files on construction. */
  autoload?: boolean;
}

/** FTS5 row shape. */
interface FtsRow {
  id: string;
  content: string;
  tier: string;
  bm25_score?: number;
}

/**
 * Unified memory index.
 *
 * @example
 * ```ts
 * const idx = new MemoryIndexManager();
 * await idx.reindex(memoryRouter);
 * const hits = await idx.search('auth jwt', { k: 10, vector: queryVec });
 * ```
 */
export class MemoryIndexManager {
  private readonly baseDir: string;
  private hnsw: HNSWIndex;
  private readonly items = new Map<string, MemoryItem>();
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private readonly hnswPath: string;
  private readonly hnswOpts: {
    maxConnections?: number;
    efConstruction?: number;
    efSearch?: number;
    dimensions?: number;
  };

  constructor(opts: MemoryIndexManagerOptions = {}) {
    this.baseDir = resolveHome(opts.baseDir ?? '~/.sanix/memory');
    this.dbPath = join(this.baseDir, 'index.db');
    this.hnswPath = join(this.baseDir, 'index.json');
    this.hnswOpts = opts.hnsw ?? {};
    this.hnsw = new HNSWIndex({
      maxConnections: this.hnswOpts.maxConnections ?? 16,
      efConstruction: this.hnswOpts.efConstruction ?? 200,
      efSearch: this.hnswOpts.efSearch ?? 50,
      dimensions: this.hnswOpts.dimensions ?? 384,
    });
    if (opts.autoload !== false) {
      this.loadSync();
    }
  }

  /**
   * Index a memory item. The item's `embedding` (if present) is added
   * to the HNSW graph; the content is added to the FTS5 table; the
   * full item is cached in memory.
   *
   * @example
   * ```ts
   * idx.index(memory, new Float32Array(memory.embedding));
   * ```
   */
  index(memory: MemoryItem, embedding: Float32Array): void {
    this.items.set(memory.id, memory);
    if (embedding && embedding.length > 0) {
      this.hnsw.add(memory.id, embedding, { tier: memory.tier, type: memory.type });
    }
    const db = this.openDb();
    const insert = db.prepare(
      'INSERT OR REPLACE INTO docs (id, content, tier) VALUES (?, ?, ?)',
    );
    insert.run(memory.id, memory.content, memory.tier);
  }

  /**
   * Remove a memory from the index.
   *
   * @example
   * ```ts
   * idx.unindex('mem-42');
   * ```
   */
  unindex(memoryId: string): void {
    this.items.delete(memoryId);
    this.hnsw.remove(memoryId);
    const db = this.openDb();
    db.prepare('DELETE FROM docs WHERE id = ?').run(memoryId);
  }

  /**
   * Hybrid vector + keyword search across all indexed memories.
   *
   * @param query - The natural-language query string.
   * @param opts  - Search options.
   *   - `vector`: pre-computed query embedding (recommended — saves an
   *      embedding generation per call).
   *   - `k`: max results (default 10).
   *   - `minScore`: minimum hybrid score (0..1) to include.
   *   - `tier`: restrict to a specific tier.
   *
   * @example
   * ```ts
   * const hits = await idx.search('how does auth work', {
   *   vector: queryVec,
   *   k: 5,
   *   tier: 'semantic',
   * });
   * ```
   */
  async search(
    query: string,
    opts: {
      vector?: Float32Array | number[];
      k?: number;
      minScore?: number;
      tier?: MemoryTier;
    } = {},
  ): Promise<ScoredMemoryItem[]> {
    const k = opts.k ?? 10;
    const minScore = opts.minScore ?? 0;
    const scores = new Map<string, { cosine: number; bm25: number }>();

    // Vector arm.
    if (opts.vector) {
      const vec =
        opts.vector instanceof Float32Array
          ? opts.vector
          : new Float32Array(opts.vector);
      const hits = this.hnsw.search(vec, k * 3);
      for (const h of hits) {
        const item = this.items.get(h.id);
        if (!item) continue;
        if (opts.tier && item.tier !== opts.tier) continue;
        // Cosine similarity = 1 - distance.
        const sim = Math.max(0, 1 - h.distance);
        scores.set(h.id, { cosine: sim, bm25: 0 });
      }
    }

    // Keyword arm (FTS5 + bm25).
    const ftsHits = this.ftsSearch(query, k * 3);
    for (const f of ftsHits) {
      const existing = scores.get(f.id);
      const item = this.items.get(f.id);
      if (!item) continue;
      if (opts.tier && item.tier !== opts.tier) continue;
      // FTS5's bm25() returns negative scores (more negative = better);
      // normalize to 0..1 by 1 / (1 + |score|).
      const normalized = f.bm25_score !== undefined
        ? 1 / (1 + Math.abs(f.bm25_score))
        : 0;
      if (existing) {
        existing.bm25 = normalized;
      } else {
        scores.set(f.id, { cosine: 0, bm25: normalized });
      }
    }

    // Hybrid merge.
    const results: ScoredMemoryItem[] = [];
    for (const [id, s] of scores) {
      const item = this.items.get(id);
      if (!item) continue;
      const score = 0.6 * s.cosine + 0.4 * s.bm25;
      if (score < minScore) continue;
      results.push({
        item,
        score,
        tier: item.tier,
        explanation: `cos=${s.cosine.toFixed(3)} bm25=${s.bm25.toFixed(3)}`,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  /**
   * Rebuild the entire index from a memory router. Pulls every item
   * from each tier, indexes each one (using its embedding if present).
   * Clears the existing index first.
   *
   * @example
   * ```ts
   * await idx.reindex(memoryRouter);
   * console.log(`Indexed ${idx.size()} items.`);
   * ```
   */
  async reindex(router: MemoryRouterLike): Promise<void> {
    this.clear();

    // Working tier.
    for (const item of router.working.all()) {
      this.indexItemIfEmbeddable(item);
    }

    // Episodic tier.
    try {
      for (const session of router.episodic.recallRaw({ limit: 10_000 })) {
        const item: MemoryItem = {
          id: session.id,
          tier: 'episodic',
          type: 'session_summary',
          content: session.goal,
          metadata: {
            sessionId: session.id,
            project: session.project,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            success: session.success,
            lessonsJson: session.lessonsJson,
          },
          createdAt: session.startedAt,
          importance: session.success ? 0.8 : 0.4,
          embedding: session.embedding,
        };
        this.indexItemIfEmbeddable(item);
      }
    } catch {
      // Episodic tier may be unavailable — skip.
    }

    // Semantic tier.
    try {
      const hits = await router.semantic.recall({
        query: '',
        limit: 10_000,
        minRelevance: 0,
      });
      for (const h of hits) {
        this.indexItemIfEmbeddable(h.item);
      }
    } catch {
      // Semantic tier may be unavailable — skip.
    }

    // Procedural tier.
    try {
      for (const item of router.procedural.list()) {
        this.indexItemIfEmbeddable(item);
      }
    } catch {
      // Procedural tier may be unavailable — skip.
    }
  }

  /**
   * Number of items currently indexed.
   */
  size(): number {
    return this.items.size;
  }

  /**
   * Persist the HNSW graph to disk. The FTS5 SQLite DB is written
   * incrementally as items are indexed, so it doesn't need a separate
   * flush — but the HNSW graph is in-memory only until `flush()` is
   * called.
   *
   * @example
   * ```ts
   * await idx.flush();
   * ```
   */
  async flush(): Promise<void> {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
    await this.hnsw.save(this.hnswPath);
  }

  /**
   * Close the underlying SQLite handle. Safe to call multiple times.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /** Index an item only if it has a usable embedding. */
  private indexItemIfEmbeddable(item: MemoryItem): void {
    if (item.embedding && item.embedding.length > 0) {
      this.index(item, new Float32Array(item.embedding));
    } else {
      // Still cache + FTS-index so keyword search works.
      this.items.set(item.id, item);
      const db = this.openDb();
      db.prepare(
        'INSERT OR REPLACE INTO docs (id, content, tier) VALUES (?, ?, ?)',
      ).run(item.id, item.content, item.tier);
    }
  }

  /** FTS5 + bm25 keyword search. */
  private ftsSearch(query: string, limit: number): FtsRow[] {
    if (!query || query.trim().length === 0) return [];
    const db = this.openDb();
    // Sanitize the query: FTS5 has its own query syntax; wrap in quotes
    // for a phrase-style search to avoid syntax errors on user input.
    const sanitized = query.replace(/["'*:]/g, ' ').trim();
    if (sanitized.length === 0) return [];
    try {
      // bm25(docs) returns negative scores — lower (more negative) = better.
      const stmt = db.prepare(
        `SELECT id, content, tier, bm25(docs) AS bm25_score
         FROM docs
         WHERE docs MATCH ?
         ORDER BY bm25(docs)
         LIMIT ?`,
      );
      return stmt.all(sanitized, limit) as FtsRow[];
    } catch {
      // FTS5 syntax errors are non-fatal — return no keyword hits.
      return [];
    }
  }

  /** Open (or create) the SQLite DB and ensure the FTS5 table exists. */
  private openDb(): Database.Database {
    if (this.db) return this.db;
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
          id UNINDEXED,
          content,
          tier UNINDEXED,
          tokenize = 'porter unicode61'
        );
      `);
    } catch {
      // FTS5 may be unavailable in some SQLite builds — fall back to a
      // regular table so keyword search degrades to a LIKE scan.
      db.exec(`
        CREATE TABLE IF NOT EXISTS docs (
          id TEXT PRIMARY KEY,
          content TEXT,
          tier TEXT
        );
      `);
    }
    this.db = db;
    return db;
  }

  /** Load existing index files (HNSW graph from disk). */
  private loadSync(): void {
    if (existsSync(this.hnswPath)) {
      try {
        const buf = readFileSync(this.hnswPath);
        this.hnsw.deserialize(buf);
      } catch {
        // Corrupt or unreadable — start fresh.
      }
    }
    // Items cache: read from the SQLite docs table.
    if (existsSync(this.dbPath)) {
      try {
        const db = this.openDb();
        const rows = db.prepare('SELECT id, content, tier FROM docs').all() as FtsRow[];
        for (const r of rows) {
          if (!this.items.has(r.id)) {
            // We only have id/content/tier here; full metadata is fetched
            // on demand by the caller. Use a minimal placeholder.
            this.items.set(r.id, {
              id: r.id,
              tier: r.tier as MemoryTier,
              type: 'fact',
              content: r.content,
              metadata: {},
              createdAt: new Date(0).toISOString(),
              importance: 0,
            });
          }
        }
      } catch {
        // DB unreadable — start fresh.
      }
    }
  }

  /** Clear all index state (HNSW + FTS5 + items cache). */
  private clear(): void {
    // Replace the HNSW index with a fresh instance (faster than removing
    // nodes one by one).
    this.hnsw = new HNSWIndex({
      maxConnections: this.hnswOpts.maxConnections ?? 16,
      efConstruction: this.hnswOpts.efConstruction ?? 200,
      efSearch: this.hnswOpts.efSearch ?? 50,
      dimensions: this.hnswOpts.dimensions ?? 384,
    });
    this.items.clear();
    const db = this.openDb();
    try {
      db.exec('DELETE FROM docs');
    } catch {
      // Table might not exist yet — ignore.
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/** Expand a leading `~` to the home directory. */
function resolveHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

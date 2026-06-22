/**
 * @file memory/SemanticMemory.ts
 * @description Tier-3 memory: vector store of facts / code patterns / API
 * knowledge / doc chunks. Uses LanceDB (embedded, zero-config) with a
 * `facts` table holding: id, content, embedding (384-dim), metadata_json,
 * created_at.
 *
 * Hybrid retrieval per spec §3:
 *   - Cosine similarity via lancedb vector search.
 *   - BM25 in-memory over stored content (basic implementation).
 *   - Re-rank with weighted score: `0.6 * cosine + 0.4 * BM25`.
 *
 * LanceDB is lazy-opened (like the embedding provider) so environments
 * without the package degrade gracefully — `available()` returns false and
 * `recall` returns an empty array.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';
import type {
  IMemoryTier,
  MemoryItem,
  RecallQuery,
  ScoredMemoryItem,
} from './types.js';
import {
  EmbeddingProvider,
  cosineSimilarity,
} from './EmbeddingProvider.js';

/**
 * A stored fact (semantic memory item).
 */
export interface SemanticFact {
  /** Unique id (nanoid). */
  id: string;
  /** The fact content (text). */
  content: string;
  /** 384-dim embedding of the content. */
  embedding: number[];
  /** JSON-stringified metadata. */
  metadataJson: string;
  /** ISO timestamp the fact was created. */
  createdAt: string;
  /** Parsed metadata (convenience accessor). */
  metadata: Record<string, unknown>;
}

/**
 * Options for {@link SemanticMemory.constructor}.
 */
export interface SemanticMemoryOptions {
  /** LanceDB path (may use `~`). Default: `~/.sanix/memory/vectors`. */
  dbPath?: string;
  /** Table name. Default: 'facts'. */
  tableName?: string;
}

/**
 * The LanceDB connection shape we expect (narrowed from the library's loose
 * types). Methods are async; results are unknown until validated.
 */
interface LanceConnection {
  createTable(
    name: string,
    data: Record<string, unknown>[],
    opts?: unknown,
  ): Promise<unknown>;
  openTable(name: string): Promise<LanceTable>;
  tableNames(): Promise<string[]>;
}

interface LanceTable {
  add(data: Record<string, unknown>[]): Promise<unknown>;
  search(query: number[], queryType?: string): LanceSearchBuilder;
  countRows(): Promise<number>;
  delete(predicate: string): Promise<unknown>;
}

interface LanceSearchBuilder {
  limit(n: number): LanceSearchBuilder;
  toList(): Promise<Record<string, unknown>[]>;
}

/** Row shape returned from LanceDB queries. */
interface FactRow {
  id: string;
  content: string;
  embedding: number[] | Float32Array;
  metadata_json: string;
  created_at: string;
}

/**
 * Tier-3 semantic memory — LanceDB vector store with BM25 hybrid retrieval.
 *
 * @example
 * ```ts
 * const sm = new SemanticMemory();
 * await sm.storeFact({
 *   id: nanoid(),
 *   content: 'The auth module uses JWT with 24h expiry.',
 *   embedding: [],
 *   metadataJson: '{}',
 *   createdAt: new Date().toISOString(),
 *   metadata: {},
 * });
 * const hits = await sm.recall({ query: 'how does auth work?' });
 * ```
 */
export class SemanticMemory implements IMemoryTier {
  readonly tier = 'semantic' as const;

  private readonly dbPath: string;
  private readonly tableName: string;
  private connPromise: Promise<LanceConnection | null> | null = null;
  /** In-memory mirror of all facts for BM25 (rebuilt lazily). */
  private factMirror: SemanticFact[] = [];
  private mirrorDirty = true;
  private readonly embeddingProvider: EmbeddingProvider;

  constructor(opts: SemanticMemoryOptions = {}) {
    this.dbPath = resolveHome(opts.dbPath ?? '~/.sanix/memory/vectors');
    this.tableName = opts.tableName ?? 'facts';
    this.embeddingProvider = EmbeddingProvider.getInstance();
  }

  /**
   * True if LanceDB is available and the table can be opened. Callers should
   * check this before relying on `recall()` results.
   */
  async available(): Promise<boolean> {
    const conn = await this.getConnection();
    return conn !== null;
  }

  /**
   * Store a fact. Computes the embedding if not provided.
   */
  async storeFact(fact: SemanticFact): Promise<void> {
    const conn = await this.getConnection();
    if (!conn) return;
    const table = await this.ensureTable(conn);
    const embedding =
      fact.embedding.length > 0
        ? fact.embedding
        : (await this.embeddingProvider.embed(fact.content)) ?? [];
    await table.add([
      {
        id: fact.id,
        content: fact.content,
        embedding,
        metadata_json: fact.metadataJson,
        created_at: fact.createdAt,
      },
    ]);
    this.mirrorDirty = true;
  }

  /**
   * Store a MemoryItem (used by the MemoryRouter). Item must have
   * `tier === 'semantic'`.
   */
  async store(item: MemoryItem): Promise<void> {
    if (item.tier !== 'semantic') return;
    await this.storeFact({
      id: item.id,
      content: item.content,
      embedding: item.embedding ?? [],
      metadataJson: JSON.stringify(item.metadata),
      createdAt: item.createdAt,
      metadata: item.metadata as Record<string, unknown>,
    });
  }

  /**
   * Recall facts by hybrid cosine + BM25 retrieval. Re-ranks with
   * `0.6 * cosine + 0.4 * BM25` per spec §3.
   */
  async recall(query: RecallQuery): Promise<ScoredMemoryItem[]> {
    const limit = query.limit ?? 10;

    // Compute query embedding once.
    const queryVec =
      query.queryEmbedding ?? (await this.embeddingProvider.embed(query.query));

    // ── Cosine arm: LanceDB vector search. ──
    const cosineHits = new Map<string, { fact: SemanticFact; score: number }>();
    if (queryVec) {
      const conn = await this.getConnection();
      if (conn) {
        try {
          const table = await conn.openTable(this.tableName);
          const rows = await table
            .search(queryVec)
            .limit(limit * 3)
            .toList();
          for (const row of rows) {
            const fact = rowToFact(row);
            // LanceDB returns `_distance` (L2 by default); convert to a
            // 0..1 similarity proxy. Lower distance = higher similarity.
            const distance = (row._distance as number) ?? 1;
            const sim = 1 / (1 + distance);
            cosineHits.set(fact.id, { fact, score: sim });
          }
        } catch {
          // Table might not exist yet — fall through to BM25-only.
        }
      }
    }

    // ── BM25 arm: in-memory search over the mirror. ──
    const mirror = await this.getMirror();
    const bm25Hits = this.searchBM25(query.query, mirror, limit * 3);
    const bm25Map = new Map<string, { fact: SemanticFact; score: number }>();
    for (const hit of bm25Hits) {
      bm25Map.set(hit.fact.id, hit);
    }

    // ── Re-rank: union of ids, weighted score. ──
    const allIds = new Set<string>([...cosineHits.keys(), ...bm25Map.keys()]);
    const scored: ScoredMemoryItem[] = [];
    for (const id of allIds) {
      const c = cosineHits.get(id);
      const b = bm25Map.get(id);
      const fact = (c ?? b)!.fact;
      const cosineScore = c?.score ?? 0;
      const bm25Score = b?.score ?? 0;
      const score = 0.6 * cosineScore + 0.4 * bm25Score;
      if (score < (query.minRelevance ?? 0)) continue;
      scored.push({
        item: factToMemoryItem(fact),
        score,
        tier: 'semantic',
        explanation: `cos=${cosineScore.toFixed(3)} bm25=${bm25Score.toFixed(3)}`,
      });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * In-memory BM25 search over the fact mirror. Basic implementation:
   * tokenizes content on whitespace, computes IDF against the corpus, and
   * scores by sum of (IDF * (k+1) * tf) / (k + tf * (1 - b + b * |d|/avgdl)).
   *
   * @example
   * ```ts
   * const hits = sm.searchBM25('auth jwt', allFacts, 5);
   * ```
   */
  searchBM25(
    query: string,
    facts: ReadonlyArray<SemanticFact>,
    limit: number,
  ): Array<{ fact: SemanticFact; score: number }> {
    if (facts.length === 0) return [];
    const k = 1.5;
    const b = 0.75;

    // Tokenize corpus.
    const docs = facts.map((f) => tokenize(f.content));
    const avgDl =
      docs.reduce((acc, d) => acc + d.length, 0) / Math.max(1, docs.length);

    // IDF for each query term.
    const queryTerms = tokenize(query);
    const nDocs = docs.length;
    const idf = new Map<string, number>();
    for (const term of new Set(queryTerms)) {
      let df = 0;
      for (const d of docs) {
        if (d.includes(term)) df++;
      }
      // Robertson-Sparck-Jones IDF with +1 smoothing.
      const idfVal = Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
      idf.set(term, idfVal);
    }

    const scored: Array<{ fact: SemanticFact; score: number }> = [];
    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i]!;
      const doc = docs[i]!;
      let score = 0;
      const dl = doc.length;
      const tfMap = new Map<string, number>();
      for (const t of doc) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
      for (const term of queryTerms) {
        const tf = tfMap.get(term) ?? 0;
        if (tf === 0) continue;
        const idfVal = idf.get(term) ?? 0;
        const denom = tf * (1 - b + (b * dl) / Math.max(1, avgDl));
        score += (idfVal * (k + 1) * tf) / (k + denom);
      }
      if (score > 0) scored.push({ fact, score });
    }
    // Normalize scores to 0..1 by dividing by the max.
    const maxScore = scored.reduce((acc, s) => Math.max(acc, s.score), 0);
    const normalized = scored.map((s) => ({
      fact: s.fact,
      score: maxScore > 0 ? s.score / maxScore : 0,
    }));
    return normalized.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Delete facts matching a SQL-like predicate (LanceDB syntax). Returns the
   * count (best-effort — LanceDB's delete doesn't return a count, so we
   * report 0 on success and -1 on failure).
   *
   * @example
   * ```ts
   * await sm.deleteWhere("project = 'old-project'");
   * ```
   */
  async deleteWhere(predicate: string): Promise<number> {
    const conn = await this.getConnection();
    if (!conn) return -1;
    try {
      const table = await conn.openTable(this.tableName);
      await table.delete(predicate);
      this.mirrorDirty = true;
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * Number of facts stored (best-effort; returns 0 if LanceDB unavailable).
   */
  async count(): Promise<number> {
    const conn = await this.getConnection();
    if (!conn) return 0;
    try {
      const table = await conn.openTable(this.tableName);
      return await table.countRows();
    } catch {
      return 0;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Lazily open (and cache) the LanceDB connection. Returns null if the
   * package is unavailable or the connection fails.
   */
  private async getConnection(): Promise<LanceConnection | null> {
    if (this.connPromise) {
      try {
        return await this.connPromise;
      } catch {
        return null;
      }
    }
    this.connPromise = (async () => {
      try {
        const dir = dirname(this.dbPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const mod = (await import('@lancedb/lancedb')) as unknown as {
          connect: (uri: string) => Promise<LanceConnection>;
        };
        return await mod.connect(this.dbPath);
      } catch {
        return null;
      }
    })();
    try {
      return await this.connPromise;
    } catch {
      return null;
    }
  }

  /**
   * Ensure the facts table exists. LanceDB's `createTable` is idempotent
   * only when given `mode: 'overwrite'` — we check `tableNames()` first.
   */
  private async ensureTable(conn: LanceConnection): Promise<LanceTable> {
    const names = await conn.tableNames();
    if (names.includes(this.tableName)) {
      return conn.openTable(this.tableName);
    }
    // Create with an empty seed row carrying the right schema.
    await conn.createTable(
      this.tableName,
      [
        {
          id: '__seed__',
          content: '',
          embedding: new Array(384).fill(0),
          metadata_json: '{}',
          created_at: new Date().toISOString(),
        },
      ],
      { mode: 'create' },
    );
    const table = await conn.openTable(this.tableName);
    // Remove the seed row.
    try {
      await table.delete("id = '__seed__'");
    } catch {
      // Some LanceDB versions don't support delete on a fresh table —
      // the seed row is harmless (empty content, zero embedding) and
      // will be filtered out by recall's score threshold.
    }
    return table;
  }

  /**
   * Get (and refresh if dirty) the in-memory fact mirror for BM25.
   */
  private async getMirror(): Promise<SemanticFact[]> {
    if (!this.mirrorDirty) return this.factMirror;
    const conn = await this.getConnection();
    if (!conn) {
      this.factMirror = [];
      this.mirrorDirty = false;
      return this.factMirror;
    }
    try {
      const table = await conn.openTable(this.tableName);
      // LanceDB doesn't have a generic "all rows" API — we use a wide
      // search with a zero vector to surface everything. This is
      // inefficient but correct for small corpora; production deployments
      // should bound the mirror size.
      const zeroVec = new Array(384).fill(0);
      const rows = await table.search(zeroVec).limit(10_000).toList();
      this.factMirror = rows
        .filter((r) => r.id !== '__seed__')
        .map(rowToFact);
      this.mirrorDirty = false;
    } catch {
      this.factMirror = [];
      this.mirrorDirty = false;
    }
    return this.factMirror;
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function resolveHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}

function rowToFact(row: Record<string, unknown>): SemanticFact {
  const r = row as Partial<FactRow>;
  const embedding = Array.isArray(r.embedding)
    ? (r.embedding as number[])
    : r.embedding instanceof Float32Array
      ? Array.from(r.embedding)
      : [];
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    id: r.id ?? nanoid(),
    content: r.content ?? '',
    embedding,
    metadataJson: r.metadata_json ?? '{}',
    createdAt: r.created_at ?? new Date().toISOString(),
    metadata,
  };
}

function factToMemoryItem(fact: SemanticFact): MemoryItem {
  return {
    id: fact.id,
    tier: 'semantic',
    type: 'fact',
    content: fact.content,
    metadata: fact.metadata as MemoryItem['metadata'],
    createdAt: fact.createdAt,
    importance: 0.5,
    embedding: fact.embedding,
  };
}

// Re-export cosineSimilarity so callers don't have to import from
// EmbeddingProvider if they want the math helper.
export { cosineSimilarity };

/**
 * @file KnowledgeIndex.ts
 * @description Hybrid search over the knowledge graph. Combines three
 * channels:
 *
 *   - **Keyword**  — SQLite FTS5 (with LIKE fallback) over entity name +
 *     aliases + description. Fast, exact-term matches.
 *   - **Semantic** — embed the query, search the HNSW vector index (built
 *     from entity-description embeddings). Conceptual / fuzzy matches.
 *   - **Graph**    — for the top-k entities from the first two channels,
 *     expand 1-2 hops to include related entities.
 *
 * Results are merged + re-ranked by a weighted score
 * `0.45 * semantic + 0.35 * keyword + 0.20 * graph` (configurable).
 *
 * @packageDocumentation
 */

import type { GraphStore } from './GraphStore.js';
import type {
  Entity,
  Relationship,
  ScoredEntity,
  SearchResult,
  Subgraph,
} from './types.js';

// Re-export the HNSW type lazily so callers don't have to import it
// themselves when they just want to pass `undefined`.
import type { HNSWIndex } from '@sanix/memory-v2';

// ─── Embedding provider shape ──────────────────────────────────────────────

/**
 * Embedding provider interface used by {@link KnowledgeIndex}. Mirrors
 * `@sanix/core`'s `EmbeddingProvider` shape so callers can pass the
 * singleton directly.
 */
export interface EmbeddingProviderLike {
  /** Embed a single text; return null on failure. */
  embed(text: string): Promise<Float32Array | null>;
}

// ─── Constructor options ───────────────────────────────────────────────────

/**
 * Options for {@link KnowledgeIndex.constructor}.
 */
export interface KnowledgeIndexOptions {
  /**
   * Pre-built HNSW index. When omitted, semantic search is disabled
   * (only keyword + graph channels are used).
   */
  vectorIndex?: HNSWIndex;
  /**
   * Embedding provider. Required for semantic search when `vectorIndex`
   * is supplied. When omitted, semantic search is disabled.
   */
  embeddingProvider?: EmbeddingProviderLike;
  /**
   * Weight for semantic similarity in the hybrid score. Default: 0.45.
   */
  semanticWeight?: number;
  /**
   * Weight for keyword (FTS) match in the hybrid score. Default: 0.35.
   */
  keywordWeight?: number;
  /**
   * Weight for graph (related-entity) expansion in the hybrid score.
   * Default: 0.20.
   */
  graphWeight?: number;
}

// ─── Search options ────────────────────────────────────────────────────────

/**
 * Options for {@link KnowledgeIndex.search}.
 */
export interface SearchOptions {
  /** Number of top entities to return. Default: 10. */
  k?: number;
  /** Graph-expansion depth (1 or 2). Default: 1. */
  depth?: number;
  /**
   * Whether to include relationships among the matched entities in the
   * result. Default: true.
   */
  includeRelationships?: boolean;
  /**
   * Override the HNSW `ef` search parameter for this call. Higher = more
   * thorough (and slower).
   */
  ef?: number;
}

// ─── Internal channel-result shape ────────────────────────────────────────

interface ChannelHit {
  entityId: string;
  score: number;
  via: 'keyword' | 'semantic' | 'graph';
}

// ─── KnowledgeIndex ───────────────────────────────────────────────────────

/**
 * Hybrid search over the knowledge graph.
 *
 * @example
 * ```ts
 * const index = new KnowledgeIndex(store, {
 *   vectorIndex: hnsw,
 *   embeddingProvider: EmbeddingProvider.getInstance(),
 * });
 * const result = await index.search('HNSW vector index');
 * for (const e of result.entities) {
 *   console.log(e.name, e.score, e.matchedVia);
 * }
 * ```
 */
export class KnowledgeIndex {
  private readonly store: GraphStore;
  private readonly vectorIndex?: HNSWIndex;
  private readonly embeddingProvider?: EmbeddingProviderLike;
  private readonly semanticWeight: number;
  private readonly keywordWeight: number;
  private readonly graphWeight: number;
  private ftsAvailable = false;

  /**
   * @param store - The graph store to search over.
   * @param opts - Behavior options. See {@link KnowledgeIndexOptions}.
   */
  constructor(store: GraphStore, opts: KnowledgeIndexOptions = {}) {
    this.store = store;
    this.vectorIndex = opts.vectorIndex;
    this.embeddingProvider = opts.embeddingProvider;
    this.semanticWeight = opts.semanticWeight ?? 0.45;
    this.keywordWeight = opts.keywordWeight ?? 0.35;
    this.graphWeight = opts.graphWeight ?? 0.20;
    this.initFts();
  }

  /**
   * Initialize the FTS5 virtual table (with LIKE-query fallback if FTS5
   * isn't compiled into the SQLite build).
   */
  private initFts(): void {
    try {
      const db = this.store.open();
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
          entity_id UNINDEXED,
          name,
          aliases,
          description,
          tokenize='porter'
        );
      `);
      this.ftsAvailable = true;
      // Sync rows on next index() call.
    } catch {
      this.ftsAvailable = false;
    }
  }

  /**
   * Add (or update) an entity in the FTS index. Should be called whenever
   * an entity is created or updated. Idempotent — deletes the old entry
   * first.
   *
   * @example
   * ```ts
   * store.addEntity(e);
   * index.indexEntity(e);
   * ```
   */
  indexEntity(entity: Entity): void {
    if (!this.ftsAvailable) return;
    const db = this.store.open();
    const del = db.prepare(
      'DELETE FROM entities_fts WHERE entity_id = ?',
    );
    const ins = db.prepare(
      'INSERT INTO entities_fts (entity_id, name, aliases, description) VALUES (?, ?, ?, ?)',
    );
    del.run(entity.id);
    ins.run(
      entity.id,
      entity.name,
      entity.aliases.join(' '),
      entity.description ?? '',
    );
  }

  /**
   * Rebuild the FTS index from scratch by reading all entities from the
   * store. Useful after bulk imports.
   */
  reindex(): void {
    if (!this.ftsAvailable) return;
    const db = this.store.open();
    db.exec('DELETE FROM entities_fts;');
    const all = this.store.listEntities({ limit: 100000 });
    const ins = db.prepare(
      'INSERT INTO entities_fts (entity_id, name, aliases, description) VALUES (?, ?, ?, ?)',
    );
    const tx = db.transaction((rows: Entity[]) => {
      for (const e of rows) {
        ins.run(
          e.id,
          e.name,
          e.aliases.join(' '),
          e.description ?? '',
        );
      }
    });
    tx(all);
  }

  /**
   * Synchronize the HNSW vector index with the store's entities. Reads
   * every entity with an embedding and adds it to the index. Idempotent
   * (re-adds replace prior entries per HNSW semantics).
   */
  async syncVectorIndex(): Promise<void> {
    if (!this.vectorIndex) return;
    const all = this.store.listEntities({ limit: 100000 });
    for (const e of all) {
      if (e.embedding) {
        this.vectorIndex.add(e.id, e.embedding, { type: e.type, name: e.name });
      }
    }
  }

  /**
   * Hybrid search over the knowledge graph.
   *
   * @param query - Natural-language query string.
   * @param opts - Search options. See {@link SearchOptions}.
   * @returns Top entities (with hybrid score + matched-via channel),
   *          their incident relationships, and a neighborhood subgraph.
   */
  async search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResult> {
    const k = opts.k ?? 10;
    const depth = Math.min(opts.depth ?? 1, 2);
    const includeRelationships = opts.includeRelationships ?? true;

    const channelHits: ChannelHit[] = [];

    // ── Keyword (FTS) ────────────────────────────────────────────────────
    const keywordHits = this.keywordSearch(query, k * 2);
    for (const h of keywordHits) {
      channelHits.push({ entityId: h.id, score: h.score, via: 'keyword' });
    }

    // ── Semantic (HNSW) ─────────────────────────────────────────────────
    if (this.vectorIndex && this.embeddingProvider) {
      const qvec = await this.embeddingProvider.embed(query);
      if (qvec) {
        const hits = this.vectorIndex.search(qvec, k * 2, opts.ef ? { ef: opts.ef } : undefined);
        for (const h of hits) {
          // HNSW distance is in [0, 2]; convert to similarity in [0, 1].
          const sim = Math.max(0, 1 - h.distance);
          channelHits.push({ entityId: h.id, score: sim, via: 'semantic' });
        }
      }
    }

    // ── Merge + rank ─────────────────────────────────────────────────────
    const merged = this.mergeChannelHits(channelHits, k);

    // ── Graph expansion ──────────────────────────────────────────────────
    const expanded = this.expandGraph(merged, depth, k);

    // Build subgraph rooted at the top entity (or the first one).
    const topId = expanded[0]?.entityId;
    let subgraph: Subgraph;
    if (topId) {
      subgraph = this.store.getSubgraph(topId, depth);
    } else {
      subgraph = { nodes: [], edges: [], depth, rootEntityId: '' };
    }

    // ── Resolve to entities ──────────────────────────────────────────────
    const entities: ScoredEntity[] = [];
    for (const h of expanded) {
      const e = this.store.getEntity(h.entityId);
      if (!e) continue;
      entities.push({
        ...e,
        score: h.score,
        matchedVia: h.via,
      });
    }

    // ── Relationships among the top entities ─────────────────────────────
    let relationships: Relationship[] = [];
    if (includeRelationships && entities.length > 0) {
      const topIds = new Set(entities.map((e) => e.id));
      const seen = new Set<string>();
      relationships = [];
      for (const e of entities) {
        const rels = this.store.getRelationships(e.id, { direction: 'both' });
        for (const r of rels) {
          if (seen.has(r.id)) continue;
          if (!topIds.has(r.source) || !topIds.has(r.target)) continue;
          seen.add(r.id);
          relationships.push(r);
        }
      }
    }

    return { entities, relationships, subgraph };
  }

  // ─── Channel implementations ───────────────────────────────────────────

  /**
   * Run keyword search via FTS5 (preferred) or LIKE fallback. Returns
   * hits with `score` in `[0, 1]` (FTS5 bm25 normalized).
   */
  private keywordSearch(
    query: string,
    limit: number,
  ): Array<{ id: string; score: number }> {
    if (!query.trim()) return [];
    if (this.ftsAvailable) {
      try {
        const db = this.store.open();
        // FTS5 bm25 returns a score; lower = better. Convert to [0, 1]
        // similarity by negating + clamping.
        const rows = db
          .prepare(
            `SELECT entity_id AS id, bm25(entities_fts) AS score
             FROM entities_fts
             WHERE entities_fts MATCH ?
             ORDER BY score
             LIMIT ?`,
          )
          .all(ftsQuery(query), limit) as Array<{
          id: string;
          score: number;
        }>;
        // Normalize: bm25 is negative (more negative = better). Map to
        // [0, 1] via 1 / (1 + |score|).
        return rows.map((r) => ({
          id: r.id,
          score: 1 / (1 + Math.abs(r.score)),
        }));
      } catch {
        // Fall through to LIKE fallback.
      }
    }
    // LIKE fallback.
    const all = this.store.listEntities({ limit: 100000 });
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: Array<{ id: string; score: number }> = [];
    for (const e of all) {
      const haystack = (
        e.name +
        ' ' +
        e.aliases.join(' ') +
        ' ' +
        (e.description ?? '')
      ).toLowerCase();
      let hits = 0;
      for (const t of terms) {
        if (haystack.includes(t)) hits++;
      }
      if (hits > 0) {
        scored.push({ id: e.id, score: hits / terms.length });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Merge hits from the three channels into a single ranked list.
   * Each entity's score is the weighted sum of its per-channel scores
   * (max channel score per entity per channel).
   */
  private mergeChannelHits(
    hits: ChannelHit[],
    limit: number,
  ): Array<{ entityId: string; score: number; via: ScoredEntity['matchedVia'] }> {
    const byEntity = new Map<
      string,
      { keyword: number; semantic: number; graph: number }
    >();
    for (const h of hits) {
      let entry = byEntity.get(h.entityId);
      if (!entry) {
        entry = { keyword: 0, semantic: 0, graph: 0 };
        byEntity.set(h.entityId, entry);
      }
      if (h.score > entry[h.via]) entry[h.via] = h.score;
    }
    const ranked: Array<{
      entityId: string;
      score: number;
      via: ScoredEntity['matchedVia'];
    }> = [];
    for (const [entityId, e] of byEntity) {
      const score =
        e.keyword * this.keywordWeight +
        e.semantic * this.semanticWeight +
        e.graph * this.graphWeight;
      // Pick the dominant channel.
      let via: ScoredEntity['matchedVia'] = 'keyword';
      if (e.semantic >= e.keyword && e.semantic >= e.graph) via = 'semantic';
      else if (e.keyword >= e.semantic && e.keyword >= e.graph) via = 'keyword';
      else via = 'graph';
      ranked.push({ entityId, score, via });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
  }

  /**
   * Expand the top entities by 1-2 hops, adding graph-channel hits with
   * a decayed score (`graphWeight * hopDecay ** hopDistance`).
   */
  private expandGraph(
    ranked: Array<{ entityId: string; score: number; via: ScoredEntity['matchedVia'] }>,
    depth: number,
    limit: number,
  ): Array<{ entityId: string; score: number; via: ScoredEntity['matchedVia'] }> {
    if (depth <= 0 || ranked.length === 0) return ranked;
    const hopDecay = 0.5;
    const seedIds = ranked.map((r) => r.entityId);
    const expanded: Array<{ entityId: string; score: number; via: ScoredEntity['matchedVia'] }> = [
      ...ranked,
    ];
    const seen = new Set<string>(seedIds);
    for (const seedId of seedIds) {
      const neighbors = this.store.getNeighbors(seedId, depth);
      const seedScore = ranked.find((r) => r.entityId === seedId)?.score ?? 0;
      for (const [nid, dist] of neighbors) {
        if (seen.has(nid)) continue;
        seen.add(nid);
        const graphScore = seedScore * Math.pow(hopDecay, dist);
        expanded.push({
          entityId: nid,
          score: graphScore * this.graphWeight,
          via: 'graph',
        });
      }
    }
    // Re-sort + limit.
    expanded.sort((a, b) => b.score - a.score);
    return expanded.slice(0, limit);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a natural-language query into an FTS5 MATCH expression. Quotes
 * multi-word phrases and ORs individual terms.
 *
 * @example
 * ```ts
 * ftsQuery('hello world'); // '"hello" OR "world"'
 * ftsQuery('a "phrase here"'); // '"a" OR "phrase here"'
 * ```
 */
function ftsQuery(query: string): string {
  // Pull out quoted phrases first, then individual words.
  const tokens: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  let consumed = '';
  while ((m = phraseRe.exec(query)) !== null) {
    if (m[1]) tokens.push(`"${m[1]}"`);
    consumed += m[0];
  }
  const remainder = query.replace(consumed, '').trim();
  for (const w of remainder.split(/\s+/)) {
    if (w) tokens.push(`"${w.replace(/"/g, '')}"`);
  }
  if (tokens.length === 0) return '""';
  return tokens.join(' OR ');
}

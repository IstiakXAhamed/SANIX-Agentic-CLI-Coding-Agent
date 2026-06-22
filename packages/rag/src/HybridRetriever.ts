/**
 * @file HybridRetriever.ts
 * @description Hybrid retrieval that combines three arms — dense vector
 * (HNSW), sparse BM25, and field-boosted keyword TF — into a single
 * ranked list. Per-arm scores are z-score normalized across the
 * candidate pool, then linearly combined with configurable weights.
 *
 * ## Algorithm
 *
 *   1. For each configured arm, retrieve the top-`k * 2` candidates.
 *      (We pull more than `k` because z-score normalization makes
 *      low-rank hits from one arm potentially competitive with
 *      high-rank hits from another.)
 *   2. Build the candidate pool = union of all retrieved doc ids.
 *   3. For each arm, compute mean & std-dev of that arm's raw scores
 *      across the candidate pool. Missing hits get a score of 0
 *      (which, after z-scoring, becomes `(0 - mean) / std` — i.e.
 *      "below average").
 *   4. Final score = `w_vec * z_vec + w_bm25 * z_bm25 + w_kw * z_kw`.
 *   5. Sort by final score desc, truncate to `k`, attach per-arm
 *      raw scores in `components`.
 *
 * ## Vector arm
 *
 * Uses HNSWIndex from `@sanix/memory-v2` for approximate nearest
 * neighbor search by cosine distance. The retriever does NOT embed
 * the query itself — `retrieve()` expects `query` to be a string and
 * looks up the embedding from `queryEmbedding` if provided. When no
 * embedding is available, the vector arm is skipped (only BM25 +
 * keyword are used).
 *
 * @packageDocumentation
 */

import type { HNSWIndex } from '@sanix/memory-v2';
import type { Document, DocumentFilter, ScoredDoc } from './types.js';
import { BM25Index } from './BM25Index.js';
import { KeywordIndex } from './KeywordIndex.js';

/** Default per-arm weights (vector 0.5, bm25 0.3, keyword 0.2). */
export const DEFAULT_HYBRID_WEIGHTS = {
  vector: 0.5,
  bm25: 0.3,
  keyword: 0.2,
} as const;

/** Constructor options. */
export interface HybridRetrieverOptions {
  /** Pre-configured HNSW vector index. Optional. */
  vectorIndex?: HNSWIndex;
  /** Pre-configured BM25 index. Optional; created lazily if absent. */
  bm25Index?: BM25Index;
  /** Pre-configured keyword index. Optional; created lazily if absent. */
  keywordIndex?: KeywordIndex;
  /** Per-arm fusion weights. Defaults to {@link DEFAULT_HYBRID_WEIGHTS}. */
  weights?: Partial<typeof DEFAULT_HYBRID_WEIGHTS>;
  /**
   * Optional embedding function. Called on `retrieve()` to embed the
   * query string for the vector arm. If absent, the vector arm is
   * skipped (only BM25 + keyword are consulted).
   */
  embed?: (text: string) => Promise<Float32Array | null>;
  /**
   * Number of candidates to pull from each arm before fusion. Default
   * `k * 2` (overridden per-call).
   */
  candidateMultiplier?: number;
}

/** Retrieve options. */
export interface RetrieveOptions {
  /** Number of final results. Default 10. */
  k?: number;
  /** Minimum final score (post-fusion). Hits below are dropped. */
  minScore?: number;
  /** Filter applied to candidates before fusion. */
  filter?: DocumentFilter;
  /** Override the query embedding (skip the `embed` call). */
  queryEmbedding?: Float32Array;
}

/**
 * Hybrid retriever combining vector + BM25 + keyword arms.
 *
 * @example
 * ```ts
 * const retriever = new HybridRetriever({ vectorIndex: hnsw });
 * await retriever.addDocument(doc1);
 * await retriever.addDocument(doc2);
 * const hits = await retriever.retrieve('auth jwt token', { k: 5 });
 * ```
 */
export class HybridRetriever {
  private readonly vectorIndex?: HNSWIndex;
  private readonly bm25Index: BM25Index;
  private readonly keywordIndex: KeywordIndex;
  private readonly weights: typeof DEFAULT_HYBRID_WEIGHTS;
  private readonly embedFn?: (text: string) => Promise<Float32Array | null>;
  private readonly candidateMultiplier: number;
  /** In-memory doc cache populated by `addDocument`. */
  private readonly docs = new Map<string, Document>();

  constructor(opts: HybridRetrieverOptions = {}) {
    this.vectorIndex = opts.vectorIndex;
    this.bm25Index = opts.bm25Index ?? new BM25Index();
    this.keywordIndex = opts.keywordIndex ?? new KeywordIndex();
    this.weights = { ...DEFAULT_HYBRID_WEIGHTS, ...opts.weights };
    this.embedFn = opts.embed;
    this.candidateMultiplier = opts.candidateMultiplier ?? 2;
  }

  /**
   * Index a document into all configured backends. The document is
   * cached in memory so the retriever can return full `Document`
   * objects on `retrieve()` (the underlying indexes only return ids).
   *
   * @example
   * ```ts
   * await retriever.addDocument({ id: 'd1', content, metadata: {...} });
   * ```
   */
  async addDocument(doc: Document): Promise<void> {
    this.docs.set(doc.id, doc);
    this.bm25Index.add(doc);
    this.keywordIndex.add(doc);
    if (this.vectorIndex && doc.embedding) {
      this.vectorIndex.add(doc.id, doc.embedding, { docId: doc.id });
    }
  }

  /**
   * Remove a document from all backends.
   */
  removeDocument(id: string): void {
    this.docs.delete(id);
    this.bm25Index.remove(id);
    this.keywordIndex.remove(id);
    this.vectorIndex?.remove(id);
  }

  /** Number of documents currently indexed. */
  size(): number {
    return this.docs.size;
  }

  /**
   * Retrieve the top-`k` documents for `query`, fused across all
   * configured arms.
   *
   * @example
   * ```ts
   * const hits = await retriever.retrieve('auth jwt', {
   *   k: 10,
   *   filter: (d) => d.metadata.source.endsWith('.md'),
   * });
   * for (const h of hits) console.log(h.doc.id, h.score, h.components);
   * ```
   */
  async retrieve(
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<ScoredDoc[]> {
    const k = opts.k ?? 10;
    const candidatesPerArm = Math.max(k * this.candidateMultiplier, k);

    // Resolve the query embedding (if we have a vector arm + embed fn).
    let qEmb: Float32Array | null | undefined = opts.queryEmbedding;
    if (qEmb === undefined && this.vectorIndex && this.embedFn) {
      try {
        qEmb = await this.embedFn(query);
      } catch {
        qEmb = null;
      }
    }

    // Pull candidates from each configured arm.
    const vectorHits = new Map<string, number>();
    const bm25Hits = new Map<string, number>();
    const keywordHits = new Map<string, number>();

    if (this.vectorIndex && qEmb) {
      const results = this.vectorIndex.search(qEmb, candidatesPerArm);
      for (const r of results) {
        // HNSW returns distance (0 = identical, 2 = opposite).
        // Convert to similarity in [0, 1] for an interpretable score.
        vectorHits.set(r.id, 1 - r.distance);
      }
    }
    if (this.bm25Index.size() > 0) {
      for (const h of this.bm25Index.search(query, candidatesPerArm)) {
        bm25Hits.set(h.id, h.score);
      }
    }
    if (this.keywordIndex.size() > 0) {
      for (const h of this.keywordIndex.search(query, candidatesPerArm)) {
        keywordHits.set(h.id, h.score);
      }
    }

    // Build candidate pool (union of all arm hits).
    const pool = new Set<string>([
      ...vectorHits.keys(),
      ...bm25Hits.keys(),
      ...keywordHits.keys(),
    ]);

    // Apply the optional filter up front to drop unwanted candidates.
    const poolFiltered: string[] = [];
    for (const id of pool) {
      const doc = this.docs.get(id);
      if (!doc) continue;
      if (opts.filter && !opts.filter(doc)) continue;
      poolFiltered.push(id);
    }
    if (poolFiltered.length === 0) return [];

    // Z-score normalize each arm across the candidate pool.
    const zVec = zscore(vectorHits, poolFiltered);
    const zBm25 = zscore(bm25Hits, poolFiltered);
    const zKw = zscore(keywordHits, poolFiltered);

    // Fuse: weighted sum of z-scores. Determine which arms were
    // actually consulted so we can set `method` correctly.
    const usedVector = this.vectorIndex !== undefined && qEmb !== null;
    const usedBm25 = this.bm25Index.size() > 0;
    const usedKeyword = this.keywordIndex.size() > 0;
    const usedMultiple =
      [usedVector, usedBm25, usedKeyword].filter(Boolean).length > 1;

    const out: ScoredDoc[] = [];
    for (const id of poolFiltered) {
      const doc = this.docs.get(id);
      if (!doc) continue;
      const components: ScoredDoc['components'] = {};
      let score = 0;
      if (usedVector) {
        const z = zVec.get(id) ?? 0;
        components.vector = vectorHits.get(id);
        score += this.weights.vector * z;
      }
      if (usedBm25) {
        const z = zBm25.get(id) ?? 0;
        components.bm25 = bm25Hits.get(id);
        score += this.weights.bm25 * z;
      }
      if (usedKeyword) {
        const z = zKw.get(id) ?? 0;
        components.keyword = keywordHits.get(id);
        score += this.weights.keyword * z;
      }
      out.push({
        doc,
        score,
        method: usedMultiple ? 'hybrid' : usedVector ? 'vector' : usedBm25 ? 'bm25' : 'keyword',
        components,
      });
    }

    out.sort((a, b) => b.score - a.score);
    let final = out.slice(0, k);
    if (opts.minScore !== undefined) {
      final = final.filter((s) => s.score >= opts.minScore!);
    }
    return final;
  }

  /** Remove all documents from all backends. */
  clear(): void {
    this.docs.clear();
    this.bm25Index.clear();
    this.keywordIndex.clear();
    // HNSWIndex doesn't have a clear() method; rebuild by removing
    // every id we know about.
    if (this.vectorIndex) {
      for (const id of this.docs.keys()) this.vectorIndex.remove(id);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Z-score normalize the values in `scores` across the candidate ids in
 * `pool`. Returns a new map with the same keys as `pool` (ids absent
 * from `scores` get z = (0 - mean) / std = -mean/std).
 *
 * If `std` is 0 (all candidates tied, including all-zeros), returns a
 * map of zeros so the arm contributes nothing to the fused score.
 */
function zscore(
  scores: Map<string, number>,
  pool: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (pool.length === 0) return out;
  let sum = 0;
  let sumSq = 0;
  for (const id of pool) {
    const v = scores.get(id) ?? 0;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / pool.length;
  const variance = sumSq / pool.length - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  if (std === 0) {
    for (const id of pool) out.set(id, 0);
    return out;
  }
  for (const id of pool) {
    const v = scores.get(id) ?? 0;
    out.set(id, (v - mean) / std);
  }
  return out;
}

/**
 * @file KeywordIndex.ts
 * @description Simple term-frequency keyword index with field boosts.
 *
 * Unlike BM25, this is a flat TF score with no length normalization
 * and no IDF weighting. It's intentionally simple — the goal is to
 * provide a *complementary* signal to vector + BM25 retrieval, not a
 * replacement. Field boosts make it especially good at surfacing docs
 * where the query terms appear in the **title** (×3) or **tags**
 * (×2) rather than just the body (×1).
 *
 * ## Tokenization
 *
 * Reuses {@link tokenize} from `./BM25Index.ts` so the keyword and
 * BM25 arms see the same terms.
 *
 * @packageDocumentation
 */

import type { Document } from './types.js';
import { tokenize } from './BM25Index.js';

/** Search hit for a keyword query. */
export interface KeywordHit {
  /** Document id. */
  id: string;
  /** Boosted TF score (unbounded). */
  score: number;
}

/** Default field-boost configuration. */
export const DEFAULT_FIELD_BOOSTS = {
  title: 3,
  tags: 2,
  content: 1,
} as const;

/** Constructor options. */
export interface KeywordIndexOptions {
  /** Field-boost overrides. */
  boosts?: Partial<typeof DEFAULT_FIELD_BOOSTS>;
}

/**
 * Field-boosted TF keyword index.
 *
 * @example
 * ```ts
 * const kw = new KeywordIndex();
 * kw.add(doc);
 * const hits = kw.search('auth jwt', 10);
 * ```
 */
export class KeywordIndex {
  private readonly boosts: typeof DEFAULT_FIELD_BOOSTS;
  /** id → Map<term, weighted TF>. */
  private readonly docTerms = new Map<string, Map<string, number>>();

  constructor(opts: KeywordIndexOptions = {}) {
    this.boosts = { ...DEFAULT_FIELD_BOOSTS, ...opts.boosts };
  }

  /** Number of indexed documents. */
  size(): number {
    return this.docTerms.size;
  }

  /**
   * Add (or replace) a document. Indexes the title (×3 boost), each
   * tag (×2 boost), and the body content (×1 boost).
   */
  add(doc: Document): void {
    const terms = new Map<string, number>();
    this.addField(terms, doc.metadata.title, this.boosts.title);
    if (doc.metadata.tags) {
      this.addField(terms, doc.metadata.tags.join(' '), this.boosts.tags);
    }
    this.addField(terms, doc.content, this.boosts.content);
    this.docTerms.set(doc.id, terms);
  }

  /**
   * Remove a document. Returns `true` if it existed.
   */
  remove(id: string): boolean {
    return this.docTerms.delete(id);
  }

  /**
   * Search the index for `query`, returning up to `k` hits ranked by
   * descending boosted-TF score. Hits with a score of 0 are filtered
   * out.
   */
  search(query: string, k: number): KeywordHit[] {
    const qTerms = tokenize(query);
    if (qTerms.length === 0) return [];
    const qSet = new Set(qTerms);
    const scores: KeywordHit[] = [];
    for (const [id, terms] of this.docTerms) {
      let score = 0;
      for (const t of qSet) {
        score += terms.get(t) ?? 0;
      }
      if (score > 0) scores.push({ id, score });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k);
  }

  /** Remove all documents. */
  clear(): void {
    this.docTerms.clear();
  }

  // ─── Internal ─────────────────────────────────────────────────────

  /**
   * Tokenize `text` and add each term's TF (multiplied by `boost`)
   * into `terms`.
   */
  private addField(
    terms: Map<string, number>,
    text: string | undefined,
    boost: number,
  ): void {
    if (!text) return;
    for (const t of tokenize(text)) {
      terms.set(t, (terms.get(t) ?? 0) + boost);
    }
  }
}

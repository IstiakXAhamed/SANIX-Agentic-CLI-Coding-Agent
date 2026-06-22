/**
 * @file BM25Index.ts
 * @description Okapi BM25 index for keyword-based document retrieval.
 *
 * BM25 is the standard "bag of words" ranking function used by search
 * engines:
 *
 * ```
 * score(q, d) = Σ_t IDF(t) · (TF(t,d) · (k1+1)) / (TF(t,d) + k1 · (1 - b + b · |d| / avgdl))
 * IDF(t) = log((N - DF(t) + 0.5) / (DF(t) + 0.5) + 1)
 * ```
 *
 * With `k1 = 1.5` and `b = 0.75` (Okapi defaults). BM25 saturates TF
 * (a term appearing 100× in a doc isn't 100× more relevant than 10×)
 * and normalizes by document length (longer docs aren't unfairly
 * penalized). IDF handles the "rare term = more signal" intuition.
 *
 * ## Tokenization
 *
 * Tokenizes on word boundaries (`\b\w+\b`), lowercased. CJK characters
 * are split into single-character tokens (a reasonable default for
 * Chinese/Japanese/Korean where word segmentation is expensive).
 *
 * @packageDocumentation
 */

import type { Document } from './types.js';

/** Search hit for a BM25 query. */
export interface BM25Hit {
  /** Document id. */
  id: string;
  /** Raw BM25 score (unbounded — higher = more relevant). */
  score: number;
}

/** Constructor options. */
export interface BM25Options {
  /** Term frequency saturation. Default 1.5. */
  k1?: number;
  /** Length normalization. Default 0.75. */
  b?: number;
}

/**
 * Okapi BM25 keyword index.
 *
 * @example
 * ```ts
 * const bm = new BM25Index();
 * bm.add(doc1); bm.add(doc2);
 * const hits = bm.search('auth jwt token', 10);
 * ```
 */
export class BM25Index {
  private readonly k1: number;
  private readonly b: number;
  /** id → document length (token count). */
  private readonly docLen = new Map<string, number>();
  /** id → Map<term, tf>. */
  private readonly docTerms = new Map<string, Map<string, number>>();
  /** term → Set<docId>. */
  private readonly inverted = new Map<string, Set<string>>();
  private totalLen = 0;

  constructor(opts: BM25Options = {}) {
    this.k1 = opts.k1 ?? 1.5;
    this.b = opts.b ?? 0.75;
  }

  /** Number of indexed documents. */
  size(): number {
    return this.docLen.size;
  }

  /** Average document length in tokens. */
  avgdl(): number {
    return this.docLen.size === 0 ? 0 : this.totalLen / this.docLen.size;
  }

  /**
   * Add (or replace) a document in the index.
   *
   * @example
   * ```ts
   * bm.add({ id: 'd1', content: 'hello world', metadata: {...} });
   * ```
   */
  add(doc: Document): void {
    this.remove(doc.id);
    const tokens = tokenize(doc.content);
    this.docLen.set(doc.id, tokens.length);
    this.totalLen += tokens.length;
    const termFreqs = new Map<string, number>();
    for (const t of tokens) {
      termFreqs.set(t, (termFreqs.get(t) ?? 0) + 1);
      let postings = this.inverted.get(t);
      if (!postings) {
        postings = new Set();
        this.inverted.set(t, postings);
      }
      postings.add(doc.id);
    }
    this.docTerms.set(doc.id, termFreqs);
  }

  /**
   * Remove a document. Returns `true` if it existed.
   */
  remove(id: string): boolean {
    const tf = this.docTerms.get(id);
    if (!tf) return false;
    const len = this.docLen.get(id) ?? 0;
    this.totalLen -= len;
    this.docLen.delete(id);
    this.docTerms.delete(id);
    for (const term of tf.keys()) {
      const postings = this.inverted.get(term);
      if (postings) {
        postings.delete(id);
        if (postings.size === 0) this.inverted.delete(term);
      }
    }
    return true;
  }

  /**
   * Search the index for `query`, returning up to `k` hits ranked by
   * descending BM25 score. Hits with a score of 0 are filtered out.
   *
   * @example
   * ```ts
   * const hits = bm.search('auth jwt', 10);
   * for (const h of hits) console.log(h.id, h.score);
   * ```
   */
  search(query: string, k: number): BM25Hit[] {
    const qTerms = tokenize(query);
    if (qTerms.length === 0 || this.docLen.size === 0) return [];
    const N = this.docLen.size;
    const avgdl = this.totalLen / N;
    const scores = new Map<string, number>();

    for (const term of new Set(qTerms)) {
      const postings = this.inverted.get(term);
      if (!postings) continue;
      const df = postings.size;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      if (idf <= 0) continue;
      for (const docId of postings) {
        const tf = this.docTerms.get(docId)!.get(term) ?? 0;
        if (tf === 0) continue;
        const dl = this.docLen.get(docId)!;
        const denom = tf + this.k1 * (1 - this.b + this.b * (dl / avgdl));
        const contrib = (idf * (tf * (this.k1 + 1))) / denom;
        scores.set(docId, (scores.get(docId) ?? 0) + contrib);
      }
    }

    return Array.from(scores.entries())
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([id, score]) => ({ id, score }));
  }

  /** Remove all documents. */
  clear(): void {
    this.docLen.clear();
    this.docTerms.clear();
    this.inverted.clear();
    this.totalLen = 0;
  }
}

/**
 * Tokenize a string for BM25 indexing. Lowercases, splits on word
 * boundaries, and emits single-character tokens for CJK runs so
 * Chinese / Japanese / Korean text gets at least one token per
 * character.
 *
 * @example
 * ```ts
 * tokenize('Hello, world!') // ['hello', 'world']
 * tokenize('认证 JWT')       // ['认', '证', 'jwt']
 * ```
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  // \p{L} matches any Unicode letter; \p{N} any number. The 'u' flag
  // enables Unicode property escapes.
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = m[0];
    // CJK run → split into single chars.
    if (/[\u3400-\u9FFF\uF900-\uFAFF]/.test(word)) {
      for (const ch of word) {
        // Skip non-letter chars within the run (numbers, etc.).
        if (/[\u3400-\u9FFF\uF900-\uFAFF]/.test(ch)) out.push(ch.toLowerCase());
      }
    } else {
      out.push(word.toLowerCase());
    }
  }
  return out;
}

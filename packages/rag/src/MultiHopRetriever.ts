/**
 * @file MultiHopRetriever.ts
 * @description Multi-hop retrieval for complex questions that require
 * chaining multiple facts.
 *
 * ## When to use
 *
 * Single-hop retrieval works when the answer is contained in a single
 * document. Multi-hop retrieval is needed when the answer requires
 * connecting facts across documents:
 *
 *   > "Who is the CEO of the company that acquired the startup
 *   >  founded by the author of X?"
 *
 * To answer this, we need to:
 *   1. Find the author of X.
 *   2. Find the startup they founded.
 *   3. Find the company that acquired that startup.
 *   4. Find the CEO of that company.
 *
 * ## Algorithm
 *
 *   1. Retrieve initial docs for the query.
 *   2. Ask the LLM: "Given this query and these docs, what's the next
 *      sub-question to answer?" If the LLM says "done" (or `maxHops`
 *      is reached), stop.
 *   3. Retrieve docs for the sub-question.
 *   4. Repeat.
 *   5. Return all unique docs collected across all hops, plus the
 *      per-hop trace.
 *
 * ## Graceful degradation
 *
 * If `provider` is missing, multi-hop collapses to a single hop (the
 * underlying `HybridRetriever.retrieve()` call) and the result's
 * `hops` array contains just the initial hop with `reasoning: 'no
 * provider — single hop'`.
 *
 * @packageDocumentation
 */

import type { IProvider, LLMMessage } from '@sanix/providers';
import type { ScoredDoc } from './types.js';
import type { HybridRetriever } from './HybridRetriever.js';

/** Per-hop trace. */
export interface MultiHop {
  /** The (sub-)query used for this hop's retrieval. */
  query: string;
  /** Docs retrieved for this hop. */
  retrieved: ScoredDoc[];
  /** LLM's reasoning for the next hop (or "done"). */
  reasoning: string;
}

/** Multi-hop retrieval result. */
export interface MultiHopResult {
  /** Per-hop traces, in execution order. */
  hops: MultiHop[];
  /** All unique docs collected across all hops (deduped by id). */
  finalDocs: ScoredDoc[];
  /** Number of hops executed. */
  totalHops: number;
}

/** Constructor options. */
export interface MultiHopRetrieverOptions {
  /** Hybrid retriever to delegate each hop's retrieval to. */
  retriever: HybridRetriever;
  /** LLM provider (required to extract sub-questions). */
  provider?: IProvider;
  /** Max number of hops. Default 3. */
  maxHops?: number;
  /** Docs per hop. Default 5. */
  kPerHop?: number;
  /** Max tokens for the LLM's "next sub-question" call. Default 256. */
  maxTokens?: number;
  /** Max chars of each doc to include in the LLM context. Default 800. */
  maxDocChars?: number;
}

/**
 * Multi-hop retriever.
 *
 * @example
 * ```ts
 * const mh = new MultiHopRetriever({
 *   retriever, provider: claudeProvider, maxHops: 4,
 * });
 * const result = await mh.retrieve(
 *   'CEO of the company that acquired the startup founded by the author of X?',
 * );
 * console.log(result.totalHops, result.finalDocs.length);
 * ```
 */
export class MultiHopRetriever {
  private readonly retriever: HybridRetriever;
  private readonly provider?: IProvider;
  private readonly maxHops: number;
  private readonly kPerHop: number;
  private readonly maxTokens: number;
  private readonly maxDocChars: number;

  constructor(opts: MultiHopRetrieverOptions) {
    this.retriever = opts.retriever;
    this.provider = opts.provider;
    this.maxHops = opts.maxHops ?? 3;
    this.kPerHop = opts.kPerHop ?? 5;
    this.maxTokens = opts.maxTokens ?? 256;
    this.maxDocChars = opts.maxDocChars ?? 800;
  }

  /**
   * Run multi-hop retrieval for `query`. Returns the per-hop trace
   * and the deduplicated final doc set.
   */
  async retrieve(
    query: string,
    opts: { k?: number } = {},
  ): Promise<MultiHopResult> {
    const k = opts.k ?? this.kPerHop;
    const hops: MultiHop[] = [];
    const seen = new Map<string, ScoredDoc>();
    let currentQuery = query;

    for (let hop = 0; hop < this.maxHops; hop++) {
      const retrieved = await this.retriever.retrieve(currentQuery, { k });
      for (const r of retrieved) {
        if (!seen.has(r.doc.id)) seen.set(r.doc.id, r);
      }

      if (!this.provider) {
        hops.push({
          query: currentQuery,
          retrieved,
          reasoning: 'no provider — single hop',
        });
        break;
      }

      const { nextQuery, reasoning } = await this.nextHop(query, retrieved);
      hops.push({ query: currentQuery, retrieved, reasoning });

      if (!nextQuery || nextQuery.toLowerCase().startsWith('done')) {
        break;
      }
      currentQuery = nextQuery;
    }

    return {
      hops,
      finalDocs: Array.from(seen.values()).sort((a, b) => b.score - a.score),
      totalHops: hops.length,
    };
  }

  // ─── Internal ───────────────────────────────────────────────────────

  /**
   * Ask the LLM what the next sub-question should be. Returns
   * `{ nextQuery: 'done', reasoning: '...' }` if the LLM judges that
   * the current docs are sufficient to answer the original query.
   */
  private async nextHop(
    originalQuery: string,
    docs: ScoredDoc[],
  ): Promise<{ nextQuery: string; reasoning: string }> {
    if (!this.provider) return { nextQuery: 'done', reasoning: 'no provider' };

    const docContext = docs
      .map((d, i) => `[${i + 1}] ${truncate(d.doc.content, this.maxDocChars)}`)
      .join('\n\n');

    const prompt =
      `Original question: ${originalQuery}\n\n` +
      `Documents retrieved so far:\n${docContext}\n\n` +
      `Based on these documents, can the original question be answered?\n` +
      `If yes, respond exactly: DONE\n` +
      `If no, respond with the next sub-question to investigate (one line, no preamble).\n\n` +
      `Response:`;

    const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
    const res = await this.provider.chat({
      messages,
      temperature: 0,
      maxTokens: this.maxTokens,
    });
    const text = res.content.trim();
    if (text.toUpperCase().startsWith('DONE')) {
      return { nextQuery: 'done', reasoning: 'answerable from current docs' };
    }
    return { nextQuery: text.split('\n')[0]!.trim(), reasoning: text };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Truncate `text` to at most `maxChars` characters. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

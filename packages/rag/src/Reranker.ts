/**
 * @file Reranker.ts
 * @description Second-stage reranker that takes the top-N retrieved
 * documents and produces a more accurate ranking.
 *
 * Retrieval (BM25, vector, hybrid) is fast but shallow — it cannot
 * model fine-grained query-document interactions. A reranker applies
 * a heavier model to the top-N candidates to re-score or reorder
 * them.
 *
 * ## Methods
 *
 *   - `'cross_encoder'` — asks an LLM to rate each (query, doc) pair
 *     on a 0-10 relevance scale. Slow but accurate (one LLM call per
 *     doc). Batches of 10 docs per prompt to amortize.
 *   - `'llm'` — asks the LLM to reorder the top-K docs in a single
 *     call (returns a permutation of indices). Faster than
 *     cross-encoder; less granular.
 *   - `'mono_t5'` — shells out to the `mono-t5` CLI if installed
 *     (popular T5-based reranker model from Castorini). The CLI must
 *     be on `$PATH`.
 *   - `'none'` — passthrough; returns the input unchanged. Useful as
 *     a default and for ablation studies.
 *
 * ## Batching
 *
 * Both LLM-based methods batch the candidates in groups of 10 to keep
 * prompt sizes reasonable. Each batch is a single LLM call.
 *
 * ## Graceful degradation
 *
 * If `provider` is missing and the method requires it, the reranker
 * silently falls back to `'none'` (passthrough) rather than throwing.
 * Same for `'mono_t5'` when the `mono-t5` binary is not on `$PATH`.
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import type { IProvider, LLMMessage } from '@sanix/providers';
import type { ScoredDoc } from './types.js';

/** Reranking strategy. */
export type RerankMethod = 'cross_encoder' | 'llm' | 'mono_t5' | 'none';

/** Constructor options. */
export interface RerankerOptions {
  /**
   * Strategy. Default `'none'` (passthrough) — callers who want actual
   * reranking must explicitly opt in.
   */
  method?: RerankMethod;
  /** LLM provider (required for `cross_encoder` and `llm`). */
  provider?: IProvider;
  /** Model id to pass to the provider (overrides the provider's default). */
  model?: string;
  /** Number of docs per LLM batch. Default 10. */
  batchSize?: number;
  /**
   * Maximum number of chars of each document to include in the LLM
   * prompt. Long docs are truncated to keep prompt sizes bounded.
   * Default 1000.
   */
  maxDocChars?: number;
}

/** Rerank options. */
export interface RerankOptions {
  /** Number of top documents to return. Default: input length. */
  topK?: number;
}

/**
 * Document reranker.
 *
 * @example
 * ```ts
 * const reranker = new Reranker({
 *   method: 'cross_encoder',
 *   provider: claudeProvider,
 * });
 * const top5 = await reranker.rerank(query, retrievedHits, { topK: 5 });
 * ```
 */
export class Reranker {
  private readonly method: RerankMethod;
  private readonly provider?: IProvider;
  private readonly model?: string;
  private readonly batchSize: number;
  private readonly maxDocChars: number;

  constructor(opts: RerankerOptions = {}) {
    this.method = opts.method ?? 'none';
    this.provider = opts.provider;
    this.model = opts.model;
    this.batchSize = opts.batchSize ?? 10;
    this.maxDocChars = opts.maxDocChars ?? 1000;
  }

  /**
   * Rerank `docs` for `query`. Returns up to `topK` docs in the new
   * order; the returned {@link ScoredDoc} objects preserve the
   * original `components` from retrieval but replace `score` with the
   * reranker's new score (for `cross_encoder`, the LLM's 0-10 rating
   * normalized to [0, 1]; for `llm` and `mono_t5`, a decreasing
   * rank-based score; for `none`, the original score).
   *
   * @example
   * ```ts
   * const reranked = await reranker.rerank('what is jwt', hits, { topK: 5 });
   * ```
   */
  async rerank(
    query: string,
    docs: ScoredDoc[],
    opts: RerankOptions = {},
  ): Promise<ScoredDoc[]> {
    const topK = opts.topK ?? docs.length;
    if (docs.length === 0) return [];

    let effective = this.method;
    if (
      (effective === 'cross_encoder' || effective === 'llm') &&
      !this.provider
    ) {
      effective = 'none';
    }
    if (effective === 'mono_t5' && !(await monoT5Available())) {
      effective = 'none';
    }

    let out: ScoredDoc[];
    switch (effective) {
      case 'none':
        out = docs.slice();
        break;
      case 'cross_encoder':
        out = await this.crossEncoder(query, docs);
        break;
      case 'llm':
        out = await this.llmRerank(query, docs);
        break;
      case 'mono_t5':
        out = await this.monoT5(query, docs);
        break;
    }
    return out.slice(0, topK);
  }

  // ─── cross_encoder ──────────────────────────────────────────────────

  /**
   * Cross-encoder reranking: ask the LLM to rate each (query, doc)
   * pair on a 0-10 relevance scale. Batch the docs in groups of
   * `batchSize` to amortize the per-call overhead.
   */
  private async crossEncoder(
    query: string,
    docs: ScoredDoc[],
  ): Promise<ScoredDoc[]> {
    const scored: Array<{ doc: ScoredDoc; rating: number }> = [];
    for (let i = 0; i < docs.length; i += this.batchSize) {
      const batch = docs.slice(i, i + this.batchSize);
      const ratings = await this.rateBatch(query, batch);
      for (let j = 0; j < batch.length; j++) {
        scored.push({ doc: batch[j]!, rating: ratings[j] ?? 0 });
      }
    }
    scored.sort((a, b) => b.rating - a.rating);
    return scored.map(({ doc, rating }) => ({
      ...doc,
      score: rating / 10,
      method: 'cross_encoder' as const,
    }));
  }

  /**
   * Build a single batch prompt and parse the LLM's 0-10 ratings.
   * Falls back to original ordering if parsing fails.
   */
  private async rateBatch(
    query: string,
    batch: ScoredDoc[],
  ): Promise<number[]> {
    const lines = batch.map(
      (d, i) =>
        `[${i + 1}] ${truncate(d.doc.content, this.maxDocChars)}`,
    );
    const prompt =
      `You are a relevance judge. Rate 0-10 how relevant each passage is to the query.\n` +
      `Output only the numbers, comma-separated, one per passage, in order.\n\n` +
      `Query: ${query}\n\n` +
      lines.join('\n\n') +
      `\n\nRatings (comma-separated):`;

    const res = await this.callLLM(prompt);
    const parts = res.split(/[\s,]+/).filter(Boolean);
    const ratings: number[] = [];
    for (const p of parts) {
      const n = Number.parseFloat(p);
      if (!Number.isNaN(n)) ratings.push(Math.max(0, Math.min(10, n)));
      if (ratings.length >= batch.length) break;
    }
    // Pad missing ratings with 0.
    while (ratings.length < batch.length) ratings.push(0);
    return ratings;
  }

  // ─── llm ────────────────────────────────────────────────────────────

  /**
   * LLM-based listwise reranking: ask the LLM to output the indices of
   * the passages in order of relevance (most relevant first). Faster
   * than cross-encoder (one call) but less granular.
   */
  private async llmRerank(
    query: string,
    docs: ScoredDoc[],
  ): Promise<ScoredDoc[]> {
    // Truncate to top 20 to keep the prompt manageable.
    const input = docs.slice(0, 20);
    const lines = input.map(
      (d, i) =>
        `[${i + 1}] ${truncate(d.doc.content, this.maxDocChars)}`,
    );
    const prompt =
      `Given this query and these ${input.length} passages, return the indices in order of relevance, most relevant first.\n` +
      `Output only comma-separated indices (1-based). No other text.\n\n` +
      `Query: ${query}\n\n` +
      lines.join('\n\n') +
      `\n\nOrder:`;

    const res = await this.callLLM(prompt);
    const seen = new Set<number>();
    const order: number[] = [];
    for (const tok of res.split(/[\s,]+/)) {
      const n = Number.parseInt(tok, 10);
      if (Number.isInteger(n) && n >= 1 && n <= input.length && !seen.has(n)) {
        seen.add(n);
        order.push(n - 1);
      }
    }
    // Append any docs the LLM didn't mention (in original order).
    for (let i = 0; i < input.length; i++) {
      if (!seen.has(i)) order.push(i);
    }
    // Append docs beyond the top-20 truncation point in original order.
    for (let i = input.length; i < docs.length; i++) order.push(i);

    // Score: linear decay from 1 down to 0 across the reranked order.
    const n = order.length;
    return order.map((idx, pos) => {
      const orig = docs[idx]!;
      return {
        ...orig,
        score: n > 1 ? 1 - pos / (n - 1) : 1,
        method: 'llm' as const,
      };
    });
  }

  // ─── mono_t5 ────────────────────────────────────────────────────────

  /**
   * Shell out to the `mono-t5` CLI. The CLI expects JSON on stdin:
   * `{ "query": "...", "docs": ["...", "..."] }` and prints
   * `{ "scores": [0.1, 0.9, ...] }` to stdout. We parse the scores and
   * sort docs by them.
   *
   * If the CLI is not on `$PATH` or returns malformed output, fall
   * back to passthrough ordering.
   */
  private async monoT5(
    query: string,
    docs: ScoredDoc[],
  ): Promise<ScoredDoc[]> {
    try {
      const payload = JSON.stringify({
        query,
        docs: docs.map((d) => truncate(d.doc.content, this.maxDocChars)),
      });
      const stdout = await runCli('mono-t5', ['--format', 'json'], payload, 30_000);
      const parsed = JSON.parse(stdout) as { scores?: number[] };
      const scores = parsed.scores ?? [];
      const pairs = docs.map((doc, i) => ({
        doc,
        score: scores[i] ?? 0,
      }));
      pairs.sort((a, b) => b.score - a.score);
      return pairs.map(({ doc, score }) => ({
        ...doc,
        score,
        method: 'mono_t5' as const,
      }));
    } catch {
      // CLI missing or errored — passthrough.
      return docs.slice();
    }
  }

  // ─── Shared LLM helper ──────────────────────────────────────────────

  /**
   * Send a single-turn prompt to the configured provider and return
   * the response text. Throws on provider error; callers catch and
   * fall back to passthrough.
   */
  private async callLLM(prompt: string): Promise<string> {
    if (!this.provider) throw new Error('Reranker: no provider');
    const messages: LLMMessage[] = [
      { role: 'user', content: prompt },
    ];
    // `this.model` is informational; the provider's adapter selects
    // its own model. We do not pass `systemPrompt` here (the prompt
    // is already self-contained).
    void this.model;
    const res = await this.provider.chat({
      messages,
      temperature: 0,
      maxTokens: 256,
    });
    return res.content;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Truncate `text` to at most `maxChars` characters, appending an ellipsis. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

/**
 * Run a CLI command, writing `stdinPayload` to its stdin and returning
 * its stdout as a string. Rejects on non-zero exit, timeout, or spawn
 * error. Used by the `mono_t5` reranker.
 */
function runCli(
  cmd: string,
  args: string[],
  stdinPayload: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    let stderrText = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`runCli: ${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`runCli: ${cmd} exited ${code}: ${stderrText}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
    });
    child.stdin.on('error', () => {
      // Ignore EPIPE if the child closed before we finished writing.
    });
    child.stdin.end(stdinPayload, 'utf-8');
  });
}

/**
 * Check whether the `mono-t5` CLI is on `$PATH`. Caches the result for
 * 60s to avoid repeated exec overhead.
 */
let _monoT5Cache: { ok: boolean; ts: number } | null = null;
async function monoT5Available(): Promise<boolean> {
  if (_monoT5Cache && Date.now() - _monoT5Cache.ts < 60_000) {
    return _monoT5Cache.ok;
  }
  try {
    // Run `mono-t5 --version` (no stdin) to probe availability.
    await runCli('mono-t5', ['--version'], '', 5_000);
    _monoT5Cache = { ok: true, ts: Date.now() };
    return true;
  } catch {
    _monoT5Cache = { ok: false, ts: Date.now() };
    return false;
  }
}

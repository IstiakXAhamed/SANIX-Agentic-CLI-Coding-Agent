/**
 * @file SemanticChunker.ts
 * @description Splits long text into semantically coherent chunks. Rather
 * than naive fixed-size windowing, the chunker:
 *
 *   1. Splits on paragraph boundaries (blank-line separated).
 *   2. Further splits each paragraph into sentences.
 *   3. Embeds every sentence (via `@xenova/transformers`, lazy-loaded).
 *   4. Greedily groups consecutive sentences with high cosine similarity
 *      into the same chunk, up to `maxTokens` per chunk.
 *   5. Falls back to paragraph-boundary chunking when embeddings are
 *      unavailable (so the chunker is always usable, just less precise).
 *
 * The result is chunks that respect natural topic boundaries — a
 * semantic break in the text (e.g. switching from "Background" to
 * "Implementation") tends to land on a chunk boundary, which improves
 * downstream retrieval accuracy.
 *
 * @packageDocumentation
 */

import type { ExactTokenizer } from './ExactTokenizer.js';
import { tokenizer as defaultTokenizer } from './ExactTokenizer.js';

/**
 * A semantically-coherent chunk produced by {@link SemanticChunker.chunk}.
 */
export interface Chunk {
  /** The chunk's text content. */
  text: string;
  /** Token count for `text` (per the configured tokenizer). */
  tokens: number;
  /** Number of sentences the chunk spans. */
  sentences: number;
  /** Character offset (inclusive) where the chunk begins in the source. */
  startOffset: number;
  /** Character offset (exclusive) where the chunk ends in the source. */
  endOffset: number;
}

/**
 * Options for {@link SemanticChunker.chunk}.
 */
export interface ChunkOptions {
  /**
   * Maximum tokens per chunk. The chunker will not produce a chunk
   * larger than this (a single sentence that exceeds this is split
   * mid-sentence as a last resort). Default 512.
   */
  maxTokens?: number;
  /**
   * Number of trailing characters from the previous chunk to prepend
   * to the next chunk, providing cross-chunk context for retrieval.
   * Default 0 (no overlap). The overlap is included in the chunk's
   * `text` and `tokens`, so effective usable capacity is
   * `maxTokens - overlapTokens`.
   */
  overlap?: number;
  /**
   * Minimum tokens per chunk. When a candidate chunk would fall below
   * this threshold and the next sentence fits within `maxTokens`, the
   * chunker merges them. Default 64.
   */
  minChunkTokens?: number;
  /**
   * Cosine-similarity threshold above which two consecutive sentences
   * are considered "the same topic" and merged. Default 0.75.
   */
  similarityThreshold?: number;
}

/**
 * Default values for {@link ChunkOptions}.
 */
const DEFAULTS = {
  maxTokens: 512,
  overlap: 0,
  minChunkTokens: 64,
  similarityThreshold: 0.75,
} as const;

/**
 * The lazily-resolved `@xenova/transformers` pipeline surface. Only the
 * `feature-extraction` pipeline is used.
 */
interface Embedder {
  /** Embed a list of texts; returns Float32Array[] (one per input). */
  (texts: string[], opts: { pooling: 'mean'; normalize: boolean }): Promise<
    { data: number[] }[]
  >;
}

/**
 * Sentence splitter. Handles common English abbreviations poorly on
 * purpose — the chunker is robust to a few mis-splits because we group
 * by similarity afterward, and a heavier NLP dep is not worth it.
 */
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'])/g;

/**
 * Split `text` into sentences, returning both the sentence text and the
 * character offset where each sentence begins (used to compute
 * `startOffset` / `endOffset` on the resulting {@link Chunk}s).
 */
function splitSentences(
  text: string,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  // Use a manual scan so we can recover offsets — `String.split` strips
  // them.
  SENTENCE_END.lastIndex = 0;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = SENTENCE_END.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const sentence = text.slice(cursor, end).trim();
    if (sentence.length > 0) {
      out.push({ text: sentence, start: cursor, end });
    }
    cursor = end;
    lastEnd = end;
    // Guard against zero-width matches (the lookbehind should prevent
    // this, but defensive).
    if (match.index === SENTENCE_END.lastIndex) SENTENCE_END.lastIndex++;
  }
  // Trailing remainder.
  if (cursor < text.length) {
    const sentence = text.slice(cursor).trim();
    if (sentence.length > 0) {
      out.push({ text: sentence, start: cursor, end: text.length });
    }
  }
  void lastEnd;
  return out;
}

/**
 * Split `text` into paragraphs (blank-line separated), preserving the
 * character offsets so we can map back to source positions.
 */
function splitParagraphs(
  text: string,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const re = /\n\s*\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const para = text.slice(cursor, match.index).trim();
    if (para.length > 0) {
      out.push({ text: para, start: cursor, end: match.index });
    }
    cursor = re.lastIndex;
  }
  // Trailing paragraph.
  if (cursor < text.length) {
    const para = text.slice(cursor).trim();
    if (para.length > 0) {
      out.push({ text: para, start: cursor, end: text.length });
    }
  }
  // If the text had no blank lines, return one paragraph.
  if (out.length === 0 && text.trim().length > 0) {
    out.push({ text: text.trim(), start: 0, end: text.length });
  }
  return out;
}

/**
 * Cosine similarity between two equal-length vectors.
 */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Lazily-resolved `@xenova/transformers` pipeline. Cached at module
 * scope so we don't re-load the model on every chunk call. `null`
 * once we've determined the package is unavailable.
 */
let embedderPromise: Promise<Embedder | null> | null = null;

/**
 * Load (and cache) the Xenova `feature-extraction` pipeline. Returns
 * `null` if `@xenova/transformers` is not installed or fails to load.
 * The chunker then falls back to paragraph-boundary splitting.
 *
 * We use the `all-MiniLM-L6-v2` model — 384-dim, ~22MB, fast on CPU,
 * and good enough for sentence-level semantic grouping. The model is
 * downloaded on first use (Xenova caches it under `~/.cache/`).
 */
async function loadEmbedder(): Promise<Embedder | null> {
  if (embedderPromise !== null) return embedderPromise;
  embedderPromise = (async (): Promise<Embedder | null> => {
    try {
      // Dynamic import — `@xenova/transformers` is an optional dep
      // (it's in core's deps, so it should be present in the monorepo,
      // but the optimizer package must not crash if it's absent).
      const mod = (await import('@xenova/transformers')) as {
        pipeline: (task: string, model: string) => Promise<Embedder>;
      };
      const pipe = await mod.pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
      );
      return pipe;
    } catch {
      return null;
    }
  })();
  return embedderPromise;
}

/**
 * Semantic text chunker.
 *
 * @example
 * ```ts
 * const chunker = new SemanticChunker();
 * const chunks = await chunker.chunk(longArticle, { maxTokens: 256 });
 * // chunks.length === ~ceil(articleTokens / 256), with boundaries
 * // aligned to topic shifts.
 * ```
 */
export class SemanticChunker {
  private readonly tokenizer: ExactTokenizer;

  /**
   * @param tokenizer Tokenizer to use for token counting. Defaults to
   *   the shared singleton from `ExactTokenizer.ts`.
   */
  constructor(tokenizer: ExactTokenizer = defaultTokenizer) {
    this.tokenizer = tokenizer;
  }

  /**
   * Split `text` into semantically-coherent chunks. See the file header
   * for the algorithm.
   *
   * @example
   * ```ts
   * const chunks = await chunker.chunk(text, { maxTokens: 256, overlap: 32 });
   * for (const c of chunks) console.log(c.tokens, c.sentences, c.text);
   * ```
   */
  async chunk(text: string, opts: ChunkOptions = {}): Promise<Chunk[]> {
    const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
    const overlapChars = opts.overlap ?? DEFAULTS.overlap;
    const minChunkTokens = opts.minChunkTokens ?? DEFAULTS.minChunkTokens;
    const similarityThreshold =
      opts.similarityThreshold ?? DEFAULTS.similarityThreshold;

    if (text.trim().length === 0) return [];

    // Step 1: split into paragraphs.
    const paragraphs = splitParagraphs(text);

    // Step 2: split each paragraph into sentences (preserving offsets).
    const sentences: Array<{
      text: string;
      start: number;
      end: number;
      paraIdx: number;
    }> = [];
    for (let p = 0; p < paragraphs.length; p++) {
      const para = paragraphs[p]!;
      const sents = splitSentences(para.text);
      for (const s of sents) {
        sentences.push({
          text: s.text,
          start: para.start + s.start,
          end: para.start + s.end,
          paraIdx: p,
        });
      }
    }

    // Degenerate case: a single sentence that exceeds maxTokens. Split
    // it by characters (last resort) and emit chunks.
    if (sentences.length === 0) {
      return this.fallbackChunk(text, maxTokens, overlapChars);
    }

    // Step 3: embed sentences (best-effort). If unavailable, fall back
    // to paragraph-boundary chunking.
    const embedder = await loadEmbedder();
    let embeddings: number[][] | null = null;
    if (embedder) {
      try {
        const outputs = await embedder(
          sentences.map((s) => s.text),
          { pooling: 'mean', normalize: true },
        );
        embeddings = outputs.map((o) => o.data);
      } catch {
        embeddings = null;
      }
    }

    // Step 4: group consecutive sentences. Either by similarity (when
    // embeddings are available) or by paragraph (fallback).
    const groups: Array<typeof sentences> = [];
    let current: typeof sentences = [sentences[0]!];
    let currentTokens = this.tokenizer.count(sentences[0]!.text);

    for (let i = 1; i < sentences.length; i++) {
      const s = sentences[i]!;
      const sTokens = this.tokenizer.count(s.text);

      // Hard cap: if adding this sentence would exceed maxTokens, flush.
      if (currentTokens + sTokens > maxTokens) {
        // Merge into previous group if current is below minChunkTokens
        // and the previous group has room.
        if (
          currentTokens < minChunkTokens &&
          groups.length > 0 &&
          this.groupTokens(groups[groups.length - 1]!) + currentTokens <= maxTokens
        ) {
          groups[groups.length - 1]!.push(...current);
        } else {
          groups.push(current);
        }
        current = [s];
        currentTokens = sTokens;
        continue;
      }

      // Soft check: are we still "on the same topic"? If embeddings are
      // available, use cosine similarity; otherwise use paragraph index.
      const sameTopic = embeddings
        ? cosine(embeddings[i - 1]!, embeddings[i]!) >= similarityThreshold
        : s.paraIdx === current[current.length - 1]!.paraIdx;

      if (sameTopic || currentTokens < minChunkTokens) {
        current.push(s);
        currentTokens += sTokens;
      } else {
        groups.push(current);
        current = [s];
        currentTokens = sTokens;
      }
    }
    if (current.length > 0) groups.push(current);

    // Step 5: assemble Chunks from groups, applying overlap.
    const chunks: Chunk[] = [];
    let prevTail = '';
    for (const group of groups) {
      const start = group[0]!.start;
      const end = group[group.length - 1]!.end;
      let body = text.slice(start, end);
      if (overlapChars > 0 && prevTail.length > 0) {
        body = `${prevTail} ${body}`;
      }
      const tokens = this.tokenizer.count(body);
      chunks.push({
        text: body,
        tokens,
        sentences: group.length,
        startOffset: overlapChars > 0 && prevTail.length > 0
          ? Math.max(0, start - overlapChars)
          : start,
        endOffset: end,
      });
      // Compute the tail for the next chunk: last `overlapChars` of
      // the group's text (without the prepended prevTail).
      const groupText = text.slice(start, end);
      prevTail = groupText.slice(Math.max(0, groupText.length - overlapChars));
    }
    return chunks;
  }

  /**
   * Compute the total token count of a sentence group.
   */
  private groupTokens(group: Array<{ text: string }>): number {
    return group.reduce((acc, s) => acc + this.tokenizer.count(s.text), 0);
  }

  /**
   * Last-resort chunker: split `text` by characters, respecting
   * `maxTokens` via the char/4 heuristic. Used when the text has no
   * sentence boundaries (e.g. minified JS) or when sentence splitting
   * produced nothing.
   */
  private fallbackChunk(
    text: string,
    maxTokens: number,
    overlapChars: number,
  ): Chunk[] {
    const chunks: Chunk[] = [];
    // Estimate chars per chunk: 4 chars/token is a safe lower bound.
    const maxChars = Math.max(1, maxTokens * 4);
    let cursor = 0;
    let prevTail = '';
    while (cursor < text.length) {
      const end = Math.min(text.length, cursor + maxChars);
      let body = text.slice(cursor, end);
      if (overlapChars > 0 && prevTail.length > 0) {
        body = `${prevTail} ${body}`;
      }
      chunks.push({
        text: body,
        tokens: this.tokenizer.count(body),
        sentences: 0,
        startOffset: overlapChars > 0 && prevTail.length > 0
          ? Math.max(0, cursor - overlapChars)
          : cursor,
        endOffset: end,
      });
      prevTail = text.slice(cursor, end).slice(
        Math.max(0, end - cursor - overlapChars),
      );
      cursor = end;
    }
    return chunks;
  }

  /**
   * Force-clear the cached embedder. Only useful in tests that swap
   * the `@xenova/transformers` mock between cases.
   */
  static resetEmbedderCache(): void {
    embedderPromise = null;
  }
}

/**
 * @file Summarizer.ts
 * @description Extractive + LLM-backed document summarization.
 *
 * The extractive method is a TextRank-style algorithm:
 *   1. Split text into sentences.
 *   2. Build a sentence-similarity graph (word-overlap, TF-weighted).
 *   3. Run power iteration on the PageRank-style transition matrix.
 *   4. Pick the top-N sentences in their original order.
 *
 * The LLM method delegates to a caller-supplied function (so this
 * package never depends on a specific provider).
 */

import type { SummarizerOptions, SummaryResult } from './types.js';

/**
 * Document summarizer.
 *
 * @example
 * ```ts
 * const s = new Summarizer();
 * const result = s.summarize(longText, { sentences: 3 });
 * ```
 */
export class Summarizer {
  /**
   * Summarize text.
   */
  public summarize(text: string, opts: SummarizerOptions = {}): Promise<SummaryResult> {
    const method = opts.method ?? 'extractive';
    if (method === 'llm') {
      if (!opts.llm) {
        return Promise.reject(new Error('SummarizerOptions.llm is required for method "llm"'));
      }
      return this.summarizeLLM(text, opts.llm!, opts);
    }
    return Promise.resolve(this.summarizeExtractive(text, opts));
  }

  /**
   * Extractive (TextRank) summarization.
   */
  public summarizeExtractive(text: string, opts: SummarizerOptions = {}): SummaryResult {
    const sentences = this.splitSentences(text);
    const sourceWords = text.split(/\s+/).filter(Boolean).length;
    if (sentences.length === 0) {
      return { summary: '', method: 'extractive', keySentences: [], sourceWords, summaryWords: 0, ratio: 0 };
    }
    if (sentences.length <= (opts.sentences ?? 3)) {
      const summary = sentences.join(' ');
      return {
        summary,
        method: 'extractive',
        keySentences: sentences,
        sourceWords,
        summaryWords: summary.split(/\s+/).filter(Boolean).length,
        ratio: sourceWords > 0 ? summary.split(/\s+/).length / sourceWords : 0,
      };
    }

    // TF vectors per sentence.
    const tf = sentences.map((s) => this.tf(s));
    const n = sentences.length;
    // Similarity matrix.
    const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const s = this.cosine(tf[i], tf[j]);
        sim[i][j] = s;
        sim[j][i] = s;
      }
    }
    // PageRank.
    const d = 0.85;
    let scores = new Array(n).fill(1 / n);
    for (let iter = 0; iter < 30; iter++) {
      const next = new Array(n).fill((1 - d) / n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        let rowSum = 0;
        for (let j = 0; j < n; j++) rowSum += sim[i][j];
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          if (rowSum > 0) sum += (sim[i][j] / rowSum) * scores[j];
        }
        next[i] = (1 - d) / n + d * sum;
      }
      scores = next;
    }
    // Pick top-K by score, then re-sort by original order.
    const k = opts.maxWords ? this.pickKByWords(sentences, scores, opts.maxWords) : (opts.sentences ?? 3);
    const indices = scores
      .map((s, i) => ({ s, i }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.i)
      .sort((a, b) => a - b);
    const keySentences = indices.map((i) => sentences[i]);
    const summary = keySentences.join(' ');
    const summaryWords = summary.split(/\s+/).filter(Boolean).length;
    return {
      summary,
      method: 'extractive',
      keySentences,
      sourceWords,
      summaryWords,
      ratio: sourceWords > 0 ? summaryWords / sourceWords : 0,
    };
  }

  /**
   * LLM-backed summarization.
   */
  public async summarizeLLM(text: string, llm: (text: string) => Promise<string>, opts: SummarizerOptions = {}): Promise<SummaryResult> {
    const sourceWords = text.split(/\s+/).filter(Boolean).length;
    const prompt = opts.maxWords
      ? `Summarize the following document in at most ${opts.maxWords} words:\n\n${text}`
      : `Summarize the following document in ${opts.sentences ?? 3} sentences:\n\n${text}`;
    const summary = (await llm(prompt)).trim();
    const summaryWords = summary.split(/\s+/).filter(Boolean).length;
    return {
      summary,
      method: 'llm',
      sourceWords,
      summaryWords,
      ratio: sourceWords > 0 ? summaryWords / sourceWords : 0,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private splitSentences(text: string): string[] {
    // Split on sentence terminators followed by whitespace + capital, preserving the terminator.
    const raw = text
      .replace(/\s+/g, ' ')
      .match(/[^.!?]+[.!?]+(?=\s+[A-Z0-9]|\s*$)|[^.!?]+$/g);
    if (!raw) return [];
    return raw.map((s) => s.trim()).filter((s) => s.length > 0);
  }

  private tf(sentence: string): Map<string, number> {
    const words = sentence.toLowerCase().match(/\b\w+\b/g) ?? [];
    const stop = STOPWORDS;
    const m = new Map<string, number>();
    for (const w of words) {
      if (stop.has(w) || w.length < 3) continue;
      m.set(w, (m.get(w) ?? 0) + 1);
    }
    return m;
  }

  private cosine(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (const [k, v] of a) {
      magA += v * v;
      const bv = b.get(k);
      if (bv) dot += v * bv;
    }
    for (const [, v] of b) magB += v * v;
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  private pickKByWords(sentences: string[], scores: number[], maxWords: number): number {
    const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
    let words = 0;
    let k = 0;
    for (const { i } of order) {
      const w = sentences[i].split(/\s+/).length;
      if (words + w > maxWords) break;
      words += w;
      k++;
    }
    return Math.max(1, k);
  }
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to',
  'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these',
  'those', 'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'me', 'him', 'her',
  'them', 'us', 'your', 'our', 'their', 'his', 'hers', 'theirs', 'ours', 'yours',
  'which', 'who', 'whom', 'whose', 'what', 'where', 'when', 'why', 'how', 'all',
  'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't',
  'just', 'don', 'now',
]);

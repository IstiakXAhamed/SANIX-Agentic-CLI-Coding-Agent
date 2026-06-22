/**
 * @file QualityScorer.ts
 * @description Scores a generated output on five dimensions for use in
 * voting, MoE, and swarm strategies:
 *
 *   - relevance     (0.30) — semantic similarity to the original query
 *   - completeness  (0.20) — coverage of expected sub-topics (heuristic)
 *   - clarity       (0.15) — inverse of avg sentence length + structure
 *   - correctness   (0.25) — LLM judge (if available) or fact-count heuristic
 *   - specificity   (0.10) — inverse of genericness (proper nouns, numbers, examples)
 *
 * The overall score is a weighted average. Callers may supply an
 * optional `judge` callback for the correctness dimension; otherwise a
 * simple fact-count heuristic is used.
 *
 * @packageDocumentation
 */

import type { QualityScore } from './types.js';

/** Default weights per dimension (must sum to 1.0). */
const DEFAULT_WEIGHTS = {
  relevance: 0.3,
  completeness: 0.2,
  clarity: 0.15,
  correctness: 0.25,
  specificity: 0.1,
} as const;

/** Options for {@link QualityScorer.score}. */
export interface QualityScorerOptions {
  /**
   * LLM-judge callback for the correctness dimension. Returns a 0..1
   * score for the output's correctness given the query.
   */
  judge?: (output: string, query: string) => Promise<number>;
  /**
   * Embedding function for semantic similarity (relevance dimension).
   * If omitted, falls back to keyword overlap.
   */
  embed?: (text: string) => Promise<number[]>;
}

/**
 * Scores a generated output on multiple dimensions.
 *
 * @example
 * ```ts
 * const scorer = new QualityScorer();
 * const score = scorer.score('Use a binary search. It runs in O(log n).', 'How do I search a sorted array?');
 * console.log(score.overall);            // 0..1
 * console.log(score.dimensions.clarity); // 0..1
 * ```
 */
export class QualityScorer {
  /** Per-dimension weights (read-only copy of the defaults). */
  readonly weights = DEFAULT_WEIGHTS;

  /**
   * Score an output against a query.
   *
   * @param output - The generated output to score.
   * @param query  - The original query / problem.
   * @param opts   - Optional judge / embed callbacks.
   * @returns The overall score and per-dimension breakdown.
   */
  async score(
    output: string,
    query: string,
    opts: QualityScorerOptions = {},
  ): Promise<QualityScore> {
    const relevance = await this.relevanceScore(output, query, opts);
    const completeness = this.completenessScore(output);
    const clarity = this.clarityScore(output);
    const correctness = await this.correctnessScore(output, query, opts);
    const specificity = this.specificityScore(output);

    const overall =
      DEFAULT_WEIGHTS.relevance * relevance +
      DEFAULT_WEIGHTS.completeness * completeness +
      DEFAULT_WEIGHTS.clarity * clarity +
      DEFAULT_WEIGHTS.correctness * correctness +
      DEFAULT_WEIGHTS.specificity * specificity;

    return {
      overall: clamp01(overall),
      dimensions: {
        relevance,
        completeness,
        clarity,
        correctness,
        specificity,
      },
    };
  }

  /**
   * Relevance: semantic similarity to the query. Uses an embedding
   * function if provided, else falls back to keyword overlap (Jaccard).
   */
  private async relevanceScore(
    output: string,
    query: string,
    opts: QualityScorerOptions,
  ): Promise<number> {
    if (opts.embed) {
      try {
        const [eOut, eQuery] = await Promise.all([
          opts.embed(output),
          opts.embed(query),
        ]);
        return clamp01(cosineSim(eOut, eQuery));
      } catch {
        // Fall through to keyword overlap.
      }
    }
    return jaccardSimilarity(output, query);
  }

  /**
   * Completeness: fraction of expected sub-topics covered. Heuristic —
   * presence of causal connectives (`because`, `therefore`, `so`),
   * numbered lists, and code blocks.
   */
  private completenessScore(output: string): number {
    if (!output.trim()) return 0;
    let score = 0;
    const causal = /\b(because|therefore|so|thus|hence|as a result|consequently)\b/gi;
    const causalCount = (output.match(causal) ?? []).length;
    score += Math.min(0.4, causalCount * 0.1);
    const numbered = (output.match(/^\s*\d+\.\s+/gm) ?? []).length;
    score += Math.min(0.3, numbered * 0.1);
    const codeBlocks = (output.match(/```[\s\S]*?```/g) ?? []).length;
    score += Math.min(0.3, codeBlocks * 0.15);
    return clamp01(score);
  }

  /**
   * Clarity: inverse of average sentence length + presence of structure
   * (headings, bullets). Shorter, more-structured outputs score higher.
   */
  private clarityScore(output: string): number {
    if (!output.trim()) return 0;
    const sentences = output
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (sentences.length === 0) return 0;
    const avgLen =
      sentences.reduce((s, sent) => s + sent.split(/\s+/).length, 0) /
      sentences.length;
    // Optimal avg sentence length is ~15-20 words; penalize >25.
    const lengthScore = avgLen <= 20 ? 1 : avgLen >= 50 ? 0.2 : 1 - (avgLen - 20) / 30 * 0.8;
    const headings = (output.match(/^#{1,6}\s+/gm) ?? []).length;
    const bullets = (output.match(/^\s*[-*+]\s+/gm) ?? []).length;
    const structureScore = Math.min(1, (headings + bullets) / 4);
    return clamp01(0.6 * lengthScore + 0.4 * structureScore);
  }

  /**
   * Correctness: LLM judge if available, else a fact-count heuristic
   * (count of concrete technical terms — model names, library names,
   * language keywords, common algorithms).
   */
  private async correctnessScore(
    output: string,
    query: string,
    opts: QualityScorerOptions,
  ): Promise<number> {
    if (opts.judge) {
      try {
        const s = await opts.judge(output, query);
        return clamp01(s);
      } catch {
        // Fall through to heuristic.
      }
    }
    return this.factCountHeuristic(output);
  }

  /**
   * Specificity: inverse of genericness. Rewards proper nouns, numbers,
   * and concrete examples. Penalizes vague phrases (`some`, `maybe`,
   * `might`, `could be`).
   */
  private specificityScore(output: string): number {
    if (!output.trim()) return 0;
    const properNouns = (output.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? []).length;
    const numbers = (output.match(/\b\d+(\.\d+)?\b/g) ?? []).length;
    const codeRefs = (output.match(/`[^`]+`/g) ?? []).length;
    const positives = properNouns + numbers + codeRefs;
    const vague = (output.match(/\b(some|maybe|might|could be|perhaps|probably|usually|generally)\b/gi) ?? []).length;
    const positiveScore = Math.min(1, positives / 12);
    const vaguePenalty = Math.min(0.5, vague * 0.05);
    return clamp01(positiveScore - vaguePenalty);
  }

  /**
   * Fact-count heuristic: counts technical terms from a small fixed
   * vocabulary (common languages, libraries, algorithms, concepts).
   */
  private factCountHeuristic(output: string): number {
    const lower = output.toLowerCase();
    const TECH_TERMS = [
      'typescript', 'javascript', 'python', 'rust', 'go', 'java', 'c++', 'react',
      'next.js', 'node', 'bun', 'docker', 'kubernetes', 'sql', 'postgres', 'redis',
      'binary search', 'merge sort', 'quick sort', 'hash table', 'tree', 'graph',
      'dfs', 'bfs', 'dynamic programming', 'recursion', 'iteration', 'async',
      'await', 'promise', 'callback', 'closure', 'class', 'interface', 'type',
      'schema', 'migration', 'test', 'mock', 'stub', 'fixture', 'ci', 'cd',
    ];
    let hits = 0;
    for (const term of TECH_TERMS) {
      if (lower.includes(term)) hits++;
    }
    return clamp01(hits / 8);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Clamp a number to the 0..1 range. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Cosine similarity between two equal-length numeric vectors.
 */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Jaccard similarity between the token sets of two strings.
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Tokenize a string into lowercase alphanumeric words.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

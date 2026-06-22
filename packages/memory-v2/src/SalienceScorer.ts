/**
 * @file memory-v2/src/SalienceScorer.ts
 * @description Computes a 0..1 "salience" score for a memory item based
 * on six weighted factors:
 *
 *   | Factor            | Weight | What it captures                       |
 *   |-------------------|--------|----------------------------------------|
 *   | Novelty           | 0.25   | Distance from existing memories.       |
 *   | Importance        | 0.25   | User- or LLM-flagged importance.       |
 *   | Recency           | 0.20   | Ebbinghaus retention.                  |
 *   | Frequency         | 0.15   | Log-scaled recall count.               |
 *   | Emotional valence | 0.15   | Errors weighted higher than successes. |
 *   | Goal relevance    | 0.10   | Token overlap with the current goal.   |
 *
 * The score is **synchronous** — novelty is computed from existing
 * pre-computed embeddings only (no on-the-fly embedding generation
 * inside `score()`). The `ScoreContext.embeddingProvider` field is
 * available for callers who want to pre-compute embeddings before
 * calling `score()` (e.g. via `precomputeNovelty()`).
 *
 * @packageDocumentation
 */

import type { MemoryItem } from './types.js';
import { ForgettingCurve } from './ForgettingCurve.js';

/** Context for `SalienceScorer.score()`. */
export interface ScoreContext {
  /**
   * Existing memories used to compute novelty. Only items with non-empty
   * `embedding` arrays contribute. Pass an empty array (or omit) for
   * the first memory in a corpus — novelty defaults to 1.0.
   */
  existingMemories?: ReadonlyArray<MemoryItem>;
  /**
   * The agent's current goal (free-text). Used to compute goal-relevance
   * via token overlap.
   */
  currentGoal?: string;
  /**
   * Optional embedding provider (shape matches the lazy `EmbeddingProvider`
   * from `@sanix/core`). Not used inside the sync `score()` method —
   * callers can use it via {@link SalienceScorer.precomputeNovelty} to
   * warm the novelty cache before scoring.
   */
  embeddingProvider?: { embed(text: string): Promise<Float32Array | null> };
}

/** Weights for each salience factor. */
export interface SalienceWeights {
  novelty: number;
  importance: number;
  recency: number;
  frequency: number;
  valence: number;
  goalRelevance: number;
}

/** Default weights — sum to 1.0. */
export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
  novelty: 0.25,
  importance: 0.25,
  recency: 0.20,
  frequency: 0.15,
  valence: 0.15,
  goalRelevance: 0.10,
};

/** Constructor options. */
export interface SalienceScorerOptions {
  /** Override the default weights. Weights are renormalized to sum to 1. */
  weights?: Partial<SalienceWeights>;
  /** LRU cache size for novelty lookups. Default 1000. */
  noveltyCacheSize?: number;
  /** Forgetting-curve instance (for recency). A default is created if omitted. */
  forgettingCurve?: ForgettingCurve;
}

/**
 * Computes salience scores for memory items.
 *
 * @example
 * ```ts
 * const scorer = new SalienceScorer();
 * const score = scorer.score(memory, { existingMemories, currentGoal: 'auth' });
 * if (score > 0.7) await promote(memory);
 * ```
 */
export class SalienceScorer {
  private readonly weights: SalienceWeights;
  private readonly noveltyCache: LRUCache<string, number>;
  private readonly forgettingCurve: ForgettingCurve;

  constructor(opts: SalienceScorerOptions = {}) {
    const merged: SalienceWeights = { ...DEFAULT_SALIENCE_WEIGHTS, ...opts.weights };
    this.weights = renormalize(merged);
    this.noveltyCache = new LRUCache<string, number>(opts.noveltyCacheSize ?? 1000);
    this.forgettingCurve = opts.forgettingCurve ?? new ForgettingCurve();
  }

  /**
   * Compute the 0..1 salience score for `memory`.
   *
   * @example
   * ```ts
   * const s = scorer.score(memory, { existingMemories, currentGoal: 'fix bug 42' });
   * ```
   */
  score(memory: MemoryItem, ctx?: ScoreContext): number {
    const novelty = this.computeNovelty(memory, ctx?.existingMemories);
    const importance = this.computeImportance(memory);
    const recency = this.computeRecency(memory);
    const frequency = this.computeFrequency(memory);
    const valence = this.computeValence(memory);
    const goalRelevance = this.computeGoalRelevance(memory, ctx?.currentGoal);

    const w = this.weights;
    const total =
      w.novelty * novelty +
      w.importance * importance +
      w.recency * recency +
      w.frequency * frequency +
      w.valence * valence +
      w.goalRelevance * goalRelevance;

    // Clamp to [0, 1] — floating-point sums can drift slightly above 1.
    return Math.max(0, Math.min(1, total));
  }

  /**
   * Pre-compute the novelty of a memory (using the embedding provider to
   * generate any missing embedding) and stash it in the LRU cache. The
   * sync {@link score} method then reads from the cache without doing
   * any embedding work.
   *
   * No-op if `ctx.embeddingProvider` is absent or if the memory already
   * has a cached novelty value.
   *
   * @example
   * ```ts
   * await scorer.precomputeNovelty(memory, {
   *   existingMemories,
   *   embeddingProvider,
   * });
   * const s = scorer.score(memory, { existingMemories });
   * ```
   */
  async precomputeNovelty(
    memory: MemoryItem,
    ctx?: ScoreContext,
  ): Promise<void> {
    if (this.noveltyCache.has(memory.id)) return;
    if (!ctx?.embeddingProvider) return;
    const existing = ctx.existingMemories;
    if (!existing || existing.length === 0) {
      this.noveltyCache.set(memory.id, 1.0);
      return;
    }
    const vec = await ctx.embeddingProvider.embed(memory.content);
    if (!vec) return;
    const novelty = this.computeNoveltyFromVector(
      memory.id,
      Array.from(vec),
      existing,
    );
    this.noveltyCache.set(memory.id, novelty);
  }

  /**
   * Clear the novelty cache (e.g. when the corpus has changed so much
   * that cached values are no longer valid).
   */
  clearCache(): void {
    this.noveltyCache.clear();
  }

  // ─── Factor implementations ─────────────────────────────────────────────

  /**
   * Novelty: average cosine distance to the top-5 nearest existing
   * memories (normalized to 0..1). Returns 1.0 if there are no existing
   * memories (the first memory is maximally novel).
   *
   * Reads from the LRU cache first; on miss, computes sync from
   * `memory.embedding` (if present) and caches.
   */
  private computeNovelty(
    memory: MemoryItem,
    existing?: ReadonlyArray<MemoryItem>,
  ): number {
    const cached = this.noveltyCache.get(memory.id);
    if (cached !== undefined) return cached;
    if (!existing || existing.length === 0) {
      this.noveltyCache.set(memory.id, 1.0);
      return 1.0;
    }
    if (!memory.embedding || memory.embedding.length === 0) {
      // Without an embedding we can't compute true novelty — fall back
      // to a neutral 0.5 (don't cache so a later call with embeddings
      // can fill it in).
      return 0.5;
    }
    const value = this.computeNoveltyFromVector(memory.id, memory.embedding, existing);
    this.noveltyCache.set(memory.id, value);
    return value;
  }

  /**
   * Compute novelty from a known vector against an existing corpus.
   * Returns `1 - mean(top-5 cosine similarities)`. The memory's own id
   * is excluded from the corpus so a memory can't be its own nearest
   * neighbor.
   */
  private computeNoveltyFromVector(
    selfId: string,
    vec: number[],
    existing: ReadonlyArray<MemoryItem>,
  ): number {
    const sims: number[] = [];
    for (const m of existing) {
      if (m.id === selfId) continue;
      if (!m.embedding || m.embedding.length === 0) continue;
      const sim = cosineSimilarity(vec, m.embedding);
      sims.push(sim);
    }
    if (sims.length === 0) return 1.0;
    sims.sort((a, b) => b - a);
    const top = sims.slice(0, 5);
    const mean = top.reduce((s, x) => s + x, 0) / top.length;
    // Distance = 1 - similarity, clamped to [0, 1] (sims can be negative).
    return Math.max(0, Math.min(1, 1 - mean));
  }

  /**
   * Importance: straight pass-through of `memory.importance` (clamped
   * to 0..1). Falls back to 0.5 if missing.
   */
  private computeImportance(memory: MemoryItem): number {
    const v = typeof memory.importance === 'number' ? memory.importance : 0.5;
    return Math.max(0, Math.min(1, v));
  }

  /**
   * Recency: Ebbinghaus retention at the current time. Uses
   * `memory.metadata.lastAccessedAt` if present, else `createdAt`.
   * Stability defaults to 24h.
   */
  private computeRecency(memory: MemoryItem): number {
    const now = Date.now();
    const lastAccessedAt =
      typeof memory.metadata.lastAccessedAt === 'number'
        ? memory.metadata.lastAccessedAt
        : Date.parse(memory.createdAt);
    const stability =
      typeof memory.metadata.stability === 'number'
        ? memory.metadata.stability
        : 24 * 60 * 60 * 1000;
    return this.forgettingCurve.retention({
      lastAccessedAt: Number.isFinite(lastAccessedAt) ? lastAccessedAt : now,
      stability,
      createdAt: Date.parse(memory.createdAt) || now,
    });
  }

  /**
   * Frequency: log-scaled recall count, normalized so that ~10 recalls
   * maps to ~1.0. `recallCount` 0 → 0; 1 → 0.30; 5 → 0.74; 10 → 1.00.
   */
  private computeFrequency(memory: MemoryItem): number {
    const count = typeof memory.metadata.recallCount === 'number' ? memory.metadata.recallCount : 0;
    if (count <= 0) return 0;
    return Math.min(1, Math.log(1 + count) / Math.log(1 + 10));
  }

  /**
   * Emotional valence: error / failure memories score 0.8 (we learn
   * more from failure than success); success / neutral score 0.3.
   */
  private computeValence(memory: MemoryItem): number {
    if (memory.metadata.isError === true) return 0.8;
    if (memory.metadata.outcome === 'failure') return 0.8;
    if (memory.metadata.outcome === 'success') return 0.4;
    return 0.3;
  }

  /**
   * Goal relevance: token-overlap ratio between the current goal and
   * the memory's content. Tokens < 3 chars are ignored (stop-word-ish).
   */
  private computeGoalRelevance(memory: MemoryItem, currentGoal?: string): number {
    if (!currentGoal) return 0.5;
    const goalTokens = tokenize(currentGoal).filter((t) => t.length > 2);
    if (goalTokens.length === 0) return 0.5;
    const contentTokens = new Set(tokenize(memory.content));
    if (contentTokens.size === 0) return 0;
    const hits = goalTokens.filter((t) => contentTokens.has(t)).length;
    return hits / goalTokens.length;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/** Tokenize a string into lowercase alphanumeric tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

/**
 * Cosine similarity between two number arrays. Returns 0 for empty or
 * mismatched-length inputs.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Renormalize a weights object so its values sum to exactly 1. */
function renormalize(w: SalienceWeights): SalienceWeights {
  const sum = w.novelty + w.importance + w.recency + w.frequency + w.valence + w.goalRelevance;
  if (sum <= 0) return { ...DEFAULT_SALIENCE_WEIGHTS };
  return {
    novelty: w.novelty / sum,
    importance: w.importance / sum,
    recency: w.recency / sum,
    frequency: w.frequency / sum,
    valence: w.valence / sum,
    goalRelevance: w.goalRelevance / sum,
  };
}

// ─── LRU cache ──────────────────────────────────────────────────────────────

/**
 * Tiny LRU cache with a max-size eviction policy. Used by
 * {@link SalienceScorer} to cache novelty scores per memory id.
 */
class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly max: number;

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    // Move-to-back (most-recently-used).
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

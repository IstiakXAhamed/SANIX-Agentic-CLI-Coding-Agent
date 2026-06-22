/**
 * @file AttentionSelector.ts
 * @description Attention-weighted context selection. Given a list of
 * candidate context items (messages, memories, file snippets) and a
 * user query, pick the top-N most relevant items that fit within a
 * token budget.
 *
 * The score blends four signals:
 *   - **Semantic similarity** between the query and the item content
 *     (cosine over Xenova MiniLM embeddings, lazy-loaded).
 *   - **Recency** — newer items get a small bump (exponential decay
 *     over 7 days).
 *   - **Importance** — caller-supplied 0..1 score (e.g. memory tier's
 *     `importance` field, or a tool-result error flag).
 *   - **Position bias** — a small monotonic boost for items closer to
 *     the start of the list (preserves caller-supplied ordering hints).
 *
 * Defaults: α=0.5 (similarity), β=0.2 (recency), γ=0.2 (importance),
 * δ=0.1 (position). All weights are configurable per call.
 *
 * @packageDocumentation
 */

import type { ExactTokenizer } from './ExactTokenizer.js';
import { tokenizer as defaultTokenizer } from './ExactTokenizer.js';

/**
 * A candidate item the selector can rank. The shape is deliberately
 * permissive: `metadata` is an open bag so callers can stash whatever
 * they need (source file path, memory tier, message role, etc.) without
 * forcing the selector to know about every concrete item type.
 */
export interface ScoreableItem {
  /** Unique id (used for dedupe + position bias). */
  id: string;
  /** The text content used for similarity scoring and budget counting. */
  content: string;
  /** Pre-computed token count for `content`. If absent, the selector
   * computes it via the configured tokenizer. */
  tokens?: number;
  /** Caller-supplied importance 0..1. Defaults to 0.5. */
  importance?: number;
  /** Optional creation timestamp (ms since epoch) for recency scoring. */
  timestamp?: number;
  /** Free-form metadata bag (preserved on selected items). */
  metadata?: Record<string, unknown>;
}

/**
 * Weights for the blended score. All must be in [0, 1]; their sum is
 * not required to be 1 (the score is normalized only against other
 * items in the same call, not absolutely).
 */
export interface ScoreWeights {
  /** Weight for semantic similarity (default 0.5). */
  alpha?: number;
  /** Weight for recency (default 0.2). */
  beta?: number;
  /** Weight for importance (default 0.2). */
  gamma?: number;
  /** Weight for position bias (default 0.1). */
  delta?: number;
}

/**
 * Result of {@link AttentionSelector.score}: the item plus its computed
 * score and per-signal breakdown (useful for debugging / TUI display).
 */
export interface ScoredItem<T extends ScoreableItem = ScoreableItem> {
  /** The original item. */
  item: T;
  /** Blended score 0..1 (higher = more relevant). */
  score: number;
  /** Per-signal breakdown (each in 0..1). */
  signals: {
    similarity: number;
    recency: number;
    importance: number;
    position: number;
  };
}

/**
 * Default weights. Exported so callers can extend rather than rebuild.
 */
export const DEFAULT_WEIGHTS: Required<ScoreWeights> = {
  alpha: 0.5,
  beta: 0.2,
  gamma: 0.2,
  delta: 0.1,
};

/**
 * Recency half-life in milliseconds (7 days). Items older than this
 * receive less than half the maximum recency boost.
 */
const RECENCY_HALF_LIFE_MS = 7 * 86_400_000;

/**
 * The lazily-resolved `@xenova/transformers` pipeline (shared with
 * SemanticChunker — declared locally here so this module is
 * self-contained).
 */
interface Embedder {
  (texts: string[], opts: { pooling: 'mean'; normalize: boolean }): Promise<
    { data: number[] }[]
  >;
}

/**
 * Cached Xenova pipeline (separate cache from SemanticChunker so the
 * two modules can be used independently without coupling).
 */
let embedderPromise: Promise<Embedder | null> | null = null;

/**
 * Load (and cache) the Xenova `feature-extraction` pipeline. Returns
 * `null` if `@xenova/transformers` is not installed or fails to load.
 * The selector then falls back to a Jaccard-over-tokens similarity
 * heuristic.
 */
async function loadEmbedder(): Promise<Embedder | null> {
  if (embedderPromise !== null) return embedderPromise;
  embedderPromise = (async (): Promise<Embedder | null> => {
    try {
      const mod = (await import('@xenova/transformers')) as {
        pipeline: (task: string, model: string) => Promise<Embedder>;
      };
      return await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    } catch {
      return null;
    }
  })();
  return embedderPromise;
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
 * Tokenize text into lowercase word tokens for the Jaccard fallback.
 * Strips punctuation but keeps alphanumerics + underscores.
 */
function wordTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter((t) => t.length > 0),
  );
}

/**
 * Jaccard similarity between two sets (|A∩B| / |A∪B|). Used as a
 * fallback when embeddings are unavailable.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Exponential recency score in [0, 1]. `now` is captured once per
 * `select` call so all items in the same call are scored against the
 * same reference time.
 */
function recencyScore(timestamp: number | undefined, now: number): number {
  if (timestamp === undefined) return 0.5; // unknown → neutral
  const age = Math.max(0, now - timestamp);
  // Half-life decay: score = 0.5^(age / halfLife).
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

/**
 * Attention-weighted context selector.
 *
 * @example
 * ```ts
 * const selector = new AttentionSelector();
 * const items = [
 *   { id: '1', content: 'auth login flow', importance: 0.8 },
 *   { id: '2', content: 'database migrations', importance: 0.5 },
 * ];
 * const picked = await selector.select('how does login work?', items, 1000);
 * // picked[0].id === '1' (high similarity + high importance)
 * ```
 */
export class AttentionSelector {
  private readonly tokenizer: ExactTokenizer;

  /**
   * @param tokenizer Tokenizer for budget tracking. Defaults to the
   *   shared singleton.
   */
  constructor(tokenizer: ExactTokenizer = defaultTokenizer) {
    this.tokenizer = tokenizer;
  }

  /**
   * Score every item against the query (does not apply the budget).
   * Exposed publicly so callers can inspect / re-rank the full list
   * before truncation.
   *
   * @example
   * ```ts
   * const scored = await selector.score('login', items);
   * scored.sort((a, b) => b.score - a.score);
   * ```
   */
  async score<T extends ScoreableItem>(
    query: string,
    items: ReadonlyArray<T>,
    weights: ScoreWeights = {},
  ): Promise<ScoredItem<T>[]> {
    const w: Required<ScoreWeights> = { ...DEFAULT_WEIGHTS, ...weights };
    const now = Date.now();

    // Embed query + all item contents in one batch (Xenova is much
    // faster batched than per-item).
    const embedder = await loadEmbedder();
    let queryVec: number[] | null = null;
    let itemVecs: (number[] | null)[] = items.map(() => null);
    if (embedder) {
      try {
        const all = [query, ...items.map((i) => i.content)];
        const outputs = await embedder(all, {
          pooling: 'mean',
          normalize: true,
        });
        queryVec = outputs[0]!.data;
        for (let i = 0; i < items.length; i++) {
          itemVecs[i] = outputs[i + 1]!.data;
        }
      } catch {
        queryVec = null;
      }
    }

    // Fallback: Jaccard over word tokens.
    const queryTokens = embedder ? null : wordTokens(query);

    return items.map((item, idx) => {
      const similarity = embedder && queryVec && itemVecs[idx]
        ? Math.max(0, cosine(queryVec, itemVecs[idx]!))
        : jaccard(queryTokens ?? new Set(), wordTokens(item.content));
      const recency = recencyScore(item.timestamp, now);
      const importance = item.importance ?? 0.5;
      // Position bias: 1.0 for the first item, decaying linearly to
      // 0.5 for the last. Mild so it only breaks ties.
      const position =
        items.length <= 1 ? 1 : 1 - 0.5 * (idx / (items.length - 1));
      const score =
        w.alpha * similarity +
        w.beta * recency +
        w.gamma * importance +
        w.delta * position;
      return {
        item,
        score,
        signals: { similarity, recency, importance, position },
      };
    });
  }

  /**
   * Select items that fit within `budget` tokens, ranked by blended
   * score. Returns the selected items (without scores — use
   * {@link score} if you need them).
   *
   * The selector is greedy: it sorts by score descending and packs
   * items in order, skipping any whose token count would exceed the
   * remaining budget. This is a 1/2-approximation of the 0/1 knapsack
   * problem, which is good enough for context selection (the cost of
   * being slightly suboptimal is just a few extra tokens of context).
   *
   * @param query The query string (semantic-similarity anchor).
   * @param items Candidate items.
   * @param budget Maximum total tokens the selected items may occupy.
   * @param weights Optional weight overrides.
   * @returns Items that fit, in descending score order.
   *
   * @example
   * ```ts
   * const picked = await selector.select('auth', items, 2000);
   * console.log(picked.map(i => i.id)); // ['3', '1', '7', ...]
   * ```
   */
  async select<T extends ScoreableItem>(
    query: string,
    items: ReadonlyArray<T>,
    budget: number,
    weights: ScoreWeights = {},
  ): Promise<T[]> {
    if (items.length === 0) return [];
    const scored = await this.score(query, items, weights);
    scored.sort((a, b) => b.score - a.score);

    const out: T[] = [];
    let used = 0;
    for (const s of scored) {
      const tokens =
        s.item.tokens ?? this.tokenizer.count(s.item.content);
      if (used + tokens > budget) continue;
      out.push(s.item);
      used += tokens;
      // If an item already has 0 tokens (empty content), still include
      // it — it's free and the caller may want it for metadata.
    }
    return out;
  }

  /**
   * Like {@link select} but returns the per-item scoring breakdown
   * alongside the picked items. Useful for TUI / debug rendering.
   */
  async selectWithScores<T extends ScoreableItem>(
    query: string,
    items: ReadonlyArray<T>,
    budget: number,
    weights: ScoreWeights = {},
  ): Promise<ScoredItem<T>[]> {
    if (items.length === 0) return [];
    const scored = await this.score(query, items, weights);
    scored.sort((a, b) => b.score - a.score);
    const out: ScoredItem<T>[] = [];
    let used = 0;
    for (const s of scored) {
      const tokens =
        s.item.tokens ?? this.tokenizer.count(s.item.content);
      if (used + tokens > budget) continue;
      out.push(s);
      used += tokens;
    }
    return out;
  }

  /**
   * Force-clear the cached embedder. Only useful in tests.
   */
  static resetEmbedderCache(): void {
    embedderPromise = null;
  }
}

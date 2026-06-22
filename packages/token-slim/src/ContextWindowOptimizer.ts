/**
 * @file ContextWindowOptimizer.ts
 * @description Knapsack-based context selection. Given a list of candidate
 * context items (each with a token cost and a relevance score), pick the
 * subset that maximizes total relevance under a token budget.
 *
 * Implements the classic 0/1 knapsack DP. With `n` items and budget `W`,
 * runtime is O(n*W) — fine for the typical 10-100 context items /
 * 1k-32k token budget.
 *
 * @packageDocumentation
 */

/**
 * A candidate context item.
 */
export interface ContextItem {
  /** Stable id (used in the result). */
  id: string;
  /** Token cost of including this item. */
  tokens: number;
  /** Relevance score (higher = more important). */
  score: number;
  /** The item's text payload (passed through to the result). */
  text: string;
}

/**
 * Result of {@link ContextWindowOptimizer.select}.
 */
export interface SelectionResult {
  /** Selected items, in their original order. */
  selected: ContextItem[];
  /** Total tokens of the selected items. */
  totalTokens: number;
  /** Total relevance score of the selected items. */
  totalScore: number;
  /** Items that were dropped (for diagnostics). */
  dropped: ContextItem[];
}

/**
 * Knapsack-based context-window optimizer.
 *
 * @example
 * ```ts
 * const r = ContextWindowOptimizer.select(items, { budget: 4096 });
 * r.selected; // highest-value subset under 4096 tokens
 * ```
 */
export const ContextWindowOptimizer = {
  /**
   * Select the highest-relevance subset of items under the token budget.
   *
   * @param items Candidate items.
   * @param opts.budget Token budget.
   * @param opts.reserve Tokens to reserve (e.g. for output). Default 0.
   * @returns A {@link SelectionResult}.
   */
  select(
    items: readonly ContextItem[],
    opts: { budget: number; reserve?: number },
  ): SelectionResult {
    const budget = Math.max(0, opts.budget - (opts.reserve ?? 0));
    if (items.length === 0 || budget <= 0) {
      return { selected: [], totalTokens: 0, totalScore: 0, dropped: [...items] };
    }
    // Scale token costs to integers (knapsack needs integer weights).
    // Items with 0 tokens are always selected (free relevance).
    const free = items.filter((i) => i.tokens <= 0);
    const paid = items.filter((i) => i.tokens > 0);
    const n = paid.length;
    const W = Math.floor(budget);
    // dp[w] = best score achievable with weight budget w.
    const dp = new Float64Array(W + 1);
    // keep[i][w] = did we include item i in the optimal solution for weight w?
    const keep: Uint8Array[] = [];
    for (let i = 0; i < n; i++) keep.push(new Uint8Array(W + 1));

    for (let i = 0; i < n; i++) {
      const wt = Math.min(W, Math.floor(paid[i].tokens));
      const sc = paid[i].score;
      // Iterate w descending so each item is used at most once.
      for (let w = W; w >= wt; w--) {
        const candidate = dp[w - wt] + sc;
        if (candidate > dp[w]) {
          dp[w] = candidate;
          keep[i][w] = 1;
        }
      }
    }

    // Backtrack to find which items were selected.
    const chosenIdx = new Set<number>();
    let w = W;
    for (let i = n - 1; i >= 0; i--) {
      if (keep[i][w] === 1) {
        chosenIdx.add(i);
        w -= Math.min(W, Math.floor(paid[i].tokens));
        if (w < 0) break;
      }
    }

    // Preserve original order across free + paid.
    const selectedSet = new Set<string>();
    let totalTokens = 0;
    let totalScore = 0;
    for (const f of free) {
      selectedSet.add(f.id);
      totalTokens += f.tokens;
      totalScore += f.score;
    }
    paid.forEach((p, i) => {
      if (chosenIdx.has(i)) {
        selectedSet.add(p.id);
        totalTokens += p.tokens;
        totalScore += p.score;
      }
    });

    const selected: ContextItem[] = [];
    const dropped: ContextItem[] = [];
    for (const it of items) {
      if (selectedSet.has(it.id)) selected.push(it);
      else dropped.push(it);
    }
    return { selected, totalTokens, totalScore, dropped };
  },
};

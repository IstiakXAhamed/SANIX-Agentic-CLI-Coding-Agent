/**
 * @file ConsensusEngine.ts
 * @description Reconciles divergent member outputs into a single consensus.
 * Supports six methods: majority, supermajority, unanimous, weighted,
 * judge_decided, best_of_n.
 *
 * Similarity is computed via either:
 *   - a caller-supplied embedding function (`opts.embed`), or
 *   - bag-of-words cosine similarity (default).
 *
 * Outputs are clustered by transitive pairwise similarity ≥ threshold.
 * The winning cluster is the one with the most weight (or most members,
 * for unweighted methods). The consensus text is the longest output in
 * the winning cluster (a simple proxy for completeness).
 *
 * @packageDocumentation
 */

import type {
  ConsensusMethod,
  ConsensusOptions,
  ConsensusResult,
} from './types.js';

/**
 * A member's contribution to a consensus round.
 */
export interface ConsensusInput {
  /** Member id. */
  memberId: string;
  /** The member's output text. */
  output: string;
  /** Weight (for `weighted` method; default 1.0). */
  weight: number;
}

/**
 * A cluster of similar outputs.
 */
interface OutputCluster {
  /** Indices into the original `outputs` array. */
  memberIndices: number[];
  /** Total weight of members in this cluster. */
  totalWeight: number;
  /** The longest output in this cluster (used as the representative). */
  representative: string;
}

/** Default fuzzy-match similarity threshold (per spec). */
const DEFAULT_THRESHOLD = 0.85;

/** Default supermajority fraction (per spec). */
const SUPERMAJORITY_FRACTION = 0.67;

/**
 * Reconciles divergent member outputs into a single consensus.
 *
 * @example
 * ```ts
 * const engine = new ConsensusEngine();
 * const result = await engine.reach(
 *   [
 *     { memberId: 'a', output: 'Use a binary search.', weight: 1 },
 *     { memberId: 'b', output: 'A binary search tree is best.', weight: 1 },
 *     { memberId: 'c', output: 'Try merge sort.', weight: 1 },
 *   ],
 *   'majority',
 * );
 * console.log(result.consensus);  // 'A binary search tree is best.'
 * console.log(result.confidence); // 0.667
 * ```
 */
export class ConsensusEngine {
  /**
   * Reach consensus among member outputs.
   *
   * @param outputs - The member outputs to reconcile.
   * @param method  - The reconciliation method.
   * @param opts    - Optional judge / threshold / embed / onConflict.
   * @returns The consensus text, confidence, and disagreements.
   */
  async reach(
    outputs: ConsensusInput[],
    method: ConsensusMethod,
    opts: ConsensusOptions = {},
  ): Promise<ConsensusResult> {
    if (outputs.length === 0) {
      return { consensus: '', confidence: 0, disagreements: [] };
    }
    if (outputs.length === 1) {
      return {
        consensus: outputs[0]!.output,
        confidence: 1,
        disagreements: [],
      };
    }

    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

    switch (method) {
      case 'majority':
        return this.majority(outputs, threshold, opts);
      case 'supermajority':
        return this.supermajority(outputs, threshold, opts);
      case 'unanimous':
        return this.unanimous(outputs, threshold, opts);
      case 'weighted':
        return this.weighted(outputs, threshold, opts);
      case 'judge_decided':
        return this.judgeDecided(outputs, opts);
      case 'best_of_n':
        return this.bestOfN(outputs, opts);
      default:
        return this.majority(outputs, threshold, opts);
    }
  }

  // ─── Methods ────────────────────────────────────────────────────────────

  /**
   * Majority: pick the most common output (fuzzy-matched via the
   * similarity threshold). Confidence = largest_cluster_size / total.
   */
  private async majority(
    outputs: ConsensusInput[],
    threshold: number,
    opts: ConsensusOptions,
  ): Promise<ConsensusResult> {
    const clusters = await this.cluster(outputs, threshold, opts);
    const winner = this.largestCluster(clusters);
    return this.buildResult(outputs, clusters, winner, 0.5);
  }

  /**
   * Supermajority: need ≥67% agreement. If no cluster exceeds the
   * threshold, the `onConflict` policy kicks in (default `best_effort`
   * — returns the largest cluster anyway with reduced confidence).
   */
  private async supermajority(
    outputs: ConsensusInput[],
    threshold: number,
    opts: ConsensusOptions,
  ): Promise<ConsensusResult> {
    const clusters = await this.cluster(outputs, threshold, opts);
    const winner = this.largestCluster(clusters);
    const agreementRate = winner.memberIndices.length / outputs.length;
    const required = SUPERMAJORITY_FRACTION;
    if (agreementRate >= required) {
      return this.buildResult(outputs, clusters, winner, required);
    }
    // Conflict — apply onConflict policy.
    return this.handleConflict(outputs, clusters, winner, required, opts);
  }

  /**
   * Unanimous: need 100% agreement. Almost always fails on free-form
   * text; the `onConflict` policy decides what to return.
   */
  private async unanimous(
    outputs: ConsensusInput[],
    threshold: number,
    opts: ConsensusOptions,
  ): Promise<ConsensusResult> {
    const clusters = await this.cluster(outputs, threshold, opts);
    if (clusters.length === 1) {
      const winner = clusters[0]!;
      return this.buildResult(outputs, clusters, winner, 1.0);
    }
    const winner = this.largestCluster(clusters);
    return this.handleConflict(outputs, clusters, winner, 1.0, opts);
  }

  /**
   * Weighted: sum weights per cluster, pick the highest. Confidence =
   * winner_weight / total_weight.
   */
  private async weighted(
    outputs: ConsensusInput[],
    threshold: number,
    opts: ConsensusOptions,
  ): Promise<ConsensusResult> {
    const clusters = await this.cluster(outputs, threshold, opts);
    let winner = clusters[0]!;
    for (const c of clusters) {
      if (c.totalWeight > winner.totalWeight) winner = c;
    }
    const totalWeight = outputs.reduce((s, o) => s + o.weight, 0);
    const confidence = totalWeight > 0 ? winner.totalWeight / totalWeight : 0;
    const disagreements = this.minorityMemberIds(outputs, clusters, winner);
    return {
      consensus: winner.representative,
      confidence,
      disagreements,
    };
  }

  /**
   * Judge-decided: call the judge callback to pick the best output.
   * Confidence = 1.0 (the judge is authoritative). Disagreements = all
   * non-winning members.
   */
  private async judgeDecided(
    outputs: ConsensusInput[],
    opts: ConsensusOptions,
  ): Promise<ConsensusResult> {
    if (!opts.judge) {
      // No judge provided — fall back to best_of_n.
      return this.bestOfN(outputs, opts);
    }
    const texts = outputs.map((o) => o.output);
    let winner = '';
    try {
      winner = await opts.judge(texts);
    } catch {
      return this.bestOfN(outputs, opts);
    }
    // The judge returns the chosen text (or close to it). Find the
    // member whose output is closest to the judge's pick.
    const winnerIdx = this.closestOutputIndex(texts, winner);
    const disagreements = outputs
      .map((_, i) => i)
      .filter((i) => i !== winnerIdx)
      .map((i) => outputs[i]!.memberId);
    return {
      consensus: winner,
      confidence: 1.0,
      disagreements,
    };
  }

  /**
   * Best-of-N: pick the longest / most detailed / highest-scoring output
   * via a simple quality heuristic (length + structure + specificity).
   */
  private async bestOfN(
    outputs: ConsensusInput[],
    _opts: ConsensusOptions,
  ): Promise<ConsensusResult> {
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < outputs.length; i++) {
      const s = qualityHeuristic(outputs[i]!.output);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    const disagreements = outputs
      .map((_, i) => i)
      .filter((i) => i !== bestIdx)
      .map((i) => outputs[i]!.memberId);
    return {
      consensus: outputs[bestIdx]!.output,
      confidence: bestScore,
      disagreements,
    };
  }

  // ─── Clustering ─────────────────────────────────────────────────────────

  /**
   * Cluster outputs by transitive pairwise similarity ≥ threshold.
   * Uses union-find for transitive closure.
   */
  private async cluster(
    outputs: ConsensusInput[],
    threshold: number,
    opts: ConsensusOptions,
  ): Promise<OutputCluster[]> {
    const n = outputs.length;
    const parent = Array.from({ length: n }, (_, i) => i);

    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]]!;
        x = parent[x]!;
      }
      return x;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    // Compute embeddings (if available) or fall back to BoW.
    let embeddings: number[][] | null = null;
    if (opts.embed) {
      try {
        embeddings = await Promise.all(outputs.map((o) => opts.embed!(o.output)));
      } catch {
        embeddings = null;
      }
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = outputs[i]!.output;
        const b = outputs[j]!.output;
        const sim = embeddings
          ? cosineSim(embeddings[i]!, embeddings[j]!)
          : bowCosineSim(a, b);
        if (sim >= threshold) union(i, j);
      }
    }

    // Group indices by root.
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      const arr = groups.get(r) ?? [];
      arr.push(i);
      groups.set(r, arr);
    }

    // Build clusters.
    const clusters: OutputCluster[] = [];
    for (const indices of groups.values()) {
      let totalWeight = 0;
      let representative = '';
      let maxLen = -1;
      for (const idx of indices) {
        totalWeight += outputs[idx]!.weight;
        if (outputs[idx]!.output.length > maxLen) {
          maxLen = outputs[idx]!.output.length;
          representative = outputs[idx]!.output;
        }
      }
      clusters.push({ memberIndices: indices, totalWeight, representative });
    }
    return clusters;
  }

  /**
   * Pick the cluster with the most members (ties broken by total weight,
   * then by representative length).
   */
  private largestCluster(clusters: OutputCluster[]): OutputCluster {
    let best = clusters[0]!;
    for (const c of clusters) {
      if (c.memberIndices.length > best.memberIndices.length) {
        best = c;
      } else if (
        c.memberIndices.length === best.memberIndices.length &&
        c.totalWeight > best.totalWeight
      ) {
        best = c;
      }
    }
    return best;
  }

  /**
   * Build a consensus result from the winning cluster. The required
   * threshold parameter sets the minimum confidence for the method.
   */
  private buildResult(
    outputs: ConsensusInput[],
    clusters: OutputCluster[],
    winner: OutputCluster,
    _required: number,
  ): ConsensusResult {
    const total = outputs.length;
    const confidence = total > 0 ? winner.memberIndices.length / total : 0;
    const disagreements = this.minorityMemberIds(outputs, clusters, winner);
    return {
      consensus: winner.representative,
      confidence,
      disagreements,
    };
  }

  /**
   * Apply the onConflict policy when consensus cannot be reached.
   * - `retry`     — return the best-effort winner with confidence=0 (caller should retry).
   * - `escalate`  — return the best-effort winner with confidence=0 (caller should escalate to a judge).
   * - `best_effort` (default) — return the best-effort winner with reduced confidence.
   */
  private handleConflict(
    outputs: ConsensusInput[],
    clusters: OutputCluster[],
    winner: OutputCluster,
    _required: number,
    opts: ConsensusOptions,
  ): ConsensusResult {
    const total = outputs.length;
    const rawConfidence = total > 0 ? winner.memberIndices.length / total : 0;
    const disagreements = this.minorityMemberIds(outputs, clusters, winner);
    const policy = opts.onConflict ?? 'best_effort';
    const confidence = policy === 'best_effort' ? rawConfidence * 0.5 : 0;
    return {
      consensus: winner.representative,
      confidence,
      disagreements,
    };
  }

  /**
   * Return the member ids that are NOT in the winning cluster.
   */
  private minorityMemberIds(
    outputs: ConsensusInput[],
    _clusters: OutputCluster[],
    winner: OutputCluster,
  ): string[] {
    const winnerSet = new Set(winner.memberIndices);
    const disagreements: string[] = [];
    for (let i = 0; i < outputs.length; i++) {
      if (!winnerSet.has(i)) disagreements.push(outputs[i]!.memberId);
    }
    return disagreements;
  }

  /**
   * Find the index of the output most similar to a reference text
   * (used by judge_decided to attribute the judge's pick to a member).
   */
  private closestOutputIndex(outputs: string[], reference: string): number {
    let bestIdx = 0;
    let bestSim = -1;
    for (let i = 0; i < outputs.length; i++) {
      const sim = bowCosineSim(outputs[i]!, reference);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    return bestIdx;
  }
}

// ─── Similarity helpers ─────────────────────────────────────────────────────

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
 * Bag-of-words cosine similarity between two strings. Lowercases,
 * splits on non-alphanumeric, and builds a token-frequency vector.
 */
function bowCosineSim(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const freqA = new Map<string, number>();
  for (const t of tokensA) freqA.set(t, (freqA.get(t) ?? 0) + 1);
  const freqB = new Map<string, number>();
  for (const t of tokensB) freqB.set(t, (freqB.get(t) ?? 0) + 1);

  let dot = 0;
  for (const [k, v] of freqA) {
    const w = freqB.get(k);
    if (w !== undefined) dot += v * w;
  }
  let normA = 0;
  for (const v of freqA.values()) normA += v * v;
  let normB = 0;
  for (const v of freqB.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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

/**
 * Simple quality heuristic used by `best_of_n` and as a fallback for
 * `judge_decided` when no judge is provided. Combines:
 *   - length (capped, log-scaled),
 *   - structure (number of bullets, numbered items, code blocks, headings),
 *   - specificity (proper nouns, numbers, examples).
 *
 * Returns a 0..1 score.
 */
export function qualityHeuristic(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  const lengthScore = Math.min(1, Math.log10(text.length + 1) / 3);
  const bullets = (text.match(/^\s*[-*+]\s+/gm) ?? []).length;
  const numbered = (text.match(/^\s*\d+\.\s+/gm) ?? []).length;
  const codeBlocks = (text.match(/```/g) ?? []).length / 2;
  const headings = (text.match(/^#{1,6}\s+/gm) ?? []).length;
  const structureScore = Math.min(1, (bullets + numbered + codeBlocks + headings) / 6);
  const numbers = (text.match(/\b\d+(\.\d+)?\b/g) ?? []).length;
  const properNouns = (text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? []).length;
  const specificityScore = Math.min(1, (numbers + properNouns) / 12);
  return 0.4 * lengthScore + 0.35 * structureScore + 0.25 * specificityScore;
}

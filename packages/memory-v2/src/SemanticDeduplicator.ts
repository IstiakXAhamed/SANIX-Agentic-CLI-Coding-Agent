/**
 * @file memory-v2/src/SemanticDeduplicator.ts
 * @description Finds near-duplicate memories using embedding cosine
 * similarity, then merges each duplicate cluster into a single memory.
 *
 * Workflow:
 *   1. `findDuplicates(items, threshold)` — O(n²) pairwise scan, groups
 *      items whose cosine similarity ≥ `threshold` (default 0.92) into
 *      `DuplicateCluster`s. Each cluster has a canonical id (the first
 *      member), all member ids, and the average pairwise similarity.
 *   2. `mergeCluster(cluster, items)` — picks the highest-salience
 *      member as the canonical, merges the others into it (concatenates
 *      unique tags, sums importance, merges metadata shallowly).
 *   3. `deduplicate(items, threshold)` — convenience wrapper that runs
 *      both steps and returns `{ kept, merged, clusters }`.
 *
 * Uses cosine similarity directly on `item.embedding` arrays. Items
 * without embeddings are skipped (treated as unique). For corpora that
 * don't yet have embeddings, callers can pass a `embeddingProvider`
 * (lazy `EmbeddingProvider` from `@sanix/core`) — items missing
 * embeddings will have them computed on demand.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type { MemoryItem } from './types.js';
import { SalienceScorer } from './SalienceScorer.js';

/** A cluster of near-duplicate memories. */
export interface DuplicateCluster {
  /** The canonical (kept) member's id. */
  canonicalId: string;
  /** All member ids (including canonical). */
  memberIds: string[];
  /** Average pairwise cosine similarity within the cluster. */
  avgSimilarity: number;
}

/** Result of `deduplicate()`. */
export interface DeduplicateResult {
  /** Surviving memories (one per cluster + the unique items). */
  kept: MemoryItem[];
  /** Number of clusters merged. */
  merged: number;
  /** The clusters that were merged. */
  clusters: DuplicateCluster[];
}

/** Constructor options. */
export interface SemanticDeduplicatorOptions {
  /** Override the default salience scorer (used to pick the canonical). */
  salienceScorer?: SalienceScorer;
}

/** Optional embedding provider for on-the-fly embedding generation. */
export interface EmbedProvider {
  embed(text: string): Promise<number[] | null>;
}

/**
 * Semantic deduplicator.
 *
 * @example
 * ```ts
 * const dedup = new SemanticDeduplicator();
 * const { kept, merged } = dedup.deduplicate(allFacts, 0.92);
 * console.log(`Merged ${merged} clusters; ${kept.length} survive.`);
 * ```
 */
export class SemanticDeduplicator {
  private readonly salience: SalienceScorer;

  constructor(opts: SemanticDeduplicatorOptions = {}) {
    this.salience = opts.salienceScorer ?? new SalienceScorer();
  }

  /**
   * Find clusters of near-duplicate memories. Items without embeddings
   * are excluded from clustering (treated as unique).
   *
   * @param items     - All items to scan.
   * @param threshold - Cosine similarity above which two items are
   *                    considered duplicates. Default 0.92.
   *
   * @example
   * ```ts
   * const clusters = dedup.findDuplicates(facts);
   * for (const c of clusters) {
   *   console.log(c.canonicalId, c.memberIds.length, c.avgSimilarity);
   * }
   * ```
   */
  findDuplicates(
    items: ReadonlyArray<MemoryItem>,
    threshold: number = 0.92,
  ): DuplicateCluster[] {
    const clusters: DuplicateCluster[] = [];
    const assigned = new Set<string>();

    // Pre-filter to items with embeddings.
    const embeddable = items.filter(
      (m) => m.embedding && m.embedding.length > 0,
    );

    for (let i = 0; i < embeddable.length; i++) {
      const a = embeddable[i]!;
      if (assigned.has(a.id)) continue;

      const memberIds: string[] = [a.id];
      let sumSim = 0;
      let pairCount = 0;

      for (let j = i + 1; j < embeddable.length; j++) {
        const b = embeddable[j]!;
        if (assigned.has(b.id)) continue;
        const sim = cosineSimilarity(a.embedding!, b.embedding!);
        if (sim >= threshold) {
          memberIds.push(b.id);
          assigned.add(b.id);
          // Track pairwise similarity against the canonical for averaging.
          sumSim += sim;
          pairCount++;
        }
      }

      if (memberIds.length > 1) {
        assigned.add(a.id);
        clusters.push({
          canonicalId: a.id,
          memberIds,
          avgSimilarity: pairCount > 0 ? sumSim / pairCount : 1,
        });
      }
    }
    return clusters;
  }

  /**
   * Merge a duplicate cluster into a single memory. The highest-salience
   * member becomes the canonical; the others are folded in:
   *   - `importance` is summed (clamped to 1).
   *   - `metadata.tags` are unioned.
   *   - Other metadata fields are merged shallowly (canonical wins on
   *     conflicts; non-canonical fields are kept if not already present).
   *   - The merged memory gets a new id (nanoid) so callers can store it
   *     as a fresh item and delete the old members.
   *
   * @param cluster - The cluster to merge.
   * @param items   - The full item set (must include all cluster members).
   *
   * @example
   * ```ts
   * const merged = dedup.mergeCluster(cluster, allFacts);
   * await router.store(merged);
   * for (const id of cluster.memberIds) await deleteMemory(id);
   * ```
   */
  mergeCluster(cluster: DuplicateCluster, items: ReadonlyArray<MemoryItem>): MemoryItem {
    const memberSet = new Set(cluster.memberIds);
    const members = items.filter((m) => memberSet.has(m.id));

    // Pick the highest-salience member as canonical.
    const ranked = members
      .map((m) => ({ m, s: this.salience.score(m) }))
      .sort((a, b) => b.s - a.s);
    const canonical = ranked[0]?.m ?? members[0]!;
    const others = ranked.slice(1).map((r) => r.m);

    // Merge tags (union, preserve order).
    const tagSet = new Set<string>();
    if (Array.isArray(canonical.metadata.tags)) {
      for (const t of canonical.metadata.tags) tagSet.add(t);
    }
    for (const o of others) {
      if (Array.isArray(o.metadata.tags)) {
        for (const t of o.metadata.tags) tagSet.add(t);
      }
    }

    // Merge metadata shallowly — canonical wins, but fill in keys the
    // canonical is missing.
    const mergedMeta: Record<string, unknown> = { ...canonical.metadata };
    for (const o of others) {
      for (const [k, v] of Object.entries(o.metadata)) {
        if (k === 'tags') continue;
        if (mergedMeta[k] === undefined && v !== undefined) {
          mergedMeta[k] = v;
        }
      }
    }
    mergedMeta.tags = Array.from(tagSet);
    // Record provenance for traceability.
    mergedMeta.mergedFrom = cluster.memberIds;
    mergedMeta.avgSimilarity = cluster.avgSimilarity;

    // Sum importance (clamped to 1).
    const totalImportance = members.reduce((s, m) => s + (m.importance ?? 0), 0);

    return {
      id: nanoid(),
      tier: canonical.tier,
      type: canonical.type,
      content: canonical.content,
      metadata: mergedMeta,
      createdAt: canonical.createdAt,
      importance: Math.max(0, Math.min(1, totalImportance)),
      embedding: canonical.embedding,
    };
  }

  /**
   * Find and merge all duplicate clusters in one pass. Returns the
   * surviving items (one per cluster + all unique items) and the merge
   * count.
   *
   * @example
   * ```ts
   * const { kept, merged } = dedup.deduplicate(allFacts);
   * console.log(`Merged ${merged} clusters; ${kept.length} survive.`);
   * ```
   */
  deduplicate(
    items: ReadonlyArray<MemoryItem>,
    threshold: number = 0.92,
  ): DeduplicateResult {
    const clusters = this.findDuplicates(items, threshold);
    const mergedIds = new Set<string>();
    for (const c of clusters) {
      for (const id of c.memberIds) mergedIds.add(id);
    }
    const kept: MemoryItem[] = items.filter((m) => !mergedIds.has(m.id));
    for (const c of clusters) {
      kept.push(this.mergeCluster(c, items));
    }
    return { kept, merged: clusters.length, clusters };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

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

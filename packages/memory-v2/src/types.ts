/**
 * @file memory-v2/src/types.ts
 * @description Local type definitions for `@sanix/memory-v2`.
 *
 * These mirror the shapes used by `@sanix/core/memory` (MemoryItem,
 * MemoryTier, ScoredMemoryItem, etc.) but are defined LOCALLY here to
 * avoid a hard runtime dependency on `@sanix/core`. The `core` package
 * lists `@sanix/memory-v2` as a dependency (so it can dynamically import
 * and delegate to v2); v2 itself is self-contained and depends only on
 * zod, nanoid, eventemitter3, and better-sqlite3.
 *
 * TypeScript's structural typing means the real `MemoryItem` instances
 * produced by `@sanix/core` will satisfy these interfaces without an
 * explicit adapter. They are intentionally narrower than the core types
 * (e.g. `type: string` instead of a closed union) so v2 doesn't need to
 * know about every core sub-type.
 *
 * @packageDocumentation
 */

// ─── Memory tiers & item shape ───────────────────────────────────────────────

/**
 * The four SANIX memory tiers. Mirrors `@sanix/core/memory`'s `MemoryTier`.
 */
export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'procedural';

/**
 * Tier-specific metadata bag. Structurally compatible with
 * `@sanix/core/memory`'s `MemoryMetadata`. V2 reads several well-known
 * keys (`lastAccessedAt`, `stability`, `recallCount`, `outcome`, `isError`)
 * that other v2 modules populate; everything else is opaque.
 */
export interface MemoryMetadata {
  /** Project identifier (episodic scoping). */
  project?: string;
  /** Task type this item relates to. */
  taskType?: string;
  /** Tool name this item relates to (procedural). */
  toolName?: string;
  /** Source session id. */
  sessionId?: string;
  /** Source file path. */
  filePath?: string;
  /** Confidence score 0..1. */
  confidence?: number;
  /** Tags for free-form categorization. */
  tags?: string[];
  /**
   * Epoch ms of last access (used by ForgettingCurve). V2 sets this when
   * a memory is recalled; if absent, v2 falls back to `createdAt`.
   */
  lastAccessedAt?: number;
  /**
   * Memory stability in epoch-ms units (used by ForgettingCurve). Higher
   * = slower decay. Default for new items is 24h.
   */
  stability?: number;
  /** Number of times this memory has been recalled. */
  recallCount?: number;
  /** Outcome of the most recent access. */
  outcome?: 'success' | 'failure' | 'neutral';
  /** True if this memory originated from an error / failure path. */
  isError?: boolean;
  /** Arbitrary extension fields. */
  [key: string]: unknown;
}

/**
 * The canonical memory item shape. Structurally compatible with
 * `@sanix/core/memory`'s `MemoryItem`.
 */
export interface MemoryItem {
  /** Unique id (nanoid). */
  id: string;
  /** Tier this item lives in. */
  tier: MemoryTier;
  /** Sub-type within the tier (open union — v2 doesn't care about specifics). */
  type: string;
  /** Primary content (text). */
  content: string;
  /** Tier-specific metadata. */
  metadata: MemoryMetadata;
  /** ISO timestamp the item was created. */
  createdAt: string;
  /** Importance score 0..1 (used in ranking / salience). */
  importance: number;
  /** Optional pre-computed embedding vector. */
  embedding?: number[];
}

/**
 * A recall query. Subset of `@sanix/core/memory`'s `RecallQuery` — v2 only
 * cares about the fields it uses.
 */
export interface RecallQuery {
  query: string;
  queryEmbedding?: number[];
  tier?: MemoryTier;
  limit?: number;
  minRelevance?: number;
  [key: string]: unknown;
}

/**
 * A memory item annotated with its computed relevance score. Structurally
 * compatible with `@sanix/core/memory`'s `ScoredMemoryItem`.
 */
export interface ScoredMemoryItem {
  item: MemoryItem;
  score: number;
  tier: MemoryTier;
  explanation?: string;
}

// ─── Minimal router view ─────────────────────────────────────────────────────

/**
 * Minimal view of a per-tier memory store. V2 only needs `recall`,
 * `store`, and an enumeration hook. Each tier satisfies a slightly
 * different enumeration shape (working: `all()`, episodic: `recallRaw()`,
 * procedural: `list()`).
 */
export interface TierLike {
  readonly tier: MemoryTier;
  recall(query: RecallQuery): Promise<ScoredMemoryItem[]>;
  store(item: MemoryItem): Promise<void>;
}

/**
 * Minimal view of the working tier — exposes `all()` for enumeration.
 */
export interface WorkingTierLike extends TierLike {
  all(): MemoryItem[];
}

/**
 * Minimal view of the episodic tier — exposes `recallRaw()` and `prune()`.
 */
export interface EpisodicTierLike extends TierLike {
  recallRaw(opts?: {
    project?: string;
    since?: string;
    until?: string;
    successOnly?: boolean;
    failureOnly?: boolean;
    limit?: number;
  }): Array<{
    id: string;
    goal: string;
    planJson: string;
    startedAt: string;
    endedAt: string | null;
    success: boolean;
    lessonsJson: string;
    project?: string;
    embedding?: number[];
  }>;
  prune(olderThanDays: number): Promise<number>;
}

/**
 * Minimal view of the semantic tier — exposes `deleteWhere()` and
 * `available()` and `count()`.
 */
export interface SemanticTierLike extends TierLike {
  available(): Promise<boolean>;
  deleteWhere(predicate: string): Promise<number>;
  count(): Promise<number>;
}

/**
 * Minimal view of the procedural tier — exposes `list()` and `delete()`.
 */
export interface ProceduralTierLike extends TierLike {
  list(taskType?: string): MemoryItem[];
  delete(id: string): boolean;
}

/**
 * Minimal view of the `MemoryRouter` from `@sanix/core`. V2 needs to read
 * each tier, store promoted items, and recall from each tier to find
 * existing-fact context. The real `MemoryRouter` structurally satisfies
 * this interface.
 */
export interface MemoryRouterLike {
  readonly working: WorkingTierLike;
  readonly episodic: EpisodicTierLike;
  readonly semantic: SemanticTierLike;
  readonly procedural: ProceduralTierLike;
  store(item: MemoryItem): Promise<void>;
  recall(query: RecallQuery): Promise<ScoredMemoryItem[]>;
}

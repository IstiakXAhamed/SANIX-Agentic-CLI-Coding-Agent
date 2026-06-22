/**
 * @file memory/types.ts
 * @description Shared types for the 4-tier SANIX memory system. All memory
 * tiers (Working, Episodic, Semantic, Procedural) operate on `MemoryItem`-
 * shaped data and answer `RecallQuery` requests via the `MemoryRouter`.
 *
 * @packageDocumentation
 */

// ─── Memory tiers & types ───────────────────────────────────────────────────

/**
 * The four memory tiers. Mirrors spec §3:
 *   - `working`    — RAM-speed, session-only (sliding window of messages)
 *   - `episodic`   — past session summaries (SQLite + embeddings)
 *   - `semantic`   — facts / knowledge / patterns (LanceDB vector store)
 *   - `procedural` — learned prompt templates & tool-usage patterns (JSON)
 */
export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'procedural';

/**
 * Sub-classification within a tier. `MemoryRouter.store` dispatches by
 * `type`; the corresponding tier persists the item.
 */
export type MemoryType =
  // working
  | 'message'
  | 'action'
  | 'observation'
  // episodic
  | 'session_summary'
  | 'session_outcome'
  | 'lesson'
  // semantic
  | 'fact'
  | 'code_pattern'
  | 'api_knowledge'
  | 'doc_chunk'
  // procedural
  | 'prompt_template'
  | 'tool_pattern'
  | 'task_strategy';

/**
 * Metadata bag attached to every memory item. Tier-specific fields live here
 * (e.g. `project` for episodic scoping, `taskType` for procedural lookup).
 */
export interface MemoryMetadata {
  /** Project identifier (episodic scoping). */
  project?: string;
  /** Task type this item relates to (procedural / semantic lookup). */
  taskType?: string;
  /** Tool name this item relates to (procedural). */
  toolName?: string;
  /** Source session id (episodic lineage). */
  sessionId?: string;
  /** Source file path (semantic doc chunks). */
  filePath?: string;
  /** Confidence score 0..1 (procedural / semantic). */
  confidence?: number;
  /** Tags for free-form categorization. */
  tags?: string[];
  /** Arbitrary extension fields. */
  [key: string]: unknown;
}

/**
 * The canonical memory item shape. Every tier's `store()` accepts a subset
 * of these fields; `recall()` returns arrays of `MemoryItem` for the
 * `MemoryRouter` to rank-and-merge.
 */
export interface MemoryItem {
  /** Unique id (nanoid). */
  id: string;
  /** Tier this item lives in. */
  tier: MemoryTier;
  /** Sub-type within the tier. */
  type: MemoryType;
  /** Primary content (text). */
  content: string;
  /** Tier-specific metadata. */
  metadata: MemoryMetadata;
  /** ISO timestamp the item was created. */
  createdAt: string;
  /** Importance score 0..1 (used in ranking). */
  importance: number;
  /** Optional pre-computed embedding vector (384-d for MiniLM). */
  embedding?: number[];
}

/**
 * A recall request. All fields are optional except `query` (the natural-
 * language or keyword probe). The router fans this out to all tiers in
 * parallel and merges results.
 */
export interface RecallQuery {
  /** The natural-language or keyword probe. */
  query: string;
  /** Optional pre-computed embedding of the query (avoids re-embedding per tier). */
  queryEmbedding?: number[];
  /** Tier to restrict recall to (default: all tiers). */
  tier?: MemoryTier;
  /** Sub-type to restrict recall to. */
  type?: MemoryType;
  /** Project scope (episodic). */
  project?: string;
  /** Time range lower bound (ISO). */
  since?: string;
  /** Time range upper bound (ISO). */
  until?: string;
  /** Filter to successful sessions only (episodic). */
  successOnly?: boolean;
  /** Filter to failed sessions only (episodic). */
  failureOnly?: boolean;
  /** Maximum results to return (per tier, before merge). */
  limit?: number;
  /** Minimum relevance score 0..1 to include in results. */
  minRelevance?: number;
}

/**
 * A memory item annotated with its computed relevance score. This is what
 * `recall()` returns — callers see both the item and why it was selected.
 */
export interface ScoredMemoryItem {
  /** The memory item. */
  item: MemoryItem;
  /** Cosine / BM25 / recency-blended relevance score, 0..1. */
  score: number;
  /** Which tier contributed this result. */
  tier: MemoryTier;
  /** Optional human-readable explanation of the score. */
  explanation?: string;
}

/**
 * Per-tier memory interface. Every concrete tier implements this so the
 * `MemoryRouter` can treat them uniformly.
 */
export interface IMemoryTier {
  /** The tier this implementation handles. */
  readonly tier: MemoryTier;
  /** Persist a memory item. */
  store(item: MemoryItem): Promise<void>;
  /** Recall items matching the query. */
  recall(query: RecallQuery): Promise<ScoredMemoryItem[]>;
}

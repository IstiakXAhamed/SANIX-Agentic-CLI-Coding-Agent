/**
 * @file memory/MemoryRouter.ts
 * @description Top-level memory facade. Dispatches `store(item)` to the
 * correct tier and parallel-recalls from all tiers, then ranks + merges.
 *
 * Per spec §3:
 *   - `store(item)` switches on `item.type` → routes to Working / Episodic /
 *     Semantic / Procedural.
 *   - `recall(query)` issues parallel recalls from all tiers and merges by
 *     `score` (already tier-normalized) plus a recency bump.
 *
 * The router also exposes `mergeSubAgentResult(report)` so the
 * SubAgentManager can fold a sub-agent's learned facts back into the
 * parent's memory.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import { nanoid } from 'nanoid';
import type {
  IMemoryTier,
  MemoryItem,
  MemoryTier,
  RecallQuery,
  ScoredMemoryItem,
} from './types.js';
import { WorkingMemory } from './WorkingMemory.js';
import { EpisodicMemory } from './EpisodicMemory.js';
import { SemanticMemory } from './SemanticMemory.js';
import { ProceduralMemory } from './ProceduralMemory.js';
import { EmbeddingProvider } from './EmbeddingProvider.js';
import type { AgentReport } from '../agent/types.js';

/**
 * Events emitted by the MemoryRouter.
 */
export interface MemoryRouterEvents {
  /** Fired when an item is stored. */
  store: { item: MemoryItem; tier: MemoryTier };
  /** Fired when a recall completes (all tiers merged). */
  recall: { query: RecallQuery; results: ScoredMemoryItem[] };
  /** Fired when a sub-agent's results are merged. */
  'subagent:merged': { agentId: string; factsAdded: number };
}

/**
 * Options for {@link MemoryRouter.constructor}.
 */
export interface MemoryRouterOptions {
  /** Pre-constructed working memory tier (else default config is used). */
  working?: WorkingMemory;
  /** Pre-constructed episodic memory tier. */
  episodic?: EpisodicMemory;
  /** Pre-constructed semantic memory tier. */
  semantic?: SemanticMemory;
  /** Pre-constructed procedural memory tier. */
  procedural?: ProceduralMemory;
  /** Working-memory window size (only used if `working` not provided). */
  workingWindowSize?: number;
  /**
   * Optional unified index manager (`@sanix/memory-v2`'s
   * `MemoryIndexManager` or any structurally-compatible object). When
   * set, {@link MemoryRouter.recall} uses it instead of parallel tier
   * recall (faster — O(log N) HNSW + FTS5 hybrid vs. per-tier scan),
   * and {@link MemoryRouter.store} indexes into it on every store.
   *
   * Opt-in: existing callers that don't set this see identical behavior
   * to before (parallel tier recall).
   */
  indexManager?: MemoryIndexManagerLike;
}

/**
 * Minimal structural interface for the optional unified index manager.
 * Satisfied by `@sanix/memory-v2`'s `MemoryIndexManager` (and by any
 * test double that implements these methods). Defined locally to avoid
 * a hard type dependency on `@sanix/memory-v2` from callers that don't
 * use the v2 features.
 */
export interface MemoryIndexManagerLike {
  /** Index a memory item with its pre-computed embedding. */
  index(memory: MemoryItem, embedding: Float32Array): void;
  /** Remove a memory from the index. */
  unindex(memoryId: string): void;
  /**
   * Hybrid vector + keyword search across all indexed memories.
   * Returns `ScoredMemoryItem[]` ranked by `0.6 * cosine + 0.4 * bm25`.
   */
  search(
    query: string,
    opts?: {
      vector?: Float32Array | number[];
      k?: number;
      minScore?: number;
      tier?: MemoryTier;
    },
  ): Promise<ScoredMemoryItem[]>;
  /** Number of items currently indexed. */
  size(): number;
}

/**
 * The 4-tier hierarchical memory router.
 *
 * @example
 * ```ts
 * const router = new MemoryRouter({ workingWindowSize: 40 });
 * await router.store({
 *   id: nanoid(),
 *   tier: 'semantic',
 *   type: 'fact',
 *   content: 'SANIX uses 4 memory tiers.',
 *   metadata: {},
 *   createdAt: new Date().toISOString(),
 *   importance: 0.8,
 * });
 * const hits = await router.recall({ query: 'memory tiers' });
 * ```
 */
export class MemoryRouter extends EventEmitter<MemoryRouterEvents> {
  readonly working: WorkingMemory;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly procedural: ProceduralMemory;
  private readonly embeddingProvider: EmbeddingProvider;
  /**
   * Optional unified index manager (v2). When set, `recall()` uses it
   * instead of parallel tier recall, and `store()` indexes into it.
   */
  readonly indexManager?: MemoryIndexManagerLike;

  constructor(opts: MemoryRouterOptions = {}) {
    super();
    this.working = opts.working ?? new WorkingMemory({ windowSize: opts.workingWindowSize });
    this.episodic = opts.episodic ?? new EpisodicMemory();
    this.semantic = opts.semantic ?? new SemanticMemory();
    this.procedural = opts.procedural ?? new ProceduralMemory();
    this.embeddingProvider = EmbeddingProvider.getInstance();
    this.indexManager = opts.indexManager;
  }

  /**
   * Tier map for dispatch / parallel recall.
   */
  private tierMap(): Record<MemoryTier, IMemoryTier> {
    return {
      working: this.working,
      episodic: this.episodic,
      semantic: this.semantic,
      procedural: this.procedural,
    };
  }

  /**
   * Store a memory item in its target tier. Emits a `store` event.
   *
   * If the item's `tier` doesn't match its `type`'s canonical tier, the
   * router infers the tier from `type` (e.g. `fact` → `semantic`).
   *
   * If an `indexManager` (v2) is configured, the item is also indexed
   * there (using its `embedding` if present) so future `recall()` calls
   * can find it via the unified hybrid index.
   */
  async store(item: MemoryItem): Promise<void> {
    const tier = this.tierForType(item.type) ?? item.tier;
    const normalized: MemoryItem = { ...item, tier };
    const tiers = this.tierMap();
    const target = tiers[tier];
    if (!target) return;
    try {
      await target.store(normalized);
      this.emit('store', { item: normalized, tier });
    } catch (err) {
      // Tier storage failures are non-fatal — log and continue. The agent
      // should not abort a session because episodic memory was unavailable.
      const msg = err instanceof Error ? err.message : String(err);
      void msg;
    }
    // Index into the v2 unified index (if configured).
    if (this.indexManager && normalized.embedding && normalized.embedding.length > 0) {
      try {
        this.indexManager.index(normalized, new Float32Array(normalized.embedding));
      } catch (err) {
        // Index failures are non-fatal — recall can still fall back to
        // the parallel tier scan.
        const msg = err instanceof Error ? err.message : String(err);
        void msg;
      }
    }
  }

  /**
   * Recall items from all tiers in parallel, then rank and merge. The query
   * embedding is computed once and shared across tiers (avoids re-embedding).
   *
   * Merging: items are sorted by their per-tier score (already 0..1
   * normalized), with a small recency bump (`+0.05 * recencyDecay`).
   * Duplicate items (same id across tiers — shouldn't happen but defensive)
   * are de-duplicated.
   *
   * If a `MemoryIndexManager` (v2) is configured, the unified hybrid
   * index is used instead of parallel tier recall — O(log N) vs.
   * per-tier scan. The query embedding is still computed once and
   * passed in as `opts.vector` for the HNSW arm.
   *
   * @example
   * ```ts
   * const hits = await router.recall({ query: 'auth jwt', limit: 10 });
   * for (const h of hits) console.log(h.tier, h.score, h.item.content);
   * ```
   */
  async recall(query: RecallQuery): Promise<ScoredMemoryItem[]> {
    // Compute query embedding once (shared across tiers / index manager).
    let queryEmbedding = query.queryEmbedding;
    if (!queryEmbedding && (await this.embeddingProvider.available())) {
      queryEmbedding = (await this.embeddingProvider.embed(query.query)) ?? undefined;
    }
    const fullQuery: RecallQuery = { ...query, queryEmbedding };

    // ── Fast path: unified index manager (v2). ──
    if (this.indexManager) {
      try {
        const results = await this.indexManager.search(query.query, {
          vector: queryEmbedding ? new Float32Array(queryEmbedding) : undefined,
          k: query.limit ?? 20,
          minScore: query.minRelevance ?? 0,
          tier: query.tier,
        });
        // Apply the same recency bump as the slow path for consistency.
        const now = Date.now();
        const bumped = results.map((s) => {
          const ageDays =
            (now - new Date(s.item.createdAt).getTime()) / 86_400_000;
          const recency = Math.max(0, 1 - ageDays / 90);
          return { ...s, score: s.score + 0.05 * recency };
        });
        const sorted = bumped.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 20);
        this.emit('recall', { query, results: sorted });
        return sorted;
      } catch (err) {
        // Index failures are non-fatal — fall through to the slow path.
        const msg = err instanceof Error ? err.message : String(err);
        void msg;
      }
    }

    // ── Slow path: parallel tier recall. ──
    const tiers = this.tierMap();
    const tierList = query.tier ? [tiers[query.tier]] : Object.values(tiers);

    const results = await Promise.all(
      tierList.map(async (tier) => {
        try {
          return await tier.recall(fullQuery);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void msg;
          return [];
        }
      }),
    );

    const all = results.flat();

    // De-duplicate by id.
    const seen = new Set<string>();
    const deduped = all.filter((s) => {
      if (seen.has(s.item.id)) return false;
      seen.add(s.item.id);
      return true;
    });

    // Recency bump.
    const now = Date.now();
    const scored = deduped.map((s) => {
      const ageDays =
        (now - new Date(s.item.createdAt).getTime()) / 86_400_000;
      const recency = Math.max(0, 1 - ageDays / 90);
      return { ...s, score: s.score + 0.05 * recency };
    });

    const sorted = scored.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 20);
    this.emit('recall', { query, results: sorted });
    return sorted;
  }

  /**
   * Merge a sub-agent's report back into the parent's memory. Stores each
   * learned fact as a semantic memory item.
   *
   * @param report - The sub-agent's report (from SubAgentManager.receiveReport).
   * @returns The number of facts actually stored.
   */
  async mergeSubAgentResult(report: AgentReport): Promise<number> {
    let added = 0;
    for (const fact of report.result.learnedFacts) {
      try {
        await this.store({
          id: nanoid(),
          tier: 'semantic',
          type: 'fact',
          content: fact,
          metadata: {
            sessionId: report.agentId,
            subAgent: report.agentId,
            confidence: report.result.success ? 0.7 : 0.3,
            tags: ['sub-agent', report.task.type],
          },
          createdAt: new Date().toISOString(),
          importance: report.result.success ? 0.7 : 0.3,
        });
        added++;
      } catch {
        // Non-fatal — continue merging the rest.
      }
    }
    this.emit('subagent:merged', { agentId: report.agentId, factsAdded: added });
    return added;
  }

  /**
   * Persist the agent's session as an episodic memory record. Called by the
   * AgentLoop at the end of `run()`.
   */
  async persistSession(session: {
    id?: string;
    goal: string;
    planJson: string;
    startedAt: string;
    endedAt: string;
    success: boolean;
    lessons: string[];
    project?: string;
  }): Promise<void> {
    try {
      await this.episodic.storeSession({
        id: session.id ?? nanoid(),
        goal: session.goal,
        planJson: session.planJson,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        success: session.success,
        lessonsJson: JSON.stringify(session.lessons),
        project: session.project,
      });
    } catch (err) {
      // Non-fatal — agent should not fail because episodic persistence failed.
      const msg = err instanceof Error ? err.message : String(err);
      void msg;
    }
  }

  /**
   * Close any open handles (SQLite, LanceDB). Safe to call multiple times.
   */
  close(): void {
    this.episodic.close();
  }

  /**
   * Map a MemoryType to its canonical tier. Used when an item's `tier`
   * field is missing or doesn't match its `type`.
   *
   * @example
   * ```ts
   * tierForType('fact');           // 'semantic'
   * tierForType('session_summary'); // 'episodic'
   * tierForType('prompt_template'); // 'procedural'
   * ```
   */
  private tierForType(type: MemoryItem['type']): MemoryTier | null {
    switch (type) {
      case 'message':
      case 'action':
      case 'observation':
        return 'working';
      case 'session_summary':
      case 'session_outcome':
      case 'lesson':
        return 'episodic';
      case 'fact':
      case 'code_pattern':
      case 'api_knowledge':
      case 'doc_chunk':
        return 'semantic';
      case 'prompt_template':
      case 'tool_pattern':
      case 'task_strategy':
        return 'procedural';
      default:
        return null;
    }
  }
}

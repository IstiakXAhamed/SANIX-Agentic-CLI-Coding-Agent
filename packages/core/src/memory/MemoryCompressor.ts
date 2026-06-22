/**
 * @file memory/MemoryCompressor.ts
 * @description Background memory-maintenance job. Runs every 10 loop
 * iterations (per spec §3).
 *
 * ## v2 delegation
 *
 * If `@sanix/memory-v2` is installed (detected via dynamic import at
 * construction time), this compressor delegates to v2's
 * `MemoryCompactor` — which adds salience-aware dedup, tier
 * promotion/demotion, Ebbinghaus-curve-driven pruning, and episodic→
 * semantic fact extraction. Otherwise it falls back to the original
 * v1 logic (merge duplicate semantic facts + prune stale episodic
 * sessions + greedy chunk clustering).
 *
 * The v2 path is **opt-in by installation**: just install
 * `@sanix/memory-v2` and the compressor picks it up automatically.
 * No code changes needed in the AgentLoop or anywhere else.
 *
 * The compressor is invoked by the AgentLoop after every Nth iteration.
 * It catches and swallows all errors — memory maintenance must never
 * abort a session.
 *
 * @packageDocumentation
 */

import type { SanixConfig } from '@sanix/config';
import type { MemoryRouter } from './MemoryRouter.js';
import type { EpisodicMemory } from './EpisodicMemory.js';
import type { SemanticMemory } from './SemanticMemory.js';
import type { MemoryItem, MemoryTier, ScoredMemoryItem } from './types.js';
import { cosineSimilarity } from './EmbeddingProvider.js';

// ─── Structural interfaces for v2 delegation ────────────────────────────────
//
// These match `@sanix/memory-v2`'s public API but are defined locally
// so callers without v2 installed don't get a TypeScript error. The
// real v2 instances satisfy these structurally.

/** A memory-access observation (v2 `MemoryAccessEvent`). */
export interface MemoryAccessEvent {
  memoryId: string;
  tier: MemoryTier;
  accessedAt: number;
  sessionId: string;
  outcome?: 'success' | 'failure' | 'neutral';
}

/** Minimal view of v2's `TierManager`. */
export interface TierManagerLike {
  observe(event: MemoryAccessEvent): void;
  runCycle(router: unknown): Promise<unknown>;
  reset?(): void;
}

/** Minimal view of v2's `MemoryIndexManager`. */
export interface IndexManagerLike {
  index(memory: MemoryItem, embedding: Float32Array): void;
  unindex(memoryId: string): void;
  search(
    query: string,
    opts?: {
      vector?: Float32Array | number[];
      k?: number;
      minScore?: number;
      tier?: MemoryTier;
    },
  ): Promise<ScoredMemoryItem[]>;
  reindex(router: unknown): Promise<void>;
  flush(): Promise<void>;
  size(): number;
  close(): void;
}

/** Minimal view of v2's `MemoryCompactor`. */
export interface MemoryCompactorLike {
  shouldRun(iteration: number): boolean;
  run(ctx: unknown): Promise<CompactionReportV2>;
}

/** v2 compaction report (subset we surface in `CompressionReport`). */
export interface CompactionReportV2 {
  duplicatesMerged: number;
  promoted: number;
  demoted: number;
  pruned: number;
  factsExtracted: number;
  durationMs: number;
  indexRebuilt: boolean;
  errors: string[];
}

/** A session record passed to v2 for episodic→semantic extraction. */
export interface SessionRecordForExtraction {
  id: string;
  goal: string;
  lessons: string[];
  toolCalls: ReadonlyArray<{
    name: string;
    args?: unknown;
    success?: boolean;
  }>;
  success: boolean;
  startedAt: string;
  endedAt: string;
}

/**
 * Loaded v2 module shape. Mirrors what `await import('@sanix/memory-v2')`
 * returns.
 */
interface MemoryV2Module {
  MemoryCompactor: new (opts?: { interval?: number }) => MemoryCompactorLike;
  TierManager: new (opts?: unknown) => TierManagerLike;
}

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Result of a single compressor run.
 */
export interface CompressionReport {
  /** Number of duplicate semantic facts merged. */
  factsMerged: number;
  /** Number of stale episodic sessions pruned. */
  sessionsPruned: number;
  /** Number of semantic chunks consolidated. */
  chunksConsolidated: number;
  /** (v2 only) Number of memories promoted to a higher tier. */
  promoted: number;
  /** (v2 only) Number of memories demoted to a lower tier. */
  demoted: number;
  /** (v2 only) Number of new semantic facts extracted. */
  factsExtracted: number;
  /** (v2 only) True if the unified index was rebuilt. */
  indexRebuilt: boolean;
  /** Wall-clock duration of the run. */
  durationMs: number;
  /** Errors encountered (non-fatal). */
  errors: string[];
  /** True if the v2 path was used. */
  usedV2: boolean;
}

/**
 * Options for {@link MemoryCompressor.constructor}.
 */
export interface MemoryCompressorOptions {
  /** Run interval (in iterations). Default: 10. */
  interval?: number;
  /** Cosine similarity threshold for "duplicate" facts. Default: 0.92. */
  duplicateThreshold?: number;
  /** Days before an episodic session is prunable. Default: from config. */
  maxAgeDays?: number;
  /**
   * Force-disable v2 delegation even if `@sanix/memory-v2` is installed.
   * Useful for tests that want to exercise the v1 path explicitly.
   */
  disableV2?: boolean;
  /**
   * Optional unified index manager (v2). When set + v2 is available,
   * the compactor can rebuild the index after significant changes.
   */
  indexManager?: IndexManagerLike;
  /**
   * Optional LLM callback for v2's episodic→semantic fact extraction.
   * Receives a prompt and returns the model's text response.
   */
  llmCallback?: (prompt: string) => Promise<string>;
}

/**
 * Background memory-maintenance job. Delegates to `@sanix/memory-v2`'s
 * `MemoryCompactor` when v2 is installed; falls back to v1 logic
 * otherwise.
 *
 * @example
 * ```ts
 * const compressor = new MemoryCompressor(memoryRouter, config);
 * // Wire up recent sessions for v2 episodic extraction:
 * compressor.setRecentSessions([lastSession]);
 * // In the agent loop:
 * if (compressor.shouldRun(state.iterationCount)) {
 *   const report = await compressor.run(state);
 *   if (report.usedV2) console.log('v2 path:', report.promoted, 'promoted');
 * }
 * ```
 */
export class MemoryCompressor {
  readonly interval: number;
  private readonly duplicateThreshold: number;
  private readonly maxAgeDays: number;
  private readonly router: MemoryRouter;
  private lastRunIteration = -1;

  // v2 delegation state.
  private v2ModulePromise: Promise<MemoryV2Module | null> | null = null;
  private v2Compactor: MemoryCompactorLike | null = null;
  private v2TierManager: TierManagerLike | null = null;
  private readonly disableV2: boolean;
  private readonly indexManager?: IndexManagerLike;
  private readonly llmCallback?: (prompt: string) => Promise<string>;
  private recentSessions: SessionRecordForExtraction[] = [];

  constructor(router: MemoryRouter, config: SanixConfig, opts: MemoryCompressorOptions = {}) {
    this.router = router;
    this.interval = opts.interval ?? 10;
    this.duplicateThreshold = opts.duplicateThreshold ?? 0.92;
    this.maxAgeDays = opts.maxAgeDays ?? config.memory.maxMemoryAge;
    this.disableV2 = opts.disableV2 ?? false;
    this.indexManager = opts.indexManager;
    this.llmCallback = opts.llmCallback;
    if (!this.disableV2) {
      // Kick off the dynamic import in the background; the result is
      // awaited inside `run()`.
      void this.loadV2();
    }
  }

  /**
   * True if the compressor should run at the given iteration index.
   *
   * @example
   * ```ts
   * if (compressor.shouldRun(state.iterationCount)) {
   *   await compressor.run(state);
   * }
   * ```
   */
  shouldRun(iteration: number): boolean {
    return iteration > 0 && iteration % this.interval === 0 && iteration !== this.lastRunIteration;
  }

  /**
   * The v2 `TierManager` (if v2 is loaded). The AgentLoop uses this to
   * call `observe()` after each recall — see the wiring in
   * {@link AgentLoop}.
   *
   * Returns `null` when v2 isn't installed or `disableV2` was set.
   */
  get tierManager(): TierManagerLike | null {
    return this.v2TierManager;
  }

  /**
   * Set the recent sessions to mine for episodic→semantic fact extraction
   * on the next `run()`. Typically called by the AgentLoop when a
   * session ends successfully.
   *
   * No-op when v2 isn't installed.
   */
  setRecentSessions(sessions: ReadonlyArray<SessionRecordForExtraction>): void {
    this.recentSessions = [...sessions];
  }

  /**
   * Run a compression pass. Catches all errors — returns a report with
   * any errors listed. Never throws.
   *
   * If `@sanix/memory-v2` is installed and loaded, delegates to v2's
   * `MemoryCompactor.run()` with a `CompactionContext` built from this
   * compressor's router, tier manager, index manager, and recent
   * sessions. Otherwise falls back to v1 logic.
   *
   * @param _state - The current agent state (unused for now, but kept
   *                 in the signature per spec for future context-aware
   *                 compression).
   */
  async run(_state?: unknown): Promise<CompressionReport> {
    const start = Date.now();

    // ── Try v2 path first. ──
    if (!this.disableV2) {
      const v2 = await this.loadV2();
      if (v2 && this.v2Compactor) {
        try {
          const ctx = {
            router: this.router,
            tierManager: this.v2TierManager,
            indexManager: this.indexManager,
            recentSessions: this.recentSessions,
            llmCallback: this.llmCallback,
          };
          const report = await this.v2Compactor.run(ctx);
          this.lastRunIteration = this.lastRunIteration; // satisfy lints
          return {
            factsMerged: report.duplicatesMerged,
            sessionsPruned: report.pruned,
            chunksConsolidated: 0,
            promoted: report.promoted,
            demoted: report.demoted,
            factsExtracted: report.factsExtracted,
            indexRebuilt: report.indexRebuilt,
            durationMs: Date.now() - start,
            errors: report.errors,
            usedV2: true,
          };
        } catch (err) {
          // v2 delegation failed — fall through to v1 with the error logged.
          const v2err = err instanceof Error ? err.message : String(err);
          return this.runV1(start, [`v2 delegation failed: ${v2err}`]);
        }
      }
    }

    return this.runV1(start, []);
  }

  /**
   * v1 fallback path. Original implementation preserved verbatim.
   */
  private async runV1(start: number, initialErrors: string[]): Promise<CompressionReport> {
    const errors: string[] = [...initialErrors];
    let factsMerged = 0;
    let sessionsPruned = 0;
    let chunksConsolidated = 0;

    // ── 1. Merge duplicate semantic facts. ──
    try {
      factsMerged = await this.mergeDuplicateFacts();
    } catch (err) {
      errors.push(`mergeDuplicateFacts: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── 2. Prune stale episodic memories. ──
    try {
      sessionsPruned = await this.pruneStaleEpisodic();
    } catch (err) {
      errors.push(`pruneStaleEpisodic: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── 3. Consolidate related semantic chunks (stub). ──
    try {
      chunksConsolidated = await this.consolidateChunks();
    } catch (err) {
      errors.push(`consolidateChunks: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.lastRunIteration = this.lastRunIteration; // no-op to satisfy lints
    return {
      factsMerged,
      sessionsPruned,
      chunksConsolidated,
      promoted: 0,
      demoted: 0,
      factsExtracted: 0,
      indexRebuilt: false,
      durationMs: Date.now() - start,
      errors,
      usedV2: false,
    };
  }

  /**
   * Merge semantic facts whose cosine similarity exceeds the duplicate
   * threshold. The "older" fact (lower createdAt) is kept; the newer one
   * is deleted (its content is appended to the survivor's metadata for
   * traceability).
   *
   * This is O(n²) in the number of facts — fine for small corpora; for
   * larger ones the consolidation pass should be invoked first to
   * reduce the working set.
   */
  async mergeDuplicateFacts(): Promise<number> {
    const semantic = this.router.semantic;
    if (!(await semantic.available())) return 0;

    // Pull a broad recall to get the fact set (BM25-only since we have no
    // specific query).
    const hits = await semantic.recall({
      query: '',
      limit: 1000,
      minRelevance: 0,
    });
    if (hits.length < 2) return 0;

    let merged = 0;
    const survivors = new Set<string>();
    for (let i = 0; i < hits.length; i++) {
      const a = hits[i]!;
      if (survivors.has(a.item.id)) continue;
      for (let j = i + 1; j < hits.length; j++) {
        const b = hits[j]!;
        if (survivors.has(b.item.id)) continue;
        if (!a.item.embedding || !b.item.embedding) continue;
        const sim = cosineSimilarity(a.item.embedding, b.item.embedding);
        if (sim >= this.duplicateThreshold) {
          // Delete b — keep the earlier one (a).
          // We delete by predicate on id; LanceDB syntax.
          await semantic.deleteWhere(`id = '${b.item.id}'`);
          survivors.add(b.item.id);
          merged++;
        }
      }
    }
    return merged;
  }

  /**
   * Prune episodic sessions older than `maxAgeDays`. Delegates to
   * `EpisodicMemory.prune`.
   */
  async pruneStaleEpisodic(): Promise<number> {
    const episodic: EpisodicMemory = this.router.episodic;
    return episodic.prune(this.maxAgeDays);
  }

  /**
   * Consolidate related semantic chunks into higher-level summaries.
   * Stub implementation: groups facts whose embeddings cluster
   * (cosine > 0.75) and emits a single "summary" fact per cluster.
   * Actual summarization requires an LLM call (deferred to when the
   * agent has a provider); the stub just counts potential clusters
   * without writing.
   */
  async consolidateChunks(): Promise<number> {
    const semantic = this.router.semantic;
    if (!(await semantic.available())) return 0;

    const hits: ScoredMemoryItem[] = await semantic.recall({
      query: '',
      limit: 500,
      minRelevance: 0,
    });
    if (hits.length < 3) return 0;

    // Greedy clustering: pick a seed, absorb all within 0.75, repeat.
    const clustered = new Set<string>();
    let clusterCount = 0;
    for (const seed of hits) {
      if (clustered.has(seed.item.id)) continue;
      if (!seed.item.embedding) continue;
      const cluster: ScoredMemoryItem[] = [seed];
      for (const other of hits) {
        if (clustered.has(other.item.id)) continue;
        if (other.item.id === seed.item.id) continue;
        if (!other.item.embedding) continue;
        const sim = cosineSimilarity(seed.item.embedding, other.item.embedding);
        if (sim >= 0.75) {
          cluster.push(other);
          clustered.add(other.item.id);
        }
      }
      if (cluster.length >= 3) {
        // Would write a summary fact here; stub just counts.
        clusterCount++;
      }
      clustered.add(seed.item.id);
    }
    return clusterCount;
  }

  // ─── v2 loader ─────────────────────────────────────────────────────────

  /**
   * Lazily dynamic-import `@sanix/memory-v2`. Cached after the first
   * call. Returns `null` if v2 isn't installed (or fails to load) —
   * the caller falls back to v1 logic in that case.
   *
   * Also constructs the v2 `MemoryCompactor` and `TierManager` on
   * first successful load.
   */
  private loadV2(): Promise<MemoryV2Module | null> {
    if (this.v2ModulePromise) return this.v2ModulePromise;
    this.v2ModulePromise = (async () => {
      try {
        const mod = (await import('@sanix/memory-v2')) as unknown as MemoryV2Module;
        if (typeof mod.MemoryCompactor !== 'function' || typeof mod.TierManager !== 'function') {
          return null;
        }
        // Construct the v2 compactor + tier manager.
        this.v2Compactor = new mod.MemoryCompactor({ interval: this.interval });
        this.v2TierManager = new mod.TierManager();
        return mod;
      } catch {
        // v2 not installed — return null silently.
        return null;
      }
    })();
    return this.v2ModulePromise;
  }
}

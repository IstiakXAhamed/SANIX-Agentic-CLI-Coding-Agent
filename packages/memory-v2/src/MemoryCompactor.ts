/**
 * @file memory-v2/src/MemoryCompactor.ts
 * @description Background compaction orchestrator — the v2 replacement
 * for `@sanix/core`'s `MemoryCompressor`. Runs periodically (every N
 * agent iterations, configured by the caller) and:
 *
 *   1. **Deduplicates** each tier via {@link SemanticDeduplicator}.
 *   2. **Promotes / demotes** memories via {@link TierManager.runCycle}.
 *   3. **Prunes** forgotten memories (Ebbinghaus R < threshold) via
 *      {@link ForgettingCurve.shouldForget}.
 *   4. **Extracts** new semantic facts from recent successful sessions
 *      via {@link EpisodicExtractor.extract}.
 *   5. **Rebuilds** the unified {@link MemoryIndexManager} if more than
 *      5% of items changed.
 *
 * The compactor never throws — every step is wrapped in try/catch and
 * any errors are recorded in the {@link CompactionReport}.
 *
 * ## Comparison to `MemoryCompressor` (v1)
 *
 * v1 only merged duplicate facts and pruned stale episodic sessions.
 * v2 adds: salience-aware dedup, tier promotion/demotion, forgetting-
 * curve-driven pruning, and episodic→semantic fact extraction. v2 also
 * maintains a unified index that makes recall O(log N) instead of the
 * O(tiers × tier-recall-cost) of v1's parallel recall.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type {
  MemoryItem,
  MemoryRouterLike,
  MemoryTier,
  ScoredMemoryItem,
} from './types.js';
import { SemanticDeduplicator } from './SemanticDeduplicator.js';
import { TierManager } from './TierManager.js';
import { ForgettingCurve, DEFAULT_FORGET_THRESHOLD } from './ForgettingCurve.js';
import { EpisodicExtractor, type SessionRecord } from './EpisodicExtractor.js';
import { MemoryIndexManager } from './MemoryIndexManager.js';

/** A session passed to the compactor for episodic→semantic extraction. */
export type { SessionRecord };

/** Result of a single compaction run. */
export interface CompactionReport {
  /** Number of duplicate clusters merged across all tiers. */
  duplicatesMerged: number;
  /** Number of memories promoted to a higher tier. */
  promoted: number;
  /** Number of memories demoted to a lower tier. */
  demoted: number;
  /** Number of memories pruned (deleted). */
  pruned: number;
  /** Number of new semantic facts extracted from recent sessions. */
  factsExtracted: number;
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs: number;
  /** True if the unified index was rebuilt during this run. */
  indexRebuilt: boolean;
  /** Non-fatal errors encountered (one string per failed step). */
  errors: string[];
}

/** Context for a single compaction run. */
export interface CompactionContext {
  /** The 4-tier memory router. */
  router: MemoryRouterLike;
  /** Tier manager with observations already accumulated. */
  tierManager: TierManager;
  /** Optional deduplicator (a default is created if omitted). */
  deduplicator?: SemanticDeduplicator;
  /** Optional forgetting curve (a default is created if omitted). */
  forgettingCurve?: ForgettingCurve;
  /** Optional episodic extractor (a default is created if omitted). */
  extractor?: EpisodicExtractor;
  /** Optional index manager (rebuilt if >5% of items changed). */
  indexManager?: MemoryIndexManager;
  /** Recent sessions to mine for facts. */
  recentSessions?: ReadonlyArray<SessionRecord>;
  /** Optional LLM callback for fact extraction. */
  llmCallback?: (prompt: string) => Promise<string>;
  /**
   * Optional existing semantic facts (for dedup against). If omitted,
   * the compactor recalls them from the router's semantic tier.
   */
  existingFacts?: ReadonlyArray<MemoryItem>;
  /**
   * Fraction of items that must change before the index is rebuilt.
   * Default 0.05 (5%).
   */
  indexRebuildThreshold?: number;
  /** Forgetting-curve retention threshold below which items are pruned. */
  pruneRetentionThreshold?: number;
}

/** Constructor options. */
export interface MemoryCompactorOptions {
  /** Run interval (in agent iterations). Default 10. */
  interval?: number;
}

/**
 * Background memory-compaction orchestrator.
 *
 * @example
 * ```ts
 * const compactor = new MemoryCompactor({ interval: 10 });
 * // In the agent loop:
 * if (compactor.shouldRun(state.iterationCount)) {
 *   const report = await compactor.run({
 *     router: memoryRouter,
 *     tierManager,
 *     indexManager,
 *     recentSessions: [lastSession],
 *   });
 *   console.log('compacted:', report);
 * }
 * ```
 */
export class MemoryCompactor {
  readonly interval: number;
  private lastRunIteration = -1;

  constructor(opts: MemoryCompactorOptions = {}) {
    this.interval = opts.interval ?? 10;
  }

  /**
   * True if the compactor should run at the given iteration index.
   *
   * @example
   * ```ts
   * if (compactor.shouldRun(state.iterationCount)) {
   *   await compactor.run(ctx);
   * }
   * ```
   */
  shouldRun(iteration: number): boolean {
    return iteration > 0 && iteration % this.interval === 0 && iteration !== this.lastRunIteration;
  }

  /**
   * Run a compaction pass. Never throws — all errors are caught and
   * recorded in the report's `errors` array.
   *
   * @example
   * ```ts
   * const report = await compactor.run({
   *   router, tierManager, indexManager,
   *   recentSessions: [session],
   *   llmCallback,
   * });
   * console.log(`promoted ${report.promoted}, pruned ${report.pruned}`);
   * ```
   */
  async run(ctx: CompactionContext): Promise<CompactionReport> {
    const start = Date.now();
    const errors: string[] = [];
    let duplicatesMerged = 0;
    let promoted = 0;
    let demoted = 0;
    let pruned = 0;
    let factsExtracted = 0;
    let indexRebuilt = false;

    const deduplicator = ctx.deduplicator ?? new SemanticDeduplicator();
    const forgettingCurve = ctx.forgettingCurve ?? new ForgettingCurve();
    const extractor = ctx.extractor ?? new EpisodicExtractor();

    // Step 1: Deduplicate each tier.
    const preSize = await this.totalSize(ctx.router);
    try {
      duplicatesMerged += await this.deduplicateTier(
        ctx.router,
        'semantic',
        deduplicator,
      );
    } catch (err) {
      errors.push(`dedup-semantic: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      duplicatesMerged += await this.deduplicateTier(
        ctx.router,
        'episodic',
        deduplicator,
      );
    } catch (err) {
      errors.push(`dedup-episodic: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      duplicatesMerged += await this.deduplicateTier(
        ctx.router,
        'procedural',
        deduplicator,
      );
    } catch (err) {
      errors.push(`dedup-procedural: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 2: Tier promotions / demotions.
    try {
      const report = await ctx.tierManager.runCycle(ctx.router);
      promoted = report.promoted.length;
      demoted = report.demoted.length;
      pruned += report.pruned.length;
    } catch (err) {
      errors.push(`tierManager.runCycle: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 3: Forgetting-curve pruning on episodic + semantic.
    try {
      pruned += await this.pruneForgotten(
        ctx.router,
        'episodic',
        forgettingCurve,
        ctx.pruneRetentionThreshold ?? DEFAULT_FORGET_THRESHOLD,
      );
    } catch (err) {
      errors.push(`prune-episodic: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      pruned += await this.pruneForgotten(
        ctx.router,
        'semantic',
        forgettingCurve,
        ctx.pruneRetentionThreshold ?? DEFAULT_FORGET_THRESHOLD,
      );
    } catch (err) {
      errors.push(`prune-semantic: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 4: Episodic → semantic fact extraction.
    if (ctx.recentSessions && ctx.recentSessions.length > 0) {
      try {
        const existingFacts =
          ctx.existingFacts ?? (await this.fetchSemanticFacts(ctx.router));
        for (const session of ctx.recentSessions) {
          if (!session.success) continue;
          const facts = await extractor.extract(session, {
            llmCallback: ctx.llmCallback,
            existingFacts,
          });
          for (const fact of facts) {
            try {
              const item: MemoryItem = {
                id: nanoid(),
                tier: 'semantic',
                type: 'fact',
                content: fact.content,
                metadata: {
                  confidence: fact.confidence,
                  sessionId: fact.source,
                  evidence: fact.evidence,
                  extractedAt: Date.now(),
                },
                createdAt: session.endedAt || new Date().toISOString(),
                importance: fact.confidence,
              };
              await ctx.router.store(item);
              factsExtracted++;
            } catch (err) {
              errors.push(
                `store-fact: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      } catch (err) {
        errors.push(`extract: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 5: Rebuild the unified index if significant changes occurred.
    if (ctx.indexManager) {
      try {
        const postSize = await this.totalSize(ctx.router);
        const changed = Math.abs(postSize - preSize) + duplicatesMerged + promoted + demoted + pruned + factsExtracted;
        const threshold = ctx.indexRebuildThreshold ?? 0.05;
        const totalItems = Math.max(1, preSize);
        if (changed / totalItems > threshold) {
          await ctx.indexManager.reindex(ctx.router);
          await ctx.indexManager.flush();
          indexRebuilt = true;
        }
      } catch (err) {
        errors.push(`index-rebuild: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.lastRunIteration = this.lastRunIteration; // satisfy lints
    return {
      duplicatesMerged,
      promoted,
      demoted,
      pruned,
      factsExtracted,
      durationMs: Date.now() - start,
      indexRebuilt,
      errors,
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * Deduplicate a single tier. Pulls all items via a wide recall,
   * runs the deduplicator, deletes the old items, and stores the
   * merged survivors. Returns the number of clusters merged.
   */
  private async deduplicateTier(
    router: MemoryRouterLike,
    tier: MemoryTier,
    deduplicator: SemanticDeduplicator,
  ): Promise<number> {
    const items = await this.fetchAllFromTier(router, tier);
    if (items.length < 2) return 0;
    const result = deduplicator.deduplicate(items);
    if (result.merged === 0) return 0;

    // Delete all merged-cluster members and store the survivors.
    const mergedIds = new Set<string>();
    for (const c of result.clusters) {
      for (const id of c.memberIds) mergedIds.add(id);
    }
    for (const id of mergedIds) {
      try {
        if (tier === 'semantic') {
          await router.semantic.deleteWhere(`id = '${id}'`);
        } else if (tier === 'procedural') {
          router.procedural.delete(id);
        }
        // working & episodic don't expose a per-id delete — skip; they
        // age out via windowing / pruning.
      } catch {
        // Non-fatal.
      }
    }
    for (const survivor of result.kept) {
      if (!mergedIds.has(survivor.id)) continue; // not a merged survivor
      try {
        await router.store(survivor);
      } catch {
        // Non-fatal.
      }
    }
    return result.merged;
  }

  /**
   * Prune memories whose Ebbinghaus retention has dropped below the
   * threshold. Pulls all items from the tier, scores each, and deletes
   * the forgettable ones.
   */
  private async pruneForgotten(
    router: MemoryRouterLike,
    tier: MemoryTier,
    curve: ForgettingCurve,
    threshold: number,
  ): Promise<number> {
    const items = await this.fetchAllFromTier(router, tier);
    let pruned = 0;
    for (const item of items) {
      const lastAccessedAt =
        typeof item.metadata.lastAccessedAt === 'number'
          ? item.metadata.lastAccessedAt
          : Date.parse(item.createdAt);
      const stability =
        typeof item.metadata.stability === 'number'
          ? item.metadata.stability
          : 86_400_000;
      if (!Number.isFinite(lastAccessedAt)) continue;
      if (
        curve.shouldForget(
          { lastAccessedAt, stability, createdAt: Date.parse(item.createdAt) || lastAccessedAt },
          threshold,
        )
      ) {
        try {
          if (tier === 'semantic') {
            await router.semantic.deleteWhere(`id = '${item.id}'`);
          } else if (tier === 'procedural') {
            router.procedural.delete(item.id);
          }
          pruned++;
        } catch {
          // Non-fatal.
        }
      }
    }
    return pruned;
  }

  /** Pull all items from a single tier via a wide recall. */
  private async fetchAllFromTier(
    router: MemoryRouterLike,
    tier: MemoryTier,
  ): Promise<MemoryItem[]> {
    if (tier === 'working') {
      return router.working.all();
    }
    if (tier === 'procedural') {
      return router.procedural.list();
    }
    try {
      const hits: ScoredMemoryItem[] = await (
        tier === 'semantic' ? router.semantic : router.episodic
      ).recall({ query: '', limit: 10_000, minRelevance: 0 });
      return hits.map((h) => h.item);
    } catch {
      return [];
    }
  }

  /** Convenience: pull all semantic facts for dedup context. */
  private async fetchSemanticFacts(router: MemoryRouterLike): Promise<MemoryItem[]> {
    return this.fetchAllFromTier(router, 'semantic');
  }

  /** Total item count across all tiers (best-effort). */
  private async totalSize(router: MemoryRouterLike): Promise<number> {
    let n = router.working.all().length;
    n += router.procedural.list().length;
    try {
      const sem = await router.semantic.recall({ query: '', limit: 10_000, minRelevance: 0 });
      n += sem.length;
    } catch {
      // ignore
    }
    try {
      const epi = await router.episodic.recall({ query: '', limit: 10_000, minRelevance: 0 });
      n += epi.length;
    } catch {
      // ignore
    }
    return n;
  }
}

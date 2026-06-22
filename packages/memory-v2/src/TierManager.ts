/**
 * @file memory-v2/src/TierManager.ts
 * @description Automatic promotion / demotion of memories between the
 * four tiers (working / episodic / semantic / procedural), based on
 * observed access patterns and salience scores.
 *
 * ## Rules (per spec)
 *
 *   1. **Working → Episodic**: a working-memory item recalled 3+ times
 *      in a single session is "promoted" — its content is written to
 *      the episodic tier (SQLite) so it survives session end.
 *   2. **Episodic → Semantic**: an episodic memory recalled 5+ times
 *      across distinct sessions is "promoted" — written to the semantic
 *      tier (LanceDB or HNSW) as a reusable fact.
 *   3. **Semantic → Episodic**: a semantic memory whose salience has
 *      stayed below 0.1 for 30+ days is "demoted" back to episodic
 *      (then potentially pruned by the ForgettingCurve).
 *   4. **Episodic → pruned**: an episodic memory not recalled in 90+
 *      days with Ebbinghaus retention < 0.05 is a pruning candidate.
 *   5. **Procedural → boost**: a procedural pattern used 10+ times
 *      successfully gets a confidence boost (+0.1, capped at 0.95).
 *
 * ## Architecture
 *
 * `observe(event)` is called by the AgentLoop after each recall / tool
 * call — it records the access in an in-memory log keyed by `memoryId`.
 * `runCycle(router)` walks the log, applies the rules above, mutates
 * the router's tiers via `store()` / `deleteWhere()` / `delete()`, and
 * returns a {@link PromotionReport} for traceability.
 *
 * The manager is intentionally **idempotent**: re-running `runCycle`
 * with no new observations produces no further mutations (each rule
 * checks the log state, not just the tier contents).
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type {
  MemoryItem,
  MemoryRouterLike,
  MemoryTier,
} from './types.js';
import { SalienceScorer } from './SalienceScorer.js';
import { ForgettingCurve } from './ForgettingCurve.js';

/** A single memory-access observation. */
export interface MemoryAccessEvent {
  /** The memory that was accessed. */
  memoryId: string;
  /** The tier it lived in at access time. */
  tier: MemoryTier;
  /** Epoch ms of the access. */
  accessedAt: number;
  /** Session id (used for cross-session counting). */
  sessionId: string;
  /** Optional outcome of the access (success/failure/neutral). */
  outcome?: 'success' | 'failure' | 'neutral';
}

/** A single promotion / demotion / prune action. */
export interface TierTransition {
  /** Source tier (`'pruned'` for prune actions). */
  from: MemoryTier | 'pruned';
  /** Destination tier (`'pruned'` for prune actions). */
  to: MemoryTier | 'pruned';
  /** The memory id. */
  memoryId: string;
}

/** Result of a `runCycle()` pass. */
export interface PromotionReport {
  /** Items promoted to a higher tier. */
  promoted: TierTransition[];
  /** Items demoted to a lower tier. */
  demoted: TierTransition[];
  /** Items pruned (deleted). */
  pruned: string[];
  /** Per-item rationale (key = memory id, value = human-readable reason). */
  rationale: Record<string, string>;
}

/** Constructor options. */
export interface TierManagerOptions {
  /** Recall count in a session to promote working → episodic. Default 3. */
  workingPromotionThreshold?: number;
  /** Distinct sessions to promote episodic → semantic. Default 5. */
  episodicPromotionThreshold?: number;
  /** Days of low salience before semantic → episodic demotion. Default 30. */
  semanticDemotionDays?: number;
  /** Salience threshold for demotion. Default 0.1. */
  semanticDemotionSalience?: number;
  /** Days without recall before episodic prune. Default 90. */
  episodicPruneDays?: number;
  /** Forgetting-curve retention threshold for pruning. Default 0.05. */
  episodicPruneRetention?: number;
  /** Successful uses to boost a procedural pattern. Default 10. */
  proceduralBoostThreshold?: number;
  /** Amount to boost procedural confidence by. Default 0.1 (cap 0.95). */
  proceduralBoostAmount?: number;
  /** Salience scorer (used for the demotion rule). */
  salienceScorer?: SalienceScorer;
  /** Forgetting-curve (used for the prune rule). */
  forgettingCurve?: ForgettingCurve;
}

/** Default thresholds. */
export const DEFAULT_TIER_THRESHOLDS = {
  workingPromotion: 3,
  episodicPromotion: 5,
  semanticDemotionDays: 30,
  semanticDemotionSalience: 0.1,
  episodicPruneDays: 90,
  episodicPruneRetention: 0.05,
  proceduralBoost: 10,
  proceduralBoostAmount: 0.1,
} as const;

/**
 * Tier promotion / demotion manager.
 *
 * @example
 * ```ts
 * const tm = new TierManager();
 * // Wire into the agent loop:
 * memory.on('recall', ({ results }) => {
 *   for (const r of results) {
 *     tm.observe({
 *       memoryId: r.item.id,
 *       tier: r.tier,
 *       accessedAt: Date.now(),
 *       sessionId,
 *       outcome: 'neutral',
 *     });
 *   }
 * });
 * // Periodically (e.g. every 10 iterations):
 * const report = await tm.runCycle(memoryRouter);
 * console.log(`promoted ${report.promoted.length}, pruned ${report.pruned.length}`);
 * ```
 */
export class TierManager {
  /** Access log: memoryId → list of access events. */
  private readonly accessLog = new Map<string, MemoryAccessEvent[]>();
  /** Session set per memory: memoryId → set of sessionIds. */
  private readonly sessionSet = new Map<string, Set<string>>();
  /** Success count per memory (procedural boost rule). */
  private readonly successCount = new Map<string, number>();
  /** Memories already processed in a prior cycle (idempotency). */
  private readonly processed = new Set<string>();

  private readonly thresholds: Required<Omit<TierManagerOptions, 'salienceScorer' | 'forgettingCurve'>>;
  private readonly salience: SalienceScorer;
  private readonly forgettingCurve: ForgettingCurve;

  constructor(opts: TierManagerOptions = {}) {
    this.thresholds = {
      workingPromotionThreshold: opts.workingPromotionThreshold ?? DEFAULT_TIER_THRESHOLDS.workingPromotion,
      episodicPromotionThreshold: opts.episodicPromotionThreshold ?? DEFAULT_TIER_THRESHOLDS.episodicPromotion,
      semanticDemotionDays: opts.semanticDemotionDays ?? DEFAULT_TIER_THRESHOLDS.semanticDemotionDays,
      semanticDemotionSalience: opts.semanticDemotionSalience ?? DEFAULT_TIER_THRESHOLDS.semanticDemotionSalience,
      episodicPruneDays: opts.episodicPruneDays ?? DEFAULT_TIER_THRESHOLDS.episodicPruneDays,
      episodicPruneRetention: opts.episodicPruneRetention ?? DEFAULT_TIER_THRESHOLDS.episodicPruneRetention,
      proceduralBoostThreshold: opts.proceduralBoostThreshold ?? DEFAULT_TIER_THRESHOLDS.proceduralBoost,
      proceduralBoostAmount: opts.proceduralBoostAmount ?? DEFAULT_TIER_THRESHOLDS.proceduralBoostAmount,
    };
    this.salience = opts.salienceScorer ?? new SalienceScorer();
    this.forgettingCurve = opts.forgettingCurve ?? new ForgettingCurve();
  }

  /**
   * Record a memory-access observation. Called by the AgentLoop after
   * each recall / tool call.
   *
   * @example
   * ```ts
   * tm.observe({
   *   memoryId: 'mem-42',
   *   tier: 'episodic',
   *   accessedAt: Date.now(),
   *   sessionId: 'sess-1',
   *   outcome: 'success',
   * });
   * ```
   */
  observe(event: MemoryAccessEvent): void {
    const log = this.accessLog.get(event.memoryId) ?? [];
    log.push(event);
    this.accessLog.set(event.memoryId, log);

    const sessions = this.sessionSet.get(event.memoryId) ?? new Set();
    sessions.add(event.sessionId);
    this.sessionSet.set(event.memoryId, sessions);

    if (event.outcome === 'success') {
      this.successCount.set(
        event.memoryId,
        (this.successCount.get(event.memoryId) ?? 0) + 1,
      );
    }

    // A new observation invalidates the "already processed" flag — the
    // item may now be eligible for a fresh promotion/demotion.
    this.processed.delete(event.memoryId);
  }

  /**
   * Run a promotion / demotion / prune cycle. Walks the access log,
   * applies each rule, and mutates the router's tiers accordingly.
   *
   * @param router - The 4-tier memory router.
   * @returns A {@link PromotionReport} listing every action taken.
   *
   * @example
   * ```ts
   * const report = await tm.runCycle(memoryRouter);
   * for (const t of report.promoted) {
   *   console.log(`${t.memoryId}: ${t.from} → ${t.to}`);
   * }
   * ```
   */
  async runCycle(router: MemoryRouterLike): Promise<PromotionReport> {
    const promoted: TierTransition[] = [];
    const demoted: TierTransition[] = [];
    const pruned: string[] = [];
    const rationale: Record<string, string> = {};

    for (const [memoryId, events] of this.accessLog) {
      if (this.processed.has(memoryId)) continue;
      if (events.length === 0) continue;

      const lastEvent = events[events.length - 1]!;
      const sessions = this.sessionSet.get(memoryId) ?? new Set();

      // Rule 1: Working → Episodic (3+ recalls in a single session).
      if (lastEvent.tier === 'working') {
        const sessionCounts = new Map<string, number>();
        for (const e of events) {
          sessionCounts.set(e.sessionId, (sessionCounts.get(e.sessionId) ?? 0) + 1);
        }
        const maxInSession = Math.max(...sessionCounts.values());
        if (maxInSession >= this.thresholds.workingPromotionThreshold) {
          const item = router.working.all().find((m) => m.id === memoryId);
          if (item) {
            try {
              await router.episodic.store({ ...item, tier: 'episodic' });
              promoted.push({ from: 'working', to: 'episodic', memoryId });
              rationale[memoryId] = `Recalled ${maxInSession}× in session ${lastEvent.sessionId} (≥ ${this.thresholds.workingPromotionThreshold}).`;
              this.processed.add(memoryId);
              continue;
            } catch (err) {
              rationale[memoryId] = `Working→episodic promotion failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
        }
      }

      // Rule 2: Episodic → Semantic (5+ distinct sessions).
      if (lastEvent.tier === 'episodic' && sessions.size >= this.thresholds.episodicPromotionThreshold) {
        try {
          const hits = await router.episodic.recall({
            query: '',
            limit: 1000,
            minRelevance: 0,
          });
          const item = hits.find((h) => h.item.id === memoryId)?.item;
          if (item) {
            const promotedItem: MemoryItem = {
              ...item,
              id: nanoid(),
              tier: 'semantic',
              type: 'fact',
              metadata: {
                ...item.metadata,
                promotedFrom: 'episodic',
                originalId: memoryId,
              },
            };
            await router.semantic.store(promotedItem);
            promoted.push({ from: 'episodic', to: 'semantic', memoryId: promotedItem.id });
            rationale[promotedItem.id] = `Episodic memory ${memoryId} recalled across ${sessions.size} sessions (≥ ${this.thresholds.episodicPromotionThreshold}).`;
            this.processed.add(memoryId);
            continue;
          }
        } catch (err) {
          rationale[memoryId] = `Episodic→semantic promotion failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Rule 3: Semantic → Episodic (salience < 0.1 for 30+ days).
      if (lastEvent.tier === 'semantic') {
        const cutoff = Date.now() - this.thresholds.semanticDemotionDays * 86_400_000;
        const recentAccess = events.some((e) => e.accessedAt >= cutoff);
        if (!recentAccess) {
          try {
            const hits = await router.semantic.recall({
              query: '',
              limit: 1000,
              minRelevance: 0,
            });
            const item = hits.find((h) => h.item.id === memoryId)?.item;
            if (item) {
              const salience = this.salience.score(item);
              if (salience < this.thresholds.semanticDemotionSalience) {
                const demotedItem: MemoryItem = {
                  ...item,
                  id: nanoid(),
                  tier: 'episodic',
                  metadata: {
                    ...item.metadata,
                    demotedFrom: 'semantic',
                    originalId: memoryId,
                  },
                };
                await router.episodic.store(demotedItem);
                // Remove from semantic tier.
                await router.semantic.deleteWhere(`id = '${memoryId}'`);
                demoted.push({ from: 'semantic', to: 'episodic', memoryId: demotedItem.id });
                rationale[demotedItem.id] = `Semantic memory ${memoryId} salience=${salience.toFixed(3)} < ${this.thresholds.semanticDemotionSalience} for ${this.thresholds.semanticDemotionDays}+ days.`;
                this.processed.add(memoryId);
                continue;
              }
            }
          } catch (err) {
            rationale[memoryId] = `Semantic→episodic demotion failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }

      // Rule 4: Episodic → pruned (90+ days, R < 0.05).
      if (lastEvent.tier === 'episodic') {
        const cutoff = Date.now() - this.thresholds.episodicPruneDays * 86_400_000;
        const lastAccessed = lastEvent.accessedAt;
        if (lastAccessed < cutoff) {
          try {
            const hits = await router.episodic.recall({
              query: '',
              limit: 1000,
              minRelevance: 0,
            });
            const item = hits.find((h) => h.item.id === memoryId)?.item;
            if (item) {
              const retention = this.forgettingCurve.retention({
                lastAccessedAt: lastAccessed,
                stability:
                  typeof item.metadata.stability === 'number'
                    ? item.metadata.stability
                    : 86_400_000,
                createdAt: Date.parse(item.createdAt) || lastAccessed,
              });
              if (retention < this.thresholds.episodicPruneRetention) {
                await router.episodic.prune(this.thresholds.episodicPruneDays);
                pruned.push(memoryId);
                rationale[memoryId] = `Episodic memory not recalled in ${this.thresholds.episodicPruneDays}+ days, retention=${retention.toFixed(3)} < ${this.thresholds.episodicPruneRetention}.`;
                this.processed.add(memoryId);
                continue;
              }
            }
          } catch (err) {
            rationale[memoryId] = `Episodic prune failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }

      // Rule 5: Procedural → boost (10+ successful uses).
      if (lastEvent.tier === 'procedural') {
        const successes = this.successCount.get(memoryId) ?? 0;
        if (successes >= this.thresholds.proceduralBoostThreshold) {
          try {
            const patterns = router.procedural.list();
            const item = patterns.find((p) => p.id === memoryId);
            if (item) {
              const currentConf = typeof item.metadata.confidence === 'number'
                ? item.metadata.confidence
                : 0.5;
              const newConf = Math.min(0.95, currentConf + this.thresholds.proceduralBoostAmount);
              const boosted: MemoryItem = {
                ...item,
                metadata: {
                  ...item.metadata,
                  confidence: newConf,
                  successCount: successes,
                  boostedAt: Date.now(),
                },
                importance: newConf,
              };
              // Delete old, store boosted (procedural memory's `store`
              // merges by name+taskType, so this updates in place).
              router.procedural.delete(memoryId);
              await router.procedural.store(boosted);
              promoted.push({ from: 'procedural', to: 'procedural', memoryId });
              rationale[memoryId] = `Procedural pattern used ${successes}× successfully (≥ ${this.thresholds.proceduralBoostThreshold}); confidence boosted ${currentConf.toFixed(2)} → ${newConf.toFixed(2)}.`;
              this.processed.add(memoryId);
              continue;
            }
          } catch (err) {
            rationale[memoryId] = `Procedural boost failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }

      // No rule applied — mark as processed so we don't re-scan.
      this.processed.add(memoryId);
    }

    return { promoted, demoted, pruned, rationale };
  }

  /**
   * Get the access log for inspection / debugging. Returns a defensive
   * copy.
   */
  getAccessLog(): ReadonlyMap<string, ReadonlyArray<MemoryAccessEvent>> {
    const out = new Map<string, ReadonlyArray<MemoryAccessEvent>>();
    for (const [k, v] of this.accessLog) {
      out.set(k, [...v]);
    }
    return out;
  }

  /**
   * Reset all observations and idempotency flags. Useful for tests.
   */
  reset(): void {
    this.accessLog.clear();
    this.sessionSet.clear();
    this.successCount.clear();
    this.processed.clear();
  }
}

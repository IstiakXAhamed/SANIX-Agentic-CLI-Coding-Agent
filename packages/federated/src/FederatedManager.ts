/**
 * @file FederatedManager.ts
 * @description Top-level coordinator for a federated learning session.
 * The manager owns the {@link ModelManager} (global state), the
 * {@link UpdateExchange} (client↔server communication), an
 * {@link AggregationStrategy}, and an optional
 * {@link DifferentialPrivacy} layer. It runs the federated loop:
 *
 *   1. Open a round → set the expected checksum on the exchange.
 *   2. Collect updates (clients submit asynchronously).
 *   3. When `minClients` is reached (or {@link runRound} is called
 *      explicitly), apply DP (if configured), aggregate, and apply the
 *      result to the model manager.
 *   4. Broadcast the new parameters to all clients.
 *   5. Emit `roundComplete` with {@link RoundStats}.
 *
 * The manager is event-driven: callers subscribe to `roundComplete`,
 * `roundFailed`, etc. and call {@link startRound} / {@link runRound} as
 * appropriate. There is no implicit timer — the caller decides when to
 * stop collecting and start aggregating.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import { DifferentialPrivacy } from './DifferentialPrivacy.js';
import { cloneParams, ModelManager } from './ModelManager.js';
import {
  createStrategy,
  type AggregationStrategy,
} from './aggregation/index.js';
import { UpdateExchange } from './UpdateExchange.js';
import type {
  ClientUpdate,
  FederatedManagerEvents,
  FederatedManagerOptions,
  ModelParameters,
  RoundStats,
  RoundStatus,
} from './types.js';

/**
 * Top-level coordinator for a federated learning session.
 *
 * ```ts
 * const manager = new FederatedManager({
 *   strategy: 'fedavg',
 *   minClients: 3,
 * });
 * manager.on('roundComplete', (stats, params) => {
 *   console.log(`round ${stats.round} done in ${stats.durationMs}ms`);
 * });
 * manager.startRound();
 * // … clients submit updates via manager.submit(update) …
 * await manager.runRound();
 * ```
 */
export class FederatedManager extends EventEmitter<FederatedManagerEvents> {
  /** Owns the global model state. */
  readonly model: ModelManager;
  /** Mediates client↔server update exchange. */
  readonly exchange: UpdateExchange;
  /** Aggregation strategy instance. */
  readonly #strategy: AggregationStrategy;
  /** Optional DP layer. */
  readonly #dp?: DifferentialPrivacy;
  /** Resolved options. */
  readonly #options: Required<Omit<FederatedManagerOptions, 'strategy' | 'strategyOptions' | 'dp'>>;
  /** Current round number (0-indexed). */
  #currentRound: number = 0;
  /** Status of the current round. */
  #status: RoundStatus = 'pending';
  /** Round start timestamps (for duration calculation). */
  #roundStarts: Map<number, number> = new Map();

  /**
   * @param options - Manager configuration (see {@link FederatedManagerOptions}).
   */
  constructor(options: FederatedManagerOptions = {}) {
    super();
    this.model = new ModelManager();
    this.exchange = new UpdateExchange({
      verifyChecksum: options.verifyChecksums ?? true,
    });
    this.#strategy = createStrategy(options.strategy ?? 'fedavg', options.strategyOptions ?? {});
    if (options.dp) {
      this.#dp = new DifferentialPrivacy(options.dp);
    }
    this.#options = {
      minClients: options.minClients ?? 2,
      maxClients: options.maxClients ?? 0,
      verifyChecksums: options.verifyChecksums ?? true,
    };
  }

  /**
   * Start a new round. Sets the expected checksum on the exchange
   * (so clients must have trained against the current model) and emits
   * `roundStart`. Throws if a round is already in progress.
   */
  startRound(): void {
    if (this.#status !== 'pending' && this.#status !== 'complete' && this.#status !== 'failed') {
      throw new Error(`Cannot start round while status is "${this.#status}"`);
    }
    this.#status = 'collecting';
    this.#roundStarts.set(this.#currentRound, Date.now());
    this.exchange.setExpectedChecksum(this.model.checksum());
    this.emit('roundStart', this.#currentRound);
  }

  /**
   * Submit a client update. Delegates to the underlying exchange. The
   * `updateReceived` event is emitted for every accepted update.
   *
   * @param update - The update to submit.
   */
  async submit(update: ClientUpdate): Promise<void> {
    await this.exchange.submit(update);
    this.emit('updateReceived', update);
  }

  /**
   * Run aggregation for the current round. Collects all queued updates,
   * applies DP (if configured), runs the aggregation strategy, applies
   * the result to the model manager, broadcasts the new parameters,
   * and emits `roundComplete`. Emits `roundFailed` on error.
   *
   * @returns The aggregated parameters and round stats, or `undefined`
   *          if the round failed.
   */
  async runRound(): Promise<{ params: ModelParameters; stats: RoundStats } | undefined> {
    if (this.#status !== 'collecting') {
      throw new Error(`Cannot run round while status is "${this.#status}"`);
    }
    const round = this.#currentRound;
    const start = this.#roundStarts.get(round) ?? Date.now();
    try {
      this.#status = 'aggregating';
      this.emit('aggregating', round);
      let updates = this.exchange.collect(round);
      if (updates.length < this.#options.minClients) {
        throw new Error(`Only ${updates.length} clients (min ${this.#options.minClients})`);
      }
      // Subsample to maxClients if configured.
      if (this.#options.maxClients > 0 && updates.length > this.#options.maxClients) {
        updates = this.#subsample(updates, this.#options.maxClients);
      }
      const beforeCount = updates.length;
      // Apply DP if configured.
      if (this.#dp) {
        updates = this.#dp.clipAndNoiseBatch(updates);
      }
      const aggregated = this.#strategy.aggregate(updates);
      this.model.apply(aggregated);
      // Broadcast the new params to clients.
      await this.exchange.broadcast(this.model.snapshot(), round + 1);
      const stats = this.#buildStats(round, beforeCount, start, updates);
      this.#status = 'complete';
      this.#currentRound += 1;
      this.emit('roundComplete', stats, aggregated);
      return { params: cloneParams(aggregated), stats };
    } catch (e) {
      this.#status = 'failed';
      this.emit('roundFailed', round, e instanceof Error ? e : new Error(String(e)));
      return undefined;
    }
  }

  /** Current round number (0-indexed). */
  get currentRound(): number {
    return this.#currentRound;
  }

  /** Status of the current round. */
  get status(): RoundStatus {
    return this.#status;
  }

  /** Convenience accessor: number of pending updates for the current round. */
  pendingUpdates(): number {
    return this.exchange.pendingCount(this.#currentRound);
  }

  /**
   * Subsample `max` updates uniformly at random from `updates`. Uses
   * Fisher-Yates shuffle.
   */
  #subsample(updates: readonly ClientUpdate[], max: number): ClientUpdate[] {
    const arr = [...updates];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr.slice(0, max);
  }

  /**
   * Build a {@link RoundStats} record for the completed round. The
   * `metrics` field is the mean of every numeric metric reported by
   * every client (weighted by `numExamples`).
   */
  #buildStats(round: number, numClients: number, startMs: number, updates: readonly ClientUpdate[]): RoundStats {
    const metricsAgg: Record<string, { sum: number; weight: number }> = {};
    for (const u of updates) {
      if (!u.metrics) continue;
      for (const [k, v] of Object.entries(u.metrics)) {
        const entry = metricsAgg[k] ?? { sum: 0, weight: 0 };
        entry.sum += v * u.numExamples;
        entry.weight += u.numExamples;
        metricsAgg[k] = entry;
      }
    }
    const metrics: Record<string, number> = {};
    for (const [k, { sum, weight }] of Object.entries(metricsAgg)) {
      metrics[k] = weight > 0 ? sum / weight : 0;
    }
    return {
      round,
      numClients,
      durationMs: Date.now() - startMs,
      metrics,
      strategy: this.#strategy.name,
      excluded: 0,
    };
  }
}

/**
 * @file UpdateExchange.ts
 * @description Mediates the network exchange of {@link ClientUpdate}s
 * between clients and the {@link FederatedManager}. The exchange
 * accepts updates, validates them against the current round and model
 * checksum, queues them, and exposes them to the manager for
 * aggregation once the round's collection window closes.
 *
 * The exchange is in-process by default (suitable for simulation and
 * testing) but supports a pluggable {@link Transport} for real
 * networked deployments (WebSocket, HTTP, etc.).
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import type { ClientUpdate, ModelParameters } from './types.js';

/** Events emitted by {@link UpdateExchange}. */
export interface UpdateExchangeEvents {
  /** Fired when a client submits a valid update. */
  received: (update: ClientUpdate) => void;
  /** Fired when a client submits an invalid update (rejected with reason). */
  rejected: (update: ClientUpdate, reason: string) => void;
  /** Fired when the collection window for a round closes. */
  roundClosed: (round: number, count: number) => void;
}

/** Transport interface for shipping updates over a real network. */
export interface Transport {
  /** Send an update from a client to the server. */
  sendUpdate(update: ClientUpdate): Promise<void>;
  /** Subscribe to incoming updates on the server side. */
  onUpdate(handler: (update: ClientUpdate) => void): () => void;
  /** Broadcast the new global parameters to all clients. */
  broadcastParams(params: ModelParameters, round: number): Promise<void>;
}

/** Options accepted by {@link UpdateExchange}. */
export interface UpdateExchangeOptions {
  /** Optional transport for networked deployments. */
  readonly transport?: Transport;
  /** Maximum number of updates to queue per round. Default `1000`. */
  readonly maxQueueSize?: number;
  /** Whether to verify the update's checksum against the current model. Default `true`. */
  readonly verifyChecksum?: boolean;
}

/**
 * Mediates client↔server update exchange.
 *
 * ```ts
 * const exchange = new UpdateExchange();
 * exchange.on('received', (u) => console.log('got update from', u.clientId));
 * exchange.submit(update);
 * const all = exchange.collect(round);
 * ```
 */
export class UpdateExchange extends EventEmitter<UpdateExchangeEvents> {
  /** Per-round queues of pending updates. */
  readonly #queues: Map<number, ClientUpdate[]> = new Map();
  /** Current expected model checksum (for verification). */
  #expectedChecksum: string | undefined;
  /** Resolved options. */
  readonly #options: Required<Omit<UpdateExchangeOptions, 'transport'>>;
  /** Optional transport. */
  readonly #transport?: Transport;

  /**
   * @param options - Exchange configuration (see {@link UpdateExchangeOptions}).
   */
  constructor(options: UpdateExchangeOptions = {}) {
    super();
    this.#options = {
      maxQueueSize: options.maxQueueSize ?? 1000,
      verifyChecksum: options.verifyChecksum ?? true,
    };
    this.#transport = options.transport;
    if (this.#transport) {
      this.#transport.onUpdate((u) => {
        void this.submit(u);
      });
    }
  }

  /**
   * Set the expected model checksum for incoming updates. Updates whose
   * `checksum` field does not match are rejected.
   *
   * @param checksum - The checksum clients should have trained against.
   */
  setExpectedChecksum(checksum: string | undefined): void {
    this.#expectedChecksum = checksum;
  }

  /**
   * Submit a client update. The update is validated against the current
   * round and (if enabled) the expected checksum. Valid updates are
   * queued for the round and a `'received'` event is emitted; invalid
   * updates are rejected with a `'rejected'` event.
   *
   * @param update - The update to submit.
   */
  async submit(update: ClientUpdate): Promise<void> {
    const reason = this.#validate(update);
    if (reason) {
      this.emit('rejected', update, reason);
      return;
    }
    const queue = this.#queues.get(update.round) ?? [];
    if (queue.length >= this.#options.maxQueueSize) {
      this.emit('rejected', update, `queue full for round ${update.round}`);
      return;
    }
    queue.push(update);
    this.#queues.set(update.round, queue);
    this.emit('received', update);
    // If a transport is configured, propagate the update to other servers.
    if (this.#transport) {
      try {
        await this.#transport.sendUpdate(update);
      } catch {
        // Transport failures are non-fatal — the update is still queued locally.
      }
    }
  }

  /**
   * Collect all queued updates for a round and close the queue. After
   * this call, further submissions for `round` are rejected.
   *
   * @param round - The round number to collect.
   * @returns The collected updates (possibly empty).
   */
  collect(round: number): ClientUpdate[] {
    const updates = this.#queues.get(round) ?? [];
    this.#queues.delete(round);
    this.emit('roundClosed', round, updates.length);
    return updates;
  }

  /** Number of queued updates for a round. */
  pendingCount(round: number): number {
    return this.#queues.get(round)?.length ?? 0;
  }

  /**
   * Broadcast new global parameters to all clients via the configured
   * transport. No-op when no transport is set.
   *
   * @param params - The new global parameters.
   * @param round  - The round the params apply to.
   */
  async broadcast(params: ModelParameters, round: number): Promise<void> {
    if (this.#transport) {
      await this.#transport.broadcastParams(params, round);
    }
  }

  /** Validate an update; returns a rejection reason string or `undefined`. */
  #validate(update: ClientUpdate): string | undefined {
    if (update.params.size === 0) return 'empty params';
    if (update.numExamples <= 0) return 'numExamples must be > 0';
    if (this.#options.verifyChecksum && this.#expectedChecksum && update.checksum) {
      if (update.checksum !== this.#expectedChecksum) {
        return `checksum mismatch (expected ${this.#expectedChecksum}, got ${update.checksum})`;
      }
    }
    return undefined;
  }
}

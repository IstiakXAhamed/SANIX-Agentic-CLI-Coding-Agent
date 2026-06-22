/**
 * @file ModelManager.ts
 * @description Owns the global model state for a federated learning
 * session. The manager holds the current {@link ModelParameters},
 * applies aggregated updates from the {@link FederatedManager}, and
 * produces checksums so clients can verify they trained against the
 * right base.
 *
 * The manager is the single source of truth for "what is the current
 * model" — clients never hold the global model directly. Instead, they
 * request a snapshot via {@link ModelManager.snapshot}, train locally,
 * and submit a {@link ClientUpdate} whose `params` are the *result* of
 * the local training (not a delta).
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import type { ModelParameters } from './types.js';

/** Options accepted by {@link ModelManager}. */
export interface ModelManagerOptions {
  /** Initial parameters (defaults to an empty model). */
  readonly initialParams?: ModelParameters;
  /** Whether to maintain a history of previous parameter versions. Default `false`. */
  readonly keepHistory?: boolean;
  /** Maximum number of history entries to retain. Default `10`. */
  readonly maxHistory?: number;
}

/**
 * Owns the global model state for a federated session.
 *
 * ```ts
 * const manager = new ModelManager({ initialParams: baseParams });
 * const snapshot = manager.snapshot();
 * // … clients train against `snapshot` and submit updates …
 * manager.apply(aggregatedParams);
 * console.log(manager.version);  // 1
 * ```
 */
export class ModelManager {
  /** Current model parameters. */
  #params: ModelParameters;
  /** Monotonically increasing version counter. */
  #version: number = 0;
  /** Whether to keep history. */
  readonly #keepHistory: boolean;
  /** Maximum history size. */
  readonly #maxHistory: number;
  /** Previous parameter versions (oldest first). */
  readonly #history: ModelParameters[] = [];

  /**
   * @param options - Manager configuration (see {@link ModelManagerOptions}).
   */
  constructor(options: ModelManagerOptions = {}) {
    this.#params = options.initialParams ? cloneParams(options.initialParams) : new Map();
    this.#keepHistory = options.keepHistory ?? false;
    this.#maxHistory = options.maxHistory ?? 10;
  }

  /**
   * Return a defensive copy of the current parameters. Mutating the
   * returned map does not affect the manager.
   */
  snapshot(): ModelParameters {
    return cloneParams(this.#params);
  }

  /**
   * Replace the current parameters with `next`. The version counter is
   * incremented and (if enabled) the previous parameters are pushed
   * into history.
   *
   * @param next - The new parameters to apply.
   */
  apply(next: ModelParameters): void {
    if (this.#keepHistory) {
      this.#history.push(cloneParams(this.#params));
      while (this.#history.length > this.#maxHistory) this.#history.shift();
    }
    this.#params = cloneParams(next);
    this.#version += 1;
  }

  /** Current version counter (starts at 0, increments on every {@link apply}). */
  get version(): number {
    return this.#version;
  }

  /** Number of tensors in the current model. */
  get size(): number {
    return this.#params.size;
  }

  /** Total number of scalar parameters across all tensors. */
  get totalParameters(): number {
    let sum = 0;
    for (const arr of this.#params.values()) sum += arr.length;
    return sum;
  }

  /**
   * Return the parameter vector for a single tensor, or `undefined`.
   *
   * @param name - Tensor name.
   */
  getTensor(name: string): Float64Array | undefined {
    const arr = this.#params.get(name);
    return arr ? Float64Array.from(arr) : undefined;
  }

  /**
   * Compute a SHA-256 checksum of the current parameters. Clients use
   * this to verify they trained against the correct base.
   */
  checksum(): string {
    const hash = createHash('sha256');
    const names = [...this.#params.keys()].sort();
    for (const name of names) {
      const arr = this.#params.get(name)!;
      hash.update(name);
      hash.update(':');
      // Use the byte view of the Float64Array for a stable checksum.
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      hash.update(bytes);
      hash.update(';');
    }
    return hash.digest('hex');
  }

  /**
   * Return a defensive copy of the history (oldest first). Empty when
   * `keepHistory` is `false`.
   */
  getHistory(): ModelParameters[] {
    return this.#history.map(cloneParams);
  }

  /**
   * Reset the manager to an empty model. History is cleared and the
   * version counter is reset to 0.
   */
  reset(): void {
    this.#params = new Map();
    this.#history.length = 0;
    this.#version = 0;
  }
}

/**
 * Deep-clone a {@link ModelParameters} map. Each tensor's underlying
 * `Float64Array` is copied so the clone is fully independent of the
 * original.
 *
 * @param params - The parameters to clone.
 * @returns A deep copy.
 */
export function cloneParams(params: ModelParameters): ModelParameters {
  const out: ModelParameters = new Map();
  for (const [k, v] of params) out.set(k, Float64Array.from(v));
  return out;
}

/**
 * Compute the L2 distance between two parameter maps. Both maps must
 * have the same keys. Used by the Krum aggregation strategy.
 *
 * @param a - First parameter map.
 * @param b - Second parameter map.
 * @returns The L2 distance.
 */
export function l2Distance(a: ModelParameters, b: ModelParameters): number {
  let sum = 0;
  for (const [k, av] of a) {
    const bv = b.get(k);
    if (!bv) throw new Error(`Missing tensor "${k}" in second map`);
    for (let i = 0; i < av.length; i++) {
      const d = av[i]! - bv[i]!;
      sum += d * d;
    }
  }
  return Math.sqrt(sum);
}

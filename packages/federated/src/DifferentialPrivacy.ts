/**
 * @file DifferentialPrivacy.ts
 * @description Differential privacy for federated learning via DP-SGD
 * style gradient clipping + Gaussian noise addition. Two integration
 * points are supported:
 *
 *   1. **Per-update (server-side)** — clip each client update to a
 *      maximum L2 norm and add Gaussian noise proportional to the
 *      clipping norm × noise multiplier. This is the simplest
 *      integration: the server applies DP before aggregation.
 *   2. **Privacy accounting** — track the (ε, δ) budget consumed over
 *      the course of training using the Rényi Differential Privacy
 *      (RDP) accountant.
 *
 * Reference: Abadi et al., "Deep Learning with Differential Privacy"
 * (CCS 2016); Mironov, "Rényi Differential Privacy" (CSF 2017).
 *
 * @packageDocumentation
 */

import { generateKeyPairSync, randomFillSync } from 'node:crypto';
import type { ClientUpdate, DPConfig, ModelParameters, PrivacyBudget } from './types.js';
import { cloneParams } from './ModelManager.js';

/**
 * Applies differential privacy to federated updates.
 *
 * ```ts
 * const dp = new DifferentialPrivacy({ numRounds: 100, noiseMultiplier: 1.0 });
 * const priv = dp.clipAndNoise(update);  // per-update DP
 * const budget = dp.budget();            // (ε, δ) consumed so far
 * ```
 */
export class DifferentialPrivacy {
  /** Resolved DP configuration. */
  readonly #config: Required<Omit<DPConfig, 'numRounds'>> & { numRounds: number };
  /** Per-round Rényi DP orders that have been consumed. */
  readonly #rdpPerRound: number[];

  /**
   * @param config - DP configuration (see {@link DPConfig}).
   */
  constructor(config: DPConfig) {
    this.#config = {
      clippingNorm: config.clippingNorm ?? 1.0,
      noiseMultiplier: config.noiseMultiplier ?? 1.0,
      samplingRate: config.samplingRate ?? 0.01,
      numRounds: config.numRounds,
      delta: config.delta ?? 1e-5,
    };
    this.#rdpPerRound = [];
  }

  /**
   * Clip a single client update to the configured L2 norm and add
   * Gaussian noise with standard deviation
   * `noiseMultiplier × clippingNorm`. Returns a new
   * {@link ModelParameters} map; the input is not mutated.
   *
   * The RDP consumption for this round is recorded and can be queried
   * via {@link budget}.
   *
   * @param update - The client update to make differentially private.
   * @returns A new {@link ClientUpdate} whose `params` have been clipped
   *          and noised. The `clientId`, `round`, `numExamples`, and
   *          `metrics` fields are preserved.
   */
  clipAndNoise(update: ClientUpdate): ClientUpdate {
    const clipped = this.#clip(update.params);
    const noised = this.#addNoise(clipped);
    this.#recordRdp();
    return { ...update, params: noised };
  }

  /**
   * Apply DP to a batch of updates at once. Equivalent to calling
   * {@link clipAndNoise} on each update but records the RDP consumption
   * only once per call (the sampling rate is the per-round rate, not
   * per-update).
   *
   * @param updates - Updates to make differentially private.
   * @returns A new array of clipped + noised updates.
   */
  clipAndNoiseBatch(updates: readonly ClientUpdate[]): ClientUpdate[] {
    const out = updates.map((u) => {
      const clipped = this.#clip(u.params);
      const noised = this.#addNoise(clipped);
      return { ...u, params: noised };
    });
    this.#recordRdp();
    return out;
  }

  /**
   * Compute the current (ε, δ) privacy budget consumed so far, using
   * the Rényi Differential Privacy accountant. The RDP at order α is
   * `q^2 × T × α / σ²` (the moments accountant approximation for
   * subsampled Gaussian mechanism), and ε is the minimum over α of
   * `RDP(α) - log(δ) / (α - 1)`.
   *
   * @returns The current {@link PrivacyBudget}.
   */
  budget(): PrivacyBudget {
    if (this.#rdpPerRound.length === 0) {
      return { epsilon: 0, delta: this.#config.delta, method: 'rdp' };
    }
    const orders = [1.5, 2, 3, 4, 8, 16, 32, 64, 256];
    let bestEpsilon = Infinity;
    for (const alpha of orders) {
      const rdp = this.#rdpPerRound.reduce((sum, r) => sum + r(alpha), 0);
      // Convert RDP to (ε, δ)-DP: ε = RDP(α) + log(1/δ) / (α - 1).
      const eps = rdp + Math.log(1 / this.#config.delta) / (alpha - 1);
      if (eps < bestEpsilon) bestEpsilon = eps;
    }
    return {
      epsilon: bestEpsilon === Infinity ? 0 : bestEpsilon,
      delta: this.#config.delta,
      method: 'rdp',
    };
  }

  /** Reset the RDP accounting (start a new session). */
  reset(): void {
    this.#rdpPerRound.length = 0;
  }

  /**
   * Clip `params` to the configured L2 norm. The L2 norm of the entire
   * parameter vector (summed across tensors) is computed; if it exceeds
   * the clipping norm, every value is scaled down proportionally.
   *
   * @param params - The parameters to clip.
   * @returns A new (clipped) {@link ModelParameters} map.
   */
  #clip(params: ModelParameters): ModelParameters {
    let norm = 0;
    for (const arr of params.values()) {
      for (let i = 0; i < arr.length; i++) norm += arr[i]! * arr[i]!;
    }
    norm = Math.sqrt(norm);
    const scale = norm > this.#config.clippingNorm ? this.#config.clippingNorm / norm : 1;
    const out: ModelParameters = new Map();
    for (const [name, arr] of params) {
      const clipped = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) clipped[i] = arr[i]! * scale;
      out.set(name, clipped);
    }
    return out;
  }

  /**
   * Add Gaussian noise with standard deviation
   * `noiseMultiplier × clippingNorm` to every parameter value. Uses
   * Box-Muller for Gaussian sampling seeded by `node:crypto`'s
   * `randomFillSync` for cryptographic-quality randomness.
   */
  #addNoise(params: ModelParameters): ModelParameters {
    const sigma = this.#config.noiseMultiplier * this.#config.clippingNorm;
    if (sigma === 0) return cloneParams(params);
    const out: ModelParameters = new Map();
    for (const [name, arr] of params) {
      const noised = new Float64Array(arr.length);
      const buf = new Uint8Array(arr.length * 8);
      randomFillSync(buf);
      for (let i = 0; i < arr.length; i++) {
        // Box-Muller transform: convert uniform [0,1) to standard normal.
        const u1 = Math.max(1e-12, bytesToDouble(buf, i * 8));
        const u2 = bytesToDouble(buf, i * 8 + 4);
        const mag = sigma * Math.sqrt(-2 * Math.log(u1));
        // Use only the sin variant (one value per call) for simplicity.
        noised[i] = arr[i]! + mag * Math.sin(2 * Math.PI * u2);
      }
      out.set(name, noised);
    }
    return out;
  }

  /**
   * Record the RDP consumption for one round. The RDP at order α for
   * the subsampled Gaussian mechanism is approximated as
   * `q² × α / σ²` (valid when `q` is small; this is the leading term
   * of the moments accountant bound). Returns a function that computes
   * the RDP at a given α so the {@link budget} method can evaluate
   * multiple orders without re-doing the per-round bookkeeping.
   */
  #recordRdp(): void {
    const q = this.#config.samplingRate;
    const sigma = this.#config.noiseMultiplier;
    const rdpFn = (alpha: number): number => {
      // Leading term of the moments accountant bound for subsampled Gaussian.
      return (q * q * alpha) / (sigma * sigma);
    };
    this.#rdpPerRound.push(rdpFn);
  }
}

/** Convert 8 bytes from `buf` at `offset` to a double in `[0, 1)`. */
function bytesToDouble(buf: Uint8Array, offset: number): number {
  // Read 8 bytes as a 64-bit unsigned int, then divide by 2^64.
  // To avoid BigInt overhead, use only the first 6 bytes (48 bits) —
  // sufficient for the [0, 1) range with ~14 decimal digits of precision.
  let v = 0;
  for (let i = 0; i < 6; i++) {
    v = v * 256 + buf[offset + i]!;
  }
  return v / 281474976710656; // 2^48
}

/**
 * Generate a per-client key pair for secure update signing. The keys
 * can be used by clients to sign their updates so the server can verify
 * authenticity before aggregation.
 *
 * @returns An object with `privateKey` and `publicKey` PEM strings.
 */
export function generateClientKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

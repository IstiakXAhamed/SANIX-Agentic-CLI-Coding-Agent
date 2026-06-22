/**
 * @file types.ts
 * @description Shared type definitions for `@sanix/federated`. Covers
 * model parameters, client updates, aggregation strategies, differential
 * privacy configuration, and round-level statistics.
 *
 * The model representation is intentionally a flat `Map<string, Float64Array>`
 * (parameter name → tensor as a typed array). This keeps the package
 * dependency-free while being rich enough to express real models
 * (each `Float64Array` is one tensor: weights, biases, etc.).
 *
 * @packageDocumentation
 */

/** A model's parameters keyed by tensor name. */
export type ModelParameters = Map<string, Float64Array>;

/** A single client's update for one round. */
export interface ClientUpdate {
  /** Stable unique client id (nanoid). */
  readonly clientId: string;
  /** Round number this update belongs to (0-indexed). */
  readonly round: number;
  /** Updated model parameters produced by the client's local training. */
  readonly params: ModelParameters;
  /** Number of training examples the client used. */
  readonly numExamples: number;
  /** Optional training metrics (loss, accuracy). */
  readonly metrics?: Readonly<Record<string, number>>;
  /** Optional computed checksum of `params` for integrity verification. */
  readonly checksum?: string;
}

/** Statistics about a single aggregation round. */
export interface RoundStats {
  /** Round number (0-indexed). */
  readonly round: number;
  /** Number of clients that contributed updates. */
  readonly numClients: number;
  /** Wall-clock duration of the round in milliseconds. */
  readonly durationMs: number;
  /** Aggregate of client metrics (mean per metric). */
  readonly metrics: Readonly<Record<string, number>>;
  /** Aggregation strategy used. */
  readonly strategy: AggregationStrategyName;
  /** Number of updates excluded by the strategy (e.g. Krum's outliers). */
  readonly excluded: number;
}

/** The set of aggregation strategy names. */
export type AggregationStrategyName =
  | 'fedavg'
  | 'fedprox'
  | 'krum'
  | 'trimmed-mean'
  | 'median';

/** Common options accepted by every aggregation strategy. */
export interface AggregationOptions {
  /** Per-client weights (e.g. proportional to `numExamples`). If absent, equal weights are used. */
  readonly weights?: readonly number[];
}

/** FedProx-specific options. */
export interface FedProxOptions extends AggregationOptions {
  /** Proximal penalty coefficient (μ in the FedProx paper). Default `0.001`. */
  readonly mu?: number;
}

/** Krum-specific options. */
export interface KrumOptions extends AggregationOptions {
  /** Number of nearest neighbours to consider. Default: `max(1, n - 2)` where n is the number of updates. */
  readonly m?: number;
  /** Number of byzantine (malicious) clients to defend against. Default `floor((n - 2) / 2)`. */
  readonly byzantine?: number;
}

/** TrimmedMean-specific options. */
export interface TrimmedMeanOptions extends AggregationOptions {
  /** Fraction of values to trim from each end (in `[0, 0.5)`). Default `0.1`. */
  readonly beta?: number;
}

/** The unified options type accepted by the strategy factory. */
export type StrategyOptions =
  | AggregationOptions
  | FedProxOptions
  | KrumOptions
  | TrimmedMeanOptions;

/** Differential privacy configuration. */
export interface DPConfig {
  /** L2 norm bound for per-example gradient clipping. Default `1.0`. */
  readonly clippingNorm?: number;
  /** Noise multiplier (σ in DP-SGD). Noise std = σ × clippingNorm. Default `1.0`. */
  readonly noiseMultiplier?: number;
  /** Sampling probability for each round. Default `0.01`. */
  readonly samplingRate?: number;
  /** Total number of rounds. Required to compute the privacy budget. */
  readonly numRounds: number;
  /** Delta for (ε, δ)-DP. Default `1e-5`. */
  readonly delta?: number;
}

/** A privacy budget estimate. */
export interface PrivacyBudget {
  /** The ε (epsilon) value. Lower = more private. */
  readonly epsilon: number;
  /** The δ (delta) value. */
  readonly delta: number;
  /** The accounting method used (e.g. `"rdp"` for Rényi DP). */
  readonly method: string;
}

/** Status of a federated round. */
export type RoundStatus = 'pending' | 'collecting' | 'aggregating' | 'complete' | 'failed';

/** Options for the {@link FederatedManager}. */
export interface FederatedManagerOptions {
  /** Aggregation strategy name. Default `'fedavg'`. */
  readonly strategy?: AggregationStrategyName;
  /** Strategy-specific options. */
  readonly strategyOptions?: StrategyOptions;
  /** Minimum number of clients required before aggregation can run. Default `2`. */
  readonly minClients?: number;
  /** Maximum number of clients per round (subsampled). `0` = all. Default `0`. */
  readonly maxClients?: number;
  /** Differential privacy configuration. Optional. */
  readonly dp?: DPConfig;
  /** Whether to verify client checksums before aggregation. Default `true`. */
  readonly verifyChecksums?: boolean;
}

/** Events emitted by {@link FederatedManager}. */
export interface FederatedManagerEvents {
  /** Fired when a round starts (collecting phase begins). */
  roundStart: (round: number) => void;
  /** Fired when a client submits an update. */
  updateReceived: (update: ClientUpdate) => void;
  /** Fired when aggregation begins. */
  aggregating: (round: number) => void;
  /** Fired when a round completes. */
  roundComplete: (stats: RoundStats, params: ModelParameters) => void;
  /** Fired when a round fails. */
  roundFailed: (round: number, error: Error) => void;
}

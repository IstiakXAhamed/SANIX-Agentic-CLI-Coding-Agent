/**
 * @file memory-v2/src/ForgettingCurve.ts
 * @description Ebbinghaus forgetting-curve model for memory decay.
 *
 * Models retention as an exponential decay over time:
 *
 *   R = e^(-t / S)
 *
 * where:
 *   - `R` = retention (0..1) — probability the memory is still "accessible".
 *   - `t` = elapsed time since last access.
 *   - `S` = stability — the time constant of decay. Higher = slower decay.
 *
 * Each successful recall strengthens the memory (spaced repetition):
 *
 *   S_new = S_old * (1 + β * (1 - R))
 *
 * where `β` is a learning-rate constant (default 0.5). The less the
 * memory was retained (`R` near 0), the bigger the stability bump —
 * this mirrors the empirical finding that difficult recalls produce
 * stronger memory traces.
 *
 * `t` and `S` are in **epoch milliseconds** throughout this module.
 * Callers can convert from other units before passing values in.
 *
 * @packageDocumentation
 */

/** A memory's forgetting-relevant fields. */
export interface ForgettingMemory {
  /** Epoch ms of last access. */
  lastAccessedAt: number;
  /** Stability in epoch ms (higher = slower decay). */
  stability: number;
  /** Epoch ms of creation (used for sanity checks / default stability). */
  createdAt: number;
}

/** Constructor options. */
export interface ForgettingCurveOptions {
  /**
   * Learning rate β for the stability update. Default 0.5. Larger values
   * cause stability to grow faster on each recall.
   */
  beta?: number;
  /**
   * Default stability (in epoch ms) for new memories that haven't been
   * recalled yet. Default: 24 hours (`86_400_000`).
   */
  defaultStability?: number;
  /**
   * Target retention for `nextReview()`. Default 0.9 (i.e. return the
   * time at which retention drops to 90%).
   */
  targetRetention?: number;
}

/** Default stability: 24 hours in ms. */
const DEFAULT_STABILITY_MS = 24 * 60 * 60 * 1000;

/** Default retention threshold below which a memory is "forgettable". */
export const DEFAULT_FORGET_THRESHOLD = 0.05;

/**
 * Ebbinghaus forgetting-curve model.
 *
 * @example
 * ```ts
 * const curve = new ForgettingCurve();
 * const R = curve.retention({
 *   lastAccessedAt: Date.now() - 3600_000,  // 1 hour ago
 *   stability: 86_400_000,                  // 1 day
 *   createdAt: Date.now() - 7 * 86_400_000, // 1 week ago
 * });
 * console.log(`retention: ${R.toFixed(3)}`); // ~0.964
 * ```
 */
export class ForgettingCurve {
  private readonly beta: number;
  private readonly defaultStability: number;
  private readonly targetRetention: number;

  constructor(opts: ForgettingCurveOptions = {}) {
    this.beta = opts.beta ?? 0.5;
    this.defaultStability = opts.defaultStability ?? DEFAULT_STABILITY_MS;
    this.targetRetention = opts.targetRetention ?? 0.9;
  }

  /**
   * Compute the current retention `R = e^(-t / S)` for a memory.
   *
   * `t` is `now - lastAccessedAt` (clamped to >= 0). If `stability` is
   * <= 0 (or unset), `defaultStability` is used.
   *
   * @example
   * ```ts
   * const R = curve.retention(memory);
   * if (R < 0.1) console.log('almost forgotten');
   * ```
   */
  retention(memory: ForgettingMemory): number {
    const now = Date.now();
    const t = Math.max(0, now - memory.lastAccessedAt);
    const S = memory.stability > 0 ? memory.stability : this.defaultStability;
    return Math.exp(-t / S);
  }

  /**
   * Update a memory's stability after a recall event, per the spaced-
   * repetition formula `S_new = S_old * (1 + β * (1 - R))`.
   *
   * @param memory - The memory's current `stability` and `lastAccessedAt`.
   * @param now    - Epoch ms of the recall (typically `Date.now()`).
   * @returns The new stability and the retention computed just before
   *          the update (useful for logging / debugging).
   *
   * @example
   * ```ts
   * const { stability } = curve.updateStability(memory, Date.now());
   * memory.stability = stability;
   * memory.lastAccessedAt = Date.now();
   * ```
   */
  updateStability(
    memory: { stability: number; lastAccessedAt: number },
    now: number,
  ): { stability: number; retention: number } {
    const t = Math.max(0, now - memory.lastAccessedAt);
    const S = memory.stability > 0 ? memory.stability : this.defaultStability;
    const R = Math.exp(-t / S);
    const newStability = S * (1 + this.beta * (1 - R));
    return { stability: newStability, retention: R };
  }

  /**
   * True if the memory's current retention is below `threshold` (default
   * 0.05). Such memories are candidates for pruning by the
   * {@link MemoryCompactor}.
   *
   * @example
   * ```ts
   * if (curve.shouldForget(memory)) {
   *   await prune(memory.id);
   * }
   * ```
   */
  shouldForget(
    memory: ForgettingMemory,
    threshold: number = DEFAULT_FORGET_THRESHOLD,
  ): boolean {
    return this.retention(memory) < threshold;
  }

  /**
   * Compute the epoch-ms timestamp at which the memory's retention will
   * drop to `targetRetention` (default 0.9). This is the optimal time
   * to schedule a review — earlier and the recall is too easy to
   * strengthen the trace; later and the memory has decayed too far.
   *
   * Formula: `t_target = -S * ln(targetR)` from `R = e^(-t/S)`.
   *
   * @example
   * ```ts
   * const reviewAt = curve.nextReview(memory);
   * scheduler.at(reviewAt, () => surface(memory));
   * ```
   */
  nextReview(memory: ForgettingMemory): number {
    const S = memory.stability > 0 ? memory.stability : this.defaultStability;
    const tTarget = -S * Math.log(Math.max(this.targetRetention, 1e-12));
    return memory.lastAccessedAt + Math.max(0, tTarget);
  }
}

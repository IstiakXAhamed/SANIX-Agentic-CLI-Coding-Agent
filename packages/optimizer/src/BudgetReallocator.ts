/**
 * @file BudgetReallocator.ts
 * @description Dynamic per-tier budget reallocation. Monitors actual
 * token usage per tier across iterations and reallocates surplus from
 * under-used tiers to over-budget tiers.
 *
 * Algorithm:
 *   - Each call to {@link observe} updates an exponential moving
 *     average (EMA, α=0.3) of per-tier token usage.
 *   - {@link reallocate} compares the EMA against the base allocation:
 *       * Tiers using <50% of their budget are "under-used" → surplus
 *         candidates.
 *       * Tiers using >100% of their budget are "over-used" →
 *         recipients.
 *   - Surplus is redistributed proportionally to over-use, but no tier
 *     drops below 50% of its base allocation (safety floor) and no
 *     tier exceeds 200% of its base (sanity ceiling).
 *
 * The reallocator is stateless across sessions — the EMA is reset on
 * construction. Persisting it would require a config integration that
 * the optimizer package deliberately avoids.
 *
 * @packageDocumentation
 */

/**
 * Per-tier token usage (actual tokens consumed). Mirrors the shape of
 * {@link BudgetAllocation} so the two are interchangeable in callers.
 */
export interface TierUsage {
  /** Tokens consumed by the system prompt tier. */
  system: number;
  /** Tokens consumed by the memory tier. */
  memory: number;
  /** Tokens consumed by the plan tier. */
  plan: number;
  /** Tokens consumed by the history tier. */
  history: number;
  /** Tokens consumed by the context tier. */
  context: number;
  /** Tokens consumed by the output tier. */
  output: number;
}

/**
 * Per-tier budget allocation. Identical shape to {@link TierUsage};
 * re-declared here so the optimizer package is self-contained (no
 * import from `@sanix/core`, which would create a cycle).
 */
export interface BudgetAllocation {
  system: number;
  memory: number;
  plan: number;
  history: number;
  context: number;
  output: number;
}

/**
 * The six tier names, in a stable order used by the reallocator's
 * internal arrays.
 */
const TIER_NAMES = ['system', 'memory', 'plan', 'history', 'context', 'output'] as const;
type TierName = (typeof TIER_NAMES)[number];

/**
 * EMA smoothing factor. 0.3 means "new observations weigh 30%,
 * history weighs 70%" — slow enough to ignore a single outlier
 * iteration, fast enough to adapt within ~5 iterations.
 */
const EMA_ALPHA = 0.3;

/**
 * Safety floor: a tier's reallocated budget will never drop below
 * `BASE * SAFETY_FLOOR_FRACTION`. 0.5 = 50%.
 */
const SAFETY_FLOOR_FRACTION = 0.5;

/**
 * Sanity ceiling: a tier's reallocated budget will never exceed
 * `BASE * CEILING_FRACTION`. 2.0 = 200%.
 */
const CEILING_FRACTION = 2.0;

/**
 * Under-use threshold: a tier using less than this fraction of its
 * budget is a surplus candidate. 0.5 = 50%.
 */
const UNDER_USE_FRACTION = 0.5;

/**
 * Dynamic budget reallocator.
 *
 * @example
 * ```ts
 * const r = new DynamicBudgetReallocator();
 * const base = { system: 5000, memory: 10000, plan: 2500,
 *                history: 12500, context: 15000, output: 5000 };
 * // Simulate 3 iterations where context over-uses and memory under-uses.
 * r.observe({ ...base, context: 18000, memory: 4000 });
 * r.observe({ ...base, context: 19000, memory: 3500 });
 * r.observe({ ...base, context: 17500, memory: 4500 });
 * const adjusted = r.reallocate(base);
 * // adjusted.context > base.context (recipient)
 * // adjusted.memory < base.memory (donor, but >= 50% of base)
 * ```
 */
export class DynamicBudgetReallocator {
  /**
   * Per-tier EMA of observed usage. `null` until the first observation
   * (so the first call seeds the EMA rather than averaging against 0).
   */
  private ema: Record<TierName, number> = {
    system: 0,
    memory: 0,
    plan: 0,
    history: 0,
    context: 0,
    output: 0,
  };

  /** Whether {@link observe} has been called at least once. */
  private hasObservation = false;

  /** Number of observations recorded. */
  private observationCount = 0;

  /**
   * Record a per-tier usage observation. Updates the EMA.
   *
   * @example
   * ```ts
   * r.observe({ system: 800, memory: 4500, plan: 600,
   *             history: 9000, context: 12000, output: 0 });
   * ```
   */
  observe(usage: TierUsage): void {
    for (const tier of TIER_NAMES) {
      const observed = usage[tier];
      if (!this.hasObservation) {
        // Seed the EMA with the first observation.
        this.ema[tier] = observed;
      } else {
        this.ema[tier] = EMA_ALPHA * observed + (1 - EMA_ALPHA) * this.ema[tier];
      }
    }
    this.hasObservation = true;
    this.observationCount++;
  }

  /**
   * Reallocate the base allocation based on observed usage. Returns a
   * new allocation (the input is not mutated).
   *
   * The algorithm:
   *   1. For each tier, compute `ratio = EMA / BASE`.
   *   2. Tiers with `ratio < UNDER_USE_FRACTION` are donors: their
   *      surplus (BASE - EMA, clipped to keep ≥ SAFETY_FLOOR_FRACTION
   *      of BASE) is collected into a pool.
   *   3. Tiers with `ratio > 1.0` are recipients: they receive a
   *      share of the pool proportional to their over-use
   *      (`EMA - BASE`), capped at CEILING_FRACTION of BASE.
   *   4. If no donors or no recipients, return the base unchanged.
   *
   * Early-out: if fewer than 2 observations have been recorded, return
   * the base unchanged (the EMA hasn't converged enough to trust).
   */
  reallocate(base: BudgetAllocation): BudgetAllocation {
    if (this.observationCount < 2) return { ...base };

    // Step 1: compute ratios + identify donors / recipients.
    const ratios: Record<TierName, number> = {
      system: 0, memory: 0, plan: 0, history: 0, context: 0, output: 0,
    };
    const donors: TierName[] = [];
    const recipients: Array<{ tier: TierName; overUse: number }> = [];
    let pool = 0;

    for (const tier of TIER_NAMES) {
      const b = base[tier];
      const ema = this.ema[tier];
      if (b <= 0) {
        ratios[tier] = 0;
        continue;
      }
      const ratio = ema / b;
      ratios[tier] = ratio;

      if (ratio < UNDER_USE_FRACTION) {
        // Donor: give up the unused portion, but never below the safety
        // floor. The donor's contribution to the pool is:
        //   BASE * (1 - SAFETY_FLOOR_FRACTION) - EMA
        // ...clamped to >= 0 (if EMA > BASE * 0.5 the donor isn't
        // actually under-using enough to give anything back).
        const floor = Math.floor(b * SAFETY_FLOOR_FRACTION);
        const surplus = Math.max(0, b - Math.max(ema, floor));
        pool += surplus;
        donors.push(tier);
      } else if (ratio > 1.0) {
        // Recipient: receives a share proportional to over-use.
        recipients.push({ tier, overUse: ema - b });
      }
    }

    if (pool <= 0 || recipients.length === 0) return { ...base };

    // Step 2: distribute the pool to recipients proportional to over-use.
    const totalOverUse = recipients.reduce((acc, r) => acc + r.overUse, 0);
    const adjusted: BudgetAllocation = { ...base };

    // Reduce donor budgets by their contributed surplus.
    for (const tier of donors) {
      const b = base[tier];
      const floor = Math.floor(b * SAFETY_FLOOR_FRACTION);
      const surplus = Math.max(0, b - Math.max(this.ema[tier], floor));
      adjusted[tier] = Math.max(floor, b - surplus);
    }

    // Increase recipient budgets by their share of the pool, capped at
    // CEILING_FRACTION of base.
    for (const r of recipients) {
      const share = totalOverUse > 0 ? (r.overUse / totalOverUse) * pool : 0;
      const cap = Math.floor(base[r.tier] * CEILING_FRACTION);
      adjusted[r.tier] = Math.min(cap, adjusted[r.tier] + Math.floor(share));
    }

    return adjusted;
  }

  /**
   * Current EMA per tier. Useful for diagnostics / TUI display.
   */
  getEma(): TierUsage {
    return { ...this.ema };
  }

  /**
   * Number of observations recorded so far.
   */
  get count(): number {
    return this.observationCount;
  }

  /**
   * Reset the EMA and observation count. Useful when the agent switches
   * tasks (a new task may have very different per-tier usage patterns
   * than the previous one, so the old EMA is misleading).
   */
  reset(): void {
    this.ema = { system: 0, memory: 0, plan: 0, history: 0, context: 0, output: 0 };
    this.hasObservation = false;
    this.observationCount = 0;
  }
}

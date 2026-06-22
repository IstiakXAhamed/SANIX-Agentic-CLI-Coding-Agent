/**
 * @file rng.ts
 * @description Seedable pseudo-random number generator (mulberry32). Used
 * by {@link Selection} and {@link EvolutionEngine} to make evolutionary
 * runs reproducible.
 *
 * @packageDocumentation
 */

/**
 * A seedable RNG — drop-in replacement for the parts of `Math.random()` the
 * evolutionary loop needs. Same seed → identical sequence.
 */
export interface Rng {
  /** Return a float in [0, 1). */
  next(): number;
  /** Return an int in [0, max). */
  nextInt(max: number): number;
  /** Pick a random element from an array. */
  pick<T>(arr: readonly T[]): T;
  /** Shuffle a copy of the array (Fisher–Yates). */
  shuffle<T>(arr: readonly T[]): T[];
}

/**
 * Build a seedable mulberry32 RNG.
 *
 * @example
 * ```ts
 * const rng = createRng(42);
 * rng.next();          // → 0.747...
 * rng.pick([1,2,3]);   // deterministic given the seed
 * ```
 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nextInt = (max: number): number => Math.floor(next() * Math.max(1, max));
  const pick = <T>(arr: readonly T[]): T => {
    if (arr.length === 0) throw new Error('rng.pick: empty array');
    return arr[nextInt(arr.length)]!;
  };
  const shuffle = <T>(arr: readonly T[]): T[] => {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = nextInt(i + 1);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  };
  return { next, nextInt, pick, shuffle };
}

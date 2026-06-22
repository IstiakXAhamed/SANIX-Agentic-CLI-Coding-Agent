/**
 * @file TokenSavingsReporter.ts
 * @description Accumulates per-stage token counts and emits a final
 * {@link TokenSavingsReport}. Used by {@link TokenSlimManager} to surface
 * "you saved 47% (1,204 tokens)" stats after each pipeline run.
 *
 * @packageDocumentation
 */

import type { StageResult, TokenSavingsReport } from './types.js';

/**
 * Accumulates stage results and produces a final report.
 *
 * @example
 * ```ts
 * const rep = new TokenSavingsReporter();
 * rep.record('minify', 1000, 850, 5);
 * rep.record('dedup',  850, 720, 2);
 * rep.finalize(); // → TokenSavingsReport
 * ```
 */
export class TokenSavingsReporter {
  private stages: StageResult[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Record a single stage's before/after token counts.
   *
   * @param name Stage name.
   * @param before Tokens before the stage.
   * @param after Tokens after the stage.
   * @param elapsedMs Wall-clock ms spent in the stage.
   */
  record(name: string, before: number, after: number, elapsedMs: number): void {
    this.stages.push({ name, before, after, elapsedMs });
  }

  /**
   * Produce the final savings report.
   *
   * @returns The {@link TokenSavingsReport}.
   */
  finalize(): TokenSavingsReport {
    if (this.stages.length === 0) {
      return {
        originalTokens: 0,
        finalTokens: 0,
        tokensSaved: 0,
        percentSaved: 0,
        perStage: {},
        elapsedMs: Date.now() - this.startTime,
      };
    }
    const originalTokens = this.stages[0].before;
    const finalTokens = this.stages[this.stages.length - 1].after;
    const tokensSaved = Math.max(0, originalTokens - finalTokens);
    const percentSaved = originalTokens > 0 ? (tokensSaved / originalTokens) * 100 : 0;
    const perStage: Record<string, { before: number; after: number }> = {};
    for (const s of this.stages) perStage[s.name] = { before: s.before, after: s.after };
    return {
      originalTokens,
      finalTokens,
      tokensSaved,
      percentSaved: Math.round(percentSaved * 100) / 100,
      perStage,
      elapsedMs: Date.now() - this.startTime,
    };
  }
}

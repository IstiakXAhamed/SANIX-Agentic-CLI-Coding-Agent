/**
 * @file HealthCheck.ts
 * @description Register named async health checks and run them all with a
 * per-check timeout (default 5s). Returns a {@link HealthCheckResult} per
 * check, suitable for surfacing in a `/healthz` endpoint or CLI status.
 *
 * @packageDocumentation
 */

import type { HealthCheck as HealthCheckDef, HealthCheckResult } from './types.js';

/** Default per-check timeout (ms). */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * A registry of health checks.
 *
 * @example
 * ```ts
 * const h = new HealthCheck();
 * h.register('db', async () => { await db.ping(); }, { timeoutMs: 1000 });
 * const results = await h.runAll();
 * results.filter(r => !r.ok); // failing checks
 * ```
 */
export class HealthCheck {
  private readonly checks = new Map<string, HealthCheckDef>();

  /**
   * Register a check.
   *
   * @param name Unique check name.
   * @param run The check implementation. Returns void or throws on failure.
   * @param opts.timeoutMs Per-check timeout (default 5s).
   */
  register(
    name: string,
    run: () => Promise<void> | void,
    opts: { timeoutMs?: number } = {},
  ): void {
    this.checks.set(name, { name, run, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  /** Unregister a check. */
  unregister(name: string): boolean {
    return this.checks.delete(name);
  }

  /** All registered check names. */
  names(): string[] {
    return [...this.checks.keys()];
  }

  /**
   * Run a single check by name.
   *
   * @param name Check name.
   */
  async runOne(name: string): Promise<HealthCheckResult> {
    const check = this.checks.get(name);
    if (!check) return { name, ok: false, durationMs: 0, error: 'no such check' };
    return runCheck(check);
  }

  /**
   * Run all registered checks in parallel.
   *
   * @returns A list of {@link HealthCheckResult} (one per check).
   */
  async runAll(): Promise<HealthCheckResult[]> {
    const checks = [...this.checks.values()];
    return Promise.all(checks.map(runCheck));
  }
}

/** Run a single check with its timeout. */
async function runCheck(check: HealthCheckDef): Promise<HealthCheckResult> {
  const start = Date.now();
  const timeout = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    await Promise.race([
      Promise.resolve().then(() => check.run()),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeout}ms`)), timeout),
      ),
    ]);
    return { name: check.name, ok: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name: check.name,
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

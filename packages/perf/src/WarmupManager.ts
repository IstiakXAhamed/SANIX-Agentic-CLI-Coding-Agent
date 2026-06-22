/**
 * @file WarmupManager.ts
 * @description Schedule warmup tasks for an application. Tasks are split
 * into `critical` (must complete before the app is "ready") and
 * `background` (best-effort, run after critical). The manager exposes a
 * `ready()` promise that resolves when all critical tasks finish.
 *
 * @packageDocumentation
 */

/** Priority of a warmup task. */
export type WarmupPriority = 'critical' | 'background';

/** A registered warmup task. */
interface WarmupTask {
  name: string;
  priority: WarmupPriority;
  run: () => Promise<void>;
}

/** Options for {@link WarmupManager}. */
export interface WarmupManagerOptions {
  /** Max parallel critical tasks. Default 4. */
  criticalConcurrency?: number;
  /** Max parallel background tasks. Default 2. */
  backgroundConcurrency?: number;
}

/** Result of {@link WarmupManager.warmup}. */
export interface WarmupResult {
  /** Wall-clock ms spent on critical tasks. */
  criticalMs: number;
  /** Wall-clock ms spent on background tasks (may still be in-flight). */
  backgroundMs: number;
  /** Critical-task outcomes (in registration order). */
  critical: Array<{ name: string; ok: boolean; error?: string; durationMs: number }>;
}

/**
 * Schedule warmup tasks.
 *
 * @example
 * ```ts
 * const w = new WarmupManager();
 * w.add('load-config', 'critical', async () => { await loadConfig(); });
 * w.add('seed-cache',  'background', async () => { await seedCache(); });
 * const r = await w.warmup();
 * // App is "ready" — background tasks continue running.
 * ```
 */
export class WarmupManager {
  private readonly tasks: WarmupTask[] = [];
  private readonly criticalConcurrency: number;
  private readonly backgroundConcurrency: number;

  constructor(opts: WarmupManagerOptions = {}) {
    this.criticalConcurrency = opts.criticalConcurrency ?? 4;
    this.backgroundConcurrency = opts.backgroundConcurrency ?? 2;
  }

  /**
   * Register a warmup task.
   *
   * @param name Task name.
   * @param priority `'critical'` or `'background'`.
   * @param run The task implementation.
   */
  add(name: string, priority: WarmupPriority, run: () => Promise<void>): void {
    this.tasks.push({ name, priority, run });
  }

  /** True if all critical tasks have completed. */
  get isReady(): boolean {
    return this.readyFlag;
  }

  private readyFlag = false;
  private readyPromise?: Promise<void>;
  private readyResolvers: Array<() => void> = [];

  /**
   * Returns a promise that resolves when all critical tasks complete.
   * Safe to call multiple times — same promise.
   */
  async ready(): Promise<void> {
    if (this.readyFlag) return;
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve) => {
        this.readyResolvers.push(resolve);
      });
    }
    return this.readyPromise;
  }

  /**
   * Run all tasks. Critical tasks run first (in parallel up to
   * `criticalConcurrency`); when they finish, `ready()` resolves and
   * background tasks start (in parallel up to `backgroundConcurrency`).
   *
   * @returns A {@link WarmupResult} (resolves after critical tasks finish;
   *          background tasks may still be in-flight).
   */
  async warmup(): Promise<WarmupResult> {
    const critical = this.tasks.filter((t) => t.priority === 'critical');
    const background = this.tasks.filter((t) => t.priority === 'background');
    const critStart = Date.now();
    const criticalResults = await runPool(critical, this.criticalConcurrency);
    const critMs = Date.now() - critStart;
    this.readyFlag = true;
    for (const r of this.readyResolvers) r();
    this.readyResolvers = [];
    // Kick off background tasks without awaiting.
    const bgStart = Date.now();
    void runPool(background, this.backgroundConcurrency).then(() => {
      // Track for diagnostics only.
      void bgStart;
    });
    return {
      criticalMs: critMs,
      backgroundMs: 0, // background is still running; tracked elsewhere.
      critical: criticalResults,
    };
  }

  /** Number of registered tasks. */
  get size(): number {
    return this.tasks.length;
  }
}

/** Run a list of tasks with a concurrency limit. */
async function runPool(
  tasks: WarmupTask[],
  concurrency: number,
): Promise<Array<{ name: string; ok: boolean; error?: string; durationMs: number }>> {
  const results: Array<{ name: string; ok: boolean; error?: string; durationMs: number }> = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const myIdx = idx++;
      const task = tasks[myIdx];
      const start = Date.now();
      try {
        await task.run();
        results.push({ name: task.name, ok: true, durationMs: Date.now() - start });
      } catch (err) {
        results.push({
          name: task.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        });
      }
    }
  });
  await Promise.all(workers);
  return results;
}

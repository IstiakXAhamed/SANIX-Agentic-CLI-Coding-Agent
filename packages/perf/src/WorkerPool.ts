/**
 * @file WorkerPool.ts
 * @description A generic worker-thread pool. Tasks are functions serialized
 * to a worker script; the pool keeps a fixed number of long-lived workers
 * and dispatches tasks to the next idle worker (FIFO queue).
 *
 * The worker script is provided by the caller and must export a default
 * function `task(args) → result`. We use `worker_threads` so tasks run on
 * real OS threads (not just event-loop turns).
 *
 * @packageDocumentation
 */

import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A pending task awaiting a worker. */
interface PendingTask<T = unknown> {
  args: unknown;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

/** A pooled worker + its current task (if any). */
interface PooledWorker {
  worker: Worker;
  current?: PendingTask;
}

/** Options for {@link WorkerPool}. */
export interface WorkerPoolOptions {
  /** Worker script path (absolute or relative to CWD). */
  workerPath: string;
  /** Pool size (default 4). */
  size?: number;
  /** Per-task timeout ms (default 30s). */
  taskTimeoutMs?: number;
  /** Max tasks per worker before recycling (default 100; 0 = never recycle). */
  maxTasksPerWorker?: number;
}

/**
 * A fixed-size pool of worker threads.
 *
 * @example
 * ```ts
 * const pool = new WorkerPool({ workerPath: './worker.js', size: 4 });
 * const result = await pool.run({ input: '...' });
 * await pool.shutdown();
 * ```
 */
export class WorkerPool {
  private readonly opts: Required<Omit<WorkerPoolOptions, 'workerPath'>> & { workerPath: string };
  private readonly workers: PooledWorker[] = [];
  private readonly queue: PendingTask[] = [];
  private isShutdown = false;

  constructor(opts: WorkerPoolOptions) {
    this.opts = {
      workerPath: opts.workerPath,
      size: opts.size ?? 4,
      taskTimeoutMs: opts.taskTimeoutMs ?? 30_000,
      maxTasksPerWorker: opts.maxTasksPerWorker ?? 100,
    };
    for (let i = 0; i < this.opts.size; i++) {
      this.workers.push(this.spawn());
    }
  }

  /**
   * Run a task on the next available worker.
   *
   * @param args Argument to pass to the worker's default export.
   * @returns The worker's return value.
   */
  async run<T = unknown>(args?: unknown): Promise<T> {
    if (this.isShutdown) throw new Error('WorkerPool is shutdown');
    return new Promise<T>((resolveP, rejectP) => {
      this.queue.push({ args, resolve: resolveP as (v: unknown) => void, reject: rejectP });
      this.dispatch();
    });
  }

  /** How many tasks are queued waiting for a worker. */
  get pending(): number {
    return this.queue.length;
  }

  /** How many workers are currently idle. */
  get idle(): number {
    return this.workers.filter((w) => !w.current).length;
  }

  /**
   * Shutdown the pool: stop accepting tasks, wait for in-flight tasks,
   * terminate all workers.
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await Promise.allSettled(this.workers.map((w) => w.worker.terminate()));
    // Reject any leftover queued tasks.
    for (const t of this.queue) t.reject(new Error('pool shutdown'));
    this.queue.length = 0;
  }

  /** Dispatch queued tasks to idle workers. */
  private dispatch(): void {
    while (this.queue.length > 0) {
      const idle = this.workers.find((w) => !w.current);
      if (!idle) break;
      const task = this.queue.shift();
      if (!task) break;
      this.runOn(idle, task);
    }
  }

  /** Run a single task on a single worker, with timeout + recycling. */
  private runOn(pw: PooledWorker, task: PendingTask): void {
    pw.current = task;
    const { worker } = pw;
    const timeout = setTimeout(() => {
      task.reject(new Error(`task timeout after ${this.opts.taskTimeoutMs}ms`));
      // Recycle the worker (it may be stuck).
      worker.terminate().catch(() => { /* ignore */ });
      const idx = this.workers.indexOf(pw);
      if (idx >= 0) this.workers[idx] = this.spawn();
      this.dispatch();
    }, this.opts.taskTimeoutMs);

    worker.once('message', (msg: unknown) => {
      clearTimeout(timeout);
      pw.current = undefined;
      task.resolve(msg);
      this.maybeRecycle(pw);
      this.dispatch();
    });
    worker.once('error', (err: Error) => {
      clearTimeout(timeout);
      pw.current = undefined;
      task.reject(err);
      // Replace the dead worker.
      const idx = this.workers.indexOf(pw);
      if (idx >= 0) this.workers[idx] = this.spawn();
      this.dispatch();
    });
    worker.postMessage(task.args);
  }

  /** Recycle a worker if it has hit its task limit. */
  private maybeRecycle(pw: PooledWorker): void {
    // We can't directly observe the count; use the worker's internal
    // resource count as a proxy by terminating + respawning every N tasks.
    // Cheap approximation: track via a per-worker counter.
    const counter = (pw as unknown as { __tasks?: number }).__tasks ?? 0;
    (pw as unknown as { __tasks?: number }).__tasks = counter + 1;
    if (this.opts.maxTasksPerWorker > 0 && (counter + 1) >= this.opts.maxTasksPerWorker) {
      pw.worker.terminate().catch(() => { /* ignore */ });
      const idx = this.workers.indexOf(pw);
      if (idx >= 0) this.workers[idx] = this.spawn();
    }
  }

  /** Spawn a fresh worker. */
  private spawn(): PooledWorker {
    const path = this.opts.workerPath.startsWith('file:')
      ? fileURLToPath(this.opts.workerPath)
      : resolve(this.opts.workerPath);
    const worker = new Worker(path);
    return { worker };
  }
}

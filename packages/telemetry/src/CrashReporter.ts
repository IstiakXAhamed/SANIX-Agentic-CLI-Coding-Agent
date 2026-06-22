/**
 * @file CrashReporter.ts
 * @description Install global handlers for `uncaughtException`,
 * `unhandledRejection`, and `SIGTERM` / `SIGINT` that capture the error
 * via an {@link ErrorMonitor}, flush all transports, and exit.
 *
 * The handlers are intentionally minimal — they capture + flush + exit,
 * matching Node's recommended pattern for production crash reporters.
 *
 * @packageDocumentation
 */

import type { ErrorMonitor } from './ErrorMonitor.js';

/** Options for {@link CrashReporter}. */
export interface CrashReporterOptions {
  /** Exit code on uncaught exception. Default 1. */
  exitCode?: number;
  /** Whether to also handle SIGINT/SIGTERM. Default true. */
  handleSignals?: boolean;
  /** Flush timeout ms (we won't wait longer than this). Default 3000. */
  flushTimeoutMs?: number;
}

/**
 * Install global crash handlers. Returns a `dispose()` function that
 * uninstalls them (useful for tests).
 *
 * @example
 * ```ts
 * const dispose = CrashReporter.install(monitor);
 * // ... later ...
 * dispose();
 * ```
 */
export const CrashReporter = {
  /**
   * Install the global handlers.
   *
   * @param monitor The {@link ErrorMonitor} to capture with.
   * @param opts See {@link CrashReporterOptions}.
   * @returns A `dispose()` function that uninstalls the handlers.
   */
  install(monitor: ErrorMonitor, opts: CrashReporterOptions = {}): () => void {
    const exitCode = opts.exitCode ?? 1;
    const handleSignals = opts.handleSignals ?? true;
    const flushTimeoutMs = opts.flushTimeoutMs ?? 3000;

    const flushWithTimeout = async (): Promise<void> => {
      try {
        await Promise.race([
          monitor.flush(),
          new Promise<void>((resolve) => setTimeout(resolve, flushTimeoutMs)),
        ]);
      } catch {
        // swallow — we're exiting anyway.
      }
    };

    const onUncaught = async (err: unknown): Promise<void> => {
      monitor.captureError(err, { level: 'fatal' });
      await flushWithTimeout();
      process.exit(exitCode);
    };

    const onUnhandled = async (reason: unknown): Promise<void> => {
      monitor.captureError(reason, { level: 'fatal' });
      await flushWithTimeout();
      process.exit(exitCode);
    };

    const onSignal = async (sig: NodeJS.Signals): Promise<void> => {
      monitor.addBreadcrumb('lifecycle', `received ${sig}`, 'warning');
      monitor.captureError(new Error(`received ${sig}`), { level: 'error' });
      await flushWithTimeout();
      process.exit(0);
    };

    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    if (handleSignals) {
      process.on('SIGTERM', onSignal);
      process.on('SIGINT', onSignal);
    }

    return () => {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
      if (handleSignals) {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
      }
    };
  },
};

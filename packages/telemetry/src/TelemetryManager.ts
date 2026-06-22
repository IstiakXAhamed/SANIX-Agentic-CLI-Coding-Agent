/**
 * @file TelemetryManager.ts
 * @description Top-level facade combining {@link ErrorMonitor},
 * {@link CrashReporter}, {@link AutoUpdater}, and {@link HealthCheck} into
 * a single object that an application can construct once and use
 * everywhere.
 *
 * @packageDocumentation
 */

import { ErrorMonitor } from './ErrorMonitor.js';
import type { ErrorMonitorOptions } from './ErrorMonitor.js';
import { CrashReporter } from './CrashReporter.js';
import { AutoUpdater } from './AutoUpdater.js';
import { HealthCheck } from './HealthCheck.js';
import { createTransport } from './Transport.js';
import type {
  AutoUpdaterOptions,
  HealthCheckResult,
  Severity,
  Transport,
  UpdateCheckResult,
} from './types.js';

/** Options for {@link TelemetryManager}. */
export interface TelemetryManagerOptions {
  /** Error-monitor options (release, environment, tags, ...). */
  monitor?: ErrorMonitorOptions;
  /** Pre-built transports (in addition to any `defaultTransport`). */
  transports?: Transport[];
  /** If set, a built-in transport to construct via `createTransport`. */
  defaultTransport?: 'console' | 'noop';
  /** If set, install crash reporters on `init()`. Default true. */
  installCrashReporter?: boolean;
  /** If set, configure the auto-updater. */
  autoUpdater?: AutoUpdaterOptions;
}

/**
 * Top-level facade for the telemetry package.
 *
 * @example
 * ```ts
 * const t = new TelemetryManager({
 *   monitor: { release: '1.2.3', environment: 'production' },
 *   defaultTransport: 'console',
 * });
 * t.init();
 * try { risky(); } catch (e) { t.captureError(e); }
 * const health = await t.runHealthChecks();
 * ```
 */
export class TelemetryManager {
  private readonly monitor: ErrorMonitor;
  private readonly health: HealthCheck;
  private readonly updater?: AutoUpdater;
  private disposeCrash?: () => void;
  private initialized = false;

  constructor(opts: TelemetryManagerOptions = {}) {
    const transports: Transport[] = opts.transports ? [...opts.transports] : [];
    if (opts.defaultTransport === 'console') {
      transports.push(createTransport('console', { minLevel: 'warning' }));
    } else if (opts.defaultTransport === 'noop' || transports.length === 0) {
      transports.push(createTransport('noop'));
    }
    this.monitor = new ErrorMonitor(opts.monitor ?? {}, transports);
    this.health = new HealthCheck();
    if (opts.autoUpdater) {
      this.updater = new AutoUpdater(opts.autoUpdater);
    }
  }

  /**
   * Install crash handlers and start the periodic update check (if
   * configured). Safe to call once.
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.disposeCrash = CrashReporter.install(this.monitor);
    this.updater?.startPeriodicCheck();
  }

  /** Tear down: uninstall crash handlers, stop the updater, flush. */
  async dispose(): Promise<void> {
    this.disposeCrash?.();
    this.disposeCrash = undefined;
    this.updater?.stopPeriodicCheck();
    await this.monitor.flush();
    await this.monitor.close();
    this.initialized = false;
  }

  /** Capture an error. */
  captureError(err: unknown, opts: { level?: Severity; extra?: Record<string, unknown>; tags?: Record<string, string> } = {}): void {
    this.monitor.captureError(err, opts);
  }

  /** Add a breadcrumb. */
  addBreadcrumb(category: string, message: string, level: Severity = 'info', data?: Record<string, unknown>): void {
    this.monitor.addBreadcrumb(category, message, level, data);
  }

  /** Register a health check. */
  registerHealthCheck(name: string, run: () => Promise<void> | void, opts: { timeoutMs?: number } = {}): void {
    this.health.register(name, run, opts);
  }

  /** Run all health checks. */
  async runHealthChecks(): Promise<HealthCheckResult[]> {
    return this.health.runAll();
  }

  /** Manually trigger an update check (if an updater is configured). */
  async checkForUpdates(): Promise<UpdateCheckResult | undefined> {
    return this.updater ? this.updater.check() : undefined;
  }

  /** The underlying error monitor. */
  getMonitor(): ErrorMonitor {
    return this.monitor;
  }
}

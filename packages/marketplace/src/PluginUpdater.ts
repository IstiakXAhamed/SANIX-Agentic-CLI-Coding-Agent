/**
 * @file PluginUpdater.ts
 * @description Background job that periodically checks installed
 * plugins against the marketplace registry for newer versions, and
 * (optionally) auto-installs them. Emits `update:available` /
 * `update:installed` / `update:failed` events.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { DEFAULT_CHECK_INTERVAL_MS } from './_constants.js';
import type { MarketplaceClient } from './MarketplaceClient.js';
import type { PluginInstaller } from './PluginInstaller.js';
import type { PluginUpdaterEvents, UpdateCheckResult } from './types.js';

/** Constructor options for {@link PluginUpdater}. */
export interface PluginUpdaterOptions {
  /** Check interval in ms (default 24h). */
  checkIntervalMs?: number;
  /** If true, auto-install updates as they're discovered. */
  autoUpdate?: boolean;
}

/**
 * Periodically checks installed plugins for available updates.
 *
 * @example
 * ```ts
 * const updater = new PluginUpdater(client, installer, { autoUpdate: true });
 * updater.on('update:available', ({ id, currentVersion, latestVersion }) => {
 *   console.log(`${id}: ${currentVersion} → ${latestVersion}`);
 * });
 * updater.start();
 * // ... later
 * updater.stop();
 * ```
 */
export class PluginUpdater extends EventEmitter<PluginUpdaterEvents> {
  readonly client: MarketplaceClient;
  readonly installer: PluginInstaller;
  readonly checkIntervalMs: number;
  readonly autoUpdate: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<UpdateCheckResult> | undefined;

  /**
   * @param client - Marketplace client (for fetching latest metadata).
   * @param installer - Plugin installer (for applying updates).
   * @param opts - Options.
   */
  constructor(
    client: MarketplaceClient,
    installer: PluginInstaller,
    opts: PluginUpdaterOptions = {},
  ) {
    super();
    this.client = client;
    this.installer = installer;
    this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.autoUpdate = opts.autoUpdate ?? false;
  }

  // ── start / stop ──────────────────────────────────────────────────────────

  /**
   * Begin periodic update checks. The first check runs immediately
   * (async, non-blocking); subsequent checks run every
   * `checkIntervalMs`.
   *
   * @example
   * ```ts
   * updater.start();
   * ```
   */
  start(): void {
    if (this.timer) return;
    // Fire an immediate check (non-blocking).
    void this.checkNow().catch(() => {
      // Swallow — errors are surfaced via events + the returned result.
    });
    this.timer = setInterval(() => {
      void this.checkNow().catch(() => {
        // Swallow — errors are surfaced via events + the returned result.
      });
    }, this.checkIntervalMs);
    // Don't keep the event loop alive just for update checks.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * Stop periodic update checks.
   *
   * @example
   * ```ts
   * updater.stop();
   * ```
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // ── checkNow ──────────────────────────────────────────────────────────────

  /**
   * Check all installed plugins for updates immediately.
   *
   * @returns A {@link UpdateCheckResult} with the list of available
   *   updates, count of up-to-date plugins, and per-plugin errors.
   *
   * @example
   * ```ts
   * const result = await updater.checkNow();
   * for (const u of result.updatesAvailable) {
   *   console.log(`${u.id}: ${u.currentVersion} → ${u.latestVersion}`);
   * }
   * ```
   */
  async checkNow(): Promise<UpdateCheckResult> {
    // Coalesce concurrent checkNow() calls.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doCheck();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Iterate installed plugins, fetch latest metadata, compare versions.
   */
  private async doCheck(): Promise<UpdateCheckResult> {
    const installed = await this.installer.listInstalled();
    const updatesAvailable: UpdateCheckResult['updatesAvailable'] = [];
    let upToDate = 0;
    const errors: string[] = [];
    for (const entry of installed) {
      try {
        const latest = await this.client.get(entry.id);
        if (!latest) {
          // Plugin no longer in the registry (unpublished). Skip silently.
          continue;
        }
        if (latest.version !== entry.version) {
          updatesAvailable.push({
            id: entry.id,
            currentVersion: entry.version,
            latestVersion: latest.version,
          });
          this.emit('update:available', {
            id: entry.id,
            currentVersion: entry.version,
            latestVersion: latest.version,
          });
          if (this.autoUpdate) {
            try {
              await this.installer.update(entry.id, latest);
              this.emit('update:installed', {
                id: entry.id,
                fromVersion: entry.version,
                toVersion: latest.version,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`${entry.id}: auto-update failed — ${msg}`);
              this.emit('update:failed', { id: entry.id, error: msg });
            }
          }
        } else {
          upToDate++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${entry.id}: ${msg}`);
      }
    }
    return { updatesAvailable, upToDate, errors };
  }
}

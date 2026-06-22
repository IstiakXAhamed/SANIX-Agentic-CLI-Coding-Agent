/**
 * @file MarketplaceManager.ts
 * @description Top-level facade for `@sanix/marketplace`. Combines a
 * {@link MarketplaceClient}, {@link PluginInstaller},
 * {@link PluginValidator}, {@link PluginLoader}, and
 * {@link PluginUpdater} into a single class that exposes the full
 * plugin lifecycle:
 *
 *   - `search` / `featured` / `listInstalled`
 *   - `install` (fetch → validate → install → load)
 *   - `uninstall` (unload → uninstall)
 *   - `update` / `updateAll`
 *   - `publish` / `rate`
 *
 * All events from the underlying subsystems are re-emitted on the
 * manager so consumers can subscribe to a single event source.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import {
  DEFAULT_CACHE_DIR,
  DEFAULT_INSTALL_DIR,
  DEFAULT_REGISTRY_URL,
} from './_constants.js';
import { MarketplaceClient } from './MarketplaceClient.js';
import { PluginInstaller } from './PluginInstaller.js';
import { PluginLoader, type PluginLoaderOptions } from './PluginLoader.js';
import { PluginUpdater } from './PluginUpdater.js';
import { PluginValidator } from './PluginValidator.js';
import type {
  InstalledPlugin,
  MarketplaceConfig,
  MarketplaceManagerEvents,
  MarketplacePlugin,
  PublishSpec,
  SearchQuery,
  UpdateCheckResult,
} from './types.js';

/** Constructor options for {@link MarketplaceManager}. */
export interface MarketplaceManagerOptions extends Partial<MarketplaceConfig> {
  /** Bearer token for authenticated endpoints (publish / unpublish / rate). */
  authToken?: string;
  /** Running SANIX version (for compatibility checks). */
  sanixVersion?: string;
  /** Plugin loader options (subsystems to register loaded plugins with). */
  loaderOptions?: Omit<PluginLoaderOptions, 'installDir'>;
}

/**
 * The top-level marketplace facade.
 *
 * @example
 * ```ts
 * const manager = new MarketplaceManager({
 *   registryUrl: 'https://registry.sanix.dev',
 *   trustLevel: 'verified',
 *   autoUpdate: false,
 * });
 *
 * manager.on('install:complete', ({ pluginId }) => {
 *   console.log(`installed ${pluginId}`);
 * });
 *
 * const results = await manager.search({ query: 'code review' });
 * const installed = await manager.install(results[0].id);
 * ```
 */
export class MarketplaceManager extends EventEmitter<MarketplaceManagerEvents> {
  /** The marketplace HTTP client. */
  readonly client: MarketplaceClient;
  /** The plugin installer. */
  readonly installer: PluginInstaller;
  /** The plugin validator. */
  readonly validator: PluginValidator;
  /** The plugin loader. */
  readonly loader: PluginLoader;
  /** The background updater. */
  readonly updater: PluginUpdater;
  /** Effective config. */
  readonly config: MarketplaceConfig;
  /** Running SANIX version (for compatibility checks). */
  readonly sanixVersion: string;

  /**
   * @param opts - Construction options (all fields optional).
   */
  constructor(opts: MarketplaceManagerOptions = {}) {
    super();
    this.config = {
      registryUrl: opts.registryUrl ?? DEFAULT_REGISTRY_URL,
      cacheDir: opts.cacheDir ?? DEFAULT_CACHE_DIR,
      installDir: opts.installDir ?? DEFAULT_INSTALL_DIR,
      trustLevel: opts.trustLevel ?? 'verified',
      autoUpdate: opts.autoUpdate ?? false,
    };
    this.sanixVersion = opts.sanixVersion ?? '1.0.0';
    this.client = new MarketplaceClient({
      registryUrl: this.config.registryUrl,
      authToken: opts.authToken,
      cacheDir: this.config.cacheDir,
    });
    this.installer = new PluginInstaller({
      installDir: this.config.installDir,
      cacheDir: this.config.cacheDir,
      trustLevel: this.config.trustLevel,
    });
    this.validator = new PluginValidator();
    this.loader = new PluginLoader({
      ...opts.loaderOptions,
      installDir: this.config.installDir,
    });
    this.updater = new PluginUpdater(this.client, this.installer, {
      autoUpdate: this.config.autoUpdate,
    });
    this.wireEvents();
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Search the marketplace.
   *
   * @example
   * ```ts
   * const results = await manager.search({ query: 'review', type: 'workflow' });
   * ```
   */
  async search(query: SearchQuery): Promise<MarketplacePlugin[]> {
    return this.client.search(query);
  }

  /**
   * Fetch featured plugins.
   *
   * @example
   * ```ts
   * const featured = await manager.featured();
   * ```
   */
  async featured(): Promise<MarketplacePlugin[]> {
    return this.client.featured();
  }

  // ── Install ───────────────────────────────────────────────────────────────

  /**
   * Install a plugin by id. Pipeline: fetch metadata → validate →
   * install → load.
   *
   * @param id - Plugin id.
   * @param opts - Install options.
   * @returns The installed-plugin manifest entry.
   * @throws {Error} if the plugin isn't found, fails validation, or the
   *   trust gate rejects it.
   *
   * @example
   * ```ts
   * const installed = await manager.install('sanim/code-review-pro');
   * ```
   */
  async install(id: string, opts: { version?: string; force?: boolean } = {}): Promise<InstalledPlugin> {
    const plugin = await this.client.get(id);
    if (!plugin) {
      throw new Error(`plugin '${id}' not found in registry`);
    }
    const validation = await this.validator.validate(plugin, {
      trustLevel: this.config.trustLevel,
      sanixVersion: this.sanixVersion,
    });
    if (!validation.valid) {
      throw new Error(
        `plugin '${id}' failed validation: ${validation.errors.join('; ')} (trustScore=${validation.trustScore})`,
      );
    }
    const installed = await this.installer.install(plugin, opts);
    // Load the freshly-installed plugin.
    const loadResult = await this.loader.loadOne(id);
    this.emit('load:result', { result: loadResult });
    return installed;
  }

  // ── Uninstall ─────────────────────────────────────────────────────────────

  /**
   * Uninstall a plugin. Pipeline: unload → uninstall.
   *
   * @param id - Plugin id.
   *
   * @example
   * ```ts
   * await manager.uninstall('sanim/code-review-pro');
   * ```
   */
  async uninstall(id: string): Promise<void> {
    // Best-effort unload (only complete_plugins have destroy()).
    await this.loader.unload(id).catch(() => undefined);
    await this.installer.uninstall(id);
  }

  // ── Update ────────────────────────────────────────────────────────────────

  /**
   * Update a single plugin to the latest version.
   *
   * @param id - Plugin id.
   * @returns The updated manifest entry.
   *
   * @example
   * ```ts
   * const updated = await manager.update('sanim/code-review-pro');
   * ```
   */
  async update(id: string): Promise<InstalledPlugin> {
    const latest = await this.client.get(id);
    if (!latest) {
      throw new Error(`plugin '${id}' not found in registry`);
    }
    const validation = await this.validator.validate(latest, {
      trustLevel: this.config.trustLevel,
      sanixVersion: this.sanixVersion,
    });
    if (!validation.valid) {
      throw new Error(
        `update rejected for '${id}': ${validation.errors.join('; ')}`,
      );
    }
    const installed = await this.installer.update(id, latest);
    // Reload the updated plugin.
    const loadResult = await this.loader.loadOne(id);
    this.emit('load:result', { result: loadResult });
    return installed;
  }

  /**
   * Check all installed plugins for updates and (if `autoUpdate` is
   * enabled) install them. Returns the check result regardless.
   *
   * @example
   * ```ts
   * const result = await manager.updateAll();
   * console.log(`${result.updatesAvailable.length} updates, ${result.upToDate} up-to-date`);
   * ```
   */
  async updateAll(): Promise<UpdateCheckResult> {
    return this.updater.checkNow();
  }

  // ── List installed ────────────────────────────────────────────────────────

  /**
   * List all installed plugins.
   *
   * @example
   * ```ts
   * for (const p of await manager.listInstalled()) {
   *   console.log(`${p.id}@${p.version}`);
   * }
   * ```
   */
  async listInstalled(): Promise<InstalledPlugin[]> {
    return this.installer.listInstalled();
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  /**
   * Publish a plugin to the registry. Requires an `authToken`.
   *
   * @example
   * ```ts
   * const { id, url } = await manager.publish(spec);
   * ```
   */
  async publish(spec: PublishSpec): Promise<{ id: string; url: string }> {
    return this.client.publish(spec);
  }

  // ── Rate ──────────────────────────────────────────────────────────────────

  /**
   * Rate a plugin (1..5). Requires an `authToken`.
   *
   * @example
   * ```ts
   * await manager.rate('sanim/code-review-pro', 5, 'Excellent!');
   * ```
   */
  async rate(id: string, rating: number, review?: string): Promise<void> {
    return this.client.rate(id, rating, review);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the background updater (periodic update checks).
   *
   * @example
   * ```ts
   * manager.start();
   * ```
   */
  start(): void {
    this.updater.start();
  }

  /**
   * Stop the background updater.
   *
   * @example
   * ```ts
   * manager.stop();
   * ```
   */
  stop(): void {
    this.updater.stop();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Re-emit all subsystem events on the manager. This gives consumers a
   * single event source for the entire marketplace lifecycle.
   */
  private wireEvents(): void {
    // Installer events.
    this.installer.on('install:start', (e) => this.emit('install:start', e));
    this.installer.on('install:download', (e) => this.emit('install:download', e));
    this.installer.on('install:extract', (e) => this.emit('install:extract', e));
    this.installer.on('install:complete', (e) => this.emit('install:complete', e));
    this.installer.on('install:failed', (e) => this.emit('install:failed', e));
    this.installer.on('uninstall', (e) => this.emit('uninstall', e));
    this.installer.on('update', (e) => this.emit('update', e));
    // Updater events.
    this.updater.on('update:available', (e) => this.emit('update:available', e));
    this.updater.on('update:installed', (e) => this.emit('update:installed', e));
    this.updater.on('update:failed', (e) => this.emit('update:failed', e));
  }
}

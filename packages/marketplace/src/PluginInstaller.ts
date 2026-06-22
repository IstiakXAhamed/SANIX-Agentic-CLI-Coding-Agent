/**
 * @file PluginInstaller.ts
 * @description Downloads + installs SANIX marketplace plugins to
 * `~/.sanix/plugins/`. Handles all five install-spec kinds (`npm`,
 * `github`, `url`, `file`, `inline`), enforces a trust-level gate
 * before install, persists an `installed.json` manifest, and emits
 * granular lifecycle events.
 *
 * The installer is deliberately decoupled from the registry — it
 * operates on a {@link MarketplacePlugin} description and never makes
 * HTTP calls itself (downloads for `url` kind go through the caller-
 * supplied fetch helper, here the local {@link fetchBuffer}). This
 * keeps it composable with {@link MarketplaceClient} and testable.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';
import {
  DEFAULT_CACHE_DIR,
  DEFAULT_INSTALL_DIR,
  INSTALLED_MANIFEST_FILENAME,
  PLUGIN_DESCRIPTOR_FILENAME,
  TRUSTED_PUBLISHERS,
} from './_constants.js';
import {
  ensureDir,
  expandPath,
  extractArchive,
  fetchBuffer,
  idToDirName,
  readJsonOrNull,
  verifyChecksum,
  writeJson,
} from './_util.js';
import type {
  InstalledPlugin,
  MarketplacePlugin,
  PluginInstallerEvents,
} from './types.js';

/** Constructor options for {@link PluginInstaller}. */
export interface PluginInstallerOptions {
  /** Install root (default `~/.sanix/plugins`). */
  installDir?: string;
  /** Cache directory for downloads (default `~/.sanix/marketplace/cache`). */
  cacheDir?: string;
  /** Trust gate (default `'verified'`). */
  trustLevel?: 'trusted' | 'verified' | 'all';
}

/** Options for {@link PluginInstaller.install}. */
export interface InstallOptions {
  /** Pin a specific version (defaults to `plugin.version`). */
  version?: string;
  /** Re-install even if already installed at the same version. */
  force?: boolean;
}

/**
 * Downloads and installs SANIX marketplace plugins.
 *
 * Extends `EventEmitter` — emit/listen for the events in
 * {@link PluginInstallerEvents}.
 *
 * @example
 * ```ts
 * const installer = new PluginInstaller({ trustLevel: 'verified' });
 * installer.on('install:complete', ({ pluginId, installed }) => {
 *   console.log(`installed ${pluginId} → ${installed.installPath}`);
 * });
 * const installed = await installer.install(plugin);
 * ```
 */
export class PluginInstaller extends EventEmitter<PluginInstallerEvents> {
  /** Absolute install root. */
  readonly installDir: string;
  /** Absolute cache directory. */
  readonly cacheDir: string;
  /** Trust gate. */
  readonly trustLevel: 'trusted' | 'verified' | 'all';

  /**
   * @param opts - Construction options.
   */
  constructor(opts: PluginInstallerOptions = {}) {
    super();
    this.installDir = expandPath(opts.installDir ?? DEFAULT_INSTALL_DIR);
    this.cacheDir = expandPath(opts.cacheDir ?? DEFAULT_CACHE_DIR);
    this.trustLevel = opts.trustLevel ?? 'verified';
  }

  // ── Install ───────────────────────────────────────────────────────────────

  /**
   * Install a plugin. Performs the trust gate, downloads / clones /
   * writes the plugin files, writes a per-plugin descriptor, and updates
   * the manifest.
   *
   * @param plugin - Plugin to install.
   * @param opts - Install options.
   * @returns The installed-plugin manifest entry.
   * @throws {Error} if the trust gate fails or installation errors.
   *
   * @example
   * ```ts
   * const installed = await installer.install(plugin, { version: '2.1.0' });
   * ```
   */
  async install(plugin: MarketplacePlugin, opts: InstallOptions = {}): Promise<InstalledPlugin> {
    const version = opts.version ?? plugin.version;
    this.checkTrust(plugin);
    // Idempotent: if already installed at the same version and not forced, return existing.
    if (!opts.force) {
      const existing = await this.getInstalled(plugin.id);
      if (existing && existing.version === version) {
        return existing;
      }
    }
    this.emit('install:start', { pluginId: plugin.id, version });
    try {
      const installPath = path.join(this.installDir, idToDirName(plugin.id));
      // Clear any existing install dir (force / version change).
      await fs.rm(installPath, { recursive: true, force: true });
      await ensureDir(installPath);

      await this.installByKind(plugin, installPath);

      // Write the per-plugin descriptor (so the loader can re-validate).
      await writeJson(path.join(installPath, PLUGIN_DESCRIPTOR_FILENAME), plugin);

      const entry: InstalledPlugin = {
        id: plugin.id,
        marketplaceId: plugin.id,
        version,
        installedAt: Date.now(),
        installPath,
        enabled: true,
      };
      await this.updateManifest((manifest) => {
        manifest.set(plugin.id, entry);
      });
      this.emit('install:complete', { pluginId: plugin.id, installed: entry });
      return entry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('install:failed', { pluginId: plugin.id, error: msg });
      throw err;
    }
  }

  // ── Uninstall ─────────────────────────────────────────────────────────────

  /**
   * Uninstall a plugin: remove its install directory and delete its
   * manifest entry. No-op if not installed.
   *
   * @param id - Plugin id.
   *
   * @example
   * ```ts
   * await installer.uninstall('sanim/code-review-pro');
   * ```
   */
  async uninstall(id: string): Promise<void> {
    const entry = await this.getInstalled(id);
    if (!entry) return;
    await fs.rm(entry.installPath, { recursive: true, force: true });
    await this.updateManifest((manifest) => {
      manifest.delete(id);
    });
    this.emit('uninstall', { pluginId: id });
  }

  // ── Update ────────────────────────────────────────────────────────────────

  /**
   * Update an installed plugin to a new version. The caller supplies
   * the latest {@link MarketplacePlugin} metadata (typically fetched
   * from the registry via `MarketplaceClient.get`).
   *
   * @param id - Plugin id.
   * @param latest - The latest plugin metadata (defaults: caller must supply).
   * @returns The updated manifest entry.
   * @throws {Error} if the plugin is not installed or the trust gate fails.
   *
   * @example
   * ```ts
   * const latest = await client.get('sanim/code-review-pro');
   * if (latest) await installer.update('sanim/code-review-pro', latest);
   * ```
   */
  async update(id: string, latest: MarketplacePlugin): Promise<InstalledPlugin> {
    const existing = await this.getInstalled(id);
    if (!existing) {
      throw new Error(`cannot update '${id}' — not installed`);
    }
    this.checkTrust(latest);
    const fromVersion = existing.version;
    // Re-install with force to overwrite.
    const updated = await this.install(latest, { version: latest.version, force: true });
    this.emit('update', { pluginId: id, fromVersion, toVersion: latest.version, installed: updated });
    return updated;
  }

  // ── List / get installed ──────────────────────────────────────────────────

  /**
   * List all installed plugins.
   *
   * @example
   * ```ts
   * for (const p of await installer.listInstalled()) {
   *   console.log(`${p.id}@${p.version} → ${p.installPath}`);
   * }
   * ```
   */
  async listInstalled(): Promise<InstalledPlugin[]> {
    const manifest = await this.readManifest();
    return Array.from(manifest.values());
  }

  /**
   * Get a single installed plugin by id, or `null` if not installed.
   *
   * @example
   * ```ts
   * const installed = await installer.getInstalled('sanim/code-review-pro');
   * ```
   */
  async getInstalled(id: string): Promise<InstalledPlugin | null> {
    const manifest = await this.readManifest();
    return manifest.get(id) ?? null;
  }

  // ── Enable / disable ──────────────────────────────────────────────────────

  /**
   * Enable an installed plugin (it will be loaded on the next
   * `PluginLoader.loadAll`).
   *
   * @param id - Plugin id.
   * @throws {Error} if not installed.
   */
  async enable(id: string): Promise<void> {
    await this.setEnabled(id, true);
  }

  /**
   * Disable an installed plugin (it will be skipped on the next load).
   *
   * @param id - Plugin id.
   * @throws {Error} if not installed.
   */
  async disable(id: string): Promise<void> {
    await this.setEnabled(id, false);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Trust gate. Throws if the plugin fails the configured trust level.
   * At `trustLevel === 'all'`, emits no error (the validator will have
   * already warned).
   */
  private checkTrust(plugin: MarketplacePlugin): void {
    const isTrustedPublisher = TRUSTED_PUBLISHERS.has(plugin.author.name.toLowerCase());
    if (this.trustLevel === 'trusted' && !isTrustedPublisher) {
      throw new Error(
        `trust gate: '${plugin.id}' author '${plugin.author.name}' is not a trusted publisher (trustLevel='trusted')`,
      );
    }
    if (this.trustLevel === 'verified' && !plugin.verified && !isTrustedPublisher) {
      throw new Error(
        `trust gate: '${plugin.id}' is neither verified nor from a trusted publisher (trustLevel='verified')`,
      );
    }
    // 'all' → no gate.
  }

  /**
   * Dispatch installation to the per-kind handler.
   */
  private async installByKind(plugin: MarketplacePlugin, installPath: string): Promise<void> {
    const spec = plugin.install;
    switch (spec.kind) {
      case 'npm':
        await this.installNpm(spec.package, spec.version ?? plugin.version, installPath);
        break;
      case 'github':
        await this.installGithub(spec.repo, spec.ref, spec.subdir, installPath);
        break;
      case 'url':
        await this.installUrl(spec.url, spec.checksum, installPath);
        break;
      case 'file':
        await this.installFile(spec.path, installPath);
        break;
      case 'inline':
        await this.installInline(plugin, spec.content, installPath);
        break;
    }
  }

  /**
   * `npm` kind: run `npm install --prefix <installDir> <package>@<version>`.
   */
  private async installNpm(pkg: string, version: string, installPath: string): Promise<void> {
    await this.runCmd('npm', ['install', '--prefix', installPath, `${pkg}@${version}`], installPath);
    this.emit('install:extract', { pluginId: pkg, installPath });
  }

  /**
   * `github` kind: `git clone` the repo, optionally checkout a ref,
   * optionally narrow to a subdir.
   */
  private async installGithub(
    repo: string,
    ref: string | undefined,
    subdir: string | undefined,
    installPath: string,
  ): Promise<void> {
    const cloneUrl = `https://github.com/${repo}.git`;
    const tmpClone = path.join(this.cacheDir, 'github', `${repo.replace('/', '__')}-${nanoid(8)}`);
    await ensureDir(tmpClone);
    await this.runCmd('git', ['clone', '--depth', '1', cloneUrl, tmpClone], this.cacheDir);
    if (ref) {
      // Fetch the specific ref (shallow clone may not have it).
      await this.runCmd('git', ['-C', tmpClone, 'fetch', '--depth', '1', 'origin', ref], tmpClone);
      await this.runCmd('git', ['-C', tmpClone, 'checkout', ref], tmpClone);
    }
    // Copy subdir (or whole repo) into installPath.
    const src = subdir ? path.join(tmpClone, subdir) : tmpClone;
    await this.copyDir(src, installPath);
    // Clean up the clone cache.
    await fs.rm(tmpClone, { recursive: true, force: true });
    this.emit('install:extract', { pluginId: repo, installPath });
  }

  /**
   * `url` kind: download, verify checksum, extract archive.
   */
  private async installUrl(url: string, checksum: string | undefined, installPath: string): Promise<void> {
    const buf = await fetchBuffer(url);
    if (checksum) {
      if (!verifyChecksum(buf, checksum)) {
        throw new Error(`checksum verification failed for ${url}`);
      }
    }
    this.emit('install:download', { pluginId: url, bytes: buf.length });
    const filename = url.split('/').pop() ?? 'archive.tar.gz';
    await extractArchive(buf, installPath, filename);
    this.emit('install:extract', { pluginId: url, installPath });
  }

  /**
   * `file` kind: symlink the source path into the install dir. Falls
   * back to a recursive copy if symlinking fails (e.g. cross-device).
   */
  private async installFile(srcPath: string, installPath: string): Promise<void> {
    const resolved = expandPath(srcPath);
    if (!existsSync(resolved)) {
      throw new Error(`file install source does not exist: ${resolved}`);
    }
    try {
      await fs.symlink(resolved, installPath, 'dir');
    } catch {
      await this.copyDir(resolved, installPath);
    }
    this.emit('install:extract', { pluginId: srcPath, installPath });
  }

  /**
   * `inline` kind: write the content directly to a file whose extension
   * depends on the plugin type:
   *
   *   - `workflow`            → `<name>.yaml`
   *   - `persona`             → `<name>.json`
   *   - `tool`                → `<name>.js`
   *   - `knowledge_schema`    → `<name>.json`
   *   - `agent_template`      → `<name>.json`
   *   - `theme`               → `<name>.json`
   *   - `complete_plugin`     → `<name>.js`
   */
  private async installInline(
    plugin: MarketplacePlugin,
    content: string,
    installPath: string,
  ): Promise<void> {
    const ext =
      plugin.type === 'workflow' ? 'yaml' :
      plugin.type === 'tool' || plugin.type === 'complete_plugin' ? 'js' :
      'json';
    const file = path.join(installPath, `${plugin.name}.${ext}`);
    await fs.writeFile(file, content, 'utf8');
    this.emit('install:extract', { pluginId: plugin.id, installPath });
  }

  /**
   * Set `enabled` on an installed plugin and persist the manifest.
   */
  private async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.updateManifest((manifest) => {
      const entry = manifest.get(id);
      if (!entry) throw new Error(`cannot ${enabled ? 'enable' : 'disable'} '${id}' — not installed`);
      entry.enabled = enabled;
    });
  }

  // ── Manifest I/O ──────────────────────────────────────────────────────────

  /** Path to the installed-plugins manifest. */
  private manifestPath(): string {
    return path.join(this.installDir, INSTALLED_MANIFEST_FILENAME);
  }

  /** Read the manifest as a Map (id → entry). Returns an empty map if absent. */
  private async readManifest(): Promise<Map<string, InstalledPlugin>> {
    const raw = await readJsonOrNull(this.manifestPath());
    const map = new Map<string, InstalledPlugin>();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (this.isInstalledPlugin(item)) {
          map.set(item.id, item);
        }
      }
    }
    return map;
  }

  /** Runtime guard for {@link InstalledPlugin}. */
  private isInstalledPlugin(v: unknown): v is InstalledPlugin {
    return (
      typeof v === 'object' && v !== null &&
      typeof (v as InstalledPlugin).id === 'string' &&
      typeof (v as InstalledPlugin).marketplaceId === 'string' &&
      typeof (v as InstalledPlugin).version === 'string' &&
      typeof (v as InstalledPlugin).installedAt === 'number' &&
      typeof (v as InstalledPlugin).installPath === 'string' &&
      typeof (v as InstalledPlugin).enabled === 'boolean'
    );
  }

  /** Atomically mutate the manifest via a callback and persist. */
  private async updateManifest(fn: (manifest: Map<string, InstalledPlugin>) => void): Promise<void> {
    const manifest = await this.readManifest();
    fn(manifest);
    await ensureDir(this.installDir);
    await writeJson(this.manifestPath(), Array.from(manifest.values()));
  }

  // ── Process / FS helpers ──────────────────────────────────────────────────

  /**
   * Spawn a child process, inherit stdio (pipe stdout/stderr), and
   * reject on non-zero exit.
   */
  private runCmd(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      });
    });
  }

  /**
   * Recursively copy a directory.
   */
  private async copyDir(src: string, dest: string): Promise<void> {
    await ensureDir(dest);
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDir(s, d);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(s);
        await fs.symlink(target, d).catch(() => undefined);
      } else if (entry.isFile()) {
        await fs.copyFile(s, d);
      }
    }
  }
}

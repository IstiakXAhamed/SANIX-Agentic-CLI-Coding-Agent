/**
 * @file types.ts
 * @description Public type definitions for `@sanix/marketplace` — the
 * SANIX plugin marketplace. Defines the shapes of marketplace plugins,
 * install specs, installed-plugin manifests, search queries, publish
 * specs, validation results, and the various event payloads emitted by
 * the subsystems.
 *
 * A {@link MarketplacePlugin} is the registry-side description of a
 * community-contributed extension (workflow, persona, tool, knowledge
 * schema, agent template, theme, or complete plugin). An
 * {@link InstalledPlugin} is the local manifest entry tracking what has
 * been installed on this machine.
 *
 * @packageDocumentation
 */

// ── Plugin taxonomy ─────────────────────────────────────────────────────────

/**
 * The kind of extension a marketplace plugin provides. Each kind maps
 * to a specific loading strategy in {@link PluginLoader}:
 *
 * - `workflow` — a YAML workflow consumed by `WorkflowLoader`.
 * - `persona` — an `AgentPersona` JSON consumed by the persona registry.
 * - `tool` — a JS module exporting a `SanixTool` instance or factory.
 * - `knowledge_schema` — entity/relationship/property schemas for the
 *   `KnowledgeManager`.
 * - `agent_template` — a `TeamConfig` JSON for multi-agent templates.
 * - `theme` — a colors/fonts JSON for the TUI theme manager.
 * - `complete_plugin` — a JS module exporting a `SanixPlugin` object
 *   whose `init(ctx)` is called on load and `destroy?()` on unload.
 */
export type PluginType =
  | 'workflow'
  | 'persona'
  | 'tool'
  | 'knowledge_schema'
  | 'agent_template'
  | 'theme'
  | 'complete_plugin';

// ── Install spec ────────────────────────────────────────────────────────────

/**
 * Describes how to fetch and install a plugin. The `kind` discriminates
 * between npm packages, GitHub repos, arbitrary URLs, local file paths,
 * and inline content.
 *
 * @example
 * ```ts
 * // npm
 * const npm: PluginInstallSpec = { kind: 'npm', package: '@sanix/my-tool', version: '^1.2.0' };
 * // github
 * const gh: PluginInstallSpec = { kind: 'github', repo: 'sanim/my-workflow', ref: 'v2.0.0' };
 * // inline (small workflow shipped as a string)
 * const inline: PluginInstallSpec = {
 *   kind: 'inline',
 *   content: 'name: hello\nsteps:\n  - id: hi\n    type: tool\n    tool: bash\n    inputs:\n      command: { literal: "echo hi" }\n',
 * };
 * ```
 */
export type PluginInstallSpec =
  | { kind: 'npm'; package: string; version?: string }
  | { kind: 'github'; repo: string; ref?: string; subdir?: string }
  | { kind: 'url'; url: string; checksum?: string }
  | { kind: 'file'; path: string }
  | { kind: 'inline'; content: string };

// ── Marketplace plugin (registry-side) ──────────────────────────────────────

/**
 * The full registry-side description of a community plugin. Returned by
 * `MarketplaceClient.search/get/list/featured` and validated by
 * `PluginValidator` before installation.
 *
 * @example
 * ```ts
 * const plugin: MarketplacePlugin = {
 *   id: 'sanim/code-review-pro',
 *   name: 'code-review-pro',
 *   displayName: 'Code Review Pro',
 *   description: 'Enhanced multi-agent code review workflow.',
 *   type: 'workflow',
 *   version: '2.1.0',
 *   author: { name: 'Istiak Ahamed', email: 'sanim@example.com' },
 *   license: 'MIT',
 *   keywords: ['code-review', 'automation', 'multi-agent'],
 *   sanixVersion: '>=1.0.0',
 *   install: { kind: 'inline', content: '...' },
 *   downloads: 1234,
 *   rating: 4.6,
 *   ratingCount: 87,
 *   createdAt: Date.now() - 86400000 * 30,
 *   updatedAt: Date.now() - 86400000,
 *   verified: true,
 *   featured: false,
 * };
 * ```
 */
export interface MarketplacePlugin {
  /** Unique registry id, conventionally `username/plugin-name`. */
  id: string;
  /** Plugin name (no scope). */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Short description shown in search results. */
  description: string;
  /** Plugin kind — determines the loading strategy. */
  type: PluginType;
  /** Semver version string (e.g. `'1.2.0'`). */
  version: string;
  /** Author info. */
  author: { name: string; email?: string; url?: string };
  /** SPDX license identifier (e.g. `'MIT'`, `'Apache-2.0'`). */
  license: string;
  /** Optional homepage URL. */
  homepage?: string;
  /** Optional source repository URL. */
  repository?: string;
  /** Search/discovery keywords. */
  keywords: string[];
  /** Minimum SANIX version required to run this plugin (semver range). */
  sanixVersion: string;
  /** How to install this plugin. */
  install: PluginInstallSpec;
  /** Optional README markdown. */
  readme?: string;
  /** Lifetime download count. */
  downloads: number;
  /** Average rating (0..5). */
  rating: number;
  /** Number of ratings submitted. */
  ratingCount: number;
  /** First-published timestamp (ms epoch). */
  createdAt: number;
  /** Last-updated timestamp (ms epoch). */
  updatedAt: number;
  /** Whether the publisher is verified by the registry. */
  verified: boolean;
  /** Whether the registry features this plugin. */
  featured: boolean;
}

// ── Installed plugin (local manifest) ───────────────────────────────────────

/**
 * Local manifest entry for an installed plugin. Persisted to
 * `~/.sanix/plugins/installed.json`.
 *
 * @example
 * ```ts
 * const installed: InstalledPlugin = {
 *   id: 'sanim/code-review-pro',
 *   marketplaceId: 'sanim/code-review-pro',
 *   version: '2.1.0',
 *   installedAt: Date.now(),
 *   installPath: '/home/user/.sanix/plugins/code-review-pro',
 *   enabled: true,
 *   config: { strict: true },
 * };
 * ```
 */
export interface InstalledPlugin {
  /** Local id (usually equals marketplaceId). */
  id: string;
  /** Registry id this install tracks. */
  marketplaceId: string;
  /** Installed version. */
  version: string;
  /** Installation timestamp (ms epoch). */
  installedAt: number;
  /** Absolute path on disk where the plugin lives. */
  installPath: string;
  /** Whether the plugin is enabled (loaded on startup). */
  enabled: boolean;
  /** Optional user-supplied config overrides. */
  config?: Record<string, unknown>;
}

// ── Marketplace config ──────────────────────────────────────────────────────

/**
 * Top-level configuration for {@link MarketplaceManager}. All fields
 * have sensible defaults.
 *
 * @example
 * ```ts
 * const config: MarketplaceConfig = {
 *   registryUrl: 'https://registry.sanix.dev',
 *   cacheDir: '~/.sanix/marketplace/cache',
 *   installDir: '~/.sanix/plugins',
 *   trustLevel: 'verified',
 *   autoUpdate: false,
 * };
 * ```
 */
export interface MarketplaceConfig {
  /** Registry base URL. Default `'https://registry.sanix.dev'`. */
  registryUrl: string;
  /** Cache directory for downloaded payloads. Default `'~/.sanix/marketplace/cache'`. */
  cacheDir: string;
  /** Plugin install directory. Default `'~/.sanix/plugins'`. */
  installDir: string;
  /** Trust level gating which plugins may be installed. */
  trustLevel: 'trusted' | 'verified' | 'all';
  /** If true, auto-install updates in the background. */
  autoUpdate: boolean;
}

// ── Search query ────────────────────────────────────────────────────────────

/**
 * Search query for `MarketplaceClient.search`. All fields optional;
 * omitted fields are not used as filters.
 *
 * @example
 * ```ts
 * const q: SearchQuery = {
 *   query: 'code review',
 *   type: 'workflow',
 *   keywords: ['automation'],
 *   sort: 'downloads',
 *   limit: 20,
 * };
 * const results = await client.search(q);
 * ```
 */
export interface SearchQuery {
  /** Free-text query. */
  query?: string;
  /** Restrict to a plugin type. */
  type?: PluginType;
  /** Require all of these keywords. */
  keywords?: string[];
  /** Filter by author name. */
  author?: string;
  /** Max results (default 50). */
  limit?: number;
  /** Sort order. */
  sort?: 'relevance' | 'downloads' | 'rating' | 'updated';
}

// ── Publish spec ────────────────────────────────────────────────────────────

/**
 * Specification for publishing a new plugin to the registry. Submitted
 * via `MarketplaceClient.publish` / `PluginPublisher.publish*`.
 *
 * @example
 * ```ts
 * const spec: PublishSpec = {
 *   name: 'my-workflow',
 *   displayName: 'My Workflow',
 *   description: 'Does X, Y, Z',
 *   type: 'workflow',
 *   version: '1.0.0',
 *   author: { name: 'Istiak Ahamed', email: 'sanim@example.com' },
 *   license: 'MIT',
 *   keywords: ['code', 'review'],
 *   sanixVersion: '>=1.0.0',
 *   install: { kind: 'inline', content: workflowYaml },
 *   readme: '# My Workflow\n...',
 * };
 * ```
 */
export interface PublishSpec {
  /** Plugin name (no scope). */
  name: string;
  /** Display name. */
  displayName: string;
  /** Description. */
  description: string;
  /** Plugin kind. */
  type: PluginType;
  /** Semver version. */
  version: string;
  /** Author info. */
  author: { name: string; email?: string; url?: string };
  /** SPDX license. */
  license: string;
  /** Keywords. */
  keywords: string[];
  /** Min SANIX version. */
  sanixVersion: string;
  /** Install spec. */
  install: PluginInstallSpec;
  /** Optional README. */
  readme?: string;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Result of {@link PluginValidator.validate}. `valid` is `true` only
 * when `errors` is empty; `warnings` are non-blocking concerns.
 */
export interface ValidationResult {
  /** Whether the plugin is safe + compatible to install. */
  valid: boolean;
  /** Non-blocking concerns (still installable). */
  warnings: string[];
  /** Blocking errors (must not install). */
  errors: string[];
  /** Trust score 0..100. */
  trustScore: number;
}

// ── Update check ────────────────────────────────────────────────────────────

/**
 * Result of {@link PluginUpdater.checkNow}. Lists plugins with updates
 * available, count of up-to-date plugins, and any errors encountered.
 */
export interface UpdateCheckResult {
  /** Plugins with a newer version available. */
  updatesAvailable: Array<{
    id: string;
    currentVersion: string;
    latestVersion: string;
  }>;
  /** Count of plugins already at the latest version. */
  upToDate: number;
  /** Per-plugin errors encountered during the check. */
  errors: string[];
}

// ── Load result ─────────────────────────────────────────────────────────────

/**
 * Result of {@link PluginLoader.loadAll} / {@link PluginLoader.loadOne}.
 */
export interface LoadResult {
  /** Number of plugins successfully loaded. */
  loaded: number;
  /** Number of plugins that failed to load. */
  failed: number;
  /** Per-plugin errors (empty if none failed). */
  errors: Array<{ pluginId: string; error: string }>;
}

// ── SanixPlugin contract (for `complete_plugin` kind) ───────────────────────

/**
 * Context passed to {@link SanixPlugin.init} when a `complete_plugin`
 * is loaded. Provides hooks into the running SANIX instance so the
 * plugin can register workflows, tools, personas, etc. programmatically.
 *
 * All fields are optional so a plugin can gracefully degrade when a
 * subsystem isn't available (e.g. running in a headless context).
 */
export interface SanixPluginContext {
  /** Plugin install path (absolute). */
  installPath: string;
  /** Plugin id from the manifest. */
  pluginId: string;
  /** Optional user config overrides. */
  config?: Record<string, unknown>;
  /** Logger sink (defaults to console). */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  /** Hook to register a tool at runtime (if a ToolRegistry is wired). */
  registerTool?: (tool: unknown) => void;
  /** Hook to register a workflow at runtime (if a WorkflowLoader is wired). */
  registerWorkflow?: (workflow: unknown) => void;
  /** Hook to register a persona at runtime. */
  registerPersona?: (persona: unknown) => void;
}

/**
 * Contract for `complete_plugin` modules. A complete plugin is a JS
 * module that default-exports (or named-exports `default`) an object
 * satisfying this interface. Its `init(ctx)` is called on load and
 * `destroy?()` on unload.
 *
 * This is declared locally to avoid a hard runtime dependency on a
 * future `@sanix/core/plugins` module; it is structurally compatible
 * with whatever `PluginManager` eventually defines.
 *
 * @example
 * ```ts
 * // my-plugin.ts
 * import type { SanixPlugin, SanixPluginContext } from '@sanix/marketplace';
 * const plugin: SanixPlugin = {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   init(ctx: SanixPluginContext) {
 *     ctx.log?.('info', 'my-plugin loaded');
 *   },
 *   destroy() {
 *     // cleanup
 *   },
 * };
 * export default plugin;
 * ```
 */
export interface SanixPlugin {
  /** Plugin name. */
  name: string;
  /** Plugin version. */
  version: string;
  /** Called when the plugin is loaded. */
  init(ctx: SanixPluginContext): Promise<void> | void;
  /** Called when the plugin is unloaded (optional). */
  destroy?(): Promise<void> | void;
}

// ── Event payloads ──────────────────────────────────────────────────────────

/** Event map for {@link PluginInstaller} (`extends EventEmitter`). */
export interface PluginInstallerEvents {
  'install:start': { pluginId: string; version?: string };
  'install:download': { pluginId: string; bytes: number };
  'install:extract': { pluginId: string; installPath: string };
  'install:complete': { pluginId: string; installed: InstalledPlugin };
  'install:failed': { pluginId: string; error: string };
  'uninstall': { pluginId: string };
  'update': { pluginId: string; fromVersion: string; toVersion: string; installed: InstalledPlugin };
}

/** Event map for {@link PluginUpdater} (`extends EventEmitter`). */
export interface PluginUpdaterEvents {
  'update:available': { id: string; currentVersion: string; latestVersion: string };
  'update:installed': { id: string; fromVersion: string; toVersion: string };
  'update:failed': { id: string; error: string };
}

/** Event map for {@link MarketplaceManager} (re-emits all subsystem events). */
export interface MarketplaceManagerEvents {
  'install:start': PluginInstallerEvents['install:start'];
  'install:download': PluginInstallerEvents['install:download'];
  'install:extract': PluginInstallerEvents['install:extract'];
  'install:complete': PluginInstallerEvents['install:complete'];
  'install:failed': PluginInstallerEvents['install:failed'];
  'uninstall': PluginInstallerEvents['uninstall'];
  'update': PluginInstallerEvents['update'];
  'update:available': PluginUpdaterEvents['update:available'];
  'update:installed': PluginUpdaterEvents['update:installed'];
  'update:failed': PluginUpdaterEvents['update:failed'];
  'load:result': { result: LoadResult };
}

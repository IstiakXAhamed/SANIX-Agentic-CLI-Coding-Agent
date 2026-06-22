/**
 * @file index.ts
 * @description Public entry point for `@sanix/marketplace` — the SANIX
 * plugin marketplace. Re-exports the full surface:
 *
 *   - **types**             — `PluginType`, `MarketplacePlugin`,
 *     `PluginInstallSpec`, `InstalledPlugin`, `MarketplaceConfig`,
 *     `SearchQuery`, `PublishSpec`, `ValidationResult`,
 *     `UpdateCheckResult`, `LoadResult`, `SanixPlugin`,
 *     `SanixPluginContext`, event-map interfaces.
 *   - **MarketplaceClient** — HTTP client for the registry (search / get
 *     / list / featured / publish / unpublish / rate / download) with
 *     timeout + retry + tiered caching + graceful degradation.
 *   - **PluginInstaller**   — Downloads + installs plugins to
 *     `~/.sanix/plugins/` (npm / github / url / file / inline kinds),
 *     with trust-gate enforcement + lifecycle events.
 *   - **PluginValidator**   — Pre-install security + compatibility
 *     validation (semver, trust, license, dangerous-pattern scan, trust
 *     score 0..100).
 *   - **PluginLoader**      — Loads installed plugins and registers
 *     them with the appropriate SANIX subsystem.
 *   - **PluginPublisher**   — Helpers for publishing workflows /
 *     personas / tools / `sanix-plugin.yaml` manifests to the registry.
 *   - **PluginUpdater**     — Background job that checks for updates
 *     and (optionally) auto-installs them.
 *   - **MarketplaceManager**— Top-level facade combining all of the
 *     above with re-emitted events.
 *
 * Import paths:
 *   ```ts
 *   import { MarketplaceManager, MarketplaceClient } from '@sanix/marketplace';
 *   import { PluginInstaller, PluginValidator } from '@sanix/marketplace';
 *   import { PluginLoader, PluginPublisher, PluginUpdater } from '@sanix/marketplace';
 *   import type { MarketplacePlugin, PublishSpec, SearchQuery } from '@sanix/marketplace';
 *   ```
 *
 * @packageDocumentation
 */

// ── Types ───────────────────────────────────────────────────────────────────
export type {
  PluginType,
  PluginInstallSpec,
  MarketplacePlugin,
  InstalledPlugin,
  MarketplaceConfig,
  SearchQuery,
  PublishSpec,
  ValidationResult,
  UpdateCheckResult,
  LoadResult,
  SanixPlugin,
  SanixPluginContext,
  PluginInstallerEvents,
  PluginUpdaterEvents,
  MarketplaceManagerEvents,
} from './types.js';

// ── MarketplaceClient ───────────────────────────────────────────────────────
export {
  MarketplaceClient,
  MarketplacePluginSchema,
  type MarketplaceClientOptions,
} from './MarketplaceClient.js';

// ── PluginInstaller ─────────────────────────────────────────────────────────
export {
  PluginInstaller,
  type PluginInstallerOptions,
  type InstallOptions,
} from './PluginInstaller.js';

// ── PluginValidator ─────────────────────────────────────────────────────────
export {
  PluginValidator,
  type ValidateOptions,
} from './PluginValidator.js';

// ── PluginLoader ────────────────────────────────────────────────────────────
export {
  PluginLoader,
  type PluginLoaderOptions,
  type WorkflowLoaderLike,
  type ToolRegistryLike,
  type KnowledgeManagerLike,
  type PluginManagerLike,
} from './PluginLoader.js';

// ── PluginPublisher ─────────────────────────────────────────────────────────
export {
  PluginPublisher,
  type PluginPublisherOptions,
  type AuthorInfo,
  type WorkflowLike,
  type PersonaLike,
  type ToolLike,
} from './PluginPublisher.js';

// ── PluginUpdater ───────────────────────────────────────────────────────────
export {
  PluginUpdater,
  type PluginUpdaterOptions,
} from './PluginUpdater.js';

// ── MarketplaceManager ──────────────────────────────────────────────────────
export {
  MarketplaceManager,
  type MarketplaceManagerOptions,
} from './MarketplaceManager.js';

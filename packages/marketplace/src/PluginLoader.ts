/**
 * @file PluginLoader.ts
 * @description Loads installed SANIX marketplace plugins and registers
 * them with the appropriate SANIX subsystem (`WorkflowLoader`,
 * `ToolRegistry`, `KnowledgeManager`, `PluginManager`, persona /
 * team-template / theme registries).
 *
 * Loading is **per-type**: each plugin kind has a dedicated loader that
 * parses the on-disk artifact, validates it against the expected
 * schema, and registers it with the supplied subsystem. Failures are
 * collected (not thrown) so one bad plugin doesn't block the rest.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PLUGIN_DESCRIPTOR_FILENAME } from './_constants.js';
import { expandPath, readJsonOrNull } from './_util.js';
import { MarketplacePluginSchema } from './MarketplaceClient.js';
import type {
  InstalledPlugin,
  LoadResult,
  MarketplacePlugin,
  SanixPlugin,
  SanixPluginContext,
} from './types.js';

// ── Structural "Like" interfaces ────────────────────────────────────────────
//
// Declared locally (structurally compatible with the real classes from
// `@sanix/workflows`, `@sanix/core`, `@sanix/knowledge`) so the loader
// has no hard runtime dependency on those packages. Callers pass real
// instances and TypeScript structural typing verifies compatibility.

/**
 * Minimal surface the loader uses from `WorkflowLoader`. The real
 * `@sanix/workflows/WorkflowLoader` satisfies this structurally.
 */
export interface WorkflowLoaderLike {
  /** Parse a YAML string into a validated workflow. */
  parse(yaml: string): unknown;
  /** Validate an already-parsed object (e.g. from JSON). */
  validate(workflow: unknown): unknown;
}

/**
 * Minimal surface the loader uses from `ToolRegistry`. The real
 * `@sanix/core/ToolRegistry` satisfies this structurally.
 */
export interface ToolRegistryLike {
  /** Register a tool instance. */
  register(tool: unknown, opts?: { source?: string; enabled?: boolean }): unknown;
}

/**
 * Minimal surface the loader uses from `KnowledgeManager`. The real
 * `@sanix/knowledge/KnowledgeManager` satisfies this structurally
 * (registration methods are best-effort — if a method is absent the
 * loader logs a warning instead of failing).
 */
export interface KnowledgeManagerLike {
  /** Optional: register an entity type schema. */
  registerEntityType?: (schema: unknown) => unknown;
  /** Optional: register a relationship type schema. */
  registerRelationshipType?: (schema: unknown) => unknown;
}

/**
 * Minimal surface the loader uses from a (future) `PluginManager`. The
 * loader calls `register(plugin)` for `complete_plugin` kinds.
 */
export interface PluginManagerLike {
  /** Register a complete plugin. */
  register(plugin: SanixPlugin): unknown;
  /** Optional: unregister on unload. */
  unregister?(name: string): unknown;
}

/** Constructor options for {@link PluginLoader}. */
export interface PluginLoaderOptions {
  /** Plugin install root (default `~/.sanix/plugins`). */
  installDir?: string;
  /** Optional workflow loader for `workflow` plugins. */
  workflowLoader?: WorkflowLoaderLike;
  /** Optional tool registry for `tool` plugins. */
  toolRegistry?: ToolRegistryLike;
  /** Optional plugin manager for `complete_plugin` plugins. */
  pluginManager?: PluginManagerLike;
  /** Optional knowledge manager for `knowledge_schema` plugins. */
  knowledgeManager?: KnowledgeManagerLike;
  /** Optional callback to register a persona. */
  registerPersona?: (persona: unknown) => void;
  /** Optional callback to register a team template (agent_template). */
  registerTeamTemplate?: (config: unknown) => void;
  /** Optional callback to register a TUI theme. */
  registerTheme?: (theme: unknown) => void;
  /** Optional logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

// ── Zod schemas for plugin artifacts ────────────────────────────────────────

/** Zod schema for a persona JSON artifact. */
const PersonaArtifactSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  tools: z.array(z.string()).optional(),
  provider: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  traits: z.array(z.string()),
  exampleQueries: z.array(z.string()),
}).passthrough();

/** Zod schema for a knowledge-schema JSON artifact. */
const KnowledgeSchemaArtifactSchema = z.object({
  entityTypes: z.array(z.object({
    name: z.string(),
    color: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()).optional(),
  relationshipTypes: z.array(z.object({
    name: z.string(),
    sourceType: z.string().optional(),
    targetType: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()).optional(),
  propertySchemas: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** Zod schema for an agent-template (team config) JSON artifact. */
const AgentTemplateArtifactSchema = z.object({
  name: z.string(),
  description: z.string(),
  members: z.array(z.object({
    id: z.string(),
    persona: z.string(),
    role: z.string(),
    weight: z.number(),
    budget: z.object({ tokens: z.number(), costUsd: z.number() }),
  }).passthrough()),
  strategy: z.string(),
  consensus: z.string(),
  rounds: z.number(),
  maxConcurrent: z.number(),
  timeoutMs: z.number(),
}).passthrough();

/** Zod schema for a theme JSON artifact. */
const ThemeArtifactSchema = z.object({
  name: z.string(),
  colors: z.record(z.string(), z.string()).optional(),
  fonts: z.record(z.string(), z.string()).optional(),
  ui: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// ── PluginLoader ────────────────────────────────────────────────────────────

/**
 * Loads installed plugins and registers them with the appropriate
 * SANIX subsystem.
 *
 * The loader is **permissive**: a failed plugin is recorded in
 * {@link LoadResult.errors} but does not abort loading of the remaining
 * plugins.
 *
 * @example
 * ```ts
 * const loader = new PluginLoader({
 *   installDir: '~/.sanix/plugins',
 *   workflowLoader,
 *   toolRegistry,
 *   pluginManager,
 *   knowledgeManager,
 *   registerPersona: (p) => personaRegistry.set(p.id, p),
 *   registerTeamTemplate: (t) => teamTemplates.push(t),
 *   registerTheme: (t) => themeManager.add(t),
 * });
 * const result = await loader.loadAll();
 * console.log(`loaded ${result.loaded}, failed ${result.failed}`);
 * ```
 */
export class PluginLoader {
  /** Absolute install root. */
  readonly installDir: string;
  private readonly opts: PluginLoaderOptions;
  /** Tracks loaded complete_plugins so they can be destroyed on unload. */
  private readonly loadedCompletePlugins = new Map<string, SanixPlugin>();

  /**
   * @param opts - Construction options.
   */
  constructor(opts: PluginLoaderOptions = {}) {
    this.opts = opts;
    this.installDir = expandPath(opts.installDir ?? '~/.sanix/plugins');
  }

  // ── Load all ──────────────────────────────────────────────────────────────

  /**
   * Scan the install directory and load every enabled plugin.
   *
   * @returns Aggregate load result.
   *
   * @example
   * ```ts
   * const result = await loader.loadAll();
   * ```
   */
  async loadAll(): Promise<LoadResult> {
    // Read the manifest to know which plugins are enabled.
    const manifestPath = path.join(this.installDir, 'installed.json');
    const raw = await readJsonOrNull(manifestPath);
    const installed: InstalledPlugin[] = Array.isArray(raw) ? raw.filter(isInstalledPlugin) : [];
    let loaded = 0;
    let failed = 0;
    const errors: LoadResult['errors'] = [];
    for (const entry of installed) {
      if (!entry.enabled) {
        this.log('info', `skipping disabled plugin ${entry.id}`);
        continue;
      }
      const r = await this.loadOne(entry.id);
      loaded += r.loaded;
      failed += r.failed;
      errors.push(...r.errors);
    }
    return { loaded, failed, errors };
  }

  // ── Load one ──────────────────────────────────────────────────────────────

  /**
   * Load a single plugin by id. Reads its descriptor, dispatches to the
   * per-type loader, and returns a single-entry result.
   *
   * @param id - Plugin id.
   * @returns Load result (loaded=1 / failed=1 + errors).
   *
   * @example
   * ```ts
   * const r = await loader.loadOne('sanim/code-review-pro');
   * ```
   */
  async loadOne(id: string): Promise<LoadResult> {
    const manifestPath = path.join(this.installDir, 'installed.json');
    const raw = await readJsonOrNull(manifestPath);
    const installed: InstalledPlugin[] = Array.isArray(raw) ? raw.filter(isInstalledPlugin) : [];
    const entry = installed.find((e) => e.id === id);
    if (!entry) {
      return { loaded: 0, failed: 1, errors: [{ pluginId: id, error: 'not installed' }] };
    }
    // Read the per-plugin descriptor.
    const descriptorPath = path.join(entry.installPath, PLUGIN_DESCRIPTOR_FILENAME);
    const desc = await readJsonOrNull(descriptorPath);
    if (!desc || typeof desc !== 'object') {
      return { loaded: 0, failed: 1, errors: [{ pluginId: id, error: 'missing or invalid descriptor' }] };
    }
    // Validate the descriptor as a MarketplacePlugin.
    let plugin: MarketplacePlugin;
    try {
      plugin = MarketplacePluginSchema.parse(desc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { loaded: 0, failed: 1, errors: [{ pluginId: id, error: `invalid descriptor: ${msg}` }] };
    }
    // Dispatch.
    try {
      await this.loadByType(plugin, entry);
      this.log('info', `loaded ${plugin.type} plugin ${plugin.id}`);
      return { loaded: 1, failed: 0, errors: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `failed to load ${plugin.id}: ${msg}`);
      return { loaded: 0, failed: 1, errors: [{ pluginId: id, error: msg }] };
    }
  }

  // ── Unload ────────────────────────────────────────────────────────────────

  /**
   * Unload a previously-loaded `complete_plugin` (calls its `destroy?()`
   * and unregisters it). No-op for other plugin types (they're stateless
   * registrations that the caller can revoke directly).
   *
   * @param id - Plugin id.
   */
  async unload(id: string): Promise<void> {
    const plugin = this.loadedCompletePlugins.get(id);
    if (!plugin) return;
    try {
      await plugin.destroy?.();
    } catch (err) {
      this.log('warn', `error destroying ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.loadedCompletePlugins.delete(id);
  }

  // ── Per-type loaders ──────────────────────────────────────────────────────

  /**
   * Dispatch to the per-type loader. Throws on failure.
   */
  private async loadByType(plugin: MarketplacePlugin, entry: InstalledPlugin): Promise<void> {
    switch (plugin.type) {
      case 'workflow':
        return this.loadWorkflow(plugin, entry);
      case 'persona':
        return this.loadPersona(plugin, entry);
      case 'tool':
        return this.loadTool(plugin, entry);
      case 'knowledge_schema':
        return this.loadKnowledgeSchema(plugin, entry);
      case 'agent_template':
        return this.loadAgentTemplate(plugin, entry);
      case 'theme':
        return this.loadTheme(plugin, entry);
      case 'complete_plugin':
        return this.loadCompletePlugin(plugin, entry);
    }
  }

  /**
   * `workflow`: read the `.yaml` file (or inline content), parse via
   * `WorkflowLoader`, register with the workflow registry.
   */
  private async loadWorkflow(plugin: MarketplacePlugin, entry: InstalledPlugin): Promise<void> {
    if (!this.opts.workflowLoader) {
      throw new Error('no workflowLoader configured');
    }
    const yamlText = await this.readArtifact(plugin, entry, '.yaml');
    const workflow = this.opts.workflowLoader.parse(yamlText);
    // The WorkflowLoader.parse returns a validated Workflow; the caller's
    // workflow registry is the loader's own internal store (built-ins +
    // user dir + project dir). Installing a workflow means writing the
    // YAML to ~/.sanix/workflows/<name>.yaml — which the installer
    // already did via the `inline` kind. Here we just validate it parses.
    this.log('info', `workflow '${plugin.name}' parsed (${(workflow as { steps?: unknown[] })?.steps?.length ?? 0} steps)`);
  }

  /**
   * `persona`: read the `.json` file, validate, call `registerPersona`.
   */
  private async loadPersona(plugin: MarketplacePlugin, entry: InstalledPlugin): Promise<void> {
    if (!this.opts.registerPersona) {
      throw new Error('no registerPersona callback configured');
    }
    const json = await this.readArtifact(plugin, entry, '.json');
    const parsed = PersonaArtifactSchema.parse(JSON.parse(json));
    this.opts.registerPersona(parsed);
  }

  /**
   * `tool`: dynamic `import()` the `.js` file. Expect a default export
   * that is a `SanixTool` instance or a factory `() => SanixTool`.
   * Register with the `ToolRegistry`.
   */
  private async loadTool(plugin: MarketplacePlugin, entry: InstalledPlugin): Promise<void> {
    if (!this.opts.toolRegistry) {
      throw new Error('no toolRegistry configured');
    }
    const jsPath = await this.resolveArtifact(plugin, entry, '.js');
    const mod = await import(pathToFileURL(jsPath).href) as { default?: unknown; tool?: unknown };
    const exported = mod.default ?? mod.tool;
    if (!exported) {
      throw new Error(`tool module '${jsPath}' has no default export`);
    }
    // If it's a factory, call it.
    const tool = typeof exported === 'function' ? (exported as () => unknown)() : exported;
    this.opts.toolRegistry.register(tool, { source: `marketplace:${plugin.id}` });
  }

  /**
   * `knowledge_schema`: read the `.json` file, validate, register entity
   * types / relationship types with the `KnowledgeManager`.
   */
  private async loadKnowledgeSchema(plugin: MarketplacePlugin, entry: InstalledPlugin): Promise<void> {
    if (!this.opts.knowledgeManager) {
      throw new Error('no knowledgeManager configured');
    }
    const json = await this.readArtifact(plugin, entry, '.json');
    const parsed = KnowledgeSchemaArtifactSchema.parse(JSON.parse(json));
    const km = this.opts.knowledgeManager;
    let registered = 0;
    if (km.registerEntityType) {
      for (const et of parsed.entityTypes ?? []) {
        km.registerEntityType(et);
        registered++;
      }
    }
    if (km.registerRelationshipType) {
      for (const rt of parsed.relationshipTypes ?? []) {
        km.registerRelationshipType(rt);
        registered++;
      }
    }
    this.log('info', `knowledge_schema '${plugin.name}' registered ${registered} types`);
  }

  /**
   * `agent_template`: read the `.json` file, validate as a team config,
   * call `registerTeamTemplate`.
   */
  private async loadAgentTemplate(plugin: MarketplacePlugin, entry: InstalledPlugin): Promise<void> {
    if (!this.opts.registerTeamTemplate) {
      throw new Error('no registerTeamTemplate callback configured');
    }
    const json = await this.readArtifact(plugin, entry, '.json');
    const parsed = AgentTemplateArtifactSchema.parse(JSON.parse(json));
    this.opts.registerTeamTemplate(parsed);
  }

  /**
   * `theme`: read the `.json` file, validate, call `registerTheme`.
   */
  private async loadTheme(plugin: MarketplacePlugin, entry: InstalledPlugin): Promise<void> {
    if (!this.opts.registerTheme) {
      throw new Error('no registerTheme callback configured');
    }
    const json = await this.readArtifact(plugin, entry, '.json');
    const parsed = ThemeArtifactSchema.parse(JSON.parse(json));
    this.opts.registerTheme(parsed);
  }

  /**
   * `complete_plugin`: dynamic `import()` the `.js` file, expect a
   * `SanixPlugin` default export, call `init(ctx)`, optionally register
   * with the `PluginManager`.
   */
  private async loadCompletePlugin(plugin: MarketplacePlugin, entry: InstalledPlugin): Promise<void> {
    const jsPath = await this.resolveArtifact(plugin, entry, '.js');
    const mod = await import(pathToFileURL(jsPath).href) as { default?: unknown; plugin?: unknown };
    const exported = mod.default ?? mod.plugin;
    if (!exported || typeof exported !== 'object') {
      throw new Error(`complete_plugin module '${jsPath}' has no default export object`);
    }
    const sanixPlugin = exported as Partial<SanixPlugin>;
    if (typeof sanixPlugin.name !== 'string' || typeof sanixPlugin.version !== 'string' || typeof sanixPlugin.init !== 'function') {
      throw new Error(`complete_plugin '${jsPath}' does not satisfy the SanixPlugin contract`);
    }
    const ctx: SanixPluginContext = {
      installPath: entry.installPath,
      pluginId: plugin.id,
      config: entry.config,
      log: (level, msg, meta) => this.log(level, `[${plugin.id}] ${msg}`, meta),
      registerTool: this.opts.toolRegistry
        ? (tool) => this.opts.toolRegistry?.register(tool, { source: `marketplace:${plugin.id}` })
        : undefined,
    };
    await sanixPlugin.init(ctx);
    this.loadedCompletePlugins.set(plugin.id, sanixPlugin as SanixPlugin);
    if (this.opts.pluginManager) {
      this.opts.pluginManager.register(sanixPlugin as SanixPlugin);
    }
  }

  // ── Artifact I/O ──────────────────────────────────────────────────────────

  /**
   * Read an artifact file (`.yaml` / `.json` / `.js`) from the install
   * path. For `inline` installs the content is in the descriptor's
   * `install.content` — return that directly. For other install kinds
   * the file lives at `<installPath>/<name>.<ext>`.
   */
  private async readArtifact(plugin: MarketplacePlugin, entry: InstalledPlugin, ext: string): Promise<string> {
    if (plugin.install.kind === 'inline') {
      return plugin.install.content;
    }
    const filePath = path.join(entry.installPath, `${plugin.name}${ext}`);
    return fs.readFile(filePath, 'utf8');
  }

  /**
   * Resolve (and verify existence of) an artifact file path. For inline
   * installs the content is written to `<installPath>/<name>.<ext>` by
   * the installer — so the path is the same.
   */
  private async resolveArtifact(plugin: MarketplacePlugin, entry: InstalledPlugin, ext: string): Promise<string> {
    const filePath = path.join(entry.installPath, `${plugin.name}${ext}`);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      throw new Error(`artifact not found: ${filePath}`);
    }
  }

  // ── Logging ───────────────────────────────────────────────────────────────

  /** Emit a log line via the optional `log` callback (default: noop). */
  private log(level: 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
    this.opts.log?.(level, msg, meta);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Runtime guard for {@link InstalledPlugin}. */
function isInstalledPlugin(v: unknown): v is InstalledPlugin {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as InstalledPlugin).id === 'string' &&
    typeof (v as InstalledPlugin).marketplaceId === 'string' &&
    typeof (v as InstalledPlugin).version === 'string' &&
    typeof (v as InstalledPlugin).installPath === 'string' &&
    typeof (v as InstalledPlugin).enabled === 'boolean'
  );
}

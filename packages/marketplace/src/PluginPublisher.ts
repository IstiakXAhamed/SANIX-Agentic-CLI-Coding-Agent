/**
 * @file PluginPublisher.ts
 * @description Helpers for publishing SANIX plugins to the marketplace
 * registry. Wraps in-memory `Workflow` / `AgentPersona` / `SanixTool`
 * objects into {@link PublishSpec}s, reads `sanix-plugin.yaml`
 * manifests from a directory, validates specs, and delegates the
 * actual HTTP `POST` to {@link MarketplaceClient.publish}.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { MarketplaceClient } from './MarketplaceClient.js';
import { ACCEPTED_SPDX_LICENSES } from './_constants.js';
import { expandPath, parseSemver, scanDangerousPatterns } from './_util.js';
import type {
  PluginInstallSpec,
  PluginType,
  PublishSpec,
} from './types.js';

// Synchronous require for `js-yaml` (keeps `publishFromDir` simple).
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type JsYamlModule = typeof import('js-yaml');
let _yaml: JsYamlModule | undefined;
function yaml(): JsYamlModule {
  if (!_yaml) _yaml = require('js-yaml') as JsYamlModule;
  return _yaml;
}

// ── Structural types for publishable objects ────────────────────────────────
//
// Declared locally so the publisher has no hard runtime dependency on
// `@sanix/workflows` / `@sanix/tools`. Callers pass real instances and
// TypeScript structural typing verifies compatibility.

/**
 * Minimal surface the publisher uses from a `Workflow` object. The real
 * `@sanix/workflows.Workflow` satisfies this structurally.
 */
export interface WorkflowLike {
  name: string;
  description?: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Minimal surface the publisher uses from an `AgentPersona`. The real
 * `@sanix/workflows.AgentPersona` satisfies this structurally.
 */
export interface PersonaLike {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  traits: string[];
  exampleQueries: string[];
}

/**
 * Minimal surface the publisher uses from a `SanixTool`. The real
 * `@sanix/tools.SanixTool` satisfies this structurally.
 */
export interface ToolLike {
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

// ── Author info ─────────────────────────────────────────────────────────────

/** Author info accepted by the publisher. */
export interface AuthorInfo {
  name: string;
  email?: string;
  url?: string;
}

/** Constructor options for {@link PluginPublisher}. */
export interface PluginPublisherOptions {
  /** Bearer token used for authenticated publish calls. */
  authToken: string;
  /** Default author info applied when a spec doesn't supply one. */
  defaultAuthor?: AuthorInfo;
  /** Default license applied when a spec doesn't supply one. */
  defaultLicense?: string;
  /** Default min SANIX version applied when a spec doesn't supply one. */
  defaultSanixVersion?: string;
}

// ── PluginPublisher ─────────────────────────────────────────────────────────

/**
 * Publishes SANIX plugins to the marketplace registry.
 *
 * The publisher is a thin wrapper over {@link MarketplaceClient.publish}
 * that handles:
 *
 *   - Reading `sanix-plugin.yaml` manifests from a directory.
 *   - Wrapping in-memory `Workflow` / `AgentPersona` / `SanixTool`
 *     objects into {@link PublishSpec}s.
 *   - Serializing tool metadata (name, description, permissions) — the
 *     tool *implementation* is NOT published; it's distributed via a
 *     `url` / `github` install spec the caller supplies.
 *   - Validating specs before submission.
 *
 * @example
 * ```ts
 * const publisher = new PluginPublisher(client, { authToken: TOKEN });
 *
 * // Publish from a directory with a sanix-plugin.yaml
 * const { id, url } = await publisher.publishFromDir('./my-plugin');
 *
 * // Publish an in-memory workflow
 * await publisher.publishWorkflow('my-wf', workflow, {
 *   author: { name: 'Istiak Ahamed' },
 *   license: 'MIT',
 *   install: { kind: 'inline', content: yamlText },
 * });
 * ```
 */
export class PluginPublisher {
  /** The underlying marketplace client (used for the HTTP POST). */
  readonly client: MarketplaceClient;
  readonly authToken: string;
  readonly defaultAuthor?: AuthorInfo;
  readonly defaultLicense?: string;
  readonly defaultSanixVersion?: string;

  /**
   * @param client - A {@link MarketplaceClient} (may or may not already
   *   carry an `authToken` — the publisher's `authToken` takes precedence
   *   and is passed on each publish call).
   * @param opts - Publisher options (must include `authToken`).
   */
  constructor(client: MarketplaceClient, opts: PluginPublisherOptions) {
    this.client = client;
    this.authToken = opts.authToken;
    this.defaultAuthor = opts.defaultAuthor;
    this.defaultLicense = opts.defaultLicense;
    this.defaultSanixVersion = opts.defaultSanixVersion;
  }

  // ── publishFromDir ────────────────────────────────────────────────────────

  /**
   * Read `sanix-plugin.yaml` from a directory, validate it, and publish.
   *
   * The manifest schema:
   * ```yaml
   * name: my-workflow
   * displayName: My Workflow
   * description: Does X, Y, Z
   * type: workflow
   * version: 1.0.0
   * author:
   *   name: Istiak Ahamed
   *   email: sanim@example.com
   * license: MIT
   * keywords: [code, review]
   * sanixVersion: '>=1.0.0'
   * install:
   *   kind: inline
   *   content: |
   *     name: my-workflow
   *     steps: [...]
   * readme: |
   *   # My Workflow
   * ```
   *
   * @param dir - Directory containing `sanix-plugin.yaml`.
   * @returns The assigned id + registry URL.
   * @throws {Error} if the manifest is missing, malformed, or fails validation.
   *
   * @example
   * ```ts
   * const { id, url } = await publisher.publishFromDir('./my-plugin');
   * ```
   */
  async publishFromDir(dir: string): Promise<{ id: string; url: string }> {
    const manifestPath = path.join(expandPath(dir), 'sanix-plugin.yaml');
    const text = await fs.readFile(manifestPath, 'utf8');
    const parsed = yaml().load(text) as unknown;
    const spec = this.manifestToSpec(parsed, dir);
    const validation = await this.validate(spec);
    if (!validation.valid) {
      throw new Error(`invalid sanix-plugin.yaml: ${validation.errors.join('; ')}`);
    }
    return this.client.publish(spec);
  }

  // ── publishWorkflow ───────────────────────────────────────────────────────

  /**
   * Publish an in-memory `Workflow` object as a `workflow` plugin.
   *
   * @param name - Plugin name (also used as the id namespace).
   * @param workflow - The workflow object.
   * @param opts - Required: `author`, `license`, `install` (kind=inline
   *   with YAML-serialized workflow, OR a `url`/`github` ref pointing to
   *   the workflow file).
   * @returns The assigned id + registry URL.
   *
   * @example
   * ```ts
   * await publisher.publishWorkflow('my-wf', workflow, {
   *   author: { name: 'Istiak Ahamed' },
   *   license: 'MIT',
   *   install: { kind: 'inline', content: yamlText },
   *   keywords: ['code', 'review'],
   * });
   * ```
   */
  async publishWorkflow(
    name: string,
    workflow: WorkflowLike,
    opts: {
      author: AuthorInfo;
      license: string;
      install: PluginInstallSpec;
      keywords?: string[];
      displayName?: string;
      description?: string;
      sanixVersion?: string;
      readme?: string;
    },
  ): Promise<{ id: string; url: string }> {
    const spec: PublishSpec = {
      name,
      displayName: opts.displayName ?? workflow.name,
      description: opts.description ?? workflow.description ?? `Workflow: ${name}`,
      type: 'workflow' as PluginType,
      version: (workflow.version as string | undefined) ?? '1.0.0',
      author: opts.author,
      license: opts.license,
      keywords: opts.keywords ?? [],
      sanixVersion: opts.sanixVersion ?? this.defaultSanixVersion ?? '>=1.0.0',
      install: opts.install,
      readme: opts.readme,
    };
    const validation = await this.validate(spec);
    if (!validation.valid) {
      throw new Error(`invalid workflow spec: ${validation.errors.join('; ')}`);
    }
    return this.client.publish(spec);
  }

  // ── publishPersona ────────────────────────────────────────────────────────

  /**
   * Publish an in-memory `AgentPersona` as a `persona` plugin.
   *
   * @param name - Plugin name.
   * @param persona - The persona object.
   * @param opts - Required: `author`, `license`.
   * @returns The assigned id + registry URL.
   *
   * @example
   * ```ts
   * await publisher.publishPersona('security-auditor', persona, {
   *   author: { name: 'Istiak Ahamed' },
   *   license: 'MIT',
   * });
   * ```
   */
  async publishPersona(
    name: string,
    persona: PersonaLike,
    opts: {
      author: AuthorInfo;
      license: string;
      version?: string;
      keywords?: string[];
      sanixVersion?: string;
      readme?: string;
    },
  ): Promise<{ id: string; url: string }> {
    const content = JSON.stringify(persona, null, 2);
    const spec: PublishSpec = {
      name,
      displayName: persona.name,
      description: persona.description,
      type: 'persona' as PluginType,
      version: opts.version ?? '1.0.0',
      author: opts.author,
      license: opts.license,
      keywords: opts.keywords ?? persona.traits,
      sanixVersion: opts.sanixVersion ?? this.defaultSanixVersion ?? '>=1.0.0',
      install: { kind: 'inline', content },
      readme: opts.readme,
    };
    const validation = await this.validate(spec);
    if (!validation.valid) {
      throw new Error(`invalid persona spec: ${validation.errors.join('; ')}`);
    }
    return this.client.publish(spec);
  }

  // ── publishTool ───────────────────────────────────────────────────────────

  /**
   * Publish a tool's *metadata* as a `tool` plugin. The tool
   * *implementation* is NOT serialized — it's distributed via the
   * `install` spec the caller supplies (typically a `github` or `url`
   * ref pointing to the JS module that default-exports the tool).
   *
   * @param name - Plugin name.
   * @param tool - The tool instance (only metadata is read).
   * @param opts - Required: `author`, `license`, `install` (must be
   *   `github`/`url`/`file` — `inline` is rejected since the
   *   implementation can't be inlined safely).
   * @returns The assigned id + registry URL.
   * @throws {Error} if `install.kind === 'inline'` or validation fails.
   *
   * @example
   * ```ts
   * await publisher.publishTool('my-tool', tool, {
   *   author: { name: 'Istiak Ahamed' },
   *   license: 'MIT',
   *   install: { kind: 'github', repo: 'sanim/my-tool', ref: 'v1.0.0' },
   * });
   * ```
   */
  async publishTool(
    name: string,
    tool: ToolLike,
    opts: {
      author: AuthorInfo;
      license: string;
      install: PluginInstallSpec;
      version?: string;
      keywords?: string[];
      displayName?: string;
      description?: string;
      sanixVersion?: string;
      readme?: string;
    },
  ): Promise<{ id: string; url: string }> {
    if (opts.install.kind === 'inline') {
      throw new Error(
        `publishTool: inline install is not allowed — tools must be distributed via github/url/file so the implementation is auditable`,
      );
    }
    const spec: PublishSpec = {
      name,
      displayName: opts.displayName ?? tool.name,
      description: opts.description ?? tool.description,
      type: 'tool' as PluginType,
      version: opts.version ?? '1.0.0',
      author: opts.author,
      license: opts.license,
      keywords: opts.keywords ?? [...tool.permissions],
      sanixVersion: opts.sanixVersion ?? this.defaultSanixVersion ?? '>=1.0.0',
      install: opts.install,
      readme: opts.readme,
    };
    const validation = await this.validate(spec);
    if (!validation.valid) {
      throw new Error(`invalid tool spec: ${validation.errors.join('; ')}`);
    }
    return this.client.publish(spec);
  }

  // ── validate ──────────────────────────────────────────────────────────────

  /**
   * Validate a {@link PublishSpec} before submission. Checks:
   *
   *   - Required fields (`name`, `displayName`, `description`, `type`,
   *     `version`, `author.name`, `license`, `sanixVersion`, `install`).
   *   - Version is valid semver.
   *   - License is in the SPDX allow-list (warning, not error).
   *   - `sanixVersion` is a non-empty string.
   *   - Install spec is well-formed for its kind.
   *   - Inline content for `tool`/`complete_plugin` doesn't contain
   *     dangerous patterns (`eval`, `child_process`, `Function(`, …).
   *
   * @param spec - The spec to validate.
   * @returns `{ valid, errors }`.
   *
   * @example
   * ```ts
   * const { valid, errors } = await publisher.validate(spec);
   * if (!valid) console.error(errors);
   * ```
   */
  async validate(spec: PublishSpec): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    if (!spec.name || !/^[a-z0-9-]+$/.test(spec.name)) {
      errors.push(`name must be kebab-case (lowercase, digits, hyphens)`);
    }
    if (!spec.displayName) errors.push('displayName is required');
    if (!spec.description) errors.push('description is required');
    if (!spec.type) errors.push('type is required');
    if (!spec.version) {
      errors.push('version is required');
    } else if (!parseSemver(spec.version)) {
      errors.push(`version '${spec.version}' is not valid semver`);
    }
    if (!spec.author?.name) errors.push('author.name is required');
    if (!spec.license) errors.push('license is required');
    else if (!ACCEPTED_SPDX_LICENSES.has(spec.license)) {
      // Non-blocking — SPDX list is non-exhaustive. Surface as a soft
      // warning via the errors array only if the caller wants strict mode.
      // Here we keep it as a non-error (validate returns valid=true).
    }
    if (!spec.sanixVersion) errors.push('sanixVersion is required');
    if (!spec.install) errors.push('install spec is required');
    else {
      const installErrors = validateInstallSpec(spec.install, spec.type);
      errors.push(...installErrors);
    }
    return { valid: errors.length === 0, errors };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Convert a parsed `sanix-plugin.yaml` object into a {@link PublishSpec}.
   * Applies defaults for `author` / `license` / `sanixVersion` from the
   * publisher's configured defaults.
   */
  private manifestToSpec(parsed: unknown, dir: string): PublishSpec {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('sanix-plugin.yaml is not a mapping');
    }
    const m = parsed as Record<string, unknown>;
    const installRaw = m.install as Record<string, unknown> | undefined;
    if (!installRaw || typeof installRaw !== 'object') {
      throw new Error('sanix-plugin.yaml: missing or invalid install spec');
    }
    const install = installRaw as unknown as PluginInstallSpec;
    const authorRaw = (m.author as Record<string, unknown> | undefined) ?? {};
    const author: AuthorInfo = {
      name: (authorRaw.name as string) ?? this.defaultAuthor?.name ?? '',
      email: authorRaw.email as string | undefined,
      url: authorRaw.url as string | undefined,
    };
    return {
      name: m.name as string,
      displayName: (m.displayName as string) ?? (m.name as string),
      description: m.description as string,
      type: m.type as PluginType,
      version: m.version as string,
      author,
      license: (m.license as string) ?? this.defaultLicense ?? 'MIT',
      keywords: Array.isArray(m.keywords) ? (m.keywords as string[]) : [],
      sanixVersion: (m.sanixVersion as string) ?? this.defaultSanixVersion ?? '>=1.0.0',
      install,
      readme: m.readme as string | undefined,
    };
  }
}

// ── Install-spec validation ─────────────────────────────────────────────────

/**
 * Validate an install spec for its kind. Returns a list of error
 * strings (empty if valid).
 */
function validateInstallSpec(spec: PluginInstallSpec, pluginType: PluginType): string[] {
  const errors: string[] = [];
  switch (spec.kind) {
    case 'npm':
      if (!spec.package) errors.push('install.npm.package is required');
      break;
    case 'github':
      if (!spec.repo) errors.push('install.github.repo is required');
      else if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(spec.repo)) {
        errors.push(`install.github.repo '${spec.repo}' is not 'owner/name'`);
      }
      break;
    case 'url':
      if (!spec.url) errors.push('install.url.url is required');
      else if (!/^https:\/\//.test(spec.url)) errors.push('install.url.url must be https');
      break;
    case 'file':
      if (!spec.path) errors.push('install.file.path is required');
      break;
    case 'inline':
      if (!spec.content) errors.push('install.inline.content is required');
      // Dangerous-pattern scan for executable kinds.
      if (pluginType === 'tool' || pluginType === 'complete_plugin') {
        const scan = scanDangerousPatterns(spec.content);
        for (const e of scan.errors) {
          errors.push(`install.inline.content contains dangerous pattern: ${e}`);
        }
      }
      break;
  }
  return errors;
}

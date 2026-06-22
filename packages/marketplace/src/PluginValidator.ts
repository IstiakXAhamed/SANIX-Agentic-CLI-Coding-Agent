/**
 * @file PluginValidator.ts
 * @description Pre-install security + compatibility validator for
 * SANIX marketplace plugins. Runs a battery of checks:
 *
 *   1. **SANIX version compatibility** — semver range match against
 *      `plugin.sanixVersion` and the running SANIX version.
 *   2. **Trust level** — gate by trusted-publisher list / verified badge.
 *   3. **License** — SPDX allow-list check.
 *   4. **Install-spec safety** — no `file://` outside `~/.sanix/`, no
 *      `eval()` in inline content, no suspicious URL schemes.
 *   5. **Inline JS scan** — dangerous-pattern scan (`child_process`,
 *      `eval`, `Function(`, …) for `tool` / `complete_plugin` kinds.
 *   6. **GitHub repo heuristics** — warn if repo is too new or has
 *      too few stars (best-effort; uses `repository` field + optional
 *      GitHub API metadata).
 *
 * Produces a {@link ValidationResult} with `valid`, `warnings`,
 * `errors`, and a 0..100 `trustScore`.
 *
 * @packageDocumentation
 */

import { expandPath, satisfiesSemver, scanDangerousPatterns } from './_util.js';
import {
  ACCEPTED_SPDX_LICENSES,
  TRUSTED_PUBLISHERS,
} from './_constants.js';
import type { MarketplacePlugin, ValidationResult } from './types.js';

/** Options for {@link PluginValidator.validate}. */
export interface ValidateOptions {
  /** Trust gate; default `'verified'`. */
  trustLevel?: 'trusted' | 'verified' | 'all';
  /** Running SANIX version (e.g. `'1.2.0'`). Defaults to a sentinel. */
  sanixVersion?: string;
  /** Allow `file://` paths outside `~/.sanix/` (default `false`). */
  allowExternalFilePaths?: boolean;
}

/**
 * Validates plugins before installation.
 *
 * The validator is stateless — a single instance can validate any
 * number of plugins.
 *
 * @example
 * ```ts
 * const validator = new PluginValidator();
 * const result = await validator.validate(plugin, { trustLevel: 'verified', sanixVersion: '1.2.0' });
 * if (!result.valid) {
 *   console.error('Refusing to install:', result.errors.join(', '));
 * } else if (result.warnings.length > 0) {
 *   console.warn('Warnings:', result.warnings.join(', '));
 * }
 * ```
 */
export class PluginValidator {
  /**
   * Validate a plugin against security + compatibility rules.
   *
   * @param plugin - The plugin to validate.
   * @param opts - Validation options.
   * @returns A {@link ValidationResult} with `valid`, `warnings`,
   *   `errors`, and `trustScore` (0..100).
   *
   * @example
   * ```ts
   * const v = await validator.validate(plugin);
   * console.log(v.trustScore, v.valid, v.warnings);
   * ```
   */
  async validate(
    plugin: MarketplacePlugin,
    opts: ValidateOptions = {},
  ): Promise<ValidationResult> {
    const trustLevel = opts.trustLevel ?? 'verified';
    const sanixVersion = opts.sanixVersion ?? '1.0.0';
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. SANIX version compatibility.
    if (!satisfiesSemver(sanixVersion, plugin.sanixVersion)) {
      errors.push(
        `SANIX version ${sanixVersion} does not satisfy plugin requirement '${plugin.sanixVersion}'`,
      );
    }

    // 2. Trust-level gate.
    const isTrustedPublisher = TRUSTED_PUBLISHERS.has(plugin.author.name.toLowerCase());
    if (trustLevel === 'trusted' && !isTrustedPublisher) {
      errors.push(
        `trustLevel='trusted' but author '${plugin.author.name}' is not in the trusted publisher list`,
      );
    } else if (trustLevel === 'verified' && !plugin.verified && !isTrustedPublisher) {
      errors.push(
        `trustLevel='verified' but plugin is neither verified nor from a trusted publisher`,
      );
    }
    // 'all' allows anything (warning below).

    // 3. License check.
    if (!ACCEPTED_SPDX_LICENSES.has(plugin.license)) {
      warnings.push(
        `license '${plugin.license}' is not in the accepted SPDX allow-list (still installable)`,
      );
    }

    // 4. Install-spec safety.
    this.validateInstallSpec(plugin, opts, errors, warnings);

    // 5. Inline JS dangerous-pattern scan (tool / complete_plugin).
    if (
      (plugin.type === 'tool' || plugin.type === 'complete_plugin') &&
      plugin.install.kind === 'inline'
    ) {
      const scan = scanDangerousPatterns(plugin.install.content);
      for (const e of scan.errors) errors.push(`inline JS contains dangerous pattern: ${e}`);
      for (const w of scan.warnings) warnings.push(`inline JS suspicious pattern: ${w}`);
    }
    // For inline workflows / personas / schemas, eval/Function are still errors.
    if (
      plugin.install.kind === 'inline' &&
      (plugin.type === 'workflow' ||
        plugin.type === 'persona' ||
        plugin.type === 'knowledge_schema' ||
        plugin.type === 'agent_template' ||
        plugin.type === 'theme')
    ) {
      const scan = scanDangerousPatterns(plugin.install.content);
      for (const e of scan.errors) errors.push(`inline content contains dangerous pattern: ${e}`);
      for (const w of scan.warnings) warnings.push(`inline content suspicious pattern: ${w}`);
    }

    // 6. GitHub repo heuristics (best-effort warning).
    if (plugin.install.kind === 'github') {
      this.checkGithubHeuristics(plugin, warnings);
    }

    // Trust score 0..100.
    const trustScore = this.computeTrustScore(plugin, isTrustedPublisher);

    return {
      valid: errors.length === 0,
      warnings,
      errors,
      trustScore,
    };
  }

  // ── Install-spec safety ───────────────────────────────────────────────────

  /**
   * Validate the install spec for path / URL safety. Mutates the passed
   * `errors` and `warnings` arrays.
   */
  private validateInstallSpec(
    plugin: MarketplacePlugin,
    opts: ValidateOptions,
    errors: string[],
    warnings: string[],
  ): void {
    const spec = plugin.install;
    switch (spec.kind) {
      case 'file': {
        const resolved = expandPath(spec.path);
        const sanixRoot = expandPath('~/.sanix');
        const allowExternal = opts.allowExternalFilePaths ?? false;
        if (!resolved.startsWith(sanixRoot) && !allowExternal) {
          errors.push(
            `file install path '${spec.path}' is outside ~/.sanix/ (use allowExternalFilePaths to override)`,
          );
        }
        break;
      }
      case 'url': {
        if (!/^https:\/\/[^\s]+$/.test(spec.url)) {
          errors.push(`url install must use https, got '${spec.url}'`);
        }
        if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/i.test(spec.url)) {
          warnings.push(`url install points to a localhost address — possible SSRF`);
        }
        if (spec.checksum && !/^[0-9a-fA-F]{64}$/.test(spec.checksum)) {
          warnings.push(`url checksum is not a valid 64-hex SHA-256 digest`);
        }
        break;
      }
      case 'github': {
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(spec.repo)) {
          errors.push(`github repo '${spec.repo}' is not in 'owner/name' format`);
        }
        break;
      }
      case 'npm': {
        if (!/^[A-Za-z0-9@/_.-]+$/.test(spec.package)) {
          errors.push(`npm package name '${spec.package}' has invalid characters`);
        }
        break;
      }
      case 'inline': {
        if (spec.content.length === 0) {
          errors.push(`inline install content is empty`);
        }
        // Inline content size guard — large inline payloads are suspicious.
        if (spec.content.length > 1_000_000) {
          warnings.push(`inline content is large (${spec.content.length} bytes) — consider a URL/github source`);
        }
        break;
      }
    }
  }

  // ── GitHub heuristics ─────────────────────────────────────────────────────

  /**
   * Best-effort GitHub heuristic checks. Without a GitHub API token we
   * can't fetch star counts or creation dates, so we warn based on the
   * plugin's `createdAt` and `downloads` as proxies for maturity.
   */
  private checkGithubHeuristics(plugin: MarketplacePlugin, warnings: string[]): void {
    const ageDays = (Date.now() - plugin.createdAt) / (1000 * 60 * 60 * 24);
    if (ageDays < 7) {
      warnings.push(`plugin is less than 7 days old (created ${ageDays.toFixed(1)} days ago) — exercise caution`);
    }
    if (plugin.downloads < 10) {
      warnings.push(`plugin has fewer than 10 downloads (${plugin.downloads}) — low adoption`);
    }
  }

  // ── Trust score ───────────────────────────────────────────────────────────

  /**
   * Compute a 0..100 trust score from plugin signals:
   *
   *   - verified badge       : +30
   *   - trusted publisher    : +40
   *   - high downloads (≥1k) : +10
   *   - high rating (≥4.0)   : +10
   *   - old enough (≥30 days): +10
   *
   * Capped at 100.
   */
  private computeTrustScore(plugin: MarketplacePlugin, isTrustedPublisher: boolean): number {
    let score = 0;
    if (plugin.verified) score += 30;
    if (isTrustedPublisher) score += 40;
    if (plugin.downloads >= 1000) score += 10;
    if (plugin.ratingCount > 0 && plugin.rating >= 4.0) score += 10;
    const ageDays = (Date.now() - plugin.createdAt) / (1000 * 60 * 60 * 24);
    if (ageDays >= 30) score += 10;
    return Math.min(100, score);
  }
}

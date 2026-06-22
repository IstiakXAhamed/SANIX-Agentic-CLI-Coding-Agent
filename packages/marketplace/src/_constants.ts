/**
 * @file _constants.ts
 * @description Internal constants for `@sanix/marketplace`: the trusted
 * publisher allow-list, the SPDX license allow-list, dangerous code
 * patterns scanned in inline/plugin JS content, and registry defaults.
 *
 * @packageDocumentation
 */

/**
 * Publishers in this set are considered "trusted" — the highest trust
 * tier. `PluginValidator` gives them +40 trust score and
 * `PluginInstaller` (at `trustLevel === 'trusted'`) only installs
 * plugins authored by these publishers.
 *
 * The set is intentionally small and conservative; it can be extended
 * by the SANIX team as the ecosystem matures. Author names are matched
 * case-insensitively against `MarketplacePlugin.author.name`.
 */
export const TRUSTED_PUBLISHERS: ReadonlySet<string> = new Set([
  'sanix',
  'sanim',
  'sanim ahmed',
  'sanix-official',
  'sanix-team',
]);

/**
 * A conservative allow-list of SPDX license identifiers accepted by
 * `PluginValidator`. Plugins with licenses not in this set are flagged
 * with a warning (not a hard error, since the list is non-exhaustive).
 */
export const ACCEPTED_SPDX_LICENSES: ReadonlySet<string> = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'Unlicense',
  '0BSD',
  'CC0-1.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-3.0-only',
]);

/**
 * Dangerous code patterns scanned in inline plugin content (workflows,
 * tools, complete plugins) and in `url`-fetched JS modules. A match is
 * a hard validation error for inline tools / complete plugins, and a
 * warning for inline workflows (workflows can legitimately invoke
 * `bash`, but `eval`/`child_process` in a YAML workflow is suspicious).
 *
 * Each entry is `{ pattern: RegExp; label: string; severity: 'error' | 'warn' }`.
 */
export interface DangerousPattern {
  pattern: RegExp;
  label: string;
  severity: 'error' | 'warn';
}

export const DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/, label: 'child_process require', severity: 'error' },
  { pattern: /require\s*\(\s*['"]node:child_process['"]\s*\)/, label: 'node:child_process require', severity: 'error' },
  { pattern: /import\s*\(\s*['"]child_process['"]\s*\)/, label: 'child_process dynamic import', severity: 'error' },
  { pattern: /import\s*\(\s*['"]node:child_process['"]\s*\)/, label: 'node:child_process dynamic import', severity: 'error' },
  { pattern: /from\s+['"]child_process['"]/, label: 'child_process import', severity: 'error' },
  { pattern: /from\s+['"]node:child_process['"]/, label: 'node:child_process import', severity: 'error' },
  { pattern: /\beval\s*\(/, label: 'eval()', severity: 'error' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function()', severity: 'error' },
  { pattern: /process\.exit\s*\(/, label: 'process.exit()', severity: 'warn' },
  { pattern: /fs\.unlinkSync\s*\(/, label: 'fs.unlinkSync()', severity: 'warn' },
  { pattern: /fs\.rmdirSync\s*\(/, label: 'fs.rmdirSync()', severity: 'warn' },
  { pattern: /\bexecSync\s*\(/, label: 'execSync()', severity: 'error' },
  { pattern: /\bspawnSync\s*\(/, label: 'spawnSync()', severity: 'error' },
  { pattern: /\.kill\s*\(/, label: 'process.kill()', severity: 'warn' },
];

/**
 * Default registry URL. Can be overridden for self-hosted registries.
 */
export const DEFAULT_REGISTRY_URL = 'https://registry.sanix.dev';

/**
 * Default install directory (expanded to an absolute path at runtime).
 */
export const DEFAULT_INSTALL_DIR = '~/.sanix/plugins';

/**
 * Default cache directory for downloaded payloads.
 */
export const DEFAULT_CACHE_DIR = '~/.sanix/marketplace/cache';

/**
 * Network timeout for registry HTTP calls, in ms.
 */
export const HTTP_TIMEOUT_MS = 30_000;

/**
 * Number of retries for failed registry HTTP calls.
 */
export const HTTP_RETRIES = 3;

/**
 * Search-result cache TTL (ms) — 5 minutes.
 */
export const CACHE_TTL_SEARCH = 5 * 60 * 1000;

/**
 * Plugin-detail cache TTL (ms) — 1 hour.
 */
export const CACHE_TTL_DETAIL = 60 * 60 * 1000;

/**
 * Default update-check interval (ms) — 24 hours.
 */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Filename of the installed-plugins manifest, relative to installDir.
 */
export const INSTALLED_MANIFEST_FILENAME = 'installed.json';

/**
 * Filename of the marketplace plugin descriptor written next to each
 * installed plugin (so the loader can re-validate without a registry
 * round-trip).
 */
export const PLUGIN_DESCRIPTOR_FILENAME = 'sanix-plugin.json';

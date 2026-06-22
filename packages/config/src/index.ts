/**
 * @sanix/config — SANIX configuration system.
 *
 * Public surface:
 *   - {@link SanixConfigSchema} / {@link SanixConfig} — Zod-validated config.
 *   - {@link defaultConfig} / {@link loadConfig} / {@link saveConfig} /
 *     {@link resolveConfig} — config I/O and resolution.
 *   - {@link expandHome} / {@link resolveEnvVars} — path & env helpers.
 *   - {@link ProfileManager} — named config profiles.
 *   - {@link SecretManager} — encrypted-ish key storage with env fallback.
 *
 * @packageDocumentation
 */

export {
  SanixConfigSchema,
  expandHome,
  resolveEnvVars,
  defaultConfig,
  loadConfig,
  saveConfig,
  resolveConfig,
  DEFAULT_CONFIG_PATH,
  type SanixConfig,
} from './SanixConfig.js';

export {
  ProfileManager,
  DEFAULT_PROFILES_PATH,
  type Profile,
  type ConfigOverride,
  type ProfileManagerOptions,
} from './ProfileManager.js';

export {
  SecretManager,
  DEFAULT_SECRETS_PATH,
  type SecretManagerOptions,
} from './SecretManager.js';

/**
 * SANIX Secret Manager
 * --------------------
 * Stores provider API keys and other secrets. The reference design calls for
 * `keytar` (OS keychain) integration, but `keytar` is a native module that
 * does not always install cleanly across every platform. This implementation
 * therefore falls back to a plain JSON file at `~/.sanix/secrets.json`.
 *
 * Resolution priority for {@link SecretManager.getKey}:
 *   1. Environment variables — `${PROVIDER}_API_KEY`, then
 *      `${PROVIDER}_KEY`, then `SANIX_${PROVIDER}_API_KEY`. Env vars win so
 *      CI/CD and ephemeral environments work without any on-disk state.
 *   2. The on-disk secret store.
 *
 * TODO: Upgrade to `keytar` for OS-native secure storage (macOS Keychain,
 * Windows Credential Vault, Linux Secret Service / GNOME Keyring). The
 * public API of this class should remain stable; only the storage backend
 * will change. A factory pattern (`createSecretManager()`) can select
 * `keytar` when available and fall back to JSON otherwise.
 *
 * @packageDocumentation
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** On-disk shape of `~/.sanix/secrets.json`. */
interface SecretStore {
  /** Map of provider name → secret value. */
  keys: Record<string, string>;
}

/** The default storage location: `~/.sanix/secrets.json`. */
export const DEFAULT_SECRETS_PATH: string = join(
  homedir(),
  '.sanix',
  'secrets.json',
);

/** Options for constructing a {@link SecretManager}. */
export interface SecretManagerOptions {
  /** Override the on-disk store location (primarily for testing). */
  storePath?: string;
  /**
   * When `false`, env-var fallback is disabled and only the on-disk store is
   * consulted. Defaults to `true`.
   */
  envFallback?: boolean;
}

/**
 * Encrypted-ish key storage with env-var fallback.
 *
 * @example
 * ```ts
 * const sm = new SecretManager();
 * sm.setKey('anthropic', 'sk-ant-...');
 * sm.getKey('anthropic'); // 'sk-ant-...' (or from $ANTHROPIC_API_KEY)
 * sm.listKeys();          // ['anthropic']
 * ```
 */
export class SecretManager {
  private readonly storePath: string;
  private readonly envFallback: boolean;

  /**
   * @param opts - Optional {@link SecretManagerOptions}.
   */
  constructor(opts: SecretManagerOptions = {}) {
    this.storePath = opts.storePath ?? DEFAULT_SECRETS_PATH;
    this.envFallback = opts.envFallback ?? true;
  }

  /**
   * Read the on-disk secret store. Returns an empty store if the file does
   * not exist or is unreadable.
   */
  private readStore(): SecretStore {
    if (!existsSync(this.storePath)) {
      return { keys: {} };
    }
    try {
      const text = readFileSync(this.storePath, 'utf-8');
      const raw = JSON.parse(text) as Partial<SecretStore>;
      return { keys: raw.keys ?? {} };
    } catch {
      return { keys: {} };
    }
  }

  /**
   * Persist the secret store with restrictive (`0600`) permissions so only
   * the owning user can read it.
   */
  private writeStore(store: SecretStore): void {
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.storePath, JSON.stringify(store, null, 2), 'utf-8');
    try {
      chmodSync(this.storePath, 0o600);
    } catch {
      // `chmod` can fail on platforms that don't support POSIX permissions
      // (e.g. Windows). Non-fatal — the file is still written.
    }
  }

  /**
   * Store (or overwrite) a secret for the given provider.
   *
   * @param provider - Provider identifier (e.g. `'anthropic'`, `'openai'`,
   *                   `'lmstudio'`). Case-insensitive on read.
   * @param key - The secret value to store.
   *
   * @example
   * ```ts
   * sm.setKey('anthropic', process.env.ANTHROPIC_API_KEY!);
   * ```
   */
  setKey(provider: string, key: string): void {
    const normalized = provider.toLowerCase();
    const store = this.readStore();
    store.keys[normalized] = key;
    this.writeStore(store);
  }

  /**
   * Retrieve a secret for the given provider.
   *
   * Resolution order (when env fallback is enabled):
   *   1. `process.env.${PROVIDER_UPPER}_API_KEY`
   *   2. `process.env.${PROVIDER_UPPER}_KEY`
   *   3. `process.env.SANIX_${PROVIDER_UPPER}_API_KEY`
   *   4. The on-disk secret store.
   *
   * @param provider - Provider identifier. Matched case-insensitively.
   * @returns The secret, or `undefined` if none is found.
   *
   * @example
   * ```ts
   * const key = sm.getKey('anthropic');
   * if (!key) throw new Error('Anthropic API key not configured');
   * ```
   */
  getKey(provider: string): string | undefined {
    const normalized = provider.toLowerCase();
    if (this.envFallback) {
      const upper = normalized.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const envCandidates = [
        `${upper}_API_KEY`,
        `${upper}_KEY`,
        `SANIX_${upper}_API_KEY`,
      ];
      for (const candidate of envCandidates) {
        const envVal = process.env[candidate];
        if (envVal !== undefined && envVal !== '') {
          return envVal;
        }
      }
    }
    const store = this.readStore();
    return store.keys[normalized];
  }

  /**
   * Permanently remove a stored secret. Env-var-only keys cannot be deleted
   * (they are resolved at read time from `process.env`).
   *
   * @param provider - Provider identifier. Matched case-insensitively.
   * @returns `true` if an on-disk secret was removed, `false` otherwise.
   *
   * @example
   * ```ts
   * sm.deleteKey('anthropic');
   * ```
   */
  deleteKey(provider: string): boolean {
    const normalized = provider.toLowerCase();
    const store = this.readStore();
    if (store.keys[normalized] === undefined) return false;
    delete store.keys[normalized];
    this.writeStore(store);
    return true;
  }

  /**
   * List all providers with a stored on-disk secret. Providers that are only
   * available via env vars are **not** included.
   *
   * @returns An array of provider identifiers (lowercase).
   *
   * @example
   * ```ts
   * sm.listKeys(); // ['anthropic', 'openai']
   * ```
   */
  listKeys(): string[] {
    return Object.keys(this.readStore().keys);
  }
}

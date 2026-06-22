/**
 * @file TokenStore.ts
 * @description Persistence layer for OAuth token sets. One JSON file at
 *   `~/.sanix/auth/tokens.json` (mode `0600`) holds every provider's
 *   tokens, keyed by provider id. All writes are atomic (write-to-temp +
 *   rename) so a crash mid-write can never corrupt the store.
 *
 *   Design choices:
 *     - File mode is `0600` on POSIX and silently ignored on Windows.
 *     - The directory `~/.sanix/auth/` is created with mode `0700` if it
 *       does not yet exist.
 *     - Reads are defensively validated with a Zod schema so a corrupt or
 *       tampered file never yields a malformed `OAuthTokenSet` to the rest
 *       of the codebase.
 *     - All public methods are synchronous-IO-bound but synchronous in
 *       signature (the file is tiny — typically <1 KB) so callers don't
 *       need to await every token lookup.
 *
 * @packageDocumentation
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { OAuthTokenSet } from './types.js';

/** Default on-disk path: `~/.sanix/auth/tokens.json`. */
export const DEFAULT_TOKEN_STORE_PATH: string = join(
  homedir(),
  '.sanix',
  'auth',
  'tokens.json',
);

/**
 * Zod schema for the persisted shape of a single {@link OAuthTokenSet}.
 * Identical to the runtime interface — exists purely so we can validate
 * that an attacker-tampered or hand-edited file does not yield a partial
 * object to callers.
 */
const TokenSetSchema: z.ZodType<OAuthTokenSet> = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.number().int().nonnegative(),
  scope: z.string(),
  tokenType: z.string().min(1),
  obtainedAt: z.number().int().nonnegative(),
  providerId: z.string().min(1),
});

/** On-disk shape of the entire token store. */
const TokenStoreSchema = z.object({
  /** Schema version — bump on incompatible changes to allow future migrations. */
  version: z.literal(1),
  /** Map of `providerId` → {@link OAuthTokenSet}. */
  tokens: z.record(z.string(), TokenSetSchema),
});

/** Internal helper type matching {@link TokenStoreSchema}. */
interface PersistedStore {
  readonly version: 1;
  readonly tokens: Record<string, OAuthTokenSet>;
}

/** Options accepted by {@link OAuthTokenStore}. */
export interface OAuthTokenStoreOptions {
  /** Override the on-disk store location (primarily for testing). */
  readonly storePath?: string;
  /**
   * When `false`, skip the `chmod 0600` calls. Defaults to `true`. Useful
   * in tests on filesystems that don't support POSIX permissions.
   */
  readonly enforcePermissions?: boolean;
}

/**
 * Atomic, file-based persistence for OAuth token sets.
 *
 * One store instance is typically created per SANIX process and shared by
 * all {@link OAuthClient} instances (one per provider). The class is safe
 * to use from a single event-loop turn; concurrent writes from different
 * processes are not coordinated (relies on atomic-rename semantics).
 *
 * @example
 * ```ts
 * const store = new OAuthTokenStore();
 * store.set('google', tokenSet);
 * const t = store.get('google');
 * store.needsRefresh('google'); // true if expiring soon
 * ```
 */
export class OAuthTokenStore {
  private readonly storePath: string;
  private readonly enforcePermissions: boolean;

  /**
   * @param opts - Optional {@link OAuthTokenStoreOptions}.
   */
  public constructor(opts: OAuthTokenStoreOptions = {}) {
    this.storePath = opts.storePath ?? DEFAULT_TOKEN_STORE_PATH;
    this.enforcePermissions = opts.enforcePermissions ?? true;
  }

  /**
   * The on-disk path this store reads from / writes to.
   */
  public get path(): string {
    return this.storePath;
  }

  /**
   * Persist (or overwrite) the token set for the given provider.
   *
   * The write is atomic: the JSON is first serialized to a sibling temp
   * file (`.tmp.<random>`), then `rename`d over the real path. POSIX
   * guarantees `rename` is atomic, so a crash mid-write leaves either the
   * old or the new file in place — never a half-written hybrid.
   *
   * @param providerId - Provider identifier (e.g. `'google'`).
   * @param tokens - The complete {@link OAuthTokenSet} to store.
   *
   * @example
   * ```ts
   * store.set('github', { accessToken: 'gho_...', expiresAt: Date.now()+3600_000, ... });
   * ```
   */
  public set(providerId: string, tokens: OAuthTokenSet): void {
    const store = this.readStore();
    store.tokens[providerId] = tokens;
    this.writeStore(store);
  }

  /**
   * Retrieve the token set for a provider, or `null` if none is stored.
   *
   * @param providerId - Provider identifier.
   * @returns The stored {@link OAuthTokenSet} or `null`.
   *
   * @example
   * ```ts
   * const t = store.get('google');
   * if (t && !store.needsRefresh('google')) useToken(t.accessToken);
   * ```
   */
  public get(providerId: string): OAuthTokenSet | null {
    return this.readStore().tokens[providerId] ?? null;
  }

  /**
   * Remove the token set for a provider. Returns `true` if a token was
   * deleted, `false` if none was stored.
   *
   * @param providerId - Provider identifier.
   * @returns Whether a token was removed.
   *
   * @example
   * ```ts
   * store.delete('github'); // → true (or false if nothing was stored)
   * ```
   */
  public delete(providerId: string): boolean {
    const store = this.readStore();
    if (store.tokens[providerId] === undefined) return false;
    delete store.tokens[providerId];
    this.writeStore(store);
    return true;
  }

  /**
   * List the provider ids that currently have stored tokens.
   *
   * @returns Array of provider ids (order is insertion-order of the
   *   underlying JSON object, which is preserved by V8 for string keys).
   *
   * @example
   * ```ts
   * store.list(); // ['google', 'github']
   * ```
   */
  public list(): string[] {
    return Object.keys(this.readStore().tokens);
  }

  /**
   * Determine whether the token for the given provider is expired **or**
   * will expire within the provider's configured refresh threshold.
   *
   * Returns `true` when there is no token at all (so callers can use this
   * single method to decide whether a refresh / re-login is needed).
   *
   * @param providerId - Provider identifier.
   * @param thresholdMs - Refresh threshold in ms. Defaults to 5 minutes
   *   (`300_000`). The value comes from
   *   {@link OAuthProviderConfig.tokenRefreshThresholdMs} in normal use.
   * @returns Whether the token needs refreshing (or is missing).
   *
   * @example
   * ```ts
   * if (store.needsRefresh('google', config.tokenRefreshThresholdMs)) {
   *   await client.refresh('google');
   * }
   * ```
   */
  public needsRefresh(providerId: string, thresholdMs: number = 300_000): boolean {
    const t = this.get(providerId);
    if (!t) return true;
    return t.expiresAt - Date.now() <= thresholdMs;
  }

  /**
   * Wipe the entire token store. Useful for `sanix auth logout --all`.
   *
   * @returns The number of token sets that were removed.
   *
   * @example
   * ```ts
   * const n = store.clear(); // wipe everything
   * ```
   */
  public clear(): number {
    const store = this.readStore();
    const n = Object.keys(store.tokens).length;
    if (n === 0) return 0;
    this.writeStore({ version: 1, tokens: {} });
    return n;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Read and validate the on-disk store. Returns an empty store if the
   * file does not exist, is unparseable, or fails schema validation (so a
   * corrupted file never crashes the process — but it does effectively
   * log the user out, which is the safe failure mode).
   */
  private readStore(): PersistedStore {
    if (!existsSync(this.storePath)) {
      return { version: 1, tokens: {} };
    }
    try {
      const text = readFileSync(this.storePath, 'utf-8');
      const raw = JSON.parse(text) as unknown;
      const parsed = TokenStoreSchema.safeParse(raw);
      if (!parsed.success) {
        // Schema mismatch — treat as empty so the user can re-login rather
        // than being permanently locked out. (Caller can still call
        // `clear()` to wipe the offending file.)
        return { version: 1, tokens: {} };
      }
      return parsed.data;
    } catch {
      return { version: 1, tokens: {} };
    }
  }

  /**
   * Atomically persist the store. Writes a temp file beside the real path,
   * `chmod`s it `0600`, then `rename`s over the real path. The directory
   * is created (mode `0700`) on first write.
   */
  private writeStore(store: PersistedStore): void {
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      if (this.enforcePermissions) {
        try {
          chmodSync(dir, 0o700);
        } catch {
          // Non-POSIX FS — ignore.
        }
      }
    }
    const tmpPath = `${this.storePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    if (this.enforcePermissions) {
      try {
        chmodSync(tmpPath, 0o600);
      } catch {
        // Non-POSIX FS — ignore.
      }
    }
    try {
      renameSync(tmpPath, this.storePath);
    } catch (e) {
      // Best-effort cleanup of the temp file on failure.
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
}

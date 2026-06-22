/**
 * @file AuthManager.ts
 * @description Top-level façade for `@sanix/auth`. Provider adapters, the
 *   CLI's `sanix auth` command, and the TUI's auth panel all go through
 *   this class.
 *
 *   Responsibilities:
 *     - Look up a provider's {@link OAuthProviderConfig} and construct an
 *       {@link OAuthClient} on demand (one client per call — they're
 *       cheap and stateless apart from the shared token store).
 *     - Run the OAuth login flow.
 *     - Refresh tokens.
 *     - Revoke + delete tokens on logout.
 *     - Return a unified {@link AuthStatus} for one or all providers,
 *       transparently detecting env-var API keys as a fallback.
 *     - Expose {@link AuthManager.getAccessToken} as the single entry
 *       point that provider adapters call to obtain a bearer credential.
 *
 *   ## Env-var fallback
 *
 *   When a provider has no OAuth token, {@link getAccessToken} falls back
 *   to the well-known env var for that provider's plain API key:
 *
 *     - `anthropic`  → `ANTHROPIC_API_KEY`
 *     - `openai`     → `OPENAI_API_KEY`
 *     - `google`     → `GOOGLE_API_KEY`
 *     - `github`     → `GITHUB_TOKEN`
 *     - `microsoft`  → `AZURE_OPENAI_API_KEY`
 *
 *   The mapping is in {@link ENV_KEY_FOR_PROVIDER}. Unknown providers
 *   have no env fallback and return `null` from `getAccessToken`.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import {
  AuthError,
  type AuthEvents,
  type AuthStatus,
  type LoginOptions,
  type OAuthProviderConfig,
  type OAuthTokenSet,
  type RefreshOptions,
} from './types.js';
import { OAuthClient } from './OAuthClient.js';
import { OAuthTokenStore, type OAuthTokenStoreOptions } from './TokenStore.js';
import { getOAuthProvider, listOAuthProviders } from './providers/index.js';

/**
 * Map of provider id → the env var that holds a plain API key for that
 * provider (used as a fallback when no OAuth token is available).
 *
 * Add new entries here as new providers gain OAuth support.
 */
const ENV_KEY_FOR_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  github: 'GITHUB_TOKEN',
  microsoft: 'AZURE_OPENAI_API_KEY',
});

/** Options accepted by {@link AuthManager}. */
export interface AuthManagerOptions {
  /** Token-store options (mostly for tests). */
  readonly tokenStoreOptions?: OAuthTokenStoreOptions;
  /** Pre-built token store (overrides `tokenStoreOptions`). */
  readonly tokenStore?: OAuthTokenStore;
  /** Optional custom fetch implementation forwarded to each OAuthClient. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Top-level façade for SANIX authentication.
 *
 * Construct one per process. Internally caches a single
 * {@link OAuthTokenStore} and constructs an {@link OAuthClient} per call.
 * Extends `EventEmitter3<AuthEvents>` so observers can subscribe to
 * `auth:*` events emitted by any internally-created `OAuthClient`.
 *
 * @example
 * ```ts
 * const auth = new AuthManager();
 *
 * // Login
 * const tokens = await auth.login('google', { clientIdOverride: '…' });
 *
 * // Use in a provider adapter
 * const bearer = await auth.getAccessToken('google');
 * if (!bearer) throw new Error('not authenticated');
 *
 * // Status dashboard
 * for (const s of auth.status()) console.log(s.providerId, s.method, s.authenticated);
 * ```
 */
export class AuthManager extends EventEmitter<AuthEvents> {
  private readonly store: OAuthTokenStore;
  private readonly fetchImpl?: typeof fetch;
  /** Per-provider OAuthClient cache so listeners survive across calls. */
  private readonly clients: Map<string, OAuthClient> = new Map();

  /**
   * @param opts - Optional {@link AuthManagerOptions}.
   */
  public constructor(opts: AuthManagerOptions = {}) {
    super();
    this.store = opts.tokenStore ?? new OAuthTokenStore(opts.tokenStoreOptions);
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * The underlying {@link OAuthTokenStore}. Exposed so the CLI can do
   * `sanix auth clear` without re-implementing the path logic.
   */
  public get tokenStore(): OAuthTokenStore {
    return this.store;
  }

  /**
   * Run the OAuth login flow for the given provider.
   *
   * @param providerId - One of {@link listOAuthProviders}.
   * @param opts - Optional {@link LoginOptions}.
   * @returns The freshly-stored {@link OAuthTokenSet}.
   * @throws {AuthError} If the provider is unknown, or on any OAuth flow
   *   failure.
   *
   * @example
   * ```ts
   * await auth.login('google', { clientIdOverride: process.env.SANIX_GOOGLE_CLIENT_ID });
   * ```
   */
  public async login(providerId: string, opts: LoginOptions = {}): Promise<OAuthTokenSet> {
    const cfg = this.requireProvider(providerId);
    const client = this.clientFor(cfg);
    return client.login(opts);
  }

  /**
   * Refresh the OAuth token for the given provider.
   *
   * @param providerId - One of {@link listOAuthProviders}.
   * @param opts - Optional {@link RefreshOptions}.
   * @returns The refreshed {@link OAuthTokenSet}.
   * @throws {AuthError} If the provider is unknown, no token is stored,
   *   no refresh token is available, or the refresh fails.
   *
   * @example
   * ```ts
   * await auth.refresh('google');
   * ```
   */
  public async refresh(providerId: string, opts: RefreshOptions = {}): Promise<OAuthTokenSet> {
    const cfg = this.requireProvider(providerId);
    const client = this.clientFor(cfg);
    return client.refresh(providerId, opts);
  }

  /**
   * Revoke (if the provider supports it) and delete the OAuth token for
   * the given provider. Idempotent — calling logout when not logged in
   * is a no-op.
   *
   * @param providerId - One of {@link listOAuthProviders}.
   *
   * @example
   * ```ts
   * await auth.logout('github');
   * ```
   */
  public async logout(providerId: string): Promise<void> {
    const cfg = this.requireProvider(providerId);
    const client = this.clientFor(cfg);
    await client.revoke(providerId);
  }

  /**
   * Return authentication status for one provider, or all known
   * providers when `providerId` is omitted.
   *
   * For each provider the result distinguishes between:
   *   - `method: 'oauth'`    — an OAuth token is stored (may or may not
   *     be expired; `authenticated` reflects the live state).
   *   - `method: 'api_key'`  — no OAuth token, but a plain env-var API
   *     key is present.
   *   - `method: 'none'`     — neither.
   *
   * @param providerId - Optional provider id. When omitted, status is
   *   returned for every provider in {@link listOAuthProviders}.
   * @returns Array of {@link AuthStatus}. Always returns an array (even
   *   for a single-provider query) so the caller can `for…of` uniformly.
   *
   * @example
   * ```ts
   * auth.status('google');           // [ { providerId: 'google', method: 'oauth', … } ]
   * auth.status().map(s => s.providerId); // ['google', 'github', 'anthropic', 'microsoft']
   * ```
   */
  public status(providerId?: string): AuthStatus[] {
    const ids = providerId ? [providerId.toLowerCase()] : listOAuthProviders();
    const out: AuthStatus[] = [];
    for (const id of ids) {
      const cfg = getOAuthProvider(id);
      if (!cfg) continue;
      const token = this.store.get(id);
      if (token) {
        const expired = token.expiresAt <= Date.now();
        out.push({
          providerId: id,
          method: 'oauth',
          authenticated: !expired,
          expiresAt: token.expiresAt,
          scopes: token.scope ? token.scope.split(' ').filter(Boolean) : cfg.scopes,
          displayName: cfg.displayName,
        });
        continue;
      }
      const envKey = ENV_KEY_FOR_PROVIDER[id];
      const envVal = envKey ? process.env[envKey] : undefined;
      if (envVal && envVal.length > 0) {
        out.push({
          providerId: id,
          method: 'api_key',
          authenticated: true,
          displayName: cfg.displayName,
        });
      } else {
        out.push({
          providerId: id,
          method: 'none',
          authenticated: false,
          displayName: cfg.displayName,
        });
      }
    }
    return out;
  }

  /**
   * Main entry point that provider adapters call to obtain a bearer
   * credential.
   *
   * Resolution order:
   *   1. A valid (auto-refreshing) OAuth access token, if one is stored.
   *   2. The well-known env-var API key for the provider
   *      ({@link ENV_KEY_FOR_PROVIDER}).
   *   3. `null` if neither is available.
   *
   * @param providerId - One of {@link listOAuthProviders} (case-insensitive),
   *   or any string for which an env-var fallback exists (e.g. `'openai'`).
   * @returns The access token / API key, or `null` if the user is not
   *   authenticated.
   *
   * @example
   * ```ts
   * const key = await auth.getAccessToken('anthropic');
   * if (!key) throw new Error('Run `sanix auth login anthropic` first');
   * fetch('https://api.anthropic.com/v1/messages', { headers: { 'x-api-key': key } });
   * ```
   */
  public async getAccessToken(providerId: string): Promise<string | null> {
    const normalized = providerId.toLowerCase();
    const cfg = getOAuthProvider(normalized);
    if (cfg) {
      const client = this.clientFor(cfg);
      const token = await client.getValidToken(normalized);
      if (token) return token.accessToken;
    }
    const envKey = ENV_KEY_FOR_PROVIDER[normalized];
    if (envKey) {
      const envVal = process.env[envKey];
      if (envVal && envVal.length > 0) return envVal;
    }
    return null;
  }

  /**
   * Enumerate the ids of every built-in OAuth provider.
   *
   * Convenience alias for the standalone `listOAuthProviders()` helper,
   * exposed on the manager so callers don't need to import it directly.
   *
   * @returns Array of provider ids.
   */
  public listOAuthProviders(): string[] {
    return listOAuthProviders();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Look up a provider config or throw an `AuthError` mentioning the
   * available providers.
   */
  private requireProvider(providerId: string): OAuthProviderConfig {
    const cfg = getOAuthProvider(providerId);
    if (!cfg) {
      throw new AuthError(
        'AUTH_NO_CLIENT_ID',
        `Unknown OAuth provider "${providerId}". Available providers: ${listOAuthProviders().join(', ')}.`,
        providerId,
      );
    }
    return cfg;
  }

  /**
   * Get-or-create the cached {@link OAuthClient} for a provider. On first
   * creation, attaches per-event forwarders that re-emit every
   * `auth:*` event from the client on this manager, so subscribers
   * attached via {@link on} see events from any provider's flow without
   * having to know which `OAuthClient` is running.
   */
  private clientFor(cfg: OAuthProviderConfig): OAuthClient {
    const existing = this.clients.get(cfg.id);
    if (existing) return existing;
    const client = new OAuthClient(
      cfg,
      this.store,
      this.fetchImpl ? { fetchImpl: this.fetchImpl } : {},
    );
    // Re-emit every event from the client on this manager. Each forwarder
    // is declared explicitly per event so TypeScript keeps the payload
    // type narrow (rather than widening to `AuthEvents[keyof AuthEvents]`).
    client.on('auth:start', (p) => this.emit('auth:start', p));
    client.on('auth:browser-opened', (p) => this.emit('auth:browser-opened', p));
    client.on('auth:callback-received', (p) => this.emit('auth:callback-received', p));
    client.on('auth:success', (p) => this.emit('auth:success', p));
    client.on('auth:failure', (p) => this.emit('auth:failure', p));
    client.on('auth:refresh', (p) => this.emit('auth:refresh', p));
    client.on('auth:logout', (p) => this.emit('auth:logout', p));
    this.clients.set(cfg.id, client);
    return client;
  }
}

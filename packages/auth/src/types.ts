/**
 * @file types.ts
 * @description Core type definitions for `@sanix/auth`. Every public symbol
 *   exposed by this package is anchored here so downstream consumers (the CLI,
 *   the provider adapters) can depend on a single stable contract.
 *
 *   The model is intentionally simple:
 *     - Each OAuth provider is described by an immutable
 *       {@link OAuthProviderConfig} (endpoints, scopes, default client id,
 *       localhost callback port).
 *     - Successful authentication produces an {@link OAuthTokenSet}, persisted
 *       by {@link OAuthTokenStore} at `~/.sanix/auth/tokens.json` with mode
 *       `0600`.
 *     - The {@link AuthManager} façade exposes a unified `status()` /
 *       `getAccessToken()` API that prefers OAuth tokens (auto-refreshing) and
 *       falls back to legacy env-var API keys.
 *     - Lifecycle progress is observable via the strongly-typed
 *       {@link AuthEvents} map consumed by `EventEmitter3`.
 *
 * @packageDocumentation
 */

/**
 * Immutable configuration for a single OAuth 2.0 provider.
 *
 * Instances are pre-built and exported from `src/providers/`. Callers should
 * treat them as read-only — to override e.g. the `clientId`, pass an explicit
 * `clientIdOverride` to {@link OAuthClient.login} instead of mutating.
 */
export interface OAuthProviderConfig {
  /** Stable provider id, e.g. `'google'` | `'github'` | `'anthropic'` | `'microsoft'`. */
  readonly id: string;
  /** Human-readable name for TUI/CLI display, e.g. `'Google (Gemini)'`. */
  readonly displayName: string;
  /** Authorization endpoint (where the browser goes to ask the user). */
  readonly authorizationEndpoint: string;
  /** Token endpoint (where the code is exchanged for tokens). */
  readonly tokenEndpoint: string;
  /** Revocation endpoint, if the provider supports RFC 7009. */
  readonly revocationEndpoint?: string;
  /** Optional user-info endpoint (for fetching the connected account). */
  readonly userInfoEndpoint?: string;
  /** Space-joined scope list sent in the authorization request. */
  readonly scopes: readonly string[];
  /**
   * Default OAuth client id. For providers that do not ship a public Desktop
   * App client (currently all of them as of this writing), this is the empty
   * string and the user is expected to supply their own via the
   * `--client-id` CLI flag (resolved by {@link resolveClientId}).
   */
  readonly clientId: string;
  /** Localhost TCP port to listen on for the OAuth callback. */
  readonly redirectPort: number;
  /** URL path on `localhost` to receive the callback (e.g. `'/callback'`). */
  readonly redirectPath: string;
  /**
   * When a cached token has fewer than this many milliseconds of life left,
   * {@link OAuthClient.getValidToken} will proactively refresh it. Defaults
   * to 5 minutes so a token that expires in 4:59 triggers a refresh.
   */
  readonly tokenRefreshThresholdMs: number;
}

/**
 * A complete set of OAuth tokens for one provider, plus bookkeeping metadata.
 *
 * The shape mirrors what an RFC 6749 token endpoint returns, with two extra
 * fields (`obtainedAt`, `providerId`) added for local management. The whole
 * structure is persisted to disk by {@link OAuthTokenStore}.
 */
export interface OAuthTokenSet {
  /** The short-lived access token sent as `Authorization: Bearer ...`. */
  readonly accessToken: string;
  /** The long-lived refresh token used to mint new access tokens. Optional. */
  readonly refreshToken?: string;
  /** Epoch milliseconds at which `accessToken` expires. */
  readonly expiresAt: number;
  /** Space-joined scopes that the access token grants. */
  readonly scope: string;
  /** Token type — almost always `'Bearer'`. */
  readonly tokenType: string;
  /** Epoch milliseconds at which this token set was obtained. */
  readonly obtainedAt: number;
  /** The provider id this token belongs to (for multi-provider stores). */
  readonly providerId: string;
}

/**
 * Public-facing status of authentication for a single provider.
 *
 * Returned by {@link AuthManager.status}. `method` distinguishes between
 * OAuth tokens, plain env-var API keys, and "nothing configured".
 */
export interface AuthStatus {
  /** The provider id this status describes. */
  readonly providerId: string;
  /** How the caller is (or is not) authenticated. */
  readonly method: 'oauth' | 'api_key' | 'none';
  /** `true` when a usable credential is available right now. */
  readonly authenticated: boolean;
  /** Epoch ms when the OAuth access token expires (OAuth only). */
  readonly expiresAt?: number;
  /** Granted scopes (OAuth only). */
  readonly scopes?: readonly string[];
  /** Human-readable provider name, for TUI/CLI display. */
  readonly displayName: string;
}

/**
 * Strongly-typed event map consumed by `EventEmitter3<AuthEvents>`.
 *
 * Every event name is namespaced with `auth:` so it cannot collide with
 * other SANIX subsystems (router / agent / tool events).
 */
export interface AuthEvents {
  /** Emitted when a login flow begins (before the browser opens). */
  'auth:start': { providerId: string };
  /** Emitted immediately after the user's browser has been launched. */
  'auth:browser-opened': { url: string };
  /** Emitted when the callback server receives a `?code=` redirect. */
  'auth:callback-received': { code: string };
  /** Emitted on successful login (token stored, callback server closed). */
  'auth:success': { providerId: string; expiresAt: number };
  /** Emitted on any failure (timeout, state mismatch, HTTP error, etc.). */
  'auth:failure': { providerId: string; error: string };
  /** Emitted after a refresh-token grant succeeds. */
  'auth:refresh': { providerId: string; expiresAt: number };
  /** Emitted after the token has been revoked and removed from the store. */
  'auth:logout': { providerId: string };
}

/**
 * Options accepted by {@link OAuthClient.login} / {@link AuthManager.login}.
 */
export interface LoginOptions {
  /**
   * Override the provider's default OAuth client id. Required for any
   * provider whose {@link OAuthProviderConfig.clientId} is empty — see
   * {@link resolveClientId}.
   */
  readonly clientIdOverride?: string;
  /**
   * Override the scopes requested. If omitted, the provider's default
   * {@link OAuthProviderConfig.scopes} are used. Use this to request
   * additional scopes (e.g. extra GitHub `repo` access) or to narrow them.
   */
  readonly scopes?: readonly string[];
  /**
   * Maximum time to wait for the user to complete the browser flow before
   * giving up. Defaults to 10 minutes (`600_000` ms) — long enough for a
   * slow 2FA dance, short enough that a forgotten tab won't pin a port
   * forever.
   */
  readonly timeoutMs?: number;
}

/**
 * Options accepted by {@link OAuthClient.refresh} / {@link AuthManager.refresh}.
 */
export interface RefreshOptions {
  /**
   * Per-call override of the client id used in the refresh-token grant.
   * Almost never needed — the client id from {@link resolveClientId} is
   * reused automatically.
   */
  readonly clientIdOverride?: string;
}

/**
 * Typed OAuth-related errors. Use `instanceof` to discriminate, or read the
 * `code` field. All carry a human-readable `message` plus optional context.
 */
export type AuthErrorCode =
  | 'AUTH_TIMEOUT'
  | 'AUTH_STATE_MISMATCH'
  | 'AUTH_CALLBACK_ERROR'
  | 'AUTH_TOKEN_EXCHANGE_FAILED'
  | 'AUTH_NO_CLIENT_ID'
  | 'AUTH_NO_REFRESH_TOKEN'
  | 'AUTH_REVOCATION_FAILED'
  | 'AUTH_NO_TOKEN'
  | 'AUTH_NETWORK_ERROR';

/**
 * Base class for every error thrown by `@sanix/auth`.
 *
 * Carries a stable {@link AuthErrorCode} so callers can switch on it.
 */
export class AuthError extends Error {
  public readonly code: AuthErrorCode;
  public readonly providerId?: string;

  public constructor(code: AuthErrorCode, message: string, providerId?: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.providerId = providerId;
    // Restore the prototype chain across the ES5/ES6 boundary (TS legacy).
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

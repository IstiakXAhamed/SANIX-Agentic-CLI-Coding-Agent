/**
 * @file OAuthClient.ts
 * @description The PKCE-based OAuth 2.0 authorization-code flow, plus
 *   refresh / revoke / auto-refresh helpers. One instance per provider
 *   (the {@link AuthManager} façade constructs them on demand).
 *
 *   ## Flow (RFC 6749 §4.1 + RFC 7636 + RFC 8252)
 *
 *     1. Generate `code_verifier`, `code_challenge`, `state`.
 *     2. Start a localhost {@link OAuthCallbackServer} on the provider's
 *        configured port.
 *     3. Build the authorization URL with `response_type=code`,
 *        `client_id`, `redirect_uri`, `scope`, `state`,
 *        `code_challenge`, `code_challenge_method=S256`,
 *        `access_type=online` (we only request offline access when
 *        refresh tokens are wanted — left to per-provider subclassing if
 *        ever needed; the default scope set already requests refresh
 *        tokens on Google via `access_type=offline` if added by the user).
 *     4. Launch the user's default browser via the `open` package.
 *     5. Wait for the callback (`waitForCode`, with a 10-minute timeout).
 *     6. POST to the token endpoint with
 *        `grant_type=authorization_code`, `code`, `redirect_uri`,
 *        `client_id`, `code_verifier` (no client secret — PKCE only).
 *     7. Parse + validate the token response with a Zod schema.
 *     8. Persist via {@link OAuthTokenStore}.
 *     9. Stop the callback server.
 *    10. Emit `auth:success` and return the token set.
 *
 *   All failures route through {@link AuthError} with a stable
 *   {@link AuthErrorCode}; the `auth:failure` event is emitted before the
 *   promise rejects so observers (e.g. the TUI) can react even if the
 *   caller only does `.catch`.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import { z } from 'zod';
import { AuthError, type AuthEvents, type LoginOptions, type OAuthProviderConfig, type OAuthTokenSet, type RefreshOptions } from './types.js';
import { OAuthCallbackServer } from './CallbackServer.js';
import { OAuthTokenStore } from './TokenStore.js';
import { computeCodeChallenge, generateCodeVerifier, generateState } from './PKCE.js';
import { resolveClientId } from './builtInClients.js';

/**
 * Zod schema for a successful token-endpoint response. Not every provider
 * returns `refresh_token` (e.g. GitHub doesn't, unless you use the
 * GitHub App flow), and `expires_in` is optional because RFC 6749 §4.2.2
 * marks it as RECOMMENDED rather than REQUIRED — when absent, we default
 * to "never expires" (`Number.MAX_SAFE_INTEGER`).
 *
 * The schema is permissive on the *presence* of unknown fields (some
 * providers return `id_token`, `user`, `scope` etc.) but strict on the
 * fields we actually use.
 */
const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    expires_in: z.number().int().positive().optional(),
    scope: z.string().optional(),
    token_type: z.string().min(1),
  })
  .passthrough();

/** Inferred type of {@link TokenResponseSchema}. */
type TokenResponse = z.infer<typeof TokenResponseSchema>;

/**
 * Default OAuth flow timeout: 10 minutes. Generous enough for slow 2FA
 * prompts and consent-screen reviews, but bounded so a forgotten tab
 * does not pin the localhost port forever.
 */
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Default per-HTTP-request timeout (token exchange, refresh, revoke):
 * 30 seconds. The OAuth flow itself can take minutes, but each
 * individual network round-trip should be quick.
 */
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** Options accepted by the {@link OAuthClient} constructor. */
export interface OAuthClientOptions {
  /**
   * Custom `fetch` implementation. Defaults to the global `fetch`
   * (Node 18+). Useful for tests and for routing through a corporate
   * proxy.
   */
  readonly fetchImpl?: typeof fetch;
  /** Override the per-HTTP-request timeout (ms). */
  readonly httpTimeoutMs?: number;
}

/**
 * PKCE-based OAuth 2.0 client for one provider.
 *
 * One instance per provider. The class is **not** thread-safe across
 * concurrent logins for the same provider — if the caller starts a
 * second {@link login} before the first resolves, the second call will
 * fail because the callback port is already in use.
 *
 * @example
 * ```ts
 * const client = new OAuthClient(googleProvider, tokenStore);
 * client.on('auth:browser-opened', ({ url }) => console.log('Open:', url));
 * const tokens = await client.login({ clientIdOverride: '…' });
 * const valid = await client.getValidToken('google'); // auto-refreshes
 * ```
 */
export class OAuthClient extends EventEmitter<AuthEvents> {
  public readonly config: OAuthProviderConfig;
  private readonly store: OAuthTokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly httpTimeoutMs: number;

  /**
   * @param config - The provider configuration.
   * @param tokenStore - The shared token store (one per process).
   * @param opts - Optional {@link OAuthClientOptions}.
   */
  public constructor(
    config: OAuthProviderConfig,
    tokenStore: OAuthTokenStore,
    opts: OAuthClientOptions = {},
  ) {
    super();
    this.config = config;
    this.store = tokenStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.httpTimeoutMs = opts.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  }

  /**
   * Run the full PKCE authorization-code flow. See the file header for
   * the step-by-step.
   *
   * @param opts - Optional {@link LoginOptions}.
   * @returns The freshly-stored {@link OAuthTokenSet}.
   * @throws {AuthError} On any failure (timeout, state mismatch, HTTP
   *   error, network error, missing client id, schema validation).
   *
   * @example
   * ```ts
   * const tokens = await client.login({
   *   clientIdOverride: '123-abc…apps.googleusercontent.com',
   *   timeoutMs: 5 * 60_000, // 5 minutes
   * });
   * ```
   */
  public async login(opts: LoginOptions = {}): Promise<OAuthTokenSet> {
    const providerId = this.config.id;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.emit('auth:start', { providerId });

    const clientId = this.resolveClientIdSafe(opts.clientIdOverride, providerId);
    const scopes = (opts.scopes && opts.scopes.length > 0) ? opts.scopes : this.config.scopes;
    const scope = scopes.join(' ');

    // 1. PKCE + state.
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier, 'S256');
    const state = generateState();

    // 2. Callback server.
    const redirectUri = `http://127.0.0.1:${this.config.redirectPort}${this.config.redirectPath}`;
    const callbackServer = new OAuthCallbackServer(
      this.config.redirectPort,
      this.config.redirectPath,
      state,
    );
    try {
      await callbackServer.start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emit('auth:failure', { providerId, error: msg });
      throw new AuthError('AUTH_CALLBACK_ERROR', `Failed to start callback server: ${msg}`, providerId);
    }

    // 3. Build authorization URL.
    const authUrl = this.buildAuthorizationUrl({
      clientId,
      redirectUri,
      scope,
      state,
      codeChallenge,
    });

    // 4. Open browser.
    try {
      const { default: openBrowser } = await import('open');
      await openBrowser(authUrl);
      this.emit('auth:browser-opened', { url: authUrl });
    } catch (e) {
      // Browser-open failure is non-fatal: print the URL so the user can
      // open it manually. We still emit `auth:browser-opened` so the TUI
      // can display the URL.
      this.emit('auth:browser-opened', { url: authUrl });
      const msg = e instanceof Error ? e.message : String(e);
      // Don't abort the flow — the user may still open the URL by hand.
      // Surface the warning via auth:failure? No — we'd rather not. Just
      // continue; the URL has been emitted for the caller to display.
      void msg;
    }

    // 5. Wait for callback.
    let code: string;
    try {
      const result = await callbackServer.waitForCode(timeoutMs);
      code = result.code;
      this.emit('auth:callback-received', { code });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emit('auth:failure', { providerId, error: msg });
      throw e instanceof AuthError
        ? e
        : new AuthError('AUTH_CALLBACK_ERROR', msg, providerId);
    } finally {
      // 9. Stop callback server (always — even on failure).
      await callbackServer.stop().catch(() => {
        /* swallow */
      });
    }

    // 6. Exchange code for tokens.
    let tokenResponse: OAuthTokenSet;
    try {
      tokenResponse = await this.exchangeCodeForTokens({
        code,
        redirectUri,
        clientId,
        codeVerifier,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emit('auth:failure', { providerId, error: msg });
      throw e instanceof AuthError
        ? e
        : new AuthError('AUTH_TOKEN_EXCHANGE_FAILED', msg, providerId);
    }

    // 7-8. Store + emit.
    this.store.set(providerId, tokenResponse);
    this.emit('auth:success', { providerId, expiresAt: tokenResponse.expiresAt });
    return tokenResponse;
  }

  /**
   * Use a stored `refresh_token` to mint a new `access_token`.
   *
   * @param providerId - Must equal {@link OAuthProviderConfig.id}.
   * @param opts - Optional {@link RefreshOptions}.
   * @returns The refreshed {@link OAuthTokenSet}.
   * @throws {AuthError} `AUTH_NO_TOKEN` if no token is stored,
   *   `AUTH_NO_REFRESH_TOKEN` if the stored token has no refresh token,
   *   `AUTH_TOKEN_EXCHANGE_FAILED` on HTTP error.
   *
   * @example
   * ```ts
   * const refreshed = await client.refresh('google');
   * ```
   */
  public async refresh(providerId: string, opts: RefreshOptions = {}): Promise<OAuthTokenSet> {
    const existing = this.store.get(providerId);
    if (!existing) {
      throw new AuthError(
        'AUTH_NO_TOKEN',
        `Cannot refresh: no token stored for provider "${providerId}"`,
        providerId,
      );
    }
    if (!existing.refreshToken) {
      throw new AuthError(
        'AUTH_NO_REFRESH_TOKEN',
        `Cannot refresh: stored token for "${providerId}" has no refresh_token. ` +
          `Re-login with \`sanix auth login ${providerId}\` to obtain one.`,
        providerId,
      );
    }
    const clientId = this.resolveClientIdSafe(opts.clientIdOverride, providerId);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken,
      client_id: clientId,
    });
    const scope = this.config.scopes.join(' ');
    if (scope) body.set('scope', scope);

    let json: unknown;
    try {
      json = await this.httpPostForm(this.config.tokenEndpoint, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emit('auth:failure', { providerId, error: msg });
      throw e instanceof AuthError
        ? e
        : new AuthError('AUTH_NETWORK_ERROR', msg, providerId);
    }

    const parsed = this.parseTokenResponse(json, existing.refreshToken, providerId);
    this.store.set(providerId, parsed);
    this.emit('auth:refresh', { providerId, expiresAt: parsed.expiresAt });
    return parsed;
  }

  /**
   * Return a non-expired access token for the given provider, refreshing
   * on-the-fly when needed.
   *
   * @param providerId - Must equal {@link OAuthProviderConfig.id}.
   * @returns A valid {@link OAuthTokenSet}, or `null` if no token is
   *   stored **and** no refresh is possible.
   *
   * @example
   * ```ts
   * const t = await client.getValidToken('google');
   * if (!t) return null;          // user must re-login
   * return t.accessToken;         // ready to use
   * ```
   */
  public async getValidToken(providerId: string): Promise<OAuthTokenSet | null> {
    const existing = this.store.get(providerId);
    if (!existing) return null;
    const now = Date.now();
    const threshold = this.config.tokenRefreshThresholdMs;
    const expired = existing.expiresAt <= now;
    const nearExpiry = existing.expiresAt - now <= threshold;
    if (!expired && !nearExpiry) {
      return existing;
    }
    if (!existing.refreshToken) {
      // Token expired and we can't refresh — caller must re-login.
      return null;
    }
    try {
      return await this.refresh(providerId);
    } catch {
      // Refresh failed (revoked, network, etc.) — caller must re-login.
      return null;
    }
  }

  /**
   * Revoke the stored access token at the provider's revocation endpoint
   * (RFC 7009), then delete it from the local store.
   *
   * If the provider does not expose a revocation endpoint, only the local
   * delete happens. Network failures during revocation are surfaced as
   * `AUTH_REVOCATION_FAILED` but the local token is still deleted — we
   * don't want a half-revoked state to keep the user logged in locally.
   *
   * @param providerId - Must equal {@link OAuthProviderConfig.id}.
   *
   * @example
   * ```ts
   * await client.revoke('github');
   * ```
   */
  public async revoke(providerId: string): Promise<void> {
    const existing = this.store.get(providerId);
    if (!existing) return;
    if (this.config.revocationEndpoint) {
      const body = new URLSearchParams({
        token: existing.refreshToken ?? existing.accessToken,
        token_type_hint: existing.refreshToken ? 'refresh_token' : 'access_token',
      });
      try {
        await this.httpPostForm(this.config.revocationEndpoint, body);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.emit('auth:failure', { providerId, error: msg });
        // Still delete locally — see method doc.
        this.store.delete(providerId);
        this.emit('auth:logout', { providerId });
        throw new AuthError('AUTH_REVOCATION_FAILED', msg, providerId);
      }
    }
    this.store.delete(providerId);
    this.emit('auth:logout', { providerId });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  /** Resolve a client id, converting AUTH_NO_CLIENT_ID into a failure event + rethrow. */
  private resolveClientIdSafe(override: string | undefined, providerId: string): string {
    try {
      return resolveClientId(providerId, override);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emit('auth:failure', { providerId, error: msg });
      throw e;
    }
  }

  /** Build the authorization URL with PKCE + state. */
  private buildAuthorizationUrl(params: {
    clientId: string;
    redirectUri: string;
    scope: string;
    state: string;
    codeChallenge: string;
  }): string {
    const qp = new URLSearchParams({
      response_type: 'code',
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
    });
    if (params.scope) qp.set('scope', params.scope);
    const sep = this.config.authorizationEndpoint.includes('?') ? '&' : '?';
    return `${this.config.authorizationEndpoint}${sep}${qp.toString()}`;
  }

  /** Exchange the authorization code for tokens. */
  private async exchangeCodeForTokens(params: {
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
  }): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    });
    const json = await this.httpPostForm(this.config.tokenEndpoint, body);
    return this.parseTokenResponse(json, undefined, this.config.id);
  }

  /**
   * POST a URL-encoded form to a token-style endpoint and return the
   * parsed JSON body. Throws `AUTH_TOKEN_EXCHANGE_FAILED` on non-2xx or
   * `AUTH_NETWORK_ERROR` on transport failure.
   */
  private async httpPostForm(url: string, body: URLSearchParams): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      throw new AuthError('AUTH_NETWORK_ERROR', `Network error POSTing to ${url}: ${msg}`, this.config.id);
    }
    clearTimeout(timer);

    const text = await resp.text();
    let json: unknown;
    try {
      json = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new AuthError(
        'AUTH_TOKEN_EXCHANGE_FAILED',
        `Token endpoint ${url} returned non-JSON response (status ${resp.status}): ${text.slice(0, 200)}`,
        this.config.id,
      );
    }

    if (!resp.ok) {
      const errObj = json as { error?: string; error_description?: string };
      const errCode = errObj?.error ?? `http_${resp.status}`;
      const errDesc = errObj?.error_description ?? '';
      throw new AuthError(
        'AUTH_TOKEN_EXCHANGE_FAILED',
        `Token endpoint ${url} returned status ${resp.status}: ${errCode}${errDesc ? ` — ${errDesc}` : ''}`,
        this.config.id,
      );
    }
    return json;
  }

  /**
   * Validate a parsed token response against the Zod schema and convert
   * it to an {@link OAuthTokenSet}.
   *
   * @param json - Parsed JSON from the token endpoint.
   * @param fallbackRefreshToken - If the response omits
   *   `refresh_token` (some providers do on refresh), reuse the previous
   *   one so subsequent refreshes still work.
   * @param providerId - Provider id to stamp on the result.
   */
  private parseTokenResponse(
    json: unknown,
    fallbackRefreshToken: string | undefined,
    providerId: string,
  ): OAuthTokenSet {
    const parsed = TokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new AuthError(
        'AUTH_TOKEN_EXCHANGE_FAILED',
        `Token endpoint response failed schema validation: ${parsed.error.message}`,
        providerId,
      );
    }
    const data: TokenResponse = parsed.data;
    const now = Date.now();
    const expiresInMs =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in * 1000
        : Number.MAX_SAFE_INTEGER - now;
    const expiresAt = now + expiresInMs;
    const refreshToken =
      data.refresh_token ?? fallbackRefreshToken;
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt,
      scope: data.scope ?? this.config.scopes.join(' '),
      tokenType: data.token_type,
      obtainedAt: now,
      providerId,
    };
  }
}

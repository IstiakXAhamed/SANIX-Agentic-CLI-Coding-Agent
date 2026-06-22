/**
 * @sanix/auth — OAuth 2.0 PKCE authentication for SANIX.
 *
 * Public surface:
 *   - {@link AuthManager} — top-level façade. Start here.
 *   - {@link OAuthClient} — per-provider PKCE flow.
 *   - {@link OAuthTokenStore} — atomic 0600 token persistence.
 *   - {@link OAuthCallbackServer} — localhost callback server.
 *   - {@link OAUTH_PROVIDERS} / {@link getOAuthProvider} /
 *     {@link listOAuthProviders} — provider registry.
 *   - {@link resolveClientId} / {@link BUILT_IN_CLIENT_IDS} — client id
 *     resolution.
 *   - {@link generateCodeVerifier} / {@link computeCodeChallenge} /
 *     {@link base64url} / {@link generateState} — PKCE primitives.
 *   - Types: {@link OAuthProviderConfig}, {@link OAuthTokenSet},
 *     {@link AuthStatus}, {@link AuthEvents}, {@link LoginOptions},
 *     {@link RefreshOptions}, {@link AuthError}, {@link AuthErrorCode}.
 *
 * @example
 * ```ts
 * import { AuthManager } from '@sanix/auth';
 *
 * const auth = new AuthManager();
 * auth.on('auth:browser-opened', ({ url }) => console.log('Open:', url));
 *
 * // Login
 * await auth.login('google', { clientIdOverride: '…apps.googleusercontent.com' });
 *
 * // Use in a provider adapter
 * const bearer = await auth.getAccessToken('google');
 *
 * // Dashboard
 * for (const s of auth.status()) {
 *   console.log(s.providerId, s.method, s.authenticated);
 * }
 * ```
 *
 * @packageDocumentation
 */

// Types
export {
  AuthError,
  type AuthErrorCode,
  type AuthEvents,
  type AuthStatus,
  type LoginOptions,
  type OAuthProviderConfig,
  type OAuthTokenSet,
  type RefreshOptions,
} from './types.js';

// PKCE primitives
export {
  base64url,
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
} from './PKCE.js';

// Callback server
export { OAuthCallbackServer, type CallbackResult } from './CallbackServer.js';

// Token store
export {
  OAuthTokenStore,
  DEFAULT_TOKEN_STORE_PATH,
  type OAuthTokenStoreOptions,
} from './TokenStore.js';

// OAuth client
export { OAuthClient, type OAuthClientOptions } from './OAuthClient.js';

// Auth manager façade
export { AuthManager, type AuthManagerOptions } from './AuthManager.js';

// Built-in client id registry
export { BUILT_IN_CLIENT_IDS, resolveClientId } from './builtInClients.js';

// Provider registry
export {
  OAUTH_PROVIDERS,
  getOAuthProvider,
  listOAuthProviders,
  googleProvider,
  githubProvider,
  anthropicProvider,
  microsoftProvider,
} from './providers/index.js';

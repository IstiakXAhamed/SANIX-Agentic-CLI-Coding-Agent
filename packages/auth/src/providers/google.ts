/**
 * @file google.ts
 * @description Google OAuth 2.0 configuration for accessing the Gemini API
 *   on behalf of the user. Uses a Desktop App OAuth client (RFC 8252
 *   native-app flow with PKCE) so no client secret is ever needed.
 *
 *   ## How to obtain a Google OAuth client id
 *
 *   1. Open the **Google Cloud Console** → *APIs & Services* → *Credentials*:
 *        https://console.cloud.google.com/apis/credentials
 *   2. Create or select a project. Make sure the **Generative Language API**
 *      (`generativelanguage.googleapis.com`) is enabled on that project
 *      (APIs & Services → Library → search "Generative Language API" →
 *      Enable).
 *   3. Click *Create Credentials* → *OAuth client ID*.
 *   4. Application type: **Desktop app**. (Web application will not work —
 *      SANIX listens on `127.0.0.1` only and never exposes a public
 *      redirect URI.)
 *   5. Give it a name (e.g. `SANIX`) and click *Create*.
 *   6. Copy the **Client ID** that looks like
 *      `1234567890-abc…apps.googleusercontent.com`.
 *   7. Pass it to SANIX with:
 *
 *        sanix auth login google --client-id 1234567890-abc…apps.googleusercontent.com
 *
 *   TODO: ship a default SANIX-branded Desktop client id once Google's
 *   OAuth consent screen review is complete. Until then `clientId` stays
 *   empty and {@link resolveClientId} throws if the user forgets the
 *   `--client-id` flag.
 *
 *   ## Scopes
 *
 *   - `https://www.googleapis.com/auth/generative-language.restricted` —
 *     the scope Gemini's REST endpoint expects for user-delegated access.
 *   - `openid`, `email` — let SANIX display the connected account in
 *     `sanix auth status`.
 *
 *   ## Endpoints
 *
 *   - Authorization: `https://accounts.google.com/o/oauth2/v2/auth`
 *   - Token:         `https://oauth2.googleapis.com/token`
 *   - Revocation:    `https://oauth2.googleapis.com/revoke`
 *   - UserInfo:      `https://www.googleapis.com/oauth2/v3/userinfo`
 *
 *   ## Localhost callback
 *
 *   Listens on `127.0.0.1:8787/callback`. The chosen port avoids the
 *   common dev-server ranges (3000, 5000, 8000, 8080) and the other SANIX
 *   OAuth provider ports.
 *
 * @packageDocumentation
 */

import type { OAuthProviderConfig } from '../types.js';

/**
 * Google / Gemini OAuth provider configuration.
 *
 * {@link OAuthProviderConfig.clientId} is intentionally empty — see the
 * file header for how to obtain one and pass it via `--client-id`.
 */
export const googleProvider: OAuthProviderConfig = {
  id: 'google',
  displayName: 'Google (Gemini)',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  userInfoEndpoint: 'https://www.googleapis.com/oauth2/v3/userinfo',
  scopes: [
    'https://www.googleapis.com/auth/generative-language.restricted',
    'openid',
    'email',
  ],
  clientId: '',
  redirectPort: 8787,
  redirectPath: '/callback',
  tokenRefreshThresholdMs: 5 * 60 * 1000,
} as const;

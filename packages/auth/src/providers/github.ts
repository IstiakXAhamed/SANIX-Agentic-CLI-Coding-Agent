/**
 * @file github.ts
 * @description GitHub OAuth configuration for Copilot-style access. A
 *   successful login yields a GitHub user-to-server token that can be
 *   used to call the GitHub API (and, where entitled, the Copilot
 *   completion endpoints via the GitHub Copilot HTTP API).
 *
 *   ## How to obtain a GitHub OAuth App client id
 *
 *   1. Open **GitHub → Settings → Developer settings → OAuth Apps**:
 *        https://github.com/settings/developers
 *   2. Click *New OAuth App*.
 *   3. Application name: `SANIX` (or anything you prefer).
 *   4. Homepage URL: `http://localhost:8788` (any URL works; this field
 *      is just informational).
 *   5. **Authorization callback URL**: `http://localhost:8788/callback`
 *      (must match {@link githubProvider.redirectPort} +
 *      {@link githubProvider.redirectPath}).
 *   6. Click *Register application*.
 *   7. Copy the **Client ID** (the secret is **not** needed — SANIX uses
 *      PKCE so no client secret is ever sent over the wire).
 *   8. Pass it to SANIX with:
 *
 *        sanix auth login github --client-id Iv1.abc123…
 *
 *   TODO: ship a default SANIX-branded OAuth App client id once the app is
 *   reviewed by GitHub. Until then `clientId` stays empty and
 *   {@link resolveClientId} throws if the user forgets the `--client-id`
 *   flag.
 *
 *   ## Scopes
 *
 *   - `read:user` — read the connected user's profile (for `auth status`).
 *   - `gist` — create / read gists (used by the `tools` package's web
 *     tools and the agent's code-sharing tools).
 *
 *   If you need more scopes (e.g. `repo` for private-repo access), pass
 *   them via `--scope` on the CLI; they will be merged into the request.
 *
 *   ## Endpoints
 *
 *   - Authorization: `https://github.com/login/oauth/authorize`
 *   - Token:         `https://github.com/login/oauth/access_token`
 *   - UserInfo:      `https://api.github.com/user`
 *
 *   GitHub does not implement RFC 7009 token revocation, so
 *   {@link OAuthProviderConfig.revocationEndpoint} is omitted — `sanix auth
 *   logout github` will simply delete the token locally. To revoke the
 *   token server-side, the user must visit
 *   https://github.com/settings/applications and revoke SANIX manually.
 *
 *   ## Localhost callback
 *
 *   Listens on `127.0.0.1:8788/callback`.
 *
 * @packageDocumentation
 */

import type { OAuthProviderConfig } from '../types.js';

/**
 * GitHub OAuth provider configuration.
 *
 * {@link OAuthProviderConfig.clientId} is intentionally empty — see the
 * file header for how to obtain one and pass it via `--client-id`.
 */
export const githubProvider: OAuthProviderConfig = {
  id: 'github',
  displayName: 'GitHub (Copilot)',
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  // GitHub does not implement RFC 7009 revocation.
  revocationEndpoint: undefined,
  userInfoEndpoint: 'https://api.github.com/user',
  scopes: ['read:user', 'gist'],
  clientId: '',
  redirectPort: 8788,
  redirectPath: '/callback',
  tokenRefreshThresholdMs: 5 * 60 * 1000,
} as const;

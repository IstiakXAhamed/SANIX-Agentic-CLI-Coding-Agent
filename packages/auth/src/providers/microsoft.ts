/**
 * @file microsoft.ts
 * @description Microsoft identity (Entra ID, formerly Azure AD) OAuth 2.0
 *   configuration for accessing Azure OpenAI Service. Uses the
 *   `common` tenant so any Microsoft account (personal or work/school)
 *   can authenticate; the requested scope is the Cognitive Services
 *   `.default` scope which translates to whatever permission the user has
 *   on the target Azure OpenAI resource.
 *
 *   ## How to obtain a Microsoft client id
 *
 *   1. Open the **Azure Portal** → *Microsoft Entra ID* → *App
 *      registrations* → *New registration*:
 *        https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps
 *   2. Supported account types: **Accounts in any organizational directory
 *      and personal Microsoft accounts** (this matches the `common`
 *      tenant used below).
 *   3. Redirect URI: select *Mobile and desktop applications* → add
 *      `http://localhost:8790/callback` (must match
 *      {@link microsoftProvider.redirectPort} +
 *      {@link microsoftProvider.redirectPath}).
 *   4. Click *Register*.
 *   5. Copy the **Application (client) ID** from the Overview page.
 *   6. Pass it to SANIX with:
 *
 *        sanix auth login microsoft --client-id 11111111-2222-3333-4444-555555555555
 *
 *   TODO: ship a default SANIX-branded Microsoft client id once the app
 *   passes Microsoft's verification. Until then `clientId` stays empty and
 *   {@link resolveClientId} throws if the user forgets the `--client-id`
 *   flag.
 *
 *   ## Scopes
 *
 *   - `https://cognitiveservices.azure.com/.default` — the standard
 *     scope for Azure Cognitive Services / Azure OpenAI. With `.default`,
 *     Microsoft returns a token scoped to whatever roles the user has on
 *     the target Azure OpenAI resource (e.g. `Cognitive Services OpenAI
 *     Contributor`).
 *
 *   ## Endpoints
 *
 *   - Authorization: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
 *   - Token:         `https://login.microsoftonline.com/common/oauth2/v2.0/token`
 *
 *   Microsoft does not currently expose a public revocation endpoint that
 *   accepts the access token directly; `sanix auth logout microsoft`
 *   deletes the token locally. (Admins can revoke refresh tokens via the
 *   Entra admin APIs.)
 *
 *   ## Localhost callback
 *
 *   Listens on `127.0.0.1:8790/callback`.
 *
 * @packageDocumentation
 */

import type { OAuthProviderConfig } from '../types.js';

/**
 * Microsoft / Azure OpenAI OAuth provider configuration.
 *
 * {@link OAuthProviderConfig.clientId} is intentionally empty — see the
 * file header for how to obtain one and pass it via `--client-id`.
 */
export const microsoftProvider: OAuthProviderConfig = {
  id: 'microsoft',
  displayName: 'Microsoft (Azure OpenAI)',
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  // No public RFC 7009 revocation endpoint for the personal/common tenant.
  revocationEndpoint: undefined,
  userInfoEndpoint: 'https://graph.microsoft.com/oidc/userinfo',
  scopes: ['https://cognitiveservices.azure.com/.default'],
  clientId: '',
  redirectPort: 8790,
  redirectPath: '/callback',
  tokenRefreshThresholdMs: 5 * 60 * 1000,
} as const;

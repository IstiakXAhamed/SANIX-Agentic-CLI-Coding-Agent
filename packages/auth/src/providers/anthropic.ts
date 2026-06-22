/**
 * @file anthropic.ts
 * @description Anthropic OAuth provider configuration.
 *
 *   ⚠️ **Status: coming soon.** Anthropic's public OAuth endpoint for the
 *   Claude API is still rolling out — at the time of writing (June 2026)
 *   the standard way to authenticate against
 *   `https://api.anthropic.com/v1/messages` is with a plain API key
 *   (`x-api-key: sk-ant-…`). The configuration below is emitted so the
 *   full PKCE flow can be tested end-to-end today against any sandbox or
 *   preview endpoint that exposes it, and so the CLI's `sanix auth login
 *   anthropic` command has a stable target.
 *
 *   When Anthropic GA's OAuth, the only changes needed here will be:
 *     1. Update the endpoints if they move.
 *     2. Update the scope list to match the GA contract.
 *     3. Optionally ship a default SANIX-branded client id.
 *
 *   ## Scopes
 *
 *   - `org:read` — read org membership / billing (for `auth status`).
 *   - `api:write` — submit prompts to the Messages API on the user's
 *     behalf.
 *
 *   ## Endpoints (subject to change before GA)
 *
 *   - Authorization: `https://console.anthropic.com/oauth/authorize`
 *   - Token:         `https://console.anthropic.com/oauth/token`
 *
 *   Until GA, prefer the env-var / API-key path
 *   (`ANTHROPIC_API_KEY=sk-ant-…`) — that path is always supported by
 *   {@link AuthManager.getAccessToken}.
 *
 *   ## Localhost callback
 *
 *   Listens on `127.0.0.1:8789/callback`.
 *
 * @packageDocumentation
 */

import type { OAuthProviderConfig } from '../types.js';

/**
 * Anthropic OAuth provider configuration (preview — see file header).
 */
export const anthropicProvider: OAuthProviderConfig = {
  id: 'anthropic',
  displayName: 'Anthropic (Claude)',
  authorizationEndpoint: 'https://console.anthropic.com/oauth/authorize',
  tokenEndpoint: 'https://console.anthropic.com/oauth/token',
  // Anthropic has not yet published a revocation endpoint.
  revocationEndpoint: undefined,
  userInfoEndpoint: undefined,
  scopes: ['org:read', 'api:write'],
  clientId: '',
  redirectPort: 8789,
  redirectPath: '/callback',
  tokenRefreshThresholdMs: 5 * 60 * 1000,
} as const;

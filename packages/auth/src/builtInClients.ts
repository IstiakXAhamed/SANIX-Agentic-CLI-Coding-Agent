/**
 * @file builtInClients.ts
 * @description Resolution of OAuth client ids.
 *
 *   SANIX ships **without** any baked-in OAuth client ids by default.
 *   Reasoning:
 *     - Bundling a client id makes every SANIX user share a single OAuth
 *       consent screen, which has caused throttling / approval issues for
 *       similar tools in the past.
 *     - Per-user client ids are zero-cost on every provider we support
 *       (Google / GitHub / Microsoft / Anthropic) and let each user
 *       audit / revoke their own consent.
 *
 *   The {@link BUILT_IN_CLIENT_IDS} map is therefore kept as a registry
 *   of *potential* built-in ids — all currently empty strings — so that
 *   if/when a SANIX-branded client id is published for a provider, only
 *   this file needs to change. The {@link resolveClientId} helper enforces
 *   the contract: it throws a clear `AUTH_NO_CLIENT_ID` error if neither
 *   an override nor a built-in id is available.
 *
 * @packageDocumentation
 */

import { AuthError } from './types.js';
import { listOAuthProviders } from './providers/index.js';

/**
 * Registry of built-in (SANIX-published) OAuth client ids per provider.
 *
 * All entries are currently empty strings (`TODO`) — see the file header.
 * When a real id is added, update only this map; no other code needs to
 * change.
 *
 * @example
 * ```ts
 * // Future: BUILT_IN_CLIENT_IDS.google = '123456-sanix.apps.googleusercontent.com';
 * BUILT_IN_CLIENT_IDS.google; // '' (empty — user must supply --client-id)
 * ```
 */
export const BUILT_IN_CLIENT_IDS: Readonly<Record<string, string>> = Object.freeze({
  // TODO: ship a SANIX-branded Google Desktop client id once Google's
  // OAuth consent screen review is complete.
  google: '',
  // TODO: ship a SANIX-branded GitHub OAuth App client id.
  github: '',
  // TODO: Anthropic OAuth is still in preview; no built-in client yet.
  anthropic: '',
  // TODO: ship a SANIX-branded Microsoft Entra app client id once the app
  // passes Microsoft verification.
  microsoft: '',
  // Any future provider added to OAUTH_PROVIDERS should also get an entry
  // here, defaulting to '' so resolveClientId() fails loudly until a real
  // id is published.
});

/**
 * Resolve the OAuth client id to use for a given provider.
 *
 * Resolution order:
 *   1. The caller-supplied `override` (from e.g. `--client-id` on the
 *      CLI). Always wins when present and non-empty.
 *   2. The built-in id in {@link BUILT_IN_CLIENT_IDS} (currently all
 *      empty).
 *
 * @param providerId - Provider id, e.g. `'google'`. Case-insensitive.
 * @param override - Optional caller-supplied client id.
 * @returns The resolved client id.
 * @throws {AuthError} `AUTH_NO_CLIENT_ID` if no client id is available.
 *
 * @example
 * ```ts
 * // CLI: sanix auth login google --client-id 123-abc…apps.googleusercontent.com
 * const id = resolveClientId('google', '123-abc…apps.googleusercontent.com');
 *
 * // No override, no built-in → throws AUTH_NO_CLIENT_ID.
 * resolveClientId('github'); // throws AuthError
 * ```
 */
export function resolveClientId(providerId: string, override?: string): string {
  const normalized = providerId.toLowerCase();
  const trimmedOverride = override?.trim();
  if (trimmedOverride && trimmedOverride.length > 0) {
    return trimmedOverride;
  }
  const builtIn = BUILT_IN_CLIENT_IDS[normalized];
  if (typeof builtIn === 'string' && builtIn.length > 0) {
    return builtIn;
  }
  throw new AuthError(
    'AUTH_NO_CLIENT_ID',
    `No OAuth client id is configured for provider "${normalized}". ` +
      `Pass one with --client-id <id>, or set the BUILT_IN_CLIENT_IDS map in @sanix/auth. ` +
      `Available providers: ${listOAuthProviders().join(', ')}.`,
    normalized,
  );
}

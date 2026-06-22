/**
 * @file providers/index.ts
 * @description Barrel + lookup helpers for every built-in OAuth provider
 *   configuration shipped with `@sanix/auth`. To add a new provider:
 *     1. Create `src/providers/<id>.ts` exporting a `OAuthProviderConfig`
 *        named `<id>Provider`.
 *     2. Import it here, add it to {@link OAUTH_PROVIDERS}, and re-export
 *        it for direct access.
 *
 * @packageDocumentation
 */

import type { OAuthProviderConfig } from '../types.js';
import { googleProvider } from './google.js';
import { githubProvider } from './github.js';
import { anthropicProvider } from './anthropic.js';
import { microsoftProvider } from './microsoft.js';

export { googleProvider } from './google.js';
export { githubProvider } from './github.js';
export { anthropicProvider } from './anthropic.js';
export { microsoftProvider } from './microsoft.js';

/**
 * Map of every built-in OAuth provider, keyed by id. Use
 * {@link getOAuthProvider} for lookup-with-fallback or
 * {@link listOAuthProviders} to enumerate ids.
 *
 * @example
 * ```ts
 * OAUTH_PROVIDERS['google']; // googleProvider
 * ```
 */
export const OAUTH_PROVIDERS: Readonly<Record<string, OAuthProviderConfig>> = Object.freeze({
  google: googleProvider,
  github: githubProvider,
  anthropic: anthropicProvider,
  microsoft: microsoftProvider,
});

/**
 * Look up an OAuth provider configuration by id.
 *
 * @param id - Provider id (e.g. `'google'`). Case-insensitive.
 * @returns The matching {@link OAuthProviderConfig}, or `null` if no
 *   built-in provider has that id.
 *
 * @example
 * ```ts
 * const cfg = getOAuthProvider('Google'); // → googleProvider (case-insensitive)
 * const nope = getOAuthProvider('openai'); // → null (no OAuth provider for OpenAI)
 * ```
 */
export function getOAuthProvider(id: string): OAuthProviderConfig | null {
  const normalized = id.toLowerCase();
  return OAUTH_PROVIDERS[normalized] ?? null;
}

/**
 * Enumerate the ids of every built-in OAuth provider.
 *
 * @returns A new array of provider ids on each call (callers can safely
 *   mutate the result).
 *
 * @example
 * ```ts
 * listOAuthProviders(); // ['google', 'github', 'anthropic', 'microsoft']
 * ```
 */
export function listOAuthProviders(): string[] {
  return Object.keys(OAUTH_PROVIDERS);
}

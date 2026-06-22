/**
 * @file PKCE.ts
 * @description RFC 7636 PKCE ("Proof Key for Code Exchange") helpers used by
 *   every OAuth 2.0 flow in `@sanix/auth`. PKCE lets public Desktop App
 *   clients (which cannot keep a client secret) safely perform an
 *   authorization-code flow by binding the authorization request to a
 *   cryptographically-random `code_verifier` that is later re-presented at
 *   the token endpoint.
 *
 *   The flow is:
 *     1. Generate a random `code_verifier` (43-128 chars, URL-safe).
 *     2. Derive `code_challenge = base64url(SHA-256(code_verifier))`.
 *     3. Send `code_challenge` + `code_challenge_method=S256` with the
 *        authorization request.
 *     4. At token-exchange time, send the original `code_verifier` so the
 *        provider can verify the same client that started the flow is now
 *        finishing it.
 *
 *   All randomness comes from `node:crypto.randomBytes` (CSPRNG).
 *
 * @packageDocumentation
 */

import { randomBytes, createHash } from 'node:crypto';

/**
 * Encode a `Buffer` as a URL-safe base64 string with no padding, per
 * RFC 4648 §5. This is the encoding every OAuth 2.0 PKCE implementation
 * expects.
 *
 * @param buffer - The bytes to encode.
 * @returns The base64url string (no `=` padding, no `+` or `/`).
 *
 * @example
 * ```ts
 * base64url(Buffer.from([0xff, 0xfe])); // '__76'
 * ```
 */
export function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Minimum and maximum code-verifier lengths allowed by RFC 7636 §4.1.
 */
const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;

/**
 * Generate a cryptographically-random PKCE `code_verifier`.
 *
 * The verifier is produced by base64url-encoding `length` random bytes (so
 * the resulting string is somewhat longer than `length`). All output
 * characters are in the RFC 7636 unreserved set
 * `[A-Z][a-z][0-9]-._~` (base64url maps `+` → `-` and `/` → `_`, and we
 * strip `=` padding — all within the allowed set).
 *
 * @param length - Number of random source bytes to use. Defaults to 64,
 *   which yields an ~86-character verifier (comfortably inside the
 *   43–128-character RFC window). Must be in `[32, 96]` so the encoded
 *   result lands inside `[43, 128]`.
 * @returns The PKCE `code_verifier` string.
 * @throws {RangeError} If `length` is outside `[32, 96]`.
 *
 * @example
 * ```ts
 * const verifier = generateCodeVerifier();
 * verifier.length; // ~86 chars, all URL-safe
 * ```
 */
export function generateCodeVerifier(length: number = 64): string {
  if (length < 32 || length > 96) {
    throw new RangeError(
      `generateCodeVerifier: length must be in [32, 96] (got ${length}) so the ` +
        `encoded verifier lands inside the RFC 7636 [43, 128] window`,
    );
  }
  return base64url(randomBytes(length));
}

/**
 * Compute the PKCE `code_challenge` from a `code_verifier`.
 *
 * For the recommended `S256` method, this is
 * `base64url(SHA-256(verifier))`. For `plain`, it is the verifier itself
 * (only useful when a provider explicitly forbids S256).
 *
 * @param verifier - The `code_verifier` previously produced by
 *   {@link generateCodeVerifier}.
 * @param method - `'S256'` (default, cryptographically bound) or `'plain'`
 *   (no binding; avoid unless the provider requires it).
 * @returns The `code_challenge` string to send with the authorization
 *   request.
 *
 * @example
 * ```ts
 * const verifier  = generateCodeVerifier();
 * const challenge = computeCodeChallenge(verifier, 'S256');
 * // Send challenge + 'S256' in the auth URL; submit verifier at token exchange.
 * ```
 */
export function computeCodeChallenge(
  verifier: string,
  method: 'S256' | 'plain' = 'S256',
): string {
  if (verifier.length < MIN_VERIFIER_LENGTH || verifier.length > MAX_VERIFIER_LENGTH) {
    throw new RangeError(
      `computeCodeChallenge: verifier length ${verifier.length} is outside the ` +
        `RFC 7636 [${MIN_VERIFIER_LENGTH}, ${MAX_VERIFIER_LENGTH}] window`,
    );
  }
  if (method === 'plain') {
    return verifier;
  }
  const hash = createHash('sha256').update(verifier, 'utf8').digest();
  return base64url(hash);
}

/**
 * Generate a cryptographically-random `state` parameter for CSRF
 * protection. The same value is sent in the authorization request and
 * expected back unchanged in the callback; any mismatch aborts the flow.
 *
 * Uses 24 random bytes (base64url-encoded to ~32 chars) — long enough to
 * be unguessable, short enough to fit in a query string comfortably.
 *
 * @returns A URL-safe opaque state token.
 *
 * @example
 * ```ts
 * const state = generateState();
 * // …send state in auth URL… later, on callback, assert state === returnedState.
 * ```
 */
export function generateState(): string {
  return base64url(randomBytes(24));
}

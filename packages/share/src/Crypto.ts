/**
 * @file Crypto.ts
 * @description AES-256-GCM symmetric encryption helpers built on
 *   `node:crypto`. No external crypto dependencies.
 *
 *   ## On-the-wire format
 *
 *   `encrypt(data, key)` produces a buffer laid out as:
 *
 *   ```
 *   | salt (16B) | ciphertext (...B) | authTag (16B) |
 *   ```
 *
 *   The 32-byte AES key is derived from `key` (a user-supplied passphrase
 *   or {@link generateKey} output) via `scryptSync(key, salt, 32)` with a
 *   fresh 16-byte random salt per encryption. The GCM auth tag is appended
 *   (not prepended) so the ciphertext length equals the plaintext length,
 *   which makes streaming-decrypt simpler for the workspace-bundler path.
 *
 *   `decrypt(data, key)` reverses the layout: split off salt/tag, re-derive
 *   the key, and call `createDecipheriv('aes-256-gcm', ...)`. Throws a
 *   `ShareError` (code `SHARE_DECRYPT_FAILED`) on any integrity failure —
 *   GCM's auth tag covers both the ciphertext and the derivation salt
 *   (passed as AAD), so a tampered blob is rejected without leaking
 *   partial plaintext.
 *
 *   ## Why scrypt (not HKDF / PBKDF2)
 *
 *   scrypt is memory-hard, which makes brute-force of a stolen key
 *   meaningfully more expensive than PBKDF2. The default parameters (N=16384,
 *   r=8, p=1) finish in ~80ms on a 2024 laptop — negligible next to the
 *   network round-trip for the actual upload.
 *
 * @packageDocumentation
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { ShareError } from './types.js';

/** Algorithm identifier (also emitted in `share:encrypted` events). */
export const SHARE_CRYPTO_ALGORITHM = 'aes-256-gcm';

/** Salt length, in bytes. */
const SALT_LEN = 16;
/** GCM authentication tag length, in bytes. */
const TAG_LEN = 16;
/** Derived AES key length, in bytes (AES-256 → 32). */
const KEY_LEN = 32;

/**
 * Encrypt `data` with `key` using AES-256-GCM.
 *
 * @param data - Plaintext bytes.
 * @param key  - Passphrase. May be any UTF-8 string; for best practice use
 *   {@link generateKey} to obtain a 32-byte base64url key.
 * @returns The on-the-wire buffer: `salt || ciphertext || authTag`.
 *
 * @example
 * ```ts
 * import { encrypt, generateKey, decrypt } from '@sanix/share';
 *
 * const key = generateKey();
 * const blob = encrypt(Buffer.from('hello'), key);
 * const back = decrypt(blob, key); // <Buffer 68 65 6c 6c 6f>
 * ```
 */
export function encrypt(data: Buffer, key: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(key, salt, KEY_LEN);
  const cipher = createCipheriv(SHARE_CRYPTO_ALGORITHM, derived, null) as CipherGCM;
  // Bind the salt into the AAD so it can't be swapped out without
  // invalidating the auth tag.
  cipher.setAAD(salt);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, ct, tag]);
}

/**
 * Decrypt a buffer produced by {@link encrypt}.
 *
 * @param data - `salt || ciphertext || authTag`.
 * @param key  - The same key passed to {@link encrypt}.
 * @returns The original plaintext.
 * @throws {ShareError} `SHARE_DECRYPT_FAILED` on any integrity / format
 *   failure. GCM guarantees no plaintext is leaked when the auth tag is
 *   invalid.
 *
 * @example
 * ```ts
 * try {
 *   const plain = decrypt(blob, key);
 * } catch (e) {
 *   if (e instanceof ShareError && e.code === 'SHARE_DECRYPT_FAILED') {
 *     console.error('wrong key or tampered blob');
 *   }
 * }
 * ```
 */
export function decrypt(data: Buffer, key: string): Buffer {
  if (data.length < SALT_LEN + TAG_LEN) {
    throw new ShareError(
      'SHARE_DECRYPT_FAILED',
      `Encrypted blob too short (${data.length} < ${SALT_LEN + TAG_LEN} bytes).`,
    );
  }
  const salt = data.subarray(0, SALT_LEN);
  const tag = data.subarray(data.length - TAG_LEN);
  const ct = data.subarray(SALT_LEN, data.length - TAG_LEN);
  const derived = scryptSync(key, salt, KEY_LEN);
  const decipher = createDecipheriv(SHARE_CRYPTO_ALGORITHM, derived, null) as DecipherGCM;
  decipher.setAAD(salt);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new ShareError(
      'SHARE_DECRYPT_FAILED',
      'AES-256-GCM authentication failed — wrong key or tampered ciphertext.',
    );
  }
}

/**
 * Generate a fresh 32-byte random key, base64url-encoded.
 *
 * The returned string is safe to print / paste into a chat. Use it as the
 * `encryptionKey` on a {@link ShareRequest} or pass it to {@link encrypt}.
 *
 * @returns 43-char base64url string (32 bytes → 43 chars without padding).
 *
 * @example
 * ```ts
 * const key = generateKey(); // 'v3ry-r4nd0m-k3y...'
 * ```
 */
export function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex digest of `data`. Used for integrity checks / log dedup.
 *
 * @param data - Any buffer.
 * @returns 64-char lowercase hex digest.
 *
 * @example
 * ```ts
 * const h = hash(Buffer.from('hello')); // '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
 * ```
 */
export function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

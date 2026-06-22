/**
 * @file _util.ts
 * @description Tiny internal helpers shared across adapters — kept here
 *   rather than inlined to avoid drift between adapters and to give the
 *   test-suite a single place to mock filesystem / id behavior.
 *
 * @packageDocumentation
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import type { Expiration, ShareKind } from './types.js';

/**
 * Map an {@link Expiration} bucket to a duration in milliseconds.
 * Returns `undefined` for `'never'` (callers should leave the
 * `expiresAt` field unset on the result).
 */
export function expirationToMs(exp: Expiration | undefined): number | undefined {
  switch (exp) {
    case '1h':
      return 3_600_000;
    case '1d':
      return 86_400_000;
    case '7d':
      return 7 * 86_400_000;
    case '30d':
      return 30 * 86_400_000;
    case 'never':
    case undefined:
      return undefined;
    default: {
      // Exhaustiveness guard — TS narrows this branch to `never`.
      const _exhaustive: never = exp;
      void _exhaustive;
      return undefined;
    }
  }
}

/**
 * Default filename for a given {@link ShareKind}, used when the caller
 * omits `filename`. The extensions line up with what the CLI's
 * `sanix share <kind>` defaults to.
 */
export function defaultFilename(kind: ShareKind): string {
  switch (kind) {
    case 'file':
      return 'sanix-file.bin';
    case 'session':
      return 'sanix-session.json';
    case 'checkpoint':
      return 'sanix-checkpoint.json';
    case 'memory-snapshot':
      return 'sanix-memory.json';
    case 'agent-result':
      return 'sanix-result.json';
    case 'workspace':
      return 'sanix-workspace.tar.gz';
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return 'sanix-share.bin';
    }
  }
}

/** Generate a fresh share id (used as the local `id` on `ShareResult`). */
export function newShareId(): string {
  return nanoid(12);
}

/**
 * Resolve `~/.sanix/shares/` (or an override). Honors `$SANIX_HOME` if set
 * (matches the convention used by `@sanix/config` / `@sanix/auth`).
 */
export function sanixSharesDir(): string {
  const home = process.env.SANIX_HOME ?? os.homedir();
  return path.join(home, '.sanix', 'shares');
}

/**
 * Convert a `string | Buffer` content field to a `Buffer` (UTF-8 for
 * strings). Centralizes the conversion so adapters always see `Buffer`.
 */
export function contentToBuffer(content: string | Buffer): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

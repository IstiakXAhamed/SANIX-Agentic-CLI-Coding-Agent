/**
 * @file providers/index.ts
 * @description Barrel for all paste-service adapters + the
 *   {@link getAdapter}/{@link listAdapters} registry helpers used by
 *   {@link ShareManager}.
 *
 *   The registry is intentionally a factory function (not a static map)
 *   so each {@link ShareManager} instance can construct adapters with
 *   its own `githubToken` — a process-wide singleton would leak tokens
 *   between unrelated share sessions.
 *
 * @packageDocumentation
 */

import type { ShareAdapter, ShareProvider } from '../types.js';
import { GistAdapter } from './GistAdapter.js';
import { PasteRsAdapter } from './PasteRsAdapter.js';
import { NullXAdapter } from './NullXAdapter.js';
import { TransferShAdapter } from './TransferShAdapter.js';
import { FileAdapter } from './FileAdapter.js';

export { GistAdapter } from './GistAdapter.js';
export { PasteRsAdapter } from './PasteRsAdapter.js';
export { NullXAdapter } from './NullXAdapter.js';
export { TransferShAdapter } from './TransferShAdapter.js';
export { FileAdapter } from './FileAdapter.js';

/** Registry options passed from {@link ShareManager} at adapter construction. */
export interface AdapterRegistryOptions {
  /** GitHub bearer token (forwarded to {@link GistAdapter}). */
  readonly githubToken?: string;
  /** Override root dir for the {@link FileAdapter}. */
  readonly fileRootDir?: string;
  /** Custom fetch implementation (forwarded to adapters that accept it). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Construct the adapter for a given provider id, or `null` if the id is
 * unknown. Adapters are constructed fresh on every call (they're cheap
 * — no network in the constructor).
 *
 * @param id - Provider id.
 * @param opts - Registry options (token, file root, etc.).
 * @returns The adapter, or `null`.
 *
 * @example
 * ```ts
 * const a = getAdapter('gist', { githubToken: process.env.GITHUB_TOKEN });
 * if (a) await a.upload({ ... });
 * ```
 */
export function getAdapter(
  id: ShareProvider,
  opts: AdapterRegistryOptions = {},
): ShareAdapter | null {
  switch (id) {
    case 'gist':
      return new GistAdapter({ token: opts.githubToken });
    case 'paste-rs':
      return new PasteRsAdapter();
    case '0x0':
      return new NullXAdapter();
    case 'transfer-sh':
      return new TransferShAdapter();
    case 'file':
      return new FileAdapter({ rootDir: opts.fileRootDir });
    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = id;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * List every built-in provider id. Useful for CLI `--help` / TUI status
 * tables.
 *
 * @returns Ordered array of provider ids.
 *
 * @example
 * ```ts
 * listAdapters(); // ['gist', 'paste-rs', '0x0', 'transfer-sh', 'file']
 * ```
 */
export function listAdapters(): ShareProvider[] {
  return ['gist', 'paste-rs', '0x0', 'transfer-sh', 'file'];
}

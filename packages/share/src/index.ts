/**
 * @file index.ts
 * @description Barrel for `@sanix/share`. Re-exports every public
 *   symbol so consumers can `import { ShareManager, encrypt, … } from
 *   '@sanix/share'`.
 *
 *   The CLI surface is **not** implemented in this package — `@sanix/cli`
 *   wires `sanix share …` to {@link ShareManager}. The intended CLI is:
 *
 *   ```
 *   sanix share file <path> [--provider gist|paste-rs|0x0|transfer-sh|file] [--encrypt] [--expires 1d|7d|never] [--public]
 *   sanix share session <sessionId> [--provider ...]
 *   sanix share checkpoint <checkpointId>
 *   sanix share memory [--provider ...]
 *   sanix share workspace [--provider ...]
 *   sanix share list
 *   sanix share revoke <id>
 *   sanix share download <url> [--decrypt --key <key>] [--out <path>]
 *   ```
 *
 * @packageDocumentation
 */

// Types — re-exported as values where applicable (ShareError is a class).
export {
  ShareError,
  type ShareProvider,
  type ShareKind,
  type Expiration,
  type ShareRequest,
  type ShareResult,
  type ShareEvents,
  type DownloadRequest,
  type DownloadResult,
  type ShareAdapter,
  type ShareRecord,
} from './types.js';

// Crypto helpers.
export {
  encrypt,
  decrypt,
  generateKey,
  hash,
  SHARE_CRYPTO_ALGORITHM,
} from './Crypto.js';

// Provider adapters + registry.
export {
  GistAdapter,
  PasteRsAdapter,
  NullXAdapter,
  TransferShAdapter,
  FileAdapter,
  getAdapter,
  listAdapters,
  type AdapterRegistryOptions,
} from './providers/index.js';

// Share log.
export { ShareLog, type ShareLogFilter } from './ShareLog.js';

// Workspace bundler.
export { WorkspaceBundler, ALWAYS_IGNORED, type BundleOptions } from './WorkspaceBundler.js';

// Tar internals (advanced use — e.g. custom bundlers).
export { tarHeader, createTarGz, type TarEntry } from './_tar.js';

// Main façade.
export {
  ShareManager,
  type ShareManagerOptions,
  type ShareFileOptions,
  type ShareSessionOptions,
  type ShareCheckpointOptions,
  type ShareMemorySnapshotOptions,
  type ShareWorkspaceOptions,
} from './ShareManager.js';

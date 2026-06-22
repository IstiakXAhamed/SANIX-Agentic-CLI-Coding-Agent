/**
 * @file ShareManager.ts
 * @description Top-level façade for `@sanix/share`. The CLI (`sanix
 *   share …`), the TUI's share panel, and any third-party consumer go
 *   through this class. It:
 *
 *     1. Picks the right {@link ShareAdapter} for a request.
 *     2. Optionally encrypts the payload with AES-256-GCM
 *        ({@link Crypto.encrypt}) **before** handing it to the adapter
 *        — the adapter only ever sees opaque ciphertext.
 *     3. Uploads via the adapter.
 *     4. Writes a {@link ShareRecord} to the JSONL log
 *        (`~/.sanix/shares/log.jsonl`).
 *     5. Emits `share:*` events at every step.
 *
 *   ## Convenience methods
 *
 *   The spec calls out five "kind-aware" helpers:
 *
 *     - {@link shareFile}        — read a file from disk, detect MIME,
 *       share as `'file'`.
 *     - {@link shareSession}     — share a serialized agent session.
 *     - {@link shareCheckpoint}  — share a checkpoint file.
 *     - {@link shareMemorySnapshot} — share a serialized memory dump.
 *     - {@link shareWorkspace}   — tar.gz the workspace and share.
 *
 *   The session / checkpoint / memory-snapshot helpers are
 *   **callback-based**: the caller supplies a `serialize` function that
 *   returns the bytes. This keeps `@sanix/share` decoupled from
 *   `@sanix/core` (no runtime cycle, no version coupling).
 *
 *   ## Encryption flow
 *
 *   When `req.encrypt === true`:
 *     1. If `req.encryptionKey` is provided, use it; otherwise generate
 *        one with {@link generateKey}.
 *     2. Encrypt the (UTF-8 encoded) content with {@link encrypt}.
 *     3. Hand the ciphertext to the adapter (the adapter sees only
 *        opaque bytes — it can't decrypt and neither can the paste
 *        service operator).
 *     4. The encryption key is returned in `ShareResult.encryptionKey`
 *        **only** when the manager generated it. Caller-supplied keys
 *        are not echoed back. The key is NEVER written to the log.
 *
 *   ## Intended CLI surface (wired by the main agent)
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

import EventEmitter from 'eventemitter3';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';
import { encrypt, decrypt, generateKey } from './Crypto.js';
import { getAdapter } from './providers/index.js';
import { ShareLog, type ShareLogFilter } from './ShareLog.js';
import { WorkspaceBundler, type BundleOptions } from './WorkspaceBundler.js';
import { mimeFromFilename } from './_mime.js';
import { contentToBuffer } from './_util.js';
import {
  ShareError,
  type DownloadRequest,
  type DownloadResult,
  type ShareEvents,
  type ShareProvider,
  type ShareRecord,
  type ShareRequest,
  type ShareResult,
} from './types.js';

/** Options for {@link ShareManager}. */
export interface ShareManagerOptions {
  /** GitHub bearer token (forwarded to the gist adapter). */
  readonly githubToken?: string;
  /** Override path for the JSONL log file. */
  readonly logPath?: string;
  /** Override root dir for the file adapter (advanced; usually unnecessary). */
  readonly fileRootDir?: string;
  /** Custom fetch implementation (forwarded to adapters). */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout, in ms. Default: 30000. */
  readonly timeoutMs?: number;
  /** Inject a pre-built {@link WorkspaceBundler} (DI for tests). */
  readonly bundler?: WorkspaceBundler;
}

/** Options for {@link ShareManager.shareFile}. */
export type ShareFileOptions = Omit<ShareRequest, 'kind' | 'content'> & {
  /** Override the kind (default `'file'`). */
  readonly kind?: ShareRequest['kind'];
};

/** Options for {@link ShareManager.shareSession}. */
export type ShareSessionOptions = Omit<ShareRequest, 'kind' | 'content'> & {
  /** Callback that returns the serialized session bytes. */
  readonly serialize?: (sessionId: string) => Promise<string | Buffer>;
};

/** Options for {@link ShareManager.shareCheckpoint}. */
export type ShareCheckpointOptions = Omit<ShareRequest, 'kind' | 'content'> & {
  /** Callback that returns the serialized checkpoint bytes. */
  readonly serialize?: (checkpointId: string) => Promise<string | Buffer>;
};

/** Options for {@link ShareManager.shareMemorySnapshot}. */
export type ShareMemorySnapshotOptions = Omit<ShareRequest, 'kind' | 'content'> & {
  /** Callback that returns the serialized memory dump. */
  readonly serialize?: () => Promise<string | Buffer>;
};

/** Options for {@link ShareManager.shareWorkspace}. */
export type ShareWorkspaceOptions = Omit<ShareRequest, 'kind' | 'content'> & {
  /** Workspace root. Default: `process.cwd()`. */
  readonly rootPath?: string;
  /** Per-file size cap (MB). See {@link BundleOptions.maxSizeMb}. */
  readonly maxSizeMb?: number;
  /** Include gitignored files (always-ignored patterns still apply). */
  readonly includeGitignored?: boolean;
  /** Extra ignore patterns. */
  readonly extraIgnore?: readonly string[];
};

/** Default provider for kind-aware helpers when none is specified. */
const DEFAULT_PROVIDER: ShareProvider = '0x0';

/**
 * Top-level share façade. Construct one per process (or per CLI
 * invocation). The class extends `EventEmitter3<ShareEvents>` so
 * observers can subscribe to `share:*` events.
 *
 * @example
 * ```ts
 * const mgr = new ShareManager({ githubToken: process.env.GITHUB_TOKEN });
 *
 * // Share a file with end-to-end encryption (key auto-generated):
 * const r = await mgr.shareFile('./checkpoint.json', { provider: 'gist', encrypt: true });
 * console.log(r.url, r.encryptionKey); // <-- save the key!
 *
 * // Download + decrypt on another machine:
 * const dl = await mgr.download({ url: r.url, encryptionKey: r.encryptionKey, expectedKind: 'file' });
 * console.log(dl.content.toString('utf8'));
 * ```
 */
export class ShareManager extends EventEmitter<ShareEvents> {
  private readonly githubToken?: string;
  private readonly fileRootDir?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly bundler: WorkspaceBundler;
  private readonly log: ShareLog;

  /**
   * @param opts - See {@link ShareManagerOptions}.
   */
  public constructor(opts: ShareManagerOptions = {}) {
    super();
    this.githubToken = opts.githubToken ?? process.env.GITHUB_TOKEN;
    this.fileRootDir = opts.fileRootDir;
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.bundler = opts.bundler ?? new WorkspaceBundler();
    this.log = new ShareLog({ path: opts.logPath });
  }

  /**
   * Upload `req.content` to `req.provider` (optionally encrypting
   * first), record the share in the log, and return the
   * {@link ShareResult}.
   *
   * @param req - The share request.
   * @returns The share result.
   * @throws {ShareError} On any failure (missing token, too large,
   *   network error, etc.). A `share:failure` event is emitted before
   *   the throw.
   */
  public async share(req: ShareRequest): Promise<ShareResult> {
    this.emit('share:start', { request: req });

    const adapter = getAdapter(req.provider, {
      githubToken: this.githubToken,
      fileRootDir: this.fileRootDir,
      fetchImpl: this.fetchImpl,
    });
    if (!adapter) {
      const err = new ShareError(
        'SHARE_UNKNOWN_PROVIDER',
        `Unknown share provider "${req.provider}". Known: gist, paste-rs, 0x0, transfer-sh, file.`,
        req.provider,
      );
      this.emit('share:failure', { provider: req.provider, error: err.message });
      throw err;
    }

    // Validate size before any network call (cheap fail-fast).
    const rawBuf = contentToBuffer(req.content);
    if (adapter.maxBytes !== Number.POSITIVE_INFINITY && rawBuf.length > adapter.maxBytes) {
      const err = new ShareError(
        'SHARE_TOO_LARGE',
        `Payload is ${rawBuf.length} bytes; ${adapter.displayName} max is ${adapter.maxBytes} bytes.`,
        req.provider,
      );
      this.emit('share:failure', { provider: req.provider, error: err.message });
      throw err;
    }

    // Optionally encrypt. The adapter sees only opaque ciphertext.
    let uploadBuf = rawBuf;
    let encryptionKey: string | undefined;
    let encrypted = false;
    if (req.encrypt) {
      const userSuppliedKey = req.encryptionKey;
      encryptionKey = userSuppliedKey ?? generateKey();
      uploadBuf = encrypt(rawBuf, encryptionKey);
      encrypted = true;
      this.emit('share:encrypted', { algorithm: 'aes-256-gcm', keyLength: 32 });
    }

    // Build the upload request. The manager rewrites `content` to the
    // (possibly encrypted) buffer and clears `encrypt`/`encryptionKey`
    // so the adapter doesn't see them.
    const uploadReq: ShareRequest = {
      ...req,
      content: uploadBuf,
      encrypt: false,
      encryptionKey: undefined,
    };

    this.emit('share:uploading', { provider: req.provider, bytes: uploadBuf.length });

    let result: ShareResult;
    try {
      // The adapter returns a partial result (encrypted: false, no
      // encryptionKey). We override the encryption fields based on
      // what we did above.
      const adapterResult = await adapter.upload(uploadReq);
      result = {
        ...adapterResult,
        encrypted,
        encryptionKey: encrypted && !req.encryptionKey ? encryptionKey : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('share:failure', { provider: req.provider, error: message });
      throw err;
    }

    // Persist the share record (no encryption key — by design).
    const record: ShareRecord = {
      id: result.id,
      createdAt: result.createdAt,
      kind: result.kind,
      provider: result.provider,
      url: result.url,
      expiresAt: result.expiresAt,
      encrypted: result.encrypted,
      bytesShared: result.bytesShared,
      deleteUrl: result.deleteUrl,
      filename: req.filename,
      description: req.description,
    };
    try {
      await this.log.append(record);
    } catch (err) {
      // A log-write failure is non-fatal — the share itself succeeded.
      // Surface a warning but don't fail the call.
      // eslint-disable-next-line no-console
      console.warn(`[sanix-share] failed to persist share log: ${(err as Error).message}`);
    }

    this.emit('share:success', { result });
    return result;
  }

  /**
   * Download a previously-shared payload. If the URL matches a record
   * in the local log, the kind/metadata are read from there; otherwise
   * `expectedKind` (or `'file'`) is used and metadata is empty.
   *
   * If `req.encryptionKey` is provided, the downloaded bytes are
   * treated as ciphertext and decrypted via {@link decrypt}.
   *
   * @param req - See {@link DownloadRequest}.
   * @returns The decoded content + metadata.
   * @throws {ShareError} On download or decryption failure.
   */
  public async download(req: DownloadRequest): Promise<DownloadResult> {
    // Try to match the URL against a local share record (for kind /
    // metadata).
    const allRecords = await this.log.list();
    const match = allRecords.find((r) => r.url === req.url);

    const provider: ShareProvider = match?.provider ?? this.guessProviderFromUrl(req.url);
    const adapter = getAdapter(provider, {
      githubToken: this.githubToken,
      fileRootDir: this.fileRootDir,
      fetchImpl: this.fetchImpl,
    });
    if (!adapter) {
      throw new ShareError(
        'SHARE_UNKNOWN_PROVIDER',
        `Could not resolve a provider for URL ${req.url} (matched provider: ${provider}).`,
        provider,
      );
    }

    let buf = await adapter.download(req.url);
    let decrypted = false;
    if (req.encryptionKey) {
      buf = decrypt(buf, req.encryptionKey);
      decrypted = true;
    }

    const kind = match?.kind ?? req.expectedKind ?? 'file';
    const metadata: Record<string, unknown> = {};

    // Sanity-check the kind if both local and caller-provided exist.
    if (match?.kind && req.expectedKind && match.kind !== req.expectedKind) {
      // eslint-disable-next-line no-console
      console.warn(
        `[sanix-share] kind mismatch: log says "${match.kind}", caller expected "${req.expectedKind}". Returning log's kind.`,
      );
    }

    return {
      content: buf,
      kind,
      metadata,
      decrypted,
      sourceUrl: req.url,
    };
  }

  /**
   * List past shares from the log, most-recent first.
   *
   * @param filter - Optional {@link ShareLogFilter}.
   * @returns Array of share records.
   */
  public async list(filter: ShareLogFilter = {}): Promise<ShareRecord[]> {
    return this.log.list(filter);
  }

  /**
   * Revoke (delete) a previously-shared payload by its local id. Calls
   * `adapter.delete()` if the provider supports deletion. Also removes
   * the record from the local log.
   *
   * @param id - The local share id (from {@link ShareResult.id}).
   * @returns `true` if the remote share was deleted; `false` if the
   *   provider doesn't support deletion OR the local record wasn't
   *   found. The local log entry is always removed when present.
   * @throws {ShareError} If the adapter throws on delete.
   */
  public async revoke(id: string): Promise<boolean> {
    const rec = await this.log.get(id);
    if (!rec) return false;
    const adapter = getAdapter(rec.provider, {
      githubToken: this.githubToken,
      fileRootDir: this.fileRootDir,
      fetchImpl: this.fetchImpl,
    });
    let deleted = false;
    if (adapter?.delete && rec.deleteUrl) {
      try {
        // 0x0.st's delete needs both the URL and the key — encode them
        // together so the adapter can split.
        const deleteArg = rec.provider === '0x0' ? `${rec.url}|${rec.deleteUrl}` : rec.deleteUrl;
        await adapter.delete(deleteArg);
        deleted = true;
      } catch (err) {
        // If the remote is already gone (404), treat as deleted.
        if (err instanceof ShareError && err.code === 'SHARE_HTTP_ERROR' && /404/.test(err.message)) {
          deleted = true;
        } else {
          throw err;
        }
      }
    }
    await this.log.remove(id);
    return deleted;
  }

  /**
   * Convenience: read a file from disk, detect its MIME type, and
   * share it as kind `'file'`.
   *
   * @param filePath - Path to the file.
   * @param opts - Share options (provider, encrypt, etc.). `kind`
   *   defaults to `'file'` but can be overridden.
   * @returns The share result.
   *
   * @example
   * ```ts
   * await mgr.shareFile('./report.pdf', { provider: 'transfer-sh', expiration: '7d' });
   * ```
   */
  public async shareFile(filePath: string, opts: ShareFileOptions): Promise<ShareResult> {
    let content: Buffer;
    try {
      content = await fs.readFile(filePath);
    } catch (err) {
      throw new ShareError(
        'SHARE_FILE_READ_FAILED',
        `Could not read ${filePath}: ${(err as Error).message}`,
      );
    }
    const filename = opts.filename ?? path.basename(filePath);
    const mimeType = opts.mimeType ?? mimeFromFilename(filename);
    return this.share({
      kind: opts.kind ?? 'file',
      content,
      filename,
      mimeType,
      provider: opts.provider ?? DEFAULT_PROVIDER,
      expiration: opts.expiration,
      encrypt: opts.encrypt,
      encryptionKey: opts.encryptionKey,
      public: opts.public,
      description: opts.description,
      metadata: opts.metadata,
    });
  }

  /**
   * Share a serialized agent session. The `serialize` callback returns
   * the bytes — the manager does NOT import `@sanix/core` (no version
   * coupling, no runtime cycle).
   *
   * @param sessionId - The session id (passed through to `serialize`).
   * @param opts - Share options + `serialize` callback.
   * @returns The share result.
   *
   * @example
   * ```ts
   * await mgr.shareSession('my-run', {
   *   provider: 'gist',
   *   serialize: async (sid) => JSON.stringify(await checkpointManager.load(sid)),
   * });
   * ```
   */
  public async shareSession(
    sessionId: string,
    opts: ShareSessionOptions,
  ): Promise<ShareResult> {
    if (!opts.serialize) {
      throw new ShareError(
        'SHARE_NO_SERIALIZER',
        'shareSession requires a `serialize` callback that returns the session bytes.',
      );
    }
    const content = await opts.serialize(sessionId);
    return this.share({
      kind: 'session',
      content,
      filename: opts.filename ?? `sanix-session-${sessionId}.json`,
      mimeType: opts.mimeType ?? 'application/json',
      provider: opts.provider ?? DEFAULT_PROVIDER,
      expiration: opts.expiration,
      encrypt: opts.encrypt ?? true, // sessions default to encrypted
      encryptionKey: opts.encryptionKey,
      public: opts.public,
      description: opts.description ?? `SANIX session ${sessionId}`,
      metadata: { ...opts.metadata, sessionId },
    });
  }

  /**
   * Share a serialized checkpoint file.
   *
   * @param checkpointId - The checkpoint id (passed through to `serialize`).
   * @param opts - Share options + `serialize` callback.
   * @returns The share result.
   *
   * @example
   * ```ts
   * await mgr.shareCheckpoint('abc123', {
   *   provider: '0x0',
   *   expiration: '7d',
   *   serialize: async (cid) => {
   *     const cp = await checkpointManager.load(cid);
   *     return JSON.stringify(cp);
   *   },
   * });
   * ```
   */
  public async shareCheckpoint(
    checkpointId: string,
    opts: ShareCheckpointOptions,
  ): Promise<ShareResult> {
    if (!opts.serialize) {
      throw new ShareError(
        'SHARE_NO_SERIALIZER',
        'shareCheckpoint requires a `serialize` callback that returns the checkpoint bytes.',
      );
    }
    const content = await opts.serialize(checkpointId);
    return this.share({
      kind: 'checkpoint',
      content,
      filename: opts.filename ?? `sanix-checkpoint-${checkpointId}.json`,
      mimeType: opts.mimeType ?? 'application/json',
      provider: opts.provider ?? DEFAULT_PROVIDER,
      expiration: opts.expiration,
      encrypt: opts.encrypt ?? true, // checkpoints default to encrypted
      encryptionKey: opts.encryptionKey,
      public: opts.public,
      description: opts.description ?? `SANIX checkpoint ${checkpointId}`,
      metadata: { ...opts.metadata, checkpointId },
    });
  }

  /**
   * Share a serialized memory snapshot (all tiers: working / episodic /
   * semantic / procedural). Caller-provided `serialize` callback.
   *
   * @param opts - Share options + `serialize` callback.
   * @returns The share result.
   *
   * @example
   * ```ts
   * await mgr.shareMemorySnapshot({
   *   provider: 'transfer-sh',
   *   expiration: '30d',
   *   encrypt: true,
   *   serialize: async () => JSON.stringify({
   *     working: workingMemory.dump(),
   *     episodic: await episodicMemory.dump(),
   *     semantic: await semanticMemory.dump(),
   *     procedural: proceduralMemory.dump(),
   *   }),
   * });
   * ```
   */
  public async shareMemorySnapshot(
    opts: ShareMemorySnapshotOptions,
  ): Promise<ShareResult> {
    if (!opts.serialize) {
      throw new ShareError(
        'SHARE_NO_SERIALIZER',
        'shareMemorySnapshot requires a `serialize` callback that returns the memory dump bytes.',
      );
    }
    const content = await opts.serialize();
    return this.share({
      kind: 'memory-snapshot',
      content,
      filename: opts.filename ?? `sanix-memory-${Date.now()}.json`,
      mimeType: opts.mimeType ?? 'application/json',
      provider: opts.provider ?? DEFAULT_PROVIDER,
      expiration: opts.expiration,
      encrypt: opts.encrypt ?? true, // memory snapshots default to encrypted
      encryptionKey: opts.encryptionKey,
      public: opts.public,
      description: opts.description ?? 'SANIX memory snapshot',
      metadata: opts.metadata,
    });
  }

  /**
   * Bundle the workspace into a tar.gz (via {@link WorkspaceBundler}) and
   * share it as kind `'workspace'`.
   *
   * @param opts - Share options + workspace bundling options.
   * @returns The share result.
   *
   * @example
   * ```ts
   * await mgr.shareWorkspace({
   *   rootPath: process.cwd(),
   *   provider: 'transfer-sh',
   *   expiration: '1d',
   *   maxSizeMb: 5,
   * });
   * ```
   */
  public async shareWorkspace(opts: ShareWorkspaceOptions): Promise<ShareResult> {
    const rootPath = opts.rootPath ?? process.cwd();
    const tarball = await this.bundler.bundle(rootPath, {
      maxSizeMb: opts.maxSizeMb,
      includeGitignored: opts.includeGitignored,
      extraIgnore: opts.extraIgnore,
    });
    return this.share({
      kind: 'workspace',
      content: tarball,
      filename: opts.filename ?? 'sanix-workspace.tar.gz',
      mimeType: 'application/gzip',
      provider: opts.provider ?? DEFAULT_PROVIDER,
      expiration: opts.expiration,
      encrypt: opts.encrypt,
      encryptionKey: opts.encryptionKey,
      public: opts.public,
      description: opts.description ?? `SANIX workspace snapshot (${rootPath})`,
      metadata: { ...opts.metadata, rootPath, bundledAt: Date.now() },
    });
  }

  /**
   * Prune expired records from the local log. Does NOT call
   * `adapter.delete()` — that's {@link revoke}. Returns the count of
   * pruned records.
   */
  public async prune(): Promise<number> {
    return this.log.prune();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Best-effort provider guess from a URL's host. Used by `download()`
   * when the URL isn't in the local log (cross-machine download).
   * Throws `ShareError` if the host is unrecognized (the caller can
   * supply `expectedKind` for sanity-checking, but the provider is
   * intrinsic to the URL — there's no override).
   */
  private guessProviderFromUrl(url: string): ShareProvider {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (
        host === 'gist.githubusercontent.com' ||
        host === 'api.github.com' ||
        host.endsWith('github.com')
      ) {
        return 'gist';
      }
      if (host === 'paste.rs') return 'paste-rs';
      if (host === '0x0.st') return '0x0';
      if (host === 'transfer.sh' || host.endsWith('.transfer.sh')) return 'transfer-sh';
      if (u.protocol === 'file:') return 'file';
      throw new ShareError(
        'SHARE_UNKNOWN_PROVIDER',
        `Could not guess share provider from URL host "${host}". ` +
          `Use ShareManager.list() to find the local record first, or download via a known provider's adapter directly.`,
      );
    } catch (err) {
      if (err instanceof ShareError) throw err;
      if (url.startsWith('file://')) return 'file';
      throw new ShareError(
        'SHARE_UNKNOWN_PROVIDER',
        `Could not parse share URL "${url}": ${(err as Error).message}`,
      );
    }
  }
}

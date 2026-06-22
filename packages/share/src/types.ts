/**
 * @file types.ts
 * @description Public type contracts for `@sanix/share`. Every class, adapter,
 *   and event payload in this package is typed against the symbols defined
 *   here. The CLI (`sanix share ...`) and any third-party consumer import
 *   exclusively from `@sanix/share`'s barrel, which re-exports these types.
 *
 *   Nothing in this file imports runtime code — it's a pure type module so
 *   it can be safely consumed in `import type` positions without pulling
 *   `node:crypto` / `node:fs` into a browser bundle.
 *
 * @packageDocumentation
 */

// ─── Provider / kind / expiration enums ──────────────────────────────────────

/**
 * Identifier of a paste-service backend. `'file'` is a local-filesystem
 * fallback for air-gapped environments (no network egress).
 */
export type ShareProvider = 'gist' | 'paste-rs' | '0x0' | 'transfer-sh' | 'file';

/**
 * The semantic kind of payload being shared. The kind is recorded in the
 * share log and round-tripped via the `metadata` field on encrypted blobs
 * so a downloader can route the decoded bytes to the right consumer
 * (e.g. a `CheckpointManager.load` for `'checkpoint'`).
 */
export type ShareKind =
  | 'file'
  | 'session'
  | 'checkpoint'
  | 'memory-snapshot'
  | 'agent-result'
  | 'workspace';

/**
 * Coarse expiration buckets. The actual duration mapping is provider
 * specific (see each adapter's `supportsExpiration`).
 *
 *  - `'1h'`  → 1 hour
 *  - `'1d'`  → 24 hours
 *  - `'7d'`  → 7 days
 *  - `'30d'` → 30 days
 *  - `'never'` → no automatic expiry (provider permitting)
 */
export type Expiration = '1h' | '1d' | '7d' | '30d' | 'never';

// ─── Request / result ────────────────────────────────────────────────────────

/**
 * Request to upload a payload to a paste service.
 *
 * Notes:
 *  - `content` may be a `string` (UTF-8) or a raw `Buffer`. Strings are
 *    encoded as UTF-8 before any encryption / size check.
 *  - When `encrypt` is `true` and `encryptionKey` is omitted, the manager
 *    generates a 32-byte random key (base64url) and returns it in the
 *    {@link ShareResult.encryptionKey} field. The key is **never** written
 *    to disk; if the caller loses it the share is unrecoverable.
 *  - `public` only applies to the `gist` provider (secret vs public gist).
 *    Other providers are inherently public.
 */
export interface ShareRequest {
  /** Semantic kind of the payload. */
  kind: ShareKind;
  /** Payload — string (UTF-8) or binary buffer. */
  content: string | Buffer;
  /** Suggested filename. Some providers (gist, transfer.sh) use this in the URL. */
  filename?: string;
  /** MIME type hint (informational; providers may ignore). */
  mimeType?: string;
  /** Which paste service to upload to. */
  provider: ShareProvider;
  /** Expiration bucket. Ignored by providers that don't support it. */
  expiration?: Expiration;
  /** If `true`, the payload is AES-256-GCM encrypted before upload. */
  encrypt?: boolean;
  /** Caller-supplied encryption key. If absent and `encrypt=true`, one is generated. */
  encryptionKey?: string;
  /** For `gist`: `true` → public gist, `false`/omitted → secret gist. */
  public?: boolean;
  /** Human-readable description (gist description, transfer.sh header). */
  description?: string;
  /** Free-form caller metadata. Stored in the share log; never sent to the provider unless the payload is unencrypted and `kind` is encoded into a sidecar. */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a successful {@link ShareManager.share} call.
 *
 *  - `expiresAt` is an epoch-ms timestamp. `undefined` means the share
 *    either has no expiry or the provider doesn't expose one.
 *  - `encryptionKey` is present **only** when the caller let the manager
 *    generate the key (i.e. `encrypt=true` and no `encryptionKey` on the
 *    request). Callers that supply their own key do not get it echoed
 *    back.
 *  - `deleteUrl` is present only for providers that support deletion
 *    (`gist`, `0x0`, `transfer-sh`). For `gist` it's the gist id endpoint;
 *    for `0x0` it's the `X-Delete-Key`; for `transfer.sh` it's the
 *    `X-Url-Delete` URL.
 */
export interface ShareResult {
  /** Local share id (nanoid). Not the provider's id. */
  id: string;
  /** Public URL of the uploaded payload (raw URL for gist). */
  url: string;
  /** Provider that handled the upload. */
  provider: ShareProvider;
  /** Semantic kind that was shared. */
  kind: ShareKind;
  /** Epoch-ms expiry, or `undefined` for "never"/"unknown". */
  expiresAt?: number;
  /** Whether the payload was encrypted before upload. */
  encrypted: boolean;
  /** Generated encryption key (only when caller didn't supply one). */
  encryptionKey?: string;
  /** Provider-specific delete URL/key (only when supported). */
  deleteUrl?: string;
  /** Bytes uploaded (post-encryption size if encrypted). */
  bytesShared: number;
  /** Epoch-ms creation time. */
  createdAt: number;
}

// ─── Events ──────────────────────────────────────────────────────────────────

/**
 * Event map for {@link ShareManager} (extends `EventEmitter3<ShareEvents>`).
 * All payloads are plain objects so they JSON-serialize cleanly for the
 * TUI's event bus.
 */
export interface ShareEvents {
  /** Emitted before any provider call. */
  'share:start': { request: ShareRequest };
  /** Emitted once the upload begins (after optional encryption). */
  'share:uploading': { provider: ShareProvider; bytes: number };
  /** Emitted on a successful upload + log write. */
  'share:success': { result: ShareResult };
  /** Emitted on any upload failure. */
  'share:failure': { provider: ShareProvider; error: string };
  /** Emitted immediately after encryption succeeds. */
  'share:encrypted': { algorithm: string; keyLength: number };
}

// ─── Download ────────────────────────────────────────────────────────────────

/**
 * Request to download (and optionally decrypt) a previously-shared
 * payload. The `url` can be any provider URL returned by
 * {@link ShareManager.share}.
 *
 * - If the share was encrypted, `encryptionKey` **must** be supplied
 *   (the manager does not store keys).
 * - `expectedKind` is an optional sanity check: when the downloaded
 *   metadata's `kind` differs, a warning is emitted but the bytes are
 *   still returned.
 */
export interface DownloadRequest {
  /** URL returned by a previous share call. */
  url: string;
  /** Encryption key (only required if the share was encrypted). */
  encryptionKey?: string;
  /** Optional expected kind — used to sanity-check the round-trip. */
  expectedKind?: ShareKind;
}

/**
 * Result of {@link ShareManager.download}.
 *
 * `metadata` carries the original {@link ShareRequest.metadata} when the
 * share was made via this manager (encoded into a sidecar JSON for plain
 * shares, or into the AES-GCM associated-data for encrypted shares).
 */
export interface DownloadResult {
  /** Decoded payload. */
  content: Buffer;
  /** Kind of the payload (from metadata or `expectedKind`). */
  kind: ShareKind;
  /** Round-tripped caller metadata (empty if none was attached). */
  metadata: Record<string, unknown>;
  /** Whether the payload was decrypted on the way out. */
  decrypted: boolean;
  /** Source URL the bytes were fetched from. */
  sourceUrl: string;
}

// ─── Adapter contract ────────────────────────────────────────────────────────

/**
 * Provider-agnostic upload/download contract. Each paste-service adapter
 * implements this interface; the {@link ShareManager} dispatches to the
 * right adapter via {@link getAdapter}.
 *
 * Implementations **must**:
 *  - Honor `signal` (AbortSignal) on every network call.
 *  - Apply a sensible default timeout (see `_http.fetchWithTimeout`) when
 *    no signal is provided.
 *  - Return a {@link ShareResult} whose `id` is a fresh nanoid (the
 *    manager stamps it into the share log).
 *  - Throw a plain `Error` whose `message` is human-readable on any
 *    failure; the manager wraps it in a `share:failure` event.
 */
export interface ShareAdapter {
  /** Provider id (matches {@link ShareProvider}). */
  readonly id: ShareProvider;
  /** Human-readable name for the TUI / CLI status table. */
  readonly displayName: string;
  /** Hard upper bound on upload size, in bytes. */
  readonly maxBytes: number;
  /** Whether the provider supports per-share expiration. */
  readonly supportsExpiration: boolean;
  /** Whether the provider supports programmatic deletion. */
  readonly supportsDeletion: boolean;
  /** Upload `req.content` and return a {@link ShareResult}. */
  upload(req: ShareRequest, signal?: AbortSignal): Promise<ShareResult>;
  /** Download raw bytes from `url`. */
  download(url: string, signal?: AbortSignal): Promise<Buffer>;
  /** Delete a previously-uploaded share (optional — see `supportsDeletion`). */
  delete?(deleteUrl: string, signal?: AbortSignal): Promise<void>;
}

// ─── Share log record ────────────────────────────────────────────────────────

/**
 * One row in the append-only share log at `~/.sanix/shares/log.jsonl`.
 * Persisted by {@link ShareLog.append} and read back by
 * {@link ShareManager.list} / {@link ShareManager.revoke}.
 *
 * Note that `encryptionKey` is **never** stored here — only the boolean
 * `encrypted` flag. Losing the key means the share is unrecoverable, by
 * design.
 */
export interface ShareRecord {
  /** Local share id (matches {@link ShareResult.id}). */
  id: string;
  /** Epoch-ms creation time. */
  createdAt: number;
  /** Semantic kind. */
  kind: ShareKind;
  /** Provider that holds the share. */
  provider: ShareProvider;
  /** Public URL of the share. */
  url: string;
  /** Epoch-ms expiry, or `undefined` for "never". */
  expiresAt?: number;
  /** Whether the share was encrypted. */
  encrypted: boolean;
  /** Bytes uploaded. */
  bytesShared: number;
  /** Provider-specific delete URL/key (only when `supportsDeletion`). */
  deleteUrl?: string;
  /** Suggested filename (if provided). */
  filename?: string;
  /** Human-readable description (if provided). */
  description?: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Error thrown by `@sanix/share` for any user-visible failure. Carries a
 * `code` so the CLI can render provider-specific hints (e.g. "run
 * `sanix auth login github` for SHARE_NO_GITHUB_TOKEN").
 */
export class ShareError extends Error {
  /** Stable machine-readable code. */
  readonly code: string;
  /** Provider implicated (when applicable). */
  readonly provider?: ShareProvider;
  constructor(code: string, message: string, provider?: ShareProvider) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
    this.provider = provider;
  }
}

/**
 * @file providers/TransferShAdapter.ts
 * @description transfer.sh adapter. transfer.sh is a "easy file sharing
 *   from the command line" service:
 *
 *     PUT https://transfer.sh/<filename>
 *     [Max-Days: <n>]                (optional expiration header)
 *     [X-Url-Delete: true]           (request a delete URL back)
 *     <raw content>
 *     → 200 OK with body = "https://transfer.sh/<rand>/<filename>\n"
 *     → response header X-Url-Delete: <delete-url>     (when requested)
 *
 *   - **No auth.**
 *   - **Expiration**: `Max-Days` request header. The adapter maps the
 *     {@link Expiration} buckets to day counts (1h→1, 1d→1, 7d→7,
 *     30d→30). `'never'` omits the header.
 *   - **Deletion**: send `DELETE <delete-url>` (the URL returned in the
 *     `X-Url-Delete` response header). The adapter always requests the
 *     delete URL on upload so `revoke()` is always available.
 *   - **Max 10 GB** (operator-enforced). The adapter warns (console) at
 *     100 MB+ but still attempts the upload.
 *   - **Self-hostable**: the base URL can be overridden via the
 *     `TRANSFER_SH_BASE_URL` env var (for air-gapped / on-prem deploys).
 *
 *   Best for: large binary blobs (workspace tarballs, memory snapshots
 *   with embeddings) where 0x0.st's 512 MB cap is too tight.
 *
 * @packageDocumentation
 */

import { fetchWithTimeout, readBodyBuffer } from '../_http.js';
import { ShareError, type ShareAdapter, type ShareRequest, type ShareResult } from '../types.js';
import { contentToBuffer, defaultFilename, expirationToMs, newShareId } from '../_util.js';

/** transfer.sh hard cap (operator default). */
const TRANSFER_SH_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

/** Soft cap above which we warn (some providers fail silently). */
const LARGE_FILE_WARN_BYTES = 100 * 1024 * 1024; // 100 MB

/** Resolve the transfer.sh base URL (self-hostable override). */
function baseUrl(): string {
  const env = process.env.TRANSFER_SH_BASE_URL;
  if (env && env.length > 0) return env.replace(/\/+$/, '');
  return 'https://transfer.sh';
}

/** Map an {@link Expiration} to a `Max-Days` header value (days). */
function expirationToDays(req: ShareRequest): number | undefined {
  const ms = expirationToMs(req.expiration);
  if (ms === undefined) return undefined;
  return Math.max(1, Math.round(ms / 86_400_000));
}

/**
 * transfer.sh adapter.
 *
 * @example
 * ```ts
 * const a = new TransferShAdapter();
 * const r = await a.upload({
 *   kind: 'workspace',
 *   content: tarball,
 *   filename: 'ws.tar.gz',
 *   provider: 'transfer-sh',
 *   expiration: '7d',
 * });
 * console.log(r.url, r.deleteUrl);
 * ```
 */
export class TransferShAdapter implements ShareAdapter {
  public readonly id = 'transfer-sh' as const;
  public readonly displayName = 'transfer.sh';
  public readonly maxBytes = TRANSFER_SH_MAX_BYTES;
  public readonly supportsExpiration = true;
  public readonly supportsDeletion = true;

  /** @inheritdoc */
  public async upload(
    req: ShareRequest,
    signal?: AbortSignal,
  ): Promise<ShareResult> {
    const buf = contentToBuffer(req.content);
    if (buf.length > this.maxBytes) {
      throw new ShareError(
        'SHARE_TOO_LARGE',
        `transfer.sh upload is ${buf.length} bytes; max ~${this.maxBytes} bytes (10 GB).`,
        'transfer-sh',
      );
    }
    if (buf.length >= LARGE_FILE_WARN_BYTES) {
      // Some providers silently truncate / 500 on huge files. Surface a
      // warning to the operator so they're not surprised by a partial.
      // eslint-disable-next-line no-console
      console.warn(
        `[sanix-share] transfer.sh: uploading ${buf.length} bytes (>100 MB). ` +
          `Some providers fail silently on large files; verify the share after upload.`,
      );
    }
    const filename = req.filename ?? defaultFilename(req.kind);
    const url = `${baseUrl()}/${encodeURIComponent(filename)}`;

    const headers: Record<string, string> = {
      'Content-Type': req.mimeType ?? 'application/octet-stream',
      // Always request a delete URL so revoke() works.
      'X-Url-Delete': 'true',
    };
    if (req.description) headers['X-File-Description'] = req.description;
    const days = expirationToDays(req);
    if (days !== undefined) headers['Max-Days'] = String(days);

    const res = await fetchWithTimeout(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(buf),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ShareError(
        'SHARE_HTTP_ERROR',
        `transfer.sh upload failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        'transfer-sh',
      );
    }
    const text = (await res.text()).trim();
    if (!text.startsWith('http')) {
      throw new ShareError(
        'SHARE_PROVIDER_ERROR',
        `transfer.sh returned an unexpected response (expected URL): ${text.slice(0, 200)}`,
        'transfer-sh',
      );
    }
    const deleteUrl = res.headers.get('X-Url-Delete') ?? undefined;
    const expMs = expirationToMs(req.expiration);

    return {
      id: newShareId(),
      url: text,
      provider: 'transfer-sh',
      kind: req.kind,
      expiresAt: expMs ? Date.now() + expMs : undefined,
      encrypted: false,
      deleteUrl,
      bytesShared: buf.length,
      createdAt: Date.now(),
    };
  }

  /** @inheritdoc */
  public async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      signal,
    });
    return readBodyBuffer(res, url, 'transfer.sh');
  }

  /** @inheritdoc */
  public async delete(deleteUrl: string, signal?: AbortSignal): Promise<void> {
    // deleteUrl is the X-Url-Delete URL returned at upload time.
    const res = await fetchWithTimeout(deleteUrl, {
      method: 'DELETE',
      signal,
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      throw new ShareError(
        'SHARE_HTTP_ERROR',
        `transfer.sh delete failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        'transfer-sh',
      );
    }
  }
}

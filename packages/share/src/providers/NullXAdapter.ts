/**
 * @file providers/NullXAdapter.ts
 * @description 0x0.st adapter. 0x0.st is a "null pointer" file host:
 *
 *     POST https://0x0.st/
 *     Content-Type: multipart/form-data
 *     file=<content>
 *     [expires=<hours>]            (optional)
 *     → 200 OK with body = "https://0x0.st/<id>.<ext>\n"
 *     → response header X-Delete-Key: <key>     (save to delete later)
 *
 *   - **No auth.**
 *   - **Expiration**: `expires=<hours>` form field. The adapter maps the
 *     {@link Expiration} buckets to hour counts (1h→1, 1d→24, 7d→168,
 *     30d→720). `'never'` omits the field.
 *   - **Deletion**: send `DELETE <url>` with `X-Delete-Key: <key>`. The
 *     adapter stores the key (not a URL) as `deleteUrl` on the share
 *     record and reconstructs the DELETE request in `delete()`.
 *   - **Max ~512 MB** (operator-enforced; subject to change).
 *
 *   Best for: binary blobs that don't fit in a gist (e.g. workspace
 *   tarballs), with a predictable expiry.
 *
 * @packageDocumentation
 */

import { fetchWithTimeout, readBodyBuffer } from '../_http.js';
import { ShareError, type ShareAdapter, type ShareRequest, type ShareResult } from '../types.js';
import { contentToBuffer, defaultFilename, expirationToMs, newShareId } from '../_util.js';

/** 0x0.st informal size cap. */
const NULLX_MAX_BYTES = 512 * 1024 * 1024; // 512 MB

/** Map an {@link Expiration} to 0x0.st's `expires` form-field value (hours). */
function expirationToHours(req: ShareRequest): number | undefined {
  const ms = expirationToMs(req.expiration);
  if (ms === undefined) return undefined;
  return Math.max(1, Math.round(ms / 3_600_000));
}

/**
 * Build a minimal multipart/form-data body. We hand-roll it because
 * Node's `FormData` produces chunked encoding that 0x0.st occasionally
 * mishandles, and we want full control over the Content-Type boundary.
 */
function buildMultipart(
  filename: string,
  content: Buffer,
  fields: Record<string, string>,
): { body: Buffer; contentType: string } {
  const boundary = `sanix-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
  const parts: Buffer[] = [];
  const crlf = Buffer.from('\r\n');

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}${crlf.toString()}Content-Disposition: form-data; name="${name}"${crlf.toString()}${crlf.toString()}`,
      ),
    );
    parts.push(Buffer.from(value));
    parts.push(crlf);
  }

  // The `file` part — note the `filename=` qualifier.
  parts.push(
    Buffer.from(
      `--${boundary}${crlf.toString()}Content-Disposition: form-data; name="file"; filename="${filename.replace(
        /"/g,
        '',
      )}"${crlf.toString()}Content-Type: application/octet-stream${crlf.toString()}${crlf.toString()}`,
    ),
  );
  parts.push(content);
  parts.push(crlf);
  parts.push(Buffer.from(`--${boundary}--${crlf.toString()}`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * 0x0.st adapter.
 *
 * @example
 * ```ts
 * const a = new NullXAdapter();
 * const r = await a.upload({
 *   kind: 'workspace',
 *   content: tarball,
 *   filename: 'ws.tar.gz',
 *   provider: '0x0',
 *   expiration: '7d',
 * });
 * console.log(r.url, r.deleteUrl); // deleteUrl = X-Delete-Key value
 * ```
 */
export class NullXAdapter implements ShareAdapter {
  public readonly id = '0x0' as const;
  public readonly displayName = '0x0.st';
  public readonly maxBytes = NULLX_MAX_BYTES;
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
        `0x0.st upload is ${buf.length} bytes; max ~${this.maxBytes} bytes (512 MB).`,
        '0x0',
      );
    }
    const filename = req.filename ?? defaultFilename(req.kind);
    const fields: Record<string, string> = {};
    const hours = expirationToHours(req);
    if (hours !== undefined) fields.expires = String(hours);

    const { body, contentType } = buildMultipart(filename, buf, fields);

    const res = await fetchWithTimeout('https://0x0.st/', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ShareError(
        'SHARE_HTTP_ERROR',
        `0x0.st upload failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        '0x0',
      );
    }
    const text = (await res.text()).trim();
    if (!text.startsWith('http')) {
      throw new ShareError(
        'SHARE_PROVIDER_ERROR',
        `0x0.st returned an unexpected response (expected URL): ${text.slice(0, 200)}`,
        '0x0',
      );
    }
    // X-Delete-Key is the magic header — capture it for later revoke().
    const deleteKey = res.headers.get('X-Delete-Key') ?? undefined;
    const expMs = expirationToMs(req.expiration);

    return {
      id: newShareId(),
      url: text,
      provider: '0x0',
      kind: req.kind,
      expiresAt: expMs ? Date.now() + expMs : undefined,
      encrypted: false,
      deleteUrl: deleteKey,
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
    return readBodyBuffer(res, url, '0x0.st');
  }

  /** @inheritdoc */
  public async delete(deleteUrl: string, signal?: AbortSignal): Promise<void> {
    // 0x0.st's deletion protocol requires BOTH the file URL and the
    // X-Delete-Key. The adapter can't reconstruct the URL from the key
    // alone, so the manager encodes both as `<url>|<key>`. Direct
    // adapter callers who only have the key should instead use
    // `ShareManager.revoke()` (which has the URL in its log).
    if (!deleteUrl.includes('|')) {
      throw new ShareError(
        'SHARE_PROVIDER_ERROR',
        '0x0.st delete requires "<url>|<key>" (the manager encodes both via revoke()). ' +
          'Direct callers should pass the encoded form or use ShareManager.revoke().',
        '0x0',
      );
    }
    const [url, key] = deleteUrl.split('|', 2);

    const res = await fetchWithTimeout(url, {
      method: 'DELETE',
      headers: key ? { 'X-Delete-Key': key } : {},
      signal,
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      throw new ShareError(
        'SHARE_HTTP_ERROR',
        `0x0.st delete failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        '0x0',
      );
    }
  }
}

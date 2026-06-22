/**
 * @file providers/PasteRsAdapter.ts
 * @description paste.rs adapter. paste.rs is a minimal paste service:
 *
 *     POST https://paste.rs/
 *     Content-Type: text/plain (or multipart)
 *     <raw content>
 *     → 200 OK with body = "https://paste.rs/<id>"
 *
 *   - **No auth.** Anyone can upload; anyone with the URL can download.
 *   - **No expiration.** Pastes are permanent (until manually deleted by
 *     the paste.rs operator). The adapter reports `expiresAt: undefined`.
 *   - **No deletion API.** Once uploaded, a paste cannot be revoked by
 *     the client. The adapter reports `supportsDeletion: false`.
 *   - **Max ~10 MB** (informal limit enforced by the operator).
 *
 *   Best for: small text snippets, error logs, quick "show a teammate"
 *   shares where the absence of a delete button is acceptable.
 *
 * @packageDocumentation
 */

import { fetchWithTimeout, readBodyBuffer } from '../_http.js';
import { ShareError, type ShareAdapter, type ShareRequest, type ShareResult } from '../types.js';
import { contentToBuffer, newShareId } from '../_util.js';

/** paste.rs informal size cap. */
const PASTE_RS_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * paste.rs adapter.
 *
 * @example
 * ```ts
 * const a = new PasteRsAdapter();
 * const r = await a.upload({ kind: 'agent-result', content: JSON.stringify({...}), provider: 'paste-rs' });
 * console.log(r.url); // https://paste.rs/abc
 * ```
 */
export class PasteRsAdapter implements ShareAdapter {
  public readonly id = 'paste-rs' as const;
  public readonly displayName = 'paste.rs';
  public readonly maxBytes = PASTE_RS_MAX_BYTES;
  public readonly supportsExpiration = false;
  public readonly supportsDeletion = false;

  /** @inheritdoc */
  public async upload(
    req: ShareRequest,
    signal?: AbortSignal,
  ): Promise<ShareResult> {
    const buf = contentToBuffer(req.content);
    if (buf.length > this.maxBytes) {
      throw new ShareError(
        'SHARE_TOO_LARGE',
        `paste.rs paste is ${buf.length} bytes; max ~${this.maxBytes} bytes (10 MB).`,
        'paste-rs',
      );
    }
    const res = await fetchWithTimeout('https://paste.rs/', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: new Uint8Array(buf),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ShareError(
        'SHARE_HTTP_ERROR',
        `paste.rs upload failed: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        'paste-rs',
      );
    }
    // Response body is the URL, possibly with a trailing newline.
    const text = (await res.text()).trim();
    if (!text.startsWith('http')) {
      throw new ShareError(
        'SHARE_PROVIDER_ERROR',
        `paste.rs returned an unexpected response (expected URL): ${text.slice(0, 200)}`,
        'paste-rs',
      );
    }
    // paste.rs returns a URL ending in a random id. The request's
    // filename is informational only — paste.rs doesn't preserve it on
    // the server, so we don't append it to the returned URL (the raw
    // URL is what downloads work against).

    return {
      id: newShareId(),
      url: text,
      provider: 'paste-rs',
      kind: req.kind,
      encrypted: false,
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
    return readBodyBuffer(res, url, 'paste.rs');
  }
}

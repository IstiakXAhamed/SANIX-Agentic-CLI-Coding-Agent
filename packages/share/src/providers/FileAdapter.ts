/**
 * @file providers/FileAdapter.ts
 * @description Local-filesystem fallback adapter. Writes the payload to
 *   `~/.sanix/shares/<id>/<filename>` and returns a `file://` URL.
 *
 *   Use cases:
 *     - Air-gapped environments with no network egress.
 *     - Local-first workflows where the operator wants the share on disk
 *       (e.g. to drop into a mounted directory served by another tool).
 *     - Testing the share pipeline without burning real paste-service
 *       quota.
 *
 *   Behavior:
 *     - **No network**: `upload` is two `fs.writeFile` calls (one for
 *       the payload, one for a `<filename>.meta.json` sidecar carrying
 *       the kind + metadata).
 *     - **No expiration**: the file persists until `delete()` or manual
 *       `rm`. The adapter records `expiresAt: undefined`.
 *     - **Deletion**: `delete()` `rm -rf`s the per-share directory.
 *     - **Download**: parses `file://` URL, reads the payload file.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ShareError, type ShareAdapter, type ShareRequest, type ShareResult } from '../types.js';
import { contentToBuffer, defaultFilename, newShareId, sanixSharesDir } from '../_util.js';

/** Sidecar metadata file (next to the payload). */
const META_SUFFIX = '.meta.json';

/** Shape of the sidecar JSON. */
interface FileMeta {
  readonly kind: ShareRequest['kind'];
  readonly createdAt: number;
  readonly metadata: Record<string, unknown>;
}

/**
 * Local-filesystem adapter.
 *
 * @example
 * ```ts
 * const a = new FileAdapter();
 * const r = await a.upload({ kind: 'checkpoint', content: '{"..."}', provider: 'file' });
 * console.log(r.url); // file:///home/user/.sanix/shares/abc123/sanix-checkpoint.json
 * ```
 */
export class FileAdapter implements ShareAdapter {
  public readonly id = 'file' as const;
  public readonly displayName = 'Local file';
  public readonly maxBytes = Number.POSITIVE_INFINITY;
  public readonly supportsExpiration = false;
  public readonly supportsDeletion = true;

  private readonly rootDir: string;

  /**
   * @param opts - `{ rootDir?: string }`. Defaults to `~/.sanix/shares/`
   *   (honors `$SANIX_HOME`).
   */
  public constructor(opts: { rootDir?: string } = {}) {
    this.rootDir = opts.rootDir ?? sanixSharesDir();
  }

  /** @inheritdoc */
  public async upload(
    req: ShareRequest,
    _signal?: AbortSignal,
  ): Promise<ShareResult> {
    const buf = contentToBuffer(req.content);
    const id = newShareId();
    const dir = path.join(this.rootDir, id);
    await fs.mkdir(dir, { recursive: true });

    const filename = req.filename ?? defaultFilename(req.kind);
    const payloadPath = path.join(dir, filename);
    await fs.writeFile(payloadPath, buf);

    const meta: FileMeta = {
      kind: req.kind,
      createdAt: Date.now(),
      metadata: req.metadata ?? {},
    };
    await fs.writeFile(path.join(dir, filename + META_SUFFIX), JSON.stringify(meta), 'utf8');

    return {
      id,
      url: pathToFileURL(payloadPath).toString(),
      provider: 'file',
      kind: req.kind,
      // No expiration on local files.
      expiresAt: undefined,
      encrypted: false,
      // deleteUrl is the share directory (so delete() can rm -rf it).
      deleteUrl: dir,
      bytesShared: buf.length,
      createdAt: meta.createdAt,
    };
  }

  /** @inheritdoc */
  public async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    let filePath: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'file:') {
        throw new ShareError(
          'SHARE_PROVIDER_ERROR',
          `FileAdapter.download expected a file:// URL, got ${u.protocol}`,
          'file',
        );
      }
      filePath = u.pathname;
    } catch (err) {
      throw new ShareError(
        'SHARE_PROVIDER_ERROR',
        `FileAdapter.download could not parse URL ${url}: ${(err as Error).message}`,
        'file',
      );
    }
    try {
      // Node ≥18 supports passing an AbortSignal directly to fs.readFile.
      return await fs.readFile(filePath, { signal });
    } catch (err) {
      throw new ShareError(
        'SHARE_HTTP_ERROR',
        `FileAdapter.download could not read ${filePath}: ${(err as Error).message}`,
        'file',
      );
    }
  }

  /** @inheritdoc */
  public async delete(deleteUrl: string, _signal?: AbortSignal): Promise<void> {
    // deleteUrl is the per-share directory (set by upload()).
    try {
      await fs.rm(deleteUrl, { recursive: true, force: true });
    } catch (err) {
      throw new ShareError(
        'SHARE_HTTP_ERROR',
        `FileAdapter.delete could not remove ${deleteUrl}: ${(err as Error).message}`,
        'file',
      );
    }
  }
}

/**
 * @file ShareLog.ts
 * @description Append-only JSONL store of past shares, at
 *   `~/.sanix/shares/log.jsonl`. One {@link ShareRecord} per line.
 *
 *   Design notes:
 *     - **Append-only**: `append()` uses `O_APPEND` so concurrent writers
 *       (e.g. two CLI processes) don't clobber each other's lines.
 *     - **No indexes**: `list()` is a linear scan. The log is expected
 *       to stay small (hundreds of entries); a million-entry log would
 *       need an SQLite migration (see {@link https://github.com/sanix/sanix/issues|TODO}).
 *     - **`prune()` is non-destructive on remote shares**: it only
 *       removes expired records from the local log; it does NOT call
 *       `adapter.delete()`. The manager exposes `revoke()` for that.
 *     - **`encryptionKey` is never stored**: only the boolean
 *       `encrypted` flag is persisted, by design.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ShareError, type ShareKind, type ShareProvider, type ShareRecord } from './types.js';
import { sanixSharesDir } from './_util.js';

/** Filter options for {@link ShareLog.list}. */
export interface ShareLogFilter {
  /** Filter by provider. */
  readonly provider?: ShareProvider;
  /** Filter by kind. */
  readonly kind?: ShareKind;
  /** Only records created since this epoch-ms. */
  readonly since?: number;
  /** Only records created before this epoch-ms. */
  readonly until?: number;
  /** Only records still alive (i.e. no `expiresAt` or `expiresAt` > now). */
  readonly aliveOnly?: boolean;
  /** Cap on the number of records returned (most-recent first). */
  readonly limit?: number;
}

/**
 * Append-only JSONL share log.
 *
 * @example
 * ```ts
 * const log = new ShareLog();
 * await log.append({ id: 'abc', createdAt: Date.now(), kind: 'file', provider: 'gist', url: '...', encrypted: false, bytesShared: 42 });
 * const recent = await log.list({ limit: 10 });
 * await log.prune(); // drop expired records
 * ```
 */
export class ShareLog {
  /** Absolute path to the JSONL file. */
  private readonly logPath: string;

  /**
   * @param opts - `{ path?: string }`. Defaults to `~/.sanix/shares/log.jsonl`.
   */
  public constructor(opts: { path?: string } = {}) {
    this.logPath = opts.path ?? path.join(sanixSharesDir(), 'log.jsonl');
  }

  /** Absolute path to the JSONL file (exposed for tests / CLI inspection). */
  public get filePath(): string {
    return this.logPath;
  }

  /**
   * Append a record. Creates the parent directory on first call. Uses
   * `O_APPEND` so concurrent writers can't clobber each other.
   *
   * @param rec - The record to append.
   */
  public async append(rec: ShareRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    const line = JSON.stringify(rec) + '\n';
    // O_APPEND is atomic for writes ≤ PIPE_BUF on POSIX; JSONL lines are
    // small enough to qualify.
    const handle = await fs.open(this.logPath, 'a');
    try {
      await handle.writeFile(line, 'utf8');
    } finally {
      await handle.close();
    }
  }

  /**
   * List records, most-recent first, optionally filtered.
   *
   * @param filter - Optional {@link ShareLogFilter}.
   * @returns Array of records (defensive copies — caller can mutate).
   */
  public async list(filter: ShareLogFilter = {}): Promise<ShareRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(this.logPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const now = Date.now();
    const out: ShareRecord[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: ShareRecord;
      try {
        rec = JSON.parse(trimmed) as ShareRecord;
      } catch {
        // Skip malformed lines rather than failing the whole list.
        continue;
      }
      if (filter.provider && rec.provider !== filter.provider) continue;
      if (filter.kind && rec.kind !== filter.kind) continue;
      if (filter.since !== undefined && rec.createdAt < filter.since) continue;
      if (filter.until !== undefined && rec.createdAt > filter.until) continue;
      if (filter.aliveOnly && rec.expiresAt !== undefined && rec.expiresAt <= now) continue;
      out.push(rec);
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    if (filter.limit !== undefined && filter.limit > 0) {
      return out.slice(0, filter.limit);
    }
    return out;
  }

  /**
   * Look up a single record by id. Returns `null` if not found.
   *
   * @param id - The share id.
   */
  public async get(id: string): Promise<ShareRecord | null> {
    const all = await this.list();
    return all.find((r) => r.id === id) ?? null;
  }

  /**
   * Remove records whose `expiresAt` has passed. **Does NOT call
   * `adapter.delete()`** — the local log is just a record; revoking the
   * remote share is a separate, explicit operation via
   * {@link ShareManager.revoke}.
   *
   * Returns the count of pruned records. The prune is implemented as a
   * full rewrite of the JSONL file (read all, filter, write all) —
   * append-only structures can't delete in place.
   *
   * @returns Number of records removed.
   */
  public async prune(): Promise<number> {
    const all = await this.list();
    const now = Date.now();
    const keep = all.filter((r) => r.expiresAt === undefined || r.expiresAt > now);
    const pruned = all.length - keep.length;
    if (pruned === 0) return 0;
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    const text = keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '');
    await fs.writeFile(this.logPath, text, 'utf8');
    return pruned;
  }

  /**
   * Remove a single record by id (e.g. after a successful `revoke()`).
   * Same rewrite strategy as {@link prune}. Returns `true` if a record
   * was removed.
   *
   * @param id - The share id to remove from the log.
   */
  public async remove(id: string): Promise<boolean> {
    const all = await this.list();
    const keep = all.filter((r) => r.id !== id);
    if (keep.length === all.length) return false;
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    const text = keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '');
    await fs.writeFile(this.logPath, text, 'utf8');
    return true;
  }

  /**
   * Update a record in-place (e.g. to clear `deleteUrl` after a
   * successful revoke). Returns `true` if the record was found and
   * updated. Throws `SHARE_NOT_FOUND` if the id doesn't exist.
   *
   * @param id - The share id to update.
   * @param patch - Partial record to merge into the existing one.
   */
  public async update(
    id: string,
    patch: Partial<Omit<ShareRecord, 'id' | 'createdAt'>>,
  ): Promise<ShareRecord> {
    const all = await this.list();
    const idx = all.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new ShareError('SHARE_NOT_FOUND', `No share record with id ${id}.`);
    }
    const updated: ShareRecord = { ...all[idx], ...patch };
    all[idx] = updated;
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    const text = all.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await fs.writeFile(this.logPath, text, 'utf8');
    return updated;
  }
}

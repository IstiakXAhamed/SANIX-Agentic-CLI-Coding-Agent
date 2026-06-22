/**
 * @file utils.ts
 * @description Internal filesystem helpers shared by the isolation backends.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Artifact } from './types.js';

/**
 * Recursively list files (and directories) under `dir`, returning
 * {@link Artifact}-shaped records. Symlinks are skipped.
 */
export function listArtifactsSync(dir: string): Artifact[] {
  const out: Artifact[] = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (p: string): void => {
    let stat: fs.Stats;
    try { stat = fs.statSync(p); } catch { return; }
    if (stat.isDirectory()) {
      out.push({ path: p, bytes: 0, modifiedAt: stat.mtimeMs, isDirectory: true });
      let entries: string[] = [];
      try { entries = fs.readdirSync(p); } catch { return; }
      for (const e of entries) {
        if (e === '.' || e === '..') continue;
        walk(path.join(p, e));
      }
    } else {
      out.push({ path: p, bytes: stat.size, modifiedAt: stat.mtimeMs, isDirectory: false });
    }
  };
  walk(dir);
  return out;
}

/**
 * Read a file as a Buffer, returning an empty Buffer on missing-file errors
 * (rethrowing other errors).
 */
export async function readFileSyncSafe(filePath: string): Promise<Buffer> {
  try {
    return await fs.promises.readFile(filePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  }
}

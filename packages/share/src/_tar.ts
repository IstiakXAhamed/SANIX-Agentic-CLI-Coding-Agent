/**
 * @file _tar.ts
 * @description Minimal USTAR tar writer. We hand-roll it (instead of
 *   pulling in the `tar` npm package) to keep `@sanix/share`'s
 *   dependency surface down to the four packages the spec mandates
 *   (zod, nanoid, eventemitter3, ignore).
 *
 *   The writer produces a byte stream compatible with GNU tar / BSD tar
 *   / 7-zip — i.e. a standard `tar -xzf` will extract it. It only
 *   writes **regular files** (no symlinks, no directories-as-entries —
 *   tar infers directories from the `/` in file paths).
 *
 *   Limitations:
 *     - File path (relative) must be <= 255 chars (uses USTAR `prefix`
 *       split for paths between 100 and 255 chars). Longer paths are
 *       skipped with a warning.
 *     - File size must fit in 11 octal digits (~8 GB). The
 *       WorkspaceBundler enforces a per-file max that's well under this.
 *     - No GNU long-name extensions, no PAX headers. Sufficient for
 *       workspace snapshots where paths are short.
 *
 * @packageDocumentation
 */

import { createGzip, type Gzip } from 'node:zlib';
import { Buffer } from 'node:buffer';

/** One USTAR header is exactly 512 bytes. */
const BLOCK_SIZE = 512;

/** Two zero blocks mark end-of-archive. */
const EOF_BLOCKS = Buffer.alloc(BLOCK_SIZE * 2);

/**
 * Encode a numeric field as zero-padded octal, NUL-terminated. The
 * USTAR spec reserves the last byte of numeric fields for a NUL, so an
 * 8-byte field has 7 digits + NUL.
 */
function octal(value: number, width: number): Buffer {
  const s = value.toString(8).padStart(width - 1, '0');
  // Pad to `width` with a trailing NUL.
  return Buffer.from(s + '\0', 'ascii');
}

/** Encode a string field, NUL-padded to `width`. */
function str(value: string, width: number): Buffer {
  const b = Buffer.from(value, 'utf8');
  if (b.length >= width) return b.subarray(0, width - 1);
  const out = Buffer.alloc(width, 0);
  b.copy(out, 0);
  return out;
}

/**
 * Build a 512-byte USTAR header for a regular file.
 *
 * @param relPath - Relative path (forward slashes). <= 255 chars.
 * @param size    - File size in bytes.
 * @param mtime   - Modification time (epoch seconds). Default: now.
 * @param mode    - File mode (default 0o644).
 * @returns 512-byte header buffer, or `null` if `relPath` is too long.
 */
export function tarHeader(
  relPath: string,
  size: number,
  mtime: number = Math.floor(Date.now() / 1000),
  mode: number = 0o644,
): Buffer | null {
  // Split paths > 100 chars using the USTAR `prefix` field (max 155).
  // The split must land on a `/`. Scan candidate positions from the
  // highest index downward so the longest possible `name` is used
  // (keeps `prefix` short, reduces nested-dir ambiguity).
  let name = relPath;
  let prefix = '';
  if (relPath.length > 100) {
    let split = -1;
    for (let i = 155; i >= 1; i--) {
      if (relPath[i] === '/') {
        const pre = relPath.slice(0, i);
        const nm = relPath.slice(i + 1);
        if (pre.length <= 155 && nm.length > 0 && nm.length <= 100) {
          split = i;
          prefix = pre;
          name = nm;
          break;
        }
      }
    }
    if (split === -1) return null; // path too long to encode
  }

  const header = Buffer.alloc(BLOCK_SIZE, 0);
  // 0   100  name
  str(name, 100).copy(header, 0);
  // 100 8    mode
  octal(mode & 0o7777, 8).copy(header, 100);
  // 108 8    uid
  octal(0, 8).copy(header, 108);
  // 116 8    gid
  octal(0, 8).copy(header, 116);
  // 124 12   size
  octal(size, 12).copy(header, 124);
  // 136 12   mtime
  octal(mtime, 12).copy(header, 136);
  // 148 8    chksum — fill with spaces while computing
  Buffer.from('        ', 'ascii').copy(header, 148);
  // 156 1    typeflag — '0' = regular file
  header[156] = 0x30; // '0'
  // 157 100  linkname — empty
  // 257 6    magic
  Buffer.from('ustar\0', 'ascii').copy(header, 257);
  // 263 2    version
  Buffer.from('00', 'ascii').copy(header, 263);
  // 265 32   uname
  str('sanix', 32).copy(header, 265);
  // 297 32   gname
  str('sanix', 32).copy(header, 297);
  // 329 8    devmajor
  octal(0, 8).copy(header, 329);
  // 337 8    devminor
  octal(0, 8).copy(header, 337);
  // 345 155  prefix
  str(prefix, 155).copy(header, 345);
  // 500 12   padding (already zeroed)

  // Compute checksum: unsigned sum of all 512 bytes (with chksum field = spaces).
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  // Write octal checksum into bytes 148..155 (6 octal digits + NUL + space).
  const chk = octal(sum & 0o777777, 8);
  chk.copy(header, 148);
  header[154] = 0; // NUL
  header[155] = 0x20; // space

  return header;
}

/**
 * Pad a buffer to a multiple of {@link BLOCK_SIZE}. Returns the original
 * buffer if already aligned, otherwise a new buffer with zero padding.
 */
function padToBlock(buf: Buffer): Buffer {
  const rem = buf.length % BLOCK_SIZE;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK_SIZE - rem, 0)]);
}

/** A single file entry in the tar stream. */
export interface TarEntry {
  /** Relative path inside the archive (forward slashes). */
  readonly relPath: string;
  /** File content. */
  readonly content: Buffer;
  /** Modification time (epoch seconds). Default: now. */
  readonly mtime?: number;
  /** File mode (default 0o644). */
  readonly mode?: number;
}

/** Wait for a writable stream to drain if it returns false. */
async function drain(stream: Gzip): Promise<void> {
  await new Promise<void>((resolve) => {
    // 'drain' is emitted exactly once after a write() returned false.
    stream.once('drain', () => resolve());
  });
}

/**
 * Create a gzip-compressed tar.gz from a list of entries. Returns the
 * full archive as a single Buffer.
 *
 * @param entries - Files to include. Paths > 255 chars are skipped with
 *   a `console.warn` (the archive still succeeds).
 * @returns tar.gz buffer.
 *
 * @example
 * ```ts
 * const buf = await createTarGz([
 *   { relPath: 'README.md', content: Buffer.from('# hi\n') },
 *   { relPath: 'src/index.ts', content: Buffer.from('console.log(1)\n') },
 * ]);
 * await fs.writeFile('out.tar.gz', buf);
 * ```
 */
export async function createTarGz(entries: readonly TarEntry[]): Promise<Buffer> {
  const gz: Gzip = createGzip();
  const chunks: Buffer[] = [];

  gz.on('data', (data: Buffer) => {
    chunks.push(data);
  });

  for (const entry of entries) {
    const header = tarHeader(entry.relPath, entry.content.length, entry.mtime, entry.mode);
    if (!header) {
      // eslint-disable-next-line no-console
      console.warn(`[sanix-share] skipping tar entry with path too long (>255 chars): ${entry.relPath}`);
      continue;
    }
    if (!gz.write(header)) await drain(gz);
    if (!gz.write(padToBlock(entry.content))) await drain(gz);
  }
  // End-of-archive marker.
  gz.write(EOF_BLOCKS);
  gz.end();
  await new Promise<void>((resolve) => {
    gz.once('end', () => resolve());
  });

  return Buffer.concat(chunks);
}

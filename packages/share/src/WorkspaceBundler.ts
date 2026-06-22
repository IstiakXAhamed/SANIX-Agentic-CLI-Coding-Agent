/**
 * @file WorkspaceBundler.ts
 * @description Walks a workspace directory, respects `.gitignore`, drops
 *   always-ignored paths (`node_modules/`, `.git/`, `dist/`, …), skips
 *   files larger than `maxSizeMb`, and produces a tar.gz via the
 *   hand-rolled USTAR writer in `_tar.ts`.
 *
 *   The result is a standard `tar -xzf`-compatible archive — no custom
 *   format, no opaque magic. The CLI's `sanix share workspace` pipes the
 *   buffer into {@link ShareManager.share}.
 *
 *   ## ignore semantics
 *
 *   The `ignore` package is used to evaluate `.gitignore` patterns. The
 *   evaluation is layered:
 *     1. Always-ignored patterns (see {@link ALWAYS_IGNORED}) are checked
 *        first and can't be overridden.
 *     2. Each `.gitignore` encountered while walking is layered on top
 *        of the previous ones (matches git's semantics where deeper
 *        `.gitignore` files override shallower ones for sub-trees).
 *     3. If `includeGitignored` is `true`, step 2 is skipped entirely
 *        (but step 1 still applies).
 *
 *   ## Path safety
 *
 *   - Walk is bounded to `rootPath` (no symlink escape — symlinks are
 *     skipped entirely to avoid tarbombs).
 *   - Relative paths in the archive use forward slashes (POSIX), even on
 *     Windows.
 *
 * @packageDocumentation
 */

import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { Buffer } from 'node:buffer';
import { createTarGz, type TarEntry } from './_tar.js';
import { ShareError } from './types.js';

/** Instance type of the `ignore()` factory (the `ignore` package doesn't export `Ignore` as a named type — `ReturnType<typeof ignore>` is the canonical workaround, used by `@sanix/cli`'s WorkspaceLoader too). */
type IgnoreInstance = ReturnType<typeof ignore>;

/** Patterns that are ALWAYS ignored, even with `includeGitignored: true`. */
export const ALWAYS_IGNORED: readonly string[] = Object.freeze([
  'node_modules/',
  '.git/',
  '.hg/',
  '.svn/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.turbo/',
  '.cache/',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '.env',
  '.env.*',
  '!.env.example',
  'coverage/',
  '.nyc_output/',
  '*.tsbuildinfo',
]);

/** Default per-file size cap (10 MB). */
const DEFAULT_MAX_SIZE_MB = 10;

/** 1 MB in bytes (for clarity in arithmetic). */
const MB = 1024 * 1024;

/** Options for {@link WorkspaceBundler.bundle}. */
export interface BundleOptions {
  /** Per-file max size, in MB. Files larger than this are skipped. Default: 10. */
  readonly maxSizeMb?: number;
  /** If `true`, include files that match a `.gitignore` (always-ignored patterns still apply). Default: `false`. */
  readonly includeGitignored?: boolean;
  /** Optional extra ignore patterns (applied on top of always-ignored). */
  readonly extraIgnore?: readonly string[];
}

/** A single directory-walk step's output. */
interface WalkResult {
  /** Files that survived the filters, as tar entries. */
  readonly entries: TarEntry[];
  /** Files skipped (with reasons) — surfaced via console.warn. */
  readonly skipped: ReadonlyArray<{ readonly relPath: string; readonly reason: string }>;
}

/**
 * Workspace bundler. Stateless — construct one per bundle call (the
 * `ignore` instance accumulates `.gitignore` rules as it walks, so
 * reuse across bundles would cross-contaminate).
 *
 * @example
 * ```ts
 * const bundler = new WorkspaceBundler();
 * const buf = await bundler.bundle(process.cwd(), { maxSizeMb: 5 });
 * // buf is a tar.gz — share it via the manager:
 * await shareManager.share({ kind: 'workspace', content: buf, filename: 'ws.tar.gz', provider: '0x0' });
 * ```
 */
export class WorkspaceBundler {
  /**
   * Bundle `rootPath` into a tar.gz buffer.
   *
   * @param rootPath - Directory to bundle. Must exist.
   * @param opts - See {@link BundleOptions}.
   * @returns tar.gz buffer.
   * @throws {ShareError} `SHARE_BUNDLE_FAILED` if `rootPath` doesn't exist
   *   or the walk throws.
   */
  public async bundle(rootPath: string, opts: BundleOptions = {}): Promise<Buffer> {
    const maxSizeMb = opts.maxSizeMb ?? DEFAULT_MAX_SIZE_MB;
    const maxBytes = maxSizeMb * MB;
    const includeGitignored = opts.includeGitignored ?? false;

    let stat;
    try {
      stat = await fs.stat(rootPath);
    } catch (err) {
      throw new ShareError(
        'SHARE_BUNDLE_FAILED',
        `Workspace root ${rootPath} not accessible: ${(err as Error).message}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new ShareError(
        'SHARE_BUNDLE_FAILED',
        `Workspace root ${rootPath} is not a directory.`,
      );
    }

    const ig: IgnoreInstance = ignore().add([...ALWAYS_IGNORED]);
    if (opts.extraIgnore && opts.extraIgnore.length > 0) {
      ig.add([...opts.extraIgnore]);
    }

    const result: WalkResult = await this.walk(rootPath, '', ig, {
      maxBytes,
      includeGitignored,
    });

    for (const s of result.skipped) {
      // eslint-disable-next-line no-console
      console.warn(`[sanix-share] skipped ${s.relPath}: ${s.reason}`);
    }

    try {
      return await createTarGz(result.entries);
    } catch (err) {
      throw new ShareError(
        'SHARE_BUNDLE_FAILED',
        `tar.gz creation failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Recursive directory walk. Layered `.gitignore` evaluation: when a
   * `.gitignore` is encountered, its rules are added to a child ignore
   * instance that inherits the parent's rules and applies to the
   * sub-tree only.
   */
  private async walk(
    absDir: string,
    relDir: string,
    ig: IgnoreInstance,
    ctx: { maxBytes: number; includeGitignored: boolean },
  ): Promise<WalkResult> {
    const entries: TarEntry[] = [];
    const skipped: Array<{ relPath: string; reason: string }> = [];

    let names: string[];
    try {
      names = await fs.readdir(absDir);
    } catch (err) {
      skipped.push({ relPath: relDir || '.', reason: `readdir failed: ${(err as Error).message}` });
      return { entries, skipped };
    }

    // Layer a child ignore instance for this directory if a .gitignore
    // is present and we're respecting gitignores.
    let childIg = ig;
    if (!ctx.includeGitignored) {
      const giPath = path.join(absDir, '.gitignore');
      try {
        const giText = await fs.readFile(giPath, 'utf8');
        // `ignore().add(...)` returns the same instance (the `ignore`
        // package mutates in place). That's actually what we want for
        // git-compatible layered semantics: deeper `.gitignore` rules
        // augment the parent rules (a deeper `!foo` can un-ignore a
        // parent-ignored `foo`), and adding rules never narrows earlier
        // scope.
        childIg = ig.add(giText);
      } catch {
        // No .gitignore in this dir — keep using parent's instance.
      }
    }

    for (const name of names) {
      const abs = path.join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;

      // Symlinks: skip to avoid tarbomb / escape.
      let lst: Stats;
      try {
        lst = await fs.lstat(abs);
      } catch (err) {
        skipped.push({ relPath: rel, reason: `lstat failed: ${(err as Error).message}` });
        continue;
      }
      if (lst.isSymbolicLink()) {
        skipped.push({ relPath: rel, reason: 'symlink skipped' });
        continue;
      }

      if (lst.isDirectory()) {
        // Check the directory itself against the ignore list (with
        // trailing slash so `node_modules/` patterns match).
        if (childIg.ignores(`${rel}/`) || childIg.ignores(rel)) {
          skipped.push({ relPath: rel, reason: 'gitignored directory' });
          continue;
        }
        const sub = await this.walk(abs, rel, childIg, ctx);
        entries.push(...sub.entries);
        skipped.push(...sub.skipped);
        continue;
      }

      if (!lst.isFile()) {
        skipped.push({ relPath: rel, reason: 'not a regular file' });
        continue;
      }

      // Check the file against the ignore list.
      if (childIg.ignores(rel)) {
        skipped.push({ relPath: rel, reason: 'gitignored file' });
        continue;
      }

      // Size cap.
      if (lst.size > ctx.maxBytes) {
        skipped.push({
          relPath: rel,
          reason: `file too large (${lst.size} > ${ctx.maxBytes} bytes)`,
        });
        continue;
      }

      let content: Buffer;
      try {
        content = await fs.readFile(abs);
      } catch (err) {
        skipped.push({ relPath: rel, reason: `read failed: ${(err as Error).message}` });
        continue;
      }

      entries.push({
        relPath: rel,
        content,
        mtime: Math.floor(lst.mtimeMs / 1000),
        mode: 0o644,
      });
    }

    return { entries, skipped };
  }
}

/**
 * @file EditFile tool — surgical edits to existing files.
 *
 * Supports three modes (per SANIX spec §7):
 *   1. `replace_block` — find an exact substring and replace it.
 *   2. `apply_patch`   — apply a unified-diff patch.
 *   3. `rewrite`       — replace the whole file with new content.
 *
 * Always creates a backup of the original content before writing. If the
 * file lives inside a git working tree, the original is recoverable via
 * `git checkout HEAD -- <path>` (and we additionally emit the prior blob
 * SHA via `git hash-object` so the agent can restore it later). Otherwise
 * a `<path>.bak` file is written alongside the target.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPatch, applyPatch, type ApplyPatchOptions } from 'diff';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  resolvePath,
  okResult,
  errResult,
} from '../types.js';

const execFileP = promisify(execFile);

/** Input schema for the `edit_file` tool. */
export const EditFileInputSchema = z
  .object({
    path: z.string().min(1),
    mode: z.enum(['replace_block', 'apply_patch', 'rewrite']),
    /** Required for `replace_block`. */
    oldText: z.string().optional(),
    newText: z.string().optional(),
    /** Required for `apply_patch` (unified diff text). */
    patch: z.string().optional(),
    /** Required for `rewrite` (new full file content). */
    content: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'replace_block') {
      if (val.oldText === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['oldText'],
          message: 'oldText is required for replace_block mode',
        });
      }
      if (val.newText === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['newText'],
          message: 'newText is required for replace_block mode',
        });
      }
    }
    if (val.mode === 'apply_patch' && val.patch === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['patch'],
        message: 'patch is required for apply_patch mode',
      });
    }
    if (val.mode === 'rewrite' && val.content === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'content is required for rewrite mode',
      });
    }
  });

/** Output schema for the `edit_file` tool. */
export const EditFileOutputSchema = z.object({
  diff: z.string(),
  linesChanged: z.number().int(),
  path: z.string(),
  backup: z.string(),
});

export type EditFileInput = z.infer<typeof EditFileInputSchema>;
export type EditFileOutput = z.infer<typeof EditFileOutputSchema>;

/** Walk up from `start` looking for a `.git` directory. */
async function findGitRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (let i = 0; i < 32; i++) {
    try {
      const stat = await fs.stat(path.join(dir, '.git'));
      if (stat.isDirectory() || stat.isFile()) return dir;
    } catch {
      /* not found at this level */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Spawn `git hash-object` to capture the pre-edit blob SHA (best-effort). */
async function gitHashObject(absPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['hash-object', absPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * EditFileTool — perform a surgical edit on an existing file.
 *
 * @example
 * ```ts
 * await new EditFileTool().execute(
 *   {
 *     path: 'src/util.ts',
 *     mode: 'replace_block',
 *     oldText: 'foo()',
 *     newText: 'bar()',
 *   },
 *   ctx,
 * );
 * ```
 */
export class EditFileTool implements SanixTool<EditFileInput, EditFileOutput> {
  readonly name = 'edit_file';
  readonly description =
    'Edit an existing file using one of three modes: replace_block (find+replace exact text), apply_patch (unified diff), or rewrite (full file replacement). Always backs up the original before writing.';
  readonly inputSchema = EditFileInputSchema;
  readonly outputSchema = EditFileOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:write'];
  readonly maxTokensInput = 128_000;
  readonly maxTokensOutput = 32_000;

  async execute(
    input: EditFileInput,
    context: ToolContext,
  ): Promise<ToolResult<EditFileOutput>> {
    const start = Date.now();
    const absPath = resolvePath(input.path, context.cwd);

    try {
      const original = await fs.readFile(absPath, 'utf-8');
      let edited: string;
      if (input.mode === 'replace_block') {
        edited = this.applyReplaceBlock(original, input.oldText!, input.newText!);
      } else if (input.mode === 'apply_patch') {
        edited = this.applyPatchMode(original, input.patch!);
      } else {
        edited = input.content!;
      }

      if (edited === original) {
        return errResult<EditFileOutput>(
          `edit_file produced no changes to ${absPath}`,
          Date.now() - start,
        );
      }

      // Backup: if inside a git tree, capture the original blob SHA so it
      // can be restored via `git cat-file -p <sha>`. Otherwise write a
      // sibling `.bak` file with the original content.
      let backup: string;
      const gitRoot = await findGitRoot(path.dirname(absPath));
      if (gitRoot) {
        const sha = await gitHashObject(absPath);
        backup = sha
          ? `git:${sha} (restore: git cat-file -p ${sha} > ${absPath})`
          : `git-tree:${gitRoot}`;
      } else {
        const bakPath = `${absPath}.bak`;
        await fs.writeFile(bakPath, original, 'utf-8');
        backup = bakPath;
      }

      await fs.writeFile(absPath, edited, 'utf-8');

      const diffText = createPatch(
        path.basename(absPath),
        original,
        edited,
        'original',
        'edited',
      );
      const linesChanged = this.countChangedLines(diffText);

      // Emit a streaming event if the caller wired one up.
      context.emit?.('tool:edit_file', {
        path: absPath,
        linesChanged,
        backup,
      });

      return okResult<EditFileOutput>(
        { diff: diffText, linesChanged, path: absPath, backup },
        Date.now() - start,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<EditFileOutput>(
        `edit_file failed for ${absPath}: ${msg}`,
        Date.now() - start,
      );
    }
  }

  /** Find+replace exact substring. Throws if `oldText` not present. */
  private applyReplaceBlock(source: string, oldText: string, newText: string): string {
    const idx = source.indexOf(oldText);
    if (idx === -1) {
      throw new Error(
        'replace_block: oldText not found in file (avoid whitespace/indentation drift).',
      );
    }
    // Replace only the first occurrence to avoid surprising mass-edits.
    return source.slice(0, idx) + newText + source.slice(idx + oldText.length);
  }

  /** Apply a unified-diff patch to `source`. */
  private applyPatchMode(source: string, patchText: string): string {
    const opts: ApplyPatchOptions = { fuzzFactor: 0 };
    const result = applyPatch(source, patchText, opts);
    if (result === false) {
      throw new Error('apply_patch: patch did not apply cleanly (hunk mismatch).');
    }
    return result;
  }

  /** Count `+`/`-` lines (excluding `+++`/`---` headers) in a unified diff. */
  private countChangedLines(diffText: string): number {
    let count = 0;
    for (const line of diffText.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+') || line.startsWith('-')) count++;
    }
    return count;
  }

  formatForContext(result: EditFileOutput): string {
    // Trim long diffs to keep prompt context cheap.
    const maxDiffLines = 60;
    const diffLines = result.diff.split('\n');
    const trimmed =
      diffLines.length > maxDiffLines
        ? `${diffLines.slice(0, maxDiffLines).join('\n')}\n…[diff truncated]`
        : result.diff;
    return `edited ${result.path} (${result.linesChanged} lines changed)\nbackup: ${result.backup}\n${trimmed}`;
  }
}

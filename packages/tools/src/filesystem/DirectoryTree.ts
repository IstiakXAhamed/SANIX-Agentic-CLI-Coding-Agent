/**
 * @file DirectoryTree tool — lists directory entries, optionally recursive
 * up to `depth` levels and optionally respecting `.gitignore`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
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

/** Input schema for the `list_directory` tool. */
export const DirectoryTreeInputSchema = z.object({
  path: z.string().min(1),
  depth: z.number().int().positive().default(1),
  respectGitignore: z.boolean().default(true),
});

/** Output schema for the `list_directory` tool. */
export const DirectoryTreeOutputSchema = z.object({
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(['file', 'dir']),
      size: z.number().int().optional(),
    }),
  ),
});

export type DirectoryTreeInput = z.infer<typeof DirectoryTreeInputSchema>;
export type DirectoryTreeOutput = z.infer<typeof DirectoryTreeOutputSchema>;

interface Entry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

/**
 * DirectoryTreeTool — list a directory (optionally recursively).
 *
 * @example
 * ```ts
 * const res = await new DirectoryTreeTool().execute(
 *   { path: '.', depth: 3 },
 *   ctx,
 * );
 * ```
 */
export class DirectoryTreeTool
  implements SanixTool<DirectoryTreeInput, DirectoryTreeOutput>
{
  readonly name = 'list_directory';
  readonly description =
    'List entries in a directory, optionally recursive up to `depth` levels. Respects .gitignore by default.';
  readonly inputSchema = DirectoryTreeInputSchema;
  readonly outputSchema = DirectoryTreeOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:read'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 16_000;

  async execute(
    input: DirectoryTreeInput,
    context: ToolContext,
  ): Promise<ToolResult<DirectoryTreeOutput>> {
    const start = Date.now();
    const root = resolvePath(input.path, context.cwd);

    const ig = ignore();
    if (input.respectGitignore) {
      try {
        ig.add(await fs.readFile(path.join(root, '.gitignore'), 'utf-8'));
      } catch {
        /* no gitignore */
      }
    }

    try {
      const entries: Entry[] = [];
      await this.walk(root, root, input.depth, ig, entries, input.respectGitignore);
      return okResult<DirectoryTreeOutput>({ entries }, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<DirectoryTreeOutput>(
        `list_directory failed for ${root}: ${msg}`,
        Date.now() - start,
      );
    }
  }

  private async walk(
    dirAbs: string,
    root: string,
    depth: number,
    ig: ReturnType<typeof ignore>,
    out: Entry[],
    respectGitignore: boolean,
  ): Promise<void> {
    if (depth < 1) return;
    let names: string[];
    try {
      names = await fs.readdir(dirAbs);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name) && depth > 1) continue;
      const abs = path.join(dirAbs, name);
      const rel = path.relative(root, abs);
      if (respectGitignore && ig.ignores(rel)) continue;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        out.push({ name, path: abs, type: 'dir' });
        await this.walk(abs, root, depth - 1, ig, out, respectGitignore);
      } else if (stat.isFile()) {
        out.push({ name, path: abs, type: 'file', size: stat.size });
      }
    }
  }

  formatForContext(result: DirectoryTreeOutput): string {
    const lines = result.entries.slice(0, 200).map((e) => {
      const tag = e.type === 'dir' ? '📁' : '📄';
      const sizeStr = e.size !== undefined ? ` (${formatBytes(e.size)})` : '';
      return `${tag} ${e.path}${sizeStr}`;
    });
    const tail =
      result.entries.length > 200 ? `\n…+${result.entries.length - 200} more` : '';
    return `${lines.join('\n')}${tail}`;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

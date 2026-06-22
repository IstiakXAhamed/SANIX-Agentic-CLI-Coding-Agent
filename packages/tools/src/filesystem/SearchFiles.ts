/**
 * @file SearchFiles tool — content search across files using simple regex.
 * Uses `glob` to enumerate files matching a glob, then scans each file's
 * content for matches.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
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

/** Input schema for the `search_files` tool. */
export const SearchFilesInputSchema = z.object({
  pattern: z.string().min(1).describe('Substring or regex to search for.'),
  path: z.string().min(1).describe('Directory or file to search within.'),
  isRegex: z.boolean().default(false).describe('Treat `pattern` as a regex.'),
  maxResults: z.number().int().positive().default(200),
  fileGlob: z
    .string()
    .default('**/*')
    .describe('Glob pattern limiting which files to scan (default "**/*").'),
});

/** Output schema for the `search_files` tool. */
export const SearchFilesOutputSchema = z.object({
  matches: z.array(
    z.object({
      file: z.string(),
      line: z.number().int(),
      column: z.number().int(),
      preview: z.string(),
    }),
  ),
});

export type SearchFilesInput = z.infer<typeof SearchFilesInputSchema>;
export type SearchFilesOutput = z.infer<typeof SearchFilesOutputSchema>;

interface MatchRow {
  file: string;
  line: number;
  column: number;
  preview: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than 2MB
const PREVIEW_RADIUS = 40;

/**
 * SearchFilesTool — ripgrep-style content search across a directory tree.
 *
 * @example
 * ```ts
 * const res = await new SearchFilesTool().execute(
 *   { pattern: 'TODO', path: 'src', fileGlob: 'double-star-slash-ts' },
 *   ctx,
 * );
 * ```
 */
export class SearchFilesTool implements SanixTool<SearchFilesInput, SearchFilesOutput> {
  readonly name = 'search_files';
  readonly description =
    'Search file contents across a directory tree. Returns file:line:column matches with previews. Respects .gitignore by default.';
  readonly inputSchema = SearchFilesInputSchema;
  readonly outputSchema = SearchFilesOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:read'];
  readonly maxTokensInput = 512;
  readonly maxTokensOutput = 16_000;

  async execute(
    input: SearchFilesInput,
    context: ToolContext,
  ): Promise<ToolResult<SearchFilesOutput>> {
    const start = Date.now();
    const root = resolvePath(input.path, context.cwd);
    const ig = ignore();

    // Load .gitignore if present at root.
    try {
      const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf-8');
      ig.add(gitignore);
    } catch {
      /* no gitignore — that's fine */
    }

    let regex: RegExp;
    try {
      regex = input.isRegex
        ? new RegExp(input.pattern, 'u')
        : new RegExp(escapeRegex(input.pattern), 'u');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<SearchFilesOutput>(`invalid pattern: ${msg}`, Date.now() - start);
    }

    const matches: MatchRow[] = [];
    try {
      const files = await glob(input.fileGlob, {
        cwd: root,
        nodir: true,
        dot: false,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });

      for (const absFile of files) {
        if (matches.length >= input.maxResults) break;
        const rel = path.relative(root, absFile);
        if (ig.ignores(rel)) continue;
        try {
          const stat = await fs.stat(absFile);
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = await fs.readFile(absFile, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= input.maxResults) break;
            const line = lines[i];
            const m = regex.exec(line);
            if (m) {
              const col = m.index + 1;
              const startIdx = Math.max(0, m.index - PREVIEW_RADIUS);
              const endIdx = Math.min(line.length, m.index + m[0].length + PREVIEW_RADIUS);
              const preview =
                (startIdx > 0 ? '…' : '') +
                line.slice(startIdx, endIdx) +
                (endIdx < line.length ? '…' : '');
              matches.push({ file: absFile, line: i + 1, column: col, preview });
            }
          }
        } catch {
          // skip unreadable file
        }
      }

      return okResult<SearchFilesOutput>({ matches }, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<SearchFilesOutput>(
        `search_files failed: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: SearchFilesOutput): string {
    if (result.matches.length === 0) return 'no matches';
    const head = result.matches.slice(0, 50);
    const lines = head.map(
      (m) => `${m.file}:${m.line}:${m.column}  ${m.preview.trim()}`,
    );
    const tail =
      result.matches.length > 50 ? `\n…+${result.matches.length - 50} more` : '';
    return `${lines.join('\n')}${tail}`;
  }
}

/** Escape a literal string for use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

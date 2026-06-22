/**
 * @file CodeIndexer — walk a repo, run analyze_ast on each supported file,
 * return an aggregate count. In-memory only — no persistence here.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
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
import { analyzeContent, detectLanguage, type Language } from './ASTAnalyzer.js';

/** Input schema for `index_codebase`. */
export const IndexCodebaseInputSchema = z.object({
  rootPath: z.string().min(1),
  fileGlobs: z
    .array(z.string())
    .default(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.py']),
});

/** Output schema for `index_codebase`. */
export const IndexCodebaseOutputSchema = z.object({
  indexed: z.number().int(),
  symbols: z.number().int(),
  durationMs: z.number().int(),
});

export type IndexCodebaseInput = z.infer<typeof IndexCodebaseInputSchema>;
export type IndexCodebaseOutput = z.infer<typeof IndexCodebaseOutputSchema>;

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_FILES = 5_000;

/**
 * CodeIndexerTool — walk a repo and count symbols.
 *
 * @example
 * ```ts
 * const res = await new CodeIndexerTool().execute(
 *   { rootPath: 'packages/tools' },
 *   ctx,
 * );
 * ```
 */
export class CodeIndexerTool
  implements SanixTool<IndexCodebaseInput, IndexCodebaseOutput>
{
  readonly name = 'index_codebase';
  readonly description =
    'Walk a repository, extract symbols from every supported source file, and return an aggregate count. In-memory only (no persistence).';
  readonly inputSchema = IndexCodebaseInputSchema;
  readonly outputSchema = IndexCodebaseOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:read'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 256;

  async execute(
    input: IndexCodebaseInput,
    context: ToolContext,
  ): Promise<ToolResult<IndexCodebaseOutput>> {
    const start = Date.now();
    const root = resolvePath(input.rootPath, context.cwd);
    try {
      const files = await glob(input.fileGlobs, {
        cwd: root,
        nodir: true,
        absolute: true,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      });

      let indexed = 0;
      let symbols = 0;
      const capped = files.slice(0, MAX_FILES);

      for (const absFile of capped) {
        try {
          const stat = await fs.stat(absFile);
          if (stat.size > MAX_FILE_BYTES) continue;
          const lang: Language | null = detectLanguage(absFile);
          if (!lang) continue;
          const content = await fs.readFile(absFile, 'utf-8');
          const syms = analyzeContent(content, lang);
          indexed++;
          symbols += syms.length;
        } catch {
          // skip unreadable
        }
      }

      return okResult<IndexCodebaseOutput>(
        { indexed, symbols, durationMs: Date.now() - start },
        Date.now() - start,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<IndexCodebaseOutput>(
        `index_codebase failed: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: IndexCodebaseOutput): string {
    return `indexed ${result.indexed} files, found ${result.symbols} symbols (${result.durationMs}ms)`;
  }
}

/**
 * @file ReadFile tool — reads file contents with optional line ranges and
 * byte caps. Explicitly does NOT respect gitignore (the caller asked for
 * a specific path).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
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

/** Input schema for the `read_file` tool. */
export const ReadFileInputSchema = z.object({
  path: z.string().min(1).describe('Absolute or cwd-relative file path.'),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-indexed first line to read (inclusive).'),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-indexed last line to read (inclusive).'),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Hard cap on bytes read; remaining content is truncated.'),
});

/** Output schema for the `read_file` tool. */
export const ReadFileOutputSchema = z.object({
  content: z.string(),
  lines: z.number().int(),
  bytes: z.number().int(),
  truncated: z.boolean(),
});

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;
export type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;

/**
 * ReadFileTool — reads a file from disk and returns its contents.
 *
 * @example
 * ```ts
 * const tool = new ReadFileTool();
 * const res = await tool.execute({ path: 'src/index.ts' }, ctx);
 * console.log(res.output?.content);
 * ```
 */
export class ReadFileTool implements SanixTool<ReadFileInput, ReadFileOutput> {
  readonly name = 'read_file';
  readonly description =
    'Read a file from disk and return its contents. Supports optional line ranges and a byte cap. Does not respect gitignore.';
  readonly inputSchema = ReadFileInputSchema;
  readonly outputSchema = ReadFileOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:read'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 32_000;

  async execute(
    input: ReadFileInput,
    context: ToolContext,
  ): Promise<ToolResult<ReadFileOutput>> {
    const start = Date.now();
    const absPath = resolvePath(input.path, context.cwd);
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) {
        return errResult<ReadFileOutput>(
          `Path is not a regular file: ${absPath}`,
          Date.now() - start,
        );
      }
      const raw = await fs.readFile(absPath, 'utf-8');
      let content = raw;

      // Apply line-range slice if requested.
      if (input.startLine !== undefined || input.endLine !== undefined) {
        const allLines = content.split('\n');
        const startIdx = (input.startLine ?? 1) - 1;
        const endIdx = input.endLine ?? allLines.length;
        const sliced = allLines.slice(
          Math.max(0, startIdx),
          Math.min(allLines.length, endIdx),
        );
        content = sliced.join('\n');
      }

      let truncated = false;
      if (input.maxBytes !== undefined && content.length > input.maxBytes) {
        content = content.slice(0, input.maxBytes);
        truncated = true;
      }

      const lines = content === '' ? 0 : content.split('\n').length;
      const out: ReadFileOutput = {
        content,
        lines,
        bytes: Buffer.byteLength(content, 'utf-8'),
        truncated,
      };
      return okResult(out, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<ReadFileOutput>(
        `read_file failed for ${path.basename(absPath)}: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: ReadFileOutput): string {
    // Render as `path:line content` blocks; caller doesn't know the path
    // here, so we emit the line numbers only.
    const lines = result.content.split('\n');
    const rendered = lines
      .map((ln, i) => `${i + 1}: ${ln}`)
      .join('\n');
    const tail = result.truncated ? '\n…[truncated]' : '';
    return `${rendered}${tail}\n(${result.lines} lines, ${result.bytes} bytes)`;
  }
}

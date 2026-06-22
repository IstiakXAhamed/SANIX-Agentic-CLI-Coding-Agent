/**
 * @file WriteFile tool — writes content to a file, optionally creating
 * intermediate directories. Permission: `filesystem:write`.
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

/** Input schema for the `write_file` tool. */
export const WriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirs: z
    .boolean()
    .default(true)
    .describe('Create parent directories if missing (default true).'),
});

/** Output schema for the `write_file` tool. */
export const WriteFileOutputSchema = z.object({
  bytesWritten: z.number().int(),
  path: z.string(),
});

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;
export type WriteFileOutput = z.infer<typeof WriteFileOutputSchema>;

/**
 * WriteFileTool — writes a string to disk, replacing any existing file.
 *
 * @example
 * ```ts
 * await new WriteFileTool().execute(
 *   { path: 'tmp/log.txt', content: 'hello' },
 *   ctx,
 * );
 * ```
 */
export class WriteFileTool implements SanixTool<WriteFileInput, WriteFileOutput> {
  readonly name = 'write_file';
  readonly description =
    'Write content to a file (overwriting). Parent directories are created by default.';
  readonly inputSchema = WriteFileInputSchema;
  readonly outputSchema = WriteFileOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:write'];
  readonly maxTokensInput = 64_000;
  readonly maxTokensOutput = 256;

  async execute(
    input: WriteFileInput,
    context: ToolContext,
  ): Promise<ToolResult<WriteFileOutput>> {
    const start = Date.now();
    const absPath = resolvePath(input.path, context.cwd);

    try {
      if (input.createDirs) {
        await fs.mkdir(path.dirname(absPath), { recursive: true });
      }
      await fs.writeFile(absPath, input.content, 'utf-8');
      const bytesWritten = Buffer.byteLength(input.content, 'utf-8');
      return okResult<WriteFileOutput>(
        { bytesWritten, path: absPath },
        Date.now() - start,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<WriteFileOutput>(
        `write_file failed for ${absPath}: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: WriteFileOutput): string {
    return `wrote ${result.bytesWritten} bytes → ${result.path}`;
  }
}

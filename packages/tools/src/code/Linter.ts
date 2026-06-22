/**
 * @file Linter — run ESLint or Ruff on a file/directory and parse the output.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const execFileP = promisify(execFile);

/** Input schema for `run_linter`. */
export const RunLinterInputSchema = z.object({
  path: z.string().min(1),
  linter: z.enum(['eslint', 'ruff', 'auto']).default('auto'),
});

/** Output schema for `run_linter`. */
export const RunLinterOutputSchema = z.object({
  issues: z.array(
    z.object({
      file: z.string(),
      line: z.number().int(),
      column: z.number().int(),
      severity: z.enum(['error', 'warn']),
      message: z.string(),
      rule: z.string().optional(),
    }),
  ),
});

export type RunLinterInput = z.infer<typeof RunLinterInputSchema>;
export type RunLinterOutput = z.infer<typeof RunLinterOutputSchema>;

interface LintIssue {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warn';
  message: string;
  rule?: string;
}

/** Pick a linter based on file extension / project layout. */
function pickLinter(
  absPath: string,
  requested: 'eslint' | 'ruff' | 'auto',
): 'eslint' | 'ruff' | null {
  if (requested !== 'auto') return requested;
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.py') return 'ruff';
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'].includes(ext)) return 'eslint';
  return null;
}

/** Check whether a binary exists by probing `--version`. */
async function isAvailable(cmd: string, args: string[] = ['--version']): Promise<boolean> {
  try {
    await execFileP(cmd, args, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * LinterTool — shell out to a linter, parse its output.
 *
 * @example
 * ```ts
 * const res = await new LinterTool().execute(
 *   { path: 'src/index.ts', linter: 'auto' },
 *   ctx,
 * );
 * ```
 */
export class LinterTool implements SanixTool<RunLinterInput, RunLinterOutput> {
  readonly name = 'run_linter';
  readonly description =
    'Run a linter (ESLint or Ruff) on a file. Auto-detects based on extension. No-op (returns zero issues) if the linter binary is missing.';
  readonly inputSchema = RunLinterInputSchema;
  readonly outputSchema = RunLinterOutputSchema;
  readonly permissions: ToolPermission[] = ['shell:exec'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 16_000;

  async execute(
    input: RunLinterInput,
    context: ToolContext,
  ): Promise<ToolResult<RunLinterOutput>> {
    const start = Date.now();
    const absPath = resolvePath(input.path, context.cwd);
    const linter = pickLinter(absPath, input.linter);
    if (!linter) {
      return okResult<RunLinterOutput>({ issues: [] }, Date.now() - start);
    }

    try {
      if (linter === 'eslint') {
        const issues = await this.runEslint(absPath);
        return okResult<RunLinterOutput>({ issues }, Date.now() - start);
      }
      const issues = await this.runRuff(absPath);
      return okResult<RunLinterOutput>({ issues }, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<RunLinterOutput>(
        `run_linter failed: ${msg}`,
        Date.now() - start,
        { issues: [] },
      );
    }
  }

  private async runEslint(absPath: string): Promise<LintIssue[]> {
    if (!(await isAvailable('npx', ['--no-install', 'eslint', '--version']))) {
      return [];
    }
    try {
      const { stdout } = await execFileP(
        'npx',
        ['--no-install', 'eslint', '--format', 'json', absPath],
        { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
      );
      return parseEslintJson(stdout);
    } catch (err) {
      // eslint exits non-zero when issues are found, but stdout still has JSON.
      const e = err as { stdout?: string };
      if (e.stdout) return parseEslintJson(e.stdout);
      return [];
    }
  }

  private async runRuff(absPath: string): Promise<LintIssue[]> {
    if (!(await isAvailable('ruff'))) return [];
    try {
      const { stdout } = await execFileP(
        'ruff',
        ['check', '--output-format', 'json', absPath],
        { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
      );
      return parseRuffJson(stdout);
    } catch (err) {
      const e = err as { stdout?: string };
      if (e.stdout) return parseRuffJson(e.stdout);
      return [];
    }
  }

  formatForContext(result: RunLinterOutput): string {
    if (result.issues.length === 0) return 'no lint issues';
    return result.issues
      .map(
        (i) =>
          `${i.severity.toUpperCase()} ${i.file}:${i.line}:${i.column} ${i.message}${i.rule ? ` (${i.rule})` : ''}`,
      )
      .join('\n');
  }
}

/** Parse `eslint --format json` output. */
function parseEslintJson(json: string): LintIssue[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: LintIssue[] = [];
  for (const fileEntry of data) {
    if (typeof fileEntry !== 'object' || fileEntry === null) continue;
    const filePath = (fileEntry as { filePath?: unknown }).filePath;
    const messages = (fileEntry as { messages?: unknown }).messages;
    if (typeof filePath !== 'string' || !Array.isArray(messages)) continue;
    for (const msg of messages) {
      if (typeof msg !== 'object' || msg === null) continue;
      const m = msg as Record<string, unknown>;
      const severityRaw = m.severity;
      const severity: 'error' | 'warn' =
        severityRaw === 2 ? 'error' : severityRaw === 1 ? 'warn' : 'warn';
      out.push({
        file: filePath,
        line: typeof m.line === 'number' ? m.line : 0,
        column: typeof m.column === 'number' ? m.column : 0,
        severity,
        message: typeof m.message === 'string' ? m.message : '',
        rule: typeof m.ruleId === 'string' ? m.ruleId : undefined,
      });
    }
  }
  return out;
}

/** Parse `ruff check --output-format json` output. */
function parseRuffJson(json: string): LintIssue[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: LintIssue[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const loc = (e.location ?? {}) as Record<string, unknown>;
    out.push({
      file: typeof e.filename === 'string' ? e.filename : '',
      line: typeof loc.row === 'number' ? loc.row : 0,
      column: typeof loc.column === 'number' ? loc.column : 0,
      severity: 'error',
      message: typeof e.message === 'string' ? e.message : '',
      rule: typeof e.code === 'string' ? e.code : undefined,
    });
  }
  return out;
}

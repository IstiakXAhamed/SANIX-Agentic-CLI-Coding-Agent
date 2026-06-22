/**
 * @file TestRunner — runs vitest / jest / pytest and parses summary.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const execFileP = promisify(execFile);

/** Input schema for `run_tests`. */
export const RunTestsInputSchema = z.object({
  path: z.string().min(1).describe('Directory or test file to run.'),
  runner: z.enum(['vitest', 'jest', 'pytest', 'auto']).default('auto'),
  pattern: z.string().optional().describe('Test name pattern (grep).'),
});

/** Output schema for `run_tests`. */
export const RunTestsOutputSchema = z.object({
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  durationMs: z.number().int(),
  failures: z.array(
    z.object({
      name: z.string(),
      message: z.string(),
    }),
  ),
});

export type RunTestsInput = z.infer<typeof RunTestsInputSchema>;
export type RunTestsOutput = z.infer<typeof RunTestsOutputSchema>;

interface TestFailure {
  name: string;
  message: string;
}

/** Auto-detect test runner from project files. */
async function detectRunner(absPath: string): Promise<'vitest' | 'jest' | 'pytest' | null> {
  // Walk up looking for package.json / pytest.ini / pyproject.toml.
  let dir = path.isAbsolute(absPath) ? path.dirname(absPath) : absPath;
  if (!(await fs.stat(dir).catch(() => null))) {
    dir = process.cwd();
  }
  for (let i = 0; i < 12; i++) {
    try {
      const pkgPath = path.join(dir, 'package.json');
      const pkgStat = await fs.stat(pkgPath);
      if (pkgStat.isFile()) {
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as Record<string, unknown>;
        const deps = {
          ...(pkg.dependencies as Record<string, string> | undefined),
          ...(pkg.devDependencies as Record<string, string> | undefined),
        };
        if (deps['vitest']) return 'vitest';
        if (deps['jest']) return 'jest';
      }
    } catch {
      /* no package.json here */
    }
    try {
      await fs.stat(path.join(dir, 'pytest.ini'));
      return 'pytest';
    } catch {
      /* not found */
    }
    try {
      const pyproj = await fs.readFile(path.join(dir, 'pyproject.toml'), 'utf-8');
      if (/\[(?:tool\.|)pytest\]/.test(pyproj)) return 'pytest';
    } catch {
      /* not found */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: extension-based.
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.py') return 'pytest';
  return null;
}

/** Check whether a binary is available. */
async function isAvailable(cmd: string, args: string[] = ['--version']): Promise<boolean> {
  try {
    await execFileP(cmd, args, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * TestRunnerTool — run a test suite.
 *
 * @example
 * ```ts
 * const res = await new TestRunnerTool().execute(
 *   { path: 'packages/tools', runner: 'auto' },
 *   ctx,
 * );
 * ```
 */
export class TestRunnerTool implements SanixTool<RunTestsInput, RunTestsOutput> {
  readonly name = 'run_tests';
  readonly description =
    'Run a test suite (vitest, jest, or pytest). Auto-detects runner from project files. Returns pass/fail/skip counts and a list of failures.';
  readonly inputSchema = RunTestsInputSchema;
  readonly outputSchema = RunTestsOutputSchema;
  readonly permissions: ToolPermission[] = ['shell:exec'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 16_000;

  async execute(
    input: RunTestsInput,
    context: ToolContext,
  ): Promise<ToolResult<RunTestsOutput>> {
    const start = Date.now();
    const absPath = resolvePath(input.path, context.cwd);
    const runner = input.runner === 'auto' ? await detectRunner(absPath) : input.runner;
    if (!runner) {
      return errResult<RunTestsOutput>(
        `run_tests: could not detect a test runner for ${absPath}`,
        Date.now() - start,
        { passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] },
      );
    }

    try {
      if (runner === 'vitest') return await this.runVitest(absPath, input.pattern, start);
      if (runner === 'jest') return await this.runJest(absPath, input.pattern, start);
      return await this.runPytest(absPath, input.pattern, start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<RunTestsOutput>(
        `run_tests failed: ${msg}`,
        Date.now() - start,
        { passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] },
      );
    }
  }

  private async runVitest(
    absPath: string,
    pattern: string | undefined,
    start: number,
  ): Promise<ToolResult<RunTestsOutput>> {
    if (!(await isAvailable('npx', ['--no-install', 'vitest', '--version']))) {
      return errResult<RunTestsOutput>(
        'run_tests: vitest is not installed',
        Date.now() - start,
        { passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] },
      );
    }
    const args = ['--no-install', 'vitest', 'run', '--reporter=json', absPath];
    if (pattern) args.push('-t', pattern);
    try {
      const { stdout } = await execFileP('npx', args, {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      return parseVitestJson(stdout, start);
    } catch (err) {
      const e = err as { stdout?: string };
      if (e.stdout) return parseVitestJson(e.stdout, start);
      throw err;
    }
  }

  private async runJest(
    absPath: string,
    pattern: string | undefined,
    start: number,
  ): Promise<ToolResult<RunTestsOutput>> {
    if (!(await isAvailable('npx', ['--no-install', 'jest', '--version']))) {
      return errResult<RunTestsOutput>(
        'run_tests: jest is not installed',
        Date.now() - start,
        { passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] },
      );
    }
    const args = ['--no-install', 'jest', '--json', '--rootDir', path.dirname(absPath)];
    if (pattern) args.push('-t', pattern);
    try {
      const { stdout } = await execFileP('npx', args, {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      return parseJestJson(stdout, start);
    } catch (err) {
      const e = err as { stdout?: string };
      if (e.stdout) return parseJestJson(e.stdout, start);
      throw err;
    }
  }

  private async runPytest(
    absPath: string,
    pattern: string | undefined,
    start: number,
  ): Promise<ToolResult<RunTestsOutput>> {
    if (!(await isAvailable('pytest'))) {
      return errResult<RunTestsOutput>(
        'run_tests: pytest is not installed',
        Date.now() - start,
        { passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] },
      );
    }
    const args = [absPath, '--tb=short', '-q'];
    if (pattern) args.push('-k', pattern);
    try {
      const { stdout } = await execFileP('pytest', args, {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      return parsePytestText(stdout, start);
    } catch (err) {
      const e = err as { stdout?: string };
      if (e.stdout) return parsePytestText(e.stdout, start);
      throw err;
    }
  }

  formatForContext(result: RunTestsOutput): string {
    const head = `pass=${result.passed} fail=${result.failed} skip=${result.skipped} (${result.durationMs}ms)`;
    if (result.failures.length === 0) return head;
    const fails = result.failures
      .slice(0, 20)
      .map((f) => `  ✗ ${f.name}: ${f.message.split('\n')[0]}`)
      .join('\n');
    return `${head}\n${fails}`;
  }
}

/** Parse vitest JSON reporter output. */
function parseVitestJson(stdout: string, start: number): ToolResult<RunTestsOutput> {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return errResult<RunTestsOutput>(
      'run_tests: could not parse vitest JSON',
      Date.now() - start,
      { passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] },
    );
  }
  const d = data as Record<string, unknown>;
  const numTotal = typeof d.numTotalTests === 'number' ? d.numTotalTests : 0;
  const passed = typeof d.numPassedTests === 'number' ? d.numPassedTests : 0;
  const failed = typeof d.numFailedTests === 'number' ? d.numFailedTests : 0;
  const skipped = typeof d.numPendingTests === 'number' ? d.numPendingTests : 0;
  const failures: TestFailure[] = [];
  const testResults = d.testResults;
  if (Array.isArray(testResults)) {
    for (const file of testResults) {
      if (typeof file !== 'object' || file === null) continue;
      const assertionResults = (file as Record<string, unknown>).assertionResults;
      if (!Array.isArray(assertionResults)) continue;
      for (const t of assertionResults) {
        if (typeof t !== 'object' || t === null) continue;
        const tt = t as Record<string, unknown>;
        if (tt.status === 'failed') {
          failures.push({
            name: typeof tt.fullName === 'string' ? tt.fullName : String(tt.name ?? ''),
            message:
              typeof tt.failureMessages === 'object' && Array.isArray(tt.failureMessages)
                ? (tt.failureMessages as string[]).join('\n')
                : '',
          });
        }
      }
    }
  }
  void numTotal;
  return okResult<RunTestsOutput>(
    { passed, failed, skipped, durationMs: Date.now() - start, failures },
    Date.now() - start,
  );
}

/** Parse jest --json output. */
function parseJestJson(stdout: string, start: number): ToolResult<RunTestsOutput> {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return errResult<RunTestsOutput>(
      'run_tests: could not parse jest JSON',
      Date.now() - start,
      { passed: 0, failed: 0, skipped: 0, durationMs: 0, failures: [] },
    );
  }
  const d = data as Record<string, unknown>;
  const passed = typeof d.numPassedTests === 'number' ? d.numPassedTests : 0;
  const failed = typeof d.numFailedTests === 'number' ? d.numFailedTests : 0;
  const skipped = typeof d.numPendingTests === 'number' ? d.numPendingTests : 0;
  const failures: TestFailure[] = [];
  const testResults = d.testResults;
  if (Array.isArray(testResults)) {
    for (const file of testResults) {
      if (typeof file !== 'object' || file === null) continue;
      const assertionResults = (file as Record<string, unknown>).assertionResults;
      if (!Array.isArray(assertionResults)) continue;
      for (const t of assertionResults) {
        if (typeof t !== 'object' || t === null) continue;
        const tt = t as Record<string, unknown>;
        if (tt.status === 'failed') {
          failures.push({
            name: typeof tt.fullName === 'string' ? tt.fullName : String(tt.name ?? ''),
            message:
              typeof tt.failureMessages === 'object' && Array.isArray(tt.failureMessages)
                ? (tt.failureMessages as string[]).join('\n')
                : '',
          });
        }
      }
    }
  }
  return okResult<RunTestsOutput>(
    { passed, failed, skipped, durationMs: Date.now() - start, failures },
    Date.now() - start,
  );
}

/** Parse pytest plain-text output (q mode). */
function parsePytestText(stdout: string, start: number): ToolResult<RunTestsOutput> {
  // Look for a summary line like `===== 2 failed, 3 passed, 1 skipped in 1.23s =====`.
  const summaryMatch = stdout.match(
    /(\d+) failed(?:.*?(\d+) passed)?(?:.*?(\d+) skipped)?/,
  );
  const failed = summaryMatch ? parseInt(summaryMatch[1], 10) : 0;
  const passed = summaryMatch && summaryMatch[2] ? parseInt(summaryMatch[2], 10) : 0;
  const skipped = summaryMatch && summaryMatch[3] ? parseInt(summaryMatch[3], 10) : 0;

  const failures: TestFailure[] = [];
  // Extract `FAILED path::test_name - reason` lines.
  const failRe = /^FAILED\s+(\S+?)\s*::\s*(\S+?)(?:\s+-\s+(.*))?$/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(stdout)) !== null) {
    failures.push({ name: `${m[1]}::${m[2]}`, message: m[3] ?? '' });
  }
  return okResult<RunTestsOutput>(
    { passed, failed, skipped, durationMs: Date.now() - start, failures },
    Date.now() - start,
  );
}

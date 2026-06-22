/**
 * @file commands/fix.ts
 * @description `sanix fix` — auto-fix lint, type, and test issues.
 *
 *   sanix fix                            Fix all issues (lint + type + test)
 *     --lint-only                        Only fix linting issues
 *     --type-only                        Only fix type errors
 *     --test-only                        Only fix test failures
 *     --file <path>                      Only fix issues in a specific file
 *     --dry-run                          Show what would be fixed, don't apply
 *     --json                             JSON output
 *
 * Process:
 *   1. Run `tsc --noEmit`     → collect type errors
 *   2. Run `eslint --format json` (or `ruff check` for Python) → collect lint
 *   3. Run tests (`vitest` / `jest` / `pytest`) → collect failures
 *   4. For each issue:
 *      - Read the file + understand the error
 *      - Use the LLM to generate a fix (or apply a known pattern)
 *      - Apply the fix (unless `--dry-run`)
 *      - Re-run the check to verify
 *   5. Report: what was fixed, what couldn't be fixed (needs manual review)
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SanixContext } from '../bootstrap.js';

/** Parsed options for `sanix fix`. */
export interface FixCommandOptions {
  lintOnly?: boolean;
  typeOnly?: boolean;
  testOnly?: boolean;
  file?: string;
  dryRun?: boolean;
  json?: boolean;
}

/** A single issue detected by a check. */
export interface FixIssue {
  /** Which check produced this issue. */
  kind: 'lint' | 'type' | 'test';
  /** File path (relative to cwd). */
  file: string;
  /** Line number (1-based, if known). */
  line?: number;
  /** Column number (1-based, if known). */
  column?: number;
  /** Rule or error code (e.g. `no-unused-vars`, `TS2307`). */
  rule?: string;
  /** Human-readable message. */
  message: string;
}

/** The result of a fix attempt. */
export interface FixResult {
  /** The original issue. */
  issue: FixIssue;
  /** Whether the fix was applied. */
  fixed: boolean;
  /** Whether the verification re-run passed. */
  verified: boolean;
  /** The fix that was applied (description). */
  description?: string;
  /** Error message if the fix attempt failed. */
  error?: string;
}

/** Aggregate report returned by {@link fixCommand}. */
export interface FixReport {
  /** Issues found, grouped by kind. */
  issues: FixIssue[];
  /** Per-issue fix results. */
  results: FixResult[];
  /** Whether `--dry-run` was set. */
  dryRun: boolean;
}

/**
 * Register the `sanix fix` command.
 *
 * @param program     - The Commander root program.
 * @param ctxProvider - Lazy context provider (called on first action).
 */
export function registerFixCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  program
    .command('fix')
    .description('Auto-fix lint, type, and test issues using the LLM.')
    .option('--lint-only', 'Only fix linting issues')
    .option('--type-only', 'Only fix type errors')
    .option('--test-only', 'Only fix test failures')
    .option('--file <path>', 'Only fix issues in a specific file')
    .option('--dry-run', 'Show what would be fixed, do not apply')
    .option('--json', 'Output JSON report')
    .action(async (opts: FixCommandOptions) => {
      try {
        const ctx = await ctxProvider();
        const report = await fixCommand(ctx, opts);
        printReport(report, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix fix failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * Run the `sanix fix` command. Exposed for programmatic use.
 *
 * @param ctx  - The wired SANIX context.
 * @param opts - Parsed CLI options.
 * @returns Aggregate report.
 */
export async function fixCommand(
  ctx: SanixContext,
  opts: FixCommandOptions,
): Promise<FixReport> {
  const cwd = process.cwd();
  const issues: FixIssue[] = [];

  // 1. Collect issues.
  if (!opts.lintOnly && !opts.testOnly) {
    issues.push(...collectTypeIssues(cwd, opts.file));
  }
  if (!opts.typeOnly && !opts.testOnly) {
    issues.push(...collectLintIssues(cwd, opts.file));
  }
  if (!opts.lintOnly && !opts.typeOnly) {
    issues.push(...collectTestIssues(cwd));
  }

  // 2. Fix each issue.
  const results: FixResult[] = [];
  for (const issue of issues) {
    const result = await attemptFix(ctx, issue, opts.dryRun === true);
    results.push(result);
    // Re-verify (skip in dry-run).
    if (!opts.dryRun && result.fixed) {
      result.verified = verifyFix(issue, cwd);
    }
  }

  return { issues, results, dryRun: opts.dryRun === true };
}

/**
 * Run `tsc --noEmit` and parse the output for type errors.
 */
function collectTypeIssues(cwd: string, fileFilter?: string): FixIssue[] {
  if (!existsSync(join(cwd, 'tsconfig.json'))) return [];
  const r = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  if (r.error || r.status === 0) return [];
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const text = stdout + '\n' + stderr;
  const issues: FixIssue[] = [];
  // Typical line: `src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`
  const re = /^([^(]+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const file = m[1]!;
    if (fileFilter && resolve(cwd, file) !== resolve(cwd, fileFilter)) continue;
    issues.push({
      kind: 'type',
      file,
      line: parseInt(m[2]!, 10),
      column: parseInt(m[3]!, 10),
      rule: m[5]!,
      message: m[6]!,
    });
  }
  return issues;
}

/**
 * Run `eslint --format json` (or `ruff check` for Python) and parse the
 * output for lint issues.
 */
function collectLintIssues(cwd: string, fileFilter?: string): FixIssue[] {
  // Detect Python project.
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'ruff.toml'))) {
    return collectRuffIssues(cwd, fileFilter);
  }
  // Node project.
  if (!existsSync(join(cwd, 'package.json'))) return [];
  if (!existsSync(join(cwd, 'node_modules', '.bin', 'eslint'))) return [];
  const args = ['--format', 'json'];
  if (fileFilter) {
    args.push(fileFilter);
  } else {
    args.push('.');
  }
  const r = spawnSync('npx', ['eslint', ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  if (r.error) return [];
  const stdout = r.stdout?.trim() ?? '';
  if (!stdout.startsWith('[') && !stdout.startsWith('{')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const issues: FixIssue[] = [];
  for (const entry of parsed as Array<Record<string, unknown>>) {
    const filePath = typeof entry.filePath === 'string' ? entry.filePath : '';
    const rel = relative(cwd, filePath);
    if (fileFilter && resolve(cwd, rel) !== resolve(cwd, fileFilter)) continue;
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    for (const msg of messages as Array<Record<string, unknown>>) {
      issues.push({
        kind: 'lint',
        file: rel || filePath,
        line: typeof msg.line === 'number' ? msg.line : undefined,
        column: typeof msg.column === 'number' ? msg.column : undefined,
        rule: typeof msg.ruleId === 'string' ? msg.ruleId : undefined,
        message: typeof msg.message === 'string' ? msg.message : '',
      });
    }
  }
  return issues;
}

/** Run `ruff check --output-format json` for Python lint issues. */
function collectRuffIssues(cwd: string, fileFilter?: string): FixIssue[] {
  const args = ['check', '--output-format', 'json'];
  if (fileFilter) {
    args.push(fileFilter);
  } else {
    args.push('.');
  }
  const r = spawnSync('ruff', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  if (r.error) return [];
  const stdout = r.stdout?.trim() ?? '';
  if (!stdout.startsWith('[')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const issues: FixIssue[] = [];
  for (const entry of parsed as Array<Record<string, unknown>>) {
    const filename = typeof entry.filename === 'string' ? entry.filename : '';
    const rel = relative(cwd, filename);
    if (fileFilter && resolve(cwd, rel) !== resolve(cwd, fileFilter)) continue;
    const location = entry.location as { row?: number; column?: number } | undefined;
    issues.push({
      kind: 'lint',
      file: rel || filename,
      line: location && typeof location.row === 'number' ? location.row : undefined,
      column: location && typeof location.column === 'number' ? location.column : undefined,
      rule: typeof entry.code === 'string' ? entry.code : undefined,
      message: typeof entry.message === 'string' ? entry.message : '',
    });
  }
  return issues;
}

/**
 * Run the project's test suite and parse the output for failing tests.
 * Detects vitest, jest, and pytest.
 */
function collectTestIssues(cwd: string): FixIssue[] {
  if (existsSync(join(cwd, 'vitest.config.ts')) || existsSync(join(cwd, 'vitest.config.js'))) {
    return collectVitestIssues(cwd);
  }
  if (existsSync(join(cwd, 'jest.config.js')) || existsSync(join(cwd, 'jest.config.ts'))) {
    return collectJestIssues(cwd);
  }
  if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'pyproject.toml'))) {
    return collectPytestIssues(cwd);
  }
  return [];
}

/** Collect vitest failures. */
function collectVitestIssues(cwd: string): FixIssue[] {
  const r = spawnSync('npx', ['vitest', 'run', '--reporter', 'json'], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
  });
  if (r.error) return [];
  const stdout = r.stdout?.trim() ?? '';
  // vitest json reporter emits one JSON object per line on some versions;
  // we look for a single JSON blob first.
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Try last line.
    const lines = stdout.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        parsed = JSON.parse(lines[i]!);
        break;
      } catch {
        // continue
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as { testResults?: Array<Record<string, unknown>> };
  const issues: FixIssue[] = [];
  const testResults = Array.isArray(obj.testResults) ? obj.testResults : [];
  for (const tr of testResults) {
    const filePath = typeof tr.name === 'string' ? tr.name : '';
    const rel = relative(cwd, filePath);
    const status = typeof tr.status === 'string' ? tr.status : '';
    if (status !== 'failed') continue;
    const messages = Array.isArray(tr.message) ? tr.message : [];
    const messageText = typeof tr.message === 'string' ? tr.message : '';
    issues.push({
      kind: 'test',
      file: rel || filePath,
      message: messageText || (messages.length > 0 ? JSON.stringify(messages[0]) : 'test failed'),
    });
  }
  return issues;
}

/** Collect jest failures (best-effort — parses the text output). */
function collectJestIssues(cwd: string): FixIssue[] {
  const r = spawnSync('npx', ['jest', '--json'], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
  });
  if (r.error) return [];
  const stdout = r.stdout?.trim() ?? '';
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as {
    testResults?: Array<{
      name?: string;
      status?: string;
      message?: string;
    }>;
  };
  const issues: FixIssue[] = [];
  const testResults = Array.isArray(obj.testResults) ? obj.testResults : [];
  for (const tr of testResults) {
    if (tr.status !== 'failed') continue;
    const rel = relative(cwd, tr.name ?? '');
    issues.push({
      kind: 'test',
      file: rel,
      message: tr.message ?? 'test failed',
    });
  }
  return issues;
}

/** Collect pytest failures (best-effort). */
function collectPytestIssues(cwd: string): FixIssue[] {
  const r = spawnSync('pytest', ['--tb=line'], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
  });
  if (r.error) return [];
  const stdout = r.stdout ?? '';
  const issues: FixIssue[] = [];
  // Lines like: `/path/to/test_x.py:12: AssertionError`
  const re = /^(.+?):(\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const file = m[1]!;
    if (!file.includes('test_')) continue;
    issues.push({
      kind: 'test',
      file: relative(cwd, file),
      line: parseInt(m[2]!, 10),
      message: m[3]!,
    });
  }
  return issues;
}

/**
 * Attempt to fix an issue. Reads the file, builds a prompt, asks the LLM
 * for the corrected file content, and applies it (unless dry-run).
 */
async function attemptFix(
  ctx: SanixContext,
  issue: FixIssue,
  dryRun: boolean,
): Promise<FixResult> {
  const result: FixResult = { issue, fixed: false, verified: false };
  const fullPath = resolve(process.cwd(), issue.file);
  if (!existsSync(fullPath)) {
    result.error = 'file not found';
    return result;
  }
  let original: string;
  try {
    original = readFileSync(fullPath, 'utf-8');
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
  // Try a built-in rule-based fix first (fast + deterministic).
  const ruleFixed = applyRuleFix(original, issue);
  if (ruleFixed !== null) {
    result.description = `applied rule-based fix for ${issue.rule ?? issue.kind}`;
    if (!dryRun) {
      try {
        writeFileSync(fullPath, ruleFixed, 'utf-8');
        result.fixed = true;
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
    } else {
      result.fixed = true;
    }
    return result;
  }
  // Fall back to the LLM (if available).
  let providers: unknown[] = [];
  try {
    providers = ctx.router.list();
  } catch {
    providers = [];
  }
  if (providers.length === 0) {
    result.error = 'no LLM provider configured; cannot auto-fix';
    return result;
  }
  try {
    const fixed = await llmFix(ctx, original, issue);
    if (fixed === null) {
      result.error = 'LLM returned no fix';
      return result;
    }
    result.description = 'LLM-generated fix';
    if (!dryRun) {
      writeFileSync(fullPath, fixed, 'utf-8');
      result.fixed = true;
    } else {
      result.fixed = true;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/**
 * Apply a deterministic rule-based fix for common issues. Returns the
 * new file content, or `null` if no rule matched.
 *
 * Currently handled:
 *  - eslint `no-unused-vars`: comment-out the unused variable (best-effort).
 *  - TS `TS6133` (declared but never used): same.
 *
 * More rules can be added; this is intentionally conservative.
 */
function applyRuleFix(content: string, issue: FixIssue): string | null {
  if (!issue.line) return null;
  const lines = content.split('\n');
  const idx = issue.line - 1;
  if (idx < 0 || idx >= lines.length) return null;
  const rule = issue.rule ?? '';
  // Unused variable: prefix with `_` (the conventional "intentionally unused" marker).
  if (rule === 'no-unused-vars' || rule === 'TS6133' || rule === '@typescript-eslint/no-unused-vars') {
    const line = lines[idx]!;
    // Try to rename `const foo` → `const _foo`, `let bar` → `let _bar`, etc.
    const m = line.match(/^(\s*(?:const|let|var)\s+)([A-Za-z_$][\w$]*)(\s*=)/);
    if (m && m[2] && !m[2].startsWith('_')) {
      lines[idx] = `${m[1]}_${m[2]}${m[3]}` + line.slice(m[0]!.length);
      return lines.join('\n');
    }
  }
  return null;
}

/** Ask the LLM to fix an issue. Returns the new file content or `null`. */
async function llmFix(
  ctx: SanixContext,
  content: string,
  issue: FixIssue,
): Promise<string | null> {
  const systemPrompt = `You are a code-fixing assistant. The user will give you a file and an issue. Return ONLY the corrected file content — no prose, no markdown fences, no explanations.`;
  const userPrompt = `File: ${issue.file}
Issue kind: ${issue.kind}
Rule: ${issue.rule ?? '(none)'}
Line: ${issue.line ?? '?'}
Column: ${issue.column ?? '?'}
Message: ${issue.message}

Original file content:
\`\`\`
${content}
\`\`\`

Return the full corrected file content (the entire file, not just the changed lines).`;
  const res = await ctx.router.route({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    taskType: 'code',
    maxTokens: 8000,
  });
  const text = res.content?.trim() ?? '';
  if (!text) return null;
  // Strip markdown fences if present.
  return text
    .replace(/^```(?:[a-zA-Z]+)?\s*\n/, '')
    .replace(/\n```\s*$/, '')
    .trim();
}

/** Re-run the relevant check to verify a fix. */
function verifyFix(issue: FixIssue, cwd: string): boolean {
  if (issue.kind === 'type') {
    const r = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    });
    if (r.error) return false;
    return r.status === 0 || !r.stdout.includes(issue.file);
  }
  if (issue.kind === 'lint') {
    const r = spawnSync('npx', ['eslint', '--format', 'json', issue.file], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    if (r.error) return false;
    try {
      const parsed = JSON.parse(r.stdout?.trim() ?? '[]') as Array<{ errorCount?: number }>;
      return parsed.every((e) => (e.errorCount ?? 0) === 0);
    } catch {
      return false;
    }
  }
  // Tests: don't re-run (too slow). Mark as unverified.
  return false;
}

/** Print the fix report (text or JSON). */
function printReport(report: FixReport, opts: FixCommandOptions): void {
  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const { issues, results, dryRun } = report;
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`\nSANIX fix — ${issues.length} issue(s) found.\n`));
  if (issues.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.green('  No issues detected. ✓\n'));
    return;
  }
  for (const r of results) {
    const i = r.issue;
    const loc = i.line ? `:${i.line}${i.column ? `:${i.column}` : ''}` : '';
    const kind = i.kind === 'lint' ? chalk.hex('#FFB347')('lint ')
      : i.kind === 'type' ? chalk.red('type ')
      : chalk.cyan('test ');
    const rule = i.rule ? chalk.dim(`(${i.rule}) `) : '';
    const status = r.fixed
      ? (r.verified ? chalk.green('✓ fixed & verified') : chalk.green('✓ fixed'))
      : chalk.red('✗ could not fix');
    const verb = dryRun ? 'would fix' : 'fixed';
    // eslint-disable-next-line no-console
    console.log(`  ${kind} ${chalk.gray(i.file + loc)} ${rule}${status}`);
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`         ${i.message}`));
    if (r.fixed && r.description) {
      // eslint-disable-next-line no-console
      console.log(chalk.dim(`         → ${verb} via ${r.description}`));
    }
    if (r.error) {
      // eslint-disable-next-line no-console
      console.log(chalk.yellow(`         ⚠ ${r.error}`));
    }
  }
  const fixedCount = results.filter((r) => r.fixed).length;
  const verifiedCount = results.filter((r) => r.verified).length;
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`\n${dryRun ? 'Would fix' : 'Fixed'}: ${chalk.green(String(fixedCount))}/${issues.length} (verified: ${verifiedCount})\n`));
  if (!dryRun && fixedCount < issues.length) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('  Some issues need manual review. See above for details.\n'));
  }
}

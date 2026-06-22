/**
 * @file commands/commit.ts
 * @description `sanix commit` — smart Conventional-Commit generator.
 *
 *   sanix commit                            Analyze staged changes + commit
 *     --all                                 Stage all changes first (git add -A)
 *     --message <msg>                       Custom message (skip generation)
 *     --no-verify                           Skip pre-commit hooks
 *     --dry-run                             Show the message, don't commit
 *     --co-author                           Add SANIX as co-author
 *
 * Process:
 *   1. Get staged changes: `git diff --cached`
 *   2. If `--all`: `git add -A` first
 *   3. Analyze the diff:
 *      - What files changed
 *      - What was added/removed/modified
 *      - Categorize: feat, fix, refactor, docs, test, chore, perf, breaking
 *   4. Generate a Conventional Commit message:
 *      - Type (feat/fix/refactor/etc.)
 *      - Scope (module/area)
 *      - Description (imperative mood, < 72 chars)
 *      - Optional body (what + why)
 *   5. If `--dry-run`: print the message and exit
 *   6. Otherwise: `git commit -m "<message>"`
 *   7. If `--co-author`: add `Co-authored-by: SANIX <noreply@sanix.dev>`
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import type { SanixContext } from '../bootstrap.js';

/** Parsed options for `sanix commit`. */
export interface CommitCommandOptions {
  all?: boolean;
  message?: string;
  noVerify?: boolean;
  dryRun?: boolean;
  coAuthor?: boolean;
}

/** Conventional Commit type. */
export type CommitType =
  | 'feat'
  | 'fix'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'chore'
  | 'perf'
  | 'build'
  | 'ci'
  | 'style'
  | 'breaking';

/** A single file's diff summary. */
export interface FileDiff {
  /** Path (as reported by `git diff --name-status`). */
  path: string;
  /** Status: added / modified / deleted / renamed. */
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Lines added (best-effort). */
  added: number;
  /** Lines removed (best-effort). */
  removed: number;
}

/** Analysis result for a diff. */
export interface DiffAnalysis {
  /** Per-file summaries. */
  files: FileDiff[];
  /** Total added lines. */
  totalAdded: number;
  /** Total removed lines. */
  totalRemoved: number;
  /** Suggested commit type. */
  type: CommitType;
  /** Suggested scope (e.g. `auth`, `api`, `cli`). */
  scope?: string;
  /** Suggested one-line description (imperative mood, < 72 chars). */
  description: string;
  /** Optional longer body. */
  body?: string;
  /** Whether the diff includes a breaking change. */
  breaking: boolean;
}

/** Generated commit message. */
export interface CommitMessage {
  /** Full message (header + optional body + co-author trailer). */
  full: string;
  /** Just the header line. */
  header: string;
  /** Optional body. */
  body?: string;
  /** Optional co-author trailer. */
  coAuthor?: string;
}

/** Result returned by {@link commitCommand}. */
export interface CommitResult {
  /** The analysis (null if no staged changes). */
  analysis: DiffAnalysis | null;
  /** The generated commit message. */
  message: CommitMessage | null;
  /** Whether the commit was actually created. */
  committed: boolean;
  /** The commit SHA (if committed). */
  sha?: string;
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** Error message (if any). */
  error?: string;
}

/** SANIX co-author trailer (used when `--co-author` is set). */
const SANIX_COAUTHOR = 'Co-authored-by: SANIX <noreply@sanix.dev>';

/**
 * Register the `sanix commit` command.
 *
 * @param program     - The Commander root program.
 * @param ctxProvider - Lazy context provider (called on first action).
 */
export function registerCommitCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  program
    .command('commit')
    .description('Generate a Conventional Commit message from staged changes and commit.')
    .option('-a, --all', 'Stage all changes first (git add -A)')
    .option('-m, --message <msg>', 'Custom commit message (skip generation)')
    .option('--no-verify', 'Skip pre-commit hooks')
    .option('--dry-run', 'Show the message, do not commit')
    .option('--co-author', 'Add SANIX as co-author')
    .action(async (opts: CommitCommandOptions) => {
      try {
        const ctx = await ctxProvider();
        const result = await commitCommand(ctx, opts);
        printResult(result, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix commit failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * Run the `sanix commit` command. Exposed for programmatic use.
 *
 * @param ctx  - The wired SANIX context.
 * @param opts - Parsed CLI options.
 */
export async function commitCommand(
  ctx: SanixContext,
  opts: CommitCommandOptions,
): Promise<CommitResult> {
  const cwd = process.cwd();
  // 1. Verify we're in a git repo.
  if (!isGitRepo(cwd)) {
    return {
      analysis: null,
      message: null,
      committed: false,
      dryRun: opts.dryRun === true,
      error: 'not a git repository (no .git directory found)',
    };
  }
  // 2. Optionally stage everything.
  if (opts.all) {
    const r = git(['add', '-A'], cwd);
    if (r.status !== 0) {
      return {
        analysis: null,
        message: null,
        committed: false,
        dryRun: opts.dryRun === true,
        error: `git add -A failed: ${r.stderr}`,
      };
    }
  }
  // 3. Get the staged diff.
  const diff = git(['diff', '--cached'], cwd).stdout;
  const nameStatus = git(['diff', '--cached', '--name-status'], cwd).stdout;
  if (!diff.trim() && !nameStatus.trim()) {
    return {
      analysis: null,
      message: null,
      committed: false,
      dryRun: opts.dryRun === true,
      error: 'no staged changes (use `git add` or `--all`)',
    };
  }
  // 4. Analyze.
  const files = parseNameStatus(nameStatus);
  for (const f of files) {
    const stat = diffStatForFile(diff, f.path);
    f.added = stat.added;
    f.removed = stat.removed;
  }
  let analysis: DiffAnalysis;
  let message: CommitMessage;
  if (opts.message) {
    // Custom message — skip analysis generation, but still build a minimal analysis.
    analysis = {
      files,
      totalAdded: files.reduce((a, f) => a + f.added, 0),
      totalRemoved: files.reduce((a, f) => a + f.removed, 0),
      type: 'chore',
      description: opts.message,
      breaking: false,
    };
    message = buildMessage(analysis, opts);
  } else {
    analysis = await analyzeDiff(ctx, diff, files);
    message = buildMessage(analysis, opts);
  }
  // 5. Dry-run: print and exit.
  if (opts.dryRun) {
    return { analysis, message, committed: false, dryRun: true };
  }
  // 6. Commit.
  const args = ['commit'];
  if (opts.noVerify) args.push('--no-verify');
  args.push('-m', message.full);
  const r = git(args, cwd);
  if (r.status !== 0) {
    return {
      analysis,
      message,
      committed: false,
      dryRun: false,
      error: `git commit failed: ${r.stderr || r.stdout}`,
    };
  }
  const sha = git(['rev-parse', 'HEAD'], cwd).stdout.trim();
  return { analysis, message, committed: true, sha, dryRun: false };
}

/** Check whether `cwd` is inside a git working tree. */
function isGitRepo(cwd: string): boolean {
  return git(['rev-parse', '--is-inside-work-tree'], cwd).stdout.trim() === 'true';
}

/** Run a git command and capture its output. */
function git(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      status: r.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: msg, status: 1 };
  }
}

/** Parse `git diff --cached --name-status` output. */
function parseNameStatus(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    const path = parts[1] ?? '';
    if (!status || !path) continue;
    let kind: FileDiff['status'];
    if (status.startsWith('A')) kind = 'added';
    else if (status.startsWith('D')) kind = 'deleted';
    else if (status.startsWith('R')) kind = 'renamed';
    else kind = 'modified';
    out.push({ path, status: kind, added: 0, removed: 0 });
  }
  return out;
}

/** Count added/removed lines for a single file in the diff. */
function diffStatForFile(diff: string, path: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const lines = diff.split('\n');
  let inFile = false;
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      inFile = line.includes(`b/${path}`);
      continue;
    }
    if (!inFile) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** Analyze a diff to determine the commit type, scope, and description. */
async function analyzeDiff(
  ctx: SanixContext,
  diff: string,
  files: FileDiff[],
): Promise<DiffAnalysis> {
  const totalAdded = files.reduce((a, f) => a + f.added, 0);
  const totalRemoved = files.reduce((a, f) => a + f.removed, 0);
  const breaking = /BREAKING\s*CHANGE|!!:/.test(diff);
  // Heuristic type detection from file paths + content.
  const type = guessType(files, diff, breaking);
  const scope = guessScope(files);
  // Try the LLM first; fall back to a heuristic description.
  let providers: unknown[] = [];
  try {
    providers = ctx.router.list();
  } catch {
    providers = [];
  }
  let description = '';
  let body: string | undefined;
  if (providers.length > 0) {
    try {
      const llmResult = await llmAnalyze(ctx, diff, files, type);
      description = llmResult.description;
      body = llmResult.body;
    } catch {
      // Fall through to heuristic.
    }
  }
  if (!description) {
    description = heuristicDescription(files, type);
  }
  return {
    files,
    totalAdded,
    totalRemoved,
    type,
    scope,
    description,
    body,
    breaking,
  };
}

/** Heuristic guess at the commit type from the changed files + diff. */
function guessType(files: FileDiff[], diff: string, breaking: boolean): CommitType {
  if (breaking) return 'breaking';
  // Tests only → test.
  if (files.length > 0 && files.every((f) => isTestFile(f.path))) return 'test';
  // Docs only → docs.
  if (files.length > 0 && files.every((f) => isDocFile(f.path))) return 'docs';
  // CI / build config only → ci / build.
  if (files.length > 0 && files.every((f) => isCiFile(f.path))) return 'ci';
  if (files.length > 0 && files.every((f) => isBuildFile(f.path))) return 'build';
  // Look for new feature signals (new file in src/, or "feat:" in diff).
  const hasNewSrcFile = files.some((f) => f.status === 'added' && isSrcFile(f.path));
  const hasFixSignal = /\bfix(?:ed|es)?\b|\bbug\b/i.test(diff);
  const hasPerfSignal = /\bperf(?:ormance)?\b|\boptimize[ds]?\b|\bspeedup\b/i.test(diff);
  if (hasPerfSignal && !hasNewSrcFile) return 'perf';
  if (hasFixSignal && !hasNewSrcFile) return 'fix';
  if (hasNewSrcFile) return 'feat';
  // Default: refactor if code changed; chore otherwise.
  if (files.some((f) => isSrcFile(f.path))) return 'refactor';
  return 'chore';
}

/** Heuristic guess at the commit scope from the changed file paths. */
function guessScope(files: FileDiff[]): string | undefined {
  if (files.length === 0) return undefined;
  // Take the common directory prefix (excluding the root).
  const dirs = files
    .map((f) => f.path.split('/').slice(0, -1).join('/'))
    .filter((d) => d.length > 0);
  if (dirs.length === 0) return undefined;
  // Find the longest common prefix.
  const common = longestCommonPrefix(dirs);
  if (!common) {
    // Fall back to the first directory component.
    const first = files[0]!.path.split('/')[0] ?? '';
    if (first && !first.includes('.')) return first;
    return undefined;
  }
  const parts = common.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? undefined;
}

/** Heuristic one-line description from the file list + type. */
function heuristicDescription(files: FileDiff[], type: CommitType): string {
  if (files.length === 1) {
    const f = files[0]!;
    const verb = f.status === 'added'
      ? 'add'
      : f.status === 'deleted'
        ? 'remove'
        : 'update';
    const desc = `${verb} ${f.path}`;
    return desc.length > 72 ? desc.slice(0, 71) + '…' : desc;
  }
  if (files.length === 2) {
    return `${type}: update ${files.length} files`.slice(0, 72);
  }
  return `${type}: update ${files.length} files`.slice(0, 72);
}

/** Ask the LLM to analyze the diff. */
async function llmAnalyze(
  ctx: SanixContext,
  diff: string,
  files: FileDiff[],
  type: CommitType,
): Promise<{ description: string; body?: string }> {
  const fileList = files.map((f) => `${f.status}: ${f.path} (+${f.added}/-${f.removed})`).join('\n');
  const truncatedDiff = diff.length > 12000 ? diff.slice(0, 12000) + '\n... (truncated)' : diff;
  const res = await ctx.router.route({
    messages: [
      {
        role: 'system',
        content: 'You are a senior software engineer writing a Conventional Commit message. Reply with a JSON object: { "description": "<imperative mood, < 72 chars, no type prefix>", "body": "<optional multi-paragraph body explaining what + why>" }. No prose outside the JSON.',
      },
      {
        role: 'user',
        content: `Detected type: ${type}
Files changed:
${fileList}

Diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Write the description and optional body. The description must be in imperative mood (e.g. "add JWT validation to auth middleware"), <= 72 chars, no trailing period. The body (optional) should explain what changed and why. Return JSON only.`,
      },
    ],
    taskType: 'code',
    maxTokens: 1500,
  });
  const text = res.content?.trim() ?? '';
  if (!text) return { description: '' };
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { description?: string; body?: string };
    return {
      description: parsed.description ?? '',
      body: parsed.body,
    };
  } catch {
    // If JSON parsing fails, treat the whole text as the description.
    return { description: text.slice(0, 72) };
  }
}

/** Build the full commit message string. */
function buildMessage(analysis: DiffAnalysis, opts: CommitCommandOptions): CommitMessage {
  const typeStr = analysis.type === 'breaking' ? 'feat' : analysis.type;
  const scopeStr = analysis.scope ? `(${analysis.scope})` : '';
  const breakingMark = analysis.breaking ? '!' : '';
  const header = `${typeStr}${scopeStr}${breakingMark}: ${analysis.description}`.slice(0, 100);
  const parts: string[] = [header];
  if (analysis.body) {
    parts.push('');
    parts.push(analysis.body);
  }
  let coAuthor: string | undefined;
  if (opts.coAuthor) {
    parts.push('');
    parts.push(SANIX_COAUTHOR);
    coAuthor = SANIX_COAUTHOR;
  }
  return {
    full: parts.join('\n'),
    header,
    body: analysis.body,
    coAuthor,
  };
}

/** True if the path is a test file. */
function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|\/.*\.|\.).*(\.(test|spec)\.(ts|tsx|js|jsx|py|go|rs)|_test\.go|_test\.py)$/.test(path)
    || /\.(test|spec)\.(ts|tsx|js|jsx|py)$/.test(path)
    || /(^|\/)test_.*\.py$/.test(path)
    || /(^|\/).*_test\.go$/.test(path);
}

/** True if the path is a docs file. */
function isDocFile(path: string): boolean {
  return /\.(md|mdx|txt|rst|adoc)$/i.test(path) || /(^|\/)(docs?|documentation)(\/|$)/i.test(path);
}

/** True if the path is a CI config file. */
function isCiFile(path: string): boolean {
  return /(^|\/)\.github\/workflows\//.test(path)
    || /(^|\/)\.gitlab-ci\.yml$/.test(path)
    || /(^|\/)\.circleci\//.test(path)
    || /(^|\/)Jenkinsfile$/.test(path);
}

/** True if the path is a build config file. */
function isBuildFile(path: string): boolean {
  return /(^|\/)(package\.json|tsconfig\.json|tsup\.config\.(ts|js)|vite\.config\.(ts|js)|webpack\.config\.(ts|js)|rollup\.config\.(ts|js)|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|Gemfile|pom\.xml|build\.gradle)$/.test(path);
}

/** True if the path is a source file. */
function isSrcFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|cc|cpp|cs|scala|swift)$/i.test(path)
    && !isTestFile(path);
}

/** Longest common prefix across an array of strings (path-component aware). */
function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let prefix = strs[0]!;
  for (const s of strs.slice(1)) {
    while (!s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

/** Print the result (text only — no JSON mode for `commit`). */
function printResult(result: CommitResult, opts: CommitCommandOptions): void {
  if (result.error) {
    // eslint-disable-next-line no-console
    console.error(chalk.red(`\n✗ ${result.error}\n`));
    return;
  }
  if (!result.message) return;
  if (opts.dryRun || !result.committed) {
    // eslint-disable-next-line no-console
    console.log(chalk.hex('#00D4FF')('\nProposed commit message:\n'));
    // eslint-disable-next-line no-console
    console.log(chalk.green(result.message.full));
    // eslint-disable-next-line no-console
    console.log(chalk.dim('\n(dry run — no commit created)'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Committed: ${result.sha?.slice(0, 7) ?? '?'}`));
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`  ${result.message.header}`));
}

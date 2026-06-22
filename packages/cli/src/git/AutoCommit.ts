/**
 * @file git/AutoCommit.ts
 * @description Auto-commit git integration — wraps `git` shell commands to
 * provide per-goal branching, per-action commits, and goal-completion
 * commits. Designed to be wired into the agent loop via the HookManager
 * (Task A3) so that each `agent:start`, `tool:after`, and `agent:complete`
 * hook automatically triggers a git operation.
 *
 * Lifecycle (typical `sanix run "goal" --git`):
 *
 *   1. `agent:start`        → {@link AutoCommit.startGoal}
 *      - If `autoBranch`: create `sanix/<slug>-<shortid>` and switch to it.
 *      - Commit current state with `sanix: start <goal>`.
 *   2. `tool:after`         → {@link AutoCommit.commitAction}
 *      - For write_file / edit_file / bash (if files changed): stage the
 *        modified files and commit with `sanix: <tool> <summary>`.
 *   3. `agent:complete`     → {@link AutoCommit.completeGoal}
 *      - Final commit `sanix: complete <goal>` (or `sanix: failed <goal>`).
 *   4. `--abort`            → {@link AutoCommit.abort}
 *      - `git reset --hard` to the pre-goal commit SHA.
 *
 * All shell interactions go through `child_process.spawnSync('git', ...)`.
 * Failures are caught and logged via the optional `log` callback — they
 * never throw (the agent loop should not abort because git failed).
 *
 * @packageDocumentation
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';

/** Options accepted by {@link AutoCommitOptions}. */
export interface AutoCommitOptions {
  /** Master switch. When false, every method is a no-op. */
  enabled: boolean;
  /** Branch prefix for `autoBranch`-created branches. Default `sanix/`. */
  branchPrefix?: string;
  /** Custom commit-message generator for `startGoal`. */
  commitMessage?: (goal: string, taskId?: string) => string;
  /** Create a new branch per goal. Default `true`. */
  autoBranch?: boolean;
  /** Stage modified files (`git add`) before each commit. Default `true`. */
  stageFiles?: boolean;
  /** Optional logger (defaults to a no-op). */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** Return value of {@link AutoCommit.startGoal}. */
export interface StartGoalResult {
  /** The branch name the goal is running on (may equal the prior branch). */
  branch: string;
  /** The SHA of the `sanix: start <goal>` commit (the goal baseline). */
  commitSha: string;
}

/**
 * Auto-commit git integration.
 *
 * @example
 * ```ts
 * const ac = new AutoCommit({ enabled: true, autoBranch: true }, cwd);
 * if (await ac.isGitRepo()) {
 *   const start = await ac.startGoal('Refactor auth module');
 *   // ... agent runs, calls ac.commitAction(...) per tool ...
 *   await ac.completeGoal('Refactor auth module', true);
 * }
 * ```
 */
export class AutoCommit {
  private readonly opts: Required<Omit<AutoCommitOptions, 'commitMessage' | 'log'>> &
    Pick<AutoCommitOptions, 'commitMessage' | 'log'>;
  private readonly cwd: string;
  private startSha: string | null = null;
  private startBranch: string | null = null;
  private commits: string[] = [];

  /**
   * @param opts - The {@link AutoCommitOptions}.
   * @param cwd  - Working directory for git commands (typically the project root).
   */
  constructor(opts: AutoCommitOptions, cwd: string) {
    this.opts = {
      enabled: opts.enabled,
      branchPrefix: opts.branchPrefix ?? 'sanix/',
      commitMessage: opts.commitMessage,
      autoBranch: opts.autoBranch ?? true,
      stageFiles: opts.stageFiles ?? true,
      log: opts.log,
    };
    this.cwd = cwd;
  }

  /**
   * True when `cwd` is inside a git working tree.
   */
  async isGitRepo(): Promise<boolean> {
    if (!existsSync(join(this.cwd, '.git'))) {
      // Also accept being inside a worktree subdir (git rev-parse handles it).
      const r = this.git(['rev-parse', '--is-inside-work-tree']);
      return r.ok && r.stdout.trim() === 'true';
    }
    return true;
  }

  /**
   * Begin a goal. If `autoBranch` is enabled, creates and switches to a
   * new branch named `<branchPrefix><slug>-<shortid>`. Then commits the
   * current state with `sanix: start <goal>`.
   *
   * @param goal - The user's high-level goal (used for branch name + commit msg).
   * @returns The new branch + commit SHA, or `null` if disabled or not a git repo.
   */
  async startGoal(goal: string): Promise<StartGoalResult | null> {
    if (!this.opts.enabled) return null;
    if (!(await this.isGitRepo())) return null;

    // Record the pre-goal branch so `abort()` can switch back.
    this.startBranch = this.currentBranch();

    // Create a new branch per goal.
    if (this.opts.autoBranch) {
      const branch = this.makeBranchName(goal);
      const r = this.git(['checkout', '-b', branch]);
      if (!r.ok) {
        this.log('warn', `Failed to create branch ${branch}: ${r.stderr.trim()}`);
        // Fall back to staying on the current branch.
      }
    }

    // Stage everything (so the start commit captures the current state).
    if (this.opts.stageFiles) {
      this.git(['add', '-A']);
    }

    // Commit. The `--allow-empty` flag lets the start commit happen even
    // when the working tree is clean (e.g. right after a fresh clone).
    const msg = this.opts.commitMessage?.(goal) ?? `sanix: start ${goal}`;
    const r = this.git(['commit', '--allow-empty', '-m', msg]);
    let sha = '';
    if (r.ok) {
      sha = this.git(['rev-parse', 'HEAD']).stdout.trim();
      this.startSha = sha;
      this.commits.push(sha);
    } else {
      this.log('warn', `startGoal commit failed: ${r.stderr.trim()}`);
    }

    return {
      branch: this.currentBranch(),
      commitSha: sha,
    };
  }

  /**
   * Commit a single tool action. Called after `write_file` / `edit_file` /
   * `bash` (when files were modified). Stages the modified files and
   * commits with a short summary derived from the tool name + a snippet of
   * the input.
   *
   * @param toolName  - The tool that ran (e.g. 'write_file', 'edit_file').
   * @param toolInput - The tool's input arguments (used to build a summary).
   * @param result    - The tool's result (used to detect whether anything changed).
   * @returns The commit SHA, or `null` when nothing was committed.
   */
  async commitAction(
    toolName: string,
    toolInput: unknown,
    result: unknown,
  ): Promise<string | null> {
    if (!this.opts.enabled) return null;
    if (!this.startSha) return null; // startGoal not called yet.
    if (!this.isWriteTool(toolName)) return null;
    if (!this.modifiedFiles(result)) return null;

    if (this.opts.stageFiles) {
      this.git(['add', '-A']);
    }

    // Check whether there's anything staged to commit (avoids empty commits
    // cluttering the history when a tool was a no-op).
    const status = this.git(['status', '--porcelain']).stdout.trim();
    if (status.length === 0) return null;

    const summary = this.summarizeToolInput(toolName, toolInput);
    const msg = `sanix: ${toolName} ${summary}`;
    const r = this.git(['commit', '-m', msg]);
    if (!r.ok) {
      this.log('warn', `commitAction failed: ${r.stderr.trim()}`);
      return null;
    }
    const sha = this.git(['rev-parse', 'HEAD']).stdout.trim();
    this.commits.push(sha);
    return sha;
  }

  /**
   * Final commit at the end of a goal. Message is `sanix: complete <goal>`
   * on success, `sanix: failed <goal>` on failure.
   *
   * @param goal   - The user's high-level goal.
   * @param success - Whether the agent reported success.
   * @returns The commit SHA, or `null` when nothing was committed.
   */
  async completeGoal(goal: string, success: boolean): Promise<string | null> {
    if (!this.opts.enabled) return null;
    if (!this.startSha) return null;

    if (this.opts.stageFiles) {
      this.git(['add', '-A']);
    }

    const verb = success ? 'complete' : 'failed';
    const msg = this.opts.commitMessage?.(goal) ?? `sanix: ${verb} ${goal}`;
    // Allow empty so the goal-completion commit is always recorded.
    const r = this.git(['commit', '--allow-empty', '-m', msg]);
    if (!r.ok) {
      this.log('warn', `completeGoal commit failed: ${r.stderr.trim()}`);
      return null;
    }
    const sha = this.git(['rev-parse', 'HEAD']).stdout.trim();
    this.commits.push(sha);
    return sha;
  }

  /**
   * Roll back to the pre-goal state. Runs `git reset --hard <startSha>` and,
   * if `autoBranch` was used, switches back to the original branch.
   *
   * @param goal - The user's high-level goal (unused, kept for API symmetry).
   */
  async abort(goal: string): Promise<void> {
    void goal; // unused
    if (!this.opts.enabled) return;
    if (!this.startSha) return;

    const r = this.git(['reset', '--hard', this.startSha]);
    if (!r.ok) {
      this.log('warn', `abort reset failed: ${r.stderr.trim()}`);
      return;
    }

    if (this.opts.autoBranch && this.startBranch) {
      this.git(['checkout', this.startBranch]);
    }
    this.startSha = null;
    this.startBranch = null;
  }

  /**
   * Return the unified diff of all changes since {@link startGoal}. The
   * diff includes every commit between `startSha` and `HEAD`, plus the
   * current uncommitted changes.
   *
   * @returns A unified-diff string. Empty when no changes were made.
   */
  async diffSinceStart(): Promise<string> {
    if (!this.startSha) return '';
    const r = this.git(['diff', `${this.startSha}..HEAD`]);
    const committed = r.ok ? r.stdout : '';
    const uncommittedR = this.git(['diff']);
    const uncommitted = uncommittedR.ok ? uncommittedR.stdout : '';
    return [committed, uncommitted].filter(Boolean).join('\n');
  }

  /** List of commit SHAs recorded by this AutoCommit instance. */
  get commitShas(): readonly string[] {
    return [...this.commits];
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /** Run a git subcommand and capture stdout / stderr / exit code. */
  private git(args: readonly string[]): {
    ok: boolean;
    stdout: string;
    stderr: string;
  } {
    try {
      const r = spawnSync('git', [...args], {
        cwd: this.cwd,
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        ok: r.status === 0,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, stdout: '', stderr: msg };
    }
  }

  /** Current branch name (or empty string on failure). */
  private currentBranch(): string {
    return this.git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  }

  /** Build a slug-safe branch name from a goal. */
  private makeBranchName(goal: string): string {
    const slug = goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const short = nanoid(6);
    return `${this.opts.branchPrefix}${slug}-${short}`;
  }

  /** True when the tool is one that modifies files (and so should be committed). */
  private isWriteTool(name: string): boolean {
    return (
      name === 'write_file' ||
      name === 'edit_file' ||
      name === 'bash' ||
      name === 'watch_files' ||
      name === 'mcp_call'
    );
  }

  /**
   * Inspect a tool result to determine whether any files were modified.
   * Defensive — `result` is `unknown` so we narrow via runtime checks.
   */
  private modifiedFiles(result: unknown): boolean {
    if (result === null || result === undefined) return false;
    if (typeof result !== 'object') return false;
    const r = result as Record<string, unknown>;
    // ToolResult envelope: { ok: boolean, output: unknown }.
    if (r.ok === false) return false;
    // If the result carries a `modifiedFiles` array (some tools do), use it.
    if (Array.isArray(r.modifiedFiles) && r.modifiedFiles.length > 0) return true;
    // Bash: if stdout/stderr mentions "wrote" or "saved", treat as a write.
    const out = typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? '');
    if (/wrote|saved|created|updated|deleted/i.test(out)) return true;
    // Fallback: assume yes (better to over-commit than to lose work).
    return true;
  }

  /** Build a short summary string from a tool's input arguments. */
  private summarizeToolInput(toolName: string, input: unknown): string {
    if (input === null || input === undefined) return '';
    if (typeof input !== 'object') return String(input).slice(0, 60);
    const obj = input as Record<string, unknown>;
    // Common tool input shapes.
    const path = obj.path ?? obj.file ?? obj.filePath ?? obj.filename;
    if (typeof path === 'string') return this.basename(path).slice(0, 60);
    const cmd = obj.command ?? obj.cmd;
    if (typeof cmd === 'string') return cmd.split(/\s+/).slice(0, 4).join(' ').slice(0, 60);
    const query = obj.query ?? obj.q;
    if (typeof query === 'string') return query.slice(0, 60);
    // Generic fallback: first 60 chars of the JSON.
    try {
      return JSON.stringify(obj).slice(0, 60);
    } catch {
      return `(${toolName})`;
    }
  }

  /** Basename of a path (cross-platform). */
  private basename(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] ?? p;
  }

  /** Forward a log message to the optional `log` callback. */
  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.opts.log?.(level, msg);
  }
}

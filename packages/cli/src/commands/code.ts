/**
 * @file commands/code.ts
 * @description `sanix code "task"` — code-focused agent mode.
 *
 * Same as `sanix run` but with three differences:
 *   1. Forces the code tools (`analyze_ast`, `run_tests`, `run_linter`,
 *      `edit_file`) to be enabled even if the user disabled them in config.
 *   2. Prefers code-strength providers (claude-sonnet-4, gpt-4o,
 *      deepseek-v3, codestral, qwen-2.5-72b, mistral-large).
 *   3. Loads project context via `FileContextLoader.loadRepo(cwd)` and
 *      seeds the agent's context with the repo's symbol map.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { FileContextLoader } from '@sanix/core';
import type { SanixContext } from '../bootstrap.js';
import { executeGoal, renderResult, type ExecuteGoalOptions } from '../run-helpers.js';

/** Tool names that are force-enabled in code mode. */
const CODE_TOOLS: readonly string[] = [
  'analyze_ast',
  'run_tests',
  'run_linter',
  'edit_file',
] as const;

/** Provider aliases that are strong at code tasks (in preference order). */
const CODE_STRENGTH_PROVIDERS: readonly string[] = [
  'claude-sonnet-4',
  'claude-opus-4',
  'gpt-4o',
  'gpt-4.1',
  'deepseek-v3',
  'deepseek-r1',
  'codestral',
  'mistral-large',
  'qwen-2.5-72b',
  'o3',
  'o1',
] as const;

/** Parsed options for the `code` command. */
export interface CodeCommandOptions {
  budget?: number;
  provider?: string;
  parallel?: number;
  dryRun?: boolean;
  interactive?: boolean;
  checkpoint?: string;
  tui?: boolean;
  verbose?: boolean;
}

/**
 * Pick the best available code-strength provider from the router's
 * registry. Falls back to the config default if none match.
 */
function pickCodeProvider(ctx: SanixContext): string | undefined {
  const registered = new Set(ctx.router.list().map((p) => p.id));
  for (const alias of CODE_STRENGTH_PROVIDERS) {
    if (registered.has(alias)) return alias;
  }
  return ctx.config.providers.default;
}

/**
 * Force-enable the code tools on the registry. Tools that aren't
 * registered (e.g. user removed them) are silently skipped.
 */
function enableCodeTools(ctx: SanixContext): void {
  for (const name of CODE_TOOLS) {
    const entry = ctx.tools.list().find((t) => t.tool.name === name);
    if (entry && !entry.enabled) {
      ctx.tools.enable(name);
    }
  }
}

/**
 * Load the repo's file map via `FileContextLoader.loadRepo(cwd)`. The
 * returned map is stashed on the context's `metadata` so the agent loop
 * can read it (via `ctx.config` or a future hook). For now we just log
 * the file count so the user sees the ingestion happened.
 */
async function loadRepoContext(_ctx: SanixContext, cwd: string): Promise<number> {
  try {
    const loader = new FileContextLoader(cwd);
    const repo = await loader.loadRepo();
    return repo.size;
  } catch {
    // Non-fatal — code mode still works without repo context.
    return 0;
  }
}

/**
 * Register the `sanix code` command.
 */
export function registerCodeCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  program
    .command('code <task>')
    .description('Code-focused agent mode — forces code tools + repo context.')
    .option('--budget <n>', 'Token budget for the run', (v: string) => Number(v))
    .option('--provider <p>', 'Force a specific provider (overrides code-strength default)')
    .option('--parallel <n>', 'Max concurrent sub-agents', (v: string) => Number(v))
    .option('--dry-run', 'Show the generated plan, do not execute')
    .option('--interactive', 'Pause for approval on each action (best-effort)')
    .option('--checkpoint <path>', 'Save/resume state to/from a JSON file')
    .option('--no-tui', 'Disable the Ink TUI; use plain-text rendering')
    .option('--verbose', 'Print extra detail in the final summary')
    .action(async (task: string, opts: CodeCommandOptions) => {
      try {
        const ctx = await ctxProvider();
        await codeCommand(ctx, task, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix code failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * Run the `sanix code` command. Exposed for programmatic use.
 *
 * @param ctx  - The wired SANIX context.
 * @param task - The code task to perform.
 * @param opts - Parsed CLI options.
 */
export async function codeCommand(
  ctx: SanixContext,
  task: string,
  opts: CodeCommandOptions,
): Promise<void> {
  // 1. Force-enable code tools.
  enableCodeTools(ctx);

  // 2. Pick a code-strength provider (unless the user forced one).
  const provider = opts.provider ?? pickCodeProvider(ctx);
  if (!opts.provider && provider) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`Code mode: using provider ${provider}.`));
  }

  // 3. Load repo context.
  const cwd = process.cwd();
  const fileCount = await loadRepoContext(ctx, cwd);
  if (fileCount > 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`Loaded ${fileCount} files from ${cwd}.`));
  }

  const execOpts: ExecuteGoalOptions = {
    provider,
    parallel: opts.parallel,
    budget: opts.budget,
    dryRun: opts.dryRun,
    interactive: opts.interactive,
    checkpoint: opts.checkpoint,
    noTui: opts.tui === false,
    cwd,
  };

  const result = await executeGoal(ctx, task, execOpts);
  renderResult(result, { verbose: opts.verbose === true });
}

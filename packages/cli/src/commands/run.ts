/**
 * @file commands/run.ts
 * @description `sanix run "goal"` — one-shot goal execution.
 *
 * Calls {@link bootstrap}, wires up an AgentLoop via {@link wireUpAgent},
 * runs the goal to completion via {@link executeGoal}, and prints the
 * final summary via {@link renderResult}.
 *
 * Flags (per the spec's `## 🛠️ CLI Commands` section):
 *   --budget <n>        Token budget for the run.
 *   --provider <p>      Force a specific provider.
 *   --local             Force local LLM only.
 *   --parallel <n>      Max concurrent sub-agents.
 *   --dry-run           Show plan, don't execute.
 *   --interactive       Pause for approval on each action.
 *   --checkpoint <path> Save/resume state.
 *   --no-tui            Disable the Ink TUI.
 *   --no-subagents      Disable sub-agent spawning (force sequential). [Task A4]
 *   --git               Enable auto-commit git integration. [Task A4]
 *   --no-workspace      Disable workspace-context loading. [Task A4]
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { SanixContext } from '../bootstrap.js';
import { executeGoal, renderResult, type ExecuteGoalOptions } from '../run-helpers.js';

/** Parsed options for the `run` command. */
export interface RunCommandOptions {
  budget?: number;
  provider?: string;
  local?: boolean;
  parallel?: number;
  dryRun?: boolean;
  interactive?: boolean;
  checkpoint?: string;
  tui?: boolean;
  verbose?: boolean;
  subagents?: boolean;
  git?: boolean;
  workspace?: boolean;
}

/**
 * Register the `sanix run` command on a Commander program instance.
 *
 * @param program     - The Commander program to register on.
 * @param ctxProvider - Async factory that returns a wired {@link SanixContext}.
 */
export function registerRunCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  program
    .command('run <goal>')
    .description('One-shot goal execution — decompose, plan, act, complete.')
    .option('--budget <n>', 'Token budget for the run', (v: string) => Number(v))
    .option('--provider <p>', 'Force a specific provider (e.g. claude-sonnet-4)')
    .option('--local', 'Force local LLM only (sets preferLocal on every request)')
    .option('--parallel <n>', 'Max concurrent sub-agents', (v: string) => Number(v))
    .option('--dry-run', 'Show the generated plan, do not execute')
    .option('--interactive', 'Pause for approval on each action (best-effort)')
    .option('--checkpoint <path>', 'Save/resume state to/from a JSON file')
    .option('--no-tui', 'Disable the Ink TUI; use plain-text rendering')
    .option('--no-subagents', 'Disable sub-agent spawning (force sequential)')
    .option('--git', 'Enable auto-commit git integration (per-goal branch + per-action commits)')
    .option('--no-workspace', 'Disable workspace-context loading')
    .option('--verbose', 'Print extra detail in the final summary')
    .action(async (goal: string, opts: RunCommandOptions) => {
      try {
        const ctx = await ctxProvider();
        await runCommand(ctx, goal, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix run failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * Execute the `sanix run` command. Exposed for testing and for callers
 * that already have a {@link SanixContext} (e.g. programmatic use).
 *
 * @param ctx  - The wired SANIX context.
 * @param goal - The user's high-level goal.
 * @param opts - Parsed CLI options.
 */
export async function runCommand(
  ctx: SanixContext,
  goal: string,
  opts: RunCommandOptions,
): Promise<void> {
  const execOpts: ExecuteGoalOptions = {
    provider: opts.provider,
    local: opts.local,
    parallel: opts.parallel,
    budget: opts.budget,
    dryRun: opts.dryRun,
    interactive: opts.interactive,
    checkpoint: opts.checkpoint,
    noTui: opts.tui === false,
    noSubAgents: opts.subagents === false,
    git: opts.git === true,
    workspace: opts.workspace !== false,
  };

  const result = await executeGoal(ctx, goal, execOpts);
  renderResult(result, { verbose: opts.verbose === true });
}

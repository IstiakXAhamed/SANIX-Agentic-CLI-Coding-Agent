/**
 * @file commands/agent.ts
 * @description `sanix agent <sub>` — list, inspect, and run SANIX's 22
 * specialized agents (Security Sentinel, Migration Maestro, Test Architect,
 * …, UI/UX Designer, UltraWorker).
 *
 *   sanix agent list                       List all specialized agents.
 *   sanix agent show <id>                  Show details for one agent.
 *   sanix agent run <id> "<goal>"          Run an agent end-to-end.
 *     --json                               Emit JSON output.
 *     --dry-run                            Plan only; no destructive actions.
 *     --provider <p>                       Override the LLM provider.
 *     --cwd <path>                         Working directory.
 *
 * This is a thin wrapper over `@sanix/agents`' `listAgents` / `showAgent` /
 * `runAgent` functions, which contain all the real logic (table rendering,
 * agent invocation, finding/action printing).
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { listAgents, showAgent, runAgent } from '@sanix/agents';

/**
 * Register the `sanix agent` command tree on a Commander program.
 *
 * @param program - The Commander program to register on.
 */
export function registerAgentCommand(program: Command): void {
  const agent = program
    .command('agent')
    .description('List, inspect, and run SANIX\'s 22 specialized agents.');

  agent
    .command('list')
    .description('List all specialized agents (grouped by category).')
    .option('--json', 'Emit a JSON array instead of a human-readable table.')
    .action(async (opts: { json?: boolean }) => {
      try {
        await listAgents({ json: opts.json });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix agent list failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  agent
    .command('show <id>')
    .description('Show detailed info for one agent (system prompt, tools, examples).')
    .action(async (id: string) => {
      try {
        await showAgent(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix agent show failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  agent
    .command('run <id> <goal>')
    .description('Run a specialized agent against a goal end-to-end.')
    .option('--json', 'Emit a JSON result instead of human-readable output.')
    .option('--dry-run', 'Plan only; do not execute destructive actions.')
    .option('--provider <p>', 'Override the LLM provider used by the agent.')
    .option('--cwd <path>', 'Working directory the agent operates within.')
    .option('--max-iterations <n>', 'Cap the agent\'s OODA loop.', (v: string) => Number(v))
    .action(async (id: string, goal: string, opts: {
      json?: boolean;
      dryRun?: boolean;
      provider?: string;
      cwd?: string;
      maxIterations?: number;
    }) => {
      try {
        await runAgent(id, goal, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix agent run failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

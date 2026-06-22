/**
 * @file commands/chat.ts
 * @description `sanix chat` — interactive chat mode.
 *
 * Starts the {@link Repl}. Each non-slash user input triggers one
 * {@link AgentLoop} iteration with the accumulated conversation as
 * context. The agent's reply (the loop's final summary) is added to the
 * conversation and displayed.
 *
 * After each turn, the loop's plan is captured via `repl.setPlan()` so
 * the REPL's `/plan` and `/edit-plan` slash commands work (Task A4 / Part 2).
 *
 * Flags:
 *   --provider <p>   Force a specific provider for this chat session.
 *   --budget <n>     Token budget per turn.
 *   --no-tui         Plain-text mode (always implied for chat — Ink is
 *                     not used; the REPL is readline-based).
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { RunContext, ToolPermission } from '@sanix/core';
import type { SanixContext } from '../bootstrap.js';
import { wireUpAgent } from '../run-helpers.js';
import { Repl, type ReplMessage } from '../repl/Repl.js';

/** Parsed options for the `chat` command. */
export interface ChatCommandOptions {
  provider?: string;
  budget?: number;
  verbose?: boolean;
}

/**
 * Register the `sanix chat` command.
 *
 * @param program     - The Commander program to register on.
 * @param ctxProvider - Async factory that returns a wired {@link SanixContext}.
 */
export function registerChatCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  program
    .command('chat')
    .description('Interactive chat mode — multi-turn conversation with the agent.')
    .option('--provider <p>', 'Force a specific provider for this session')
    .option('--budget <n>', 'Token budget per turn', (v: string) => Number(v))
    .option('--verbose', 'Print extra detail on each turn')
    .action(async (opts: ChatCommandOptions) => {
      try {
        const ctx = await ctxProvider();
        await chatCommand(ctx, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix chat failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * Run the `sanix chat` command. Exposed for programmatic use.
 *
 * @param ctx  - The wired SANIX context.
 * @param opts - Parsed CLI options.
 */
export async function chatCommand(
  ctx: SanixContext,
  opts: ChatCommandOptions,
): Promise<void> {
  const repl = new Repl({
    context: ctx,
    onUserMessage: async (input, conversation) => {
      const loop = wireUpAgent(ctx, {
        provider: opts.provider,
        maxIterations: 3, // cap each turn to keep chat responsive
      });

      // Build seed messages from the conversation history (excluding the
      // just-added user message — the loop's `goal` carries it).
      const seedMessages = conversation
        .slice(0, -1)
        .map((m: ReplMessage) => ({ role: m.role, content: m.content }));

      const allowedPermissions: ToolPermission[] = [
        'file_read',
        'file_write',
        'shell_exec',
        'web_request',
        'memory_read',
        'memory_write',
        'ask_user',
      ];

      const runContext: RunContext = {
        config: ctx.config,
        cwd: process.cwd(),
        seedMessages,
        signal: new AbortController().signal,
        project: undefined,
        toolContext: {
          config: ctx.config,
          cwd: process.cwd(),
          allowedPermissions,
        },
      };

      try {
        const result = await loop.run(input, runContext);
        // Capture the plan so the REPL's /plan and /edit-plan commands
        // can display / edit it on the next iteration.
        repl.setPlan(result.finalState.plan ?? null);
        return result.summary || '(no response)';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return chalk.red(`[agent error] ${msg}`);
      }
    },
  });

  await repl.start();
}

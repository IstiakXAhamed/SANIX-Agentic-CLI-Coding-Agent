/**
 * @file commands/ask.ts
 * @description `sanix ask "question"` — quick question mode.
 *
 * Same as `sanix run` but:
 *   1. Restricts the ToolRegistry to read-only tools (read_file,
 *      list_directory, search_files, web_search, fetch_url).
 *   2. Single-turn — no plan decomposition, no multi-iteration loop.
 *   3. Loads a lightweight workspace context (framework + entry points
 *      only — no relevant-file scoring) per Task A4 / Part 6.
 *
 * The agent loop is still used (so memory + provider routing still work),
 * but with `maxIterations: 1` and a read-only toolset.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { SanixContext } from '../bootstrap.js';
import { executeGoal, renderResult, type ExecuteGoalOptions } from '../run-helpers.js';
import { WorkspaceLoader } from '../workspace/WorkspaceLoader.js';

/** Tool names permitted in ask mode (read-only). */
const ASK_ALLOWED_TOOLS: readonly string[] = [
  'read_file',
  'list_directory',
  'search_files',
  'web_search',
  'fetch_url',
] as const;

/** Parsed options for the `ask` command. */
export interface AskCommandOptions {
  provider?: string;
  budget?: number;
  verbose?: boolean;
}

/**
 * Restrict the tool registry to read-only tools. Every registered tool
 * not in {@link ASK_ALLOWED_TOOLS} is disabled.
 */
function restrictToReadOnly(ctx: SanixContext): void {
  const allowed = new Set(ASK_ALLOWED_TOOLS);
  for (const entry of ctx.tools.list()) {
    if (!allowed.has(entry.tool.name)) {
      ctx.tools.disable(entry.tool.name);
    } else if (!entry.enabled) {
      ctx.tools.enable(entry.tool.name);
    }
  }
}

/**
 * Register the `sanix ask` command.
 */
export function registerAskCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  program
    .command('ask <question>')
    .description('Quick question — read-only tools, single-turn, no plan.')
    .option('--provider <p>', 'Force a specific provider')
    .option('--budget <n>', 'Token budget for the turn', (v: string) => Number(v))
    .option('--verbose', 'Print extra detail in the final summary')
    .action(async (question: string, opts: AskCommandOptions) => {
      try {
        const ctx = await ctxProvider();
        await askCommand(ctx, question, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix ask failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * Run the `sanix ask` command. Exposed for programmatic use.
 *
 * @param ctx      - The wired SANIX context.
 * @param question - The user's question.
 * @param opts     - Parsed CLI options.
 */
export async function askCommand(
  ctx: SanixContext,
  question: string,
  opts: AskCommandOptions,
): Promise<void> {
  // Restrict to read-only tools.
  restrictToReadOnly(ctx);

  // ── Task A4 / Part 6: lightweight workspace context for ask mode. ────
  // Ask mode is read-only + single-turn, so we only load the framework +
  // entry points (no relevant-file scoring — that would be too expensive
  // for a quick question).
  let seedMessages = undefined;
  try {
    const loader = new WorkspaceLoader();
    const ws = await loader.detect(process.cwd());
    const parts: string[] = [];
    if (ws.framework) parts.push(`Framework: ${ws.framework}`);
    if (ws.language !== 'unknown') parts.push(`Language: ${ws.language}`);
    if (ws.packageManager) parts.push(`Package manager: ${ws.packageManager}`);
    if (ws.entryPoints.length > 0) {
      parts.push(`Entry points: ${ws.entryPoints.join(', ')}`);
    }
    if (parts.length > 0) {
      seedMessages = [
        {
          role: 'system' as const,
          content: `Workspace context (lightweight):\n${parts.join('\n')}`,
        },
      ];
    }
  } catch {
    // Non-fatal — workspace context is best-effort.
  }

  const execOpts: ExecuteGoalOptions = {
    provider: opts.provider,
    budget: opts.budget,
    // Single-turn: cap at 1 iteration. No multi-step planning.
    maxIterations: 1,
    noTui: true, // ask mode always uses plain text — no TUI needed for a one-shot Q&A.
    seedMessages,
    // Sub-agents never spawn in ask mode — single-turn + read-only.
    noSubAgents: true,
  };

  const result = await executeGoal(ctx, question, execOpts);
  renderResult(result, { verbose: opts.verbose === true });
}

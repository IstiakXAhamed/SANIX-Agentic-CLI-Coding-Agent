/**
 * @file cli.ts — implementation of the `sanix agent` CLI command.
 *
 * Exports three functions — `listAgents`, `showAgent`, `runAgent` — that the
 * SANIX CLI (`@sanix/cli`) wires up to:
 *
 *   ```
 *   sanix agent list                    # List all 20 agents
 *   sanix agent show <id>               # Show agent details
 *   sanix agent run <id> "<goal>"       # Run an agent
 *     --json                            # JSON output
 *     --dry-run                         # Show plan, don't execute
 *     --provider <p>                    # Override provider
 *     --cwd <path>                      # Working directory
 *   ```
 *
 * The functions accept an {@link AgentCLIOptions} bag so the caller can
 * drive them programmatically (e.g. from the TUI or a test harness),
 * not just from Commander.
 *
 * @packageDocumentation
 */

import { getGlobalRegistry } from './registerAllAgents.js';
import type { SpecializedAgent } from './types.js';
import type {
  AgentAction,
  AgentCategory,
  AgentRunOptions,
  AgentRunResult,
} from './types.js';

// ─── Public types ─────────────────────────────────────────────────────────

/** Options accepted by every `sanix agent` subcommand. */
export interface AgentCLIOptions {
  /** Emit JSON instead of human-readable text. */
  json?: boolean;
  /** Show the planned actions but do not execute write/destructive steps. */
  dryRun?: boolean;
  /** Override the LLM provider used by the agent (e.g. `anthropic/claude-3-5-sonnet`). */
  provider?: string;
  /** Cap the agent's OODA loop at this many iterations. */
  maxIterations?: number;
}

/** Options accepted by `runAgent` (extends {@link AgentCLIOptions} with cwd). */
export type RunAgentOptions = AgentCLIOptions & {
  /** Working directory the agent operates within. */
  cwd?: string;
};

// ─── ANSI color helpers (no external dep) ─────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

/** Colorize a string (skipped when stdout is not a TTY). */
function color(code: keyof typeof ANSI, text: string): string {
  if (!process.stdout.isTTY) return text;
  return `${ANSI[code]}${text}${ANSI.reset}`;
}

/** Severity → ANSI color. */
function severityColor(
  sev: 'critical' | 'high' | 'medium' | 'low' | 'info',
): keyof typeof ANSI {
  switch (sev) {
    case 'critical':
      return 'red';
    case 'high':
      return 'red';
    case 'medium':
      return 'yellow';
    case 'low':
      return 'cyan';
    case 'info':
      return 'gray';
  }
}

// ─── Public CLI functions ─────────────────────────────────────────────────

/**
 * `sanix agent list` — print a table of all registered agents.
 *
 * @example
 * ```ts
 * await listAgents();                    // human-readable table
 * await listAgents({ json: true });      // JSON array
 * ```
 */
export async function listAgents(opts?: AgentCLIOptions): Promise<void> {
  const registry = getGlobalRegistry();
  const agents = registry.list();

  if (opts?.json) {
    process.stdout.write(
      JSON.stringify(
        agents.map((a) => ({
          id: a.id,
          name: a.name,
          icon: a.icon,
          category: a.category,
          description: a.description,
          tools: a.tools,
          exampleQueries: a.exampleQueries,
        })),
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (agents.length === 0) {
    process.stdout.write(
      color('yellow', 'No agents registered.\n'),
    );
    return;
  }

  // Group by category for readability.
  const byCategory = new Map<AgentCategory, SpecializedAgent[]>();
  for (const a of agents) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }

  process.stdout.write(
    color('bold', `SANIX Agents (${agents.length})`) + '\n\n',
  );
  for (const [cat, list] of [...byCategory.entries()].sort()) {
    process.stdout.write(
      color('magenta', `■ ${cat}`) +
        color('gray', ` (${list.length})`) + '\n',
    );
    for (const a of list) {
      const id = color('cyan', a.id.padEnd(22));
      const icon = `${a.icon} `;
      const desc =
        a.description.length > 80
          ? a.description.slice(0, 77) + '...'
          : a.description;
      process.stdout.write(`  ${icon}${id}  ${desc}\n`);
    }
    process.stdout.write('\n');
  }
}

/**
 * `sanix agent show <id>` — print detailed info about one agent.
 *
 * @example
 * ```ts
 * await showAgent('cost-optimizer');
 * ```
 */
export async function showAgent(id: string): Promise<void> {
  const registry = getGlobalRegistry();
  const agent = registry.get(id);

  if (!agent) {
    process.stdout.write(
      color('red', `✗ Agent not found: ${id}\n`) +
        color('gray', `  Run \`sanix agent list\` to see available agents.\n`),
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\n');
  process.stdout.write(
    `  ${color('bold', `${agent.icon}  ${agent.name}`)} ` +
      color('gray', `(${agent.id})`) + '\n',
  );
  process.stdout.write(
    color('gray', '  ─────────────────────────────────────────────\n'),
  );
  process.stdout.write(`  ${color('dim', 'Category:')} ${agent.category}\n`);
  process.stdout.write(
    `  ${color('dim', 'Description:')} ${agent.description}\n\n`,
  );

  process.stdout.write(color('bold', '  System Prompt\n'));
  process.stdout.write(
    color('gray', '  ─────────────────────────────────────────────\n'),
  );
  // Wrap the system prompt at 80 cols with a 2-space indent.
  for (const line of wrapText(agent.systemPrompt, 78)) {
    process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write('\n');

  process.stdout.write(color('bold', '  Tools\n'));
  for (const t of agent.tools) {
    process.stdout.write(`  • ${color('cyan', t)}\n`);
  }
  process.stdout.write('\n');

  process.stdout.write(color('bold', '  Example Queries\n'));
  for (const q of agent.exampleQueries) {
    process.stdout.write(`  ${color('green', '▸')} ${q}\n`);
  }
  process.stdout.write('\n');
}

/**
 * `sanix agent run <id> "<goal>"` — run an agent and print the result.
 *
 * @example
 * ```ts
 * await runAgent('cost-optimizer', 'Cut our AWS bill by 20%', {
 *   cwd: '/repo',
 *   dryRun: true,
 * });
 * ```
 *
 * @example
 * ```ts
 * await runAgent('log-detective', 'Analyze /var/log/app.log', {
 *   json: true,
 *   provider: 'anthropic/claude-3-5-sonnet',
 * });
 * ```
 */
export async function runAgent(
  id: string,
  goal: string,
  opts?: RunAgentOptions,
): Promise<void> {
  const registry = getGlobalRegistry();
  const agent = registry.get(id);

  if (!agent) {
    process.stdout.write(
      color('red', `✗ Agent not found: ${id}\n`) +
        color('gray', `  Run \`sanix agent list\` to see available agents.\n`),
    );
    process.exitCode = 1;
    return;
  }

  const runOptions: AgentRunOptions = {
    goal,
    cwd: opts?.cwd ?? process.cwd(),
    dryRun: opts?.dryRun ?? false,
    provider: opts?.provider,
    maxIterations: opts?.maxIterations,
  };

  // Header.
  if (!opts?.json) {
    process.stdout.write('\n');
    process.stdout.write(
      `  ${color('bold', `${agent.icon}  Running ${agent.name}`)} ` +
        color('gray', `(${agent.id})`) + '\n',
    );
    process.stdout.write(
      color('gray', '  ─────────────────────────────────────────────\n'),
    );
    process.stdout.write(`  ${color('dim', 'Goal:')} ${goal}\n`);
    if (runOptions.dryRun) {
      process.stdout.write(
        `  ${color('yellow', 'DRY RUN')} — will not execute destructive actions\n`,
      );
    }
    if (runOptions.provider) {
      process.stdout.write(
        `  ${color('dim', 'Provider:')} ${runOptions.provider}\n`,
      );
    }
    process.stdout.write(`  ${color('dim', 'CWD:')} ${runOptions.cwd}\n`);
    process.stdout.write(
      color('gray', '  ─────────────────────────────────────────────\n'),
    );
  }

  // Execute.
  let result: AgentRunResult;
  try {
    result = await agent.run(runOptions);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts?.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: msg }) + '\n',
      );
    } else {
      process.stdout.write(
        color('red', `\n  ✗ Agent failed: ${msg}\n`),
      );
    }
    process.exitCode = 1;
    return;
  }

  // Output.
  if (opts?.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  printResultHuman(result);
}

// ─── Human-readable result printer ────────────────────────────────────────

/** Print an {@link AgentRunResult} in human-readable form. */
function printResultHuman(result: AgentRunResult): void {
  process.stdout.write(
    `\n  ${color('green', '✓')} ${color('bold', 'Summary')}\n`,
  );
  for (const line of wrapText(result.summary, 78)) {
    process.stdout.write(`    ${line}\n`);
  }
  if (result.durationMs !== undefined) {
    process.stdout.write(
      color('gray', `    (${result.durationMs}ms, ${result.iterations ?? 0} iterations)\n`),
    );
  }

  if (result.findings.length > 0) {
    process.stdout.write(`\n  ${color('bold', 'Findings')} ${color('gray', `(${result.findings.length})`)}\n`);
    for (const f of result.findings) {
      const sev = severityColor(f.severity);
      process.stdout.write(
        `    ${color(sev, `[${f.severity.toUpperCase().padEnd(8)}]`)} ` +
          color('bold', f.title) + '\n',
      );
      if (f.file) {
        process.stdout.write(
          color('gray', `      📄 ${f.file}${f.line ? `:${f.line}` : ''}\n`),
        );
      }
      for (const line of wrapText(f.description, 76)) {
        process.stdout.write(color('gray', `      ${line}\n`));
      }
    }
  }

  if (result.actions.length > 0) {
    process.stdout.write(`\n  ${color('bold', 'Actions')} ${color('gray', `(${result.actions.length})`)}\n`);
    for (const a of result.actions) {
      process.stdout.write(
        `    ${actionIcon(a)} ${a.description}\n`,
      );
      if (a.estimatedSavings !== undefined) {
        process.stdout.write(
          color('green', `      💰 ~$${a.estimatedSavings.toFixed(2)}/mo savings\n`),
        );
      }
      if (a.command) {
        process.stdout.write(
          color('cyan', `      $ ${a.command}\n`),
        );
      }
    }
  }

  if (result.artifacts && result.artifacts.length > 0) {
    process.stdout.write(`\n  ${color('bold', 'Artifacts')}\n`);
    for (const a of result.artifacts) {
      const sizeKb = (a.content.length / 1024).toFixed(1);
      process.stdout.write(
        `    📎 ${a.name} ` +
          color('gray', `(${a.language ?? 'text'}, ${sizeKb} KB)\n`),
      );
    }
  }

  process.stdout.write('\n');
}

/** Pick an emoji for an action based on its type. */
function actionIcon(a: AgentAction): string {
  switch (a.type) {
    case 'fix':
      return '🔧';
    case 'suggestion':
      return '💡';
    case 'warning':
      return '⚠️';
    case 'info':
      return 'ℹ️';
  }
}

// ─── Text helpers ─────────────────────────────────────────────────────────

/** Word-wrap a string at `width` columns. */
function wrapText(text: string, width: number): string[] {
  if (!text) return [''];
  const paragraphs = text.split('\n');
  const out: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/);
    let line = '';
    for (const w of words) {
      if (line.length + w.length + 1 > width && line.length > 0) {
        out.push(line);
        line = w;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    out.push(line);
  }
  return out;
}

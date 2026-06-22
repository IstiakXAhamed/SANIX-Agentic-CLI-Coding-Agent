/**
 * @file commands/team.ts
 * @description `sanix team <sub>` — multi-agent team subcommands.
 *
 *   sanix team list                              List available team templates.
 *   sanix team show <name>                       Show team template details.
 *   sanix team solve <template> "<problem>"      Run a team to solve a problem.
 *   sanix team compare <template> "<problem>"    Run multiple strategies, compare.
 *
 * Delegates to {@link AgentTeam} from `@sanix/multiagent`. The team's
 * `agentFactory` is wired to the SANIX {@link ProviderRouter} so every
 * member run goes through the normal circuit-breaker + fallback path.
 *
 * Graceful degradation: if `@sanix/multiagent` cannot be loaded (e.g.
 * the package was not installed), every subcommand prints a clear error
 * and exits 1. The {@link SanixContext.multiagent} field is optional
 * and lazily-instantiated by {@link getTeamFactory}.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { SanixContext } from '../bootstrap.js';

/** Parsed options for `sanix team solve`. */
export interface TeamSolveOptions {
  context?: string;
  rounds?: number;
  maxConcurrent?: number;
  noTui?: boolean;
  json?: boolean;
}

/** Parsed options for `sanix team compare`. */
export interface TeamCompareOptions {
  strategies?: string;
  context?: string;
  rounds?: number;
  maxConcurrent?: number;
  json?: boolean;
}

/**
 * Lazy handle to the `@sanix/multiagent` module. We dynamic-import it
 * on first use so the CLI boot path stays fast and so the command
 * degrades cleanly when the package is absent.
 */
interface MultiagentModule {
  AgentTeam: new (
    config: TeamConfigLike,
    opts: { agentFactory: (m: TeamMemberLike) => AgentHandleLike },
  ) => {
    solve: (problem: string, context?: string) => Promise<TeamResultLike>;
    executeStrategy: (
      strategy: string,
      problem: string,
      context?: string,
    ) => Promise<TeamResultLike>;
  };
  getTeamTemplate: (name: string) => TeamConfigLike | null;
  listTeamTemplates: () => string[];
  TEAM_TEMPLATES: TeamConfigLike[];
}

/** Structural subset of {@link TeamConfig} we read. */
interface TeamConfigLike {
  name: string;
  description: string;
  strategy: string;
  consensus: string;
  rounds: number;
  maxConcurrent: number;
  timeoutMs: number;
  members: TeamMemberLike[];
}

/** Structural subset of {@link TeamMember}. */
interface TeamMemberLike {
  id: string;
  persona: string;
  role: string;
  provider?: string;
  systemPromptOverride?: string;
  weight: number;
}

/** Structural subset of {@link AgentHandle}. */
interface AgentHandleLike {
  id: string;
  run: (input: string, context?: string) => Promise<string>;
  abort: () => void;
  lastRun?: () => { costUsd: number; tokensUsed: number; durationMs: number };
}

/** Structural subset of {@link TeamResult}. */
interface TeamResultLike {
  teamName: string;
  consensus: string;
  contributions: Array<{
    memberId: string;
    persona: string;
    role: string;
    output: string;
    costUsd: number;
    tokensUsed: number;
    durationMs: number;
  }>;
  consensusConfidence: number;
  totalCostUsd: number;
  totalTokens: number;
  totalDurationMs: number;
  rounds: number;
  disagreements: string[];
}

/** Cached dynamic-import of `@sanix/multiagent`. */
let multiagentPromise: Promise<MultiagentModule> | null = null;

/**
 * Lazily dynamic-import `@sanix/multiagent`. Cached so subsequent
 * invocations are free. Throws a friendly error if the package is
 * missing.
 */
async function loadMultiagent(): Promise<MultiagentModule> {
  if (!multiagentPromise) {
    multiagentPromise = (async () => {
      try {
        // Variable specifier → TypeScript skips static module resolution
        // so the command degrades cleanly when the package isn't linked.
        const spec = '@sanix/multiagent';
        const mod = (await import(spec)) as unknown as MultiagentModule;
        return mod;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `@sanix/multiagent is not available (${msg}). Install it to use \`sanix team\`.`,
        );
      }
    })();
  }
  return multiagentPromise;
}

/**
 * Build an `agentFactory` that drives each team member via the
 * ProviderRouter. Each call to `run` routes a chat request through
 * the router with the member's persona (or system-prompt override)
 * prepended as the system message.
 */
function makeAgentFactory(
  ctx: SanixContext,
): (member: TeamMemberLike) => AgentHandleLike {
  return (member: TeamMemberLike) => {
    let lastRun: { costUsd: number; tokensUsed: number; durationMs: number } | undefined;
    return {
      id: member.id,
      abort: () => {
        // Best-effort: the router doesn't expose per-request abort, so
        // we rely on the strategy's own abort signal. No-op here.
      },
      run: async (input: string, context?: string): Promise<string> => {
        const system = member.systemPromptOverride ?? `You are a "${member.persona}" agent.`;
        const userContent = context ? `${context}\n\n${input}` : input;
        const start = Date.now();
        const res = await ctx.router.route({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
          maxTokens: 2048,
          temperature: 0.3,
        });
        const tokensUsed = res.usage.inputTokens + res.usage.outputTokens;
        lastRun = {
          costUsd: res.costUsd ?? 0,
          tokensUsed,
          durationMs: Date.now() - start,
        };
        return res.content;
      },
      lastRun: () => lastRun ?? { costUsd: 0, tokensUsed: 0, durationMs: 0 },
    };
  };
}

/**
 * Apply CLI overrides (rounds, maxConcurrent) on top of a template.
 * Returns a shallow-cloned config so the original template is not
 * mutated.
 */
function applyOverrides(
  cfg: TeamConfigLike,
  opts: { rounds?: number; maxConcurrent?: number },
): TeamConfigLike {
  return {
    ...cfg,
    rounds: opts.rounds ?? cfg.rounds,
    maxConcurrent: opts.maxConcurrent ?? cfg.maxConcurrent,
  };
}

/**
 * Register the `sanix team` command tree.
 *
 * @param program       - The Commander root program.
 * @param ctxProvider   - Lazy context provider (called on first action).
 */
export function registerTeamCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const team = program
    .command('team')
    .description('Multi-agent team orchestration (parallel, debate, voting, MoE, …).');

  team
    .command('list')
    .description('List the available built-in team templates.')
    .action(async () => {
      try {
        const ma = await loadMultiagent();
        teamList(ma);
      } catch (err) {
        fail('team list', err);
      }
    });

  team
    .command('show <name>')
    .description('Show the details of a single team template.')
    .action(async (name: string) => {
      try {
        const ma = await loadMultiagent();
        teamShow(ma, name);
      } catch (err) {
        fail('team show', err);
      }
    });

  team
    .command('solve <template> <problem>')
    .description('Run a team to solve a problem using its configured strategy.')
    .option('--context <text>', 'Additional context (prior outputs, constraints, …).')
    .option('--rounds <n>', 'Override the number of rounds (debate / swarm).', (v: string) => Number(v))
    .option('--max-concurrent <n>', 'Max parallel member executions.', (v: string) => Number(v))
    .option('--no-tui', 'Plain-text output (default).')
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (template: string, problem: string, opts: TeamSolveOptions) => {
      try {
        const ctx = await ctxProvider();
        const ma = await loadMultiagent();
        await teamSolve(ctx, ma, template, problem, opts);
      } catch (err) {
        fail('team solve', err);
      }
    });

  team
    .command('compare <template> <problem>')
    .description('Run a team with multiple strategies and compare results.')
    .option(
      '--strategies <s1,s2,s3>',
      'Comma-separated strategy list (e.g. parallel,debate,voting).',
    )
    .option('--context <text>', 'Additional context passed to every strategy run.')
    .option('--rounds <n>', 'Override rounds (debate / swarm).', (v: string) => Number(v))
    .option('--max-concurrent <n>', 'Max parallel member executions.', (v: string) => Number(v))
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (template: string, problem: string, opts: TeamCompareOptions) => {
      try {
        const ctx = await ctxProvider();
        const ma = await loadMultiagent();
        await teamCompare(ctx, ma, template, problem, opts);
      } catch (err) {
        fail('team compare', err);
      }
    });
}

/** `sanix team list`. */
export function teamList(ma: MultiagentModule): void {
  const names = ma.listTeamTemplates();
  if (names.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No team templates available.'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Team templates (${names.length}):\n`));
  for (const cfg of ma.TEAM_TEMPLATES) {
    const strat = chalk.hex('#FFB347')(`[${cfg.strategy}]`);
    const members = chalk.dim(`(${cfg.members.length} members)`);
    // eslint-disable-next-line no-console
    console.log(`  ${chalk.cyan(cfg.name.padEnd(20))} ${strat} ${members}`);
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`    ${wrap(cfg.description, 80, 4)}`));
  }
}

/** `sanix team show <name>`. */
export function teamShow(ma: MultiagentModule, name: string): void {
  const cfg = ma.getTeamTemplate(name);
  if (!cfg) {
    throw new Error(`No team template named "${name}". Run \`sanix team list\` to see options.`);
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Team: ${cfg.name}\n`));
  // eslint-disable-next-line no-console
  console.log(chalk.dim(wrap(cfg.description, 80, 0)));
  // eslint-disable-next-line no-console
  console.log(
    chalk.hex('#FFB347')('\nStrategy:') + ` ${cfg.strategy}  ` +
    chalk.hex('#FFB347')('Consensus:') + ` ${cfg.consensus}  ` +
    chalk.hex('#FFB347')('Rounds:') + ` ${cfg.rounds}`,
  );
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#FFB347')('\nMembers:'));
  for (const m of cfg.members) {
    const role = chalk.green(`[${m.role}]`);
    // eslint-disable-next-line no-console
    console.log(`  ${chalk.cyan(m.id.padEnd(16))} ${role} ${chalk.dim(`persona=${m.persona} weight=${m.weight}`)}`);
  }
}

/** `sanix team solve <template> "<problem>"`. */
export async function teamSolve(
  ctx: SanixContext,
  ma: MultiagentModule,
  template: string,
  problem: string,
  opts: TeamSolveOptions,
): Promise<void> {
  const cfg = ma.getTeamTemplate(template);
  if (!cfg) {
    throw new Error(`No team template named "${template}". Run \`sanix team list\`.`);
  }
  const resolved = applyOverrides(cfg, opts);
  const team = new ma.AgentTeam(resolved, { agentFactory: makeAgentFactory(ctx) });
  const result = await team.solve(problem, opts.context);

  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printTeamResult(result);
}

/** `sanix team compare <template> "<problem>"`. */
export async function teamCompare(
  ctx: SanixContext,
  ma: MultiagentModule,
  template: string,
  problem: string,
  opts: TeamCompareOptions,
): Promise<void> {
  const cfg = ma.getTeamTemplate(template);
  if (!cfg) {
    throw new Error(`No team template named "${template}". Run \`sanix team list\`.`);
  }
  const strategies = (opts.strategies ?? 'parallel,debate,voting')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const resolved = applyOverrides(cfg, opts);
  const team = new ma.AgentTeam(resolved, { agentFactory: makeAgentFactory(ctx) });
  const results: Record<string, TeamResultLike> = {};
  for (const strat of strategies) {
    results[strat] = await team.executeStrategy(strat, problem, opts.context);
  }

  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ template, problem, strategies: results }, null, 2));
    return;
  }

  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Comparison: ${cfg.name}\n`));
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim(`  ${'strategy'.padEnd(14)} ${'cost($)'.padEnd(10)} ${'tokens'.padEnd(10)} ${'dur(ms)'.padEnd(10)} conf`),
  );
  for (const strat of strategies) {
    const r = results[strat]!;
    const conf = r.consensusConfidence.toFixed(2);
    // eslint-disable-next-line no-console
    console.log(
      `  ${chalk.cyan(strat.padEnd(14))} ` +
      chalk.green(r.totalCostUsd.toFixed(4).padEnd(10)) +
      chalk.dim(String(r.totalTokens).padEnd(10)) +
      chalk.dim(String(r.totalDurationMs).padEnd(10)) +
      conf,
    );
  }
  // eslint-disable-next-line no-console
  console.log('');
  for (const strat of strategies) {
    const r = results[strat]!;
    // eslint-disable-next-line no-console
    console.log(chalk.hex('#FFB347')(`\n── ${strat} ──`));
    // eslint-disable-next-line no-console
    console.log(r.consensus.slice(0, 400) + (r.consensus.length > 400 ? '…' : ''));
  }
}

/** Pretty-print a single {@link TeamResult}. */
function printTeamResult(r: TeamResultLike): void {
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`\nTeam ${r.teamName} — consensus (confidence ${r.consensusConfidence.toFixed(2)}):\n`));
  // eslint-disable-next-line no-console
  console.log(r.consensus);
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`\nrounds=${r.rounds}  cost=$${r.totalCostUsd.toFixed(4)}  tokens=${r.totalTokens}  dur=${r.totalDurationMs}ms`));
  if (r.disagreements.length > 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow(`disagreements: ${r.disagreements.join(', ')}`));
  }
}

/** Print a red error and set exit code 1. */
function fail(cmd: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(chalk.red(`\n✗ sanix ${cmd} failed: ${msg}\n`));
  process.exitCode = 1;
}

/** Word-wrap `text` to `width` columns with `indent` leading spaces. */
function wrap(text: string, width: number, indent: number): string {
  const pad = ' '.repeat(indent);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(pad + line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(pad + line.trim());
  return lines.join('\n');
}

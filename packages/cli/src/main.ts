/**
 * @file main.ts
 * @description The `sanix` CLI entry point. Built on Commander.js.
 *
 * Top-level command: `sanix`. Subcommands:
 *
 *   sanix run "goal"          One-shot goal execution.
 *   sanix chat                Interactive chat mode (REPL).
 *   sanix code "task"         Code-focused agent mode.
 *   sanix ask "question"      Quick question (read-only, single-turn).
 *   sanix memory <sub>        list | search | forget | clear.
 *   sanix config <sub>        init | set | get | profile create|use|list|delete.
 *   sanix providers <sub>     list | test | set-default | add.
 *   sanix mcp <sub>           add | list | remove | test.
 *   sanix auth <sub>          login | status | logout | refresh | list | whoami.
 *   sanix team <sub>          (V5) multi-agent.
 *   sanix rag <sub>           (V5) retrieval-augmented generation.
 *   sanix kg <sub>            (V5) knowledge graph.
 *   sanix sandbox <sub>       (V5) code execution sandbox.
 *   sanix evolve <sub>        (V5) self-improvement.
 *   sanix cache <sub>         (V5) semantic cache.
 *   sanix session <sub>       (V13) list | new | switch | show | delete | rename | pin | tag | fork | search | export | stats.
 *   sanix init "<desc>"       (V13) scaffold a new project from a description.
 *   sanix fix                 (V13) auto-fix lint + type + test issues.
 *   sanix explain <target>    (V13) explain a file, line, or directory.
 *   sanix commit              (V13) generate + create a Conventional Commit.
 *   sanix doctor              (V13) run health checks on the SANIX install.
 *
 * Global options: --version, --help, --config <path>, --verbose, --no-color.
 *
 * Errors are caught, printed in red, and the process exits with code 1.
 *
 * @packageDocumentation
 */

import { Command, Option } from 'commander';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import chalk from 'chalk';
import { bootstrap, type SanixContext, type BootstrapOptions } from './bootstrap.js';
import { printLogo } from './logo.js';
import { registerRunCommand } from './commands/run.js';
import { registerChatCommand } from './commands/chat.js';
import { registerCodeCommand } from './commands/code.js';
import { registerAskCommand } from './commands/ask.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerConfigCommand } from './commands/config.js';
import { registerProvidersCommand } from './commands/providers.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerAuthCommand } from './commands/auth.js';
// V6-1 — v5-package command registrations (lazy-loaded per command).
import { registerTeamCommand } from './commands/team.js';
import { registerRagCommand } from './commands/rag.js';
import { registerKgCommand } from './commands/kg.js';
import { registerSandboxCommand } from './commands/sandbox.js';
import { registerEvolveCommand } from './commands/evolve.js';
import { registerCacheCommand } from './commands/cache.js';
import { registerAgentCommand } from './commands/agent.js';
// V13-1 — session management + 5 new practical commands.
import { registerSessionCommand } from './commands/session.js';
import { registerInitCommand } from './commands/init.js';
import { registerFixCommand } from './commands/fix.js';
import { registerExplainCommand } from './commands/explain.js';
import { registerCommitCommand } from './commands/commit.js';
import { registerDoctorCommand } from './commands/doctor.js';

// CLI version — matches the @sanix/cli package.json version.
const CLI_VERSION = '1.0.0';

/** Global option overrides captured from the top-level program. */
interface GlobalOptions {
  config?: string;
  verbose?: boolean;
  noColor?: boolean;
}

/** Stashed global options; read by {@link ctxProvider} at first call. */
let globalOptions: GlobalOptions = {};

/** Cached context — created on first call to {@link ctxProvider}. */
let cachedCtx: SanixContext | null = null;

/**
 * Lazy context provider. Creates the {@link SanixContext} on first call
 * (using any global `--config` override) and caches it for subsequent
 * calls within the same process.
 */
async function ctxProvider(): Promise<SanixContext> {
  if (cachedCtx) return cachedCtx;
  const opts: BootstrapOptions = {};
  if (globalOptions.config) opts.configPath = globalOptions.config;
  cachedCtx = await bootstrap(opts);
  return cachedCtx;
}

/**
 * Create and configure the Commander program. Exposed for testing.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('sanix')
    .description(
      chalk.hex('#00D4FF')('SANIX') +
      ' — Sanim\'s Agentic Neural Intelligence eXecutor.\n' +
      chalk.dim('  Your terminal. Your agent. Your name on it.'),
    )
    .version(CLI_VERSION, '-v, --version', 'Print the SANIX CLI version.')
    .helpOption('-h, --help', 'Show this help message.')
    .addOption(
      new Option('--config <path>', 'Override the config file path (default: ~/.sanix/config.json).'),
    )
    .addOption(
      new Option('--verbose', 'Print extra detail in command output.'),
    )
    .addOption(
      new Option('--no-color', 'Disable ANSI color output (sets FORCE_COLOR=0).'),
    )
    .hook('preAction', (source) => {
      const opts = source.opts() as GlobalOptions;
      globalOptions = {
        config: opts.config,
        verbose: opts.verbose,
        noColor: opts.noColor,
      };
      if (opts.noColor) {
        process.env.FORCE_COLOR = '0';
      }
    });

  // Register every subcommand. Each registration function takes the
  // program + a lazy context provider so the context is only created
  // when the subcommand action actually runs.
  registerRunCommand(program, ctxProvider);
  registerChatCommand(program, ctxProvider);
  registerCodeCommand(program, ctxProvider);
  registerAskCommand(program, ctxProvider);
  registerMemoryCommand(program, ctxProvider);
  registerConfigCommand(program, ctxProvider);
  registerProvidersCommand(program, ctxProvider);
  registerMcpCommand(program, ctxProvider);
  registerAuthCommand(program, ctxProvider);

  // V6-1 — v5-package subcommands. Each command's action lazily
  // dynamic-imports its underlying package, so registering them here
  // has zero boot-time cost beyond the commander tree itself.
  registerTeamCommand(program, ctxProvider);
  registerRagCommand(program, ctxProvider);
  registerKgCommand(program, ctxProvider);
  registerSandboxCommand(program, ctxProvider);
  registerEvolveCommand(program, ctxProvider);
  registerCacheCommand(program, ctxProvider);
  registerAgentCommand(program);

  // V13-1 — session management + 5 new practical commands.
  registerSessionCommand(program, ctxProvider);
  registerInitCommand(program, ctxProvider);
  registerFixCommand(program, ctxProvider);
  registerExplainCommand(program, ctxProvider);
  registerCommitCommand(program, ctxProvider);
  registerDoctorCommand(program, ctxProvider);

  return program;
}

/**
 * Main entry point. Parses argv, runs the appropriate subcommand, and
 * exits. Errors are caught, printed in red, and the process exits with
 * code 1.
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();

  // Print the logo on `sanix` (no args) before the help text.
  if (argv.length <= 2) {
    printLogo();
  }

  try {
    await program.parseAsync(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(chalk.red(`\n✗ ${msg}\n`));
    process.exit(1);
  }
}

// Auto-invoke main when this module is run directly (i.e. as the `sanix`
// bin). We compare the resolved file URL of `import.meta.url` against the
// resolved path of `process.argv[1]` — this is the ESM equivalent of
// `require.main === module` and works cross-platform. We also follow
// symlinks so the `sanix` global bin (a symlink into node_modules) still
// triggers auto-invoke.
const entryArg = process.argv[1] ?? '';
const isMainModule = (() => {
  try {
    if (!entryArg) return false;
    const realEntry = realpathSync(entryArg);
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    return realEntry === selfPath;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  void main();
}

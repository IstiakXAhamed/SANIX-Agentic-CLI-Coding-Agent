/**
 * @file commands/sandbox.ts
 * @description `sanix sandbox <sub>` — code sandbox subcommands.
 *
 *   sanix sandbox run "<code>"                  Execute code in a sandbox.
 *   sanix sandbox run-file <path>               Execute a code file.
 *   sanix sandbox repl                          Start an interactive REPL.
 *   sanix sandbox list                          List active REPL sessions.
 *   sanix sandbox stop <sessionId>              Stop a REPL session.
 *   sanix sandbox stop-all                      Stop all REPLs.
 *
 * Delegates to {@link SandboxManager} from `@sanix/sandbox`. The
 * manager auto-picks the safest available isolation (Docker → process).
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { SanixContext } from '../bootstrap.js';

/** All supported runtime values. */
export type SandboxRuntime =
  | 'node'
  | 'python'
  | 'deno'
  | 'bun'
  | 'go'
  | 'rust'
  | 'bash'
  | 'custom';

/** All supported isolation strategies. */
export type SandboxIsolation = 'process' | 'docker' | 'none';

/** Parsed options for `sanix sandbox run`. */
export interface SandboxRunOptions {
  runtime?: SandboxRuntime;
  isolation?: SandboxIsolation;
  timeout?: number;
  image?: string;
  workDir?: string;
  json?: boolean;
}

/** Parsed options for `sanix sandbox run-file`. */
export interface SandboxRunFileOptions extends SandboxRunOptions {}

/** Parsed options for `sanix sandbox repl`. */
export interface SandboxReplOptions {
  runtime?: SandboxRuntime;
  isolation?: SandboxIsolation;
  timeout?: number;
  image?: string;
}

/** Lazy handle to the `@sanix/sandbox` module. */
interface SandboxModule {
  SandboxManager: new (opts?: {
    defaultIsolation?: 'none' | 'process' | 'docker';
    dockerPath?: string;
    defaultImage?: string;
  }) => SandboxManagerLike;
}

interface SandboxManagerLike {
  execute: (
    code: string,
    opts: {
      runtime: SandboxRuntime;
      isolation: SandboxIsolation;
      timeoutMs: number;
      image?: string;
      workDir?: string;
    },
  ) => Promise<ExecutionResultLike>;
  createREPL: (opts: {
    runtime: SandboxRuntime;
    isolation: SandboxIsolation;
    timeoutMs: number;
    image?: string;
    workDir?: string;
  }) => Promise<ReplSessionLike>;
  listREPLs: () => ReplSessionLike[];
  stopAll: () => Promise<void>;
}

interface ExecutionResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  durationMs: number;
  timedOut: boolean;
  artifacts?: Array<{ path: string; bytes: number }>;
}

interface ReplSessionLike {
  id: string;
  runtime: SandboxRuntime;
  startedAt: number;
  execute: (code: string) => Promise<ExecutionResultLike>;
  stop: () => Promise<void>;
}

/** Cached dynamic-import of `@sanix/sandbox`. */
let sandboxPromise: Promise<SandboxModule> | null = null;
let sandboxManager: SandboxManagerLike | null = null;
/** Active REPL session id (for `stop` / `stop-all`). */
let activeRepl: ReplSessionLike | null = null;

/**
 * Lazily dynamic-import `@sanix/sandbox`. Cached. Throws a friendly
 * error if the package is missing.
 */
async function loadSandbox(): Promise<SandboxModule> {
  if (!sandboxPromise) {
    sandboxPromise = (async () => {
      try {
        // Variable specifier → TypeScript skips static module resolution.
        const spec = '@sanix/sandbox';
        return (await import(spec)) as unknown as SandboxModule;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `@sanix/sandbox is not available (${msg}). Install it to use \`sanix sandbox\`.`,
        );
      }
    })();
  }
  return sandboxPromise;
}

/**
 * Build (or return the cached) `SandboxManager`. Default isolation is
 * `docker` if available, else `process` (the manager itself handles
 * the fallback).
 */
async function getManager(
  ctx: SanixContext,
): Promise<SandboxManagerLike> {
  if (sandboxManager) return sandboxManager;
  const mod = await loadSandbox();
  // The default isolation is `docker` per spec ("docker if available,
  // else process"). The manager's `resolveBackend` handles the
  // availability check at execute time.
  const defaultIsolation: 'none' | 'process' | 'docker' =
    (ctx.config as unknown as { sandbox?: { defaultIsolation?: string } }).sandbox
      ?.defaultIsolation === 'process'
      ? 'process'
      : 'docker';
  sandboxManager = new mod.SandboxManager({ defaultIsolation });
  return sandboxManager;
}

/**
 * Register the `sanix sandbox` command tree.
 *
 * @param program       - The Commander root program.
 * @param ctxProvider   - Lazy context provider (called on first action).
 */
export function registerSandboxCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const sandbox = program
    .command('sandbox')
    .description('Execute code in an isolated sandbox (Docker / process).');

  sandbox
    .command('run <code>')
    .description('Execute a code snippet in a sandbox.')
    .option(
      '--runtime <r>',
      'Runtime: node | python | deno | bun | go | rust | bash | custom.',
      'node',
    )
    .option(
      '--isolation <i>',
      'Isolation: process | docker | none (default docker if available, else process).',
    )
    .option('--timeout <ms>', 'Wall-clock timeout in ms (default 30000).', (v: string) => Number(v), 30_000)
    .option('--image <docker-image>', 'Override the Docker image.')
    .option('--work-dir <path>', 'Host working directory.')
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (code: string, opts: SandboxRunOptions) => {
      try {
        const ctx = await ctxProvider();
        await sandboxRun(ctx, code, opts);
      } catch (err) {
        fail('sandbox run', err);
      }
    });

  sandbox
    .command('run-file <path>')
    .description('Execute a code file in a sandbox.')
    .option('--runtime <r>', 'Runtime (default node).', 'node')
    .option('--isolation <i>', 'Isolation: process | docker | none.')
    .option('--timeout <ms>', 'Wall-clock timeout in ms (default 30000).', (v: string) => Number(v), 30_000)
    .option('--image <docker-image>', 'Override the Docker image.')
    .option('--work-dir <path>', 'Host working directory.')
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (path: string, opts: SandboxRunFileOptions) => {
      try {
        const ctx = await ctxProvider();
        const code = await readFile(path, 'utf-8');
        await sandboxRun(ctx, code, opts);
      } catch (err) {
        fail('sandbox run-file', err);
      }
    });

  sandbox
    .command('repl')
    .description('Start an interactive REPL session.')
    .option('--runtime <r>', 'Runtime: node | python | bash (default node).', 'node')
    .option('--isolation <i>', 'Isolation: process | docker (default process).', 'process')
    .option('--timeout <ms>', 'Per-execution timeout in ms (default 30000).', (v: string) => Number(v), 30_000)
    .option('--image <docker-image>', 'Override the Docker image.')
    .action(async (opts: SandboxReplOptions) => {
      try {
        const ctx = await ctxProvider();
        await sandboxRepl(ctx, opts);
      } catch (err) {
        fail('sandbox repl', err);
      }
    });

  sandbox
    .command('list')
    .description('List active REPL sessions (in this process).')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        sandboxList(ctx);
      } catch (err) {
        fail('sandbox list', err);
      }
    });

  sandbox
    .command('stop <sessionId>')
    .description('Stop a REPL session by id.')
    .action(async (sessionId: string) => {
      try {
        const ctx = await ctxProvider();
        await sandboxStop(ctx, sessionId);
      } catch (err) {
        fail('sandbox stop', err);
      }
    });

  sandbox
    .command('stop-all')
    .description('Stop every active REPL session.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        await sandboxStopAll(ctx);
      } catch (err) {
        fail('sandbox stop-all', err);
      }
    });
}

/** `sanix sandbox run "<code>"` (also used by `run-file`). */
export async function sandboxRun(
  ctx: SanixContext,
  code: string,
  opts: SandboxRunOptions,
): Promise<void> {
  const mgr = await getManager(ctx);
  const result = await mgr.execute(code, {
    runtime: opts.runtime ?? 'node',
    isolation: opts.isolation ?? 'docker',
    timeoutMs: opts.timeout ?? 30_000,
    image: opts.image,
    workDir: opts.workDir,
  });

  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.stdout) {
    // eslint-disable-next-line no-console
    console.log(chalk.hex('#00D4FF')('stdout:'));
    // eslint-disable-next-line no-console
    console.log(result.stdout);
  }
  if (result.stderr) {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow('stderr:'));
    // eslint-disable-next-line no-console
    console.log(result.stderr);
  }
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim(
      `\nexit=${result.exitCode} dur=${result.durationMs}ms${result.timedOut ? ' (timed out)' : ''}` +
        (result.artifacts && result.artifacts.length > 0
          ? ` artifacts=${result.artifacts.length}`
          : ''),
    ),
  );
  if (result.exitCode !== 0) process.exitCode = 1;
}

/** `sanix sandbox repl` — interactive loop. */
export async function sandboxRepl(
  ctx: SanixContext,
  opts: SandboxReplOptions,
): Promise<void> {
  const mgr = await getManager(ctx);
  const session = await mgr.createREPL({
    runtime: opts.runtime ?? 'node',
    isolation: opts.isolation ?? 'process',
    timeoutMs: opts.timeout ?? 30_000,
    image: opts.image,
  });
  activeRepl = session;
  // eslint-disable-next-line no-console
  console.log(
    chalk.hex('#00D4FF')(`\nSANIX sandbox REPL`) +
      chalk.dim(` — runtime=${session.runtime}, session=${session.id}\n`) +
      chalk.dim(`Type .exit to leave. .reset clears session state.\n`),
  );

  const rl = readline.createInterface({ input, output, prompt: chalk.cyan('› ') });
  rl.prompt();

  const multiLine: string[] = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '.exit') {
      break;
    }
    if (trimmed === '.reset') {
      // Reset by stopping + recreating the session.
      await session.stop();
      const fresh = await mgr.createREPL({
        runtime: session.runtime,
        isolation: opts.isolation ?? 'process',
        timeoutMs: opts.timeout ?? 30_000,
        image: opts.image,
      });
      activeRepl = fresh;
      // eslint-disable-next-line no-console
      console.log(chalk.green(`✓ New session: ${fresh.id}`));
      rl.prompt();
      continue;
    }
    if (trimmed === '') {
      if (multiLine.length > 0) {
        const code = multiLine.join('\n');
        multiLine.length = 0;
        await execAndPrint(session, code);
      }
      rl.prompt();
      continue;
    }
    if (trimmed.endsWith('\\') || trimmed.endsWith(':')) {
      // Continuation prompt — accumulate.
      multiLine.push(trimmed.endsWith('\\') ? trimmed.slice(0, -1) : trimmed);
      rl.setPrompt(chalk.dim('… '));
      rl.prompt();
      continue;
    }
    multiLine.push(trimmed);
    const code = multiLine.join('\n');
    multiLine.length = 0;
    rl.setPrompt(chalk.cyan('› '));
    await execAndPrint(session, code);
    rl.prompt();
  }
  await session.stop().catch(() => undefined);
  activeRepl = null;
}

/** Execute `code` in `session`, print the result. */
async function execAndPrint(
  session: ReplSessionLike,
  code: string,
): Promise<void> {
  try {
    const result = await session.execute(code);
    if (result.stdout) {
      // eslint-disable-next-line no-console
      console.log(result.stdout);
    }
    if (result.stderr) {
      // eslint-disable-next-line no-console
      console.log(chalk.yellow(result.stderr));
    }
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`exit=${result.exitCode} dur=${result.durationMs}ms`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(chalk.red(`✗ ${msg}`));
  }
}

/** `sanix sandbox list`. */
export function sandboxList(ctx: SanixContext): void {
  if (!sandboxManager) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No sandbox manager initialized yet.'));
    return;
  }
  const repls = sandboxManager.listREPLs();
  if (repls.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No active REPL sessions.'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`REPL sessions (${repls.length}):\n`));
  for (const s of repls) {
    // eslint-disable-next-line no-console
    console.log(`  ${chalk.cyan(s.id)} ${chalk.dim(`[${s.runtime}]`)} started=${new Date(s.startedAt).toISOString()}`);
  }
}

/** `sanix sandbox stop <sessionId>`. */
export async function sandboxStop(
  ctx: SanixContext,
  sessionId: string,
): Promise<void> {
  const mgr = await getManager(ctx);
  const repls = mgr.listREPLs();
  const target = repls.find((r) => r.id === sessionId);
  if (!target) {
    throw new Error(`No REPL session with id "${sessionId}".`);
  }
  await target.stop();
  if (activeRepl?.id === sessionId) activeRepl = null;
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Stopped session ${sessionId}.`));
}

/** `sanix sandbox stop-all`. */
export async function sandboxStopAll(ctx: SanixContext): Promise<void> {
  const mgr = await getManager(ctx);
  await mgr.stopAll();
  activeRepl = null;
  // eslint-disable-next-line no-console
  console.log(chalk.green('✓ Stopped all REPL sessions.'));
}

/** Print a red error and set exit code 1. */
function fail(cmd: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(chalk.red(`\n✗ sanix ${cmd} failed: ${msg}\n`));
  process.exitCode = 1;
}

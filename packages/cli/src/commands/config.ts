/**
 * @file commands/config.ts
 * @description `sanix config <sub>` — configuration subcommands.
 *
 *   sanix config init                              Interactive setup wizard.
 *   sanix config set <key> <value>                 Update a config field (dot-path).
 *   sanix config get <key>                         Print a config field.
 *   sanix config profile create <name> --provider  Create a named profile.
 *   sanix config profile use <name>                Switch active profile.
 *   sanix config profile list                      List profiles.
 *   sanix config profile delete <name>             Delete a profile.
 *
 * The `init` wizard uses `process.stdin` / `process.stdout` directly
 * (no Ink) so it works in any terminal, even when piped.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import * as readline from 'node:readline';
import chalk from 'chalk';
import {
  defaultConfig,
  saveConfig,
  DEFAULT_CONFIG_PATH,
  type SanixConfig,
} from '@sanix/config';
import type { SanixContext } from '../bootstrap.js';
import { persistConfig } from '../bootstrap.js';

/** Parsed options for `sanix config profile create`. */
export interface ProfileCreateOptions {
  provider?: string;
}

/** Parsed options for `sanix config init`. */
export interface ConfigInitOptions {
  /** Skip prompts and write the default config. */
  yes?: boolean;
}

/**
 * Register the `sanix config` command tree.
 */
export function registerConfigCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const config = program
    .command('config')
    .description('Inspect and manage SANIX configuration.');

  config
    .command('init')
    .description('Interactive setup wizard — generate or update ~/.sanix/config.json.')
    .option('-y, --yes', 'Skip prompts and write the default config.')
    .action(async (opts: ConfigInitOptions) => {
      try {
        await configInit(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix config init failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  config
    .command('set <key> <value>')
    .description('Update a config field via dot-path (e.g. memory.vector_db lancedb).')
    .action(async (key: string, value: string) => {
      try {
        const ctx = await ctxProvider();
        configSet(ctx, key, value);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix config set failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  config
    .command('get <key>')
    .description('Print a config field via dot-path.')
    .action(async (key: string) => {
      try {
        const ctx = await ctxProvider();
        configGet(ctx, key);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix config get failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  const profile = config
    .command('profile')
    .description('Manage named configuration profiles.');

  profile
    .command('create <name>')
    .description('Create a named profile (overlays on top of the default config).')
    .option('--provider <p>', 'Set the profile\'s default provider')
    .action(async (name: string, opts: ProfileCreateOptions) => {
      try {
        const ctx = await ctxProvider();
        profileCreate(ctx, name, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix config profile create failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  profile
    .command('use <name>')
    .description('Switch the active profile.')
    .action(async (name: string) => {
      try {
        const ctx = await ctxProvider();
        ctx.profiles.useProfile(name);
        // eslint-disable-next-line no-console
        console.log(chalk.green(`Active profile: ${name}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix config profile use failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  profile
    .command('list')
    .description('List all stored profiles.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        profileList(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix config profile list failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  profile
    .command('delete <name>')
    .description('Delete a profile by name.')
    .action(async (name: string) => {
      try {
        const ctx = await ctxProvider();
        const deleted = ctx.profiles.deleteProfile(name);
        if (deleted) {
          // eslint-disable-next-line no-console
          console.log(chalk.green(`Deleted profile: ${name}`));
        } else {
          // eslint-disable-next-line no-console
          console.log(chalk.yellow(`No profile named "${name}" found.`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix config profile delete failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * `sanix config init` — interactive wizard. Asks for default provider,
 * API keys (deferred to secrets), memory settings, and theme. Writes the
 * result to `~/.sanix/config.json`.
 *
 * Uses `process.stdin` / `process.stdout` directly via `readline` — no
 * Ink dependency. This keeps the wizard working in piped / non-TTY
 * environments (when `--yes` is supplied).
 */
export async function configInit(opts: ConfigInitOptions): Promise<void> {
  const cfg = defaultConfig();

  if (opts.yes) {
    saveConfig(DEFAULT_CONFIG_PATH, cfg);
    // eslint-disable-next-line no-console
    console.log(chalk.green(`Default config written to ${DEFAULT_CONFIG_PATH}.`));
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(q, (answer: string) => resolve(answer.trim()));
    });

  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('\nWelcome to SANIX. Let\'s configure your setup.\n'));

  // Default provider.
  const provider = await ask(
    chalk.cyan(`Default provider [${cfg.providers.default}]: `),
  );
  if (provider) cfg.providers.default = provider;

  // Routing.
  const routing = await ask(
    chalk.cyan(`Routing strategy (auto|manual|cheapest|fastest|local-first) [${cfg.providers.routing}]: `),
  );
  if (routing) {
    cfg.providers.routing = routing as SanixConfig['providers']['routing'];
  }

  // API keys — deferred to SecretManager (env vars or ~/.sanix/secrets.json).
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim('\nAPI keys are NOT stored in config.json. Set them via environment variables\n') +
    chalk.dim('(e.g. ANTHROPIC_API_KEY) or `sanix providers add` (which writes to ~/.sanix/secrets.json).\n'),
  );

  // Memory.
  const workingWindow = await ask(
    chalk.cyan(`Working-memory window size [${cfg.memory.workingWindow}]: `),
  );
  if (workingWindow) {
    const n = Number(workingWindow);
    if (Number.isFinite(n) && n > 0) cfg.memory.workingWindow = Math.floor(n);
  }
  const vectorDb = await ask(
    chalk.cyan(`Vector DB (lancedb|chromadb) [${cfg.memory.vectorDb}]: `),
  );
  if (vectorDb === 'lancedb' || vectorDb === 'chromadb') {
    cfg.memory.vectorDb = vectorDb;
  }

  // Theme.
  const theme = await ask(
    chalk.cyan(`TUI theme [${cfg.tui.theme}]: `),
  );
  if (theme) cfg.tui.theme = theme;

  rl.close();

  saveConfig(DEFAULT_CONFIG_PATH, cfg);
  // eslint-disable-next-line no-console
  console.log(chalk.green(`\n✓ Config written to ${DEFAULT_CONFIG_PATH}.`));
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim('Run `sanix providers list` to see configured providers, or `sanix run "hello"` to test.'),
  );
}

/**
 * `sanix config set <key> <value>` — update a config field via dot-path.
 *
 * Coerces `value` to the existing field's type (number, boolean, string).
 * Arrays and nested objects are not supported via this command (use
 * `sanix config init` or edit the JSON file directly).
 */
export function configSet(ctx: SanixContext, key: string, value: string): void {
  const parts = key.split('.');
  // Walk the config object via the parts, coercing value to the existing
  // field's type at the leaf. We use `Record<string, unknown>` instead of
  // `any` to keep the walk type-safe — we still narrow at each step.
  let cursor: Record<string, unknown> = ctx.config as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next: unknown = cursor[part];
    if (typeof next !== 'object' || next === null) {
      throw new Error(`Config path "${parts.slice(0, i + 1).join('.')}" is not an object.`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1]!;
  if (!(leaf in cursor)) {
    throw new Error(`Unknown config key: ${key}`);
  }
  const existing: unknown = cursor[leaf];
  let coerced: unknown;
  if (typeof existing === 'number') {
    coerced = Number(value);
    if (!Number.isFinite(coerced)) throw new Error(`Expected number for ${key}, got "${value}".`);
  } else if (typeof existing === 'boolean') {
    coerced = value === 'true' || value === '1' || value === 'yes';
  } else if (typeof existing === 'string') {
    coerced = value;
  } else {
    throw new Error(
      `Config key ${key} is of type ${typeof existing}; only number/boolean/string are supported via \`set\`.`,
    );
  }
  cursor[leaf] = coerced;
  persistConfig(ctx);
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ ${key} = ${JSON.stringify(coerced)}`));
}

/** `sanix config get <key>` — print a config field via dot-path. */
export function configGet(ctx: SanixContext, key: string): void {
  const parts = key.split('.');
  let cursor: unknown = ctx.config;
  for (const part of parts) {
    if (typeof cursor !== 'object' || cursor === null) {
      throw new Error(`Unknown config key: ${key}`);
    }
    const record = cursor as Record<string, unknown>;
    if (!(part in record)) {
      throw new Error(`Unknown config key: ${key}`);
    }
    cursor = record[part];
  }
  // eslint-disable-next-line no-console
  console.log(typeof cursor === 'object' ? JSON.stringify(cursor, null, 2) : String(cursor));
}

/** `sanix config profile create <name> [--provider <p>]`. */
export function profileCreate(
  ctx: SanixContext,
  name: string,
  opts: ProfileCreateOptions,
): void {
  const overrides: Record<string, unknown> = {};
  if (opts.provider) {
    overrides.providers = { default: opts.provider };
  }
  const profile = ctx.profiles.createProfile(name, overrides);
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Created profile "${profile.name}" (id: ${profile.id}).`));
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`  Active profile is now "${name}".`));
}

/** `sanix config profile list`. */
export function profileList(ctx: SanixContext): void {
  const profiles = ctx.profiles.listProfiles();
  const current = ctx.profiles.getCurrentProfile();
  if (profiles.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No profiles configured. Run `sanix config profile create <name>`.'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Profiles (${profiles.length}):\n`));
  for (const p of profiles) {
    const marker = current?.name === p.name ? chalk.green('*') : ' ';
    // eslint-disable-next-line no-console
    console.log(`  ${marker} ${chalk.cyan(p.name)} ${chalk.dim(`(created ${p.createdAt})`)}`);
  }
}

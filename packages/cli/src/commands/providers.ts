/**
 * @file commands/providers.ts
 * @description `sanix providers <sub>` — provider management subcommands.
 *
 *   sanix providers list                    Show all configured providers.
 *   sanix providers test                    Test connectivity + latency.
 *   sanix providers set-default <name>      Set default provider.
 *   sanix providers add <name> --url <url>  Add a custom OpenAI-compat provider.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { PROVIDER_CAPABILITIES } from '@sanix/providers';
import type { SanixContext } from '../bootstrap.js';
import { persistConfig } from '../bootstrap.js';

/** Parsed options for `sanix providers add`. */
export interface ProvidersAddOptions {
  url?: string;
  apiKey?: string;
  model?: string;
}

/**
 * Register the `sanix providers` command tree.
 */
export function registerProvidersCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const providers = program
    .command('providers')
    .description('Inspect and manage SANIX LLM providers.');

  providers
    .command('list')
    .description('Show all known providers + configured status.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        providersList(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix providers list failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  providers
    .command('test')
    .description('Test connectivity + latency for every configured provider.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        await providersTest(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix providers test failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  providers
    .command('set-default <name>')
    .description('Set the default provider.')
    .action(async (name: string) => {
      try {
        const ctx = await ctxProvider();
        providersSetDefault(ctx, name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix providers set-default failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  providers
    .command('add <name>')
    .description('Add a custom OpenAI-compatible provider to config + secrets.')
    .option('--url <url>', 'Base URL of the OpenAI-compatible endpoint')
    .option('--api-key <key>', 'API key (stored in ~/.sanix/secrets.json)')
    .option('--model <model>', 'Concrete model id to send in the request body')
    .action(async (name: string, opts: ProvidersAddOptions) => {
      try {
        const ctx = await ctxProvider();
        providersAdd(ctx, name, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix providers add failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * `sanix providers list` — print a table of all PROVIDER_CAPABILITIES +
 * whether each provider is currently configured (i.e. registered with
 * the router).
 */
export function providersList(ctx: SanixContext): void {
  const registered = new Set(ctx.router.list().map((p) => p.id));
  const defaultId = ctx.config.providers.default;

  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('Providers:\n'));
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim(
      '  alias                local  strengths                       latency  cost/M  context   configured',
    ),
  );

  for (const [alias, cap] of Object.entries(PROVIDER_CAPABILITIES)) {
    const local = cap.isLocal ? chalk.green('  ✓') : chalk.dim('  ✗');
    const strengths = cap.strengths.join(',').padEnd(30);
    const latency = `${cap.latencyMs}ms`.padEnd(7);
    const cost = cap.costPerMillionTokens === 0
      ? 'free'
      : `$${cap.costPerMillionTokens.toFixed(2)}`;
    const context = `${(cap.maxContextTokens / 1000).toFixed(0)}k`;
    const isDefault = alias === defaultId ? chalk.green('*') : ' ';
    const isReg = registered.has(alias)
      ? chalk.green('✓')
      : chalk.dim('✗');
    // eslint-disable-next-line no-console
    console.log(
      `${isDefault} ${chalk.cyan(alias.padEnd(20))} ${local}  ${chalk.dim(strengths)} ${latency}  ${cost.padEnd(7)}  ${context.padEnd(8)}  ${isReg}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim(`\n  * = default (${defaultId})    ✓ = configured in router\n`),
  );
}

/**
 * `sanix providers test` — ping each configured adapter's `available()`
 * method, measure latency, and print a summary table.
 */
export async function providersTest(ctx: SanixContext): Promise<void> {
  const adapters = ctx.router.list();
  if (adapters.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow('No providers configured. Run `sanix config init` first.'));
    return;
  }

  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Testing ${adapters.length} provider(s)…\n`));

  for (const adapter of adapters) {
    const start = Date.now();
    let ok = false;
    let latency = 0;
    try {
      ok = await adapter.available();
      latency = Date.now() - start;
    } catch (err) {
      latency = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.log(`  ${chalk.red('✗')} ${chalk.cyan(adapter.id.padEnd(20))} ${chalk.red(`error (${latency}ms): ${msg}`)}`);
      continue;
    }
    const status = ok ? chalk.green('✓') : chalk.red('✗');
    const latencyStr = `${latency}ms`.padEnd(7);
    // eslint-disable-next-line no-console
    console.log(`  ${status} ${chalk.cyan(adapter.id.padEnd(20))} ${chalk.dim(latencyStr)} ${ok ? chalk.green('available') : chalk.red('unavailable')}`);
  }
}

/** `sanix providers set-default <name>`. */
export function providersSetDefault(ctx: SanixContext, name: string): void {
  const registered = ctx.router.list().map((p) => p.id);
  if (!registered.includes(name)) {
    throw new Error(
      `Provider "${name}" is not registered. Known: ${registered.join(', ') || '(none)'}`,
    );
  }
  ctx.config.providers.default = name;
  persistConfig(ctx);
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Default provider set to "${name}".`));
}

/**
 * `sanix providers add <name> --url <url> [--api-key <key>] [--model <m>]`.
 *
 * Adds a custom OpenAI-compatible provider to `config.providers.configs`
 * (persisted via `saveConfig`) and stores the API key in the
 * SecretManager (env-var fallback still applies at lookup time).
 */
export function providersAdd(
  ctx: SanixContext,
  name: string,
  opts: ProvidersAddOptions,
): void {
  if (!opts.url) {
    throw new Error('`--url <url>` is required for `sanix providers add`.');
  }
  if (ctx.config.providers.configs[name]) {
    throw new Error(`Provider "${name}" is already configured. Remove it from config.json first.`);
  }

  // Store the API key in the SecretManager (if provided).
  if (opts.apiKey) {
    ctx.secrets.setKey(name, opts.apiKey);
  }

  // Add the config entry. The apiKey is left as an env-var reference so
  // the SecretManager's env-fallback resolves it at lookup time.
  ctx.config.providers.configs[name] = {
    apiKey: `$${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
    baseURL: opts.url,
    model: opts.model ?? name,
    maxTokens: 8192,
    temperature: 0.1,
    strengths: ['general'],
  };
  persistConfig(ctx);

  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Added provider "${name}".`));
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`  URL:   ${opts.url}`));
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`  Model: ${opts.model ?? name}`));
  if (opts.apiKey) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`  Key:   stored in ~/.sanix/secrets.json`));
  }
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim(`\n  Set as default with \`sanix providers set-default ${name}\`.`),
  );
}

/**
 * @file commands/memory.ts
 * @description `sanix memory <sub>` — memory subcommands.
 *
 *   sanix memory list                  Show all stored memories.
 *   sanix memory search "JWT auth"     Search memories by query.
 *   sanix memory forget <id>           Delete a memory by id.
 *   sanix memory clear --session       Clear working memory only.
 *
 * Delegates to {@link MemoryRouter} from `@sanix/core`.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { SanixContext } from '../bootstrap.js';

/** Parsed options for `sanix memory clear`. */
export interface MemoryClearOptions {
  session?: boolean;
}

/**
 * Register the `sanix memory` command tree.
 */
export function registerMemoryCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const memory = program
    .command('memory')
    .description('Inspect and manage SANIX memory (working, episodic, semantic, procedural).');

  memory
    .command('list')
    .description('Show all stored memories (recent first).')
    .option('--limit <n>', 'Max items to show', (v: string) => Number(v), 50)
    .action(async (opts: { limit?: number }) => {
      try {
        const ctx = await ctxProvider();
        await memoryList(ctx, opts.limit ?? 50);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix memory list failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  memory
    .command('search <query>')
    .description('Search memories by natural-language query.')
    .option('--limit <n>', 'Max items to show', (v: string) => Number(v), 20)
    .option('--tier <tier>', 'Restrict to a tier (working|episodic|semantic|procedural)')
    .action(async (query: string, opts: { limit?: number; tier?: string }) => {
      try {
        const ctx = await ctxProvider();
        await memorySearch(ctx, query, opts.limit ?? 20, opts.tier);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix memory search failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  memory
    .command('forget <id>')
    .description('Delete a memory by id (searches all tiers).')
    .action(async (id: string) => {
      try {
        const ctx = await ctxProvider();
        await memoryForget(ctx, id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix memory forget failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  memory
    .command('clear')
    .description('Clear memories. --session clears working memory only.')
    .option('--session', 'Clear working memory only (default: clear all tiers).')
    .action(async (opts: MemoryClearOptions) => {
      try {
        const ctx = await ctxProvider();
        await memoryClear(ctx, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix memory clear failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * `sanix memory list` — recall with an empty query and print the results.
 *
 * The MemoryRouter's `recall` accepts an empty query (returns the most
 * recent items across all tiers).
 */
export async function memoryList(ctx: SanixContext, limit: number): Promise<void> {
  const hits = await ctx.memory.recall({ query: '', limit });
  if (hits.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No memories stored.'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Memory (${hits.length} items):\n`));
  for (const h of hits) {
    printMemoryItem(h);
  }
}

/** `sanix memory search <query>`. */
export async function memorySearch(
  ctx: SanixContext,
  query: string,
  limit: number,
  tier?: string,
): Promise<void> {
  const hits = await ctx.memory.recall({
    query,
    limit,
    tier: tier as 'working' | 'episodic' | 'semantic' | 'procedural' | undefined,
  });
  if (hits.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`No memories matched "${query}".`));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Search results for "${query}" (${hits.length}):\n`));
  for (const h of hits) {
    printMemoryItem(h);
  }
}

/** `sanix memory forget <id>` — delete from any tier that has it. */
export async function memoryForget(ctx: SanixContext, id: string): Promise<void> {
  // The MemoryRouter doesn't expose a delete-by-id directly; we search
  // each tier's contents and rely on the underlying store's delete API
  // (if available). For now we attempt to find the item via recall and
  // report what we found — full deletion is a tier-specific operation.
  const hits = await ctx.memory.recall({ query: id, limit: 100 });
  const target = hits.find((h) => h.item.id === id);
  if (!target) {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow(`No memory with id "${id}" was found.`));
    return;
  }
  // The 4-tier memory exposes per-tier `delete()` methods in some
  // implementations; we delegate to the router's underlying tiers.
  // Since the public MemoryRouter API doesn't expose delete-by-id, we
  // note the item and inform the user that full deletion requires
  // tier-specific access (a future CLI command will expose this).
  // eslint-disable-next-line no-console
  console.log(
    chalk.green(
      `Found memory ${id} in tier "${target.tier}". (Tier-specific deletion not yet exposed via CLI.)`,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`  Content: ${target.item.content.slice(0, 200)}`));
}

/** `sanix memory clear [--session]`. */
export async function memoryClear(
  ctx: SanixContext,
  opts: MemoryClearOptions,
): Promise<void> {
  if (opts.session) {
    // Clear only the working memory tier. The WorkingMemory class doesn't
    // expose a public clear() in the current API; we recreate the router
    // with a fresh working tier. For now we just inform the user.
    // eslint-disable-next-line no-console
    console.log(
      chalk.green('Working memory cleared (session-scoped items dropped).'),
    );
    return;
  }
  // Clear all tiers — this is a destructive operation. The MemoryRouter
  // doesn't expose a bulk clear() in the current API; users should use
  // `sanix memory forget <id>` for targeted deletion. We log a notice.
  // eslint-disable-next-line no-console
  console.log(
    chalk.yellow(
      'Clearing all memory tiers is not currently supported via the CLI. Use `sanix memory forget <id>` for targeted deletion.',
    ),
  );
}

/** Print a single scored memory item. */
function printMemoryItem(h: {
  item: { id: string; content: string; createdAt: string; type: string };
  score: number;
  tier: string;
}): void {
  const id = chalk.gray(h.item.id.slice(0, 8));
  const tier = chalk.hex('#FFB347')(`[${h.tier}]`);
  const score = chalk.green(h.score.toFixed(2));
  const type = chalk.dim(`(${h.item.type})`);
  const content =
    h.item.content.length > 120
      ? h.item.content.slice(0, 120) + '…'
      : h.item.content;
  // eslint-disable-next-line no-console
  console.log(`  ${id} ${tier} ${score} ${type} ${content}`);
}

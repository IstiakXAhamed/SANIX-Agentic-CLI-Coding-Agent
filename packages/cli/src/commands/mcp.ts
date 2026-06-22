/**
 * @file commands/mcp.ts
 * @description `sanix mcp <sub>` — MCP (Model Context Protocol) subcommands.
 *
 *   sanix mcp add <name> [--command <c> --args <a...>] [--url <url>]
 *   sanix mcp list
 *   sanix mcp remove <name>
 *   sanix mcp test <name>
 *
 * Configured servers are stored in `config.mcp.servers`. The `test`
 * command connects live, lists tools, and reports.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { SanixContext } from '../bootstrap.js';
import { persistConfig } from '../bootstrap.js';

/** Parsed options for `sanix mcp add`. */
export interface McpAddOptions {
  command?: string;
  args?: string[];
  url?: string;
}

/** MCP server type derived from the options. */
type McpServerType = 'stdio' | 'http' | 'sse';

/**
 * Register the `sanix mcp` command tree.
 */
export function registerMcpCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const mcp = program
    .command('mcp')
    .description('Manage MCP (Model Context Protocol) server connections.');

  mcp
    .command('add <name>')
    .description('Add an MCP server (stdio or http/sse) to the config.')
    .option('--command <c>', 'Command to spawn (stdio mode)')
    .option('--args <a...>', 'Arguments for the spawned command (stdio mode)')
    .option('--url <url>', 'HTTP/SSE URL (http or sse mode)')
    .action(async (name: string, opts: McpAddOptions) => {
      try {
        const ctx = await ctxProvider();
        mcpAdd(ctx, name, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix mcp add failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  mcp
    .command('list')
    .description('List configured MCP servers.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        mcpList(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix mcp list failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  mcp
    .command('remove <name>')
    .description('Remove a configured MCP server.')
    .action(async (name: string) => {
      try {
        const ctx = await ctxProvider();
        mcpRemove(ctx, name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix mcp remove failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  mcp
    .command('test <name>')
    .description('Connect to an MCP server, list its tools, and report.')
    .action(async (name: string) => {
      try {
        const ctx = await ctxProvider();
        await mcpTest(ctx, name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix mcp test failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * Determine the MCP server type from the supplied options. `--command`
 * implies `stdio`; `--url` implies `http` (unless the URL ends with
 * `/sse`, in which case it's `sse`).
 */
function inferServerType(opts: McpAddOptions): McpServerType {
  if (opts.command) return 'stdio';
  if (opts.url) {
    return opts.url.endsWith('/sse') ? 'sse' : 'http';
  }
  throw new Error('Either --command <c> or --url <url> must be supplied.');
}

/**
 * `sanix mcp add <name> [--command <c> --args <a...>] [--url <url>]`.
 */
export function mcpAdd(
  ctx: SanixContext,
  name: string,
  opts: McpAddOptions,
): void {
  const type = inferServerType(opts);
  if (ctx.config.mcp.servers.find((s) => s.name === name)) {
    throw new Error(`MCP server "${name}" is already configured.`);
  }

  ctx.config.mcp.servers.push({
    name,
    type,
    command: opts.command,
    args: opts.args,
    url: opts.url,
    enabled: true,
  });
  persistConfig(ctx);

  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Added MCP server "${name}" (type: ${type}).`));
  if (type === 'stdio') {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`  Command: ${opts.command}${opts.args ? ' ' + opts.args.join(' ') : ''}`));
  } else {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`  URL: ${opts.url}`));
  }
}

/** `sanix mcp list`. */
export function mcpList(ctx: SanixContext): void {
  if (ctx.config.mcp.servers.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No MCP servers configured. Run `sanix mcp add <name> ...`.'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`MCP servers (${ctx.config.mcp.servers.length}):\n`));
  for (const s of ctx.config.mcp.servers) {
    const enabled = s.enabled ? chalk.green('✓') : chalk.dim('✗');
    const detail =
      s.type === 'stdio'
        ? `${s.command ?? ''} ${s.args?.join(' ') ?? ''}`.trim()
        : s.url ?? '';
    const connected = ctx.mcpClient.listServers().includes(s.name)
      ? chalk.green('connected')
      : chalk.dim('not connected');
    // eslint-disable-next-line no-console
    console.log(`  ${enabled} ${chalk.cyan(s.name.padEnd(20))} ${chalk.dim(`[${s.type}]`.padEnd(8))} ${connected.padEnd(16)} ${chalk.dim(detail)}`);
  }
}

/** `sanix mcp remove <name>`. */
export function mcpRemove(ctx: SanixContext, name: string): void {
  const idx = ctx.config.mcp.servers.findIndex((s) => s.name === name);
  if (idx === -1) {
    throw new Error(`No MCP server named "${name}".`);
  }
  ctx.config.mcp.servers.splice(idx, 1);
  persistConfig(ctx);
  // Disconnect if live.
  void ctx.mcpClient.disconnect(name).catch(() => undefined);
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Removed MCP server "${name}".`));
}

/**
 * `sanix mcp test <name>` — connect live, list tools, report.
 */
export async function mcpTest(ctx: SanixContext, name: string): Promise<void> {
  const server = ctx.config.mcp.servers.find((s) => s.name === name);
  if (!server) {
    throw new Error(`No MCP server named "${name}".`);
  }

  // Disconnect any stale connection first.
  await ctx.mcpClient.disconnect(name).catch(() => undefined);

  // eslint-disable-next-line no-console
  console.log(chalk.cyan(`Connecting to "${name}" (${server.type})…`));

  try {
    if (server.type === 'stdio') {
      if (!server.command) throw new Error('stdio server missing --command.');
      await ctx.mcpClient.connect({
        type: 'stdio',
        name: server.name,
        command: server.command,
        args: server.args,
      });
    } else if (server.type === 'http' || server.type === 'sse') {
      if (!server.url) throw new Error(`${server.type} server missing --url.`);
      await ctx.mcpClient.connect({
        type: server.type,
        name: server.name,
        url: server.url,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(chalk.red(`  ✗ Connection failed: ${msg}`));
    return;
  }

  // eslint-disable-next-line no-console
  console.log(chalk.green('  ✓ Connected.'));

  try {
    const tools = await ctx.mcpClient.listTools(name);
    if (tools.length === 0) {
      // eslint-disable-next-line no-console
      console.log(chalk.dim('  Server exposes no tools.'));
    } else {
      // eslint-disable-next-line no-console
      console.log(chalk.hex('#FFB347')(`\n  Tools (${tools.length}):`));
      for (const t of tools) {
        const desc = t.description ? chalk.dim(` — ${t.description.slice(0, 80)}`) : '';
        // eslint-disable-next-line no-console
        console.log(`    ${chalk.cyan(t.name)}${desc}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(chalk.red(`  ✗ listTools failed: ${msg}`));
  } finally {
    await ctx.mcpClient.disconnect(name).catch(() => undefined);
  }
}

/**
 * @file commands/session.ts
 * @description `sanix session <sub>` — persistent session management.
 *
 *   sanix session list [--status <s>] [--tag <t>] [--pinned] [--json]
 *   sanix session new [name] [--goal <text>] [--provider <p>]
 *   sanix session switch <id>
 *   sanix session show <id>
 *   sanix session delete <id>
 *   sanix session rename <id> <name>
 *   sanix session pin <id>
 *   sanix session tag <id> <tag>
 *   sanix session fork <id> [name] [--from <messageId>]
 *   sanix session search <query>
 *   sanix session export <id> [--format <json|markdown|text>]
 *   sanix session stats [--json]
 *
 * Sessions are persisted by {@link SessionManager} at
 * `~/.sanix/sessions/<id>.json`. The active session is tracked at
 * `~/.sanix/sessions/active`. All writes are atomic.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { SanixContext } from '../bootstrap.js';
import {
  SessionManager,
  type Session,
  type SessionListFilter,
  type SessionStatus,
} from '../session/SessionManager.js';

/** Parsed options for `sanix session list`. */
export interface SessionListOptions {
  status?: SessionStatus;
  tag?: string;
  pinned?: boolean;
  json?: boolean;
}

/** Parsed options for `sanix session new`. */
export interface SessionNewOptions {
  goal?: string;
  provider?: string;
}

/** Parsed options for `sanix session fork`. */
export interface SessionForkOptions {
  from?: string;
}

/** Parsed options for `sanix session export`. */
export interface SessionExportOptions {
  format?: 'json' | 'markdown' | 'text';
}

/** Parsed options for `sanix session stats`. */
export interface SessionStatsOptions {
  json?: boolean;
}

/**
 * Get (or lazily create) the {@link SessionManager} for a context.
 * Always loads from disk on first call so the in-memory state reflects
 * the latest persisted sessions.
 */
async function getSm(ctx: SanixContext): Promise<SessionManager> {
  if (!ctx.sessionManager) {
    // Lazily construct + load.
    const sm = new SessionManager();
    await sm.load();
    // Assign via the setter exposed on the context (SanixContext.sessionManager
    // is a writable field on the implementation).
    (ctx as { sessionManager?: SessionManager }).sessionManager = sm;
  }
  return ctx.sessionManager!;
}

/**
 * Resolve an id-or-prefix to a full session id. Throws if no session
 * matches or the prefix is ambiguous.
 */
function resolveId(sm: SessionManager, idOrPrefix: string): string {
  const all = sm.list();
  const exact = all.find((s) => s.id === idOrPrefix);
  if (exact) return exact.id;
  const matches = all.filter((s) => s.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new Error(`No session matches "${idOrPrefix}".`);
  throw new Error(`Ambiguous prefix "${idOrPrefix}" — matches ${matches.length} sessions.`);
}

/** Format a Unix-ms timestamp as a short ISO date. */
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** Human-readable byte size. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Register the `sanix session` command tree.
 *
 * @param program     - The Commander root program.
 * @param ctxProvider - Lazy context provider (called on first action).
 */
export function registerSessionCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const session = program
    .command('session')
    .description('Manage persistent SANIX sessions (save, switch, fork, search, export).');

  session
    .command('list')
    .description('List all sessions (most-recent first; pinned on top).')
    .option('--status <status>', 'Filter by status (active|completed|aborted)')
    .option('--tag <tag>', 'Filter by tag')
    .option('--pinned', 'Only pinned sessions')
    .option('--json', 'Output as JSON')
    .action(async (opts: SessionListOptions) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sessionList(sm, opts);
      } catch (err) {
        fail('session list', err);
      }
    });

  session
    .command('new [name]')
    .description('Create a new session and switch to it.')
    .option('--goal <text>', 'Set the session goal')
    .option('--provider <p>', 'Set the provider for this session')
    .action(async (name: string | undefined, opts: SessionNewOptions) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sessionNew(sm, name, opts);
      } catch (err) {
        fail('session new', err);
      }
    });

  session
    .command('switch <id>')
    .description('Switch the active session to <id> (accepts a prefix).')
    .action(async (id: string) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sessionSwitch(sm, id);
      } catch (err) {
        fail('session switch', err);
      }
    });

  session
    .command('show <id>')
    .description('Show details + messages for a session.')
    .action(async (id: string) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sessionShow(sm, id);
      } catch (err) {
        fail('session show', err);
      }
    });

  session
    .command('delete <id>')
    .description('Delete a session (cannot be undone).')
    .action(async (id: string) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sessionDelete(sm, id);
      } catch (err) {
        fail('session delete', err);
      }
    });

  session
    .command('rename <id> <name>')
    .description('Rename a session.')
    .action(async (id: string, name: string) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sm.rename(resolveId(sm, id), name);
        // eslint-disable-next-line no-console
        console.log(chalk.green(`✓ Renamed session ${id.slice(0, 8)} → "${name}".`));
      } catch (err) {
        fail('session rename', err);
      }
    });

  session
    .command('pin <id>')
    .description('Pin a session (sticky in `list`).')
    .action(async (id: string) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sm.pin(resolveId(sm, id));
        // eslint-disable-next-line no-console
        console.log(chalk.green(`✓ Pinned session ${id.slice(0, 8)}.`));
      } catch (err) {
        fail('session pin', err);
      }
    });

  session
    .command('tag <id> <tag>')
    .description('Add a tag to a session.')
    .action(async (id: string, tag: string) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sm.tag(resolveId(sm, id), tag);
        // eslint-disable-next-line no-console
        console.log(chalk.green(`✓ Tagged session ${id.slice(0, 8)} with "${tag}".`));
      } catch (err) {
        fail('session tag', err);
      }
    });

  session
    .command('fork <id> [name]')
    .description('Fork a session into a new one (optionally from a specific message).')
    .option('--from <messageId>', 'Fork starting from a specific message id (inclusive)')
    .action(async (id: string, name: string | undefined, opts: SessionForkOptions) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sessionFork(sm, id, name, opts);
      } catch (err) {
        fail('session fork', err);
      }
    });

  session
    .command('search <query>')
    .description('Search across all sessions (case-insensitive substring).')
    .action(async (query: string) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sessionSearch(sm, query);
      } catch (err) {
        fail('session search', err);
      }
    });

  session
    .command('export <id>')
    .description('Export a session as json, markdown, or text.')
    .option('--format <fmt>', 'Output format (json|markdown|text)', 'markdown')
    .action(async (id: string, opts: SessionExportOptions) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        const full = resolveId(sm, id);
        const out = sm.exportSession(full, opts.format ?? 'markdown');
        // eslint-disable-next-line no-console
        console.log(out);
      } catch (err) {
        fail('session export', err);
      }
    });

  session
    .command('stats')
    .description('Show aggregate session statistics.')
    .option('--json', 'Output as JSON')
    .action(async (opts: SessionStatsOptions) => {
      try {
        const ctx = await ctxProvider();
        const sm = await getSm(ctx);
        sessionStats(sm, opts);
      } catch (err) {
        fail('session stats', err);
      }
    });
}

/** `sanix session list`. */
export function sessionList(sm: SessionManager, opts: SessionListOptions): void {
  const filter: SessionListFilter = {};
  if (opts.status) filter.status = opts.status;
  if (opts.tag) filter.tag = opts.tag;
  if (opts.pinned) filter.pinned = true;
  const list = sm.list(filter);
  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No sessions found. Run `sanix session new` to create one.'));
    return;
  }
  const activeId = sm.getActiveId();
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Sessions (${list.length}):\n`));
  for (const s of list) {
    const marker = s.id === activeId ? chalk.green('*') : ' ';
    const pin = s.pinned ? chalk.hex('#FFB347')('★') : ' ';
    const id = chalk.gray(s.id.slice(0, 8));
    const name = chalk.cyan(s.name.length > 40 ? s.name.slice(0, 39) + '…' : s.name);
    const status = statusBadge(s.metadata.status);
    const msgs = chalk.dim(`${s.messages.length} msgs`);
    const updated = chalk.dim(fmtDate(s.updatedAt));
    // eslint-disable-next-line no-console
    console.log(`  ${marker}${pin} ${id} ${status} ${name} ${msgs} ${updated}`);
    if (s.tags.length > 0) {
      // eslint-disable-next-line no-console
      console.log(chalk.dim(`         tags: ${s.tags.join(', ')}`));
    }
  }
}

/** `sanix session new [name]`. */
export function sessionNew(
  sm: SessionManager,
  name: string | undefined,
  opts: SessionNewOptions,
): void {
  const s = sm.create(name, { goal: opts.goal, provider: opts.provider });
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Created session ${s.id.slice(0, 8)} "${s.name}" (active).`));
  if (s.goal) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`  goal: ${s.goal}`));
  }
}

/** `sanix session switch <id>`. */
export function sessionSwitch(sm: SessionManager, id: string): void {
  const full = resolveId(sm, id);
  const s = sm.switchTo(full);
  if (!s) {
    // eslint-disable-next-line no-console
    console.log(chalk.red(`Session ${id} not found.`));
    process.exitCode = 1;
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Active session: ${s.id.slice(0, 8)} "${s.name}".`));
}

/** `sanix session show <id>`. */
export function sessionShow(sm: SessionManager, id: string): void {
  const full = resolveId(sm, id);
  const s = sm.get(full);
  if (!s) {
    // eslint-disable-next-line no-console
    console.log(chalk.red(`Session ${id} not found.`));
    process.exitCode = 1;
    return;
  }
  const activeId = sm.getActiveId();
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Session ${s.id.slice(0, 8)} — "${s.name}"\n`));
  // eslint-disable-next-line no-console
  console.log(`  id         : ${chalk.gray(s.id)}`);
  // eslint-disable-next-line no-console
  console.log(`  active     : ${s.id === activeId ? chalk.green('yes') : 'no'}`);
  // eslint-disable-next-line no-console
  console.log(`  status     : ${statusBadge(s.metadata.status)}`);
  // eslint-disable-next-line no-console
  console.log(`  created    : ${chalk.dim(fmtDate(s.createdAt))}`);
  // eslint-disable-next-line no-console
  console.log(`  updated    : ${chalk.dim(fmtDate(s.updatedAt))}`);
  if (s.goal) {
    // eslint-disable-next-line no-console
    console.log(`  goal       : ${chalk.cyan(s.goal)}`);
  }
  if (s.provider) {
    // eslint-disable-next-line no-console
    console.log(`  provider   : ${chalk.dim(s.provider)}`);
  }
  if (s.model) {
    // eslint-disable-next-line no-console
    console.log(`  model      : ${chalk.dim(s.model)}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  pinned     : ${s.pinned ? chalk.hex('#FFB347')('yes') : 'no'}`);
  // eslint-disable-next-line no-console
  console.log(`  tags       : ${s.tags.length > 0 ? s.tags.join(', ') : chalk.dim('(none)')}`);
  // eslint-disable-next-line no-console
  console.log(`  messages   : ${s.messages.length}`);
  // eslint-disable-next-line no-console
  console.log(`  tokens     : ${s.metadata.totalTokens}`);
  // eslint-disable-next-line no-console
  console.log(`  cost (USD) : $${s.metadata.totalCostUsd.toFixed(6)}`);
  // eslint-disable-next-line no-console
  console.log(`  iterations : ${s.metadata.iterationCount}`);
  // eslint-disable-next-line no-console
  console.log('');
  if (s.messages.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('  (no messages yet)'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#FFB347')('Messages:'));
  for (const m of s.messages) {
    const role = m.role === 'user'
      ? chalk.cyan('🧑 user')
      : m.role === 'assistant'
        ? chalk.green('🤖 assistant')
        : m.role === 'system'
          ? chalk.gray('⚙️ system')
          : chalk.hex('#FFB347')('🔧 tool');
    const ts = chalk.dim(fmtDate(m.timestamp));
    // eslint-disable-next-line no-console
    console.log(`\n  ${role}  ${ts}`);
    const lines = m.content.split('\n');
    for (const line of lines.slice(0, 50)) {
      // eslint-disable-next-line no-console
      console.log(`    ${line}`);
    }
    if (lines.length > 50) {
      // eslint-disable-next-line no-console
      console.log(chalk.dim(`    … (${lines.length - 50} more lines)`));
    }
  }
}

/** `sanix session delete <id>`. */
export function sessionDelete(sm: SessionManager, id: string): void {
  const full = resolveId(sm, id);
  const deleted = sm.delete(full);
  if (!deleted) {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow(`Session ${id} not found.`));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Deleted session ${full.slice(0, 8)}.`));
}

/** `sanix session fork <id> [name]`. */
export function sessionFork(
  sm: SessionManager,
  id: string,
  name: string | undefined,
  opts: SessionForkOptions,
): void {
  const full = resolveId(sm, id);
  const forked = sm.fork(full, opts.from, name);
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Forked session ${full.slice(0, 8)} → ${forked.id.slice(0, 8)} "${forked.name}".`));
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`  ${forked.messages.length} messages copied.`));
}

/** `sanix session search <query>`. */
export function sessionSearch(sm: SessionManager, query: string): void {
  const results = sm.search(query);
  if (results.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`No sessions matched "${query}".`));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Search results for "${query}" (${results.length} sessions):\n`));
  for (const r of results) {
    const s = r.session;
    // eslint-disable-next-line no-console
    console.log(`  ${chalk.gray(s.id.slice(0, 8))} ${chalk.cyan(s.name)} ${chalk.dim(`(${r.matches.length} matches)`)}`);
    for (const m of r.matches.slice(0, 3)) {
      // eslint-disable-next-line no-console
      console.log(chalk.dim(`    • ${m.snippet}`));
    }
    if (r.matches.length > 3) {
      // eslint-disable-next-line no-console
      console.log(chalk.dim(`    … (${r.matches.length - 3} more matches)`));
    }
  }
}

/** `sanix session stats`. */
export function sessionStats(sm: SessionManager, opts: SessionStatsOptions): void {
  const s = sm.stats();
  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('Session statistics:\n'));
  // eslint-disable-next-line no-console
  console.log(`  Total sessions   : ${chalk.green(String(s.totalSessions))}`);
  // eslint-disable-next-line no-console
  console.log(`  Active sessions  : ${chalk.cyan(String(s.activeSessions))}`);
  // eslint-disable-next-line no-console
  console.log(`  Total messages   : ${chalk.dim(String(s.totalMessages))}`);
  // eslint-disable-next-line no-console
  console.log(`  Total tokens     : ${chalk.dim(String(s.totalTokens))}`);
  // eslint-disable-next-line no-console
  console.log(`  Total cost (USD) : ${chalk.dim(`$${s.totalCostUsd.toFixed(6)}`)}`);
  if (s.oldestSession) {
    // eslint-disable-next-line no-console
    console.log(`  Oldest session   : ${chalk.dim(fmtDate(s.oldestSession))}`);
  }
  if (s.newestSession) {
    // eslint-disable-next-line no-console
    console.log(`  Newest session   : ${chalk.dim(fmtDate(s.newestSession))}`);
  }
  const size = sm.diskSizeBytes();
  // eslint-disable-next-line no-console
  console.log(`  Disk usage       : ${chalk.dim(fmtBytes(size))}`);
}

/** Color-coded status badge. */
function statusBadge(status: SessionStatus): string {
  switch (status) {
    case 'active':
      return chalk.green('[active]');
    case 'completed':
      return chalk.cyan('[completed]');
    case 'aborted':
      return chalk.red('[aborted]');
    default:
      return chalk.dim(`[${status}]`);
  }
}

/** Print a red error and set exit code 1. */
function fail(cmd: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(chalk.red(`\n✗ sanix ${cmd} failed: ${msg}\n`));
  process.exitCode = 1;
}

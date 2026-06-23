/**
 * @file repl/Repl.ts
 * @description Interactive REPL for `sanix chat`.
 *
 * Built on Node's `readline` interface. Each non-slash user input triggers
 * one {@link AgentLoop} iteration with the accumulated conversation as
 * context. Slash commands (parsed by {@link parseSlashCommand}) handle
 * meta-operations: help, clear, memory, provider switch, budget set,
 * save/load conversation, fork/switch/diff branches, checkpoints, cost,
 * hooks, auth, plan inspection, undo/redo, exit.
 *
 * History is capped at 100 entries and persisted to `~/.sanix/history.json`
 * so it survives across sessions.
 *
 * @packageDocumentation
 */

import * as readline from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import chalk from 'chalk';
import type { AgentLoop, Plan } from '@sanix/core';
import type { LLMMessage } from '@sanix/providers';
import { SessionManager, type Session } from '../session/SessionManager.js';

/**
 * Coerce message content (string or ContentBlock[]) to plain text for REPL
 * display. Image blocks are skipped (their binary payload can't be shown
 * inline in a terminal).
 */
function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}
import type { SanixContext } from '../bootstrap.js';
import {
  parseSlashCommand,
  type SlashCommand,
} from './InputHandler.js';
import { renderWelcome, renderHelpTable } from './welcome.js';
import { renderStatusBar } from './status-bar.js';
import type { StatusBarData } from './status-bar.js';

/** Default path for persisted REPL history: `~/.sanix/history.json`. */
export const HISTORY_PATH: string = join(homedir(), '.sanix', 'history.json');

/** Maximum number of history entries kept in memory + on disk. */
export const MAX_HISTORY = 100;

/** Generate a fresh nanoid for checkpoint / branch ids. */
function newRunIdSafe(): string {
  return nanoid(12);
}

/** A single message in the REPL's conversation log. */
export interface ReplMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** ISO timestamp the message was added. */
  ts: string;
}

/** Options accepted by {@link Repl.start}. */
export interface ReplOptions {
  /** The wired SANIX context. */
  context: SanixContext;
  /** A pre-wired agent loop (else one will be constructed per turn). */
  loop?: AgentLoop;
  /** Override the persisted history path (defaults to {@link HISTORY_PATH}). */
  historyPath?: string;
  /** Override the readline input stream (defaults to `process.stdin`). */
  input?: NodeJS.ReadableStream;
  /** Override the readline output stream (defaults to `process.stdout`). */
  output?: NodeJS.WritableStream;
  /** Override the prompt string (defaults to `sanix> `). */
  prompt?: string;
  /** Callback invoked when the user issues `/exit` or Ctrl+D. */
  onExit?: () => void | Promise<void>;
  /**
   * Callback invoked for each non-slash user input. Receives the input
   * and the accumulated conversation; returns the assistant's reply
   * string (or throws on error). Defaults to a stub that prints the input
   * back — the chat command supplies a real implementation.
   */
  onUserMessage?: (
    input: string,
    conversation: ReplMessage[],
  ) => Promise<string>;
}

/**
 * Interactive SANIX REPL.
 *
 * @example
 * ```ts
 * const ctx = await bootstrap();
 * const repl = new Repl({ context: ctx, onUserMessage: myHandler });
 * await repl.start();
 * ```
 */
export class Repl extends EventEmitter {
  private readonly ctx: SanixContext;
  private readonly historyPath: string;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly promptStr: string;
  private readonly onExit?: () => void | Promise<void>;
  private readonly onUserMessage?: (
    input: string,
    conversation: ReplMessage[],
  ) => Promise<string>;

  private rl: readline.Interface | null = null;
  private history: string[] = [];
  private conversation: ReplMessage[] = [];
  private currentBudget: number | undefined;
  private exited = false;
  /** Most-recent plan captured from the agent loop (for `/plan`, `/edit-plan`). */
  private lastPlan: Plan | null = null;
  /** Undo stack of checkpoint ids (for `/undo` + `/redo`). */
  private undoStack: string[] = [];
  /** Redo stack of checkpoint ids (for `/redo`). */
  private redoStack: string[] = [];
  /** V13-1 — Session manager (lazily initialized on first session slash command). */
  private sessionManager: SessionManager | null = null;
  /** V13-1 — The currently-active session (if any). */
  private activeSession: Session | null = null;
  /** Data for the bottom status bar. */
  private statusData: StatusBarData = {
    provider: '—',
    messageCount: 0,
  };

  constructor(opts: ReplOptions) {
    super();
    this.ctx = opts.context;
    this.historyPath = opts.historyPath ?? HISTORY_PATH;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.promptStr = opts.prompt ?? chalk.dim('> ');
    this.onExit = opts.onExit;
    this.onUserMessage = opts.onUserMessage;
  }

  /**
   * Start the REPL. Loads history, prints a banner, and enters the
   * readline loop. Resolves when the user exits (via `/exit`, Ctrl+C, or
   * Ctrl+D).
   */
  async start(): Promise<void> {
    this.history = this.loadHistory();

    this.rl = readline.createInterface({
      input: this.input as NodeJS.ReadableStream,
      output: this.output as NodeJS.WritableStream,
      prompt: this.promptStr,
      history: this.history.slice(-MAX_HISTORY),
      terminal: process.stdout.isTTY === true,
    });

    // ── Claude Code-style welcome ─────────────────────────────
    // Clear the entire terminal for a fresh slate.
    console.clear();

    // Seed status bar data from the current config.
    this.statusData.provider = this.ctx.config.providers.default || '\u2014';
    this.statusData.messageCount = 0;

    this.writeLine(renderWelcome(this.ctx.config));

    // V13-1 — Load (or resume) the active session, and replay its messages
    // into the in-memory conversation. This is async but we don't block the
    // prompt on it — if it's slow, the user can start typing.
    void this.bootstrapSession();

    this.rl.prompt();

    this.rl.on('line', (line: string) => {
      // Defer to an async handler so we can `await` user-message dispatch.
      void this.handleLine(line);
    });

    // Ctrl+C: emit a 'close' event by calling handleExit directly.
    this.rl.on('SIGINT', () => {
      void this.handleExit();
    });

    // Ctrl+D / rl.close(): also exit.
    this.rl.on('close', () => {
      void this.handleExit();
    });

    // Block until the readline interface closes.
    await new Promise<void>((resolve) => {
      this.once('closed', () => resolve());
    });
  }

  /**
   * V13-1 — Bootstrap the session sub-system on REPL start. Loads the
   * SessionManager (from `~/.sanix/sessions/`), restores the active
   * session (if any), and replays its messages into the in-memory
   * conversation so the user sees their prior context.
   *
   * If the SessionManager is already set on the context (e.g. by an
   * earlier `sanix session` invocation), that instance is reused.
   */
  private async bootstrapSession(): Promise<void> {
    try {
      // Reuse the context's SessionManager if present; otherwise construct
      // one and assign it back to the context for future commands.
      if (this.ctx.sessionManager) {
        this.sessionManager = this.ctx.sessionManager;
      } else {
        const sm = new SessionManager();
        await sm.load();
        this.sessionManager = sm;
        // Assign back to the context so `sanix session` sees the same state.
        (this.ctx as { sessionManager?: SessionManager }).sessionManager = sm;
      }
      const active = this.sessionManager.getActive();
      if (active) {
        this.activeSession = active;
        // Replay the session's messages into the conversation.
        this.conversation = active.messages.map((m) => ({
          role: (m.role === 'tool' ? 'system' : m.role) as ReplMessage['role'],
          content: m.content,
          ts: new Date(m.timestamp).toISOString(),
        }));
        if (active.messages.length > 0) {
          this.writeLine(
            chalk.dim(`Resumed session ${active.id.slice(0, 8)} "${active.name}" (${active.messages.length} messages).\n`),
          );
        }
      }
    } catch (err) {
      // Non-fatal — sessions are best-effort.
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.yellow(`Session load failed: ${msg}\n`));
    }
  }

  /**
   * Capture a plan from an agent run (called by the chat command after
   * each turn). Used by `/plan` and `/edit-plan`.
   *
   * @param plan - The plan to capture (or `null` to clear).
   */
  setPlan(plan: Plan | null): void {
    this.lastPlan = plan;
  }

  /**
   * Handle a single typed line. Dispatches to either the slash-command
   * path or the user-message path.
   */
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      this.rl?.prompt();
      return;
    }

    // Record in history (capped).
    this.history.push(trimmed);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    this.persistHistory();

    const slash = parseSlashCommand(trimmed);
    if (slash) {
      await this.handleSlash(slash);
      this.rl?.prompt();
      return;
    }

    // Non-slash input: dispatch to the user-message handler.
    if (!this.onUserMessage) {
      this.writeLine(chalk.yellow('No message handler configured.\n'));
      this.rl?.prompt();
      return;
    }

    this.statusData.messageCount = this.conversation.length + 1;
    this.conversation.push({
      role: 'user',
      content: trimmed,
      ts: new Date().toISOString(),
    });
    // V13-1 — Persist the user message to the active session (creating
    // one on the fly if none exists yet).
    this.ensureActiveSession();

    // Show the user message with a ChatGPT-style "You" label
    this.writeLine(this.formatChatMessage('You', trimmed, chalk.hex('#00D4FF')));
    if (this.activeSession && this.sessionManager) {
      try {
        this.sessionManager.addMessage(this.activeSession.id, {
          role: 'user',
          content: trimmed,
        });
        this.activeSession = this.sessionManager.get(this.activeSession.id);
      } catch {
        // Non-fatal — session persistence is best-effort.
      }
    }

    try {
      const reply = await this.onUserMessage(trimmed, this.conversation);
      this.conversation.push({
        role: 'assistant',
        content: reply,
        ts: new Date().toISOString(),
      });
      this.statusData.messageCount = this.conversation.length + 1;
      this.writeLine(this.formatChatMessage('SANIX', reply, chalk.hex('#FFB347')));
      this.writeLine(renderStatusBar(this.statusData));
      // V13-1 — Persist the assistant reply to the active session.
      if (this.activeSession && this.sessionManager) {
        try {
          this.sessionManager.addMessage(this.activeSession.id, {
            role: 'assistant',
            content: reply,
          });
          this.activeSession = this.sessionManager.get(this.activeSession.id);
        } catch {
          // Non-fatal.
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`\nError: ${msg}\n\n`));
    }

    this.rl?.prompt();
  }

  /**
   * V13-1 — Ensure there is an active session. If the SessionManager is
   * loaded but no session is active, create one (named from the current
   * working directory + timestamp).
   */
  private ensureActiveSession(): void {
    if (!this.sessionManager) {
      // Lazily construct + load (best-effort).
      try {
        const sm = new SessionManager();
        // Note: load() is async; we don't await here because ensureActiveSession
        // is called from a sync context. The load will complete by the time the
        // next message is persisted.
        void sm.load();
        this.sessionManager = sm;
        (this.ctx as { sessionManager?: SessionManager }).sessionManager = sm;
      } catch {
        return;
      }
    }
    if (!this.activeSession && this.sessionManager) {
      try {
        const active = this.sessionManager.getActive();
        if (active) {
          this.activeSession = active;
        } else {
          const name = `chat-${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
          this.activeSession = this.sessionManager.create(name);
        }
      } catch {
        // Non-fatal.
      }
    }
  }

  /** Dispatch a parsed slash command to its handler. */
  private async handleSlash(cmd: SlashCommand): Promise<void> {
    switch (cmd.kind) {
      case 'help':
        this.writeLine(renderHelpTable() + '\n');
        return;
      case 'clear':
        await this.handleClear();
        return;
      case 'memory':
        await this.handleMemory(cmd);
        return;
      case 'provider':
        this.handleProvider(cmd.name);
        return;
      case 'budget':
        this.currentBudget = cmd.amount;
        this.writeLine(chalk.green(`Token budget set to ${cmd.amount}.\n`));
        return;
      case 'save':
        this.handleSave(cmd.path);
        return;
      case 'load':
        this.handleLoad(cmd.path);
        return;
      case 'fork':
        await this.handleFork(cmd.label);
        return;
      case 'branch':
        await this.handleBranchList();
        return;
      case 'switch':
        await this.handleSwitch(cmd.id);
        return;
      case 'diff':
        await this.handleDiff(cmd.a, cmd.b);
        return;
      case 'checkpoint':
        await this.handleCheckpoint();
        return;
      case 'resume':
        await this.handleResume(cmd.id);
        return;
      case 'cost':
        this.handleCost();
        return;
      case 'hooks':
        this.handleHooks();
        return;
      case 'auth':
        await this.handleAuth(cmd.provider);
        return;
      case 'plan':
        this.handlePlan();
        return;
      case 'edit-plan':
        this.handleEditPlan();
        return;
      case 'undo':
        await this.handleUndo();
        return;
      case 'redo':
        await this.handleRedo();
        return;
      // V13-1 — session slash commands.
      case 'sessions':
        await this.handleSessionsList();
        return;
      case 'session':
        await this.handleSession(cmd);
        return;
      case 'exit':
        await this.handleExit();
        return;
    }
  }

  /** V13-1 — `/sessions` — list all sessions. */
  private async handleSessionsList(): Promise<void> {
    if (!this.sessionManager) {
      this.writeLine(chalk.dim('Sessions not initialized yet.\n'));
      return;
    }
    const list = this.sessionManager.list();
    if (list.length === 0) {
      this.writeLine(chalk.dim('No sessions yet. Use /session new to create one.\n'));
      return;
    }
    const activeId = this.sessionManager.getActiveId();
    this.writeLine(chalk.hex('#FFB347')('Sessions:\n'));
    for (const s of list) {
      const marker = s.id === activeId ? chalk.green('*') : ' ';
      const pin = s.pinned ? chalk.hex('#FFB347')('★') : ' ';
      const id = chalk.gray(s.id.slice(0, 8));
      const name = chalk.cyan(s.name.length > 40 ? s.name.slice(0, 39) + '…' : s.name);
      const msgs = chalk.dim(`(${s.messages.length} msgs)`);
      this.writeLine(`  ${marker}${pin} ${id} ${name} ${msgs}\n`);
    }
  }

  /** V13-1 — `/session <sub>` — dispatch to the right session sub-handler. */
  private async handleSession(
    cmd: Extract<SlashCommand, { kind: 'session' }>,
  ): Promise<void> {
    if (!this.sessionManager) {
      // Lazily construct + load.
      try {
        const sm = new SessionManager();
        await sm.load();
        this.sessionManager = sm;
        (this.ctx as { sessionManager?: SessionManager }).sessionManager = sm;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.writeLine(chalk.red(`Session init failed: ${msg}\n`));
        return;
      }
    }
    switch (cmd.sub) {
      case 'new': {
        const s = this.sessionManager!.create(cmd.name);
        this.activeSession = s;
        this.conversation = [];
        this.writeLine(chalk.green(`✓ Created session ${s.id.slice(0, 8)} "${s.name}" (active).\n`));
        return;
      }
      case 'switch': {
        const full = this.resolveSessionId(cmd.id);
        if (!full) {
          this.writeLine(chalk.red(`No session matches "${cmd.id}".\n`));
          return;
        }
        const s = this.sessionManager!.switchTo(full);
        if (!s) {
          this.writeLine(chalk.red(`Session ${full.slice(0, 8)} not found.\n`));
          return;
        }
        this.activeSession = s;
        // Replay the session's messages.
        this.conversation = s.messages.map((m) => ({
          role: (m.role === 'tool' ? 'system' : m.role) as ReplMessage['role'],
          content: m.content,
          ts: new Date(m.timestamp).toISOString(),
        }));
        this.writeLine(chalk.green(`✓ Switched to session ${s.id.slice(0, 8)} "${s.name}" (${s.messages.length} messages).\n`));
        return;
      }
      case 'fork': {
        if (!this.activeSession) {
          this.writeLine(chalk.yellow('No active session to fork. Use /session new first.\n'));
          return;
        }
        const forked = this.sessionManager!.fork(this.activeSession.id, undefined, cmd.name);
        this.activeSession = forked;
        this.conversation = forked.messages.map((m) => ({
          role: (m.role === 'tool' ? 'system' : m.role) as ReplMessage['role'],
          content: m.content,
          ts: new Date(m.timestamp).toISOString(),
        }));
        this.writeLine(chalk.green(`✓ Forked → session ${forked.id.slice(0, 8)} "${forked.name}" (${forked.messages.length} messages).\n`));
        return;
      }
      case 'export': {
        if (!this.activeSession) {
          this.writeLine(chalk.yellow('No active session to export.\n'));
          return;
        }
        const out = this.sessionManager!.exportSession(this.activeSession.id, 'markdown');
        this.writeLine(out + '\n');
        return;
      }
      case 'delete': {
        const full = this.resolveSessionId(cmd.id);
        if (!full) {
          this.writeLine(chalk.red(`No session matches "${cmd.id}".\n`));
          return;
        }
        const deleted = this.sessionManager!.delete(full);
        if (!deleted) {
          this.writeLine(chalk.yellow(`Session ${cmd.id} not found.\n`));
          return;
        }
        if (this.activeSession?.id === full) {
          this.activeSession = null;
          this.conversation = [];
        }
        this.writeLine(chalk.green(`✓ Deleted session ${full.slice(0, 8)}.\n`));
        return;
      }
    }
  }

  /**
   * V13-1 — Resolve a session id-or-prefix to a full id. Returns `null`
   * if no session matches or the prefix is ambiguous.
   */
  private resolveSessionId(idOrPrefix: string): string | null {
    if (!this.sessionManager) return null;
    const all = this.sessionManager.list();
    const exact = all.find((s) => s.id === idOrPrefix);
    if (exact) return exact.id;
    const matches = all.filter((s) => s.id.startsWith(idOrPrefix));
    if (matches.length === 1) return matches[0]!.id;
    return null;
  }

  /** `/clear` — clear working memory + the in-memory conversation. */
  private async handleClear(): Promise<void> {
    try {
      this.ctx.memory.working.clear();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.yellow(`Working memory clear failed: ${msg}\n`));
    }
    this.conversation = [];
    this.writeLine(chalk.green('Working memory + conversation cleared.\n'));
  }

  /** `/memory` or `/memory search <query>` — stats or search. */
  private async handleMemory(
    cmd: { sub?: 'search'; query?: string },
  ): Promise<void> {
    try {
      if (cmd.sub === 'search' && cmd.query) {
        const hits = await this.ctx.memory.recall({ query: cmd.query, limit: 10 });
        if (hits.length === 0) {
          this.writeLine(chalk.dim(`No memories matched "${cmd.query}".\n`));
          return;
        }
        this.writeLine(chalk.hex('#FFB347')(`Search results for "${cmd.query}":\n`));
        for (const h of hits) {
          this.printMemoryItem(h);
        }
        return;
      }
      // No sub-command → print stats per tier.
      const stats = await this.gatherMemoryStats();
      this.writeLine(chalk.hex('#FFB347')('Memory stats:\n'));
      for (const s of stats) {
        this.writeLine(`  ${chalk.cyan(s.tier.padEnd(12))} ${s.count} items\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Memory command failed: ${msg}\n`));
    }
  }

  /** `/provider <name>` — switch the active provider. */
  private handleProvider(name: string): void {
    const provider = this.ctx.router.get(name);
    if (!provider) {
      this.writeLine(chalk.red(`Unknown provider: ${name}\n`));
      return;
    }
    this.ctx.config.providers.default = name;
    this.statusData.provider = name;
    this.writeLine(chalk.green(`Active provider: ${name}\n`));
  }

  /** `/save <path>` — save the conversation to JSON. */
  private handleSave(path: string): void {
    try {
      this.saveConversation(path);
      this.writeLine(chalk.green(`Conversation saved to ${path}.\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Save failed: ${msg}\n`));
    }
  }

  /** `/load <path>` — load a conversation from JSON. */
  private handleLoad(path: string): void {
    try {
      this.loadConversation(path);
      this.writeLine(chalk.green(`Loaded ${this.conversation.length} messages from ${path}.\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Load failed: ${msg}\n`));
    }
  }

  /** `/fork [label]` — fork the conversation via BranchManager. */
  private async handleFork(label: string | undefined): Promise<void> {
    try {
      // BranchManager.fork takes (fromMessageIndex, label). Fork at the
      // current message count so the new branch inherits the full history.
      const branchId = this.ctx.branches.fork(this.conversation.length, label);
      this.writeLine(chalk.green(`Forked conversation → branch ${branchId.slice(0, 8)}.\n`));
      if (label) {
        this.writeLine(chalk.dim(`  Label: ${label}\n`));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Fork failed: ${msg}\n`));
    }
  }

  /** `/branch` — list all branches. */
  private async handleBranchList(): Promise<void> {
    try {
      const branches = this.ctx.branches.list();
      if (branches.length === 0) {
        this.writeLine(chalk.dim('No branches yet. Use /fork to create one.\n'));
        return;
      }
      this.writeLine(chalk.hex('#FFB347')('Branches:\n'));
      for (const b of branches) {
        const id = b.id.slice(0, 8);
        const label = b.label ? chalk.cyan(b.label) : chalk.dim('(no label)');
        const active = b.active ? chalk.green('*') : ' ';
        const msgCount = b.messages.length;
        this.writeLine(`  ${active} ${id} ${label} ${chalk.dim(`(${msgCount} msgs)`)}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Branch list failed: ${msg}\n`));
    }
  }

  /** `/switch <id>` — switch to a branch. Accepts full id or 8-char prefix. */
  private async handleSwitch(id: string): Promise<void> {
    try {
      // Try exact match first; fall back to prefix match (so users can
      // paste the 8-char id shown by `/branch`).
      const all = this.ctx.branches.list();
      let target = all.find((b) => b.id === id);
      if (!target) {
        const matches = all.filter((b) => b.id.startsWith(id));
        if (matches.length === 1) {
          target = matches[0];
        } else if (matches.length === 0) {
          throw new Error(`No branch matches "${id}".`);
        } else {
          throw new Error(
            `Ambiguous branch prefix "${id}" — matches ${matches.length} branches.`,
          );
        }
      }
      this.ctx.branches.switchTo(target.id);
      const branch = this.ctx.branches.getActive();
      // Sync the REPL's conversation view with the active branch's messages.
      this.conversation = branch.messages.map((m) => ({
        role: (m.role === 'tool' ? 'system' : m.role) as ReplMessage['role'],
        content: toText(m.content),
        ts: new Date().toISOString(),
      }));
      this.writeLine(chalk.green(`Switched to branch ${target.id.slice(0, 8)}.\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Switch failed: ${msg}\n`));
    }
  }

  /** `/diff <a> <b>` — diff two branches. Accepts full ids or prefixes. */
  private async handleDiff(a: string, b: string): Promise<void> {
    try {
      const resolvedA = this.resolveBranchId(a);
      const resolvedB = this.resolveBranchId(b);
      const diff = this.ctx.branches.diff(resolvedA, resolvedB);
      if (diff.onlyInA.length === 0 && diff.onlyInB.length === 0) {
        this.writeLine(chalk.dim(`No differences between ${a} and ${b}.\n`));
        return;
      }
      this.writeLine(chalk.hex('#FFB347')(`Diff ${a}..${b}:\n`));
      this.writeLine(chalk.dim(`  Common prefix: ${diff.common.length} messages\n`));
      this.writeLine(chalk.red(`  Only in ${a}: ${diff.onlyInA.length} messages\n`));
      for (const m of diff.onlyInA.slice(0, 5)) {
        const preview = m.content.slice(0, 80);
        this.writeLine(chalk.red(`    - [${m.role}] ${preview}\n`));
      }
      this.writeLine(chalk.green(`  Only in ${b}: ${diff.onlyInB.length} messages\n`));
      for (const m of diff.onlyInB.slice(0, 5)) {
        const preview = m.content.slice(0, 80);
        this.writeLine(chalk.green(`    + [${m.role}] ${preview}\n`));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Diff failed: ${msg}\n`));
    }
  }

  /**
   * Resolve a branch id (full or 8-char prefix) to a full branch id.
   * @throws if no branch matches or the prefix is ambiguous.
   */
  private resolveBranchId(idOrPrefix: string): string {
    const all = this.ctx.branches.list();
    const exact = all.find((b) => b.id === idOrPrefix);
    if (exact) return exact.id;
    const matches = all.filter((b) => b.id.startsWith(idOrPrefix));
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length === 0) throw new Error(`No branch matches "${idOrPrefix}".`);
    throw new Error(
      `Ambiguous branch prefix "${idOrPrefix}" — matches ${matches.length} branches.`,
    );
  }

  /** `/checkpoint` — manually save a checkpoint. */
  private async handleCheckpoint(): Promise<void> {
    try {
      const id = newRunIdSafe();
      const now = Date.now();
      // Build a placeholder plan if none exists yet (Checkpoint requires one).
      const plan: Plan = this.lastPlan ?? {
        goal: '(interactive session)',
        understanding: '',
        ambiguities: [],
        tasks: [],
        successCriteria: [],
        estimatedTokenBudget: 0,
        recommendedProvider: this.ctx.config.providers.default,
        parallelizable: false,
        createdAt: new Date().toISOString(),
      };
      const cpPath = await this.ctx.checkpoints.save({
        id,
        sessionId: 'repl',
        goal: plan.goal,
        createdAt: now,
        agentState: {} as never, // REPL sessions don't carry a full AgentState.
        plan,
        completedTaskIds: [],
        messages: this.conversation.map((m) => ({
          role: m.role,
          content: toText(m.content),
        })),
        costSummary: this.ctx.costs.summarize(),
        iteration: this.conversation.length,
        metadata: { source: 'repl', budget: this.currentBudget },
      });
      this.undoStack.push(id);
      this.redoStack = [];
      this.writeLine(chalk.green(`Checkpoint saved: ${id} → ${cpPath}\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Checkpoint save failed: ${msg}\n`));
    }
  }

  /** `/resume <id>` — resume from a checkpoint. */
  private async handleResume(id: string): Promise<void> {
    try {
      const cp = await this.ctx.checkpoints.load(id);
      if (!cp) {
        this.writeLine(chalk.red(`No checkpoint with id ${id}.\n`));
        return;
      }
      if (Array.isArray(cp.messages)) {
        this.conversation = cp.messages.map((m) => ({
          role: (m.role === 'tool' ? 'system' : m.role) as ReplMessage['role'],
          content: toText(m.content),
          ts: new Date().toISOString(),
        }));
      }
      if (cp.plan) {
        this.lastPlan = cp.plan as Plan;
      }
      if (cp.metadata && typeof cp.metadata.budget === 'number') {
        this.currentBudget = cp.metadata.budget;
      }
      this.writeLine(chalk.green(`Resumed from checkpoint ${id}.\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Resume failed: ${msg}\n`));
    }
  }

  /** `/cost` — show cost summary via CostTracker.formatSummary(). */
  private handleCost(): void {
    try {
      const summary = this.ctx.costs.summarize();
      const text = this.ctx.costs.formatSummary(summary);
      this.writeLine(chalk.hex('#FFB347')('Cost summary:\n'));
      this.writeLine(`${text}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Cost summary failed: ${msg}\n`));
    }
  }

  /** `/hooks` — list registered hooks. */
  private handleHooks(): void {
    try {
      const hooks = this.ctx.hooks.list();
      if (hooks.length === 0) {
        this.writeLine(chalk.dim('No hooks registered.\n'));
        return;
      }
      this.writeLine(chalk.hex('#FFB347')('Registered hooks:\n'));
      for (const h of hooks) {
        const id = String(h.id ?? '').slice(0, 8);
        const event = String(h.event ?? '');
        const priority = typeof h.priority === 'number' ? chalk.dim(` [${h.priority}]`) : '';
        this.writeLine(`  ${chalk.cyan(id)} ${event}${priority}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Hooks list failed: ${msg}\n`));
    }
  }

  /** `/auth <provider>` — start an OAuth login flow. */
  private async handleAuth(provider: string): Promise<void> {
    try {
      this.writeLine(chalk.cyan(`Starting OAuth flow for ${provider}…\n`));
      const tokenSet = await this.ctx.authManager.login(provider);
      const expiry = new Date(tokenSet.expiresAt).toLocaleString();
      this.writeLine(chalk.green(`✓ Logged in to ${provider}.\n`));
      this.writeLine(chalk.dim(`  Token expires: ${expiry}\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Auth failed: ${msg}\n`));
    }
  }

  /** `/plan` — show the current plan. */
  private handlePlan(): void {
    if (!this.lastPlan) {
      this.writeLine(chalk.dim('No plan yet. Send a message to generate one.\n'));
      return;
    }
    this.writeLine(chalk.hex('#FFB347')('Current plan:\n'));
    this.writeLine(chalk.white(`  Goal: ${this.lastPlan.goal}\n`));
    this.writeLine(chalk.dim(`  Understanding: ${this.lastPlan.understanding}\n`));
    if (this.lastPlan.ambiguities.length > 0) {
      this.writeLine(chalk.yellow('  Ambiguities:\n'));
      for (const a of this.lastPlan.ambiguities) {
        this.writeLine(chalk.yellow(`    - ${a}\n`));
      }
    }
    this.writeLine(chalk.white('  Tasks:\n'));
    for (const t of this.lastPlan.tasks) {
      const status = chalk.gray(`[${t.status}]`);
      this.writeLine(`    ${status} ${chalk.cyan(t.id)}: ${t.title}\n`);
    }
    if (this.lastPlan.successCriteria.length > 0) {
      this.writeLine(chalk.green('  Success criteria:\n'));
      for (const c of this.lastPlan.successCriteria) {
        this.writeLine(chalk.green(`    - ${c}\n`));
      }
    }
  }

  /** `/edit-plan` — open the plan in `$EDITOR`. */
  private handleEditPlan(): void {
    if (!this.lastPlan) {
      this.writeLine(chalk.dim('No plan yet to edit.\n'));
      return;
    }
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
    // Write plan to a temp file, invoke editor, read back.
    const tmpPath = join(
      process.env.TMPDIR ?? '/tmp',
      `sanix-plan-${Date.now()}.json`,
    );
    try {
      writeFileSync(tmpPath, JSON.stringify(this.lastPlan, null, 2), 'utf-8');
      this.writeLine(chalk.dim(`Opening plan in ${editor} (${tmpPath})…\n`));
      const r = spawnSync(editor, [tmpPath], { stdio: 'inherit' });
      if (r.error) {
        this.writeLine(chalk.red(`Failed to launch editor: ${r.error.message}\n`));
        return;
      }
      // Read back the (possibly edited) plan.
      const edited = readFileSync(tmpPath, 'utf-8');
      const parsed = JSON.parse(edited) as unknown;
      this.lastPlan = parsed as Plan;
      this.writeLine(chalk.green('Plan updated. (Note: edits apply to in-memory plan only.)\n'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Edit-plan failed: ${msg}\n`));
    }
  }

  /** `/undo` — restore from the most-recent checkpoint. */
  private async handleUndo(): Promise<void> {
    if (this.undoStack.length === 0) {
      this.writeLine(chalk.dim('Nothing to undo.\n'));
      return;
    }
    const id = this.undoStack.pop()!;
    this.redoStack.push(id);
    try {
      const cp = await this.ctx.checkpoints.load(id);
      if (cp) {
        if (Array.isArray(cp.messages)) {
          this.conversation = cp.messages.map((m) => ({
            role: (m.role === 'tool' ? 'system' : m.role) as ReplMessage['role'],
            content: toText(m.content),
            ts: new Date().toISOString(),
          }));
        }
        if (cp.plan) {
          this.lastPlan = cp.plan as Plan;
        }
      }
      this.writeLine(chalk.green(`Undone to checkpoint ${id}.\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Undo failed: ${msg}\n`));
    }
  }

  /** `/redo` — re-apply the last undone action. */
  private async handleRedo(): Promise<void> {
    if (this.redoStack.length === 0) {
      this.writeLine(chalk.dim('Nothing to redo.\n'));
      return;
    }
    const id = this.redoStack.pop()!;
    this.undoStack.push(id);
    try {
      const cp = await this.ctx.checkpoints.load(id);
      if (cp) {
        if (Array.isArray(cp.messages)) {
          this.conversation = cp.messages.map((m) => ({
            role: (m.role === 'tool' ? 'system' : m.role) as ReplMessage['role'],
            content: toText(m.content),
            ts: new Date().toISOString(),
          }));
        }
        if (cp.plan) {
          this.lastPlan = cp.plan as Plan;
        }
      }
      this.writeLine(chalk.green(`Redone to checkpoint ${id}.\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(chalk.red(`Redo failed: ${msg}\n`));
    }
  }

  /** Persist the conversation to a JSON file. */
  private saveConversation(path: string): void {
    const resolved = path.startsWith('~/')
      ? join(homedir(), path.slice(2))
      : path;
    const dir = dirname(resolved);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(resolved, JSON.stringify(this.conversation, null, 2), 'utf-8');
  }

  /** Load a conversation from a JSON file (replaces the current one). */
  private loadConversation(path: string): void {
    const resolved = path.startsWith('~/')
      ? join(homedir(), path.slice(2))
      : path;
    const text = readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('Conversation file is not an array');
    }
    this.conversation = parsed as ReplMessage[];
  }

  /** Handle `/exit`, Ctrl+C, or Ctrl+D. Idempotent. */
  private async handleExit(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    // V13-1 — flush the active session to disk before exiting.
    if (this.sessionManager) {
      try {
        await this.sessionManager.save();
      } catch {
        // Non-fatal — exit anyway.
      }
    }
    this.writeLine(chalk.dim('\nGoodbye.\n'));
    try {
      await this.onExit?.();
    } catch {
      // Non-fatal — exit anyway.
    }
    this.rl?.close();
    this.emit('closed');
  }

  /** Load persisted history from {@link HISTORY_PATH}. */
  private loadHistory(): string[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      const text = readFileSync(this.historyPath, 'utf-8');
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return [];
      return (parsed as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .slice(-MAX_HISTORY);
    } catch {
      return [];
    }
  }

  /** Persist current history to {@link HISTORY_PATH}. */
  private persistHistory(): void {
    const dir = dirname(this.historyPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        this.historyPath,
        JSON.stringify(this.history, null, 2),
        'utf-8',
      );
    } catch {
      // Non-fatal — history persistence is best-effort.
    }
  }

  /** Format a message with a ChatGPT-style label. */
  private formatChatMessage(label: string, content: string, color: typeof chalk): string {
    const labelLine = `${color.bold(label)}`;
    const lines = content.split('\n');
    const body = lines.map((l) => `  ${l}`);
    return `\n${labelLine}\n${body.join('\n')}\n`;
  }

  /** Write a string to the output stream. */
  private writeLine(s: string): void {
    this.output.write(s);
  }

  /** Print a single scored memory item. */
  private printMemoryItem(h: {
    item: { id: string; content: string };
    score: number;
    tier: string;
  }): void {
    const id = chalk.gray(String(h.item.id).slice(0, 8));
    const tier = chalk.dim(`[${h.tier}]`);
    const score = chalk.green(h.score.toFixed(2));
    const content =
      h.item.content.length > 120
        ? h.item.content.slice(0, 120) + '…'
        : h.item.content;
    this.writeLine(`  ${id} ${tier} ${score} ${content}\n`);
  }

  /** Gather per-tier memory stats. */
  private async gatherMemoryStats(): Promise<
    Array<{ tier: string; count: number }>
  > {
    const tiers: Array<{ tier: string; counter: () => Promise<number> | number }> = [
      { tier: 'working', counter: () => this.ctx.memory.working.all().length },
      {
        tier: 'episodic',
        counter: () => {
          const e = this.ctx.memory.episodic as unknown as {
            count?: () => Promise<number> | number;
            all?: () => unknown[];
          };
          if (typeof e.count === 'function') return e.count();
          if (typeof e.all === 'function') return e.all().length;
          return 0;
        },
      },
      {
        tier: 'semantic',
        counter: () => {
          const s = this.ctx.memory.semantic as unknown as {
            count?: () => Promise<number> | number;
            countRows?: () => Promise<number> | number;
          };
          if (typeof s.count === 'function') return s.count();
          if (typeof s.countRows === 'function') return s.countRows();
          return 0;
        },
      },
      {
        tier: 'procedural',
        counter: () => {
          const p = this.ctx.memory.procedural as unknown as {
            count?: () => Promise<number> | number;
            all?: () => unknown[];
          };
          if (typeof p.count === 'function') return p.count();
          if (typeof p.all === 'function') return p.all().length;
          return 0;
        },
      },
    ];
    const out: Array<{ tier: string; count: number }> = [];
    for (const t of tiers) {
      let count = 0;
      try {
        const r = await Promise.resolve(t.counter());
        count = typeof r === 'number' ? r : 0;
      } catch {
        count = 0;
      }
      out.push({ tier: t.tier, count });
    }
    return out;
  }

  /**
   * Build the {@link LLMMessage} array representing the current
   * conversation. Used by the chat command to seed the agent loop.
   */
  toLLMMessages(): LLMMessage[] {
    return this.conversation.map((m) => ({
      role: m.role,
      content: toText(m.content),
    }));
  }

  /** Current token budget (set via `/budget`). */
  get budget(): number | undefined {
    return this.currentBudget;
  }
}

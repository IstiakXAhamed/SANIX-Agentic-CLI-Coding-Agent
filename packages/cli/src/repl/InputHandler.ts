/**
 * @file repl/InputHandler.ts
 * @description Slash-command parser + keybind handler for the SANIX REPL.
 *
 * The REPL is intentionally minimal — it delegates actual line editing,
 * history navigation, and ANSI handling to Node's built-in `readline`
 * interface. This module provides the two pieces of logic that readline
 * can't do on its own:
 *
 *   1. {@link parseSlashCommand} — turn a typed line into a typed
 *      {@link SlashCommand} (or `null` if it's not a slash command).
 *   2. {@link handleKey} — map a handful of control keys (Ctrl+C, Ctrl+L,
 *      Enter) to {@link KeyAction}s the REPL loop can act on.
 *
 * Supported slash commands (Task A4 / Part 2 + V13-1 session commands):
 *
 *   /help                       Show available commands.
 *   /clear                      Clear working memory.
 *   /memory [search <query>]    Show memory stats or search.
 *   /provider <name>            Switch active provider.
 *   /budget <n>                 Set token budget for subsequent turns.
 *   /save <path>                Save conversation to JSON.
 *   /load <path>                Load a conversation from JSON.
 *   /fork [label]               Fork the conversation (BranchManager).
 *   /branch                     List branches.
 *   /switch <id>                Switch to a branch.
 *   /diff <a> <b>               Diff two branches.
 *   /checkpoint                 Manually save a checkpoint.
 *   /resume <id>                Resume from a checkpoint.
 *   /cost                       Show cost summary (CostTracker).
 *   /hooks                      List registered hooks.
 *   /auth <provider>            Start OAuth login for a provider.
 *   /plan                       Show the current plan.
 *   /edit-plan                  Open the plan in `$EDITOR`.
 *   /undo                       Undo the last action.
 *   /redo                       Redo the last undone action.
 *   /sessions                   List all sessions (V13-1).
 *   /session new [name]         Create a new session (V13-1).
 *   /session switch <id>        Switch to a session (V13-1).
 *   /session fork [name]        Fork the current session (V13-1).
 *   /session export             Export the current session (V13-1).
 *   /session delete <id>        Delete a session (V13-1).
 *   /exit | /quit               Save session + exit.
 *
 * @packageDocumentation
 */

/**
 * A parsed slash command. The `kind` discriminator matches the command
 * name (without the leading `/`); payload fields carry the parsed argument.
 */
export type SlashCommand =
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'memory'; sub?: 'search'; query?: string }
  | { kind: 'provider'; name: string }
  | { kind: 'budget'; amount: number }
  | { kind: 'save'; path: string }
  | { kind: 'load'; path: string }
  | { kind: 'fork'; label?: string }
  | { kind: 'branch' }
  | { kind: 'switch'; id: string }
  | { kind: 'diff'; a: string; b: string }
  | { kind: 'checkpoint' }
  | { kind: 'resume'; id: string }
  | { kind: 'cost' }
  | { kind: 'hooks' }
  | { kind: 'auth'; provider: string }
  | { kind: 'plan' }
  | { kind: 'edit-plan' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  // V13-1 session slash commands.
  | { kind: 'sessions' }
  | { kind: 'session'; sub: 'new'; name?: string }
  | { kind: 'session'; sub: 'switch'; id: string }
  | { kind: 'session'; sub: 'fork'; name?: string }
  | { kind: 'session'; sub: 'export' }
  | { kind: 'session'; sub: 'delete'; id: string }
  | { kind: 'exit' };

/**
 * A high-level action derived from a keypress. The REPL's main loop maps
 * these to behavior (submit current line, clear screen, exit, etc.).
 *
 * Note: arrow-key history navigation is handled natively by `readline`
 * when the interface is created with a `history` array (Node 20+), so we
 * do not emit `history-prev` / `history-next` actions here.
 */
export type KeyAction =
  | { kind: 'submit' }
  | { kind: 'clear-screen' }
  | { kind: 'exit' };

/** Context passed to {@link handleKey}. */
export interface KeyHandlerContext {
  /** Current history navigation index (0 = newest). */
  historyIndex: number;
  /** Total number of entries in history. */
  historyLength: number;
}

/** All recognized slash command names (without the leading `/`). */
export const SLASH_COMMANDS: readonly string[] = [
  'help',
  'clear',
  'memory',
  'provider',
  'budget',
  'save',
  'load',
  'fork',
  'branch',
  'switch',
  'diff',
  'checkpoint',
  'resume',
  'cost',
  'hooks',
  'auth',
  'plan',
  'edit-plan',
  'undo',
  'redo',
  // V13-1 session slash commands.
  'sessions',
  'session',
  'exit',
] as const;

/**
 * Parse a typed line into a {@link SlashCommand}, or return `null` if the
 * line is not a slash command (i.e. does not start with `/`).
 *
 * @example
 * ```ts
 * parseSlashCommand('/help');           // { kind: 'help' }
 * parseSlashCommand('/provider gpt-4o');// { kind: 'provider', name: 'gpt-4o' }
 * parseSlashCommand('/memory search jwt auth'); // { kind: 'memory', sub: 'search', query: 'jwt auth' }
 * parseSlashCommand('hello');           // null
 * parseSlashCommand('/provider');       // null (missing argument)
 * ```
 */
export function parseSlashCommand(line: string): SlashCommand | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;

  // Split into command + remainder. We use a regex that captures
  // whitespace-separated tokens so `/provider gpt-4o` parses cleanly.
  const tokens = trimmed.slice(1).split(/\s+/);
  const cmd = tokens[0] ?? '';
  const arg = tokens.slice(1).join(' ').trim();

  switch (cmd.toLowerCase()) {
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'clear':
      return { kind: 'clear' };
    case 'memory': {
      // /memory              → stats
      // /memory search foo   → search
      if (!arg) return { kind: 'memory' };
      const parts = arg.split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      if (sub === 'search') {
        const query = parts.slice(1).join(' ').trim();
        if (!query) return null;
        return { kind: 'memory', sub: 'search', query };
      }
      // Treat any other arg as a search query (convenience).
      return { kind: 'memory', sub: 'search', query: arg };
    }
    case 'provider':
      if (!arg) return null;
      return { kind: 'provider', name: arg };
    case 'budget': {
      if (!arg) return null;
      const amount = Number(arg);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      return { kind: 'budget', amount: Math.floor(amount) };
    }
    case 'save':
      if (!arg) return null;
      return { kind: 'save', path: arg };
    case 'load':
      if (!arg) return null;
      return { kind: 'load', path: arg };
    case 'fork':
      // Label is optional.
      return { kind: 'fork', label: arg || undefined };
    case 'branch':
      return { kind: 'branch' };
    case 'switch':
      if (!arg) return null;
      return { kind: 'switch', id: arg };
    case 'diff': {
      if (!arg) return null;
      const parts = arg.split(/\s+/);
      if (parts.length < 2) return null;
      return { kind: 'diff', a: parts[0]!, b: parts[1]! };
    }
    case 'checkpoint':
      return { kind: 'checkpoint' };
    case 'resume':
      if (!arg) return null;
      return { kind: 'resume', id: arg };
    case 'cost':
      return { kind: 'cost' };
    case 'hooks':
      return { kind: 'hooks' };
    case 'auth':
      if (!arg) return null;
      return { kind: 'auth', provider: arg };
    case 'plan':
      return { kind: 'plan' };
    case 'edit-plan':
      return { kind: 'edit-plan' };
    case 'undo':
      return { kind: 'undo' };
    case 'redo':
      return { kind: 'redo' };
    case 'sessions':
      return { kind: 'sessions' };
    case 'session': {
      // /session new [name]
      // /session switch <id>
      // /session fork [name]
      // /session export
      // /session delete <id>
      if (!arg) return null;
      const parts = arg.split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      const rest = parts.slice(1).join(' ').trim();
      if (sub === 'new') return { kind: 'session', sub: 'new', name: rest || undefined };
      if (sub === 'switch') {
        if (!rest) return null;
        return { kind: 'session', sub: 'switch', id: rest };
      }
      if (sub === 'fork') return { kind: 'session', sub: 'fork', name: rest || undefined };
      if (sub === 'export') return { kind: 'session', sub: 'export' };
      if (sub === 'delete') {
        if (!rest) return null;
        return { kind: 'session', sub: 'delete', id: rest };
      }
      return null;
    }
    case 'exit':
    case 'quit':
    case 'q':
      return { kind: 'exit' };
    default:
      return null;
  }
}

/**
 * Map a raw key string (as delivered by readline's `key` event) to a
 * {@link KeyAction}. Returns `null` for keys the REPL doesn't handle
 * (i.e. all printable characters — readline adds them to the line buffer
 * itself).
 *
 * @example
 * ```ts
 * handleKey('\r', ctx);    // { kind: 'submit' }
 * handleKey('\x03', ctx);  // { kind: 'exit' }
 * handleKey('\x0c', ctx);  // { kind: 'clear-screen' }
 * handleKey('a', ctx);     // null
 * ```
 */
export function handleKey(
  key: string,
  _ctx: KeyHandlerContext,
): KeyAction | null {
  switch (key) {
    case '\r': // Carriage return (Enter).
    case '\n': // Line feed.
      return { kind: 'submit' };
    case '\x03': // Ctrl+C.
      return { kind: 'exit' };
    case '\x0c': // Ctrl+L.
      return { kind: 'clear-screen' };
    default:
      return null;
  }
}

/**
 * Generate a help string for the available slash commands. Used by the
 * `/help` command and the REPL startup banner.
 */
export function slashHelpText(): string {
  return [
    'Available slash commands:',
    '  /help                       Show this help message',
    '  /clear                      Clear working memory',
    '  /memory [search <query>]    Show memory stats or search memory',
    '  /provider <name>            Switch the active provider (e.g. claude-sonnet-4)',
    '  /budget <n>                 Set the token budget for subsequent turns',
    '  /save <path>                Save the conversation to a JSON file',
    '  /load <path>                Load a conversation from a JSON file',
    '  /fork [label]               Fork the conversation at the current point',
    '  /branch                     List all conversation branches',
    '  /switch <id>                Switch to a branch',
    '  /diff <a> <b>               Diff two branches',
    '  /checkpoint                 Manually save a checkpoint',
    '  /resume <id>                Resume from a checkpoint',
    '  /cost                       Show the cost summary so far',
    '  /hooks                      List registered hooks',
    '  /auth <provider>            Start OAuth login for a provider',
    '  /plan                       Show the current plan',
    '  /edit-plan                  Open the plan in $EDITOR for manual editing',
    '  /undo                       Undo the last action',
    '  /redo                       Redo the last undone action',
    '  /sessions                   List all sessions',
    '  /session new [name]         Create a new session',
    '  /session switch <id>        Switch to a session',
    '  /session fork [name]        Fork the current session',
    '  /session export             Export the current session (markdown)',
    '  /session delete <id>        Delete a session',
    '  /exit                       Exit the REPL (also Ctrl+C or Ctrl+D)',
  ].join('\n');
}

/**
 * @file index.ts
 * @description Programmatic entry point for `@sanix/cli`.
 *
 * Re-exports the public surface so downstream consumers can embed the
 * SANIX CLI in their own Node.js applications:
 *
 *   - {@link bootstrap} + {@link SanixContext} — wire up the full runtime.
 *   - {@link wireUpAgent} + {@link executeGoal} — run goals programmatically.
 *   - {@link renderResult} — format a result for terminal output.
 *   - {@link Repl} — embed the interactive REPL.
 *   - {@link printLogo} — print the SANIX banner.
 *   - {@link main} + {@link createProgram} — invoke the CLI from JS.
 *   - {@link AutoCommit} — embed the auto-commit git integration (Task A4).
 *   - {@link WorkspaceLoader} — embed the workspace-context loader (Task A4).
 *
 * @packageDocumentation
 */

export {
  bootstrap,
  connectMcpServers,
  persistConfig,
  newRunId,
  type SanixContext,
  type BootstrapOptions,
} from './bootstrap.js';

export {
  wireUpAgent,
  wireUpAgentFull,
  executeGoal,
  enrichResult,
  saveCheckpoint,
  loadCheckpoint,
  renderResult,
  DEFAULT_CHECKPOINT_DIR,
  type WireUpAgentOptions,
  type WiredAgent,
  type ExecuteGoalOptions,
  type RenderResultOptions,
  type CheckpointData,
  type EnrichResultOptions,
  type SanixResultMeta,
  type AugmentedAgentResult,
} from './run-helpers.js';

export { Repl, HISTORY_PATH, MAX_HISTORY, type ReplOptions, type ReplMessage } from './repl/Repl.js';
export {
  renderWelcome,
  renderStatusLine,
  renderHelpTable,
  initBlackBackground,
  resetBackground,
  BG_BLACK,
  RST,
  blackWrap,
  SET_BLACK_BG,
  RESET_BG,
} from './repl/welcome.js';
export { renderStatusBar } from './repl/status-bar.js';
export type { StatusBarData } from './repl/status-bar.js';
export {
  parseSlashCommand,
  handleKey,
  slashHelpText,
  SLASH_COMMANDS,
  type SlashCommand,
  type KeyAction,
  type KeyHandlerContext,
} from './repl/InputHandler.js';

export {
  SANIX_LOGO,
  SANIX_TAGLINE,
  SANIX_BYLINE,
  printLogo,
  coloredBanner,
} from './logo.js';

export { main, createProgram } from './main.js';

// Re-export the command-register functions for callers that want to
// build a custom Commander program with only a subset of subcommands.
export { registerRunCommand, runCommand, type RunCommandOptions } from './commands/run.js';
export { registerChatCommand, chatCommand, type ChatCommandOptions } from './commands/chat.js';
export { registerCodeCommand, codeCommand, type CodeCommandOptions } from './commands/code.js';
export { registerAskCommand, askCommand, type AskCommandOptions } from './commands/ask.js';
export { registerMemoryCommand } from './commands/memory.js';
export { registerConfigCommand } from './commands/config.js';
export { registerProvidersCommand } from './commands/providers.js';
export { registerMcpCommand } from './commands/mcp.js';
export {
  registerAuthCommand,
  authLogin,
  authStatus,
  authLogout,
  authRefresh,
  authList,
  authWhoami,
  type AuthLoginOptions,
} from './commands/auth.js';

// Task A4 / Part 3: Auto-commit git integration.
export {
  AutoCommit,
  type AutoCommitOptions,
  type StartGoalResult,
} from './git/AutoCommit.js';

// Task A4 / Part 6: Workspace context loader.
export {
  WorkspaceLoader,
  type WorkspaceContext,
  type ProjectLanguage,
  type PackageManager,
  type SelectRelevantFilesOptions,
  type BuildContextStringOptions,
} from './workspace/WorkspaceLoader.js';

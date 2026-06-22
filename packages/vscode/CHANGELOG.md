# Change Log

All notable changes to the SANIX VSCode extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-06-22

### Added
- Initial release of the SANIX VSCode extension.
- 12 commands: open chat, send to chat, inline edit (Cmd+K), run agent, run UltraWorker, explain, fix, commit, doctor, sessions list/switch, show cost.
- 10 configuration settings (cliPath, defaultModel, streamOutput, maxInlineSelectionChars, autoApplyDiffs, showStatusBar, theme, costWarningThresholdUsd, intelligencePipeline, enableVision).
- Sidebar chat webview with slash commands (`/clear`, `/agent`, `/session`, `/cost`, `/model`, `/provider`, `/help`).
- Streaming output (token-by-token rendering in the webview).
- Diff applier (parses ```diff fenced blocks, applies via `WorkspaceEdit` with native undo).
- Status bar integration (idle / running / streaming / cost-warning / cost-critical / error states).
- Auto-attaches to active SANIX session via `~/.sanix/sessions/active` file watcher.
- V16 Intelligence System integration — runs the 10-step pipeline via the `/intel` prefix.
- Programmatic API for other extensions (`runAgent`, `runUltraWorker`, `ask`, `vision`, `runIntelligencePipeline`, `getCostToday`, `getActiveSession`, `switchSession`).
- 3 editor/context menu items (Send to Chat, Explain, Run Agent).
- 3 keybindings (Cmd/Ctrl+K inline edit, Cmd/Ctrl+Shift+S send to chat, Cmd/Ctrl+Shift+Alt+S open chat).
- 2 contributed theme colors (`sanix.diffAdded`, `sanix.diffRemoved`).
- Compatible with VSCode 1.85+ (Mac, Windows, Linux).

### Known Limitations
- Requires the SANIX CLI to be installed and on PATH (or set `sanix.cliPath` to the binary).
- Streaming rendering is text-only — image responses are not yet rendered inline.
- The diff applier uses a simple string-contains match for hunk placement; very large diffs may need a manual review pass.

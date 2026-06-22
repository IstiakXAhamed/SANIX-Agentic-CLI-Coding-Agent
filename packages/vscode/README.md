# SANIX — Agentic Neural Intelligence eXecutor for VS Code

> SANIX in your editor — **22 specialized agents**, **streaming chat**, **inline edit (Cmd+K)**, a **diff applier** with native undo, and the **V16 speed-first intelligence pipeline** that makes at most 2 LLM calls per task.

SANIX is a self-directing, multi-provider, memory-aware, sub-agent-capable agentic CLI that rivals Claude Code, Cursor Agent, and Hermes combined. This package brings it into the editor you already live in, with a sidebar chat webview, inline edit, and deep integration with the SANIX CLI session store.

![SANIX in VS Code](media/icon.png)

---

## Table of Contents

1. [Features](#features)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Platform Support](#platform-support)
5. [Quick Start](#quick-start)
6. [Commands](#commands)
7. [Configuration](#configuration)
8. [Slash Commands](#slash-commands)
9. [Inline Edit (Cmd+K)](#inline-edit-cmdk)
10. [Diff Applier](#diff-applier)
11. [Status Bar](#status-bar)
12. [V16 Intelligence Pipeline](#v16-intelligence-pipeline)
13. [Programmatic API](#programmatic-api)
14. [Keybindings](#keybindings)
15. [Theme Colors](#theme-colors)
16. [Troubleshooting](#troubleshooting)
17. [Contributing](#contributing)
18. [License](#license)

---

## Features

- **Sidebar chat webview** — opens in the activity bar, with streaming token-by-token rendering, slash-command dispatch, and per-message metadata (model, cost).
- **12 commands** — open chat, send selection to chat, inline edit (Cmd+K), run a named agent, run the UltraWorker orchestrator, explain selection, fix issues, generate commit, doctor (health check), list/switch sessions, show cost.
- **3 context-menu items** — Send to Chat, Explain, Run Agent — appear on the editor context menu when a selection is active.
- **3 keybindings** — Cmd/Ctrl+K for inline edit, Cmd/Ctrl+Shift+S to send selection to chat, Cmd/Ctrl+Shift+Alt+S to open the chat sidebar.
- **10 configuration settings** covering CLI path, default model, streaming, max selection size, auto-apply diffs, status bar visibility, theme, cost thresholds, intelligence pipeline toggle, and vision enablement.
- **Diff applier** — parses ` ```diff ` fenced blocks returned by SANIX and applies them via a single `WorkspaceEdit` (so a single Ctrl+Z undoes the whole change). Auto-apply can be disabled in settings.
- **Status bar integration** — a single item in the bottom-right corner shows the current state (idle / running / streaming / cost-warning / cost-critical / error) plus the day's running cost and the active session id.
- **Auto-attaches to active SANIX session** — the extension watches `~/.sanix/sessions/active` so the sidebar always reflects the session the CLI is currently using.
- **V16 Intelligence Pipeline integration** — chat messages prefixed with `/intel ` are routed through the CLI's 10-step intelligence pipeline, which makes **at most 2 LLM calls** per task (1 for generation + 0-1 for verification fix) and runs every local operation in under 100 ms.
- **Programmatic API** — other VS Code extensions can call SANIX via `vscode.extensions.getExtension('istiak-ahamed.sanix')?.exports`. The exported object exposes `ask`, `runAgent`, `runUltraWorker`, `vision`, `runIntelligencePipeline`, `getCostToday`, `getActiveSession`, and `switchSession`.
- **2 contributed theme colors** — `sanix.diffAdded` and `sanix.diffRemoved` so users can customize how the diff applier highlights applied changes.
- **Self-contained** — the SANIX CLI runtime is bundled in the VSIX. No separate CLI installation or `PATH` setup needed. Works on macOS (arm64 & x64), Linux x64, and Windows x64. Tested against VS Code 1.85 through 1.95.

---

## Requirements

- **VS Code 1.85.0 or newer.**
- **Node.js 20+** (the SANIX CLI runtime requires Node 20+).
- **A SANIX provider configured** — Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together, Mistral, Ollama, LM Studio, or any OpenAI-compatible endpoint. Run `sanix config` to set API keys after installation.

> The SANIX CLI runtime is bundled inside the extension (see [Platform Support](#platform-support)). No separate CLI installation is required. Set `sanix.cliPath` only if you need to override the bundled binary with a custom build.

---

## Installation

### From the Marketplace (recommended)

1. Open the Extensions view in VS Code (`Cmd/Ctrl+Shift+X`).
2. Search for **SANIX**.
3. Click **Install**.

### From a `.vsix` file

```bash
code --install-extension sanix-1.0.0.vsix
```

### From source

```bash
cd packages/vscode
npm install
npm run package
code --install-extension sanix-1.0.0.vsix
```

---

## Platform Support

The SANIX CLI runtime is bundled directly inside the VSIX — no separate CLI installation or `PATH` setup needed.

### Binary Resolution Priority

When the extension activates, it locates the CLI binary in this order:

1. `sanix.cliPath` setting (developer override) — if set, use this absolute path
2. Bundled runtime — `bin/{platform}/sanix` inside the extension directory
3. `PATH` fallback — look for `sanix` on the system PATH

### VSIX Size & Contents

| Metric | Value |
|---|---|
| VSIX size | ~97 MB (compressed ZIP) |
| Files included | ~18,400 files |
| CLI bundle size | ~390 MB (raw, before ZIP compression) |
| Node modules | ~30,400 files (production-only, pruned) |
| npm packages in bundle | 731 (63 bloat packages stripped) |

### Bundled Native Modules

The VSIX ships with platform-specific native binaries for the build target's architecture:

| Module | Version | Raw Size | Purpose |
|---|---|---|---|
| `@lancedb/lancedb-darwin-arm64` | 0.30.0 | 104 MB | Vector database for memory & RAG |
| `onnxruntime-node` | 1.14.0 | 21 MB | ONNX model inference (LLM embedding) |
| `@xenova/transformers` | — | 10 MB | ML pipeline (SIMD WASM) |
| `better-sqlite3` | 11.10.0 | 1.9 MB | Session & metadata storage |
| `gpt-tokenizer` | — | 5.5 MB | Token counting & encoding |

### Supported Platforms

The VSIX is built per-target. Each build includes native binaries only for its host platform:

| Platform | Arch | Bootstrap Script |
|---|---|---|
| macOS | arm64 (Apple Silicon) | `bin/macos-arm64/sanix` |
| macOS | x64 (Intel) | `bin/macos-x64/sanix` |
| Linux | x64 | `bin/linux-x64/sanix` |
| Windows | x64 | `bin/win-x64/sanix.exe` |

To produce a VSIX for a different target platform, run the build on that platform:

```bash
cd packages/vscode
npm run build:cli   # prunes native modules to match build host
npm run build
npm run package     # produces <100 MB VSIX for this target
```

On Apple Silicon Macs, the x64 ONNX runtime binary is automatically stripped from the VSIX, saving ~6.5 MB compressed.

---

## Quick Start

1. Install the extension.
2. Click the **SANIX** icon in the activity bar (or run **SANIX: Open Chat** from the command palette).
3. Type a question and press **Enter** (or click **Send**).
4. Watch the response stream in token-by-token.
5. Select some code in your editor and press **Cmd/Ctrl+K** to edit it inline.
6. Type `/help` in the chat input to see all available slash commands.
7. Type `/intel <task description>` to run the V16 intelligence pipeline.

---

## Commands

All commands live under the `SANIX:` prefix in the command palette (`Cmd/Ctrl+Shift+P`).

| Command                              | Description                                                   |
| ------------------------------------ | ------------------------------------------------------------- |
| `SANIX: Open Chat`                   | Reveals and focuses the SANIX sidebar chat webview.           |
| `SANIX: Send Selection to Chat`      | Sends the active editor's selection to the chat sidebar.      |
| `SANIX: Inline Edit (Cmd+K)`         | Opens an input box; the LLM's response replaces the selection.|
| `SANIX: Run Agent...`                | QuickPick of the 22 SANIX agents; runs the chosen one.        |
| `SANIX: Run UltraWorker`             | Prompts for a goal; runs the UltraWorker orchestrator.        |
| `SANIX: Explain Selection`           | Sends the selection to `sanix explain`.                       |
| `SANIX: Fix Issues in File`          | Runs `sanix fix` on the active file.                          |
| `SANIX: Generate Commit`             | Runs `sanix commit` (dry-run first; user confirms).           |
| `SANIX: Doctor (Health Check)`       | Runs `sanix doctor` and shows the JSON report.                |
| `SANIX: Sessions — List`             | QuickPick of all sessions; pick one to switch.                |
| `SANIX: Sessions — Switch`           | InputBox for a session id to switch to directly.              |
| `SANIX: Show Cost (Today)`           | Shows today's USD cost in an info message + status bar.       |

---

## Configuration

Open settings (`Cmd/Ctrl+,`) and search for `sanix`:

| Setting                            | Type      | Default                          | Description                                                                 |
| ---------------------------------- | --------- | -------------------------------- | --------------------------------------------------------------------------- |
| `sanix.cliPath`                    | `string`  | `""`                             | Override path to the `sanix` CLI binary. Empty = use bundled runtime (see [Platform Support](#platform-support)). |
| `sanix.defaultModel`               | `string`  | `"anthropic:claude-sonnet-4"`    | Default model in `provider:model` format.                                   |
| `sanix.streamOutput`               | `boolean` | `true`                           | Token-by-token streaming in the webview.                                    |
| `sanix.maxInlineSelectionChars`    | `number`  | `8000`                           | Max chars sent to inline edit (Cmd+K). Larger selections are truncated.     |
| `sanix.autoApplyDiffs`             | `boolean` | `true`                           | Auto-apply ```diff fenced blocks via `WorkspaceEdit` (single Ctrl+Z undo).  |
| `sanix.showStatusBar`              | `boolean` | `true`                           | Show the SANIX status bar item.                                             |
| `sanix.theme`                      | `enum`    | `"auto"`                         | Webview theme: `auto` (follow VS Code) / `light` / `dark`.                  |
| `sanix.costWarningThresholdUsd`    | `number`  | `5.0`                            | Daily cost (USD) at which the status bar turns amber.                       |
| `sanix.costCriticalThresholdUsd`   | `number`  | `20.0`                           | Daily cost (USD) at which the status bar turns red.                         |
| `sanix.intelligencePipeline`       | `boolean` | `true`                           | Route `/intel`-prefixed messages through the V16 pipeline.                  |
| `sanix.enableVision`               | `boolean` | `true`                           | Allow image input (drag-and-drop into the chat webview).                    |

---

## Slash Commands

Type these in the chat input box:

| Command                          | Action                                                                  |
| -------------------------------- | ----------------------------------------------------------------------- |
| `/clear`                         | Clear all chat history (does not affect the SANIX CLI session store).   |
| `/agent <name> <prompt>`         | Run a named agent (e.g. `/agent coder refactor this function`).         |
| `/session`                       | List all SANIX sessions.                                                |
| `/session <id>`                  | Switch the active session.                                              |
| `/cost`                          | Show today's running cost (USD + token breakdown).                      |
| `/model <provider:model>`        | Override the model for the next message.                                |
| `/provider <name>`               | Override the provider for the next message.                             |
| `/intel <task>`                  | Run the V16 10-step intelligence pipeline on the task.                  |
| `/help`                          | Show this list inside the chat.                                         |

---

## Inline Edit (Cmd+K)

1. Select some text in any editor.
2. Press **Cmd+K** (Mac) or **Ctrl+K** (Windows/Linux).
3. Type an instruction (e.g. "rename `foo` to `bar` and add error handling").
4. Press **Enter**.
5. The selection is replaced with the LLM's output. A single **Cmd+Z** undoes the edit.

Selections longer than `sanix.maxInlineSelectionChars` (default: 8000) are truncated with a `/* …truncated… */` marker so you don't accidentally send a 50,000-line file to the model.

---

## Diff Applier

When SANIX returns a message that contains a ` ```diff ` fenced block, the extension parses it and (if `sanix.autoApplyDiffs` is `true`) applies the changes immediately via a single `vscode.WorkspaceEdit`. A single Ctrl+Z undoes the entire change.

The parser:

- Reads the `+++ b/path/to/file.ts` header to determine the target file.
- For each `@@ ... @@` hunk, finds the removed-text block in the file via `String.indexOf` and replaces it with the added-text block.
- If the removed block isn't found (e.g. context drift), the added block is appended at EOF with a warning.
- New files (where `+++` points to `/dev/null` is NOT supported; we treat `+++ /dev/null` as "skip") — actually no, we skip `--- /dev/null` as the source.

Each chat message that contains a diff also gets an **Apply Diff** button so you can re-apply or apply after editing the response.

The two contributed theme colors `sanix.diffAdded` and `sanix.diffRemoved` can be customized in your `settings.json`:

```json
"workbench.colorCustomizations": {
  "sanix.diffAdded": "#81b71b",
  "sanix.diffRemoved": "#e06c75"
}
```

---

## Status Bar

A single status-bar item appears in the bottom-right corner (next to the language indicator). Its icon, color, and tooltip change based on the current state:

| State           | Icon                       | Color                | When                                                          |
| --------------- | -------------------------- | -------------------- | ------------------------------------------------------------- |
| `idle`          | `$(sanix-idle)`            | default              | No active stream                                              |
| `running`       | `$(loading~spin)`          | default              | A non-streaming command is in flight                          |
| `streaming`     | `$(pulse)`                 | green (added)        | Token-by-token streaming is active                            |
| `cost-warning`  | `$(warning)`               | amber                | Today's cost ≥ `sanix.costWarningThresholdUsd`                |
| `cost-critical` | `$(error)`                 | red (error bg)       | Today's cost ≥ `sanix.costCriticalThresholdUsd`               |
| `error`         | `$(bug)`                   | red (error bg)       | The last CLI invocation failed                                |

Click the item to open the chat sidebar. The tooltip shows the current state plus the active session id. The item also displays the day's running cost (USD) and the active session id when present.

Set `sanix.showStatusBar` to `false` to hide the item entirely.

---

## V16 Intelligence Pipeline

The V16 intelligence pipeline is a 10-step, speed-first execution engine that powers the SANIX CLI's `intelligence run` command. It makes **at most 2 LLM calls** per task — one for generation, and zero or one for a verification fix if the first output fails the quality gate. Every local operation (pattern match, context index, error-pattern lookup, quality review) runs in under 100 ms.

The pipeline steps:

1. **Pattern match** — 32 built-in solution patterns; if one matches the task, instantiate it (0 LLM calls).
2. **Plan** — local `plan()` returns a `CotPlan` with steps + variable slots.
3. **Context inject** — BM25 + IDF over a 12-language symbol index; library docs cached at `~/.sanix/docs-cache/`.
4. **Examples** — 56-example TF-IDF bank (local hashing; no Xenova/transformers dependency).
5. **Assemble** — merge plan + context + examples into one comprehensive prompt, leaving `{{BODY:name}}` placeholders.
6. **Generate** — **LLM call #1**. Fill the placeholders.
7. **Verify** — run `tsc --noEmit` + `eslint --format json` + tests in parallel; collect errors.
8. **Fix** — **LLM call #2 (only if step 7 found errors)**. Send only the error list + the failing output.
9. **Quality gate** — 234-rule review (parallel) + 17-rule OWASP security scan + complexity check.
10. **Escalate** — if the quality score is below 50, escalate via the 6-level chain: Ollama → Groq → DeepSeek → GPT-4o-mini → Sonnet → Opus.

To invoke the pipeline from the chat webview, prefix your message with `/intel `:

```
/intel Add a /health endpoint to this Express app with tests, docs, and a CI step
```

The extension will call `sanix intelligence run` and stream the final output into the chat.

---

## Programmatic API

Other VS Code extensions can call SANIX via the exported API:

```typescript
import * as vscode from "vscode";

const sanixExt = vscode.extensions.getExtension<{
  ask(prompt: string, opts?: { model?: string; cwd?: string }): Promise<string>;
  runAgent(agent: string, prompt: string, opts?: { cwd?: string }): Promise<string>;
  runUltraWorker(goal: string, opts?: { cwd?: string }): Promise<string>;
  vision(imagePath: string, prompt: string, opts?: { model?: string }): Promise<string>;
  runIntelligencePipeline(task: string, opts?: { cwd?: string }): Promise<string>;
  getCostToday(): Promise<number>;
  getActiveSession(): Promise<SanixSession | null>;
  switchSession(sessionId?: string): Promise<SanixSession | null>;
}>("istiak-ahamed.sanix");

const sanix = sanixExt?.exports;
if (sanix) {
  const answer = await sanix.ask("What does this codebase do?");
  const summary = await sanix.runAgent("reviewer", selectedCode);
  const plan = await sanix.runIntelligencePipeline("Migrate this app to TypeScript");
  const cost = await sanix.getCostToday();
}
```

The full `SanixSession` type is exported from `@sanix/vscode/types`. The API surface is intentionally small — anything not exposed here can be invoked by shelling out to the `sanix` CLI.

---

## Keybindings

| Keybinding                       | Command                  | When                 |
| -------------------------------- | ------------------------ | -------------------- |
| `Cmd/Ctrl+K`                     | `sanix.inlineEdit`       | `editorTextFocus`    |
| `Cmd/Ctrl+Shift+S`               | `sanix.sendToChat`       | `editorHasSelection` |
| `Cmd/Ctrl+Shift+Alt+S`           | `sanix.openChat`         | always               |

These are the defaults — you can rebind them in your `keybindings.json` (`Cmd/Ctrl+Shift+P` → `Preferences: Open Keyboard Shortcuts`).

---

## Theme Colors

| Color ID             | Light default | Dark default | Description                                       |
| -------------------- | ------------- | ------------ | ------------------------------------------------- |
| `sanix.diffAdded`    | `#587c0b`     | `#81b71b`    | Color used for added lines in SANIX-applied diffs.|
| `sanix.diffRemoved`  | `#ad0707`     | `#e06c75`    | Color used for removed lines in SANIX-applied diffs.|

Override them in `settings.json`:

```json
"workbench.colorCustomizations": {
  "sanix.diffAdded": "#50c878",
  "sanix.diffRemoved": "#ff6b6b"
}
```

---

## Troubleshooting

### "SANIX: command not found"

The extension couldn't find a working `sanix` CLI binary. This should not happen with the bundled runtime — check the following:

1. **Unsupported platform** — the VSIX bundles native binaries only for macOS (arm64 & x64), Linux x64, and Windows x64. If you are on Linux arm64 or another unsupported platform, set `sanix.cliPath` to a custom build's path.
2. **Corrupted installation** — reinstall the extension: `code --uninstall-extension sanix-1.0.0.vsix && code --install-extension sanix-1.0.0.vsix`.
3. **Override not found** — if you set `sanix.cliPath`, verify the path exists and the binary is executable. Clear the setting to fall back to the bundled version.

### Chat sidebar shows nothing

1. Verify the CLI works: `sanix ask "hello"` in your terminal.
2. Check the SANIX config: `sanix config` — make sure a provider is configured.
3. Open the Output panel (`Cmd/Ctrl+Shift+U`) and select the **SANIX** channel to see logs.
4. Reload the window (`Cmd/Ctrl+Shift+P` → `Developer: Reload Window`).

### Diffs aren't being applied

- Check that `sanix.autoApplyDiffs` is `true`.
- Check that the LLM actually returned a ` ```diff ` block (open the chat sidebar and look for the fenced code block).
- Use the **Apply Diff** button on the message to apply manually.

### Cost thresholds aren't triggering

The status-bar cost is polled every 5 minutes. If you want a faster update, run **SANIX: Show Cost (Today)** manually.

### Inline edit (Cmd+K) doesn't replace the selection

Make sure you have an active selection (highlight some text first). The command is gated on `editorTextFocus` so it won't fire in terminal or output panels.

---

## Contributing

SANIX is developed in the open at <https://github.com/istiak-ahamed/sanix>. PRs welcome!

1. Clone the monorepo.
2. `bun install` (or `npm install`).
3. `cd packages/vscode && npm install`.
4. Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.
5. Make changes, reload the host to test.
6. Run `npm run package` to produce a `.vsix` for local testing before opening a PR.

See [PUBLISHING.md](./PUBLISHING.md) for the full release process.

---

## License

MIT © 2026 Istiak Ahamed. See [LICENSE](./LICENSE).

# SANIX VSCode Extension — Complete Build Bundle (v1.0.0, refreshed 2026-06-22)

This zip contains **everything** needed to install, develop, and publish the SANIX VSCode extension — **plus the latest full project README** so you have the complete picture.

## 📖 Two READMEs in this zip — read both

| File | Lines | What it covers |
|---|---|---|
| **`README.md`** | 344 | The VSCode extension itself — install, 12 commands, 10 settings, slash commands, inline edit (Cmd+K), diff applier, status bar, V16 pipeline integration, programmatic API, keybindings, theme colors, troubleshooting. This is the README that ships inside the `.vsix` and shows on the Marketplace page. |
| **`PROJECT-README.md`** | 996 | The full SANIX project — 45 packages, 22 agents, 19 LLM adapters (incl. OpenCode Zen + Groq free tiers), V16 Intelligence System, V18-A/V19-2 streaming, V18-C vision, V18-D cost dashboard, V18-F workspaces, V18-G MCP discovery, V18-L agent memory sharing, V20 model listing with FREE pills, desktop GUI, web dashboard, ~175,000 LOC. This is the README at the repo root. |

If you only read one, read `PROJECT-README.md` — it's the comprehensive overview. `README.md` is the VSCode Marketplace listing.

## What's inside

```
sanix-vscode-extension-v1.0.0/
├── sanix-1.0.0.vsix              ← Ready-to-install extension (32 KB)
├── README.md                     ← VSCode extension guide (344 lines, ships in .vsix)
├── PROJECT-README.md             ← Full project README (996 lines, repo root)
├── PUBLISHING.md                 ← Full publish guide (1,920 words, 12 sections)
├── CHANGELOG.md                  ← v1.0.0 release notes
├── LICENSE                       ← MIT
├── THIS-ZIP-GUIDE.md             ← This file
│
├── src/                          ← TypeScript source (22 files)
│   ├── extension.ts                — activate() / deactivate() entry
│   ├── config.ts                   — reads ~/.sanix/config.json
│   ├── types.ts                    — shared types
│   ├── api/SanixApi.ts             — programmatic API for other extensions
│   ├── chat/ChatViewProvider.ts    — sidebar chat webview
│   ├── diff/DiffApplier.ts         — parse + apply unified diffs
│   ├── intelligence/PipelineProxy.ts — V16 10-step pipeline integration
│   ├── providers/SanixCliProvider.ts — spawn `sanix` CLI child process
│   ├── providers/SessionWatcher.ts — watch ~/.sanix/sessions/active
│   ├── status/StatusBar.ts         — idle/running/cost status bar
│   └── commands/                   — 12 command handlers
│       ├── openChat.ts, sendToChat.ts, inlineEdit.ts, runAgent.ts
│       ├── runUltraWorker.ts, explain.ts, fix.ts, commit.ts
│       └── doctor.ts, sessionsList.ts, switchSession.ts, showCost.ts
│
├── webview/                      ← Sidebar chat web UI
│   ├── chat.html
│   ├── chat.css
│   └── chat.js
│
├── dist/                         ← Built output (committed for convenience)
│   ├── extension.js                — esbuild-bundled entry (26 KB)
│   └── webview/                    — copied webview assets
│
├── media/
│   └── icon.png                  ← 128×128 extension icon
│
├── .github/workflows/            ← GitHub Actions CI/CD
│   ├── publish-vscode.yml          — tag-triggered publish to Marketplace
│   └── vscode-ci.yml               — PR CI (typecheck + build + package)
│
├── package.json                  ← VSCode extension manifest (12 commands, 10 settings)
├── tsconfig.json                 ← TypeScript config
├── esbuild.config.mjs            ← Bundler config
└── .vscodeignore                 ← Files to exclude from .vsix
```

## Quick start

### Option A — Just install the prebuilt .vsix (no build needed)

```bash
code --install-extension sanix-1.0.0.vsix
```

Verify:
```bash
code --list-extensions | grep sanix
# → istiak-ahamed.sanix@1.0.0
```

**Prerequisite:** The SANIX CLI must be installed and on your PATH:
```bash
npm install -g sanix
sanix config init          # onboarding wizard
sanix providers add opencode-zen --api-key <key>   # 11 free models auto-shown!
sanix providers add groq --api-key <key>           # 25+ free models auto-shown!
```

### Option B — Develop from source

```bash
cd sanix-vscode-extension-v1.0.0
npm install                # install dev deps (esbuild, @types/vscode, @vscode/vsce)
npm run build              # rebuild dist/extension.js
npm run package            # rebuild sanix-1.0.0.vsix
code --install-extension sanix-1.0.0.vsix   # install fresh build
```

Press `F5` in VS Code to launch an Extension Development Host with SANIX loaded for live debugging.

## Publishing to the Marketplace

See **PUBLISHING.md** for the full 12-section guide. TL;DR:

1. Create a PAT at https://dev.azure.com (Marketplace > Manage scope, "All accessible accounts")
2. Add it as a GitHub repo secret named `VSCE_TOKEN`
3. Bump `version` in `package.json` + add a `CHANGELOG.md` entry
4. Tag and push:
   ```bash
   git tag vscode-v1.0.1
   git push origin vscode-v1.0.1
   ```
5. The `publish-vscode.yml` workflow builds, packages, publishes to the Marketplace, and creates a GitHub Release with the `.vsix` attached — all automatically.

## Commands provided (12)

| Command | Shortcut | Description |
|---|---|---|
| `sanix.chat.open` | — | Open the sidebar chat webview |
| `sanix.chat.send` | Right-click → "SANIX: Send to Chat" | Send current selection to chat |
| `sanix.inlineEdit` | `Cmd+K` / `Ctrl+K` | Inline edit selected code via LLM |
| `sanix.agent.run` | — | Pick from 22 agents + run on selection |
| `sanix.agent.runUltraWorker` | — | Quick UltraWorker run on current file |
| `sanix.explain` | Right-click → "SANIX: Explain" | Explain current file/selection |
| `sanix.fix` | — | Run `sanix fix` on current project |
| `sanix.commit` | — | Run `sanix commit` on staged changes |
| `sanix.doctor` | — | Run `sanix doctor` (16 health checks) |
| `sanix.session.list` | — | List all SANIX sessions |
| `sanix.session.switch` | — | Switch active session |
| `sanix.cost.show` | — | Show today's cost in status bar |

## Settings (10)

| Setting | Default | Description |
|---|---|---|
| `sanix.cliPath` | `"sanix"` | Path to the SANIX CLI binary |
| `sanix.defaultModel` | `""` | Default model id (provider-specific) |
| `sanix.streamOutput` | `true` | Stream tokens to webview in real-time |
| `sanix.maxInlineSelectionChars` | `2000` | Auto-fork to chat above this size |
| `sanix.autoApplyDiffs` | `false` | Auto-apply detected diffs |
| `sanix.showStatusBar` | `true` | Show the SANIX status bar |
| `sanix.theme` | `"auto"` | `auto` / `dark` / `light` |
| `sanix.costWarningThresholdUsd` | `1.0` | Red status bar above this daily cost |
| `sanix.intelligencePipeline` | `true` | Use V16 10-step pipeline for `run` |
| `sanix.enableVision` | `true` | Allow `--image` in chat |

## License

MIT © 2026 Istiak Ahamed. See `LICENSE` for details.

## Links

- **SANIX main repo:** https://github.com/istiak-ahamed/sanix
- **SANIX CLI:** `npm install -g sanix`
- **Marketplace (when published):** https://marketplace.visualstudio.com/items?itemName=istiak-ahamed.sanix
- **Report issues:** https://github.com/istiak-ahamed/sanix/issues

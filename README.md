<div align="center">

<pre>
░██████╗░░█████╗░███╗░░██╗██╗██╗░░██╗
██╔════╝░██╔══██╗████╗░██║██║╚██╗██╔╝
╚█████╗░░███████║██╔██╗██║██║░╚███╔╝░
░╚═══██╗░██╔══██║██║╚████║██║░██╔██╗░
██████╔╝░██║░░██║██║░╚███║██║██╔╝╚██╗
╚═════╝░░╚═╝░░╚═╝╚═╝░░╚══╝╚═╝╚═╝░░╚═╝
</pre>


# SANIX —Self-Adaptive Agentic Neural Intelligence eXecutor

### *Your terminal. Your agent *

**Created by Istiak Ahamed** · **All Rights Reserved © 2026**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![Packages](https://img.shields.io/badge/packages-45-orange.svg)](#packages)
[![Agents](https://img.shields.io/badge/agents-22-purple.svg)](#specialized-agents)
[![Adapters](https://img.shields.io/badge/LLM%20adapters-19-cyan.svg)](#-packages-45)
[![Tests](https://img.shields.io/badge/tests-343%2F343-brightgreen.svg)](#testing)
[![VSCode](https://img.shields.io/badge/VSCode-extension-blue.svg)](#-vscode-extension-v18-b)
[![FREE Models](https://img.shields.io/badge/FREE%20models-36%2B-brightgreen.svg)](#-model-listing-with-free-pills-v20)

A production-grade, agentic AI platform with **45 packages** (incl. 8 curated plugins + a VSCode extension), **22 specialized agents** (incl. the **UltraWorker** Autonomous Master Orchestrator), **19 LLM adapters** (incl. **OpenCode Zen** with 11 always-free models + **Groq** with 25+ free dev-tier models), **9 memory tiers**, a **speed-first Intelligence System** (10 modules, max 2 LLM calls/task, 606 built-in rules/patterns/examples), **streaming output** everywhere (ask/run/agent run), **multimodal vision**, **voice mode** (push-to-talk + VAD), **workspace manager**, **MCP auto-discovery**, **agent memory sharing** (shared RunContext scratchpad), **real-time cost dashboard** (SQLite + 4 recharts charts), **auto-updater** (atomic binary swap), **model listing with green FREE pills**, a **desktop GUI** (macOS/Windows/Linux), a **web dashboard**, **Autonomous Ultra Agents**, and **~175,000 lines of TypeScript**.

</div>

---

## 📋 Table of Contents

- [Quick Start](#-quick-start)
- [Desktop App Installation](#-desktop-app-installation)
- [CLI Installation](#-cli-installation)
- [Specialized Agents (22)](#-specialized-agents-22)
- [Speed-First Intelligence System (V16)](#-speed-first-intelligence-system-v16)
- [VSCode Extension (V18-B)](#-vscode-extension-v18-b)
- [All Features](#-all-features)
- [CLI Commands](#-cli-commands)
- [Packages (45)](#-packages-45)
- [Guides](#-guides)
- [Troubleshooting](#-troubleshooting)
- [License](#-license)

---

## 🚀 Quick Start

### Option A: Desktop App (Recommended)

**macOS:**
1. Download `SANIX-1.0.0-mac.dmg` from [Releases](https://github.com/istiak-ahamed/sanix/releases)
2. Open the `.dmg` file
3. Drag SANIX to your Applications folder
4. **Right-click** SANIX → **Open** → **"Open anyway"** (first launch only — bypasses Gatekeeper)
5. SANIX is ready!

**Windows:**
1. Download `SANIX-1.0.0-win.exe` from [Releases](https://github.com/istiak-ahamed/sanix/releases)
2. Run the `.exe` file
3. Click **"More info"** → **"Run anyway"** (bypasses SmartScreen)
4. Follow the installer
5. SANIX is ready!

**Linux:**
1. Download `SANIX-1.0.0-linux.AppImage` from [Releases](https://github.com/istiak-ahamed/sanix/releases)
2. `chmod +x SANIX-*.AppImage`
3. `./SANIX-*.AppImage`

### Option B: CLI Only

```bash
# One-line install (macOS/Linux)
curl -fsSL https://sanix.dev/install.sh | bash

# Or via npm
npm install -g sanix

# Then just type:
sanix
```

### First Run

```bash
sanix config init          # Interactive onboarding wizard
export ANTHROPIC_API_KEY=sk-ant-...   # Set an API key
sanix ask "hello"          # Quick question
sanix run "refactor auth"  # Full agent run
```

---

## 🖥️ Desktop App Installation

### macOS (.dmg)

#### Step-by-step Guide

1. **Download** the `SANIX-1.0.0-mac.dmg` file from the [Releases page](https://github.com/istiak-ahamed/sanix/releases)

2. **Open** the `.dmg` file by double-clicking it

3. **Install** — Drag the SANIX icon to the Applications folder

4. **First Launch** — Because SANIX is not code-signed (no Apple Developer certificate), macOS will show "SANIX cannot be opened because it is from an unidentified developer." To bypass:
   - **Method 1 (Recommended):** Right-click (or Control-click) the SANIX app → select **"Open"** → click **"Open"** in the dialog
   - **Method 2:** Go to **System Settings** → **Privacy & Security** → scroll down → click **"Open Anyway"** next to the SANIX warning
   - **Method 3 (Terminal):** `xattr -cr /Applications/SANIX.app`

5. **Subsequent launches:** Just double-click SANIX normally — no warning after the first time

6. **SANIX is ready!** The app will auto-start the REST API server and load the dashboard

#### macOS Requirements
- macOS 10.13 (High Sierra) or later
- Node.js 20+ (for CLI features)
- 500MB free disk space

### Windows (.exe)

#### Step-by-step Guide

1. **Download** the `SANIX-1.0.0-win.exe` file from the [Releases page](https://github.com/istiak-ahamed/sanix/releases)

2. **Run** the `.exe` file by double-clicking it

3. **SmartScreen Warning** — Windows will show "Windows protected your PC." To bypass:
   - Click **"More info"**
   - Click **"Run anyway"**

4. **Install** — Follow the installer wizard:
   - Choose installation directory (default: `C:\Users\{user}\AppData\Local\SANIX`)
   - Choose whether to create desktop shortcut (recommended)
   - Choose whether to create Start Menu shortcut (recommended)
   - Click **Install**

5. **Launch** — SANIX will launch automatically after installation, or find it in:
   - Desktop shortcut
   - Start Menu → SANIX
   - Or run `SANIX.exe` from the installation directory

6. **SANIX is ready!** The app will auto-start the REST API server and load the dashboard

#### Portable Version
- Download `SANIX-1.0.0-portable.exe` — no installation needed, just run it

#### Windows Requirements
- Windows 10 or later (64-bit)
- Node.js 20+ (for CLI features)
- 500MB free disk space

### Linux (AppImage)

1. Download `SANIX-1.0.0-linux.AppImage`
2. `chmod +x SANIX-*.AppImage`
3. `./SANIX-*.AppImage`
4. For desktop integration: `sudo apt install libappindicator1` (optional)

---

## 📦 CLI Installation

### One-Line Install

```bash
curl -fsSL https://sanix.dev/install.sh | bash
```

This script:
- ✅ Checks prerequisites (Node.js 20+, npm, git)
- ✅ Clones the repository
- ✅ Installs all dependencies
- ✅ Builds all 43 packages
- ✅ Links the `sanix` command globally
- ✅ Installs shell completions (bash/zsh/fish)
- ✅ Runs the onboarding wizard

### npm Install

```bash
npm install -g sanix
```

### Build from Source

```bash
git clone https://github.com/istiak-ahamed/sanix.git
cd sanix
npm install
npm run build
npm link
```

### Verify Installation

```bash
sanix --version      # 1.0.0
sanix --help         # Shows all commands
sanix providers list # Lists 19 LLM providers (incl. OpenCode Zen with free models)
```

### Shell Completions

```bash
# Bash
echo 'eval "$(_SANIX_COMPLETE=bash sanix)"' >> ~/.bashrc

# Zsh
echo 'eval "$(_SANIX_COMPLETE=zsh sanix)"' >> ~/.zshrc

# Fish
sanix completions fish > ~/.config/fish/completions/sanix.fish

# PowerShell
sanix completions powershell | Out-String | Invoke-Expression
```

---

## 🤖 Specialized Agents (22)

SANIX includes 22 specialized AI agents, each an expert in its domain. The **UltraWorker** orchestrator can spawn and manage all other agents.

### 👑 UltraWorker — Master Orchestrator

The most powerful agent. Takes any goal, decomposes it, selects the right agents, spawns them in parallel, collects results, and delivers a unified output.

```bash
sanix agent run ultra-worker "Audit this entire codebase"
# UltraWorker spawns: SecuritySentinel + PerfProfiler + RefactorRanger + DependencyDetective (parallel)
# Then: TestArchitect + DocDoctor (Phase 2)
# Then: synthesizes all findings into one report
```

### All 22 Agents

| # | Agent | Icon | Category | What It Does |
|---|---|---|---|---|
| 1 | **Security Sentinel** | 🛡️ | Security | Scans for OWASP Top 10, hardcoded secrets, dependency CVEs, insecure configs, crypto weaknesses. Auto-generates patches. |
| 2 | **Migration Maestro** | 🚚 | Migration | Handles JS→TS, Vue 2→3, Python 2→3, Express→Fastify, CommonJS→ESM. Rewrites code, updates configs, runs tests. |
| 3 | **Test Architect** | 🧪 | Testing | Analyzes coverage gaps, generates unit/integration/e2e tests, mocks dependencies, runs mutation testing. |
| 4 | **Perf Profiler** | ⚡ | Performance | Profiles CPU/memory/I/O, finds bottlenecks, suggests optimizations, benchmarks before/after. |
| 5 | **Doc Doctor** | 📝 | Documentation | Generates JSDoc/docstrings, architecture diagrams, READMEs, changelogs. Detects doc drift. |
| 6 | **Refactor Ranger** | 🔧 | Refactoring | Detects code smells (long methods, god classes, duplication), applies design patterns, verifies via tests. |
| 7 | **Dependency Detective** | 🔍 | Dependencies | Audits for CVEs, license issues, outdated versions, unused packages, bundle size. Auto-updates safely. |
| 8 | **API Designer** | 🎨 | API | Designs REST/GraphQL APIs, generates OpenAPI specs, mock servers, SDK clients, Postman collections. |
| 9 | **DBA Agent** | 🗄️ | Database | Analyzes schemas, suggests indexes, finds slow queries, detects N+1 problems, generates migrations. |
| 10 | **DevOps Engineer** | 🚀 | DevOps | Writes Dockerfiles, CI/CD pipelines, Terraform, Kubernetes manifests, monitoring configs. |
| 11 | **Data Scientist** | 📊 | Data Science | Cleans data, EDA, builds ML models, generates visualizations, writes analysis reports. |
| 12 | **Accessibility Auditor** | ♿ | Accessibility | Scans for WCAG violations, color contrast, keyboard navigation, ARIA labels. Auto-generates fixes. |
| 13 | **Changelog Generator** | 📋 | Release | Analyzes git history, categorizes changes, generates changelogs, bumps versions, creates release notes. |
| 14 | **Onboarding Buddy** | 🤝 | Onboarding | Analyzes codebase, generates a tour (entry points, key modules, patterns, setup guide). |
| 15 | **Bug Bounty Hunter** | 🐛 | Debugging | Fuzzes inputs, tests edge cases, checks race conditions, finds memory leaks. Reports with repro steps. |
| 16 | **Cost Optimizer** | 💰 | Optimization | Analyzes cloud bills, finds idle resources, right-sizes instances, suggests reserved instances. |
| 17 | **Pair Programmer** | 👥 | Pairing | Watches your edits in real-time, suggests improvements, catches bugs, explains code, asks questions. |
| 18 | **Retro Agent** | 🕰️ | Learning | Learns from past failures, avoids repeating mistakes, suggests proven approaches. Gets smarter over time. |
| 19 | **Code Archaeologist** | 🏺 | Analysis | Digs through git history, explains why code was written a certain way, traces feature evolution. |
| 20 | **Log Detective** | 🔍 | Monitoring | Analyzes logs, finds anomalies, traces request flows, identifies error patterns, generates incident reports. |
| 21 | **UI/UX Designer** | 🎨 | Design | Designs interfaces, generates component code, creates design systems, wireframes, themes, micro-animations. |
| 22 | **UltraWorker** | 👑 | Orchestration | Master agent — decomposes goals, spawns other agents in parallel, synthesizes results, resolves conflicts. |

### Using Agents

```bash
# List all agents
sanix agent list

# Run a specific agent
sanix agent run security-sentinel "Scan for vulnerabilities"

# Run the UltraWorker (spawns other agents automatically!)
sanix agent run ultra-worker "Set up a new project: design UI, create API, write tests, CI/CD"
```

### Programmatic API

```typescript
import { getGlobalRegistry } from '@sanix/agents';

const registry = getGlobalRegistry();

// List all 22 agents
registry.list();

// Run the security scanner
await registry.get('security-sentinel')!.run('Scan this codebase');

// Run UltraWorker — it spawns other agents automatically!
await registry.get('ultra-worker')!.run('Audit everything', { registry });

// Run the UI/UX Designer
await registry.get('ui-designer')!.run('Design a login page with OAuth');
```

---

## ✨ All Features

### 🧠 Agentic Core
- OODA Agent Loop (Observe → Orient → Decide → Act) with self-critique
- Two-Phase Planner with dynamic replanning
- Sub-Agent Orchestration (parallel, compressed context)
- Hooks System (14 event types, veto-capable)
- Checkpoint & Resume
- Conversation Branching (fork, switch, diff)
- Tool Approval Workflow (risk assessment)
- Auto-Commit Git Integration

### 🤖 Multi-Agent System
- 7 Team Strategies (Parallel, Sequential, Debate, Voting, MoE, Hierarchical, Swarm)
- 6 Consensus Methods (Majority, Supermajority, Unanimous, Weighted, Judge, Best-of-N)
- 8 Agent Personas (Researcher, Coder, Reviewer, Architect, Debugger, Explainer, Planner, Writer)

### 🔍 RAG 2.0
- Hybrid Retrieval (HNSW vector + BM25 + keyword, z-score fusion)
- 4 Reranking Methods (Cross-encoder, LLM, mono-T5, none)
- 6 Query Rewriting Methods (Expand, Decompose, HyDE, Step-back, Rephrase, Multilingual)
- Multi-Hop Retrieval (LLM-judged chaining)
- Citation Extraction

### 🧬 Memory System (9 Tiers)
- Sensory → Working → Episodic → Semantic → Procedural → Prospective → Metacognitive → Social → Spatial
- HNSW Vector Index (pure TypeScript, no native deps)
- Ebbinghaus Forgetting Curve (spaced repetition)
- Salience Scoring (novelty + importance + recency + frequency + valence)
- Semantic Deduplication
- Auto Tier Promotion/Demotion

### 🗜️ Token Optimization (50%+ Reduction)
- 7-Stage Pipeline (tool desc compression → message dedup → prompt minification → structured compression → LLMlingua-2 → context window optimization → budget enforcement)
- Exact Tokenizer (GPT BPE, provider-specific)
- Streaming Token Counter (real-time)
- Prompt Cache Manager

### 🔐 Authentication
- OAuth 2.0 PKCE (Google, GitHub, Anthropic, Microsoft)
- Secret Vault Integration (1Password, Bitwarden, HashiCorp Vault, LastPass, KeePass, pass)
- Profile Management

### 🌐 Distributed Mode
- 5 Service Discovery Backends (Static, DNS, Consul, Kubernetes, etcd)
- 4 Load Balancing Strategies
- Cluster Coordinator + Worker Nodes

### 📊 Observability
- OpenTelemetry Tracing (span tree per agent run)
- 7 Pre-Registered Metrics
- Cost Tracker (per-provider pricing)
- Telemetry (error monitoring, crash reporter, auto-updater, health checks)
- Audit Log (SHA-256 hash chain, tamper-proof, SOC2/GDPR/HIPAA/PCI/ISO27001/NIST compliance)

### 🛠️ Tools (40+)
- Filesystem (6): read, write, edit (3 modes), search, list, watch
- Shell (4): bash (sandboxed), process management, env
- Code (5): AST analysis, linting, test running, dependency analysis, codebase indexing
- Web (3): search, fetch, document reader
- Memory (4): remember, recall, forget, summarize
- MCP (dynamic): Model Context Protocol client
- Browser (17): navigate, click, type, scroll, screenshot, extract, evaluate, PDF, etc.
- Sandbox (8 runtimes): Node, Python, Deno, Bun, Go, Rust, Bash, Custom — Docker isolation

### 📄 Document AI
- 6 Formats: PDF, DOCX, PPTX, XLSX, HTML, Image
- OCR (Tesseract + Vision LLM)
- Table Extraction, Summarization, Document QA

### 🗄️ Natural Language → SQL
- 4 Dialects (SQLite, PostgreSQL, MySQL, MSSQL)
- Schema Extraction, SQL Generation, Validation, Execution, Chart Suggestions

### 🧬 Self-Improvement
- Prompt Evolution (genetic algorithm, 8 mutation strategies)
- A/B Testing (statistical z-test)
- Meta-Learning (multi-armed bandit)

### 🎯 Code Intelligence
- LSP Integration (tsserver, pyright, gopls, rust-analyzer)
- Symbol Extraction (6 languages)
- Call Graph, References, Type Hierarchy
- Semantic Code Search

### ⚡ Performance
- Worker Thread Pool, Connection Pool, Request Batcher
- 3-Level Cache (L1 LRU → L2 LRU → L3 disk)
- Lazy Loading, Performance Monitor

### 🖥️ Desktop GUI (Electron)
- Cross-platform (macOS, Windows, Linux)
- System tray, native notifications, deep links
- Auto-starts REST API server
- Window state persistence

### 🌐 Web Dashboard (Next.js 16)
- 11 pages, multi-tab chat, visual workflow editor
- Agent graph visualizer, live analytics
- Knowledge graph explorer, multi-agent team console
- Command palette (Cmd+K), keyboard shortcuts

### ✨ Polish
- Animated Spinners (5 themes), Progress Bars, Onboarding Wizard
- Error Formatter (actionable suggestions), Banner Renderer
- Status Line, Table Renderer, Confetti, Toast Notifications

### 🎨 OpenCode-Style Terminal UI (V21)
- **Vertically centered layout** — Logo + input box centered in the terminal with flex padding
- **Gradient logo** — Per-character cyan→violet RGB gradient on the SANIX Unicode block-letter logo
- **Input box** — Simple bordered box with `✨ Ask anything... "Fix anything"` placeholder, agent/model info below
- **Keyboard hints** — Centered `tab agents / ctrl+p commands` below the input box
- **Tip line** — `● Tip Type /help to see all commands` with amber accent
- **Bottom status bar** — `~/path:branch · provider /help for commands` (left) + `v1.0.0` (right), matching OpenCode's footer format
- **Clean prompt** — Minimal `>` prompt (dimmed) with terminal clear on REPL start for a fresh slate
- **ChatGPT-style messages** — `You` (teal) / `SANIX` (amber) bold labels with 2-space indented content
- **Dynamic status bar** — Provider + message count + version shown after each assistant reply
- **No outer borders** — Clean minimal design without box-drawing borders wrapping the screen
- Files: `packages/cli/src/repl/welcome.ts`, `packages/cli/src/repl/status-bar.ts`, `packages/cli/src/repl/Repl.ts`

### 🆓 OpenCode Zen Provider (V20)
- New adapter `OpencodeZenAdapter` at `packages/providers/src/adapters/OpencodeZenAdapter.ts`
- Base URL: `https://inference.de-fra.zenformation.com/v1` (OpenAI-compatible)
- Auth: `OPENCODE_ZEN_API_KEY` env var (or `--api-key` flag)
- **11 always-free models** (auto-tagged with FREE pill):
  - `zen-zeta-1`, `zen-agent`, `zen-flash`, `zen-mini` (OpenCode Zen in-house)
  - `qwen2.5-coder-32b-instruct`, `qwen2.5-72b-instruct`, `llama-3.3-70b-instruct`
  - `deepseek-r1-distill-qwen-32b`, `mistral-7b-instruct-v0.3`, `gemma-2-9b-it`, `phi-3.5-mini-instruct`
- Quick add: `sanix providers add opencode-zen --api-key <key>` (URL auto-filled)
- Models with `zen-` prefix are always free; community open-weights models are hardcoded in `KNOWN_FREE_MODEL_IDS`

### 🆓 Groq Free Dev Tier (V20)
- `GroqAdapter` overrides `isModelFree()` to return `true` for every model — Groq's entire chat catalog is free during the dev/beta tier
- **25+ known-free Groq models** surface with FREE pills immediately after `sanix providers add groq`:
  - Llama: `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `llama3-70b-8192`, `llama3-8b-8192`, etc.
  - Qwen: `qwen-2.5-72b-versatile`, `qwen-2.5-coder-32b-versatile`, `qwen2.5-72b-instruct`, etc.
  - Gemma: `gemma2-9b-it`, `gemma-7b-it`
  - Mistral: `mixtral-8x7b-32768`, `mistral-saba-24b`
  - DeepSeek: `deepseek-r1-distill-llama-70b`, `deepseek-r1-distill-qwen-32b`
  - Whisper (audio): `whisper-large-v3`, `whisper-large-v3-turbo`, `distil-whisper-large-v3-en`
  - Kimi: `kimi-k2-instruct`
- Quick add: `sanix providers add groq --api-key <key>` (URL auto-filled)
- Aliases `groq`, `groq-*`, `llama-*`, `qwen-*`, `mixtral-*`, `gemma*` all route to GroqAdapter when no `--url` is given

### 🏷️ Model Listing with FREE Pills (V20)
- `sanix providers add <name> --api-key <key>` — **auto-fetches the model list immediately after adding** and renders it inline with green **` FREE `** pills beside every free model. No need to run a separate command. Pass `--no-fetch` to skip.
- `sanix providers models [providerId]` — re-fetch the model list anytime (uses 60s cache)
- Free models get a green **` FREE `** pill beside the model name (chalk.bgGreen.black)
- `--free-only` filters to just free models
- `--json` for machine-readable output (array of ModelInfo objects)
- `--refresh` bypasses the 60s cache
- Special-cases (surface known-free models even before the first API call):
  - **OpenCode Zen** — 11 always-free models (zen-* + 7 community open-weights)
  - **Groq** — 25+ free models (entire chat catalog free during dev/beta tier)
  - **Ollama / LM Studio** — every local model is free (runs on user's hardware)
- `listModels()` method on IProvider — implemented for OpenAI, OpenAI-compat (Groq, Together, DeepSeek, Mistral, LM Studio, OpenCode Zen), with 60s cache + never-throws semantics
- Inline summary header: `📦 25 model(s) available · 25 FREE · 0 paid`
- Models sorted: free first, then alphabetical
- Graceful degradation: if the API call fails (invalid key, network), prints a yellow warning with diagnostic suggestions and exits cleanly

### 🎬 Streaming Output Everywhere (V18-A + V19-2)
- `sanix ask "question" --stream` — tokens stream to stdout as they arrive (V18-A)
- `sanix run "goal" --stream` — stream during goal execution (V19-2)
- `sanix agent run <id> "goal" --stream` — stream agent's response (V19-2)
- 10-frame braille spinner with 500ms debounce (only animates when waiting)
- Live latency + token + char count stats (`--stats`)
- Spinner suppression (`--no-spinner`) for piping
- Aborts cleanly on `Ctrl+C` (signal-aware)
- 5-10× perceived latency reduction vs. waiting for full response

### 📜 Run History (V19-3)
- `sanix history` — list recent RunContext summaries (last 20 by default)
- `sanix history <runId>` — show full summary (writers, entries, metadata)
- `sanix history <runId> --entries` — show every scratchpad entry in full
- `sanix history --json` — machine-readable output
- `sanix history --purge` — delete summaries older than 30 days (`--force` to skip confirmation)
- Auto-suggests similar run ids on typo (prefix matching)

### 👁️ Multimodal Vision (V18-C)
- `sanix ask "describe this" --image screenshot.png` (single image)
- `sanix ask "compare these" --image a.png --image b.png` (multi-image)
- `sanix vision ./image.png "find the bug"` (dedicated command)
- 3 vision-capable providers: OpenAI (gpt-4o), Anthropic (claude-3-5-sonnet), Gemini (gemini-1.5-pro)
- Auto MIME-type detection (.png, .jpg, .gif, .webp)
- Image input via file path, data URI, or remote URL

### 🎙️ Voice Mode (V18-K)
- Push-to-talk (spacebar) + Voice Activity Detection (VAD) modes
- 3 STT backends (Whisper API, Azure, local whisper-cpp)
- 4 TTS backends (OpenAI, ElevenLabs, Azure, local system voice)
- ANSI animated indicators (🎤 listening / ⚙️ transcribing / 💭 thinking / 🔊 speaking)
- TTS behavior modes: `always` / `on-voice-input` / `never`
- Graceful fallback to text mode when no microphone available

### 📊 Cost & Token Dashboard (V18-D)
- SQLite-backed cost tracker (`~/.sanix/costs.db`) — atomic, WAL-mode, 5 indexes
- 83-model pricing table (real 2024-2025 list prices per 1K tokens)
- Live dashboard at `/costs` with 4 recharts charts (daily bar, provider pie, task horizontal bar, token stacked area)
- KPI cards: Total Cost / Calls / Input Tokens / Output Tokens
- Sortable provider breakdown table + recent calls table
- Budget alert banner (set `SANIX_BUDGET_USD=5.00` env)
- Date range picker: Today / 7d / 30d / All time
- REST API: `GET /api/costs?range=today|7d|30d|all`

### 🔄 Auto-Updater (V18-J)
- GitHub Releases integration — checks `istiak-ahamed/sanix/releases/latest`
- Hand-rolled semver compare (no dep on `semver`)
- Streaming download + SHA256 verification + atomic binary swap
- Automatic rollback from `.bak` on any failure
- `sanix update check` / `sanix update install` / `sanix update --auto`
- Desktop app: electron-updater with native notifications + `quitAndInstall`
- 1-hour cache to avoid GitHub API rate-limiting

### 🗂️ Workspace Manager (V18-F)
- Multi-project support — each workspace has its own config, sessions, agents
- Atomic JSON-per-workspace persistence at `~/.sanix/workspaces/<id>.json`
- Auto-detection: SANIX switches workspaces based on current dir
- `sanix ws list/new/switch/show/rename/tag/untag/delete/export/import/stats`
- Sessions tagged with `workspaceId` for per-project history

### 🔌 MCP Server Auto-Discovery (V18-G)
- Scans project `.mcp.json` + parent dirs (stops at `.git`) + global paths
- Validates official MCP config schema (`{mcpServers: {<name>: {command, args, env}}}`)
- `sanix mcp scan` — list discovered servers
- `sanix mcp scan --watch` — continuous file-watch with 500ms debounce
- `sanix mcp scan --register` — auto-register with running SANIX MCP client

### 🧠 Agent Memory Sharing (V18-L)
- Shared `RunContext` scratchpad for multi-agent runs
- In-memory + on-disk (`~/.sanix/runs/<runId>.jsonl` — append-only)
- UltraWorker auto-creates one + passes to every spawned agent
- Agents read each other's findings (`ctx.get('security.findings')`)
- `set` / `get` / `append` / `has` / `keys` / `snapshot` / `prefix` API
- Post-run summary file: `<runId>.summary.json`

### 🔍 Semantic Code Search Everywhere (V18-I)
- BM25 index auto-built on first use, cached at `~/.sanix/intel-cache/bm25-index.json`
- 5-minute TTL (refreshes on next call after expiry)
- `ask`, `run`, `agent run`, `explain`, `fix` auto-inject top-5 relevant code snippets when streaming
- No more `--context <file>` flags — context is always relevant
- Stop-word filtering, 50-line chunking with 10-line overlap
- Falls back silently if `@sanix/intel` is unavailable

### 🧩 Curated Plugin Pack (V18-H)
- 8 production-ready plugins at `packages/plugins/`:
  - `jest-test-gen` — generate Jest/Vitest tests from source
  - `prisma-helper` — schema validation, migration diff, seed gen
  - `docker-compose-gen` — generate compose files + Dockerfiles
  - `openapi-to-sdk` — generate TypeScript/Python/Go SDKs from OpenAPI specs
  - `commit-lint` — enforce Conventional Commits + suggest messages
  - `dep-checker` — audit vulnerabilities, unused, outdated, deprecated deps
  - `ai-review` — AI-powered code review (security/perf/style) with heuristic fallback
  - `release-notes` — generate release notes + bump versions from git log
- 17 tools total across the 8 plugins, all Zod-schema'd, JSDoc'd, zero `any`
- 100% test pass rate (343/343)

### 💾 Session Management (V13-1)
- Persistent sessions across CLI invocations + REPL restarts
- Atomic JSON writes (temp + rename) for crash-safety
- Fork from any message, search snippets, export (json/markdown/text)
- Tag/pin sessions, switch by ID prefix, REPL `/sessions` + `/session` commands

---

## 🎨 VSCode Extension (V18-B)

SANIX ships a first-class VSCode extension that wraps the CLI — bringing the full power of the 22 specialized agents, the V16 Speed-First Intelligence pipeline, and the V18 streaming/vision/voice features directly into your editor. The extension is shipped as a real `.vsix` package and includes a detailed `PUBLISHING.md` guide for marketplace publishing.

### Install the .vsix

```bash
# From source (development):
cd packages/vscode
npm install
npm run package      # produces dist/sanix-1.0.0.vsix
code --install-extension dist/sanix-1.0.0.vsix

# Or once published to the marketplace:
# Search "SANIX" in the VSCode Extensions panel
```

### 12 Commands

| Command | Shortcut | Description |
|---|---|---|
| `SANIX: Open Chat` | — | Open the sidebar chat webview |
| `SANIX: Send to Chat` | Right-click → "SANIX: Send to Chat" | Send current selection to chat |
| `SANIX: Inline Edit` | `Cmd+K` / `Ctrl+K` | Inline edit selected code via LLM |
| `SANIX: Run Agent` | — | Pick from 22 agents + run on selection |
| `SANIX: Run UltraWorker` | — | Quick UltraWorker run on current file |
| `SANIX: Explain` | Right-click → "SANIX: Explain" | Explain current file/selection |
| `SANIX: Fix` | — | Run `sanix fix` on current project |
| `SANIX: Commit` | — | Run `sanix commit` on staged changes |
| `SANIX: Doctor` | — | Run `sanix doctor` (16 health checks) |
| `SANIX: Sessions List` | — | List all SANIX sessions |
| `SANIX: Sessions Switch` | — | Switch active session |
| `SANIX: Show Cost` | — | Show today's cost in status bar |

### 10 Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `sanix.cliPath` | string | `"sanix"` | Path to the SANIX CLI binary |
| `sanix.defaultModel` | string | `""` | Default model id (provider-specific) |
| `sanix.streamOutput` | boolean | `true` | Stream tokens to webview in real-time |
| `sanix.maxInlineSelectionChars` | number | `2000` | Auto-fork to chat above this size |
| `sanix.autoApplyDiffs` | boolean | `false` | Auto-apply detected diffs |
| `sanix.showStatusBar` | boolean | `true` | Show the SANIX status bar |
| `sanix.theme` | enum | `"auto"` | `auto` / `dark` / `light` |
| `sanix.costWarningThresholdUsd` | number | `1.0` | Red status bar above this daily cost |
| `sanix.intelligencePipeline` | boolean | `true` | Use V16 10-step pipeline for `run` |
| `sanix.enableVision` | boolean | `true` | Allow `--image` in chat |

For the full VSCode walkthrough (sidebar chat, inline edit, agent runner, diff applier, status bar, sessions, intelligence pipeline integration, themes, troubleshooting, keyboard shortcuts, programmatic API, privacy, FAQ), see `packages/vscode/README.md` (4,796 words).

---

---

## 🛠️ CLI Commands

```bash
# Core Agent
sanix run "<goal>"           # One-shot goal execution
sanix chat                   # Interactive REPL (20+ slash commands)
sanix code "<task>"          # Code-focused agent mode
sanix ask "<question>"       # Quick question (read-only)

# Specialized Agents
sanix agent list             # List all 22 agents
sanix agent run <id> "<goal>" # Run a specific agent
sanix agent run ultra-worker "audit everything"  # Run the master orchestrator

# Multi-Agent Teams
sanix team solve <template> "<problem>"
sanix team list

# RAG
sanix rag ingest <path>      # Ingest file/directory
sanix rag query "<question>" # Ask against the RAG store

# Knowledge Graph
sanix kg ingest <path>       # Ingest into knowledge graph
sanix kg query "<question>"  # Semantic + graph search
sanix kg dsl "<query>"       # Cypher-like DSL query
sanix kg visualize <id>      # Visualize subgraph

# Code Sandbox
sanix sandbox run "<code>"   # Execute code in isolated sandbox
sanix sandbox repl           # Persistent REPL

# Self-Improvement
sanix evolve run "<prompt>"  # Evolve prompts via genetic algorithm
sanix evolve best            # Show best evolved prompt

# Token Optimization
sanix optimize <file>        # Optimize a prompt (50%+ reduction)
sanix optimize:stats         # Show savings statistics

# Auto-Tool Selection
sanix autotool recommend <task>  # Recommend best tools
sanix autotool execute <task>    # Auto-pick + execute

# Semantic Cache
sanix cache stats            # Cache statistics
sanix cache clear            # Clear the cache

# Management
sanix memory list            # List memories
sanix config init            # Interactive setup wizard
sanix providers list         # List 19 LLM providers
sanix providers models       # V20 — List models from all providers (FREE pills!)
sanix providers models opencode-zen   # List models from one provider
sanix providers models --free-only   # Show only free models
sanix providers add opencode-zen --api-key <key>  # Add OpenCode Zen (URL auto-filled, 11 free models)
sanix providers add groq --api-key <key>          # Add Groq (URL auto-filled, 25+ free models)
sanix auth login <provider>  # OAuth login
sanix auth status            # Auth status
sanix mcp list               # List MCP servers

# Streaming + Vision + Voice (V18-A/C/K + V19-2)
sanix ask "<q>" --stream      # Stream tokens to stdout (V18-A)
sanix run "<goal>" --stream   # Stream during goal execution (V19-2)
sanix agent run <id> "<g>" --stream  # Stream agent's response (V19-2)
sanix ask "<q>" --image p.png # Analyze an image (V18-C)
sanix chat --voice            # Push-to-talk voice mode (V18-K)

# Run History (V19-3)
sanix history                 # List recent RunContext summaries
sanix history <runId>         # Show a specific run's full summary
sanix history --purge         # Delete summaries older than 30 days

# Workspaces + MCP Discovery (V18-F/G)
sanix ws list                 # List all workspaces
sanix ws new <name>           # Create workspace for current dir
sanix ws switch <id|name>     # Switch active workspace
sanix mcp scan                # Discover .mcp.json files
sanix mcp scan --register     # Auto-register discovered servers

# Auto-Updater (V18-J)
sanix update check            # Check GitHub for newer version
sanix update install          # Download + atomic binary swap
```

---

## 📦 Packages (45)

| Package | Description |
|---|---|
| `@sanix/core` | OODA agent loop, 9-tier memory, token budget, tool registry, hooks, checkpoints |
| `@sanix/providers` | 19 LLM adapters (OpenAI, Anthropic, Gemini, Groq, Together, DeepSeek, Mistral, Ollama, LM Studio, **OpenCode Zen** + generic OpenAI-compat) + ProviderRouter with CircuitBreaker + `listModels()` with FREE pill tagging (V20) |
| `@sanix/tools` | 22+ tools (filesystem, shell, code, web, memory, MCP) |
| `@sanix/tui` | Ink v5 React TUI with 11 components |
| `@sanix/config` | Zod-validated config + ProfileManager + SecretManager |
| `@sanix/cli` | Commander.js CLI with 27 commands (incl. session, intelligence, init, fix, explain, commit, doctor, vision, update, workspace, mcp-scan, voice, stream, history, providers models) + OpenCode-style interactive REPL + Speed-First Intelligence System (10 modules, 606 built-in rules/patterns/examples) + Streaming/Vision/Voice/Workspace/RunHistory integrations |
| `@sanix/auth` | OAuth 2.0 PKCE (Google/GitHub/Anthropic/Microsoft) |
| `@sanix/optimizer` | Context/token optimization |
| `@sanix/memory-v2` | HNSW index, Ebbinghaus, salience, dedup |
| `@sanix/share` | File sharing (Gist, paste.rs, 0x0.st, transfer.sh) |
| `@sanix/server` | REST API server (14 routes) + MCP server mode |
| `@sanix/compressor` | LLM prompt compression + symbol-aware code context |
| `@sanix/workflows` | YAML pipelines + 8 personas + tool composition |
| `@sanix/dashboard` | Next.js 16 web UI |
| `@sanix/voice` | TTS (4 backends) + STT (3 backends) + VoiceAssistant |
| `@sanix/observe` | OpenTelemetry tracing + metrics |
| `@sanix/bench` | Benchmark suite (38 prompts, 6 categories) |
| `@sanix/multiagent` | 7 team strategies + 6 consensus methods |
| `@sanix/rag` | RAG 2.0 (hybrid retrieval, reranking, multi-hop) |
| `@sanix/semantic-cache` | Embedding-based LLM response cache |
| `@sanix/knowledge` | Knowledge graph + Cypher-like DSL |
| `@sanix/sandbox` | Docker-isolated code execution (8 runtimes) |
| `@sanix/self-improve` | Prompt evolution + A/B testing + meta-learning |
| `@sanix/distributed` | Multi-machine clusters (5 discovery backends) |
| `@sanix/browser` | Playwright automation (17 tools) + WebAgent |
| `@sanix/marketplace` | Plugin discovery + install + publish |
| `@sanix/token-slim` | Ultra token optimization (7-stage pipeline) |
| `@sanix/desktop` | Electron desktop GUI (cross-platform) |
| `@sanix/autotool` | Auto-tool selection + effectiveness tracking |
| `@sanix/telemetry` | Error monitoring + crash reporter + auto-updater |
| `@sanix/perf` | Worker pools, connection pools, cache hierarchy |
| `@sanix/intel` | LSP integration + symbol index + call graph |
| `@sanix/polish` | Animated spinners, onboarding wizard, error formatter |
| `@sanix/timetravel` | Time-travel debugger |
| `@sanix/audit` | Tamper-proof audit log + compliance (6 standards) |
| `@sanix/prbot` | PR review bot (52 rules, 4 platforms) |
| `@sanix/completions` | Shell completions (5 shells) |
| `@sanix/docai` | Document AI (PDF/DOCX/PPTX/XLSX/HTML/Image + OCR) |
| `@sanix/nlsql` | Natural Language → SQL (4 dialects) |
| `@sanix/vault` | Secret vault (1Password/Bitwarden/HashiCorp/LastPass/KeePass/pass) |
| `@sanix/federated` | Federated learning (5 aggregation strategies) |
| `@sanix/pluginsdk` | Plugin SDK + docs generator |
| `@sanix/agents` | 22 specialized agents (Security, Migration, Test, Perf, UltraWorker, etc.) |

---

## 📚 Guides

### Guide 1: First Run

```bash
# 1. Install SANIX
curl -fsSL https://sanix.dev/install.sh | bash

# 2. Run the onboarding wizard
sanix config init

# 3. Set an API key
export ANTHROPIC_API_KEY=sk-ant-...
# OR
export OPENAI_API_KEY=sk-...
# OR use OAuth
sanix auth login google

# 4. Ask a question
sanix ask "What does this codebase do?"

# 5. Run a full agent
sanix run "Add error handling to src/auth.ts"

# 6. Start interactive chat
sanix chat
```

### Guide 2: Using Specialized Agents

```bash
# Security scan
sanix agent run security-sentinel "Scan for vulnerabilities"

# Generate tests
sanix agent run test-architect "Generate tests for src/auth.ts"

# Refactor code
sanix agent run refactor-ranger "Reduce complexity in src/utils.ts"

# Design a UI
sanix agent run ui-designer "Design a settings page with tabs"

# Let UltraWorker handle everything
sanix agent run ultra-worker "Audit this entire codebase"
```

### Guide 3: Multi-Agent Teams

```bash
# List team templates
sanix team list

# Run a code review team (debate strategy)
sanix team solve code-review-team "Review the auth module"

# Compare strategies
sanix team compare code-review-team "Review auth" --strategies parallel,debate,voting
```

### Guide 4: RAG Pipeline

```bash
# Ingest documents
sanix rag ingest ./docs --recursive
sanix rag ingest ./README.md

# Query
sanix rag query "How does authentication work?"

# Search without generating
sanix rag search "authentication"
```

### Guide 5: Knowledge Graph

```bash
# Ingest code
sanix kg ingest ./src --source codebase

# Query
sanix kg query "Who created the auth module?"

# Cypher-like DSL
sanix kg dsl "MATCH (n:Person)-[:CREATED]->(m) RETURN n, m"

# Visualize
sanix kg visualize <entityId> --depth 2 --format mermaid
```

### Guide 6: Desktop App

1. Download from [Releases](https://github.com/istiak-ahamed/sanix/releases)
2. Install (see [Desktop App Installation](#-desktop-app-installation))
3. The app auto-starts the SANIX server
4. The dashboard loads automatically
5. Start chatting, running agents, or exploring features

### Guide 7: Token Optimization

```bash
# Optimize a prompt
echo "Please note that in order to use this feature, you need to..." | sanix optimize -

# Check savings
sanix optimize:stats

# Full report
sanix optimize:report
```

### Guide 8: Plugin Development

```typescript
import { definePlugin, defineTool } from '@sanix/pluginsdk';
import { z } from 'zod';

export default definePlugin({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'My custom SANIX plugin',
  author: 'Your Name',
  license: 'MIT',

  tools: [
    defineTool({
      name: 'my_tool',
      description: 'Does something cool',
      inputSchema: z.object({ input: z.string() }),
      outputSchema: z.object({ result: z.string() }),
      permissions: ['shell:exec'],
      execute: async (input) => ({ result: `Processed: ${input.input}` }),
    }),
  ],
});
```

---

## 🔧 Troubleshooting

### macOS: "SANIX cannot be opened because it is from an unidentified developer"

This is expected — SANIX is not code-signed (no Apple Developer certificate). To bypass:

**Method 1 (Recommended):**
1. Right-click (or Control-click) the SANIX app
2. Select **"Open"**
3. Click **"Open"** in the dialog

**Method 2:**
1. Go to **System Settings** → **Privacy & Security**
2. Scroll down to the Security section
3. Click **"Open Anyway"** next to the SANIX warning

**Method 3 (Terminal):**
```bash
xattr -cr /Applications/SANIX.app
open /Applications/SANIX.app
```

After the first launch, subsequent launches will work normally.

### Windows: "Windows protected your PC" (SmartScreen)

This is expected — SANIX is not code-signed. To bypass:

1. Click **"More info"**
2. Click **"Run anyway"**

### "sanix: command not found" after install

```bash
# Restart your terminal, or:
source ~/.bashrc    # Bash
source ~/.zshrc     # Zsh

# Or check if it's linked:
which sanix
# If not found, re-link:
cd ~/.sanix/src && npm link
```

### "Cannot find module" errors

```bash
cd ~/.sanix/src
npm install
npm run build
```

### Server not starting

```bash
# Check if port 7331 is in use
lsof -i :7331

# Start the server manually
sanix serve
```

### Tests failing

```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage
```

---

## 🧪 Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

---

## 📄 License

MIT License

Copyright © 2026 **Istiak Ahamed**. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

<div align="center">

**Created by Istiak Ahamed** · All rights reserved © 2026

**[⭐ Star on GitHub](https://github.com/istiak-ahamed/sanix)** · **[📦 Download Desktop App](https://github.com/istiak-ahamed/sanix/releases)** · **[🐛 Report Issues](https://github.com/istiak-ahamed/sanix/issues)**

</div>

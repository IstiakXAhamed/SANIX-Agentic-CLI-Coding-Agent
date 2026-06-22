# SANIX — 5-Minute Quickstart

Get up and running with SANIX in under 5 minutes.

---

## Step 1: Install (30 seconds)

```bash
# Option A: One-line install
curl -fsSL https://sanix.dev/install.sh | bash

# Option B: npm
npm install -g sanix

# Option C: Build from source
git clone https://github.com/istiak-ahamed/sanix.git
cd sanix && npm install && npm run build && npm link
```

Verify:
```bash
sanix --version    # → 1.0.0
```

---

## Step 2: Set API Key (10 seconds)

Pick ONE provider:

```bash
# Claude (Anthropic)
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# OR GPT-4o (OpenAI)
export OPENAI_API_KEY=sk-your-key-here

# OR use OAuth (browser-based)
sanix auth login google
```

---

## Step 3: Run Onboarding (30 seconds)

```bash
sanix config init
```

This launches an interactive wizard that sets up your provider, memory, sandbox, and theme.

---

## Step 4: Ask a Question (10 seconds)

```bash
sanix ask "What can you do?"
```

Output:
```
I'm SANIX, an agentic AI assistant. I can:
- Write and review code
- Run shell commands
- Search the web
- Manage memory across sessions
- Spawn sub-agents for parallel work
...
```

---

## Step 5: Run an Agent (2 minutes)

```bash
sanix run "Create a hello world function in TypeScript with tests"
```

SANIX will:
1. Decompose the goal into a plan
2. Write the code (`hello.ts`)
3. Write tests (`hello.test.ts`)
4. Run the tests
5. Report results

---

## Step 6: Try Specialized Agents (1 minute)

```bash
# List all 22 agents
sanix agent list

# Run the security scanner
sanix agent run security-sentinel "Scan this directory for vulnerabilities"

# Run the test architect
sanix agent run test-architect "Generate tests for src/index.ts"

# Run UltraWorker (spawns other agents automatically!)
sanix agent run ultra-worker "Audit this codebase"
```

---

## Step 7: Interactive Chat (1 minute)

```bash
sanix chat
```

```
> Hello!
SANIX: Hi! How can I help you today?

> /help          # Show slash commands
> /sessions      # List saved sessions
> /session new   # Create a new session
> /fork          # Fork the current conversation
> /cost          # Show cost summary
> /exit          # Save and exit
```

---

## Step 8: Session Management (30 seconds)

```bash
# List all sessions
sanix session list

# Create a new session
sanix session new "Auth refactor"

# Switch to a session
sanix session switch <id>

# Fork a session from a specific point
sanix session fork <id> "Alternative approach"

# Search across all sessions
sanix session search "authentication"

# Export a session as Markdown
sanix session export <id> --format markdown
```

---

## Step 9: Useful Commands (30 seconds)

```bash
# Check system health
sanix doctor

# Explain a file
sanix explain src/auth.ts

# Auto-fix lint/type/test issues
sanix fix

# Generate a smart commit message
sanix commit

# Scaffold a new project
sanix init "REST API with Express, PostgreSQL, JWT auth, tests, Docker"

# Optimize a prompt (60%+ token reduction)
echo "Please note that in order to..." | sanix optimize -
```

---

## You're Done! 🎉

You now know enough to be productive with SANIX. Here's what to explore next:

| Want to... | Command |
|---|---|
| Run a multi-agent team | `sanix team solve code-review-team "Review my code"` |
| Ingest docs for RAG | `sanix rag ingest ./docs --recursive` |
| Build a knowledge graph | `sanix kg ingest ./src` |
| Run code in a sandbox | `sanix sandbox run "console.log('hello')"` |
| Evolve your prompts | `sanix evolve run "You are a helpful assistant"` |
| Start the web dashboard | `cd packages/dashboard && npm run dev` |
| Start the desktop app | `cd packages/desktop && npm run dev` |

---

**Need help?** Run `sanix doctor` to diagnose issues, or `sanix --help` to see all commands.

**Created by Istiak Ahamed** · MIT License · All rights reserved © 2026

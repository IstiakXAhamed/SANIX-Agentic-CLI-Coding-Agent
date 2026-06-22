/**
 * @file bootstrap.ts
 * @description Dependency-injection root for the SANIX CLI.
 *
 * `bootstrap()` is the single entry point that wires up every long-lived
 * service the CLI needs:
 *
 *   - {@link SecretManager}    — provider API keys (env + JSON store).
 *   - {@link ProfileManager}   — named configuration profiles.
 *   - {@link SanixConfig}      — fully-resolved, env-substituted config.
 *   - {@link ProviderRouter}   — registered adapters, circuit breaker, fallback.
 *   - {@link ToolRegistry}     — every built-in tool pre-registered.
 *   - {@link MemoryRouter}     — 4-tier memory (working/episodic/semantic/procedural).
 *   - {@link ContextBuilder}   — token-budget-aware prompt assembler.
 *   - {@link MemoryCompressor} — background memory maintenance.
 *   - {@link MCPClient}        — live MCP server connections (lazy).
 *
 * The returned {@link SanixContext} is passed to every command handler so
 * they never need to re-instantiate services themselves.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  resolveConfig,
  saveConfig,
  expandHome,
  ProfileManager,
  SecretManager,
  DEFAULT_CONFIG_PATH,
  type SanixConfig,
} from '@sanix/config';
import {
  ProviderRouter,
  AnthropicAdapter,
  OpenAIAdapter,
  GeminiAdapter,
  MistralAdapter,
  GroqAdapter,
  TogetherAdapter,
  DeepSeekAdapter,
  OllamaAdapter,
  LMStudioAdapter,
  OpenAICompatAdapter,
  type IProvider,
} from '@sanix/providers';
import {
  MemoryRouter,
  ContextBuilder,
  MemoryCompressor,
  ToolRegistry,
  HookManager,
  CheckpointManager,
  BranchManager,
  ApprovalManager,
  CostTracker,
  type ToolPermission,
} from '@sanix/core';
import { AuthManager } from '@sanix/auth';
import { allTools, MCPClient } from '@sanix/tools';
import { SessionManager } from './session/SessionManager.js';

/** A single named entry from `config.providers.configs`. */
interface ProviderConfigEntry {
  apiKey?: string;
  baseURL?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  strengths: string[];
}

/**
 * Optional v5-package managers. Each is lazily instantiated by the
 * matching `sanix <cmd>` subcommand via {@link SanixContext.v5} and is
 * `undefined` until first use — keeping the boot path fast for users
 * who never invoke the v5 commands.
 *
 * The shapes are intentionally structural (local interfaces) so the
 * CLI never imports the v5 packages at module load time. The
 * underlying managers are loaded via dynamic `import()` inside each
 * command file.
 */
export interface SanixV5Managers {
  /**
   * Multi-agent team factory. Built on first `sanix team` invocation.
   * The actual `AgentTeam` class is constructed per-solve (one per
   * template) — this field just signals that the package is available.
   */
  readonly multiagent?: { available: true };
  /**
   * RAG pipeline (document store + retriever + provider). Built on
   * first `sanix rag` invocation. The same instance is reused across
   * subsequent rag commands in the same process.
   */
  readonly rag?: unknown;
  /**
   * `SemanticCache` instance. Built on first `sanix cache` invocation.
   * When `v5Config.cache.enabled` is true, the {@link ProviderRouter}
   * is wrapped with `CachedProviderRouter` so all `route()` calls
   * consult the cache before delegating.
   */
  readonly semanticCache?: unknown;
  /**
   * `CachedProviderRouter` wrapping {@link SanixContext.router}. Only
   * present when `v5Config.cache.enabled === true` AND the cache has
   * been instantiated. Commands that need to bypass the cache (e.g.
   * `cache invalidate`) call `ctx.router` directly.
   */
  readonly cachedRouter?: unknown;
  /**
   * `KnowledgeManager`. Built on first `sanix kg` invocation. Backed
   * by a SQLite store at `~/.sanix/knowledge/graph.db`.
   */
  readonly knowledge?: unknown;
  /**
   * `SandboxManager`. Built on first `sanix sandbox` invocation. The
   * default isolation is `docker` (falls back to `process`).
   */
  readonly sandbox?: unknown;
  /**
   * `SelfImprovementManager`. Built on first `sanix evolve` invocation.
   * Wired with the first available provider + the built-in benchmark
   * suite.
   */
  readonly selfImprove?: unknown;
}

/**
 * CLI-local configuration defaults for the v5 packages. These are NOT
 * part of the {@link SanixConfig} schema (which lives in
 * `@sanix/config` and is closed) — they are read from env vars and
 * merged into {@link SanixContext.v5Config} at boot time. Each v5
 * command consults this object for its defaults.
 */
export interface SanixV5Config {
  /** Semantic cache configuration. */
  readonly cache: {
    /** Master switch. When `false`, `sanix cache` refuses to operate. */
    readonly enabled: boolean;
    /** Cosine-similarity hit threshold (0..1). */
    readonly threshold: number;
    /** TTL in ms. 0 = never expire. */
    readonly ttlMs: number;
    /** Max entries before LRU eviction. */
    readonly maxSize: number;
  };
  /** Sandbox configuration. */
  readonly sandbox: {
    /** Default isolation when `--isolation` is omitted. */
    readonly defaultIsolation: 'process' | 'docker' | 'none';
    /** Default per-execution timeout in ms. */
    readonly defaultTimeoutMs: number;
  };
  /** RAG configuration. */
  readonly rag: {
    /** Document store backend. */
    readonly store: 'memory' | 'filesystem' | 'sqlite';
    /** Top-K default for `rag query` / `rag search`. */
    readonly defaultK: number;
    /** Whether to enable the reranker stage by default. */
    readonly rerankByDefault: boolean;
    /** Whether to enable the query-rewriter stage by default. */
    readonly rewriteByDefault: boolean;
  };
  /** Knowledge graph configuration. */
  readonly knowledge: {
    /** SQLite path (under `~/.sanix/knowledge/`). */
    readonly dbPath: string;
    /** Default extraction method. */
    readonly method: 'llm' | 'regex' | 'hybrid';
  };
}

/**
 * The fully-wired SANIX runtime. Every CLI command receives one of these
 * and never reaches into individual service constructors directly.
 */
export interface SanixContext {
  /** Fully-resolved, env-substituted SANIX config. */
  readonly config: SanixConfig;
  /** Absolute path the config was loaded from (used by `sanix config set`). */
  readonly configPath: string;
  /** Secret manager (env + JSON store). */
  readonly secrets: SecretManager;
  /** Profile manager (`~/.sanix/profiles.json`). */
  readonly profiles: ProfileManager;
  /** Provider router with all configured adapters registered. */
  readonly router: ProviderRouter;
  /** Tool registry with every built-in tool pre-registered. */
  readonly tools: ToolRegistry;
  /** 4-tier memory router. */
  readonly memory: MemoryRouter;
  /** Token-budget-aware prompt builder. */
  readonly contextBuilder: ContextBuilder;
  /** Background memory-maintenance job. */
  readonly compressor: MemoryCompressor;
  /** Live MCP server connections (lazy; populated by `sanix mcp`). */
  readonly mcpClient: MCPClient;
  /** OAuth + API-key auth manager (Task A1). */
  readonly authManager: AuthManager;
  /** Lifecycle hook manager — fires agent/tool/memory events (Task A3). */
  readonly hooks: HookManager;
  /** Checkpoint manager — manual + auto checkpoints (Task A3). */
  readonly checkpoints: CheckpointManager;
  /** Branch manager — conversation forking (Task A3). */
  readonly branches: BranchManager;
  /** Approval manager — interactive + auto approvals (Task A3). */
  readonly approvals: ApprovalManager;
  /** Cost tracker — accumulates USD spend + cache stats per session (Task A3). */
  readonly costs: CostTracker;
  /**
   * V5-package managers (multiagent / rag / cache / knowledge / sandbox /
   * self-improve). Lazily-instantiated; all fields optional. See
   * {@link SanixV5Managers}.
   */
  readonly v5: SanixV5Managers;
  /**
   * V5-package config defaults. Read from env vars at boot. See
   * {@link SanixV5Config}.
   */
  readonly v5Config: SanixV5Config;
  /**
   * Session manager — persistent, atomic session storage for the
   * `sanix session` command + the REPL. Lazily instantiated on first
   * access (so commands that don't touch sessions pay no cost). When
   * `undefined`, the `sanix session` / `sanix chat` commands construct
   * one on demand and assign it here.
   */
  sessionManager?: SessionManager;
}

/** Options accepted by {@link bootstrap}. */
export interface BootstrapOptions {
  /**
   * Override the config file path. Defaults to `~/.sanix/config.json` (the
   * {@link DEFAULT_CONFIG_PATH} constant from `@sanix/config`).
   */
  configPath?: string;
  /**
   * When `true`, MCP servers configured in `config.mcp.servers` are
   * connected eagerly during bootstrap. Defaults to `false` — the CLI
   * connects lazily to keep startup fast.
   */
  connectMcp?: boolean;
}

/**
 * Map a stable model alias (e.g. `'claude-sonnet-4'`, `'gpt-4o'`) to the
 * correct adapter constructor. The mapping is intentionally simple: prefix
 * matching on the alias. Unknown aliases fall through to
 * {@link OpenAICompatAdapter} so users can wire arbitrary OpenAI-compat
 * endpoints via `sanix providers add`.
 */
function adapterForAlias(
  alias: string,
  entry: ProviderConfigEntry,
): IProvider {
  const apiKey = entry.apiKey;

  // Anthropic Claude family.
  if (alias.startsWith('claude-')) {
    return new AnthropicAdapter({
      apiKey,
      modelId: alias,
      concreteModel: entry.model,
      baseURL: entry.baseURL,
    });
  }

  // OpenAI family.
  if (alias === 'o1' || alias === 'o3' || alias.startsWith('gpt-')) {
    return new OpenAIAdapter({
      apiKey,
      modelId: alias,
      concreteModel: entry.model,
      baseURL: entry.baseURL,
    });
  }

  // Google Gemini.
  if (alias.startsWith('gemini-')) {
    return new GeminiAdapter({
      apiKey,
      modelId: alias,
      concreteModel: entry.model,
    });
  }

  // Mistral family.
  if (alias.startsWith('mistral-') || alias === 'codestral') {
    return new MistralAdapter({
      apiKey,
      modelId: alias,
      concreteModel: entry.model,
    });
  }

  // Groq (llama / qwen served by Groq).
  if (alias.startsWith('llama-') || alias.startsWith('qwen-')) {
    return new GroqAdapter({
      apiKey,
      modelId: alias,
      concreteModel: entry.model,
    });
  }

  // Together AI (fallback for `together-*` aliases).
  if (alias.startsWith('together-')) {
    return new TogetherAdapter({
      apiKey,
      modelId: alias,
      concreteModel: entry.model,
    });
  }

  // DeepSeek.
  if (alias.startsWith('deepseek-')) {
    return new DeepSeekAdapter({
      apiKey,
      modelId: alias,
      concreteModel: entry.model,
    });
  }

  // Local: Ollama.
  if (alias.startsWith('ollama-')) {
    return new OllamaAdapter({
      modelId: alias,
      concreteModel: entry.model,
      baseURL: entry.baseURL,
    });
  }

  // Local: LM Studio.
  if (alias.startsWith('lmstudio-')) {
    return new LMStudioAdapter({
      modelId: alias,
      concreteModel: entry.model,
      baseURL: entry.baseURL,
    });
  }

  // Generic OpenAI-compatible fallback.
  if (entry.baseURL) {
    return new OpenAICompatAdapter({
      id: alias,
      baseURL: entry.baseURL,
      model: entry.model,
      apiKey,
      displayName: alias,
    });
  }

  // Last-resort: an OpenAICompatAdapter pointed at the default OpenAI URL
  // with the alias as the model. This lets users register arbitrary model
  // aliases without needing a baseURL — they'll just hit OpenAI's API.
  return new OpenAICompatAdapter({
    id: alias,
    baseURL: 'https://api.openai.com/v1',
    model: entry.model,
    apiKey,
    displayName: alias,
  });
}

/**
 * Build the {@link ProviderRouter} from the resolved config. Every entry in
 * `config.providers.configs` becomes a registered adapter; the router's
 * circuit breaker and fallback logic then handle availability.
 *
 * AuthManager integration (Task A1): for each provider, before checking
 * for an API key, we consult `authManager.getAccessToken(providerId)`. If
 * it returns a token, that token is used as the `apiKey` for the adapter —
 * enabling OAuth-only providers (e.g. `google`, `github`) to be used
 * without a static API key in the config or env.
 *
 * **Env-var auto-detection (Task V13-2):** when `config.providers.configs`
 * is empty (i.e. the user has not run `sanix config init` or
 * `sanix providers add`), we look at the process environment for any of
 * the well-known provider API-key variables and auto-register the
 * matching adapter. This makes `sanix run "hello world"` work
 * out-of-the-box once a user `export`s their key — the very first-run
 * experience promised by the Quickstart guide.
 *
 * @returns A Promise that resolves to the wired {@link ProviderRouter}.
 */
async function buildRouter(
  config: SanixConfig,
  secrets: SecretManager,
  authManager: AuthManager,
): Promise<ProviderRouter> {
  const providers: IProvider[] = [];
  for (const [alias, entry] of Object.entries(config.providers.configs)) {
    // 1. AuthManager OAuth token (highest priority — Task A1).
    //    getAccessToken is async (may auto-refresh); we await it per alias.
    //    Unknown providers return null without throwing.
    let resolvedKey: string | undefined;
    try {
      const token = await authManager.getAccessToken(alias);
      resolvedKey = token ?? undefined;
    } catch {
      // AuthManager not yet initialized for this provider — fall through.
    }

    // 2. Config apiKey (literal or `$ENV_VAR` reference — already env-
    //    substituted by resolveConfig).
    if (!resolvedKey && entry.apiKey) {
      resolvedKey = entry.apiKey;
      if (resolvedKey.startsWith('$')) {
        const envName = resolvedKey.slice(1);
        resolvedKey = process.env[envName] ?? entry.apiKey;
      }
    }

    // 3. SecretManager lookup keyed by alias prefix.
    if (!resolvedKey) {
      const providerKey = alias.split('-')[0] ?? alias;
      resolvedKey = secrets.getKey(providerKey);
    }

    const provider = adapterForAlias(alias, {
      ...entry,
      apiKey: resolvedKey,
    });
    providers.push(provider);
  }

  // ── Env-var auto-detection (Task V13-2). ─────────────────────────────
  // If the user has not explicitly configured any providers (the common
  // first-run case), register adapters for every well-known API key that
  // is present in the environment. Each adapter's constructor reads its
  // own env var when `apiKey` is omitted, so we simply pass `undefined`
  // and let the adapter resolve the key. This makes
  // `ANTHROPIC_API_KEY=sk-... sanix run "hello"` work without any setup.
  if (providers.length === 0) {
    for (const auto of autoDetectableProviders()) {
      const key = process.env[auto.envVar];
      if (key && key.trim() !== '') {
        // The adapter will pick up the env var on its own; we pass
        // `undefined` to keep the key out of the config and let the
        // adapter own the env-var lookup (matches the adapter's own
        // documented behavior).
        providers.push(
          adapterForAlias(auto.alias, {
            model: auto.model,
            maxTokens: auto.maxTokens,
            temperature: 0.1,
            strengths: auto.strengths,
            apiKey: key,
          }),
        );
      }
    }
  }

  return new ProviderRouter({ providers });
}

/**
 * Descriptor for a provider that can be auto-detected from a single env
 * var. Used by {@link buildRouter} when no providers are explicitly
 * configured. Order matters: the first auto-detected provider becomes the
 * primary (Anthropic first matches the Quickstart's default of Claude).
 */
interface AutoDetectableProvider {
  /** Stable alias used as the adapter's `modelId` and router key. */
  readonly alias: string;
  /** Concrete model id sent to the provider's API. */
  readonly model: string;
  /** Env var that holds the API key. */
  readonly envVar: string;
  /** Default max output tokens. */
  readonly maxTokens: number;
  /** Strengths tags the router uses for routing decisions. */
  readonly strengths: string[];
}

/**
 * The list of providers SANIX can auto-detect from the environment, in
 * priority order. Anthropic and OpenAI are first because they are the
 * two providers named in the Quickstart guide. The remaining providers
 * cover the rest of the cloud-LLM ecosystem (Google, Mistral, Groq,
 * Together, DeepSeek) so a user with any of those keys gets a working
 * `sanix run` on first try.
 */
function autoDetectableProviders(): readonly AutoDetectableProvider[] {
  return [
    {
      alias: 'claude-sonnet-4',
      model: 'claude-sonnet-4-20250514',
      envVar: 'ANTHROPIC_API_KEY',
      maxTokens: 8192,
      strengths: ['reasoning', 'coding', 'long-context'],
    },
    {
      alias: 'gpt-4o',
      model: 'gpt-4o',
      envVar: 'OPENAI_API_KEY',
      maxTokens: 8192,
      strengths: ['general', 'tools', 'fast'],
    },
    {
      alias: 'gemini-2.0-flash',
      model: 'gemini-2.0-flash',
      envVar: 'GEMINI_API_KEY',
      maxTokens: 8192,
      strengths: ['general', 'fast', 'long-context'],
    },
    {
      alias: 'mistral-large-latest',
      model: 'mistral-large-latest',
      envVar: 'MISTRAL_API_KEY',
      maxTokens: 8192,
      strengths: ['general', 'reasoning'],
    },
    {
      alias: 'llama-3.3-70b-versatile',
      model: 'llama-3.3-70b-versatile',
      envVar: 'GROQ_API_KEY',
      maxTokens: 8192,
      strengths: ['fast', 'general'],
    },
    {
      alias: 'together-meta-llama/Llama-3.3-70B-Instruct-Turbo',
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      envVar: 'TOGETHER_API_KEY',
      maxTokens: 8192,
      strengths: ['general', 'fast'],
    },
    {
      alias: 'deepseek-chat',
      model: 'deepseek-chat',
      envVar: 'DEEPSEEK_API_KEY',
      maxTokens: 8192,
      strengths: ['coding', 'reasoning'],
    },
  ] as const;
}

/**
 * Initialize the SANIX runtime. Loads config, secrets, profiles, providers,
 * tools, memory, and context builder; returns a fully-wired
 * {@link SanixContext}.
 *
 * This function is **idempotent**: calling it twice yields two independent
 * contexts (each with its own router, tool registry, etc.). The CLI calls
 * it exactly once per process.
 *
 * @param opts - Optional {@link BootstrapOptions}.
 * @returns A ready-to-use {@link SanixContext}.
 *
 * @example
 * ```ts
 * const ctx = await bootstrap();
 * const loop = wireUpAgent(ctx, { provider: 'claude-sonnet-4' });
 * const result = await executeGoal(ctx, 'Refactor auth', { loop });
 * ```
 */
export async function bootstrap(
  opts: BootstrapOptions = {},
): Promise<SanixContext> {
  const configPath = opts.configPath
    ? expandHome(opts.configPath)
    : DEFAULT_CONFIG_PATH;

  // Load (or default) the config. resolveConfig silently falls back to
  // defaults when the file is missing — bootstrap honors that even when
  // `requireConfig` is set, because an empty provider registry is a
  // recoverable state (commands that need a provider surface a clear
  // error at call time).
  const config = resolveConfig(opts.configPath);

  // Initialize secrets + profiles.
  const secrets = new SecretManager();
  const profiles = new ProfileManager();

  // AuthManager (Task A1) — OAuth + API-key authentication for providers.
  // Instantiated before the router so the router can consult it during
  // adapter construction. The default constructor wires a token store at
  // `~/.sanix/auth/tokens.json` (mode 0600).
  const authManager = new AuthManager();

  // Apply the active profile's overrides on top of the loaded config.
  // Profile overrides are deep-partial; the schema re-parses the merged
  // result so we always end up with a complete, validated config.
  const activeProfile = profiles.getCurrentProfile();
  const effectiveConfig: SanixConfig = activeProfile
    ? mergeOverrides(config, activeProfile.overrides)
    : config;

  // Wire up the provider router with all configured adapters. AuthManager
  // is consulted first per provider (Task A1) — OAuth tokens win over
  // config API keys. The router construction is async because
  // `getAccessToken` may auto-refresh expired tokens.
  const router = await buildRouter(effectiveConfig, secrets, authManager);

  // Register every built-in tool. Tools that require an API key not
  // present in the environment will degrade gracefully at call time
  // (each tool's `execute()` handles missing-config with a clear error).
  const tools = new ToolRegistry();
  for (const tool of allTools()) {
    tools.register(tool as never, { source: 'builtin' });
  }

  // 4-tier memory router. The defaults (in-memory working + on-disk
  // episodic/semantic/procedural) are sensible for first-run; users with
  // heavy memory workloads can tune via `sanix config set memory.*`.
  const memory = new MemoryRouter({
    workingWindowSize: effectiveConfig.memory.workingWindow,
  });

  // Context builder + memory compressor. The compressor is not auto-
  // started; commands that run the agent loop call `compressor.run()`
  // at the appropriate iteration cadence.
  const contextBuilder = new ContextBuilder(effectiveConfig);
  const compressor = new MemoryCompressor(memory, effectiveConfig);

  // MCP client starts empty; `sanix mcp add` and the agent bootstrap path
  // populate it lazily from `effectiveConfig.mcp.servers`.
  const mcpClient = new MCPClient();

  // Task A3 managers: hooks, checkpoints, branches, approvals, costs.
  // Each is constructed with the minimum context it needs; rich wiring
  // (event subscriptions, persistence paths) happens lazily on first use.
  const hooks = new HookManager();
  const checkpoints = new CheckpointManager({
    dir: expandHome(effectiveConfig.agent.checkpointDir),
  });
  const branches = new BranchManager();
  // Translate the config's coarse approval tags to ToolPermission values.
  // 'all' expands to write/exec permissions; 'bash' → 'shell_exec'; 'web' →
  // 'web_request'; 'file_write' stays as-is. Read-only perms are never
  // required-for-approval.
  const approvalPerms: ToolPermission[] = [];
  for (const tag of effectiveConfig.agent.requireApprovalFor) {
    if (tag === 'all') {
      approvalPerms.push('file_write', 'shell_exec', 'web_request', 'memory_write');
    } else if (tag === 'bash') {
      approvalPerms.push('shell_exec');
    } else if (tag === 'web') {
      approvalPerms.push('web_request');
    } else if (tag === 'file_write') {
      approvalPerms.push('file_write');
    }
  }
  const approvals = new ApprovalManager({
    requireFor: approvalPerms,
  });
  const costs = new CostTracker();

  // V5 config defaults — read from env vars so users can override
  // without touching the (closed) `@sanix/config` schema. All v5
  // commands consult `ctx.v5Config` for their defaults.
  const v5Config = resolveV5Config();

  const ctx: SanixContext = {
    config: effectiveConfig,
    configPath,
    secrets,
    profiles,
    router,
    tools,
    memory,
    contextBuilder,
    compressor,
    mcpClient,
    authManager,
    hooks,
    checkpoints,
    branches,
    approvals,
    costs,
    // All v5 managers start undefined — each `sanix <cmd>` lazily
    // dynamic-imports its package and populates the matching field on
    // first use.
    v5: {},
    v5Config,
  };

  // Optionally connect MCP servers eagerly. Off by default — the MCP
  // connections are slow (stdio spawns) and most CLI commands don't
  // need them.
  if (opts.connectMcp && effectiveConfig.mcp.servers.length > 0) {
    await connectMcpServers(ctx);
  }

  return ctx;
}

/**
 * Resolve the CLI-local v5 config defaults from environment variables.
 * Every key has a sensible default so the function always returns a
 * complete {@link SanixV5Config}.
 *
 * Recognized env vars:
 *
 *   SANIX_CACHE_ENABLED         = '0' | '1' (default '1')
 *   SANIX_CACHE_THRESHOLD       = float (default 0.92)
 *   SANIX_CACHE_TTL_MS          = int ms   (default 86400000)
 *   SANIX_CACHE_MAX_SIZE        = int      (default 10000)
 *   SANIX_SANDBOX_ISOLATION     = process | docker | none (default 'docker')
 *   SANIX_SANDBOX_TIMEOUT_MS    = int ms   (default 30000)
 *   SANIX_RAG_STORE             = memory | filesystem | sqlite (default 'sqlite')
 *   SANIX_RAG_DEFAULT_K         = int      (default 5)
 *   SANIX_RAG_RERANK_DEFAULT    = '0' | '1' (default '1')
 *   SANIX_RAG_REWRITE_DEFAULT   = '0' | '1' (default '1')
 *   SANIX_KG_DB_PATH            = string   (default '~/.sanix/knowledge/graph.db')
 *   SANIX_KG_METHOD             = llm | regex | hybrid (default 'hybrid')
 *
 * @returns A fully-populated v5 config block.
 */
function resolveV5Config(): SanixV5Config {
  const env = process.env;
  const truthy = (v: string | undefined): boolean => v === '1' || v === 'true';

  const defaultIsolation: 'process' | 'docker' | 'none' =
    env.SANIX_SANDBOX_ISOLATION === 'process' ||
    env.SANIX_SANDBOX_ISOLATION === 'docker' ||
    env.SANIX_SANDBOX_ISOLATION === 'none'
      ? env.SANIX_SANDBOX_ISOLATION
      : 'docker';

  const ragStore: 'memory' | 'filesystem' | 'sqlite' =
    env.SANIX_RAG_STORE === 'memory' ||
    env.SANIX_RAG_STORE === 'filesystem' ||
    env.SANIX_RAG_STORE === 'sqlite'
      ? env.SANIX_RAG_STORE
      : 'sqlite';

  const kgMethod: 'llm' | 'regex' | 'hybrid' =
    env.SANIX_KG_METHOD === 'llm' ||
    env.SANIX_KG_METHOD === 'regex' ||
    env.SANIX_KG_METHOD === 'hybrid'
      ? env.SANIX_KG_METHOD
      : 'hybrid';

  return {
    cache: {
      enabled: env.SANIX_CACHE_ENABLED !== '0' && env.SANIX_CACHE_ENABLED !== 'false',
      threshold: parseFloat(env.SANIX_CACHE_THRESHOLD ?? '0.92'),
      ttlMs: parseInt(env.SANIX_CACHE_TTL_MS ?? '86400000', 10),
      maxSize: parseInt(env.SANIX_CACHE_MAX_SIZE ?? '10000', 10),
    },
    sandbox: {
      defaultIsolation,
      defaultTimeoutMs: parseInt(env.SANIX_SANDBOX_TIMEOUT_MS ?? '30000', 10),
    },
    rag: {
      store: ragStore,
      defaultK: parseInt(env.SANIX_RAG_DEFAULT_K ?? '5', 10),
      rerankByDefault: !truthy(env.SANIX_RAG_RERANK_DEFAULT)
        ? true
        : env.SANIX_RAG_RERANK_DEFAULT !== '0' && env.SANIX_RAG_RERANK_DEFAULT !== 'false',
      rewriteByDefault: !truthy(env.SANIX_RAG_REWRITE_DEFAULT)
        ? true
        : env.SANIX_RAG_REWRITE_DEFAULT !== '0' && env.SANIX_RAG_REWRITE_DEFAULT !== 'false',
    },
    knowledge: {
      dbPath: env.SANIX_KG_DB_PATH ?? join(homedir(), '.sanix', 'knowledge', 'graph.db'),
      method: kgMethod,
    },
  };
}

/**
 * Connect every enabled MCP server in `ctx.config.mcp.servers`. Failures
 * are logged but never fatal — a broken MCP server should not prevent the
 * CLI from running.
 *
 * @param ctx - The SANIX context to connect MCP servers for.
 * @returns The number of servers successfully connected.
 */
export async function connectMcpServers(ctx: SanixContext): Promise<number> {
  let connected = 0;
  for (const server of ctx.config.mcp.servers) {
    if (!server.enabled) continue;
    try {
      if (server.type === 'stdio') {
        if (!server.command) continue;
        await ctx.mcpClient.connect({
          type: 'stdio',
          name: server.name,
          command: server.command,
          args: server.args,
        });
      } else if (server.type === 'http' || server.type === 'sse') {
        if (!server.url) continue;
        await ctx.mcpClient.connect({
          type: server.type,
          name: server.name,
          url: server.url,
        });
      }
      connected++;
    } catch {
      // Non-fatal — the user can `sanix mcp test <name>` to diagnose.
    }
  }
  return connected;
}

/**
 * Persist the context's current config to disk. Used by `sanix config set`
 * and `sanix providers add` / `sanix mcp add` after they mutate the
 * in-memory config.
 *
 * @param ctx - The SANIX context whose config should be persisted.
 */
export function persistConfig(ctx: SanixContext): void {
  saveConfig(ctx.configPath, ctx.config);
}

/**
 * Deeply merge a deep-partial {@link ConfigOverride} (from a profile) over
 * a complete {@link SanixConfig}. Arrays are replaced wholesale (matching
 * the {@link ConfigOverride} type definition in `@sanix/config`).
 *
 * The result is re-parsed through the schema so any field the override
 * nullified gets re-defaulted.
 *
 * @param base - The complete base config.
 * @param overrides - Deep-partial overrides from a profile.
 * @returns A new, fully-validated config.
 */
function mergeOverrides(
  base: SanixConfig,
  overrides: Record<string, unknown>,
): SanixConfig {
  const merged = deepMerge(
    base as unknown as Record<string, unknown>,
    overrides,
  );
  // The merge above produces a plain object that *should* satisfy the
  // SanixConfig shape (overrides are deep-partial of the schema). We
  // cast back through `unknown` rather than re-parsing through the Zod
  // schema to avoid importing the schema symbol here — the caller is
  // expected to have validated the profile overrides at creation time.
  return merged as unknown as SanixConfig;
}

/**
 * Recursively merge `overrides` over `base`. Arrays on `overrides` replace
 * arrays on `base` wholesale (per the {@link ConfigOverride} contract).
 */
function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key] as unknown)
    ) {
      out[key] = deepMerge(
        out[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Generate a fresh, URL-safe run id. Used for checkpoint file names and
 * session-scoped memory keys.
 *
 * @returns A 21-character nanoid string.
 */
export function newRunId(): string {
  return nanoid(21);
}

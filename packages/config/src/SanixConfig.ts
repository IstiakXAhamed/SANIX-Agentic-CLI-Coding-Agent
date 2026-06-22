/**
 * SANIX Configuration Schema & Resolution
 * ---------------------------------------
 * Zod-validated configuration system for SANIX (Sanim's Agentic Neural
 * Intelligence eXecutor). Every config that flows through SANIX is parsed
 * against {@link SanixConfigSchema}, guaranteeing a consistent, typed shape.
 *
 * The schema mirrors the design spec at:
 *   `## 🔐 Configuration Schema (`sanix.config.ts`)`
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The canonical SANIX configuration schema.
 *
 * Every field carries a default so that `SanixConfigSchema.parse({})` returns
 * a fully-formed, usable configuration. Nested object defaults cascade:
 * passing a partial `providers` object still fills in `routing`, `configs`,
 * etc. via the inner field defaults.
 *
 * @example
 * ```ts
 * const cfg = SanixConfigSchema.parse({
 *   providers: { default: 'claude-opus-4' },
 * });
 * cfg.providers.routing; // 'auto' (default applied)
 * cfg.memory.vectorDb;   // 'lancedb' (default applied)
 * ```
 */
export const SanixConfigSchema = z.object({
  version: z.string().default('1.0'),

  providers: z.object({
    default: z.string().default('claude-sonnet-4'),
    routing: z
      .enum(['auto', 'manual', 'cheapest', 'fastest', 'local-first'])
      .default('auto'),
    configs: z
      .record(
        z.object({
          /** API key, or an env-var reference like `"$ANTHROPIC_API_KEY"`. */
          apiKey: z.string().optional(),
          /** Base URL for local / custom endpoints (LM Studio, Ollama, ...). */
          baseURL: z.string().optional(),
          model: z.string(),
          maxTokens: z.number().default(8192),
          temperature: z.number().default(0.1),
          strengths: z.array(z.string()).default([]),
        }),
      )
      .default({}),
  }).default({}),

  memory: z.object({
    /** Number of most-recent messages retained in working memory. */
    workingWindow: z.number().default(40),
    vectorDb: z.enum(['lancedb', 'chromadb']).default('lancedb'),
    vectorDbPath: z.string().default('~/.sanix/memory/vectors'),
    sqlitePath: z.string().default('~/.sanix/memory/episodic.db'),
    embeddingModel: z.string().default('Xenova/all-MiniLM-L6-v2'),
    /** Days before an episodic memory is pruned. */
    maxMemoryAge: z.number().default(90),
    autoSummarize: z.boolean().default(true),
  }).default({}),

  agent: z.object({
    maxIterations: z.number().default(100),
    maxSubAgents: z.number().default(4),
    defaultTokenBudget: z.number().default(100000),
    requireApprovalFor: z
      .array(z.enum(['file_write', 'bash', 'web', 'all']))
      .default([]),
    checkpointDir: z.string().default('~/.sanix/checkpoints'),
    /** Reflect (self-critique) every N agent iterations. */
    reflectEveryN: z.number().default(3),
  }).default({}),

  tools: z.object({
    bash: z.object({
      enabled: z.boolean().default(true),
      timeout: z.number().default(30000),
      /** Optional allowlist. When set, only these commands may run. */
      allowedCommands: z.array(z.string()).optional(),
      blockedCommands: z
        .array(z.string())
        .default(['rm -rf /', 'sudo rm']),
    }).default({}),
    web: z.object({
      enabled: z.boolean().default(true),
      searchProvider: z.enum(['brave', 'tavily', 'serp']).default('brave'),
      apiKey: z.string().optional(),
    }).default({}),
  }).default({}),

  mcp: z.object({
    servers: z
      .array(
        z.object({
          name: z.string(),
          type: z.enum(['stdio', 'http', 'sse']),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          url: z.string().optional(),
          enabled: z.boolean().default(true),
        }),
      )
      .default([]),
  }).default({}),

  tui: z.object({
    theme: z.string().default('sanix'),
    showTokenBudget: z.boolean().default(true),
    showMemoryPanel: z.boolean().default(false),
    diffStyle: z.enum(['inline', 'split', 'hidden']).default('inline'),
    streamOutput: z.boolean().default(true),
  }).default({}),
});

/** The fully-resolved SANIX configuration type. */
export type SanixConfig = z.infer<typeof SanixConfigSchema>;

/**
 * Expand a leading `~` (and `~user`) to the home directory.
 *
 * Paths in the default config use `~` notation for portability; this helper
 * resolves them to absolute filesystem paths before any I/O occurs.
 *
 * @example
 * ```ts
 * expandHome('~/.sanix/config.json'); // '/home/alice/.sanix/config.json'
 * expandHome('/etc/hosts');           // '/etc/hosts' (unchanged)
 * ```
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p.startsWith('~')) {
    // `~user` form — resolve only the simple `~` case to homedir; full
    // user-resolution requires OS support and is intentionally omitted.
    const slash = p.indexOf('/');
    if (slash === -1) return p;
    return join(homedir(), p.slice(slash + 1));
  }
  return p;
}

const ENV_VAR_PATTERN = /^\$([A-Z_][A-Z0-9_]*)$/;

/**
 * Deeply walk a value and resolve any string of the form `"$ENV_VAR"` to the
 * corresponding `process.env[ENV_VAR]` value. Unresolvable references and
 * non-matching strings are left untouched.
 *
 * @example
 * ```ts
 * process.env.ANTHROPIC_API_KEY = 'sk-...';
 * resolveEnvVars({ providers: { configs: { x: { apiKey: '$ANTHROPIC_API_KEY' } } } });
 * // => { providers: { configs: { x: { apiKey: 'sk-...' } } } }
 * ```
 */
export function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = ENV_VAR_PATTERN.exec(value);
    if (match) {
      const envVal = process.env[match[1]];
      return envVal !== undefined ? envVal : value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

/** The default location of the SANIX config file: `~/.sanix/config.json`. */
export const DEFAULT_CONFIG_PATH: string = join(
  homedir(),
  '.sanix',
  'config.json',
);

/**
 * Returns a fully-resolved default SANIX configuration.
 *
 * Equivalent to `SanixConfigSchema.parse({})` — every default is applied so
 * the result is immediately usable.
 *
 * @example
 * ```ts
 * const cfg = defaultConfig();
 * cfg.providers.default; // 'claude-sonnet-4'
 * ```
 */
export function defaultConfig(): SanixConfig {
  return SanixConfigSchema.parse({});
}

/**
 * Load and validate a SANIX config from disk.
 *
 * The file must contain a JSON object. Missing fields are filled with schema
 * defaults; invalid fields throw a `ZodError`.
 *
 * @param path - Absolute or `~`-prefixed path to the config JSON file.
 * @returns The validated, fully-defaulted config. Env-var references are
 *          **not** resolved here — call {@link resolveConfig} for that.
 * @throws {z.ZodError} if the file contents fail validation.
 * @throws {Error} if the file cannot be read or parsed as JSON.
 *
 * @example
 * ```ts
 * const cfg = loadConfig('~/.sanix/config.json');
 * ```
 */
export function loadConfig(path: string): SanixConfig {
  const resolved = expandHome(path);
  const text = readFileSync(resolved, 'utf-8');
  const raw: unknown = JSON.parse(text);
  return SanixConfigSchema.parse(raw);
}

/**
 * Serialize and write a SANIX config to disk, creating parent directories as
 * needed.
 *
 * @param path - Absolute or `~`-prefixed destination path.
 * @param config - A config object conforming to {@link SanixConfigSchema}.
 *
 * @example
 * ```ts
 * saveConfig('~/.sanix/config.json', defaultConfig());
 * ```
 */
export function saveConfig(path: string, config: SanixConfig): void {
  const resolved = expandHome(path);
  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Re-parse through the schema to guarantee the written file is valid.
  const validated = SanixConfigSchema.parse(config);
  writeFileSync(resolved, JSON.stringify(validated, null, 2), 'utf-8');
}

/**
 * Resolve the effective SANIX configuration by merging built-in defaults with
 * the user config file at `~/.sanix/config.json` (or a custom path), then
 * resolving all `$ENV_VAR` references via `process.env`.
 *
 * Resolution order:
 *   1. {@link defaultConfig} provides the baseline.
 *   2. The user config file (if present) is parsed through the schema; Zod
 *      applies defaults to any fields the user omitted.
 *   3. {@link resolveEnvVars} replaces `"$ENV_VAR"` strings.
 *
 * If the user config file is missing or unreadable, the pristine default is
 * returned (with env vars still resolved).
 *
 * @param path - Optional override for the config file location.
 * @returns The fully-resolved, env-substituted SANIX config.
 *
 * @example
 * ```ts
 * const cfg = resolveConfig();
 * cfg.providers.configs['anthropic']?.apiKey; // 'sk-...' (from $ANTHROPIC_API_KEY)
 * ```
 */
export function resolveConfig(path?: string): SanixConfig {
  const configPath = isAbsolute(path ?? '')
    ? path!
    : expandHome(path ?? DEFAULT_CONFIG_PATH);

  let userRaw: unknown = {};
  if (existsSync(configPath)) {
    try {
      const text = readFileSync(configPath, 'utf-8');
      userRaw = JSON.parse(text);
    } catch {
      // Corrupt or unreadable config — fall back to defaults silently so the
      // agent can still boot. The CLI surface may surface a warning.
      userRaw = {};
    }
  }

  const merged = SanixConfigSchema.parse(userRaw);
  return resolveEnvVars(merged) as SanixConfig;
}

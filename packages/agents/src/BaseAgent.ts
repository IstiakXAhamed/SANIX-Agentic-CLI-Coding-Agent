/**
 * @file BaseAgent.ts
 * @description Abstract base class for every specialized SANIX agent.
 *
 * `BaseAgent` provides the shared machinery that every specialized agent
 * (Security Sentinel, Migration Maestro, Test Architect, Perf Profiler,
 * Doc Doctor, ...) needs:
 *
 *   - **Identity** — abstract `id`, `name`, `description`, `category`,
 *     `icon`, `systemPrompt`, `tools`, `provider`, `temperature`,
 *     `exampleQueries` fields (subclasses fill these in).
 *   - **Progress events** — an EventEmitter3 surface plus an
 *     `onProgress` bridge so callers can subscribe either way.
 *   - **Finding/action collection** — `addFinding`, `recordAction`,
 *     `recordMetric` helpers that accumulate structured records into the
 *     final {@link AgentRunResult}.
 *   - **Cost + token tracking** — `trackCost` / `trackTokens` helpers
 *     (no-op when no provider is wired in).
 *   - **Output formatting** — `formatOutput` produces the final
 *     `markdown` / `json` / `text` string per the caller's
 *     {@link AgentRunOptions.outputFormat}.
 *   - **Filesystem helpers** — `walkFiles`, `readFileSafe`,
 *     `isTextFile`, `runShell` — used by every scan-heavy agent.
 *
 * Subclasses implement `run(goal, opts)` and call into the helpers above
 * to do their work. The base takes care of the bookkeeping so subclasses
 * can stay focused on the actual analysis.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import { nanoid } from 'nanoid';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import type {
  AgentAction,
  AgentCategory,
  AgentFinding,
  AgentProgressEvent,
  AgentRunOptions,
  AgentRunResult,
  BaseAgentEvents,
  CostEstimate,
  SpecializedAgent,
} from './types.js';

// ─── Provider surface (optional, lazy) ───────────────────────────────────────
//
// The agents package optionally consumes an `IProvider` so an agent can
// mix deterministic static analysis with LLM-based reasoning. The
// provider is NOT required — every agent degrades gracefully to
// pure static analysis when no provider is wired in. We import the type
// lazily to avoid a hard runtime cycle with `@sanix/providers`.

import type { IProvider, LLMMessage, LLMRequest, LLMResponse } from '@sanix/providers';

/**
 * Default maximum number of iterations an agent will perform before
 * bailing out with `success: false`. Overridable via
 * {@link AgentRunOptions.maxIterations}.
 */
export const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Directories that are skipped by {@link BaseAgent.walkFiles} by default.
 * These are universally non-source directories in modern projects.
 */
export const DEFAULT_IGNORED_DIRS = new Set<string>([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  'target',
  'out',
  'bin',
  'obj',
  '.idea',
  '.vscode',
  'tmp',
  'temp',
]);

/**
 * File extensions treated as text by {@link BaseAgent.isTextFile}.
 * Binary files are skipped during scans to avoid corrupting regex
 * matches with non-text content.
 */
export const TEXT_FILE_EXTENSIONS = new Set<string>([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.json5', '.jsonc',
  '.py', '.pyi', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.kts',
  '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.scala', '.clj',
  '.cljs', '.cljc', '.edn', '.ex', '.exs', '.erl', '.hrl', '.fs', '.fsx',
  '.ml', '.mli', '.lua', '.pl', '.pm', '.r', '.R', '.dart', '.groovy',
  '.gradle', '.tf', '.hcl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.env', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.md', '.mdx', '.rst', '.txt', '.html', '.htm', '.css', '.scss', '.sass',
  '.less', '.vue', '.svelte', '.astro', '.sql', '.graphql', '.gql',
  '.proto', '.thrift', '.dockerfile', '.makefile', '.lock', '.log',
]);

/**
 * Options for {@link BaseAgent.walkFiles}.
 */
export interface WalkOptions {
  /** Extra directory names to skip (merged with {@link DEFAULT_IGNORED_DIRS}). */
  ignoreDirs?: string[];
  /** Only include files whose extension is in this set (empty = all text files). */
  extensions?: string[];
  /** Hard cap on the number of files returned. Default 5000. */
  maxFiles?: number;
  /** Skip files larger than this many bytes. Default 1 MiB. */
  maxFileBytes?: number;
}

/**
 * Constructor options for {@link BaseAgent}.
 */
export interface BaseAgentOptions {
  /**
   * Optional LLM provider. When set, an agent may call
   * {@link BaseAgent.llmChat} for higher-level reasoning (e.g. to draft
   * a migration plan, summarize findings, or generate a doc paragraph).
   * When absent, every agent runs in pure static-analysis mode.
   */
  provider?: IProvider;
}

/**
 * Internal per-run state. Created by {@link BaseAgent.startRun}, mutated
 * by the helpers (`addFinding`, `recordAction`, ...), and consumed by
 * {@link BaseAgent.finishRun} to produce the final
 * {@link AgentRunResult}. Subclasses get a handle to a `RunContext` by
 * calling `this.startRun(goal, opts)` at the top of their `run()`.
 */
export interface RunContext {
  /** The originating goal. */
  goal: string;
  /** Resolved run options. */
  opts: Required<
    Pick<AgentRunOptions, 'cwd' | 'provider' | 'maxIterations' | 'dryRun' | 'outputFormat'>
  > &
    Pick<AgentRunOptions, 'onProgress'>;
  /** Wall-clock start of the run (ms epoch). */
  startedAt: number;
  /** Monotonic iteration counter (incremented per file/step). */
  iteration: number;
  /** Accumulated findings. */
  findings: AgentFinding[];
  /** Accumulated actions. */
  actions: AgentAction[];
  /** Agent-specific metrics. */
  metrics: Record<string, number>;
  /** Accumulated USD cost. */
  costUsd: number;
  /** Accumulated token usage. */
  tokensUsed: number;
  /** Run status (set to false on failure). */
  success: boolean;
  /** Raw output buffer (used when subclass writes directly). */
  output: string;
}

/**
 * Abstract base class for every specialized SANIX agent.
 *
 * Subclasses MUST implement:
 *   - the readonly identity fields (`id`, `name`, `description`,
 *     `category`, `icon`, `systemPrompt`, `tools`, `exampleQueries`),
 *   - the `run(goal, opts)` method that performs the actual analysis.
 *
 * Subclasses MAY override:
 *   - `provider` and `temperature` (declared as readonly fields — set
 *     in the subclass constructor or as a class field).
 *
 * The base class is intentionally NOT an `IProvider`-only construct —
 * it works perfectly well with zero LLM access (pure static analysis).
 * The `provider` opt is purely additive: when set, subclasses may call
 * {@link BaseAgent.llmChat} for higher-level reasoning.
 *
 * @example
 * ```ts
 * class MyAgent extends BaseAgent {
 *   readonly id = 'my-agent';
 *   readonly name = 'My Agent';
 *   readonly description = 'Does the thing.';
 *   readonly category: AgentCategory = 'analysis';
 *   readonly icon = '🔍';
 *   readonly systemPrompt = 'You are My Agent...';
 *   readonly tools = ['read_file', 'search_files'];
 *   readonly exampleQueries = ['Find the thing'];
 *
 *   async run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult> {
 *     const ctx = this.startRun(goal, opts);
 *     this.emitProgress('analyze', 'Scanning files...');
 *     for await (const file of this.walkFiles(ctx.cwd)) {
 *       this.addFinding({ severity: 'info', category: 'demo',
 *         title: file, description: 'Found a file.' });
 *     }
 *     return this.finishRun(ctx);
 *   }
 * }
 * ```
 */
export abstract class BaseAgent
  extends EventEmitter<BaseAgentEvents>
  implements SpecializedAgent
{
  // ── Identity (subclasses MUST override) ─────────────────────────────────────
  public abstract readonly id: string;
  public abstract readonly name: string;
  public abstract readonly description: string;
  public abstract readonly category: AgentCategory;
  public abstract readonly icon: string;
  public abstract readonly systemPrompt: string;
  public abstract readonly tools: string[];
  public abstract readonly exampleQueries: string[];

  // ── Optional overrides ──────────────────────────────────────────────────────
  public readonly provider?: string;
  public readonly temperature?: number;

  // ── Optional LLM provider instance (set via constructor opts) ───────────────
  private readonly llmProvider: IProvider | undefined;

  /**
   * @param opts - Optional constructor opts (currently just `provider`).
   */
  constructor(opts: BaseAgentOptions = {}) {
    super();
    this.llmProvider = opts.provider;
  }

  // ── Abstract run() ──────────────────────────────────────────────────────────
  /**
   * Run the agent against a goal. Subclasses implement this; they should
   * call {@link startRun} at the top, do their work using the helpers
   * (`emitProgress`, `addFinding`, `recordAction`, `walkFiles`, ...),
   * and finally `return this.finishRun(ctx)`.
   *
   * @param goal - The user's high-level goal.
   * @param opts - Optional run configuration.
   */
  abstract run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult>;

  // ── Run lifecycle helpers ───────────────────────────────────────────────────

  /**
   * Initialize a run. Subclasses call this at the top of `run()`:
   *
   * ```ts
   * const ctx = this.startRun(goal, opts);
   * ```
   *
   * The returned context accumulates findings/actions/metrics as the
   * agent works. {@link finishRun} produces the final
   * {@link AgentRunResult} from it.
   */
  protected startRun(goal: string, opts?: AgentRunOptions): RunContext {
    const ctx: RunContext = {
      goal,
      opts: {
        cwd: opts?.cwd ?? process.cwd(),
        provider: opts?.provider ?? this.provider ?? 'static',
        maxIterations: opts?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        dryRun: opts?.dryRun ?? false,
        outputFormat: opts?.outputFormat ?? 'markdown',
        onProgress: opts?.onProgress,
      },
      startedAt: Date.now(),
      iteration: 0,
      findings: [],
      actions: [],
      metrics: {},
      costUsd: 0,
      tokensUsed: 0,
      success: true,
      output: '',
    };
    this.emitProgress('start', `Agent ${this.id} starting: ${goal}`, undefined, ctx);
    return ctx;
  }

  /**
   * Finalize a run. Subclasses call this at the end of `run()`:
   *
   * ```ts
   * return this.finishRun(ctx);
   * ```
   *
   * This emits the `complete` (or `error`) progress event, formats the
   * output per `ctx.opts.outputFormat`, and returns the structured
   * {@link AgentRunResult}.
   */
  protected finishRun(ctx: RunContext): AgentRunResult {
    const durationMs = Date.now() - ctx.startedAt;
    const output = this.formatOutput(ctx);

    if (ctx.success) {
      this.emitProgress(
        'complete',
        `Agent ${this.id} completed in ${durationMs}ms with ${ctx.findings.length} findings.`,
        { findings: ctx.findings.length, actions: ctx.actions.length, durationMs },
        ctx,
      );
    } else {
      this.emitProgress('error', `Agent ${this.id} ended with success=false.`, { durationMs }, ctx);
    }

    return {
      agentId: this.id,
      goal: ctx.goal,
      success: ctx.success,
      output,
      findings: ctx.findings,
      actions: ctx.actions,
      metrics: ctx.metrics,
      durationMs,
      costUsd: ctx.costUsd,
      tokensUsed: ctx.tokensUsed,
    };
  }

  // ── Progress + EventEmitter bridge ─────────────────────────────────────────

  /**
   * Emit a structured progress event. Subclasses call this to surface
   * live progress to the caller. The event is dispatched both via the
   * EventEmitter3 surface (`agent.on('analyze', ...)`) and via the
   * `onProgress` callback in {@link AgentRunOptions}.
   */
  protected emitProgress(
    type: AgentProgressEvent['type'],
    message: string,
    data?: unknown,
    ctx?: RunContext,
  ): void {
    const event: AgentProgressEvent = {
      type,
      message,
      data,
      iteration: ctx?.iteration,
      timestamp: new Date().toISOString(),
    };
    // Bridge to onProgress callback (one-shot subscriber per run).
    ctx?.opts.onProgress?.(event);
    // Bridge to EventEmitter3 subscribers (long-lived subscribers).
    this.emit(type, event);
  }

  // ── Finding / action / metric collection ───────────────────────────────────

  /**
   * Record a finding. Returns the new finding (with a generated id) so
   * the caller can attach a snippet or suggestion afterwards.
   */
  protected addFinding(
    ctx: RunContext,
    finding: Omit<AgentFinding, 'id'>,
  ): AgentFinding {
    const full: AgentFinding = { id: nanoid(12), ...finding };
    ctx.findings.push(full);
    this.emitProgress('finding', full.title, full, ctx);
    return full;
  }

  /**
   * Record an action. Returns the new action (with a generated id).
   */
  protected recordAction(
    ctx: RunContext,
    action: Omit<AgentAction, 'id'>,
  ): AgentAction {
    const full: AgentAction = { id: nanoid(12), ...action };
    ctx.actions.push(full);
    this.emitProgress('action', full.description, full, ctx);
    return full;
  }

  /**
   * Increment (or set) a named metric on the run context. Metrics are
   * surfaced in the final {@link AgentRunResult.metrics} map and in the
   * markdown report's summary table.
   */
  protected recordMetric(
    ctx: RunContext,
    name: string,
    valueOrDelta: number,
    mode: 'increment' | 'set' = 'increment',
  ): void {
    if (mode === 'set') {
      ctx.metrics[name] = valueOrDelta;
    } else {
      ctx.metrics[name] = (ctx.metrics[name] ?? 0) + valueOrDelta;
    }
  }

  /**
   * Mark the run as failed. The run continues (subclass decides whether
   * to bail or keep going), but the final result will report
   * `success: false`.
   */
  protected markFailed(ctx: RunContext, reason: string): void {
    ctx.success = false;
    if (ctx.output === '') ctx.output = reason;
  }

  // ── Cost + token tracking ──────────────────────────────────────────────────

  /**
   * Record an LLM cost. No-op when no provider is wired in.
   */
  protected trackCost(ctx: RunContext, estimate: CostEstimate): void {
    const cost = this.estimateCostUsd(estimate);
    ctx.costUsd += cost;
    ctx.tokensUsed += estimate.inputTokens + estimate.outputTokens;
  }

  /**
   * Record raw token usage (when no cost-per-token is available, e.g.
   * local providers). Increments the `tokensUsed` counter only.
   */
  protected trackTokens(ctx: RunContext, inputTokens: number, outputTokens: number): void {
    ctx.tokensUsed += inputTokens + outputTokens;
  }

  /**
   * Rough USD cost estimate per 1M tokens. Hardcoded pricing covers the
   * common SANIX providers; unknown providers default to a mid-range
   * $3/M input, $15/M output (Claude Sonnet-class) estimate.
   */
  protected estimateCostUsd(estimate: CostEstimate): number {
    const [inPerM, outPerM] = this.pricingFor(estimate.providerId);
    return (estimate.inputTokens / 1_000_000) * inPerM + (estimate.outputTokens / 1_000_000) * outPerM;
  }

  /**
   * Pricing table per provider id — `[inputPerM, outputPerM]` in USD.
   * Used by {@link estimateCostUsd}. Unknown providers default to
   * Sonnet-class pricing.
   */
  protected pricingFor(providerId: string): [number, number] {
    const table: Record<string, [number, number]> = {
      'claude-opus-4': [15, 75],
      'claude-sonnet-4': [3, 15],
      'claude-haiku-3.5': [0.8, 4],
      'gpt-4o': [2.5, 10],
      'gpt-4o-mini': [0.15, 0.6],
      'gpt-4-turbo': [10, 30],
      'gpt-4': [30, 60],
      'gpt-3.5-turbo': [0.5, 1.5],
      'gemini-1.5-pro': [1.25, 5],
      'gemini-1.5-flash': [0.075, 0.3],
      'groq-llama-3.3-70b': [0.59, 0.79],
      'deepseek-chat': [0.14, 0.28],
      'mistral-large': [2, 6],
    };
    return table[providerId] ?? [3, 15];
  }

  // ── Output formatting ──────────────────────────────────────────────────────

  /**
   * Format the run's accumulated findings/actions/metrics into the
   * requested output format. Subclasses may override this to add a
   * custom report header/footer, but the default produces a sensible
   * markdown / json / text digest.
   */
  protected formatOutput(ctx: RunContext): string {
    if (ctx.opts.outputFormat === 'json') {
      return JSON.stringify(this.toResult(ctx), null, 2);
    }
    if (ctx.opts.outputFormat === 'text') {
      return this.formatText(ctx);
    }
    return this.formatMarkdown(ctx);
  }

  /**
   * Build the structured {@link AgentRunResult} from a run context —
   * used by both {@link finishRun} and {@link formatOutput} (for JSON).
   */
  protected toResult(ctx: RunContext): AgentRunResult {
    return {
      agentId: this.id,
      goal: ctx.goal,
      success: ctx.success,
      output: ctx.output,
      findings: ctx.findings,
      actions: ctx.actions,
      metrics: ctx.metrics,
      durationMs: Date.now() - ctx.startedAt,
      costUsd: ctx.costUsd,
      tokensUsed: ctx.tokensUsed,
    };
  }

  /**
   * Default markdown report. Subclasses may override
   * {@link formatMarkdown} to inject a custom header / summary.
   */
  protected formatMarkdown(ctx: RunContext): string {
    const lines: string[] = [];
    lines.push(`# ${this.icon} ${this.name} — Report`);
    lines.push('');
    lines.push(`**Goal:** ${ctx.goal}`);
    lines.push(`**Status:** ${ctx.success ? '✅ Success' : '❌ Failed'}`);
    lines.push(`**Duration:** ${Date.now() - ctx.startedAt} ms`);
    lines.push(`**Findings:** ${ctx.findings.length}`);
    lines.push(`**Actions:** ${ctx.actions.length}`);
    lines.push(`**Cost:** $${ctx.costUsd.toFixed(4)} (${ctx.tokensUsed} tokens)`);
    if (Object.keys(ctx.metrics).length > 0) {
      lines.push('');
      lines.push('## Metrics');
      lines.push('');
      lines.push('| Metric | Value |');
      lines.push('| --- | --- |');
      for (const [k, v] of Object.entries(ctx.metrics)) {
        lines.push(`| ${k} | ${v} |`);
      }
    }
    if (ctx.findings.length > 0) {
      lines.push('');
      lines.push('## Findings');
      lines.push('');
      // Sort by severity (critical first).
      const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
      const sorted = [...ctx.findings].sort(
        (a, b) => order[a.severity] - order[b.severity],
      );
      for (const f of sorted) {
        lines.push(`### [${f.severity.toUpperCase()}] ${f.title}`);
        lines.push('');
        lines.push(`- **Category:** ${f.category}`);
        if (f.file) {
          const loc = f.line ? `${f.file}:${f.line}` : f.file;
          lines.push(`- **Location:** \`${loc}\``);
        }
        if (f.tags && f.tags.length > 0) {
          lines.push(`- **Tags:** ${f.tags.map((t) => `\`${t}\``).join(', ')}`);
        }
        if (f.autoFixable) lines.push('- **Auto-fixable:** ✅ yes');
        lines.push('');
        lines.push(f.description);
        if (f.snippet) {
          lines.push('');
          lines.push('```');
          lines.push(f.snippet.trim());
          lines.push('```');
        }
        if (f.suggestion) {
          lines.push('');
          lines.push('**Suggested fix:**');
          lines.push('');
          lines.push(f.suggestion);
        }
        lines.push('');
      }
    }
    if (ctx.actions.length > 0) {
      lines.push('## Actions');
      lines.push('');
      lines.push('| # | Type | Description | Duration | Status |');
      lines.push('| --- | --- | --- | --- | --- |');
      ctx.actions.forEach((a, i) => {
        const status = a.success ? '✅' : '❌';
        lines.push(
          `| ${i + 1} | ${a.type} | ${a.description} | ${a.durationMs}ms | ${status} |`,
        );
      });
    }
    return lines.join('\n');
  }

  /**
   * Default plain-text digest. Subclasses may override.
   */
  protected formatText(ctx: RunContext): string {
    const lines: string[] = [];
    lines.push(`[${this.icon} ${this.name}] goal: ${ctx.goal}`);
    lines.push(`status: ${ctx.success ? 'success' : 'failed'}, duration: ${Date.now() - ctx.startedAt}ms, findings: ${ctx.findings.length}`);
    for (const f of ctx.findings) {
      const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
      lines.push(`  [${f.severity}] ${f.title}${loc}`);
    }
    return lines.join('\n');
  }

  // ── Filesystem helpers ─────────────────────────────────────────────────────

  /**
   * Walk files under `dir`, yielding absolute paths. Respects
   * {@link DEFAULT_IGNORED_DIRS} plus any in `opts.ignoreDirs`. Filters
   * by extension if `opts.extensions` is set; otherwise yields all text
   * files (per {@link TEXT_FILE_EXTENSIONS}).
   *
   * Implemented as an async generator so callers can `for await ... of`
   * without buffering the entire tree.
   */
  protected async *walkFiles(
    dir: string,
    opts: WalkOptions = {},
  ): AsyncGenerator<string> {
    const ignore = new Set<string>([
      ...DEFAULT_IGNORED_DIRS,
      ...(opts.ignoreDirs ?? []),
    ]);
    const extensions = opts.extensions
      ? new Set(opts.extensions.map((e) => (e.startsWith('.') ? e : '.' + e)))
      : null;
    const maxFiles = opts.maxFiles ?? 5000;
    const maxFileBytes = opts.maxFileBytes ?? 1_048_576;
    let count = 0;

    async function* walk(current: string): AsyncGenerator<string> {
      if (count >= maxFiles) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (count >= maxFiles) return;
        if (entry.isDirectory()) {
          if (ignore.has(entry.name)) continue;
          if (entry.name.startsWith('.') && entry.name !== '.env') continue;
          yield* walk(path.join(current, entry.name));
        } else if (entry.isFile()) {
          if (extensions && !extensions.has(path.extname(entry.name).toLowerCase())) {
            continue;
          }
          if (!extensions && !isTextFile(entry.name)) continue;
          // Skip oversized files.
          try {
            const stat = await fs.stat(path.join(current, entry.name));
            if (stat.size > maxFileBytes) continue;
          } catch {
            continue;
          }
          count++;
          yield path.join(current, entry.name);
        }
      }
    }

    yield* walk(dir);
  }

  /**
   * Read a file as UTF-8 text. Returns `null` on error (file missing,
   * binary, ...) — callers should treat `null` as "skip this file".
   * Records a `read` action in the run context (if supplied).
   */
  protected async readFileSafe(
    filePath: string,
    ctx?: RunContext,
  ): Promise<string | null> {
    const start = Date.now();
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (ctx) {
        this.recordAction(ctx, {
          type: 'read',
          description: `Read ${filePath}`,
          input: { path: filePath },
          output: { bytes: content.length },
          durationMs: Date.now() - start,
          success: true,
        });
      }
      return content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx) {
        this.recordAction(ctx, {
          type: 'read',
          description: `Read ${filePath}`,
          input: { path: filePath },
          durationMs: Date.now() - start,
          success: false,
          error: msg,
        });
      }
      return null;
    }
  }

  /**
   * Write a file (unless `dryRun` is true — then record the action
   * without touching the filesystem). Creates parent directories as
   * needed.
   */
  protected async writeFileSafe(
    filePath: string,
    content: string,
    ctx: RunContext,
  ): Promise<boolean> {
    const start = Date.now();
    if (ctx.opts.dryRun) {
      this.recordAction(ctx, {
        type: 'write',
        description: `[dry-run] Write ${filePath}`,
        input: { path: filePath, bytes: content.length },
        durationMs: Date.now() - start,
        success: true,
      });
      return true;
    }
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');
      this.recordAction(ctx, {
        type: 'write',
        description: `Write ${filePath}`,
        input: { path: filePath, bytes: content.length },
        durationMs: Date.now() - start,
        success: true,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordAction(ctx, {
        type: 'write',
        description: `Write ${filePath}`,
        input: { path: filePath, bytes: content.length },
        durationMs: Date.now() - start,
        success: false,
        error: msg,
      });
      return false;
    }
  }

  /**
   * Run a shell command and capture stdout/stderr/exitCode. Records an
   * `exec` action. Honors `dryRun` (records the command without
   * executing).
   *
   * @param command - The shell command to run.
   * @param ctx - The current run context.
   * @param execCwd - Working directory for the command (defaults to
   *                  `ctx.opts.cwd`).
   * @param timeoutMs - Timeout in ms (default 30s).
   */
  protected async runShell(
    command: string,
    ctx: RunContext,
    execCwd?: string,
    timeoutMs = 30_000,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }> {
    const start = Date.now();
    if (ctx.opts.dryRun) {
      this.recordAction(ctx, {
        type: 'exec',
        description: `[dry-run] ${command}`,
        input: { command },
        durationMs: Date.now() - start,
        success: true,
      });
      return { stdout: '', stderr: '', exitCode: 0, success: true };
    }
    return new Promise((resolve) => {
      childProcess.exec(
        command,
        {
          cwd: execCwd ?? ctx.opts.cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const exitCode = err && 'code' in err ? (err.code as number) : err ? 1 : 0;
          const success = !err;
          this.recordAction(ctx, {
            type: 'exec',
            description: command,
            input: { command, cwd: execCwd ?? ctx.opts.cwd },
            output: { stdout: stdout.length > 4096 ? stdout.slice(0, 4096) + '…' : stdout, exitCode },
            durationMs: Date.now() - start,
            success,
            error: err && !('code' in err) ? err.message : undefined,
          });
          resolve({ stdout, stderr, exitCode, success });
        },
      );
    });
  }

  /**
   * Search a file's contents for matches of a regex. Returns the
   * matches with line numbers (1-indexed) and the matched line text.
   * Used by every scan-heavy agent.
   */
  protected searchInFile(
    content: string,
    pattern: RegExp,
  ): Array<{ line: number; match: string; lineText: string }> {
    const results: Array<{ line: number; match: string; lineText: string }> = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      // Reset lastIndex for non-global regexes (otherwise stateful iteration skips matches).
      pattern.lastIndex = 0;
      const m = pattern.exec(lineText);
      if (m) {
        results.push({ line: i + 1, match: m[0], lineText });
      }
    }
    return results;
  }

  /**
   * Iterate over every text file under `cwd`, calling `fn` with the
   * file path and contents. Returns the number of files processed.
   * Respects the run's `maxIterations` cap (file count).
   */
  protected async scanFiles(
    ctx: RunContext,
    fn: (filePath: string, content: string) => Promise<void> | void,
    opts: WalkOptions = {},
  ): Promise<number> {
    let processed = 0;
    for await (const file of this.walkFiles(ctx.opts.cwd, opts)) {
      if (processed >= ctx.opts.maxIterations * 200) break;
      ctx.iteration++;
      const content = await this.readFileSafe(file, ctx);
      if (content === null) continue;
      await fn(file, content);
      processed++;
    }
    return processed;
  }

  // ── LLM bridge (optional) ──────────────────────────────────────────────────

  /**
   * Optional LLM chat helper. Subclasses call this when they want
   * higher-level reasoning (e.g. drafting a migration plan from a
   * context summary). When no provider is wired in, returns `null` —
   * subclasses MUST handle this gracefully (fall back to static logic).
   *
   * Always records cost + tokens in the run context.
   */
  protected async llmChat(
    ctx: RunContext,
    messages: LLMMessage[],
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<LLMResponse | null> {
    if (!this.llmProvider) return null;
    const start = Date.now();
    try {
      const req: LLMRequest = {
        messages,
        maxTokens: opts?.maxTokens ?? 2048,
        temperature: opts?.temperature ?? this.temperature ?? 0.2,
        systemPrompt: this.systemPrompt,
      };
      const response = await this.llmProvider.chat(req);
      this.trackCost(ctx, {
        providerId: this.llmProvider.id,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
      this.recordAction(ctx, {
        type: 'analyze',
        description: `LLM chat (${this.llmProvider.id}) ${Date.now() - start}ms`,
        input: { messageCount: messages.length },
        output: { contentLength: response.content.length },
        durationMs: Date.now() - start,
        success: true,
      });
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordAction(ctx, {
        type: 'analyze',
        description: `LLM chat (${this.llmProvider?.id ?? 'unknown'})`,
        input: { messageCount: messages.length },
        durationMs: Date.now() - start,
        success: false,
        error: msg,
      });
      return null;
    }
  }
}

// ─── Module-level helpers (kept top-level so they're tree-shakeable) ─────────

/**
 * Test whether a file path is "text" based on its extension. Used by
 * {@link BaseAgent.walkFiles} to skip binary files.
 */
export function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
  // Special-case extensionless files common in devops.
  const base = path.basename(filePath).toLowerCase();
  return ['dockerfile', 'makefile', 'rakefile', 'gemfile', 'license', 'readme'].includes(base);
}

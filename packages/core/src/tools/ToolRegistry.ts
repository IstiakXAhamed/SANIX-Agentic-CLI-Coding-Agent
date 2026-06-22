/**
 * @file tools/ToolRegistry.ts
 * @description Central tool registration and dispatch hub. Tools register
 * themselves (or are registered by the CLI bootstrap on behalf of
 * `@sanix/tools`), and the AgentLoop's Executor looks them up by name to
 * dispatch `TOOL_CALL` decisions.
 *
 * The registry is also an `EventEmitter3` so the TUI, telemetry, and audit
 * log can subscribe to `tool:before` / `tool:after` / `tool:error` events
 * without coupling to the executor.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import type {
  AnySanixTool,
  RegisteredTool,
  ToolContext,
  ToolRegistryEvents,
  ToolResult,
} from './interfaces.js';
import { ToolValidator, type ValidationResult } from './ToolValidator.js';
import type { HookManager } from '../hooks/HookManager.js';

/**
 * Options for {@link ToolRegistry.register}.
 */
export interface RegisterOptions {
  /** When false, the tool is registered but disabled (calls rejected). */
  enabled?: boolean;
  /** Source label (e.g. 'builtin', 'mcp:myserver'). */
  source?: string;
}

/**
 * Options for {@link ToolRegistry.execute}.
 */
export interface ExecuteOptions {
  /** Skip schema validation (caller has already validated). Default false. */
  skipValidation?: boolean;
}

/**
 * Central registry of all SANIX tools. Single instance per agent run.
 *
 * @example
 * ```ts
 * const registry = new ToolRegistry();
 * registry.register(new ReadFileTool());
 * registry.register(new BashTool(), { source: 'builtin' });
 *
 * registry.on('tool:after', ({ name, result, durationMs }) => {
 *   console.log(`${name} → ${result.success ? 'ok' : 'fail'} (${durationMs}ms)`);
 * });
 *
 * const result = await registry.execute('read_file', { path: '/etc/hosts' }, ctx);
 * ```
 */
export class ToolRegistry extends EventEmitter<ToolRegistryEvents> {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly validator: ToolValidator;
  /**
   * Optional hook manager. When set, the registry emits `tool:before`
   * (which can veto or modify input) and `tool:after` (which can modify
   * the result) around every {@link execute} call. Opt-in.
   */
  private hookManager: HookManager | undefined;

  constructor() {
    super();
    this.validator = new ToolValidator();
  }

  /**
   * Attach a {@link HookManager}. The registry will emit `tool:before` /
   * `tool:after` hooks around every {@link execute} call. Setting `null`
   * (or calling with no argument) detaches.
   *
   * @param hm - The hook manager (or undefined to detach).
   */
  setHookManager(hm: HookManager | undefined): void {
    this.hookManager = hm;
  }

  /**
   * Register a tool. If a tool with the same name already exists, it is
   * replaced (with a warning emitted via `tool:registered`).
   *
   * @param tool - The tool instance to register.
   * @param opts - Registration options.
   * @returns this (for chaining).
   */
  register(tool: AnySanixTool, opts: RegisterOptions = {}): this {
    const entry: RegisteredTool = {
      tool,
      registeredAt: new Date().toISOString(),
      enabled: opts.enabled ?? true,
      source: opts.source,
    };
    this.tools.set(tool.name, entry);
    this.emit('tool:registered', { name: tool.name, source: opts.source });
    return this;
  }

  /**
   * Unregister a tool by name. No-op if the tool is not registered.
   *
   * @param name - The tool name to remove.
   * @returns true if a tool was removed.
   */
  unregister(name: string): boolean {
    const had = this.tools.delete(name);
    if (had) this.emit('tool:unregistered', { name });
    return had;
  }

  /**
   * Enable a previously-registered (but disabled) tool.
   */
  enable(name: string): boolean {
    const entry = this.tools.get(name);
    if (!entry) return false;
    entry.enabled = true;
    return true;
  }

  /**
   * Disable a tool (calls to it will be rejected). The tool remains
   * registered and visible in `list()`.
   */
  disable(name: string): boolean {
    const entry = this.tools.get(name);
    if (!entry) return false;
    entry.enabled = false;
    return true;
  }

  /**
   * Look up a tool by name. Returns the `AnySanixTool` (not the
   * `RegisteredTool` wrapper) or undefined.
   *
   * @example
   * ```ts
   * const tool = registry.get('read_file');
   * if (tool) console.log(tool.description);
   * ```
   */
  get(name: string): AnySanixTool | undefined {
    return this.tools.get(name)?.tool;
  }

  /**
   * Look up the full registration entry (includes enabled flag, source,
   * registeredAt). Returns undefined if not registered.
   */
  getEntry(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered tools (including disabled ones).
   *
   * @param opts - `{ enabledOnly?: true }` filters out disabled tools.
   */
  list(opts: { enabledOnly?: boolean } = {}): RegisteredTool[] {
    const all = [...this.tools.values()];
    if (opts.enabledOnly) return all.filter((e) => e.enabled);
    return all;
  }

  /**
   * List the names of all enabled tools — convenience for building the
   * `tools` array passed to an LLM request.
   */
  enabledNames(): string[] {
    return this.list({ enabledOnly: true }).map((e) => e.tool.name);
  }

  /**
   * Validate a tool call's arguments + permissions without executing. Useful
   * for pre-flight checks and for surfacing validation errors to the LLM
   * before the executor commits to running the tool.
   *
   * @param name - Tool name.
   * @param argsJson - Raw JSON arguments string from the LLM.
   * @param ctx - Runtime tool context.
   */
  validate(
    name: string,
    argsJson: string,
    ctx: ToolContext,
  ): ValidationResult {
    const tool = this.get(name);
    if (!tool) {
      return { ok: false, kind: 'schema_error', error: `Tool '${name}' is not registered` };
    }
    if (!this.tools.get(name)!.enabled) {
      return { ok: false, kind: 'permission_denied', error: `Tool '${name}' is disabled` };
    }
    return this.validator.validate(tool, argsJson, ctx);
  }

  /**
   * Execute a tool by name. Performs schema validation (unless
   * `skipValidation` is set), emits `tool:before` / `tool:after` /
   * `tool:error` events, and returns the standardized `ToolResult`.
   *
   * The method NEVER throws on expected tool failures — those are returned
   * as `{ success: false, error }`. Programmer errors (tool not registered,
   * schema mismatch when `skipValidation` is true) throw.
   *
   * @param name - Tool name (must be registered and enabled).
   * @param input - Already-parsed input (caller takes responsibility for
   *                schema validation when `skipValidation: true`), OR a raw
   *                JSON string (parsed + validated when `skipValidation: false`).
   * @param ctx - Runtime tool context.
   * @param opts - Execution options.
   */
  async execute(
    name: string,
    input: unknown | string,
    ctx: ToolContext,
    opts: ExecuteOptions = {},
  ): Promise<ToolResult<unknown>> {
    const entry = this.tools.get(name);
    if (!entry) {
      const err = `Tool '${name}' is not registered`;
      this.emit('tool:error', { name, error: err, input });
      return { success: false, error: err, tokensUsed: 0, durationMs: 0 };
    }
    if (!entry.enabled) {
      const err = `Tool '${name}' is disabled`;
      this.emit('tool:error', { name, error: err, input });
      return { success: false, error: err, tokensUsed: 0, durationMs: 0 };
    }

    const tool = entry.tool;
    let validatedInput: unknown;

    if (opts.skipValidation) {
      validatedInput = input;
    } else {
      const argsJson = typeof input === 'string' ? input : JSON.stringify(input);
      const v = this.validator.validate(tool, argsJson, ctx);
      if (!v.ok) {
        this.emit('tool:error', { name, error: v.error, input });
        return { success: false, error: v.error, tokensUsed: 0, durationMs: 0 };
      }
      validatedInput = v.input;
    }

    // ── Hook: tool:before (can veto or modify input). ──
    if (this.hookManager) {
      const hookCtx = await this.hookManager.emit('tool:before', {
        toolName: name,
        toolInput: validatedInput,
      });
      if (hookCtx.vetoed) {
        const vetoErr = 'Tool execution vetoed by hook';
        this.emit('tool:error', { name, error: vetoErr, input: validatedInput });
        return { success: false, error: vetoErr, tokensUsed: 0, durationMs: 0 };
      }
      if (hookCtx.toolInput !== undefined) {
        validatedInput = hookCtx.toolInput;
      }
    }

    // ── Approval workflow (opt-in via ToolContext.approvalManager). ──
    if (ctx.approvalManager) {
      const am = ctx.approvalManager;
      // Only prompt if any of the tool's permissions require approval.
      const needsApproval = tool.permissions.some((p) => am.requiresApproval(p));
      if (needsApproval) {
        try {
          const response = await am.requestApproval({
            toolName: name,
            toolInput: validatedInput,
            permissions: tool.permissions,
            reason: `Tool '${name}' requires one of: ${tool.permissions.join(', ')}.`,
            context: ctx.metadata,
          });
          if (response.decision === 'deny' || response.decision === 'deny_always') {
            const denyErr = 'Tool execution denied by user';
            this.emit('tool:error', { name, error: denyErr, input: validatedInput });
            return { success: false, error: denyErr, tokensUsed: 0, durationMs: 0 };
          }
          // Approve / approve_always — optionally apply modified input.
          if (response.modifiedInput !== undefined) {
            validatedInput = response.modifiedInput;
          }
        } catch (err) {
          // Handler error → deny (safer default).
          const msg = err instanceof Error ? err.message : String(err);
          const denyErr = `Approval handler error: ${msg}`;
          this.emit('tool:error', { name, error: denyErr, input: validatedInput });
          return { success: false, error: denyErr, tokensUsed: 0, durationMs: 0 };
        }
      }
    }

    const startedAt = new Date().toISOString();
    this.emit('tool:before', { name, input: validatedInput, timestamp: startedAt });
    const start = Date.now();

    let normalized: ToolResult<unknown>;
    try {
      const result = await tool.execute(validatedInput, ctx);
      const durationMs = Date.now() - start;
      normalized = {
        success: result.success,
        output: result.output,
        error: result.error,
        tokensUsed: result.tokensUsed ?? 0,
        durationMs: result.durationMs || durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('tool:error', { name, error: msg, input: validatedInput });
      normalized = { success: false, error: msg, tokensUsed: 0, durationMs };
    }

    // ── Hook: tool:after (can modify result). ──
    if (this.hookManager) {
      const hookCtx = await this.hookManager.emit('tool:after', {
        toolName: name,
        toolInput: validatedInput,
        toolResult: normalized,
      });
      if (hookCtx.toolResult !== undefined) {
        normalized = hookCtx.toolResult as ToolResult<unknown>;
      }
    }

    this.emit('tool:after', { name, result: normalized, durationMs: normalized.durationMs });
    if (!normalized.success) {
      this.emit('tool:error', {
        name,
        error: normalized.error ?? 'unknown error',
        input: validatedInput,
      });
    }
    return normalized;
  }

  /**
   * Clear all registered tools. Mainly useful in tests.
   */
  clear(): void {
    for (const name of [...this.tools.keys()]) {
      this.unregister(name);
    }
  }

  /**
   * Number of tools currently registered.
   */
  get size(): number {
    return this.tools.size;
  }
}

/**
 * @file AgentObserver.ts
 * @description Hooks into the AgentLoop via the HookManager to auto-trace
 * every agent run. Creates a root span per `agent:start`, child spans per
 * `iteration`, grandchildren per `tool` / `llm` call, and auto-records
 * metrics (token counts, costs, latencies).
 *
 * @packageDocumentation
 */

import type { HookManager } from '@sanix/core';
import type { LLMRequest, LLMResponse } from '@sanix/providers';
import type { SanixTracer } from './Tracer.js';
import type { MetricsRegistry } from './Metrics.js';
import type { Span } from './types.js';

/**
 * Constructor options for {@link AgentObserver}.
 */
export interface AgentObserverOptions {
  /**
   * The agent id used as the `agent_id` label for metrics. If unset,
   * a fresh id is generated per `agent:start` event (so each run gets
   * its own metric series).
   */
  agentId?: string;
}

/**
 * An observer that auto-traces SANIX AgentLoop runs via the HookManager.
 * Attach it once per agent run and it will create a span tree mirroring
 * the agent's execution:
 *
 *   ```
 *   agent:run
 *   ├─ iteration:0
 *   │  ├─ llm:chat
 *   │  └─ tool:read_file
 *   ├─ iteration:1
 *   │  └─ llm:chat
 *   └─ ...
 *   ```
 *
 * @example
 * ```ts
 * const tracer = new SanixTracer();
 * const metrics = new MetricsRegistry();
 * const observer = new AgentObserver(tracer, metrics);
 * observer.attach(hookManager);
 * await agentLoop.run(goal, ctx);
 * console.log(tracer.exportJSON());
 * ```
 */
export class AgentObserver {
  private readonly tracer: SanixTracer;
  private readonly metrics: MetricsRegistry;
  private readonly agentId?: string;
  /** agent id assigned for the current run (from options or auto-generated). */
  private currentAgentId: string | null = null;
  /** Root span for the current agent run. */
  private rootSpan: Span | null = null;
  /** Per-iteration span, keyed by iteration index. */
  private readonly iterSpans: Map<number, Span> = new Map();
  /** In-flight tool span (awaiting `tool:after`). */
  private toolSpan: Span | null = null;
  /** In-flight LLM span (awaiting `llm:after`). */
  private llmSpan: Span | null = null;
  /** Start time of the current agent run (for duration metric). */
  private runStart = 0;
  /** Registration ids returned by `hookManager.on` (for optional detach). */
  private readonly regs: string[] = [];

  /**
   * @param tracer  - The tracer to record spans into.
   * @param metrics - The metrics registry to record metrics into.
   * @param opts    - Optional `{ agentId? }`.
   */
  constructor(
    tracer: SanixTracer,
    metrics: MetricsRegistry,
    opts: AgentObserverOptions = {},
  ) {
    this.tracer = tracer;
    this.metrics = metrics;
    this.agentId = opts.agentId;
  }

  /**
   * Register all hook handlers with the given {@link HookManager}.
   * Should be called before `AgentLoop.run()` so the observer sees the
   * `agent:start` event.
   */
  attach(hookManager: HookManager): void {
    this.regs.push(
      hookManager.on('agent:start', (ctx) => this.onAgentStart(ctx)),
      hookManager.on('iteration:before', (ctx) => this.onIterBefore(ctx)),
      hookManager.on('iteration:after', (ctx) => this.onIterAfter(ctx)),
      hookManager.on('tool:before', (ctx) => this.onToolBefore(ctx)),
      hookManager.on('tool:after', (ctx) => this.onToolAfter(ctx)),
      hookManager.on('llm:before', (ctx) => this.onLlmBefore(ctx)),
      hookManager.on('llm:after', (ctx) => this.onLlmAfter(ctx)),
      hookManager.on('cost:recorded', (ctx) => this.onCostRecorded(ctx)),
      hookManager.on('agent:complete', (ctx) => this.onAgentComplete(ctx)),
      hookManager.on('error', (ctx) => this.onError(ctx)),
    );
  }

  /**
   * Detach all hook handlers. Safe to call multiple times.
   */
  detach(hookManager: HookManager): void {
    for (const id of this.regs) hookManager.unregister(id);
    this.regs.length = 0;
  }

  // ─── Hook handlers ────────────────────────────────────────────────────

  private onAgentStart(ctx: { agentState?: { goal?: string } }): void {
    this.currentAgentId = this.agentId ?? `agent-${Date.now()}`;
    this.runStart = Date.now();
    this.rootSpan = this.tracer.startSpan('agent:run', {
      attributes: {
        'agent.id': this.currentAgentId,
        'agent.goal': ctx.agentState?.goal ?? '',
      },
    });
    this.iterSpans.clear();
  }

  private onIterBefore(ctx: { iteration?: number }): void {
    const iter = ctx.iteration ?? 0;
    const span = this.tracer.startSpan(`iteration:${iter}`, {
      parent: this.rootSpan ?? undefined,
      attributes: { 'iteration': iter },
    });
    this.iterSpans.set(iter, span);
    this.metrics.agentIterationsTotal(this.currentAgentId ?? 'unknown');
  }

  private onIterAfter(ctx: { iteration?: number }): void {
    const iter = ctx.iteration ?? 0;
    const span = this.iterSpans.get(iter);
    if (span) {
      span.end();
      this.iterSpans.delete(iter);
    }
  }

  private onToolBefore(ctx: {
    toolName?: string;
    toolInput?: unknown;
    iteration?: number;
  }): void {
    const iter = ctx.iteration ?? 0;
    const parent = this.iterSpans.get(iter) ?? this.rootSpan ?? undefined;
    const toolName = ctx.toolName ?? 'unknown';
    this.toolSpan = this.tracer.startSpan(`tool:${toolName}`, {
      parent,
      attributes: {
        'tool.name': toolName,
        'tool.input': safeStringify(ctx.toolInput),
      },
    });
  }

  private onToolAfter(ctx: {
    toolName?: string;
    toolResult?: unknown;
    iteration?: number;
  }): void {
    if (!this.toolSpan) return;
    const toolName = ctx.toolName ?? 'unknown';
    const result = ctx.toolResult as { success?: boolean; error?: string } | undefined;
    const success = result?.success !== false;
    this.toolSpan.setAttribute('tool.success', success);
    if (result?.error) this.toolSpan.setAttribute('tool.error', result.error);
    this.toolSpan.setStatus(success ? 'ok' : 'error');
    this.toolSpan.end();
    this.toolSpan = null;
    this.metrics.toolCallsTotal(toolName, success ? 'success' : 'failure');
  }

  private onLlmBefore(ctx: { llmRequest?: LLMRequest }): void {
    const parent =
      this.iterSpans.get(this.currentIter()) ?? this.rootSpan ?? undefined;
    const req = ctx.llmRequest;
    this.llmSpan = this.tracer.startSpan('llm:chat', {
      parent,
      attributes: req
        ? {
            'llm.messages': req.messages.length,
            'llm.tools': req.tools?.length ?? 0,
            'llm.max_tokens': req.maxTokens ?? 0,
            'llm.temperature': req.temperature ?? 0,
            'llm.task_type': req.taskType ?? 'general',
          }
        : {},
    });
  }

  private onLlmAfter(ctx: { llmResponse?: LLMResponse }): void {
    if (!this.llmSpan) return;
    const res = ctx.llmResponse;
    if (res) {
      this.llmSpan.setAttribute('llm.model', res.model);
      this.llmSpan.setAttribute('llm.tokens.input', res.usage.inputTokens);
      this.llmSpan.setAttribute('llm.tokens.output', res.usage.outputTokens);
      if (res.usage.cacheReadTokens)
        this.llmSpan.setAttribute('llm.tokens.cache_read', res.usage.cacheReadTokens);
      this.llmSpan.setAttribute('llm.latency_ms', res.latencyMs);
      this.llmSpan.setAttribute('llm.cache_hit', res.cacheHit ?? false);
      if (res.toolCalls && res.toolCalls.length > 0)
        this.llmSpan.setAttribute('llm.tool_calls', res.toolCalls.length);
      this.llmSpan.setStatus('ok');

      // Record metrics.
      // We don't know the provider id from the response alone — use model
      // name as the provider label (callers can re-label via post-processing).
      const provider = res.model;
      this.metrics.llmTokensTotal(provider, 'input', res.usage.inputTokens);
      this.metrics.llmTokensTotal(provider, 'output', res.usage.outputTokens);
      if (res.usage.cacheReadTokens)
        this.metrics.llmTokensTotal(provider, 'cache_read', res.usage.cacheReadTokens);
      this.metrics.llmLatencyMs(provider, res.latencyMs);
      if (res.costUsd !== undefined)
        this.metrics.llmCostUsdTotal(provider, res.costUsd);
    }
    this.llmSpan.end();
    this.llmSpan = null;
  }

  private onCostRecorded(ctx: {
    costEntry?: {
      providerId?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      costUsd?: number;
    };
  }): void {
    const e = ctx.costEntry;
    if (!e) return;
    const provider = e.providerId ?? e.model ?? 'unknown';
    if (e.costUsd !== undefined) this.metrics.llmCostUsdTotal(provider, e.costUsd);
    if (e.inputTokens) this.metrics.llmTokensTotal(provider, 'input', e.inputTokens);
    if (e.outputTokens) this.metrics.llmTokensTotal(provider, 'output', e.outputTokens);
    if (e.cacheReadTokens)
      this.metrics.llmTokensTotal(provider, 'cache_read', e.cacheReadTokens);
  }

  private onAgentComplete(_ctx: { agentState?: unknown }): void {
    if (this.rootSpan) {
      this.rootSpan.setStatus('ok');
      this.rootSpan.end();
      this.rootSpan = null;
    }
    if (this.currentAgentId) {
      const duration = Date.now() - this.runStart;
      this.metrics.agentDurationMs(this.currentAgentId, duration);
    }
    this.currentAgentId = null;
  }

  private onError(ctx: { error?: Error }): void {
    if (this.llmSpan) {
      this.llmSpan.setStatus('error');
      if (ctx.error) this.llmSpan.setAttribute('error.message', ctx.error.message);
      this.llmSpan.end();
      this.llmSpan = null;
    }
    if (this.toolSpan) {
      this.toolSpan.setStatus('error');
      if (ctx.error) this.toolSpan.setAttribute('error.message', ctx.error.message);
      this.toolSpan.end();
      this.toolSpan = null;
    }
    if (this.rootSpan && ctx.error) {
      this.rootSpan.setStatus('error');
      this.rootSpan.setAttribute('error.message', ctx.error.message);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /**
   * Best-effort guess at the current iteration index from the in-flight
   * iterSpans map (whichever was started most recently and not yet ended).
   */
  private currentIter(): number {
    let max = -1;
    for (const k of this.iterSpans.keys()) if (k > max) max = k;
    return max;
  }
}

/**
 * Safely stringify a value, swallowing circular-reference errors.
 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

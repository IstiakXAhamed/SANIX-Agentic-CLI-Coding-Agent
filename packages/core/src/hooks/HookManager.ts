/**
 * @file hooks/HookManager.ts
 * @description Sanix's extensible hook system. Provides a priority-ordered,
 * side-effect-capable, veto-capable event bus that any module can plug into
 * to observe or modify the agent's behavior at well-defined points:
 *
 *   - **Lifecycle**: `agent:start`, `agent:complete`
 *   - **Per-iteration**: `iteration:before`, `iteration:after`
 *   - **Tool dispatch**: `tool:before` (veto / modify input), `tool:after` (modify result)
 *   - **LLM dispatch**: `llm:before` (veto / modify request), `llm:after` (modify response)
 *   - **Planning**: `plan:created`, `plan:revised`
 *   - **Sub-agents**: `subagent:spawn`, `subagent:complete`
 *   - **Misc**: `error`, `cost:recorded`
 *
 * Hooks run in priority order (lower = earlier; default 100). Each handler
 * receives a {@link HookContext} and may return a {@link HookResult} that
 * either modifies the context for subsequent handlers, signals a veto
 * (short-circuit), or simply records side effects. All new features are
 * opt-in — `HookManager` is `undefined` by default on every call site.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type { LLMRequest, LLMResponse } from '@sanix/providers';
import type { AgentState, Plan } from '../agent/types.js';
// Re-use the CostEntry / CostSummary types defined by the existing cost
// module (Task A2). This keeps a single source of truth for cost types.
import type { CostEntry, CostSummary } from '../cost/CostTracker.js';

// Re-export so consumers can `import { CostEntry } from '@sanix/core/hooks'`
// without having to know about the cost module.
export type { CostEntry, CostSummary };

// ─── Hook event types ───────────────────────────────────────────────────────

/**
 * The set of well-defined hook events. Each maps to a specific point in the
 * agent lifecycle. Handlers register against one event at a time.
 */
export type HookEvent =
  | 'agent:start' // before the agent loop begins
  | 'agent:complete' // after the agent loop finishes
  | 'iteration:before' // before each OODA iteration
  | 'iteration:after' // after each OODA iteration
  | 'tool:before' // before a tool executes (can veto / modify input)
  | 'tool:after' // after a tool executes (can modify result)
  | 'llm:before' // before an LLM call (can modify request)
  | 'llm:after' // after an LLM call (can modify response)
  | 'plan:created' // after Planner.decompose()
  | 'plan:revised' // after Planner.replan()
  | 'subagent:spawn' // before a sub-agent starts
  | 'subagent:complete' // after a sub-agent finishes
  | 'error' // on any unhandled error
  | 'cost:recorded'; // after a cost entry is recorded

/**
 * The context handed to every hook handler. Only the fields relevant to the
 * fired event are populated; the rest are `undefined`. Handlers may mutate
 * the *return value* of the handler (via {@link HookResult}) — direct
 * mutation of this object is discouraged.
 *
 * The optional `vetoed` flag is set by {@link HookManager.emit} when a
 * prior handler vetoed the action; subsequent handlers can inspect it.
 */
export interface HookContext {
  /** The agent state at the time of the event (lifecycle / iteration events). */
  agentState?: AgentState;
  /** Tool name (for `tool:*` events). */
  toolName?: string;
  /** Tool input (for `tool:*` events; may be modified by `tool:before` handlers). */
  toolInput?: unknown;
  /** Tool result (for `tool:after`; may be modified). */
  toolResult?: unknown;
  /** LLM request (for `llm:*` events; may be modified by `llm:before` handlers). */
  llmRequest?: LLMRequest;
  /** LLM response (for `llm:after`; may be modified). */
  llmResponse?: LLMResponse;
  /** The plan (for `plan:*` events; may be modified). */
  plan?: Plan;
  /** Sub-agent id (for `subagent:*` events). */
  subAgentId?: string;
  /** The error (for `error` events). */
  error?: Error;
  /** The cost entry (for `cost:recorded` events). */
  costEntry?: CostEntry;
  /** Iteration index (for `iteration:*` events). */
  iteration?: number;
  /**
   * Set to `true` by the manager if a prior handler vetoed the action.
   * Read-only from a handler's perspective.
   */
  vetoed?: boolean;
  /**
   * Human-readable side effects performed by prior handlers. Appended to
   * (not replaced) so handlers can accumulate an audit trail.
   */
  sideEffects?: string[];
}

/**
 * The return value of a hook handler. All fields are optional; returning
 * `void` (or `undefined`) is equivalent to returning `{}`.
 */
export interface HookResult {
  /**
   * If `true`, the action is skipped. For `tool:before` and `llm:before`,
   * this short-circuits emit() and signals the caller to skip the action.
   * For other events, veto is recorded but has no caller-side effect.
   */
  veto?: boolean;
  /**
   * Replace the tool input (for `tool:before`). Subsequent handlers see
   * the modified value.
   */
  modifiedInput?: unknown;
  /**
   * Replace the tool result (for `tool:after`). Subsequent handlers see
   * the modified value.
   */
  modifiedResult?: unknown;
  /** Replace the plan (for `plan:*` events). */
  modifiedPlan?: Plan;
  /** Replace the LLM request (for `llm:before`). */
  modifiedRequest?: LLMRequest;
  /** Replace the LLM response (for `llm:after`). */
  modifiedResponse?: LLMResponse;
  /**
   * Human-readable side effects performed by this handler. Appended to
   * `HookContext.sideEffects` for downstream handlers and audit logs.
   */
  sideEffects?: string[];
}

/**
 * A registered hook handler. Returned by {@link HookManager.list} and used
 * internally for dispatch.
 */
export interface HookRegistration {
  /** Stable unique id (used for unregistration). */
  id: string;
  /** The event this handler is registered for. */
  event: HookEvent;
  /** The handler itself. */
  handler: HookHandler;
  /** Lower = runs first (default 100). */
  priority: number;
  /** If `true`, the handler is removed after its first invocation. */
  once?: boolean;
}

/**
 * A hook handler function. May be async. Returns a {@link HookResult} to
 * modify the context or veto, or `void` to indicate no changes.
 */
export type HookHandler = (
  ctx: HookContext,
) => Promise<HookResult | void> | HookResult | void;

// ─── HookManager ────────────────────────────────────────────────────────────

/**
 * The central hook registry and dispatcher. One instance per agent run
 * (typically owned by the {@link AgentLoop} and shared with the
 * {@link ToolRegistry} and {@link Executor}).
 *
 * Handlers run in priority order (ascending). Each handler can mutate the
 * context for the next handler. If any handler returns `{ veto: true }`,
 * the emit short-circuits and the returned context has `vetoed: true`.
 *
 * @example
 * ```ts
 * const hooks = new HookManager();
 *
 * // Log every tool call.
 * hooks.on('tool:before', async (ctx) => {
 *   console.log(`[tool] ${ctx.toolName}`, ctx.toolInput);
 * });
 *
 * // Veto any bash command containing 'rm -rf /'.
 * hooks.on('tool:before', async (ctx) => {
 *   if (ctx.toolName === 'bash' && typeof ctx.toolInput === 'object' && ctx.toolInput) {
 *     const cmd = (ctx.toolInput as { command?: string }).command ?? '';
 *     if (/rm\s+-rf\s+\/(\s|$)/.test(cmd)) {
 *       return { veto: true, sideEffects: ['blocked destructive rm -rf /'] };
 *     }
 *   }
 * }, { priority: 10 }); // run before the default-priority logger
 *
 * // Modify an LLM request to inject a system message.
 * hooks.on('llm:before', async (ctx) => {
 *   if (!ctx.llmRequest) return;
 *   return {
 *     modifiedRequest: {
 *       ...ctx.llmRequest,
 *       messages: [
 *         { role: 'system', content: 'Safety policy: refuse harmful requests.' },
 *         ...ctx.llmRequest.messages,
 *       ],
 *     },
 *   };
 * });
 * ```
 */
export class HookManager {
  /** All registrations, keyed by id (for O(1) unregister). */
  private readonly registrations: Map<string, HookRegistration> = new Map();
  /** Per-event sorted handler list (lazily rebuilt when `dirty`). */
  private readonly index: Map<HookEvent, HookRegistration[]> = new Map();
  /** True when the sorted index needs rebuilding. */
  private dirty = false;

  /**
   * Register a handler. Returns the registration id (for unregistration).
   *
   * @param reg - The registration (id optional; auto-generated if absent).
   * @returns The registration id.
   */
  register(reg: Omit<HookRegistration, 'id'> & { id?: string }): string {
    const id = reg.id ?? nanoid();
    const full: HookRegistration = {
      id,
      event: reg.event,
      handler: reg.handler,
      priority: reg.priority,
      once: reg.once,
    };
    this.registrations.set(id, full);
    this.dirty = true;
    return id;
  }

  /**
   * Unregister a handler by id.
   *
   * @returns `true` if a registration was removed.
   */
  unregister(id: string): boolean {
    const removed = this.registrations.delete(id);
    if (removed) this.dirty = true;
    return removed;
  }

  /**
   * Convenience wrapper for {@link register} with the common shape.
   *
   * @param event - The event to listen for.
   * @param handler - The handler function.
   * @param opts - Optional `{ priority?, once? }`.
   * @returns The registration id.
   */
  on(
    event: HookEvent,
    handler: HookHandler,
    opts: { priority?: number; once?: boolean } = {},
  ): string {
    return this.register({
      event,
      handler,
      priority: opts.priority ?? 100,
      once: opts.once,
    });
  }

  /**
   * Emit an event. Runs all registered handlers for the event in priority
   * order. Each handler may modify the context (via its return value) for
   * the next handler. If any handler returns `{ veto: true }`, the emit
   * short-circuits and the returned context has `vetoed: true`.
   *
   * Handler errors are swallowed (and logged via `console.error`) so a
   * buggy hook can never crash the agent loop. If you need to surface hook
   * errors, register an `error` event handler that re-throws.
   *
   * @param event - The event to emit.
   * @param ctx - The initial context.
   * @returns The (possibly modified) context after all handlers have run.
   */
  async emit(event: HookEvent, ctx: HookContext): Promise<HookContext> {
    this.ensureIndex();
    const list = this.index.get(event) ?? [];
    if (list.length === 0) return { ...ctx };

    // Clone the context so handlers don't mutate the caller's object.
    let current: HookContext = {
      ...ctx,
      sideEffects: ctx.sideEffects ? [...ctx.sideEffects] : [],
    };
    let vetoed = false;

    for (const reg of list) {
      // `once` handlers are removed before invocation so re-entrant emits
      // (e.g. a handler that itself emits) don't double-fire.
      if (reg.once) {
        this.registrations.delete(reg.id);
        this.dirty = true;
      }

      let result: HookResult | void;
      try {
        result = await reg.handler(current);
      } catch (err) {
        // Log and continue — hooks must not crash the agent.
        // eslint-disable-next-line no-console
        console.error(`[HookManager] handler for '${event}' threw:`, err);
        continue;
      }

      if (!result) continue;

      // Apply modifications to the running context.
      if (result.modifiedInput !== undefined) current.toolInput = result.modifiedInput;
      if (result.modifiedResult !== undefined) current.toolResult = result.modifiedResult;
      if (result.modifiedPlan !== undefined) current.plan = result.modifiedPlan;
      if (result.modifiedRequest !== undefined) current.llmRequest = result.modifiedRequest;
      if (result.modifiedResponse !== undefined) current.llmResponse = result.modifiedResponse;
      if (result.sideEffects && result.sideEffects.length > 0) {
        current.sideEffects = [...(current.sideEffects ?? []), ...result.sideEffects];
      }

      if (result.veto) {
        vetoed = true;
        break;
      }
    }

    current.vetoed = vetoed;
    return current;
  }

  /**
   * Remove all registrations. Mainly useful in tests.
   */
  clear(): void {
    this.registrations.clear();
    this.index.clear();
    this.dirty = false;
  }

  /**
   * List all current registrations (sorted by priority within each event).
   * The returned array is a snapshot — mutating it does not affect the
   * manager.
   */
  list(): HookRegistration[] {
    this.ensureIndex();
    const out: HookRegistration[] = [];
    for (const list of this.index.values()) out.push(...list);
    return out;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Rebuild the per-event sorted index if dirty. O(n log n) where n is the
   * total number of registrations; only runs when registrations change.
   */
  private ensureIndex(): void {
    if (!this.dirty) return;
    this.index.clear();
    for (const reg of this.registrations.values()) {
      const list = this.index.get(reg.event) ?? [];
      list.push(reg);
      this.index.set(reg.event, list);
    }
    for (const list of this.index.values()) {
      list.sort((a, b) => a.priority - b.priority);
    }
    this.dirty = false;
  }
}

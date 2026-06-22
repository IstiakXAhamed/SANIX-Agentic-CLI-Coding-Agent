/**
 * @file AgentRegistry.ts
 * @description Central registry for specialized SANIX agents.
 *
 * Holds a `Map<id, SpecializedAgent>` and exposes:
 *   - {@link register} — add an agent.
 *   - {@link get} — fetch an agent by id.
 *   - {@link list} — return compact summaries for CLI/TUI display.
 *   - {@link listByCategory} — filter by {@link AgentCategory}.
 *   - {@link run} — invoke an agent by id with a goal + options.
 *
 * The registry is transport-light — it doesn't load providers or wire
 * tool registries itself. Callers register pre-built agent instances
 * (potentially constructed with a provider via {@link BaseAgent}
 * options) and the registry delegates `run()` calls straight through.
 *
 * @example
 * ```ts
 * import { AgentRegistry, SecuritySentinel, DocDoctor } from '@sanix/agents';
 *
 * const registry = new AgentRegistry();
 * registry.register(new SecuritySentinel());
 * registry.register(new DocDoctor());
 *
 * // List available agents for a CLI picker.
 * for (const summary of registry.list()) {
 *   console.log(`${summary.icon} ${summary.name} — ${summary.description}`);
 * }
 *
 * // Run one by id.
 * const result = await registry.run('security-sentinel', 'Audit this repo', { cwd: '/repo' });
 * ```
 *
 * @packageDocumentation
 */

import type {
  AgentCategory,
  AgentRunOptions,
  AgentRunResult,
  AgentSummary,
  SpecializedAgent,
} from './types.js';
import { SecuritySentinel } from './agents/SecuritySentinel.js';
import { MigrationMaestro } from './agents/MigrationMaestro.js';
import { TestArchitect } from './agents/TestArchitect.js';
import { PerfProfiler } from './agents/PerfProfiler.js';
import { DocDoctor } from './agents/DocDoctor.js';

/**
 * Options for {@link AgentRegistry.register}.
 */
export interface RegisterOptions {
  /**
   * When true (default), the registry throws if an agent with the same
   * id is already registered. When false, the new agent replaces the
   * old silently.
   */
  throwOnConflict?: boolean;
}

/**
 * Central registry of specialized SANIX agents.
 *
 * Holds the catalog and delegates `run()` calls. The registry is the
 * single entry point for any caller that wants to enumerate agents or
 * invoke them by id (CLI, TUI, MCP server, ...).
 *
 * @example
 * ```ts
 * const registry = new AgentRegistry();
 * registry.register(new SecuritySentinel());
 *
 * if (registry.has('security-sentinel')) {
 *   const result = await registry.run('security-sentinel', 'Scan src/auth', { cwd: '/repo' });
 *   console.log(result.findings.length, 'findings');
 * }
 * ```
 */
export class AgentRegistry {
  private readonly agents: Map<string, SpecializedAgent> = new Map();

  /**
   * Register an agent. Returns `this` for chaining.
   *
   * @param agent - The agent instance to register.
   * @param opts - Registration options.
   * @throws if `opts.throwOnConflict` is true (default) and an agent
   *         with the same id is already registered.
   */
  register(agent: SpecializedAgent, opts: RegisterOptions = {}): this {
    const throwOnConflict = opts.throwOnConflict ?? true;
    if (throwOnConflict && this.agents.has(agent.id)) {
      throw new Error(`Agent '${agent.id}' is already registered. Pass { throwOnConflict: false } to override.`);
    }
    this.agents.set(agent.id, agent);
    return this;
  }

  /**
   * Register every built-in specialized agent (Security Sentinel,
   * Migration Maestro, Test Architect, Perf Profiler, Doc Doctor).
   *
   * Convenience for callers that want "all of them" without enumerating
   * each class.
   *
   * @example
   * ```ts
   * const registry = new AgentRegistry().registerBuiltins();
   * console.log(registry.size); // 5
   * ```
   */
  registerBuiltins(): this {
    this.register(new SecuritySentinel(), { throwOnConflict: false });
    this.register(new MigrationMaestro(), { throwOnConflict: false });
    this.register(new TestArchitect(), { throwOnConflict: false });
    this.register(new PerfProfiler(), { throwOnConflict: false });
    this.register(new DocDoctor(), { throwOnConflict: false });
    return this;
  }

  /**
   * Unregister an agent by id. No-op if the agent is not registered.
   *
   * @returns true if an agent was removed.
   */
  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  /**
   * Look up an agent by id. Returns `null` if not registered.
   */
  get(id: string): SpecializedAgent | null {
    return this.agents.get(id) ?? null;
  }

  /**
   * Check whether an agent with `id` is registered.
   */
  has(id: string): boolean {
    return this.agents.has(id);
  }

  /**
   * List all registered agents as compact {@link AgentSummary} records
   * suitable for CLI/TUI display (no systemPrompt leak, no tool list
   * bloat).
   */
  list(): AgentSummary[] {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      name: a.name,
      category: a.category,
      icon: a.icon,
      description: a.description,
      exampleQueries: a.exampleQueries,
      toolCount: a.tools.length,
    }));
  }

  /**
   * List agents in a given category.
   *
   * @example
   * ```ts
   * const securityAgents = registry.listByCategory('security');
   * ```
   */
  listByCategory(category: AgentCategory): SpecializedAgent[] {
    return [...this.agents.values()].filter((a) => a.category === category);
  }

  /**
   * List the distinct categories that have at least one registered
   * agent. Useful for building a category browser in the TUI.
   */
  listCategories(): AgentCategory[] {
    const set = new Set<AgentCategory>();
    for (const a of this.agents.values()) set.add(a.category);
    return [...set];
  }

  /**
   * Run an agent by id with a goal + options. Delegates straight to
   * `agent.run(goal, opts)`.
   *
   * @throws if no agent with `id` is registered.
   */
  async run(id: string, goal: string, opts?: AgentRunOptions): Promise<AgentRunResult> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(
        `Agent '${id}' is not registered. Available: ${[...this.agents.keys()].join(', ')}`,
      );
    }
    return agent.run(goal, opts);
  }

  /**
   * Number of agents currently registered.
   */
  get size(): number {
    return this.agents.size;
  }

  /**
   * Remove every registered agent. Useful in tests.
   */
  clear(): void {
    this.agents.clear();
  }
}

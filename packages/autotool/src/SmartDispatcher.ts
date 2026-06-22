/**
 * @file SmartDispatcher.ts
 * @description Wraps a {@link ToolRegistry} with caching ({@link ToolCache}),
 * effectiveness tracking ({@link EffectivenessTracker}), and a "warm"
 * fast-path for tools whose recent invocations all succeeded. All
 * `invoke` calls flow through here so callers get transparent caching +
 * telemetry.
 *
 * @packageDocumentation
 */

import { EffectivenessTracker } from './EffectivenessTracker.js';
import { ToolCache } from './ToolCache.js';
import type { ToolRegistry, ToolResult } from './types.js';

/** Options for {@link SmartDispatcher}. */
export interface SmartDispatcherOptions {
  /** Cache options. Pass `false` to disable caching. */
  cache?: false | { maxSize?: number; defaultTtlMs?: number };
  /** Tracker options. */
  tracker?: ConstructorParameters<typeof EffectivenessTracker>[0];
  /** Whether to use the cache by default. Default true. */
  useCache?: boolean;
}

/**
 * A caching, tracking wrapper around a {@link ToolRegistry}.
 *
 * @example
 * ```ts
 * const d = new SmartDispatcher(registry);
 * await d.invoke('read_file', { path: '/etc/hosts' }); // runs + caches
 * await d.invoke('read_file', { path: '/etc/hosts' }); // cache hit
 * ```
 */
export class SmartDispatcher {
  private readonly registry: ToolRegistry;
  private readonly cache?: ToolCache;
  private readonly tracker: EffectivenessTracker;
  private readonly useCache: boolean;

  constructor(registry: ToolRegistry, opts: SmartDispatcherOptions = {}) {
    this.registry = registry;
    this.tracker = new EffectivenessTracker(opts.tracker ?? {});
    this.useCache = opts.useCache ?? true;
    if (this.useCache && opts.cache !== false) {
      this.cache = new ToolCache(opts.cache ?? {});
    }
  }

  /**
   * Invoke a tool, consulting the cache first and recording effectiveness
   * after.
   *
   * @param name Tool name.
   * @param args Tool arguments.
   * @param opts.bypassCache If true, skip the cache lookup (but still store).
   * @returns The {@link ToolResult}.
   */
  async invoke(
    name: string,
    args: Record<string, unknown>,
    opts: { bypassCache?: boolean } = {},
  ): Promise<ToolResult> {
    if (!opts.bypassCache && this.cache) {
      const cached = this.cache.get(name, args);
      if (cached) return cached;
    }
    const result = await this.registry.invoke(name, args);
    this.tracker.record(name, result);
    if (this.cache && result.ok) this.cache.set(name, args, result);
    return result;
  }

  /** Expose the underlying tracker for analysis. */
  getTracker(): EffectivenessTracker {
    return this.tracker;
  }

  /** Expose the underlying cache (if any) for invalidation. */
  getCache(): ToolCache | undefined {
    return this.cache;
  }

  /** The wrapped registry. */
  getRegistry(): ToolRegistry {
    return this.registry;
  }
}

/**
 * @file discovery/StaticDiscovery.ts
 * @description Discovery backend backed by a caller-supplied list of
 * node URLs. Performs a health check on each URL on every `discover()`
 * call; only healthy nodes are returned.
 *
 * @packageDocumentation
 */

import type { ClusterNode } from '../types.js';
import { type ServiceDiscovery, healthCheck, makeNode } from './types.js';

/**
 * Options for {@link StaticDiscovery.constructor}.
 */
export interface StaticDiscoveryOptions {
  /** Pre-configured node list. */
  nodes: Array<{ url: string; authToken?: string }>;
  /** Health-check timeout per node (default 2000ms). */
  healthCheckTimeoutMs?: number;
  /** Re-discovery interval (default 30000ms). */
  rediscoverIntervalMs?: number;
  /** Default capabilities to assign to discovered nodes. */
  capabilities?: string[];
  /** Default max concurrency. */
  maxConcurrency?: number;
}

/**
 * Static discovery — uses a fixed caller-supplied list of node URLs.
 *
 * @example
 * ```ts
 * const discovery = new StaticDiscovery({
 *   nodes: [
 *     { url: 'http://worker-1:7331' },
 *     { url: 'http://worker-2:7331' },
 *   ],
 * });
 * const nodes = await discovery.discover();
 * ```
 */
export class StaticDiscovery implements ServiceDiscovery {
  private readonly opts: StaticDiscoveryOptions;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: StaticDiscoveryOptions) {
    this.opts = opts;
  }

  async discover(): Promise<ClusterNode[]> {
    const results = await Promise.all(
      this.opts.nodes.map(async (entry) => {
        const ok = await healthCheck(entry.url, this.opts.healthCheckTimeoutMs ?? 2000);
        if (!ok) return null;
        return makeNode({
          id: deriveIdFromUrl(entry.url),
          url: entry.url,
          authToken: entry.authToken,
          capabilities: this.opts.capabilities,
          maxConcurrency: this.opts.maxConcurrency,
        });
      }),
    );
    return results.filter((n): n is ClusterNode => n !== null);
  }

  start(onDiscover: (nodes: ClusterNode[]) => void): void {
    if (this.timer) return;
    const interval = this.opts.rediscoverIntervalMs ?? 30000;
    void this.discover().then(onDiscover).catch(() => undefined);
    this.timer = setInterval(() => {
      void this.discover().then(onDiscover).catch(() => undefined);
    }, interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Derive a stable node id from a URL. Uses the hostname + port segment.
 *
 * @internal
 */
export function deriveIdFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '7331'}`;
  } catch {
    // Fall back to the raw string with non-alphanumeric chars stripped.
    return url.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 64);
  }
}

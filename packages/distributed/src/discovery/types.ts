/**
 * @file discovery/types.ts
 * @description Common interface implemented by every discovery backend.
 * Each backend resolves a {@link DiscoveryConfig} into a list of
 * {@link ClusterNode} candidates (after a health check).
 *
 * @packageDocumentation
 */

import type { ClusterNode } from '../types.js';

/**
 * The common interface implemented by every discovery backend.
 *
 * @example
 * ```ts
 * const discovery = createDiscovery({ type: 'static', nodes: [...] });
 * const nodes = await discovery.discover();
 * discovery.start((nodes) => registry.register(...));
 * discovery.stop();
 * ```
 */
export interface ServiceDiscovery {
  /**
   * Perform a one-shot discovery: resolve the configured source into a
   * list of nodes, health-check each, and return the survivors.
   *
   * @returns Healthy discovered nodes (may be empty).
   */
  discover(): Promise<ClusterNode[]>;

  /**
   * Start continuous background discovery. The callback is invoked on
   * every successful re-discovery cycle (default every 30s) with the
   * full new node set. The caller typically reconciles this against
   * its registry.
   *
   * @param onDiscover - Callback invoked with each fresh node list.
   */
  start(onDiscover: (nodes: ClusterNode[]) => void): void;

  /** Stop the background discovery loop. */
  stop(): void;
}

/**
 * Common HTTP health-check helper. Does a GET /health on the node URL
 * with a short timeout. Returns true on HTTP 200.
 *
 * @param url     - Base URL of the node (no trailing slash).
 * @param timeoutMs - Max wait (default 2000).
 */
export async function healthCheck(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a {@link ClusterNode} skeleton from minimal discovery data.
 * The caller is expected to fill in `id` (often derived from URL).
 *
 * @internal
 */
export function makeNode(opts: {
  id: string;
  url: string;
  authToken?: string;
  role?: ClusterNode['role'];
  capabilities?: string[];
  maxConcurrency?: number;
  metadata?: Record<string, unknown>;
}): ClusterNode {
  return {
    id: opts.id,
    url: opts.url,
    authToken: opts.authToken,
    role: opts.role ?? 'worker',
    status: 'online',
    capabilities: opts.capabilities ?? [],
    maxConcurrency: opts.maxConcurrency ?? 4,
    currentLoad: 0,
    lastHeartbeat: Date.now(),
    metadata: opts.metadata,
  };
}

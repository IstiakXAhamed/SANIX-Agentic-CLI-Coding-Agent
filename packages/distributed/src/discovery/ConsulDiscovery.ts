/**
 * @file discovery/ConsulDiscovery.ts
 * @description Discovery backend backed by the HashiCorp Consul HTTP API.
 * Queries `GET /v1/health/service/:name?passing=true` on every
 * re-discovery cycle, parses each healthy instance's `Service.Address`
 * (or `Node.Address` fallback) + `Service.Port`, and produces one node
 * per passing instance.
 *
 * @packageDocumentation
 */

import type { ClusterNode } from '../types.js';
import { type ServiceDiscovery, healthCheck, makeNode } from './types.js';
import { deriveIdFromUrl } from './StaticDiscovery.js';

/**
 * Options for {@link ConsulDiscovery.constructor}.
 */
export interface ConsulDiscoveryOptions {
  /** Base URL of the Consul agent (e.g. `http://consul:8500`). */
  address: string;
  /** The Consul service name to look up. */
  serviceName: string;
  /** Optional ACL token sent as `?token=` query param. */
  aclToken?: string;
  /** Auth token for all discovered SANIX nodes (optional). */
  nodeAuthToken?: string;
  /** Re-discovery interval (default 30000ms). */
  rediscoverIntervalMs?: number;
  /** Health-check timeout per node (default 2000ms). */
  healthCheckTimeoutMs?: number;
  /** Default capabilities to assign. */
  capabilities?: string[];
  /** Default max concurrency. */
  maxConcurrency?: number;
}

/**
 * Shape of a Consul `GET /v1/health/service/:name` entry (only the
 * fields we read). See https://developer.hashicorp.com/consul/api-docs/health#list-nodes-for-service.
 */
interface ConsulServiceEntry {
  Node?: { Address?: string; Node?: string };
  Service?: { Address?: string; Port?: number; Tags?: string[] };
  Checks?: Array<{ Status?: string }>;
}

/**
 * Consul-based discovery.
 *
 * @example
 * ```ts
 * const discovery = new ConsulDiscovery({
 *   address: 'http://consul:8500',
 *   serviceName: 'sanix-worker',
 * });
 * const nodes = await discovery.discover();
 * ```
 */
export class ConsulDiscovery implements ServiceDiscovery {
  private readonly opts: ConsulDiscoveryOptions;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ConsulDiscoveryOptions) {
    this.opts = opts;
  }

  async discover(): Promise<ClusterNode[]> {
    const base = this.opts.address.replace(/\/$/, '');
    const url = new URL(`/v1/health/service/${encodeURIComponent(this.opts.serviceName)}`, base);
    url.searchParams.set('passing', 'true');
    if (this.opts.aclToken) url.searchParams.set('token', this.opts.aclToken);

    let entries: ConsulServiceEntry[];
    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) return [];
      entries = raw as ConsulServiceEntry[];
    } catch {
      return [];
    }

    const candidates = entries
      .map((e): { url: string; tags?: string[] } | null => {
        const svcAddr = e.Service?.Address;
        const nodeAddr = e.Node?.Address;
        const host = svcAddr && svcAddr.length > 0 ? svcAddr : nodeAddr;
        const port = e.Service?.Port ?? 7331;
        if (!host) return null;
        return { url: `http://${host}:${port}`, tags: e.Service?.Tags };
      })
      .filter((c): c is { url: string; tags?: string[] } => c !== null);

    const results = await Promise.all(
      candidates.map(async (c) => {
        const ok = await healthCheck(c.url, this.opts.healthCheckTimeoutMs ?? 2000);
        if (!ok) return null;
        return makeNode({
          id: deriveIdFromUrl(c.url),
          url: c.url,
          authToken: this.opts.nodeAuthToken,
          capabilities: this.opts.capabilities ?? consulTagsToCapabilities(c.tags),
          maxConcurrency: this.opts.maxConcurrency,
          metadata: { source: 'consul', serviceName: this.opts.serviceName, tags: c.tags ?? [] },
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
 * Convert Consul service tags to SANIX capability tags. Tags already
 * prefixed with `cap:` are passed through verbatim; others are ignored.
 *
 * @internal
 */
function consulTagsToCapabilities(tags?: string[]): string[] {
  if (!tags) return [];
  return tags.filter((t) => t.startsWith('cap:')).map((t) => t.slice(4));
}

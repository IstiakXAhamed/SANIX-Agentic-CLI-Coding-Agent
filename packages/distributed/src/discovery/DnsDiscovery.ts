/**
 * @file discovery/DnsDiscovery.ts
 * @description Discovery backend backed by DNS A-record resolution.
 * Resolves a hostname to multiple IPv4 addresses via `dns.resolve4()`;
 * each address becomes a node bound to the configured port.
 *
 * Falls back to `dns.lookup()` (single A record) if `resolve4` rejects
 * (e.g. for `localhost`).
 *
 * @packageDocumentation
 */

import { resolve4, lookup } from 'node:dns/promises';
import type { ClusterNode } from '../types.js';
import { type ServiceDiscovery, healthCheck, makeNode } from './types.js';

/**
 * Options for {@link DnsDiscovery.constructor}.
 */
export interface DnsDiscoveryOptions {
  /** Hostname to resolve (e.g. `workers.sanix.local`). */
  hostname: string;
  /** Port each resolved IP listens on. */
  port: number;
  /** Auth token for all discovered nodes (optional). */
  authToken?: string;
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
 * DNS-based discovery — one node per resolved A record.
 *
 * @example
 * ```ts
 * const discovery = new DnsDiscovery({
 *   hostname: 'workers.sanix.local',
 *   port: 7331,
 * });
 * const nodes = await discovery.discover();
 * ```
 */
export class DnsDiscovery implements ServiceDiscovery {
  private readonly opts: DnsDiscoveryOptions;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DnsDiscoveryOptions) {
    this.opts = opts;
  }

  async discover(): Promise<ClusterNode[]> {
    let ips: string[];
    try {
      const records = await resolve4(this.opts.hostname);
      ips = records;
    } catch {
      // Fall back to lookup (handles /etc/hosts + single A records).
      try {
        const result = await lookup(this.opts.hostname, { family: 4 });
        ips = [result.address];
      } catch {
        return [];
      }
    }

    const candidates = ips.map((ip) => ({
      id: `${ip}:${this.opts.port}`,
      url: `http://${ip}:${this.opts.port}`,
    }));

    const results = await Promise.all(
      candidates.map(async (c) => {
        const ok = await healthCheck(c.url, this.opts.healthCheckTimeoutMs ?? 2000);
        if (!ok) return null;
        return makeNode({
          id: c.id,
          url: c.url,
          authToken: this.opts.authToken,
          capabilities: this.opts.capabilities,
          maxConcurrency: this.opts.maxConcurrency,
          metadata: { hostname: this.opts.hostname, ip: c.id.split(':')[0] },
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

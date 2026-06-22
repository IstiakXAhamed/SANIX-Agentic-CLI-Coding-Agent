/**
 * @file discovery/EtcdDiscovery.ts
 * @description Discovery backend backed by the etcd v3 KV API.
 * Queries `POST /v3/kv/range` with a base64-encoded key prefix; each
 * key under the prefix is treated as a node registration whose value
 * is a JSON object `{ url, authToken?, capabilities?, maxConcurrency? }`.
 *
 * @packageDocumentation
 */

import type { ClusterNode } from '../types.js';
import { type ServiceDiscovery, healthCheck, makeNode } from './types.js';
import { deriveIdFromUrl } from './StaticDiscovery.js';

/**
 * Options for {@link EtcdDiscovery.constructor}.
 */
export interface EtcdDiscoveryOptions {
  /** One or more etcd endpoints (e.g. `['http://etcd:2379']`). */
  endpoints: string[];
  /** Key prefix that all node registrations live under (e.g. `/sanix/nodes/`). */
  prefix: string;
  /** Auth token for all discovered SANIX nodes (optional). */
  nodeAuthToken?: string;
  /** Re-discovery interval (default 30000ms). */
  rediscoverIntervalMs?: number;
  /** Health-check timeout per node (default 2000ms). */
  healthCheckTimeoutMs?: number;
}

/**
 * Shape of the etcd v3 KV range response. See
 * https://etcd.io/docs/v3.5/dev-guide/api_grpc_gateway/#range.
 */
interface EtcdRangeResponse {
  kvs?: Array<{ key: string; value: string }>;
  count?: string | number;
}

/**
 * Expected shape of an etcd node-registration value.
 */
interface EtcdNodeValue {
  url: string;
  authToken?: string;
  capabilities?: string[];
  maxConcurrency?: number;
  role?: ClusterNode['role'];
  metadata?: Record<string, unknown>;
}

/**
 * etcd-based discovery.
 *
 * @example
 * ```ts
 * const discovery = new EtcdDiscovery({
 *   endpoints: ['http://etcd:2379'],
 *   prefix: '/sanix/nodes/',
 * });
 * const nodes = await discovery.discover();
 * ```
 */
export class EtcdDiscovery implements ServiceDiscovery {
  private readonly opts: EtcdDiscoveryOptions;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: EtcdDiscoveryOptions) {
    this.opts = opts;
  }

  async discover(): Promise<ClusterNode[]> {
    const rangeEnd = prefixRangeEnd(this.opts.prefix);
    const body = {
      key: btoa(this.opts.prefix),
      range_end: btoa(rangeEnd),
    };

    let entries: EtcdNodeValue[];
    try {
      // Try each endpoint until one succeeds.
      let resp: Response | null = null;
      for (const ep of this.opts.endpoints) {
        const base = ep.replace(/\/$/, '');
        try {
          resp = await fetch(`${base}/v3/kv/range`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
          });
          if (resp.ok) break;
        } catch {
          // try next endpoint
        }
      }
      if (!resp || !resp.ok) return [];
      const raw = (await resp.json()) as unknown;
      entries = parseRangeResponse(raw);
    } catch {
      return [];
    }

    const results = await Promise.all(
      entries.map(async (e) => {
        const ok = await healthCheck(e.url, this.opts.healthCheckTimeoutMs ?? 2000);
        if (!ok) return null;
        return makeNode({
          id: deriveIdFromUrl(e.url),
          url: e.url,
          authToken: e.authToken ?? this.opts.nodeAuthToken,
          role: e.role,
          capabilities: e.capabilities,
          maxConcurrency: e.maxConcurrency,
          metadata: { source: 'etcd', ...e.metadata },
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
 * Compute the etcd "range end" key for a prefix — the prefix with its
 * last byte incremented, so the range covers exactly `prefix*`. If the
 * prefix is empty or the last byte is 0xff, returns `'\0'` (full range).
 *
 * @internal
 */
function prefixRangeEnd(prefix: string): string {
  if (prefix.length === 0) return '\0';
  const bytes = Array.from(prefix, (c) => c.charCodeAt(0));
  const i = bytes.length - 1;
  if (bytes[i] === 0xff) {
    // Drop the trailing 0xff and recurse — handles 0xff...ff prefixes.
    return prefixRangeEnd(prefix.slice(0, i));
  }
  bytes[i] += 1;
  return String.fromCharCode(...bytes);
}

/**
 * Parse an etcd v3 KV range response into a list of node values.
 * Each KV's key is base64-encoded; we use the value (also base64) as
 * a JSON object describing the node.
 *
 * @internal
 */
function parseRangeResponse(raw: unknown): EtcdNodeValue[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const resp = raw as EtcdRangeResponse;
  if (!Array.isArray(resp.kvs)) return [];
  const out: EtcdNodeValue[] = [];
  for (const kv of resp.kvs) {
    if (typeof kv.value !== 'string') continue;
    try {
      const decoded = atob(kv.value);
      const parsed = JSON.parse(decoded) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const v = parsed as Record<string, unknown>;
      if (typeof v.url !== 'string') continue;
      out.push({
        url: v.url,
        authToken: typeof v.authToken === 'string' ? v.authToken : undefined,
        capabilities: Array.isArray(v.capabilities)
          ? v.capabilities.filter((s): s is string => typeof s === 'string')
          : undefined,
        maxConcurrency: typeof v.maxConcurrency === 'number' ? v.maxConcurrency : undefined,
        role: v.role === 'coordinator' || v.role === 'worker' || v.role === 'peer' ? v.role : undefined,
        metadata: typeof v.metadata === 'object' && v.metadata !== null
          ? (v.metadata as Record<string, unknown>)
          : undefined,
      });
    } catch {
      // skip unparseable values
    }
  }
  return out;
}

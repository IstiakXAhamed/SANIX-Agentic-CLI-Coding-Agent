/**
 * @file discovery/K8sDiscovery.ts
 * @description Discovery backend backed by the Kubernetes Endpoints API.
 * Queries `GET /api/v1/namespaces/:ns/endpoints/:svc` for the live set
 * of pod IPs backing a Kubernetes Service.
 *
 * Auth strategy (in order):
 *   1. `KUBERNETES_SERVICE_ACCOUNT_TOKEN` env var (explicit override).
 *   2. Service-account token mounted at
 *      `/var/run/secrets/kubernetes.io/serviceaccount/token`.
 *   3. None — request is anonymous (only works against permissive RBAC).
 *
 * If both attempts fail (e.g. running outside a cluster with no token
 * available), the discoverer falls back to reading `KUBERNETES_SERVICE_HOST`
 * + the configured service port — useful for in-cluster sidecar patterns
 * where the SANIX process can't reach the API server but knows its own
 * cluster IP.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import type { ClusterNode } from '../types.js';
import { type ServiceDiscovery, healthCheck, makeNode } from './types.js';
import { deriveIdFromUrl } from './StaticDiscovery.js';

/**
 * Options for {@link K8sDiscovery.constructor}.
 */
export interface K8sDiscoveryOptions {
  /** Kubernetes namespace (e.g. `default`, `sanix`). */
  namespace: string;
  /** Kubernetes Service name whose Endpoints we watch. */
  serviceName: string;
  /** Port each backing pod listens on (default 7331). */
  port?: number;
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
 * Truncated shape of the Kubernetes Endpoints API response (only the
 * fields we read). See https://kubernetes.io/docs/reference/kubernetes-api/service-resources/endpoints-v1/#Endpoints.
 */
interface K8sEndpoints {
  subsets?: Array<{
    addresses?: Array<{ ip: string; hostname?: string }>;
    notReadyAddresses?: Array<{ ip: string; hostname?: string }>;
    ports?: Array<{ port: number; name?: string }>;
  }>;
}

/**
 * Kubernetes-based discovery.
 *
 * @example
 * ```ts
 * const discovery = new K8sDiscovery({
 *   namespace: 'sanix',
 *   serviceName: 'sanix-worker',
 * });
 * const nodes = await discovery.discover();
 * ```
 */
export class K8sDiscovery implements ServiceDiscovery {
  private readonly opts: K8sDiscoveryOptions;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: K8sDiscoveryOptions) {
    this.opts = opts;
  }

  async discover(): Promise<ClusterNode[]> {
    const port = this.opts.port ?? 7331;
    const addresses = await this.fetchEndpointAddresses();
    if (addresses.length === 0) {
      // Fallback: read in-cluster env vars (single node).
      return this.fallbackFromEnv(port);
    }
    const candidates = addresses.map((a) => ({
      id: `${a.ip}:${port}`,
      url: `http://${a.ip}:${port}`,
      hostname: a.hostname,
    }));
    const results = await Promise.all(
      candidates.map(async (c) => {
        const ok = await healthCheck(c.url, this.opts.healthCheckTimeoutMs ?? 2000);
        if (!ok) return null;
        return makeNode({
          id: c.id,
          url: c.url,
          authToken: this.opts.nodeAuthToken,
          capabilities: this.opts.capabilities,
          maxConcurrency: this.opts.maxConcurrency,
          metadata: {
            source: 'k8s',
            namespace: this.opts.namespace,
            serviceName: this.opts.serviceName,
            hostname: c.hostname,
          },
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

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Query the Kubernetes API for the Endpoints object backing
   * `serviceName` in `namespace`. Returns the list of ready + not-ready
   * addresses (we health-check both — not-ready pods may still serve
   * /health).
   */
  private async fetchEndpointAddresses(): Promise<Array<{ ip: string; hostname?: string }>> {
    const apiBase = process.env.KUBERNETES_API_BASE ?? 'https://kubernetes.default.svc';
    const url = `${apiBase}/api/v1/namespaces/${encodeURIComponent(this.opts.namespace)}/endpoints/${encodeURIComponent(this.opts.serviceName)}`;
    const token = this.readServiceAccountToken();

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const raw = (await res.json()) as unknown;
      if (typeof raw !== 'object' || raw === null) return [];
      const ep = raw as K8sEndpoints;
      const out: Array<{ ip: string; hostname?: string }> = [];
      for (const subset of ep.subsets ?? []) {
        const subsetPort = subset.ports?.[0]?.port ?? this.opts.port ?? 7331;
        void subsetPort; // already used as default at caller; tracked for clarity.
        for (const a of subset.addresses ?? []) out.push({ ip: a.ip, hostname: a.hostname });
        for (const a of subset.notReadyAddresses ?? []) out.push({ ip: a.ip, hostname: a.hostname });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Read the in-cluster service-account token (if available). Returns
   * the explicit `KUBERNETES_SERVICE_ACCOUNT_TOKEN` env var first, then
   * tries the well-known mount path.
   */
  private readServiceAccountToken(): string | null {
    const envToken = process.env.KUBERNETES_SERVICE_ACCOUNT_TOKEN;
    if (envToken && envToken.length > 0) return envToken;
    try {
      return readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf-8').trim();
    } catch {
      return null;
    }
  }

  /**
   * Fallback when no API token / API server is reachable: assume we're
   * running in-cluster alongside the SANIX workers and use
   * `KUBERNETES_SERVICE_HOST` as a single-node endpoint. Useful for
   * single-replica dev setups.
   */
  private async fallbackFromEnv(port: number): Promise<ClusterNode[]> {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    if (!host) return [];
    const url = `http://${host}:${port}`;
    const ok = await healthCheck(url, this.opts.healthCheckTimeoutMs ?? 2000);
    if (!ok) return [];
    return [
      makeNode({
        id: deriveIdFromUrl(url),
        url,
        authToken: this.opts.nodeAuthToken,
        capabilities: this.opts.capabilities,
        maxConcurrency: this.opts.maxConcurrency,
        metadata: { source: 'k8s-env-fallback' },
      }),
    ];
  }
}

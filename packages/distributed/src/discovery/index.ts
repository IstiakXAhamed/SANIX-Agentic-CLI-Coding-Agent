/**
 * @file discovery/index.ts
 * @description Barrel + factory for service-discovery backends.
 * Use `createDiscovery(config)` to get a backend for any
 * {@link DiscoveryConfig} variant.
 *
 * @packageDocumentation
 */

import type { DiscoveryConfig } from '../types.js';
import { type ServiceDiscovery } from './types.js';
import { StaticDiscovery } from './StaticDiscovery.js';
import { DnsDiscovery } from './DnsDiscovery.js';
import { ConsulDiscovery } from './ConsulDiscovery.js';
import { K8sDiscovery } from './K8sDiscovery.js';
import { EtcdDiscovery } from './EtcdDiscovery.js';

export type { ServiceDiscovery } from './types.js';
export { healthCheck, makeNode } from './types.js';
export { StaticDiscovery, type StaticDiscoveryOptions, deriveIdFromUrl } from './StaticDiscovery.js';
export { DnsDiscovery, type DnsDiscoveryOptions } from './DnsDiscovery.js';
export { ConsulDiscovery, type ConsulDiscoveryOptions } from './ConsulDiscovery.js';
export { K8sDiscovery, type K8sDiscoveryOptions } from './K8sDiscovery.js';
export { EtcdDiscovery, type EtcdDiscoveryOptions } from './EtcdDiscovery.js';

/**
 * Factory: instantiate the right {@link ServiceDiscovery} backend for
 * the given {@link DiscoveryConfig}.
 *
 * @example
 * ```ts
 * const discovery = createDiscovery({ type: 'dns', hostname: 'workers.local', port: 7331 });
 * const nodes = await discovery.discover();
 * ```
 *
 * @param config - Discovery configuration (discriminated by `type`).
 * @returns A new {@link ServiceDiscovery} instance.
 * @throws  Error for unknown `type` values.
 */
export function createDiscovery(config: DiscoveryConfig): ServiceDiscovery {
  switch (config.type) {
    case 'static':
      return new StaticDiscovery({ nodes: config.nodes });
    case 'dns':
      return new DnsDiscovery({ hostname: config.hostname, port: config.port });
    case 'consul':
      return new ConsulDiscovery({ address: config.address, serviceName: config.serviceName });
    case 'k8s':
      return new K8sDiscovery({ namespace: config.namespace, serviceName: config.serviceName });
    case 'etcd':
      return new EtcdDiscovery({ endpoints: config.endpoints, prefix: config.prefix });
    default: {
      // Exhaustiveness check — if a new type is added without a case,
      // this becomes a compile error.
      const _exhaustive: never = config;
      void _exhaustive;
      throw new Error(`Unknown discovery type: ${(config as { type: string }).type}`);
    }
  }
}

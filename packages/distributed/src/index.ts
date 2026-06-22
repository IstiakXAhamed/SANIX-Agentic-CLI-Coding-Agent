/**
 * @file index.ts
 * @description Public entry point for `@sanix/distributed`. Re-exports
 * the full surface of SANIX's distributed mode:
 *
 *   - **types**             — `ClusterNode`, `ClusterConfig`,
 *     `DiscoveryConfig`, `DistributedTask`, `ClusterStats`,
 *     `HeartbeatPayload`, `RegisterPayload`, `TaskAssignment`,
 *     `TaskResultReport`, and the various event interfaces.
 *   - **NodeRegistry**      — in-memory node registry with auto-sweep.
 *   - **discovery**         — 5 backends (static/DNS/Consul/K8s/etcd)
 *     + `createDiscovery` factory.
 *   - **TaskDispatcher**    — 4 load-balancing strategies + retries.
 *   - **ClusterCoordinator** — top-level orchestrator (runs on the
 *     coordinator node).
 *   - **WorkerNode**        — worker-side runner (registers with the
 *     coordinator, heartbeats, executes assignments).
 *   - **ClusterRoutes**     — `registerClusterRoutes` +
 *     `attachWorkerHandler` for wiring cluster REST endpoints into a
 *     `SanixServer`.
 *   - **DistributedSubAgentManager** — drop-in replacement for
 *     `@sanix/core`'s `SubAgentManager`.
 *   - **DistributedTeam**   — drop-in replacement for
 *     `@sanix/multiagent`'s `AgentTeam`.
 *
 * Import paths:
 *   import { ClusterCoordinator, WorkerNode, registerClusterRoutes } from '@sanix/distributed';
 *   import { createDiscovery, StaticDiscovery } from '@sanix/distributed/discovery';
 *
 * @packageDocumentation
 */

// ── Types ────────────────────────────────────────────────────────────────
export type {
  ClusterNode,
  ClusterConfig,
  ClusterRole,
  NodeStatus,
  LoadBalancer,
  RetryPolicy,
  DiscoveryConfig,
  DistributedTask,
  DistributedTaskType,
  DistributedTaskStatus,
  DistributedTaskInput,
  ClusterStats,
  HeartbeatPayload,
  RegisterPayload,
  TaskAssignment,
  TaskResultReport,
  NodeRegistryEvents,
  ClusterCoordinatorEvents,
  WorkerNodeEvents,
} from './types.js';

// ── Node Registry ─────────────────────────────────────────────────────────
export { NodeRegistry } from './NodeRegistry.js';

// ── Task Dispatcher ───────────────────────────────────────────────────────
export { TaskDispatcher } from './TaskDispatcher.js';

// ── Cluster Coordinator ───────────────────────────────────────────────────
export { ClusterCoordinator } from './ClusterCoordinator.js';

// ── Worker Node ───────────────────────────────────────────────────────────
export { WorkerNode, type WorkerNodeOptions, type TaskExecutor } from './WorkerNode.js';

// ── Cluster Routes ────────────────────────────────────────────────────────
export {
  registerClusterRoutes,
  attachWorkerHandler,
} from './ClusterRoutes.js';

// ── Distributed Sub-Agent Manager ─────────────────────────────────────────
export {
  DistributedSubAgentManager,
  type DistributedSubAgentManagerOptions,
} from './DistributedSubAgentManager.js';

// ── Distributed Team ──────────────────────────────────────────────────────
export { DistributedTeam, type DistributedTeamOptions } from './DistributedTeam.js';

// ── Discovery (re-exported here for one-import ergonomics) ────────────────
export {
  createDiscovery,
  type ServiceDiscovery,
  healthCheck,
  StaticDiscovery,
  DnsDiscovery,
  ConsulDiscovery,
  K8sDiscovery,
  EtcdDiscovery,
} from './discovery/index.js';

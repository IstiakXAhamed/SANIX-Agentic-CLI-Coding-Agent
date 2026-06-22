/**
 * @file types.ts
 * @description Shared types for `@sanix/distributed`. Defines the cluster
 * node model, cluster configuration, discovery config union, distributed
 * task lifecycle, and cluster-wide statistics. Every other module in this
 * package imports from here.
 *
 * @packageDocumentation
 */

/**
 * The functional role a node plays in the cluster.
 *
 * - `coordinator` — receives task submissions, dispatches to workers,
 *   tracks cluster stats. Exactly one per cluster (active).
 * - `worker`      — registers with the coordinator, accepts task
 *   assignments, executes them locally, reports results back.
 * - `peer`        — symmetric role: any node can submit or execute.
 *   Used in mesh topologies without a dedicated coordinator.
 */
export type ClusterRole = 'coordinator' | 'worker' | 'peer';

/**
 * Current reachability / availability state of a node.
 *
 * - `online`   — recently heartbeated; accepts new tasks.
 * - `offline`  — missed ≥3 heartbeats (or explicitly marked); tasks
 *   routed elsewhere; may auto-recover on next heartbeat.
 * - `draining` — coordinator-initiated graceful shutdown: no new tasks
 *   assigned, but in-flight tasks are allowed to complete.
 */
export type NodeStatus = 'online' | 'offline' | 'draining';

/**
 * A single node in the cluster. Each entry corresponds to a running
 * SANIX server instance reachable via its REST API.
 *
 * @example
 * ```ts
 * const node: ClusterNode = {
 *   id: 'worker-1',
 *   url: 'http://10.0.0.21:7331',
 *   authToken: 'secret',
 *   role: 'worker',
 *   status: 'online',
 *   capabilities: ['llm:anthropic', 'sandbox:docker'],
 *   maxConcurrency: 8,
 *   currentLoad: 0.25,
 *   lastHeartbeat: Date.now(),
 * };
 * ```
 */
export interface ClusterNode {
  /** Stable unique id (typically the worker's self-reported id). */
  id: string;
  /** Base URL of the node's REST API, e.g. `http://worker-1.local:7331`. */
  url: string;
  /** Optional bearer token for authenticating to this node's REST API. */
  authToken?: string;
  /** The node's role in the cluster. */
  role: ClusterRole;
  /** Current availability state. */
  status: NodeStatus;
  /**
   * Capability tags advertising what this node can do. Used by the
   * `capability` load-balancer to filter candidates. Examples:
   * `llm:anthropic`, `llm:openai`, `sandbox:docker`, `rag:store`,
   * `tools:filesystem`, `tools:browser`.
   */
  capabilities: string[];
  /** Maximum concurrent in-flight tasks this node will accept. */
  maxConcurrency: number;
  /** Current load 0..1 (in-flight / maxConcurrency). */
  currentLoad: number;
  /** Epoch ms of the most recent heartbeat received from this node. */
  lastHeartbeat: number;
  /** Free-form metadata (region, instance type, version, ...). */
  metadata?: Record<string, unknown>;
}

/**
 * Strategy the {@link TaskDispatcher} uses to pick a node for a task.
 *
 * - `least_load`   — pick the online node with the lowest `currentLoad`.
 * - `round_robin`  — rotate through online nodes (stateful counter).
 * - `capability`   — filter by required capabilities (from task payload),
 *                    then `least_load` among matches.
 * - `random`       — pick a random online node (good for testing).
 */
export type LoadBalancer = 'least_load' | 'round_robin' | 'capability' | 'random';

/**
 * Retry policy for failed task dispatches.
 */
export interface RetryPolicy {
  /** Maximum number of retries per task (default 3). */
  maxRetries: number;
  /** Base backoff in ms (doubles each retry; default 500). */
  backoffMs: number;
}

/**
 * Top-level cluster configuration.
 *
 * @example
 * ```ts
 * const config: ClusterConfig = {
 *   nodeId: 'coordinator-1',
 *   role: 'coordinator',
 *   discovery: { type: 'static', nodes: [{ url: 'http://worker-1:7331' }] },
 *   heartbeatIntervalMs: 5000,
 *   heartbeatTimeoutMs: 15000,
 *   loadBalancer: 'least_load',
 *   retryPolicy: { maxRetries: 3, backoffMs: 500 },
 * };
 * ```
 */
export interface ClusterConfig {
  /** This node's ID (used in heartbeats + log correlation). */
  nodeId: string;
  /** This node's role. */
  role: ClusterRole;
  /** Service discovery configuration. */
  discovery: DiscoveryConfig;
  /** Heartbeat send/receive interval in ms (default 5000). */
  heartbeatIntervalMs: number;
  /** Heartbeat timeout in ms — nodes silent for this long go offline (default 15000). */
  heartbeatTimeoutMs: number;
  /** Load-balancing strategy for the dispatcher. */
  loadBalancer: LoadBalancer;
  /** Per-task retry policy. */
  retryPolicy: RetryPolicy;
  /**
   * Hard timeout per task attempt in ms (default 300000 = 5 min).
   * If a task doesn't complete in this window it's marked `timeout`
   * and retried on another node.
   */
  taskTimeoutMs?: number;
  /**
   * Max concurrency for in-flight dispatches from this coordinator
   * (default 32). Use to bound local resource use.
   */
  maxDispatchConcurrency?: number;
}

/**
 * Service discovery configuration. Discriminated union by `type`.
 *
 * - `static` — caller-supplied list of node URLs.
 * - `dns`    — resolve a hostname to multiple A records; one node per IP.
 * - `consul` — query Consul HTTP API for healthy service instances.
 * - `k8s`    — query Kubernetes Endpoints API (or fall back to env vars).
 * - `etcd`   — query etcd v3 KV range with a key prefix.
 */
export type DiscoveryConfig =
  | { type: 'static'; nodes: Array<{ url: string; authToken?: string }> }
  | { type: 'dns'; hostname: string; port: number }
  | { type: 'consul'; address: string; serviceName: string }
  | { type: 'k8s'; namespace: string; serviceName: string }
  | { type: 'etcd'; endpoints: string[]; prefix: string };

/**
 * The type of work a distributed task represents. Maps to a specific
 * REST endpoint on the assigned worker node.
 *
 * - `llm_chat`         → `POST /v1/chat`
 * - `tool_execute`     → `POST /v1/tools/:name/execute`
 * - `agent_run`        → `POST /v1/run` then poll `GET /v1/runs/:id`
 * - `rag_query`        → `POST /v1/rag/query`
 * - `sandbox_execute`  → `POST /v1/sandbox/execute`
 */
export type DistributedTaskType =
  | 'llm_chat'
  | 'tool_execute'
  | 'agent_run'
  | 'rag_query'
  | 'sandbox_execute';

/**
 * Lifecycle status of a distributed task.
 */
export type DistributedTaskStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'complete'
  | 'failed'
  | 'timeout';

/**
 * A unit of work submitted to the cluster.
 *
 * @example
 * ```ts
 * const task: DistributedTask = {
 *   id: 'task-abc',
 *   type: 'llm_chat',
 *   payload: { messages: [{ role: 'user', content: 'Hello' }] },
 *   status: 'pending',
 *   createdAt: Date.now(),
 *   retries: 0,
 * };
 * ```
 */
export interface DistributedTask {
  /** Unique task id (nanoid). */
  id: string;
  /** The kind of work. Determines which REST endpoint the dispatcher hits. */
  type: DistributedTaskType;
  /** Type-specific payload (see {@link DistributedTaskType}). */
  payload: unknown;
  /** The node id this task is currently assigned to (if any). */
  assignedNodeId?: string;
  /** Current lifecycle status. */
  status: DistributedTaskStatus;
  /** The task result (set on success). */
  result?: unknown;
  /** Error message (set on failure / timeout). */
  error?: string;
  /** Epoch ms when the task was created. */
  createdAt: number;
  /** Epoch ms when the task was assigned to a node. */
  assignedAt?: number;
  /** Epoch ms when the task reached a terminal state. */
  completedAt?: number;
  /** Number of retries so far. */
  retries: number;
  /**
   * Optional capability requirements (used by the `capability`
   * load-balancer). Inferred from {@link type} when not supplied.
   */
  requiredCapabilities?: string[];
}

/**
 * Input to {@link ClusterCoordinator.submitTask} — the caller supplies
 * everything except the auto-generated fields.
 */
export type DistributedTaskInput = Omit<
  DistributedTask,
  'id' | 'status' | 'createdAt' | 'retries'
>;

/**
 * Cluster-wide statistics, aggregated by the coordinator.
 */
export interface ClusterStats {
  /** Total known nodes (any status). */
  nodeCount: number;
  /** Nodes currently `online`. */
  onlineNodes: number;
  /** Lifetime count of tasks that reached `complete`. */
  totalTasksCompleted: number;
  /** Lifetime count of tasks that reached `failed` or `timeout`. */
  totalTasksFailed: number;
  /** Average end-to-end task latency in ms (rolling). */
  avgLatencyMs: number;
  /** Total estimated USD cost across all completed tasks. */
  totalCostUsd: number;
  /** Per-node breakdown. */
  byNode: Record<
    string,
    {
      tasksCompleted: number;
      tasksFailed: number;
      avgLoad: number;
      costUsd: number;
    }
  >;
}

/**
 * Heartbeat payload sent by workers to the coordinator.
 */
export interface HeartbeatPayload {
  /** The worker's self-reported node id. */
  nodeId: string;
  /** Current load 0..1 (in-flight / maxConcurrency). */
  load: number;
  /** Capability tags (may grow over time). */
  capabilities: string[];
  /** Max concurrency the worker will accept. */
  maxConcurrency: number;
  /** Optional metadata update. */
  metadata?: Record<string, unknown>;
}

/**
 * Registration payload sent by workers when they first join the cluster.
 */
export interface RegisterPayload {
  /** Worker self-reported id. */
  nodeId: string;
  /** Worker's reachable URL (so the coordinator can call back). */
  url: string;
  /** Worker's role (typically `'worker'`). */
  role: ClusterRole;
  /** Initial capability tags. */
  capabilities: string[];
  /** Max concurrency. */
  maxConcurrency: number;
  /** Optional auth token the coordinator should use for callbacks. */
  authToken?: string;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Task assignment pushed from coordinator to worker.
 */
export interface TaskAssignment {
  /** The task id. */
  taskId: string;
  /** The task type. */
  type: DistributedTaskType;
  /** The task payload. */
  payload: unknown;
  /** Required capabilities (informational). */
  requiredCapabilities?: string[];
  /** Hard deadline (epoch ms) — worker should abort the task after this. */
  deadline: number;
}

/**
 * Result report pushed from worker to coordinator.
 */
export interface TaskResultReport {
  /** The task id. */
  taskId: string;
  /** Final status. */
  status: 'complete' | 'failed' | 'timeout';
  /** The result payload (on success). */
  result?: unknown;
  /** Error message (on failure). */
  error?: string;
  /** Tokens used (informational). */
  tokensUsed?: { inputTokens: number; outputTokens: number };
  /** Estimated USD cost (informational). */
  costUsd?: number;
  /** Wall-clock duration in ms. */
  durationMs?: number;
}

/**
 * Events emitted by {@link NodeRegistry}.
 */
export interface NodeRegistryEvents {
  /** Fired when a new node is registered (joins the cluster). */
  'node:registered': { node: ClusterNode };
  /** Fired when a node goes offline (missed heartbeats or explicit). */
  'node:offline': { nodeId: string; reason: string };
  /** Fired when a previously-offline node's heartbeat resumes. */
  'node:recovered': { node: ClusterNode };
  /** Fired on every heartbeat received. */
  'heartbeat:received': { nodeId: string; load: number; ts: number };
  /** Fired when <50% of nodes are online (cluster degraded). */
  'cluster:degraded': { onlineNodes: number; totalNodes: number };
  /** Fired when the cluster recovers from a degraded state. */
  'cluster:healthy': { onlineNodes: number; totalNodes: number };
}

/**
 * Events emitted by {@link ClusterCoordinator}.
 */
export interface ClusterCoordinatorEvents {
  /** Fired when a new task is submitted to the cluster. */
  'task:submitted': { taskId: string; type: DistributedTaskType };
  /** Fired when a task is assigned to a node. */
  'task:assigned': { taskId: string; nodeId: string };
  /** Fired when a task reaches `complete`. */
  'task:complete': { taskId: string; nodeId: string; result: unknown };
  /** Fired when a task reaches `failed` or `timeout`. */
  'task:failed': { taskId: string; nodeId?: string; error: string };
  /** Fired when a node joins the cluster. */
  'node:joined': { nodeId: string; url: string };
  /** Fired when a node leaves the cluster (offline or unregistered). */
  'node:left': { nodeId: string; reason: string };
  /** Fired when <50% of nodes are online (cluster degraded). */
  'cluster:degraded': { onlineNodes: number; totalNodes: number };
  /** Fired when the cluster recovers from a degraded state. */
  'cluster:healthy': { onlineNodes: number; totalNodes: number };
}

/**
 * Events emitted by {@link WorkerNode}.
 */
export interface WorkerNodeEvents {
  /** Fired when the worker registers with the coordinator. */
  'registered': { nodeId: string; coordinatorUrl: string };
  /** Fired on each heartbeat send. */
  'heartbeat:sent': { ts: number; load: number };
  /** Fired when a task is received from the coordinator. */
  'task:received': { taskId: string; type: DistributedTaskType };
  /** Fired when a task completes locally. */
  'task:complete': { taskId: string; durationMs: number };
  /** Fired when a task fails locally. */
  'task:failed': { taskId: string; error: string };
  /** Fired on heartbeat ack/error. */
  'heartbeat:error': { error: string };
}

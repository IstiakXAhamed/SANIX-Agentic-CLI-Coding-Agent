/**
 * @file ClusterRoutes.ts
 * @description Registers cluster-coordination REST endpoints on an
 * existing `SanixServer` instance. Routes:
 *
 *   POST   /v1/cluster/register              — worker joins the cluster.
 *   POST   /v1/cluster/heartbeat             — worker heartbeat.
 *   POST   /v1/cluster/tasks                 — submit a task to the cluster.
 *   GET    /v1/cluster/tasks/:id             — task status.
 *   GET    /v1/cluster/tasks/next            — worker pulls a pending task.
 *   POST   /v1/cluster/tasks/:id/assign      — coordinator pushes a task to a worker.
 *   POST   /v1/cluster/tasks/:id/result      — worker reports a result.
 *   POST   /v1/cluster/nodes/:id/drain       — drain a node.
 *   GET    /v1/cluster/stats                 — cluster statistics.
 *   GET    /v1/cluster/nodes                 — list nodes.
 *
 * The SanixServer's internal `router` field is private at compile time
 * but exists at runtime (TypeScript `private` is erasable). We access
 * it via a typed structural cast — no `any`.
 *
 * @packageDocumentation
 */

import type { SanixServer, RouteHandler, RouteRequest, RouteResponse } from '@sanix/server';
import type { ClusterCoordinator } from './ClusterCoordinator.js';
import type {
  ClusterNode,
  DistributedTask,
  DistributedTaskInput,
  DistributedTaskType,
  HeartbeatPayload,
  RegisterPayload,
  TaskAssignment,
  TaskResultReport,
} from './types.js';

/**
 * Structural mirror of the public surface of `@sanix/server`'s `Router`
 * class — just the methods we need.
 */
interface RouterLike {
  get(pattern: string, handler: RouteHandler): void;
  post(pattern: string, handler: RouteHandler): void;
}

/**
 * Structural view of `SanixServer` exposing its internal router field.
 */
interface SanixServerWithRouter {
  router: RouterLike;
}

/**
 * Register cluster-coordination routes on an existing SanixServer.
 * The SanixServer's `router` field is private at compile time but
 * accessible at runtime; we access it via a structural cast through
 * `unknown` (no `any`).
 *
 * @example
 * ```ts
 * const server = new SanixServer({ ctx, port: 7331 });
 * registerClusterRoutes(server, coordinator);
 * await server.start();
 * ```
 *
 * @param server      - The SanixServer instance to extend.
 * @param coordinator - The cluster coordinator that owns the routes.
 */
export function registerClusterRoutes(
  server: SanixServer,
  coordinator: ClusterCoordinator,
): void {
  // Cast through unknown to access the private `router` field.
  const withRouter = server as unknown as SanixServerWithRouter;
  const router = withRouter.router;
  if (!router || typeof router.post !== 'function' || typeof router.get !== 'function') {
    throw new Error(
      'registerClusterRoutes: the supplied SanixServer does not expose a usable router. ' +
      'Ensure you are using @sanix/server >= 1.0.0.',
    );
  }

  // ─── POST /v1/cluster/register ──────────────────────────────────────────
  router.post('/v1/cluster/register', async (req) => {
    const body = (req.body ?? {}) as Partial<RegisterPayload>;
    if (typeof body.nodeId !== 'string' || typeof body.url !== 'string') {
      return jsonError(400, 'nodeId and url required');
    }
    const node: ClusterNode = {
      id: body.nodeId,
      url: body.url,
      authToken: body.authToken,
      role: body.role ?? 'worker',
      status: 'online',
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      maxConcurrency: typeof body.maxConcurrency === 'number' ? body.maxConcurrency : 4,
      currentLoad: 0,
      lastHeartbeat: Date.now(),
      metadata: body.metadata,
    };
    coordinator.registerNode(node);
    return json({ registered: true, nodeId: node.id });
  });

  // ─── POST /v1/cluster/heartbeat ─────────────────────────────────────────
  router.post('/v1/cluster/heartbeat', async (req) => {
    const body = (req.body ?? {}) as Partial<HeartbeatPayload>;
    if (typeof body.nodeId !== 'string') {
      return jsonError(400, 'nodeId required');
    }
    coordinator.processHeartbeat({
      nodeId: body.nodeId,
      load: typeof body.load === 'number' ? body.load : 0,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      maxConcurrency: typeof body.maxConcurrency === 'number' ? body.maxConcurrency : 4,
      metadata: body.metadata,
    });
    return json({ ack: true, ts: Date.now() });
  });

  // ─── POST /v1/cluster/tasks ─────────────────────────────────────────────
  router.post('/v1/cluster/tasks', async (req) => {
    const body = (req.body ?? {}) as Partial<DistributedTaskInput>;
    if (!isValidTaskType(body.type)) {
      return jsonError(400, 'type must be one of llm_chat|tool_execute|agent_run|rag_query|sandbox_execute');
    }
    const taskId = await coordinator.submitTask({
      type: body.type,
      payload: body.payload,
      requiredCapabilities: body.requiredCapabilities,
    });
    return json({ taskId, status: 'pending' }, 202);
  });

  // ─── GET /v1/cluster/tasks/:id ──────────────────────────────────────────
  // NOTE: This must be registered BEFORE the `next` route to avoid the
  // path-param matcher shadowing the literal `next` segment. The
  // SanixServer router iterates routes in registration order, so
  // registering `next` first would shadow `:id`. We register `:id`
  // first and `next` separately below — but since `:id` matches any
  // single segment including `next`, we special-case `next` inside the
  // handler.
  router.get('/v1/cluster/tasks/:id', async (req) => {
    const id = req.params['id'] ?? '';
    // Special-case: `next` is a reserved pseudo-id for worker polling.
    if (id === 'next') {
      return handleNextTask(req);
    }
    const task = coordinator.getTaskStatus(id);
    if (!task) return jsonError(404, 'task not found');
    return json({ task });
  });

  // ─── POST /v1/cluster/tasks/:id/assign ──────────────────────────────────
  // Coordinator → worker: push a task assignment. This endpoint is
  // typically hosted by the WORKER, not the coordinator, but we
  // register it here so a single SanixServer can serve both roles
  // (peer mode). The assignment is forwarded to the worker's
  // WorkerNode if one is attached.
  router.post('/v1/cluster/tasks/:id/assign', async (req) => {
    const id = req.params['id'] ?? '';
    const body = (req.body ?? {}) as Partial<TaskAssignment>;
    if (typeof body.type !== 'string' || typeof body.taskId !== 'string') {
      return jsonError(400, 'taskId and type required');
    }
    // Look up the worker-side handler via the coordinator's registry
    // metadata. If no handler is attached, reject.
    const handler = clusterWorkerHandlers.get(coordinator);
    if (!handler) {
      return jsonError(501, 'worker task handler not configured on this node');
    }
    const assignment: TaskAssignment = {
      taskId: body.taskId ?? id,
      type: body.type as DistributedTaskType,
      payload: body.payload,
      requiredCapabilities: body.requiredCapabilities,
      deadline: typeof body.deadline === 'number' ? body.deadline : Date.now() + 300000,
    };
    handler(assignment);
    return json({ accepted: true, taskId: assignment.taskId }, 202);
  });

  // ─── POST /v1/cluster/tasks/:id/result ──────────────────────────────────
  // Worker → coordinator: report a task result.
  router.post('/v1/cluster/tasks/:id/result', async (req) => {
    const id = req.params['id'] ?? '';
    const body = (req.body ?? {}) as Partial<TaskResultReport>;
    if (body.status !== 'complete' && body.status !== 'failed' && body.status !== 'timeout') {
      return jsonError(400, 'status must be complete|failed|timeout');
    }
    coordinator.recordTaskResult({
      taskId: id,
      status: body.status,
      result: body.result,
      error: body.error,
      tokensUsed: body.tokensUsed,
      costUsd: body.costUsd,
      durationMs: body.durationMs,
    });
    return json({ recorded: true });
  });

  // ─── POST /v1/cluster/nodes/:id/drain ───────────────────────────────────
  router.post('/v1/cluster/nodes/:id/drain', async (req) => {
    const id = req.params['id'] ?? '';
    const timeoutMs = Number(req.query.get('timeoutMs') ?? 60000);
    // Drain runs in the background so the HTTP request doesn't block.
    void coordinator.drainNode(id, timeoutMs).catch(() => undefined);
    return json({ draining: true, nodeId: id }, 202);
  });

  // ─── GET /v1/cluster/stats ──────────────────────────────────────────────
  router.get('/v1/cluster/stats', async () => {
    return json({ stats: coordinator.getStats() });
  });

  // ─── GET /v1/cluster/nodes ──────────────────────────────────────────────
  router.get('/v1/cluster/nodes', async (req) => {
    const status = req.query.get('status') as ClusterNode['status'] | null;
    const role = req.query.get('role') as ClusterNode['role'] | null;
    const capabilitiesParam = req.query.get('capabilities') ?? '';
    const capabilities = capabilitiesParam ? capabilitiesParam.split(',').filter(Boolean) : undefined;
    const nodes = coordinator.getRegistry().list({
      status: status ?? undefined,
      role: role ?? undefined,
      capabilities,
    });
    return json({ nodes });
  });

  // ─── Internal: handle GET /v1/cluster/tasks/next ────────────────────────
  function handleNextTask(req: RouteRequest): RouteResponse {
    const nodeId = req.query.get('nodeId') ?? '';
    if (!nodeId) return jsonError(400, 'nodeId required');
    // Pull a pending task assigned to this worker. The coordinator
    // does not queue per-worker tasks itself (workers are pushed
    // assignments via /assign); but for pull-mode workers we expose
    // any pending task whose requiredCapabilities this worker matches.
    const workerNode = coordinator.getRegistry().get(nodeId);
    if (!workerNode) return jsonError(404, 'unknown worker');

    // Walk the coordinator's task list for a pending task. The
    // coordinator's tasks map is private; we expose a helper below.
    const task = pullPendingTaskForNode(coordinator, workerNode);
    if (!task) {
      // 204 No Content — worker should poll again.
      return { status: 204, headers: {}, body: '' };
    }
    const assignment: TaskAssignment = {
      taskId: task.id,
      type: task.type,
      payload: task.payload,
      requiredCapabilities: task.requiredCapabilities,
      deadline: Date.now() + (task.requiredCapabilities ? 300000 : 300000),
    };
    return json({ assignment });
  }
}

// ─── Worker handler attachment ────────────────────────────────────────────

/**
 * Side-table: maps a coordinator → its attached worker task handler.
 * Set via {@link attachWorkerHandler} when a WorkerNode is co-located
 * with the coordinator on the same SanixServer (peer mode).
 */
const clusterWorkerHandlers = new WeakMap<ClusterCoordinator, (a: TaskAssignment) => void>();

/**
 * Attach a worker-side task handler to a coordinator. Required when
 * the SanixServer hosting the cluster routes also acts as a worker
 * (peer mode) — the `/v1/cluster/tasks/:id/assign` route will forward
 * assignments to this handler.
 *
 * @example
 * ```ts
 * const worker = new WorkerNode({...}, executor);
 * attachWorkerHandler(coordinator, (a) => worker.handleAssignment(a));
 * registerClusterRoutes(server, coordinator);
 * ```
 */
export function attachWorkerHandler(
  coordinator: ClusterCoordinator,
  handler: (assignment: TaskAssignment) => void,
): void {
  clusterWorkerHandlers.set(coordinator, handler);
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Type guard for {@link DistributedTaskType}.
 */
function isValidTaskType(t: unknown): t is DistributedTaskType {
  return (
    t === 'llm_chat' ||
    t === 'tool_execute' ||
    t === 'agent_run' ||
    t === 'rag_query' ||
    t === 'sandbox_execute'
  );
}

/**
 * Pull a pending task from the coordinator that's assignable to the
 * given worker node. We access the coordinator's task list via a
 * structural cast — the field is private at compile time but exists
 * at runtime.
 */
function pullPendingTaskForNode(
  coordinator: ClusterCoordinator,
  worker: ClusterNode,
): DistributedTask | null {
  // Structural access to the coordinator's internal tasks map.
  const withTasks = coordinator as unknown as {
    tasks?: Map<string, DistributedTask>;
  };
  const tasks = withTasks.tasks;
  if (!tasks || typeof tasks[Symbol.iterator] !== 'function') return null;
  let picked: DistributedTask | null = null;
  for (const t of tasks.values()) {
    if (t.status !== 'pending') continue;
    if (t.assignedNodeId && t.assignedNodeId !== worker.id) continue;
    if (t.requiredCapabilities && t.requiredCapabilities.length > 0) {
      const ok = t.requiredCapabilities.every(
        (cap) =>
          worker.capabilities.includes(cap) ||
          worker.capabilities.includes(cap.replace(/:.*$/, ':any')),
      );
      if (!ok) continue;
    }
    picked = t;
    break;
  }
  if (picked) {
    picked.status = 'assigned';
    picked.assignedNodeId = worker.id;
    picked.assignedAt = Date.now();
  }
  return picked;
}

/**
 * Build a JSON success response.
 */
function json(body: unknown, status = 200): RouteResponse {
  return { status, headers: { 'Content-Type': 'application/json' }, body };
}

/**
 * Build a JSON error response.
 */
function jsonError(status: number, message: string): RouteResponse {
  return { status, headers: { 'Content-Type': 'application/json' }, body: { error: message } };
}

/**
 * @file NodeRegistry.ts
 * @description In-memory registry of all known cluster nodes. Tracks
 * heartbeats, auto-marks nodes offline when their heartbeats go stale,
 * and emits lifecycle events through EventEmitter3.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import type {
  ClusterConfig,
  ClusterNode,
  NodeRegistryEvents,
  NodeStatus,
} from './types.js';

/**
 * Tracks all known cluster nodes.
 *
 * The registry is the single source of truth for cluster topology: which
 * nodes exist, what capabilities they advertise, how loaded they are,
 * and whether they're currently `online` / `offline` / `draining`.
 *
 * A background sweep job (run every `heartbeatTimeoutMs`) checks each
 * node's `lastHeartbeat`; nodes that have been silent for longer than
 * `heartbeatTimeoutMs` are auto-marked `offline`. If a previously-offline
 * node's heartbeat resumes, the registry emits `node:recovered`.
 *
 * @example
 * ```ts
 * const registry = new NodeRegistry(config);
 * registry.on('node:registered', ({ node }) => console.log(`joined: ${node.id}`));
 * registry.on('node:offline', ({ nodeId }) => console.log(`lost: ${nodeId}`));
 * registry.register(workerNode);
 * registry.updateHeartbeat('worker-1', 0.3);
 * const onlines = registry.onlineNodes();
 * ```
 */
export class NodeRegistry extends EventEmitter<NodeRegistryEvents> {
  private readonly nodes = new Map<string, ClusterNode>();
  private readonly config: ClusterConfig;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private wasDegraded = false;

  constructor(config: ClusterConfig) {
    super();
    this.config = config;
  }

  /**
   * Start the background sweep job that marks stale nodes offline.
   * Idempotent — safe to call multiple times.
   */
  startSweep(): void {
    if (this.sweepTimer) return;
    const interval = Math.max(this.config.heartbeatTimeoutMs, 1000);
    this.sweepTimer = setInterval(() => this.sweep(), interval);
    // Don't keep the event loop alive solely for the sweep.
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  /** Stop the background sweep job. */
  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Add (or replace) a node in the registry. If the node already exists
   * by id, its mutable fields (url, authToken, capabilities,
   * maxConcurrency, metadata) are updated and its heartbeat is refreshed.
   *
   * @param node - The node to register.
   */
  register(node: ClusterNode): void {
    const existing = this.nodes.get(node.id);
    const now = Date.now();
    if (existing) {
      // Update mutable fields, preserve lastHeartbeat freshness.
      existing.url = node.url;
      existing.authToken = node.authToken;
      existing.role = node.role;
      existing.capabilities = node.capabilities;
      existing.maxConcurrency = node.maxConcurrency;
      existing.currentLoad = node.currentLoad;
      existing.metadata = node.metadata;
      existing.lastHeartbeat = node.lastHeartbeat || now;
      // Recover if previously offline.
      if (existing.status === 'offline' && node.status !== 'offline') {
        existing.status = 'online';
        this.emit('node:recovered', { node: existing });
      } else {
        existing.status = node.status;
      }
      this.emit('node:registered', { node: existing });
    } else {
      const fresh: ClusterNode = {
        ...node,
        lastHeartbeat: node.lastHeartbeat || now,
        status: node.status || 'online',
      };
      this.nodes.set(node.id, fresh);
      this.emit('node:registered', { node: fresh });
    }
    this.checkDegradation();
  }

  /**
   * Remove a node from the registry entirely (vs. `markOffline`, which
   * keeps it in the map but flags it as unreachable).
   *
   * @param nodeId - The node id to remove.
   */
  unregister(nodeId: string): void {
    const removed = this.nodes.get(nodeId);
    if (!removed) return;
    this.nodes.delete(nodeId);
    this.emit('node:offline', { nodeId, reason: 'unregistered' });
    this.checkDegradation();
  }

  /**
   * Get a node by id.
   *
   * @param nodeId - The node id.
   * @returns The node, or `null` if unknown.
   */
  get(nodeId: string): ClusterNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  /**
   * List nodes, optionally filtered.
   *
   * @param filter - Optional filter: `status`, `role`, and/or `capabilities`
   *   (a node must advertise ALL listed capabilities to match).
   * @returns Array of matching nodes.
   */
  list(filter?: {
    status?: NodeStatus;
    role?: ClusterNode['role'];
    capabilities?: string[];
  }): ClusterNode[] {
    const all = [...this.nodes.values()];
    if (!filter) return all;
    return all.filter((n) => {
      if (filter.status && n.status !== filter.status) return false;
      if (filter.role && n.role !== filter.role) return false;
      if (filter.capabilities && filter.capabilities.length > 0) {
        for (const cap of filter.capabilities) {
          if (!n.capabilities.includes(cap)) return false;
        }
      }
      return true;
    });
  }

  /**
   * Update a node's heartbeat + load. Restores `online` status if the
   * node was previously offline.
   *
   * @param nodeId - The node id.
   * @param load   - New load value 0..1.
   */
  updateHeartbeat(nodeId: string, load: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const wasOffline = node.status === 'offline';
    node.lastHeartbeat = Date.now();
    node.currentLoad = Math.max(0, Math.min(1, load));
    if (wasOffline) {
      node.status = 'online';
      this.emit('node:recovered', { node });
    }
    this.emit('heartbeat:received', { nodeId, load: node.currentLoad, ts: node.lastHeartbeat });
  }

  /**
   * Mark a node offline (does not remove it from the registry).
   *
   * @param nodeId - The node id.
   */
  markOffline(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    if (node.status === 'offline') return;
    node.status = 'offline';
    this.emit('node:offline', { nodeId, reason: 'marked offline' });
    this.checkDegradation();
  }

  /**
   * Mark a node as draining (no new tasks; in-flight allowed to finish).
   *
   * @param nodeId - The node id.
   */
  markDraining(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.status = 'draining';
  }

  /** All currently-online nodes. */
  onlineNodes(): ClusterNode[] {
    return this.list({ status: 'online' });
  }

  /** Total node count (any status). */
  get size(): number {
    return this.nodes.size;
  }

  /** Number of currently-online nodes. */
  get onlineCount(): number {
    let count = 0;
    for (const n of this.nodes.values()) if (n.status === 'online') count++;
    return count;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Sweep job: mark nodes with stale heartbeats offline.
   */
  private sweep(): void {
    const now = Date.now();
    const timeout = this.config.heartbeatTimeoutMs;
    for (const node of this.nodes.values()) {
      if (node.status === 'offline' || node.status === 'draining') continue;
      if (now - node.lastHeartbeat > timeout) {
        node.status = 'offline';
        this.emit('node:offline', {
          nodeId: node.id,
          reason: `heartbeat stale (${Math.round((now - node.lastHeartbeat) / 1000)}s)`,
        });
      }
    }
    this.checkDegradation();
  }

  /**
   * Track cluster health: emit `cluster:degraded` when <50% online,
   * `cluster:healthy` when it recovers.
   */
  private checkDegradation(): void {
    const total = this.nodes.size;
    if (total === 0) return;
    const online = this.onlineCount;
    const ratio = online / total;
    if (ratio < 0.5 && !this.wasDegraded) {
      this.wasDegraded = true;
      this.emit('cluster:degraded', { onlineNodes: online, totalNodes: total });
    } else if (ratio >= 0.5 && this.wasDegraded) {
      this.wasDegraded = false;
      this.emit('cluster:healthy', { onlineNodes: online, totalNodes: total });
    }
  }
}

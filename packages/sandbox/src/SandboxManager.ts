/**
 * @file SandboxManager.ts
 * @description Top-level sandbox orchestrator. Composes a {@link RuntimeAdapter}
 * with an {@link IsolationBackend} to execute arbitrary code in a configured
 * sandbox. Picks the safest available isolation by default (Docker → process
 * with warning).
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { nanoid } from 'nanoid';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BackendExecOptions,
  ExecutionResult,
  Isolation,
  REPLSession,
  Sandbox,
  SandboxOptions,
} from './types.js';
import { getIsolationBackend } from './isolation/index.js';
import { getRuntimeAdapter } from './runtimes/index.js';
import { REPLManager } from './REPLManager.js';

/**
 * Events emitted by {@link SandboxManager}.
 */
export interface SandboxManagerEvents {
  /** Emitted before a one-shot execution starts. */
  'execute:start': { sandboxId: string; opts: SandboxOptions };
  /** Emitted after a one-shot execution finishes. */
  'execute:complete': { sandboxId: string; result: ExecutionResult };
  /** Emitted when a new REPL session is created. */
  'repl:create': { sessionId: string; opts: SandboxOptions };
  /** Emitted when a REPL session is stopped. */
  'repl:stop': { sessionId: string };
  /** Emitted when a backend falls back (e.g. docker → process). */
  'backend:fallback': { from: Isolation; to: Isolation; reason: string };
  /** Emitted on internal errors. */
  'error': { error: Error };
}

/**
 * SandboxManager constructor options.
 */
export interface SandboxManagerOptions {
  /** Default isolation when `opts.isolation` is omitted. Default: `'docker'`. */
  defaultIsolation?: Isolation;
  /** Path to the docker binary. Default: `'docker'`. */
  dockerPath?: string;
  /** Default docker image when `opts.image` is omitted. */
  defaultImage?: string;
}

/**
 * The top-level sandbox orchestrator. Exposes one-shot execution, persistent
 * REPL creation, and global cleanup.
 *
 * @example
 * ```ts
 * const mgr = new SandboxManager();
 * // One-shot:
 * const res = await mgr.execute('console.log(1+1)', {
 *   runtime: 'node', isolation: 'process', timeoutMs: 5_000,
 * });
 * // REPL:
 * const repl = await mgr.createREPL({
 *   runtime: 'python', isolation: 'docker', image: 'python:3.12-slim',
 *   timeoutMs: 10_000, persistent: true,
 * });
 * await repl.execute('x = 5');
 * await repl.execute('print(x*2)');   // → 10
 * await repl.stop();
 * ```
 */
export class SandboxManager extends EventEmitter<SandboxManagerEvents> {
  private readonly defaultIsolation: Isolation;
  private readonly dockerPath: string;
  private readonly defaultImage?: string;
  private readonly replManager: REPLManager;
  private readonly sandboxes: Map<string, Sandbox> = new Map();

  constructor(opts: SandboxManagerOptions = {}) {
    super();
    this.defaultIsolation = opts.defaultIsolation ?? 'docker';
    this.dockerPath = opts.dockerPath ?? 'docker';
    this.defaultImage = opts.defaultImage;
    this.replManager = new REPLManager({ dockerPath: this.dockerPath });
  }

  /**
   * Create a one-shot sandbox (does not execute anything yet — call
   * `sandbox.execute(code)` to run code).
   */
  async createSandbox(opts: SandboxOptions): Promise<Sandbox> {
    const resolved = this.resolveOpts(opts);
    const backend = await this.resolveBackend(resolved);
    const id = nanoid(8);

    const sandbox: Sandbox = {
      opts: resolved,
      execute: (code: string) => this.runOnce(id, resolved, backend, code),
      stop: async () => { this.sandboxes.delete(id); },
    };
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  /**
   * One-shot execution: create a sandbox, run code, return result.
   */
  async execute(code: string, opts: SandboxOptions): Promise<ExecutionResult> {
    const sb = await this.createSandbox(opts);
    try {
      return await sb.execute(code);
    } finally {
      await sb.stop();
    }
  }

  /**
   * Create a persistent REPL session.
   */
  async createREPL(opts: SandboxOptions): Promise<REPLSession> {
    const resolved = this.resolveOpts({ ...opts, persistent: true });
    this.emit('repl:create', { sessionId: '(pending)', opts: resolved });
    const repl = await this.replManager.create(resolved);
    this.emit('repl:create', { sessionId: repl.id, opts: resolved });
    return repl;
  }

  /**
   * List all active REPL sessions.
   */
  listREPLs(): REPLSession[] {
    return this.replManager.list();
  }

  /**
   * Stop every active sandbox and REPL.
   */
  async stopAll(): Promise<void> {
    await this.replManager.stopAll();
    for (const sb of this.sandboxes.values()) {
      await sb.stop();
    }
    this.sandboxes.clear();
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /** Apply defaults + ensure required fields are present. */
  private resolveOpts(opts: SandboxOptions): SandboxOptions {
    const isolation = opts.isolation ?? this.defaultIsolation;
    const image = opts.image ?? this.defaultImage;
    if (!opts.timeoutMs || opts.timeoutMs <= 0) {
      throw new Error('SandboxManager: opts.timeoutMs is required and must be > 0');
    }
    return { ...opts, isolation, image };
  }

  /**
   * Resolve the safest available isolation backend. If the requested backend
   * is unavailable, fall back to a safer one with a warning event.
   */
  private async resolveBackend(opts: SandboxOptions): Promise<ReturnType<typeof getIsolationBackend>> {
    const backend = getIsolationBackend(opts.isolation);
    // For 'none' or 'process' — always available.
    if (opts.isolation === 'none' || opts.isolation === 'process') {
      return backend;
    }
    // For docker / firecracker / wasm — check availability.
    const ok = await backend.available().catch(() => false);
    if (ok) return backend;
    // Fall back to process with a warning.
    const fallback: Isolation = 'process';
    this.emit('backend:fallback', {
      from: opts.isolation,
      to: fallback,
      reason: `${opts.isolation} backend not available — falling back to process isolation`,
    });
    // Mutate opts so the runtime adapter / REPL manager know.
    opts.isolation = fallback;
    return getIsolationBackend(fallback);
  }

  /** Build a BackendExecOptions from SandboxOptions. */
  private toBackendOpts(opts: SandboxOptions): BackendExecOptions {
    return {
      cwd: opts.workDir,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      memoryLimitMb: opts.memoryLimitMb,
      cpuQuota: opts.cpuQuota,
      networkEnabled: opts.networkEnabled,
      image: opts.image,
      mounts: opts.mounts,
    };
  }

  /** Execute one-shot code under the given backend. */
  private async runOnce(
    sandboxId: string,
    opts: SandboxOptions,
    backend: ReturnType<typeof getIsolationBackend>,
    code: string,
  ): Promise<ExecutionResult> {
    const runtime = getRuntimeAdapter(opts.runtime);
    if (opts.isolation === 'docker' && opts.runtime !== 'custom' && !opts.image) {
      opts.image = runtime.defaultImage;
    }
    const cmd = runtime.buildExecCommand(code, opts);
    const backendOpts: BackendExecOptions = {
      ...this.toBackendOpts(opts),
      stdin: cmd.stdin,
    };
    this.emit('execute:start', { sandboxId, opts });
    try {
      const result = await backend.execute(cmd.command, backendOpts);
      this.emit('execute:complete', { sandboxId, result });
      // Cleanup tmp files written by the runtime adapter.
      if (cmd.tmpFiles) {
        for (const f of cmd.tmpFiles) {
          try { await fs.promises.unlink(f); } catch { /* best-effort */ }
        }
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      throw error;
    }
  }
}

/**
 * Default workDir for one-shot executions when none is provided.
 */
export function defaultWorkDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sanix-${prefix}-`));
}

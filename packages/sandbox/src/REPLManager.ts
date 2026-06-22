/**
 * @file REPLManager.ts
 * @description Persistent REPL session manager. Each session keeps a
 * runtime-adapter-managed state snapshot (variables defined in the session)
 * and replays it before each execution so user code sees a persistent
 * environment — even when the underlying isolation doesn't keep a process
 * alive between executions.
 *
 * Sessions auto-expire after 30 minutes of inactivity.
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
  REPLSession,
  SandboxOptions,
} from './types.js';
import { getIsolationBackend } from './isolation/index.js';
import { getRuntimeAdapter, type RuntimeAdapter } from './runtimes/index.js';
import type { IsolationBackend } from './types.js';

/** Auto-expire sessions after 30 min of inactivity. */
const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * Events emitted by {@link REPLManager}.
 */
export interface REPLManagerEvents {
  /** Emitted when a new session is created. */
  'session:create': { sessionId: string; runtime: string };
  /** Emitted when a session is stopped (manually or auto-expired). */
  'session:stop': { sessionId: string; reason: 'manual' | 'timeout' | 'error' };
  /** Emitted before each `execute()` call. */
  'session:execute': { sessionId: string; codeLen: number };
  /** Emitted after each `execute()` call. */
  'session:result': { sessionId: string; result: ExecutionResult };
}

/**
 * Internal record for an active REPL session.
 */
interface SessionRecord {
  session: REPLSession;
  runtime: RuntimeAdapter;
  backend: IsolationBackend;
  opts: SandboxOptions;
  state: Record<string, unknown>;
  lastActivity: number;
  expiryTimer: NodeJS.Timeout;
  dockerContainerStarted: boolean;
  workDir: string;
}

/**
 * REPLManager constructor options.
 */
export interface REPLManagerOptions {
  /** Path to the docker binary. */
  dockerPath?: string;
}

/**
 * Manages persistent REPL sessions. Sessions preserve variables between
 * executions (via runtime-adapter-managed state injection/extraction).
 *
 * @example
 * ```ts
 * const mgr = new REPLManager();
 * const repl = await mgr.create({
 *   runtime: 'python', isolation: 'docker', image: 'python:3.12-slim',
 *   timeoutMs: 10_000, persistent: true,
 * });
 * await repl.execute('x = 5');
 * await repl.execute('print(x*2)');   // → 10
 * await mgr.stop(repl.id);
 * ```
 */
export class REPLManager extends EventEmitter<REPLManagerEvents> {
  private readonly sessions: Map<string, SessionRecord> = new Map();
  private readonly dockerPath: string;

  constructor(opts: REPLManagerOptions = {}) {
    super();
    this.dockerPath = opts.dockerPath ?? 'docker';
  }

  /**
   * Create a new persistent REPL session.
   */
  async create(opts: SandboxOptions): Promise<REPLSession> {
    if (!opts.persistent) opts = { ...opts, persistent: true };
    const isolation = opts.isolation ?? 'process';
    const resolved: SandboxOptions = { ...opts, isolation };
    const runtime = getRuntimeAdapter(resolved.runtime);
    const backend = getIsolationBackend(isolation);
    if (isolation !== 'none' && isolation !== 'process') {
      const ok = await backend.available().catch(() => false);
      if (!ok) {
        // Fall back to process isolation.
        resolved.isolation = 'process';
      }
    }
    if (resolved.isolation === 'docker' && !resolved.image) {
      resolved.image = runtime.defaultImage;
    }
    const id = nanoid(10);
    const workDir = resolved.workDir
      ?? fs.mkdtempSync(path.join(os.tmpdir(), `sanix-repl-${id}-`));
    resolved.workDir = workDir;

    // For docker isolation, start a persistent container.
    let dockerContainerStarted = false;
    if (resolved.isolation === 'docker') {
      const startCmd = runtime.buildSessionStartCommand(resolved);
      const backendOpts: BackendExecOptions = {
        cwd: '/work',
        env: resolved.env,
        timeoutMs: 10_000,
        memoryLimitMb: resolved.memoryLimitMb,
        cpuQuota: resolved.cpuQuota,
        networkEnabled: resolved.networkEnabled,
        image: resolved.image,
        mounts: [{ host: workDir, container: '/work' }],
      };
      await backend.startSession(id, startCmd.command, backendOpts);
      dockerContainerStarted = true;
    }

    const state: Record<string, unknown> = {};
    const record: SessionRecord = {
      session: undefined as unknown as REPLSession,
      runtime,
      backend,
      opts: resolved,
      state,
      lastActivity: Date.now(),
      expiryTimer: undefined as unknown as NodeJS.Timeout,
      dockerContainerStarted,
      workDir,
    };

    const session: REPLSession = {
      id,
      runtime: resolved.runtime,
      startedAt: Date.now(),
      execute: (code: string) => this.executeInSession(id, code),
      getState: () => ({ ...record.state }),
      setState: (s: Record<string, unknown>) => this.setState(id, s),
      reset: () => this.resetSession(id),
      stop: () => this.stop(id),
    };
    record.session = session;
    record.expiryTimer = setTimeout(() => this.expire(id), SESSION_TTL_MS);
    this.sessions.set(id, record);
    this.emit('session:create', { sessionId: id, runtime: resolved.runtime });
    return session;
  }

  /**
   * Get an active session by id.
   */
  get(id: string): REPLSession | null {
    return this.sessions.get(id)?.session ?? null;
  }

  /**
   * List all active sessions.
   */
  list(): REPLSession[] {
    return [...this.sessions.values()].map((r) => r.session);
  }

  /**
   * Stop a single session.
   */
  async stop(id: string): Promise<void> {
    const rec = this.sessions.get(id);
    if (!rec) return;
    clearTimeout(rec.expiryTimer);
    this.sessions.delete(id);
    if (rec.dockerContainerStarted) {
      try { await rec.backend.stopSession(id); } catch { /* best-effort */ }
    }
    // Best-effort cleanup of the workDir.
    try {
      await fs.promises.rm(rec.workDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
    this.emit('session:stop', { sessionId: id, reason: 'manual' });
  }

  /**
   * Stop all sessions.
   */
  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /**
   * Expose session-internal info to collaborators (e.g. {@link ArtifactManager}).
   * Returns `null` for unknown sessions.
   */
  sessionInfo(id: string): {
    workDirPath: string;
    isDocker: boolean;
    backend: IsolationBackend;
  } | null {
    const rec = this.sessions.get(id);
    if (!rec) return null;
    return {
      workDirPath: rec.opts.isolation === 'docker' ? '/work' : rec.workDir,
      isDocker: rec.dockerContainerStarted,
      backend: rec.backend,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private async executeInSession(id: string, code: string): Promise<ExecutionResult> {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`REPLManager: unknown session '${id}'`);
    this.bumpActivity(id);
    this.emit('session:execute', { sessionId: id, codeLen: code.length });

    // Prepend state restoration code, append state extraction wrapper.
    const restoreCode = rec.runtime.buildStateRestoreCode(rec.state, rec.opts);
    const wrappedUserCode = rec.runtime.wrapWithStateExtraction(code, rec.opts);
    const fullCode = `${restoreCode}\n${wrappedUserCode}`;
    const cmd = rec.runtime.buildSessionExecCommand(fullCode, rec.opts);

    const backendOpts: BackendExecOptions = {
      cwd: rec.opts.isolation === 'docker' ? '/work' : rec.workDir,
      env: rec.opts.env,
      timeoutMs: rec.opts.timeoutMs,
      memoryLimitMb: rec.opts.memoryLimitMb,
      cpuQuota: rec.opts.cpuQuota,
      networkEnabled: rec.opts.networkEnabled,
      image: rec.opts.image,
      stdin: cmd.stdin,
    };

    let result: ExecutionResult;
    try {
      if (rec.dockerContainerStarted) {
        result = await rec.backend.execInSession(id, cmd.command, backendOpts);
      } else {
        result = await rec.backend.execute(cmd.command, backendOpts);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('session:stop', { sessionId: id, reason: 'error' });
      throw error;
    }

    // Capture updated state from the wrapped stderr/stdout output.
    const combined = `${result.stdout}\n${result.stderr}`;
    const newState = rec.runtime.extractState(combined);
    if (Object.keys(newState).length > 0) {
      rec.state = { ...rec.state, ...newState };
    }

    this.emit('session:result', { sessionId: id, result });
    return result;
  }

  private async setState(id: string, state: Record<string, unknown>): Promise<void> {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`REPLManager: unknown session '${id}'`);
    rec.state = { ...state };
    this.bumpActivity(id);
  }

  private async resetSession(id: string): Promise<void> {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error(`REPLManager: unknown session '${id}'`);
    rec.state = {};
    // Clear the workDir contents too.
    try {
      const entries = await fs.promises.readdir(rec.workDir);
      await Promise.all(entries.map((e) => fs.promises.rm(path.join(rec.workDir, e), { recursive: true, force: true })));
    } catch { /* best-effort */ }
    this.bumpActivity(id);
  }

  private bumpActivity(id: string): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    rec.lastActivity = Date.now();
    clearTimeout(rec.expiryTimer);
    rec.expiryTimer = setTimeout(() => this.expire(id), SESSION_TTL_MS);
  }

  private async expire(id: string): Promise<void> {
    if (!this.sessions.has(id)) return;
    try { await this.stop(id); } catch { /* noop */ }
    this.emit('session:stop', { sessionId: id, reason: 'timeout' });
  }
}

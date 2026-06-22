/**
 * @file isolation/DockerIsolation.ts
 * @description Docker-isolation backend. Uses `docker run --rm` for one-shot
 * executions, and `docker run -d` + `docker exec` + `docker stop` for
 * persistent REPL sessions. Enforces memory / CPU / network / filesystem
 * restrictions via Docker flags.
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type {
  Artifact,
  BackendExecOptions,
  ExecutionResult,
  IsolationBackend,
} from '../types.js';
import { listArtifactsSync, readFileSyncSafe } from '../utils.js';

/**
 * Spawn a child process, capture stdout/stderr, kill on timeout.
 * Used internally to invoke the `docker` CLI.
 */
function runCaptured(command: string[], opts: {
  timeoutMs: number;
  stdin?: string;
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; signal?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let signal: string | undefined;
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 500);
    }, opts.timeoutMs);
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (sig) signal = sig;
      resolve({ stdout, stderr, exitCode: code ?? 0, timedOut, signal });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n[docker spawn error]', exitCode: 1, timedOut: false });
    });
  });
}

/**
 * Docker-isolation backend. Safe-by-default flags:
 *   - `--network none`           (unless `networkEnabled: true`)
 *   - `--read-only`              (root FS is immutable; writes go to /tmp via tmpfs)
 *   - `--tmpfs /tmp:rw,size=64m` (writable scratch)
 *   - `--user nobody`            (drop privileges)
 *   - `--memory <mb>m`           (memory cap)
 *   - `--cpus <quota/1024>`      (CPU cap)
 *   - `--workdir /work`          (deterministic cwd)
 *
 * Persistent REPLs use `docker run -d` to start a sleeping container, then
 * `docker exec` for each execution.
 *
 * @example
 * ```ts
 * const be = new DockerIsolation({ dockerPath: 'docker' });
 * if (await be.available()) {
 *   const res = await be.execute(['node','--eval','console.log(1)'], {
 *     timeoutMs: 5000,
 *     image: 'node:20-slim',
 *   });
 * }
 * ```
 */
export class DockerIsolation implements IsolationBackend {
  readonly type = 'docker' as const;
  private readonly dockerPath: string;
  private readonly sessions: Map<string, { containerId: string; workDir: string }> = new Map();
  private availabilityCache: boolean | null = null;

  /**
   * @param opts.dockerPath - Path to docker binary. Default `'docker'`.
   */
  constructor(opts: { dockerPath?: string } = {}) {
    this.dockerPath = opts.dockerPath ?? 'docker';
  }

  async available(): Promise<boolean> {
    if (this.availabilityCache !== null) return this.availabilityCache;
    try {
      const res = await runCaptured([this.dockerPath, 'version', '--format', '{{.Server.Version}}'], {
        timeoutMs: 5_000,
      });
      this.availabilityCache = res.exitCode === 0 && res.stdout.trim().length > 0;
    } catch {
      this.availabilityCache = false;
    }
    return this.availabilityCache;
  }

  /** Build the `docker run` flag list for the security restrictions. */
  private buildRunFlags(opts: BackendExecOptions, persistent: boolean): string[] {
    const flags: string[] = [];
    if (opts.memoryLimitMb) flags.push('--memory', `${opts.memoryLimitMb}m`);
    if (opts.cpuQuota) flags.push('--cpus', String(Math.max(0.01, opts.cpuQuota / 1024)));
    if (!opts.networkEnabled) flags.push('--network', 'none');
    flags.push('--read-only');
    flags.push('--tmpfs', '/tmp:rw,size=64m');
    flags.push('--user', 'nobody');
    flags.push('--workdir', opts.cwd ?? '/work');
    if (persistent) {
      flags.push('-d'); // detached
      // Need stdin=open so we can exec into it later.
    } else {
      flags.push('--rm');
    }
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        flags.push('--env', `${k}=${v}`);
      }
    }
    if (opts.mounts) {
      for (const m of opts.mounts) {
        const ro = m.readonly ? ':ro' : '';
        flags.push('-v', `${m.host}:${m.container}${ro}`);
      }
    }
    return flags;
  }

  async execute(command: string[], opts: BackendExecOptions): Promise<ExecutionResult> {
    if (!(await this.available())) {
      throw new Error('DockerIsolation: docker daemon not available. Install Docker or pick another isolation.');
    }
    const image = opts.image ?? 'alpine:latest';
    const flags = this.buildRunFlags(opts, false);
    const fullCmd = [this.dockerPath, 'run', ...flags, image, ...command];
    const start = Date.now();
    const res = await runCaptured(fullCmd, {
      timeoutMs: opts.timeoutMs,
      stdin: opts.stdin,
    });
    const durationMs = Date.now() - start;
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      signal: res.signal,
      durationMs,
      timedOut: res.timedOut,
    };
  }

  async startSession(sessionId: string, command: string[], opts: BackendExecOptions): Promise<void> {
    if (!(await this.available())) {
      throw new Error('DockerIsolation: docker daemon not available.');
    }
    // Use a host-side workdir so artifacts written into /work survive.
    const workDir = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), `sanix-session-${sessionId}-`));
    const image = opts.image ?? 'alpine:latest';
    const flags = this.buildRunFlags({ ...opts, cwd: '/work' }, true);
    // Mount workDir → /work so files persist between exec calls.
    flags.push('-v', `${workDir}:/work`);
    const fullCmd = [this.dockerPath, 'run', ...flags, image, ...command];
    const res = await runCaptured(fullCmd, { timeoutMs: opts.timeoutMs });
    const containerId = res.stdout.trim();
    if (res.exitCode !== 0 || !containerId) {
      throw new Error(`DockerIsolation: failed to start session: ${res.stderr || res.stdout}`);
    }
    this.sessions.set(sessionId, { containerId, workDir });
  }

  async execInSession(sessionId: string, command: string[], opts: BackendExecOptions): Promise<ExecutionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`DockerIsolation: unknown session '${sessionId}'`);
    }
    const fullCmd = [this.dockerPath, 'exec', session.containerId, ...command];
    const start = Date.now();
    const res = await runCaptured(fullCmd, {
      timeoutMs: opts.timeoutMs,
      stdin: opts.stdin,
      env: opts.env,
    });
    const durationMs = Date.now() - start;
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      signal: res.signal,
      durationMs,
      timedOut: res.timedOut,
    };
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try {
      await runCaptured([this.dockerPath, 'stop', '-t', '2', session.containerId], { timeoutMs: 10_000 });
    } catch { /* best-effort */ }
    try {
      await runCaptured([this.dockerPath, 'rm', '-f', session.containerId], { timeoutMs: 5_000 });
    } catch { /* best-effort */ }
  }

  async listSessionArtifacts(sessionId: string, containerPath: string): Promise<Artifact[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    try {
      const res = await runCaptured(
        [this.dockerPath, 'exec', session.containerId, 'ls', '-1A', '--recursive', containerPath],
        { timeoutMs: 5_000 },
      );
      // Best-effort: fall back to listing the host workDir.
      if (res.exitCode === 0) {
        const lines = res.stdout.split('\n').filter(Boolean).map((l) => l.trim());
        const out: Artifact[] = [];
        for (const l of lines) {
          try {
            const stat = await runCaptured(
              [this.dockerPath, 'exec', session.containerId, 'stat', '-c', '%s %Y', l],
              { timeoutMs: 2_000 },
            );
            if (stat.exitCode === 0) {
              const [size, mtime] = stat.stdout.trim().split(/\s+/);
              out.push({
                path: l,
                bytes: Number(size) || 0,
                modifiedAt: Number(mtime) || Date.now(),
                isDirectory: false,
              });
            }
          } catch { /* skip */ }
        }
        return out;
      }
    } catch { /* fall through */ }
    // Fallback: list the host workDir (mounts make these equivalent).
    return listArtifactsSync(path.join(session.workDir, path.basename(containerPath) || '.'));
  }

  async readSessionFile(sessionId: string, containerPath: string): Promise<Buffer> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`DockerIsolation: unknown session '${sessionId}'`);
    const res = await runCaptured(
      [this.dockerPath, 'exec', session.containerId, 'cat', containerPath],
      { timeoutMs: 10_000 },
    );
    if (res.exitCode !== 0) {
      throw new Error(`DockerIsolation: read failed: ${res.stderr}`);
    }
    return Buffer.from(res.stdout, 'utf8');
  }

  async copySessionFile(sessionId: string, containerPath: string, hostPath: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`DockerIsolation: unknown session '${sessionId}'`);
    // `docker cp` requires the container to be running — but it works on
    // paused/stopped containers too. Use a temp file path inside the host.
    const res = await runCaptured(
      [this.dockerPath, 'cp', `${session.containerId}:${containerPath}`, hostPath],
      { timeoutMs: 30_000 },
    );
    if (res.exitCode !== 0) {
      throw new Error(`DockerIsolation: cp failed: ${res.stderr}`);
    }
  }
}

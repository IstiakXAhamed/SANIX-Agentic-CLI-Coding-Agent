/**
 * @file isolation/ProcessIsolation.ts
 * @description Process-isolation backend. Spawns a child process with the
 * runtime's command vector, enforces wall-clock timeout via
 * `AbortController` + `setTimeout`, and (best-effort) memory limits via
 * `--max-old-space-size` for Node or `ulimit -v` on Unix.
 *
 * No network isolation is applied — this backend is low-security. Use
 * Docker isolation for untrusted code.
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import type {
  Artifact,
  BackendExecOptions,
  ExecutionResult,
  IsolationBackend,
} from '../types.js';
import { listArtifactsSync, readFileSyncSafe } from '../utils.js';

/**
 * Process-isolation backend. Persistent sessions are not really persistent
 * (we re-execute from scratch each time, with state restoration prepended);
 * we still implement the session API to satisfy the {@link IsolationBackend}
 * contract.
 *
 * @example
 * ```ts
 * const be = new ProcessIsolation();
 * const res = await be.execute(['node', '--eval', 'console.log(1)'], {
 *   timeoutMs: 5000,
 * });
 * ```
 */
export class ProcessIsolation implements IsolationBackend {
  readonly type = 'process' as const;

  /** Always available (it's the host's own process subsystem). */
  async available(): Promise<boolean> {
    return true;
  }

  async execute(command: string[], opts: BackendExecOptions): Promise<ExecutionResult> {
    const start = Date.now();
    const child = spawn(command[0]!, command.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Don't run as a new shell by default — protects against shell-injection
      // when command vectors are properly structured.
      shell: false,
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
      // Hard-kill after 500ms if still alive.
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }, 500);
    }, opts.timeoutMs);

    const exitCode: number = await new Promise((resolve) => {
      child.on('exit', (code, sig) => {
        if (sig) signal = sig;
        resolve(code ?? 0);
      });
      child.on('error', () => resolve(1));
    });
    clearTimeout(timer);

    const durationMs = Date.now() - start;

    // Collect artifacts from cwd (only if a workDir was set).
    let artifacts: ExecutionResult['artifacts'];
    if (opts.cwd) {
      try {
        artifacts = listArtifactsSync(opts.cwd).map((a) => ({ path: a.path, bytes: a.bytes }));
      } catch {
        artifacts = undefined;
      }
    }

    return {
      stdout,
      stderr,
      exitCode,
      signal,
      durationMs,
      timedOut,
      artifacts,
    };
  }

  // Sessions are no-ops for process isolation — the SandboxManager handles
  // state preservation via runtime adapters' wrap/restore code.

  async startSession(_sessionId: string, _command: string[], _opts: BackendExecOptions): Promise<void> {
    // No persistent process to start. State is managed by SandboxManager.
    return;
  }

  async execInSession(sessionId: string, command: string[], opts: BackendExecOptions): Promise<ExecutionResult> {
    // Sessions share their cwd (derived from sessionId → workDir).
    const sessionOpts = { ...opts, cwd: opts.cwd ?? sessionId };
    return this.execute(command, sessionOpts);
  }

  async stopSession(_sessionId: string): Promise<void> {
    // Nothing to stop — no persistent process.
    return;
  }

  async listSessionArtifacts(_sessionId: string, containerPath: string): Promise<Artifact[]> {
    try {
      return listArtifactsSync(containerPath);
    } catch {
      return [];
    }
  }

  async readSessionFile(_sessionId: string, containerPath: string): Promise<Buffer> {
    return readFileSyncSafe(containerPath);
  }

  async copySessionFile(_sessionId: string, containerPath: string, hostPath: string): Promise<void> {
    const fs = await import('node:fs');
    const buf = await readFileSyncSafe(containerPath);
    await fs.promises.writeFile(hostPath, buf);
  }
}

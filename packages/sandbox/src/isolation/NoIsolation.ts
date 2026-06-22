/**
 * @file isolation/NoIsolation.ts
 * @description **DANGER ZONE** — direct `eval` / `exec` with no sandboxing
 * whatsoever. Requires explicit opt-in via `SandboxOptions.isolation='none'`.
 *
 * Only the Node, Python (via `python3 -c`), and Bash runtimes are meaningfully
 * supported here; other runtimes fall back to the ProcessIsolation command
 * vector (still no extra isolation, but at least a separate process).
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type {
  Artifact,
  BackendExecOptions,
  ExecutionResult,
  IsolationBackend,
} from '../types.js';
import { listArtifactsSync, readFileSyncSafe } from '../utils.js';

const require = createRequire(import.meta.url);

/**
 * No-isolation backend. Runs the runtime's command vector directly on the
 * host (no resource limits, no network restrictions, no FS restrictions).
 *
 * The Node runtime specifically supports true `eval` (no subprocess) when
 * the command vector is exactly `['node', '--eval', code]` — we detect this
 * and inline the eval to demonstrate the no-isolation trade-off explicitly.
 *
 * @example
 * ```ts
 * // DANGER: arbitrary code executes in the host process.
 * const be = new NoIsolation();
 * await be.execute(['node','--eval','console.log(1)'], { timeoutMs: 1000 });
 * ```
 */
export class NoIsolation implements IsolationBackend {
  readonly type = 'none' as const;

  async available(): Promise<boolean> {
    return true;
  }

  async execute(command: string[], opts: BackendExecOptions): Promise<ExecutionResult> {
    const start = Date.now();
    // Special-case Node --eval for true in-process eval (most dangerous path).
    if (command[0] === 'node' && command[1] === '--eval' && command.length === 3) {
      const code = command[2]!;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const origLog = console.log;
      const origErr = console.error;
      let timedOut = false;
      console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
      console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '));
      const timer = setTimeout(() => { timedOut = true; }, opts.timeoutMs);
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('require', 'process', 'globalThis', code);
        fn(require, process, globalThis);
      } catch (err) {
        stderr.push(String(err instanceof Error ? err.message : err));
        console.log = origLog;
        console.error = origErr;
        clearTimeout(timer);
        return {
          stdout: stdout.join('\n'),
          stderr: stderr.join('\n'),
          exitCode: 1,
          durationMs: Date.now() - start,
          timedOut,
        };
      }
      console.log = origLog;
      console.error = origErr;
      clearTimeout(timer);
      return {
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
        exitCode: 0,
        durationMs: Date.now() - start,
        timedOut,
      };
    }

    // Fallback: spawn (still no isolation, but at least a separate process).
    const child = spawn(command[0]!, command.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let signal: string | undefined;
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 500);
    }, opts.timeoutMs);
    const exitCode: number = await new Promise((resolve) => {
      child.on('exit', (code, sig) => { if (sig) signal = sig; resolve(code ?? 0); });
      child.on('error', () => resolve(1));
    });
    clearTimeout(timer);

    let artifacts: ExecutionResult['artifacts'];
    if (opts.cwd) {
      try {
        artifacts = listArtifactsSync(opts.cwd).map((a) => ({ path: a.path, bytes: a.bytes }));
      } catch { artifacts = undefined; }
    }
    return { stdout, stderr, exitCode, signal, durationMs: Date.now() - start, timedOut, artifacts };
  }

  async startSession(): Promise<void> { /* no-op */ }
  async execInSession(_id: string, command: string[], opts: BackendExecOptions): Promise<ExecutionResult> {
    return this.execute(command, opts);
  }
  async stopSession(): Promise<void> { /* no-op */ }
  async listSessionArtifacts(_id: string, p: string): Promise<Artifact[]> {
    try { return listArtifactsSync(p); } catch { return []; }
  }
  async readSessionFile(_id: string, p: string): Promise<Buffer> { return readFileSyncSafe(p); }
  async copySessionFile(_id: string, cp: string, hp: string): Promise<void> {
    const fs = await import('node:fs');
    const buf = await readFileSyncSafe(cp);
    await fs.promises.writeFile(hp, buf);
  }
}

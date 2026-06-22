/**
 * @file isolation/FirecrackerIsolation.ts
 * @description Firecracker microVM isolation backend. **Stub** — Firecracker
 * requires the `firecracker` CLI and a configured jailer; until those are
 * available on the host, this backend throws informative errors.
 *
 * @packageDocumentation
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Artifact,
  BackendExecOptions,
  ExecutionResult,
  IsolationBackend,
} from '../types.js';

const execFileP = promisify(execFile);

/**
 * Stub Firecracker backend. All operations throw with an actionable message
 * pointing the user at Docker isolation instead.
 *
 * @example
 * ```ts
 * const be = new FirecrackerIsolation();
 * if (await be.available()) {
 *   // not reachable today — firecracker CLI not yet wired up.
 * }
 * ```
 */
export class FirecrackerIsolation implements IsolationBackend {
  readonly type = 'firecracker' as const;
  private readonly fcPath: string;
  private availabilityCache: boolean | null = null;

  constructor(opts: { fcPath?: string } = {}) {
    this.fcPath = opts.fcPath ?? 'firecracker';
  }

  async available(): Promise<boolean> {
    if (this.availabilityCache !== null) return this.availabilityCache;
    try {
      await execFileP(this.fcPath, ['--version'], { timeout: 2_000 });
      this.availabilityCache = true;
    } catch {
      this.availabilityCache = false;
    }
    return this.availabilityCache;
  }

  private notImplemented(method: string): never {
    throw new Error(
      `FirecrackerIsolation.${method}(): not implemented yet. ` +
        `Install the firecracker CLI (and jailer) and configure a rootfs/kernel — or use ` +
        `isolation='docker' for now.`,
    );
  }

  async execute(_command: string[], _opts: BackendExecOptions): Promise<ExecutionResult> {
    if (!(await this.available())) {
      throw new Error(
        'FirecrackerIsolation: firecracker CLI not found on PATH. Install firecracker or use isolation=\'docker\'.',
      );
    }
    this.notImplemented('execute');
  }

  async startSession(_id: string, _cmd: string[], _opts: BackendExecOptions): Promise<void> {
    this.notImplemented('startSession');
  }

  async execInSession(_id: string, _cmd: string[], _opts: BackendExecOptions): Promise<ExecutionResult> {
    this.notImplemented('execInSession');
  }

  async stopSession(_id: string): Promise<void> {
    this.notImplemented('stopSession');
  }

  async listSessionArtifacts(_id: string, _path: string): Promise<Artifact[]> {
    this.notImplemented('listSessionArtifacts');
  }

  async readSessionFile(_id: string, _path: string): Promise<Buffer> {
    this.notImplemented('readSessionFile');
  }

  async copySessionFile(_id: string, _cpath: string, _hpath: string): Promise<void> {
    this.notImplemented('copySessionFile');
  }
}

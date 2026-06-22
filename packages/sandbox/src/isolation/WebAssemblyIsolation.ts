/**
 * @file isolation/WebAssemblyIsolation.ts
 * @description WebAssembly (Wasmtime) isolation backend. **Stub** — running
 * arbitrary host languages (Node/Python/Go/...) inside Wasmtime requires
 * compiling them to WASI first, which is not generally practical for ad-hoc
 * code. This backend exists so callers can request `isolation: 'webassembly'`
 * and receive a clear error pointing them at Docker instead.
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
 * Stub WASM isolation backend. All operations throw with an actionable
 * message.
 *
 * @example
 * ```ts
 * const be = new WebAssemblyIsolation();
 * if (await be.available()) {
 *   // wasmtime is installed; still need WASI-compiled modules.
 * }
 * ```
 */
export class WebAssemblyIsolation implements IsolationBackend {
  readonly type = 'webassembly' as const;
  private readonly wasmtimePath: string;
  private availabilityCache: boolean | null = null;

  constructor(opts: { wasmtimePath?: string } = {}) {
    this.wasmtimePath = opts.wasmtimePath ?? 'wasmtime';
  }

  async available(): Promise<boolean> {
    if (this.availabilityCache !== null) return this.availabilityCache;
    try {
      await execFileP(this.wasmtimePath, ['--version'], { timeout: 2_000 });
      this.availabilityCache = true;
    } catch {
      this.availabilityCache = false;
    }
    return this.availabilityCache;
  }

  private notImplemented(method: string): never {
    throw new Error(
      `WebAssemblyIsolation.${method}(): not implemented. ` +
        `WASM isolation requires pre-compiled WASI modules for each runtime, which is not ` +
        `supported for ad-hoc code. Use isolation='docker' instead.`,
    );
  }

  async execute(_command: string[], _opts: BackendExecOptions): Promise<ExecutionResult> {
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

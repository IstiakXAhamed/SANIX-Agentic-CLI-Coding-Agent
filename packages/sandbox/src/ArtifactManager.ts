/**
 * @file ArtifactManager.ts
 * @description File-artifact manager for sandbox sessions. Lists, reads, and
 * downloads files produced by code running inside a session's workDir.
 *
 * @packageDocumentation
 */

import type { Artifact, REPLSession } from './types.js';
import { REPLManager } from './REPLManager.js';

/**
 * ArtifactManager constructor options.
 */
export interface ArtifactManagerOptions {
  /** The {@link REPLManager} whose sessions this manager reads from. */
  replManager: REPLManager;
}

/**
 * Manages file artifacts produced by sandboxed code. For process isolation
 * (or no isolation), reads directly from the host workDir; for docker,
 * falls back to `docker cp` against the running container.
 *
 * @example
 * ```ts
 * const replMgr = new REPLManager();
 * const artifacts = new ArtifactManager({ replManager: replMgr });
 * const repl = await replMgr.create(opts);
 * await repl.execute('with open("hello.txt","w") as f: f.write("hi")');
 * const files = await artifacts.list(repl.id);
 * ```
 */
export class ArtifactManager {
  private readonly replManager: REPLManager;

  constructor(opts: ArtifactManagerOptions) {
    this.replManager = opts.replManager;
  }

  /**
   * List artifacts produced in the session's workDir.
   */
  async list(sessionId: string): Promise<Artifact[]> {
    const rec = this.replManager.get(sessionId);
    if (!rec) throw new Error(`ArtifactManager: unknown session '${sessionId}'`);
    // Delegate to the backend's session-aware listing. For process isolation,
    // that walks the host workDir; for docker, it execs `ls` inside the
    // container.
    // We need access to the underlying backend + workDir. Reach into the
    // manager via a small typed accessor.
    const info = this.replManager.sessionInfo(sessionId);
    if (!info) throw new Error(`ArtifactManager: no info for '${sessionId}'`);
    return info.backend.listSessionArtifacts(sessionId, info.workDirPath);
  }

  /**
   * Read a file produced in the session's workDir into a Buffer.
   */
  async read(sessionId: string, file: string): Promise<Buffer> {
    const info = this.replManager.sessionInfo(sessionId);
    if (!info) throw new Error(`ArtifactManager: unknown session '${sessionId}'`);
    const filePath = info.isDocker ? file : `${info.workDirPath}/${file}`;
    return info.backend.readSessionFile(sessionId, filePath);
  }

  /**
   * Download a file from the session's workDir to a host path.
   */
  async download(sessionId: string, file: string, destHostPath: string): Promise<void> {
    const info = this.replManager.sessionInfo(sessionId);
    if (!info) throw new Error(`ArtifactManager: unknown session '${sessionId}'`);
    const filePath = info.isDocker ? file : `${info.workDirPath}/${file}`;
    await info.backend.copySessionFile(sessionId, filePath, destHostPath);
  }
}

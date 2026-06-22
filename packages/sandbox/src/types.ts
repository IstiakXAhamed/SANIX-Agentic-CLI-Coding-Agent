/**
 * @file types.ts
 * @description Sandbox type system for `@sanix/sandbox`. Defines the public
 * option / result / REPL session contracts, plus the internal
 * {@link IsolationBackend} and {@link RuntimeAdapter} interfaces that the
 * manager composes to actually run code.
 *
 * @packageDocumentation
 */

/**
 * Supported code-execution runtimes. Each maps to a {@link RuntimeAdapter}
 * that knows how to build the correct command-line invocation for both
 * one-shot execution and persistent REPL sessions.
 */
export type Runtime =
  | 'node'
  | 'python'
  | 'deno'
  | 'bun'
  | 'go'
  | 'rust'
  | 'bash'
  | 'custom';

/**
 * Isolation strategy. Higher = more secure, more setup.
 *
 * - `none`         — direct `eval` / `exec` (DANGER ZONE, explicit opt-in only).
 * - `process`      — child process with resource limits (low security, no network isolation).
 * - `docker`       — Docker container with `--network none`, `--read-only`, memory/CPU caps.
 * - `firecracker`  — Firecracker microVM (stub, throws until CLI is available).
 * - `webassembly`  — Wasmtime-based sandbox (stub).
 */
export type Isolation =
  | 'none'
  | 'process'
  | 'docker'
  | 'firecracker'
  | 'webassembly';

/**
 * Options for creating a sandbox.
 *
 * @example
 * ```ts
 * const opts: SandboxOptions = {
 *   runtime: 'python',
 *   isolation: 'docker',
 *   image: 'python:3.12-slim',
 *   timeoutMs: 10_000,
 *   memoryLimitMb: 256,
 *   cpuQuota: 256,
 *   networkEnabled: false,
 * };
 * ```
 */
export interface SandboxOptions {
  /** Code runtime (selects the {@link RuntimeAdapter}). */
  runtime: Runtime;
  /** Isolation strategy (selects the {@link IsolationBackend}). */
  isolation: Isolation;
  /** Docker image override (e.g. `node:20-slim`, `python:3.12-slim`). */
  image?: string;
  /** Host working directory (process isolation) or host mount source. */
  workDir?: string;
  /** Environment variables to inject into the execution. */
  env?: Record<string, string>;
  /** Hard wall-clock timeout per execution (ms). Required. */
  timeoutMs: number;
  /** Memory limit in megabytes (enforced where supported). */
  memoryLimitMb?: number;
  /** CPU quota in Docker CPU shares (1–1024). */
  cpuQuota?: number;
  /** Whether to allow outbound network access (default false). */
  networkEnabled?: boolean;
  /** Keep the underlying container/process alive between executions (REPL mode). */
  persistent?: boolean;
  /** Bind-mounts (docker only). */
  mounts?: Array<{ host: string; container: string; readonly?: boolean }>;
  /** Custom command template for `runtime='custom'` (e.g. `ruby {file}`). */
  customCommand?: string;
}

/**
 * The result of a single sandbox execution.
 */
export interface ExecutionResult {
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Signal that killed the process (e.g. `SIGTERM`), when applicable. */
  signal?: string;
  /** Wall-clock execution duration in ms. */
  durationMs: number;
  /** `true` if the execution was killed by the timeout. */
  timedOut: boolean;
  /** Files produced in the workDir during this execution. */
  artifacts?: Array<{ path: string; bytes: number }>;
}

/**
 * A persistent REPL session. State survives between {@link REPLSession.execute}
 * calls — variables defined in one call are visible in the next.
 */
export interface REPLSession {
  /** Stable unique session id. */
  id: string;
  /** The runtime this session uses. */
  runtime: Runtime;
  /** Unix ms timestamp when the session was created. */
  startedAt: number;
  /** Execute a code snippet in this session. */
  execute(code: string): Promise<ExecutionResult>;
  /** Return a runtime-specific state snapshot (defined variables). */
  getState(): Record<string, unknown>;
  /** Restore a previously captured state snapshot. */
  setState(state: Record<string, unknown>): Promise<void>;
  /** Reset the session — clear all state, equivalent to a fresh session. */
  reset(): Promise<void>;
  /** Stop the session and release all resources. */
  stop(): Promise<void>;
}

/**
 * A one-shot sandbox instance.
 */
export interface Sandbox {
  /** The options this sandbox was created with. */
  opts: SandboxOptions;
  /** Execute a code snippet. */
  execute(code: string): Promise<ExecutionResult>;
  /** Release all resources held by this sandbox. */
  stop(): Promise<void>;
}

// ─── Internal contracts (used by SandboxManager) ───────────────────────────

/**
 * The command-line + stdin shape returned by a {@link RuntimeAdapter}.
 */
export interface RuntimeCommand {
  /** Command vector — `argv[0]` is the binary, the rest are args. */
  command: string[];
  /** Optional stdin payload piped to the process. */
  stdin?: string;
  /** Optional tmp files (path → content) the adapter wrote that should be
   * cleaned up after execution. */
  tmpFiles?: string[];
}

/**
 * A runtime adapter knows how to build command lines for a particular
 * language runtime. It does NOT know about isolation — the
 * {@link IsolationBackend} is responsible for actually running the command.
 */
export interface RuntimeAdapter {
  /** The runtime this adapter handles. */
  readonly runtime: Runtime;
  /** Default docker image used when `SandboxOptions.image` is unset. */
  readonly defaultImage: string;
  /** Build a one-shot execution command for `code`. */
  buildExecCommand(code: string, opts: SandboxOptions): RuntimeCommand;
  /** Build a command to start a persistent REPL session (docker only). */
  buildSessionStartCommand(opts: SandboxOptions): RuntimeCommand;
  /** Build a command to execute `code` inside an already-running session. */
  buildSessionExecCommand(code: string, opts: SandboxOptions): RuntimeCommand;
  /** Wrap `code` so that, after running, it prints a state snapshot to stdout
   *  in a parseable format (the parser is `extractState`). */
  wrapWithStateExtraction(code: string, opts: SandboxOptions): string;
  /** Build a preamble that restores `state` before user code runs. */
  buildStateRestoreCode(state: Record<string, unknown>, opts: SandboxOptions): string;
  /** Parse the state-extraction marker from stdout back into a JS object. */
  extractState(stdout: string): Record<string, unknown>;
}

/**
 * Options handed to an {@link IsolationBackend}'s execution methods.
 */
export interface BackendExecOptions {
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Wall-clock timeout (ms). */
  timeoutMs: number;
  /** Memory limit (MB). */
  memoryLimitMb?: number;
  /** CPU quota (Docker shares 1–1024). */
  cpuQuota?: number;
  /** Whether the sandbox may access the network. */
  networkEnabled?: boolean;
  /** Stdin payload. */
  stdin?: string;
  /** Docker image (docker backend only). */
  image?: string;
  /** Bind-mounts (docker backend only). */
  mounts?: Array<{ host: string; container: string; readonly?: boolean }>;
}

/**
 * An isolation backend knows how to actually run a command vector under a
 * particular isolation strategy (process, docker, firecracker, wasm).
 */
export interface IsolationBackend {
  /** The isolation strategy this backend implements. */
  readonly type: Isolation;
  /** Quickly check whether this backend is usable on the current host
   *  (e.g. docker daemon reachable, firecracker CLI on PATH). */
  available(): Promise<boolean>;
  /** One-shot execution: spawn, capture, terminate. */
  execute(command: string[], opts: BackendExecOptions): Promise<ExecutionResult>;
  /** Start a persistent session, returning a session id. */
  startSession(sessionId: string, command: string[], opts: BackendExecOptions): Promise<void>;
  /** Execute a command inside a running session. */
  execInSession(sessionId: string, command: string[], opts: BackendExecOptions): Promise<ExecutionResult>;
  /** Stop a running session. */
  stopSession(sessionId: string): Promise<void>;
  /** List artifacts produced in a session's workDir (docker: `docker cp`). */
  listSessionArtifacts(sessionId: string, containerPath: string): Promise<Artifact[]>;
  /** Read a file from a session's workDir into a Buffer. */
  readSessionFile(sessionId: string, containerPath: string): Promise<Buffer>;
  /** Copy a file from a session's workDir to a host path. */
  copySessionFile(sessionId: string, containerPath: string, hostPath: string): Promise<void>;
}

/**
 * A file produced inside a sandbox.
 */
export interface Artifact {
  /** Path inside the sandbox workDir. */
  path: string;
  /** File size in bytes. */
  bytes: number;
  /** Unix ms timestamp of last modification. */
  modifiedAt: number;
  /** `true` if this entry is a directory. */
  isDirectory: boolean;
}

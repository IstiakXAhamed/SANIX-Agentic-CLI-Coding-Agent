/**
 * @file index.ts
 * @description Public entry point for `@sanix/sandbox`. Re-exports the
 * manager, REPL manager, artifact manager, the SANIX tool wrapper, all
 * isolation backends, all runtime adapters, and the shared types.
 *
 * Importing paths:
 *   import { SandboxManager, SandboxExecuteTool, getRuntimeAdapter } from '@sanix/sandbox';
 *   import type { SandboxOptions, REPLSession } from '@sanix/sandbox';
 *
 * @packageDocumentation
 */

// ── Top-level orchestrators ────────────────────────────────────────────────
export {
  SandboxManager,
  type SandboxManagerOptions,
  type SandboxManagerEvents,
  defaultWorkDir,
} from './SandboxManager.js';

export {
  REPLManager,
  type REPLManagerOptions,
  type REPLManagerEvents,
} from './REPLManager.js';

export {
  ArtifactManager,
  type ArtifactManagerOptions,
} from './ArtifactManager.js';

// ── Tool wrapper ──────────────────────────────────────────────────────────
export {
  SandboxExecuteTool,
  type SandboxExecuteToolOptions,
  SandboxToolInputSchema,
  SandboxToolOutputSchema,
  type SanixToolLike,
  type ToolResultLike,
  type ToolContextLike,
} from './SandboxTool.js';

// ── Isolation backends ─────────────────────────────────────────────────────
export {
  getIsolationBackend,
  listIsolations,
  ProcessIsolation,
  DockerIsolation,
  FirecrackerIsolation,
  WebAssemblyIsolation,
  NoIsolation,
} from './isolation/index.js';

// ── Runtime adapters ───────────────────────────────────────────────────────
export {
  getRuntimeAdapter,
  listRuntimes,
  NodeRuntime,
  PythonRuntime,
  DenoRuntime,
  BunRuntime,
  GoRuntime,
  RustRuntime,
  BashRuntime,
  CustomRuntime,
} from './runtimes/index.js';

// ── Shared types ───────────────────────────────────────────────────────────
export type {
  Runtime,
  Isolation,
  SandboxOptions,
  ExecutionResult,
  REPLSession,
  Sandbox,
  RuntimeCommand,
  RuntimeAdapter,
  BackendExecOptions,
  IsolationBackend,
  Artifact,
} from './types.js';

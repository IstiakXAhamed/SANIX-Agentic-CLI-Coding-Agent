/**
 * @file runtimes/index.ts
 * @description Barrel + factory for runtime adapters.
 *
 * @packageDocumentation
 */

import type { Runtime, RuntimeAdapter } from '../types.js';
import { NodeRuntime } from './NodeRuntime.js';
import { PythonRuntime } from './PythonRuntime.js';
import { DenoRuntime } from './DenoRuntime.js';
import { BunRuntime } from './BunRuntime.js';
import { GoRuntime } from './GoRuntime.js';
import { RustRuntime } from './RustRuntime.js';
import { BashRuntime } from './BashRuntime.js';
import { CustomRuntime } from './CustomRuntime.js';

export { NodeRuntime } from './NodeRuntime.js';
export { PythonRuntime } from './PythonRuntime.js';
export { DenoRuntime } from './DenoRuntime.js';
export { BunRuntime } from './BunRuntime.js';
export { GoRuntime } from './GoRuntime.js';
export { RustRuntime } from './RustRuntime.js';
export { BashRuntime } from './BashRuntime.js';
export { CustomRuntime } from './CustomRuntime.js';
export type { RuntimeAdapter } from '../types.js';

/**
 * Internal registry of all built-in runtime adapters, keyed by their
 * `runtime` field. Used by {@link getRuntimeAdapter}.
 */
const REGISTRY: Record<Runtime, () => RuntimeAdapter> = {
  node: () => new NodeRuntime(),
  python: () => new PythonRuntime(),
  deno: () => new DenoRuntime(),
  bun: () => new BunRuntime(),
  go: () => new GoRuntime(),
  rust: () => new RustRuntime(),
  bash: () => new BashRuntime(),
  custom: () => new CustomRuntime(),
};

/**
 * Look up the {@link RuntimeAdapter} for a given {@link Runtime}.
 *
 * @example
 * ```ts
 * const adapter = getRuntimeAdapter('python');
 * const cmd = adapter.buildExecCommand('print(1)', opts);
 * ```
 */
export function getRuntimeAdapter(runtime: Runtime): RuntimeAdapter {
  const factory = REGISTRY[runtime];
  if (!factory) {
    throw new Error(`Sandbox: unknown runtime '${runtime}'`);
  }
  return factory();
}

/**
 * List every runtime that has an adapter registered.
 */
export function listRuntimes(): Runtime[] {
  return Object.keys(REGISTRY) as Runtime[];
}

/**
 * @file isolation/index.ts
 * @description Barrel + factory for isolation backends.
 *
 * @packageDocumentation
 */

import type { Isolation, IsolationBackend } from '../types.js';
import { ProcessIsolation } from './ProcessIsolation.js';
import { DockerIsolation } from './DockerIsolation.js';
import { FirecrackerIsolation } from './FirecrackerIsolation.js';
import { WebAssemblyIsolation } from './WebAssemblyIsolation.js';
import { NoIsolation } from './NoIsolation.js';

export { ProcessIsolation } from './ProcessIsolation.js';
export { DockerIsolation } from './DockerIsolation.js';
export { FirecrackerIsolation } from './FirecrackerIsolation.js';
export { WebAssemblyIsolation } from './WebAssemblyIsolation.js';
export { NoIsolation } from './NoIsolation.js';

/**
 * Internal registry of all isolation backends.
 */
const REGISTRY: Record<Isolation, () => IsolationBackend> = {
  none: () => new NoIsolation(),
  process: () => new ProcessIsolation(),
  docker: () => new DockerIsolation(),
  firecracker: () => new FirecrackerIsolation(),
  webassembly: () => new WebAssemblyIsolation(),
};

/**
 * Look up the {@link IsolationBackend} for a given {@link Isolation} strategy.
 *
 * @example
 * ```ts
 * const be = getIsolationBackend('docker');
 * if (await be.available()) { ... }
 * ```
 */
export function getIsolationBackend(type: Isolation): IsolationBackend {
  const factory = REGISTRY[type];
  if (!factory) {
    throw new Error(`Sandbox: unknown isolation '${type}'`);
  }
  return factory();
}

/**
 * List every isolation strategy that has a backend registered.
 */
export function listIsolations(): Isolation[] {
  return Object.keys(REGISTRY) as Isolation[];
}

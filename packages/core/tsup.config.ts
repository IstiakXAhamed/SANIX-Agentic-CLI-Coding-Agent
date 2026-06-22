/**
 * @file tsup.config.ts
 * @description Build config for @sanix/core. Compiles five entry points so
 * downstream consumers can tree-shake by subsystem:
 *   - `@sanix/core`         — everything (barrel)
 *   - `@sanix/core/agent`   — OODA loop, planner, executor, reflector, sub-agents
 *   - `@sanix/core/memory`  — 4-tier hierarchical memory + compressor
 *   - `@sanix/core/context` — token-budget context assembly
 *   - `@sanix/core/tools`   — tool registry + interfaces
 *
 * ESM-only output, with DTS bundles and clean build dir. Entry keys are the
 * emitted paths (relative to `dist/`); values are the source files.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'agent/index': 'src/agent/index.ts',
    'memory/index': 'src/memory/index.ts',
    'context/index': 'src/context/index.ts',
    'tools/index': 'src/tools/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
  target: 'es2022',
  platform: 'node',
});

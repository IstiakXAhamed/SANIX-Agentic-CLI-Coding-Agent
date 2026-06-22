/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/federated`. Two entry points:
 * the main barrel (`src/index.ts`) and the aggregation sub-entry
 * (`src/aggregation/index.ts`) so consumers can import just the
 * aggregation strategies without pulling in the manager.
 *
 * @packageDocumentation
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/aggregation/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
  target: 'es2022',
  platform: 'node',
});

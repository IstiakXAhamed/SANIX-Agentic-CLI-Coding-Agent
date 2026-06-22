/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/prbot`. Two entry points: the
 * main barrel (`src/index.ts`) and the platforms sub-entry
 * (`src/platforms/index.ts`) so consumers can import just the platform
 * clients without pulling in the review engine.
 *
 * @packageDocumentation
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/platforms/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'node',
});

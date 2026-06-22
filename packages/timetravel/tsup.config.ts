/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/timetravel`. Single ESM entry, with
 * DTS bundling, source maps, and ES2022 target on the Node platform.
 *
 * @packageDocumentation
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'node',
});

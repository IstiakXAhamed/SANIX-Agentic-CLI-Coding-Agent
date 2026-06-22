/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/audit`. Single ESM entry with DTS,
 * source maps, and ES2022 Node target.
 *
 * @packageDocumentation
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'node',
});

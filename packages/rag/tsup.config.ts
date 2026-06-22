/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/rag`. ESM-only, with bundled DTS,
 * sourcemaps, treeshaking, and splitting. Single barrel entry.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
  target: 'es2022',
  platform: 'node',
});

import { defineConfig } from 'tsup';

/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/completions`. ESM-only, DTS
 * bundled. Zero runtime deps beyond `nanoid` — all shell templates
 * are pure TS string builders.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  treeshake: true,
  external: ['nanoid'],
  noExternal: [],
});

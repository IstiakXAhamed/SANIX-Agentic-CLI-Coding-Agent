import { defineConfig } from 'tsup';

/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/nlsql`. ESM-only, DTS bundled.
 * DB drivers (better-sqlite3, pg, mysql2) are dynamically imported by
 * the executor and kept external. LLM calls go through `@sanix/providers`.
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
  external: [
    'nanoid',
    'zod',
    'eventemitter3',
    'better-sqlite3',
    'pg',
    'mysql2',
    '@sanix/providers',
  ],
  noExternal: [],
});

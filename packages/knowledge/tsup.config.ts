/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/knowledge`. ESM-only, with bundled
 * DTS, sourcemaps, treeshaking, and splitting. Single barrel entry.
 * `@sanix/*` siblings + native `better-sqlite3` are marked external so
 * the bundle stays lean and respects the monorepo's workspace linking.
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
  external: [
    '@sanix/core',
    '@sanix/core/*',
    '@sanix/providers',
    '@sanix/providers/*',
    'better-sqlite3',
    'nanoid',
    'eventemitter3',
    'zod',
  ],
});

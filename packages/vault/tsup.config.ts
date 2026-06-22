import { defineConfig } from 'tsup';

/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/vault`. ESM-only, DTS bundled.
 * Vault CLIs (`op`, `bw`, `vault`, `lpass`, `keepassxc-cli`, `pass`)
 * are invoked as child processes; `kdbxweb` / `node-gyp` native modules
 * are dynamically imported where used and kept external.
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
    'kdbxweb',
    'argon2',
    '@sanix/providers',
  ],
  noExternal: [],
});

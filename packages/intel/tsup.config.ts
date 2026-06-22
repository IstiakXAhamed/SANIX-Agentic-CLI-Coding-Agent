import { defineConfig } from 'tsup';

/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/intel`. ESM-only, DTS bundled.
 * Heavy / native deps (LSP servers, ripgrep) are spawned as child
 * processes at runtime — never bundled.
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
  external: ['nanoid', 'eventemitter3', 'zod', 'vscode-languageserver-protocol', 'vscode-jsonrpc'],
  noExternal: [],
});

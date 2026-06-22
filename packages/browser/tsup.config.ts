import { defineConfig } from 'tsup';

/**
 * ESM build for `@sanix/browser`.
 *
 * `playwright` is marked external because:
 *   1. The package is dynamically imported at runtime inside `BrowserManager.launch()`
 *      so the package itself loads even if Playwright is not installed.
 *   2. Bundling Playwright would balloon the dist artifact and break the
 *      "lazy import" contract.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  external: ['playwright'],
  treeshake: true,
});

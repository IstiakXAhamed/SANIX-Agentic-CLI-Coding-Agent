import { defineConfig } from 'tsup';

/**
 * ESM build for `@sanix/workflows`. Single entry — the barrel
 * `src/index.ts` re-exports every public symbol so downstream callers
 * do one import:
 *
 *   import {
 *     WorkflowLoader,
 *     WorkflowExecutor,
 *     ToolComposer,
 *     PERSONAS,
 *     getPersona,
 *     BUILTIN_WORKFLOWS,
 *     listWorkflows,
 *     runWorkflow,
 *   } from '@sanix/workflows';
 *
 * The built-in workflow `.yaml` files in `src/builtin/` are copied into
 * `dist/builtin/` via the `copy` option below so the loader can read
 * them at runtime from the bundled location (it falls back to
 * `src/builtin/` for dev mode where the JS runs from `src/`).
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
  treeshake: true,
  external: [
    '@sanix/core',
    '@sanix/providers',
    '@sanix/tools',
    'js-yaml',
    'eventemitter3',
    'nanoid',
    'zod',
  ],
  noExternal: [],
  // Copy built-in YAML workflows so the loader can read them at runtime
  // from the bundled dist. Without this, dist/builtin/*.yaml wouldn't
  // exist and BUILTIN_WORKFLOWS would fall back to dev paths.
  copy: [
    { from: 'src/builtin', to: 'builtin' },
  ],
});

/**
 * @file vitest.config.ts
 * @description Root vitest configuration for the SANIX monorepo.
 *
 * ## Why the manual aliases?
 *
 * Several `@sanix/*` workspace packages (multiagent, rag, knowledge,
 * sandbox, self-improve, semantic-cache) are missing from the
 * hoisted `node_modules/@sanix/` directory — only a subset of the
 * 23 packages got symlinks created. To make every test reliably
 * resolve every `@sanix/*` import (including subpath exports like
 * `@sanix/multiagent/templates`) we register explicit aliases that
 * point at each package's TypeScript source entry. This also means
 * tests always exercise the latest source code, never a stale
 * `dist/` build.
 *
 * Aliases are listed as an Array (not an Object) and ordered
 * longest-first so that subpath exports (`@sanix/multiagent/templates`)
 * are matched before their parent package (`@sanix/multiagent`).
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));
const pkg = (name: string): string =>
  resolve(rootDir, 'packages', name, 'src', 'index.ts');

// Longest-first ordering prevents `@sanix/multiagent` from greedily
// matching `@sanix/multiagent/templates`.
const aliases = [
  {
    find: '@sanix/multiagent/templates',
    replacement: resolve(rootDir, 'packages/multiagent/src/templates/index.ts'),
  },
  {
    find: '@sanix/multiagent/strategies',
    replacement: resolve(
      rootDir,
      'packages/multiagent/src/strategies/index.ts',
    ),
  },
  { find: '@sanix/providers/adapters', replacement: resolve(
    rootDir,
    'packages/providers/src/adapters/index.ts',
  ) },
  { find: '@sanix/multiagent', replacement: pkg('multiagent') },
  { find: '@sanix/rag', replacement: pkg('rag') },
  { find: '@sanix/semantic-cache', replacement: pkg('semantic-cache') },
  { find: '@sanix/knowledge', replacement: pkg('knowledge') },
  { find: '@sanix/sandbox', replacement: pkg('sandbox') },
  { find: '@sanix/self-improve', replacement: pkg('self-improve') },
  { find: '@sanix/bench', replacement: pkg('bench') },
  { find: '@sanix/providers', replacement: pkg('providers') },
  { find: '@sanix/memory-v2', replacement: pkg('memory-v2') },
  { find: '@sanix/observe', replacement: pkg('observe') },
  { find: '@sanix/optimizer', replacement: pkg('optimizer') },
  { find: '@sanix/core', replacement: pkg('core') },
  { find: '@sanix/config', replacement: pkg('config') },
  { find: '@sanix/tools', replacement: pkg('tools') },
  { find: '@sanix/workflows', replacement: pkg('workflows') },
];

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/node_modules/**', '**/test/**'],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

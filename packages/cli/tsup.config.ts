/**
 * @file tsup.config.ts
 * @description Build configuration for the @sanix/cli package.
 *
 * - Entry points: `src/main.ts` (the `sanix` bin) + `src/index.ts` (programmatic API).
 * - ESM output (matches the monorepo's `"type": "module"`).
 * - DTS generation enabled so downstream consumers get full type info.
 * - `clean: false` so the shebang banner we inject via `banner.js` is not
 *   stripped by a destructive rebuild between file-watcher ticks.
 * - The `banner.js` re-prepends `#!/usr/bin/env node` because tsup's esbuild
 *   loader drops the literal shebang from source during transform.
 *
 * @packageDocumentation
 */

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: false,
  sourcemap: true,
  // Disable code-splitting so main.ts stays a single self-contained file —
  // required so `import.meta.url` in main.ts equals `dist/main.js` (the entry
  // point Node was invoked with). Otherwise tsup hoists shared code into a
  // chunk and the `isMainModule` check no longer fires.
  splitting: false,
  // esbuild strips leading `#!` from source during transform; re-add it here
  // so `dist/main.js` remains directly executable as a CLI bin.
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Node 20+ supports top-level await, dynamic import, etc. — target it
  // explicitly so esbuild keeps modern syntax (no down-levelling).
  target: 'es2022',
  platform: 'node',
  // Preserve the `@sanix/*` workspace imports as bare specifiers (the
  // monorepo's workspace resolution handles them at runtime).
  // Heavy native deps that can't be bundled are also externalized.
  external: [
    '@sanix/config',
    '@sanix/core',
    '@sanix/providers',
    '@sanix/tools',
    '@sanix/tui',
    '@sanix/auth',
    '@sanix/share',
    '@sanix/server',
    '@sanix/token-slim',
    '@sanix/autotool',
    '@sanix/memory-v2',
    '@sanix/optimizer',
    'better-sqlite3',
    '@lancedb/lancedb',
    '@xenova/transformers',
    'playwright',
    'electron',
    'react',
    'react-dom',
    'ink',
  ],
});

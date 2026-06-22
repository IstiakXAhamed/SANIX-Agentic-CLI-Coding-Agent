import { defineConfig } from 'tsup';

/**
 * Multi-entry ESM build for @sanix/tools.
 * Each subsystem is independently importable via the package exports map.
 */
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/filesystem/index.ts',
    'src/shell/index.ts',
    'src/code/index.ts',
    'src/web/index.ts',
    'src/memory_tools/index.ts',
    'src/mcp/index.ts',
  ],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  treeshake: true,
});
